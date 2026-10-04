<?php
declare(strict_types=1);

require_once __DIR__ . '/util.php';
require_once __DIR__ . '/store.php';

/**
 * 设备与配对码存储（IKJN7C）。语义与 .NET AuthStore / CF CloudStore 对齐：
 * - device token = 32 字节随机（base64url，前缀 cyn_）；库内只存 SHA-256 哈希，签发后仅回显一次；
 * - 配对码 = 8 位易读字母表（无 0/O/1/I/L/U），一次性 + TTL（默认 5 分钟），库内只存哈希；
 * - 撤销即时生效；轮换 = 原子替换哈希（旧 token 立即失效）；
 * - 不写日志（调用方也不得把 token / 配对码打进日志）。
 */
final class AuthStore
{
    private PDO $pdo;
    private int $pairTtlSeconds;

    public function __construct(string $dbPath, int $pairTtlSeconds)
    {
        $this->pairTtlSeconds = $pairTtlSeconds;
        $dir = dirname($dbPath);
        if (!is_dir($dir)) {
            mkdir($dir, 0700, true);
        }
        $this->pdo = new PDO('sqlite:' . $dbPath, null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
        $this->pdo->exec('PRAGMA journal_mode=WAL');
        $this->pdo->exec('PRAGMA busy_timeout=5000');
        $this->pdo->exec('CREATE TABLE IF NOT EXISTS devices (
            device_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            token_hash TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            last_seen_at TEXT,
            revoked_at TEXT
        )');
        $this->pdo->exec('CREATE TABLE IF NOT EXISTS pairing_codes (
            code_hash TEXT PRIMARY KEY,
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            redeemed_at TEXT,
            redeemed_by TEXT
        )');
    }

    /** 签发一次性配对码（返回 [显示码, 过期时间]；库内只存规范化哈希）。 */
    public function createPairCode(string $createdBy): array
    {
        $code = cyrene_random_pair_code();
        $now = new DateTimeImmutable('now', new DateTimeZone('UTC'));
        $expires = $now->modify('+' . $this->pairTtlSeconds . ' seconds');
        $this->pdo->prepare('DELETE FROM pairing_codes WHERE expires_at < ?')
            ->execute([$now->modify('-1 hour')->format('Y-m-d\TH:i:s.v\Z')]);
        $this->pdo->prepare(
            'INSERT INTO pairing_codes (code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)'
        )->execute([
            cyrene_sha256_hex($code),
            $createdBy,
            $now->format('Y-m-d\TH:i:s.v\Z'),
            $expires->format('Y-m-d\TH:i:s.v\Z'),
        ]);
        return [cyrene_format_pair_code($code), $expires->format('Y-m-d\TH:i:s.v\Z')];
    }

    /** 兑换配对码 → 签发 device token（原子：一次性以 UPDATE ... WHERE redeemed_at IS NULL 保证）。 */
    public function redeem(mixed $rawCode, mixed $deviceName): ?array
    {
        $code = cyrene_normalize_pair_code($rawCode);
        if ($code === null) {
            return null;
        }
        $name = cyrene_normalize_device_name($deviceName);
        $deviceId = 'dev_' . cyrene_random_hex(6);
        $token = 'cyn_' . cyrene_base64url(random_bytes(32));
        $now = cyrene_iso_now();
        $this->pdo->beginTransaction();
        try {
            $statement = $this->pdo->prepare(
                'UPDATE pairing_codes SET redeemed_at = ?, redeemed_by = ?
                 WHERE code_hash = ? AND redeemed_at IS NULL AND expires_at > ?'
            );
            $statement->execute([$now, $deviceId, cyrene_sha256_hex($code), $now]);
            if ($statement->rowCount() === 0) {
                $this->pdo->rollBack();
                return null;
            }
            $this->pdo->prepare(
                'INSERT INTO devices (device_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)'
            )->execute([$deviceId, $name, cyrene_sha256_hex($token), $now]);
            $this->pdo->commit();
        } catch (Throwable $error) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            throw $error;
        }
        return ['deviceId' => $deviceId, 'name' => $name, 'token' => $token];
    }

    /** 按 token 鉴权（撤销即失败；命中节流更新 last_seen）。 */
    public function tryAuthenticate(?string $token): ?array
    {
        if ($token === null || $token === '') {
            return null;
        }
        $statement = $this->pdo->prepare('SELECT device_id, name, revoked_at FROM devices WHERE token_hash = ?');
        $statement->execute([cyrene_sha256_hex($token)]);
        $row = $statement->fetch();
        if ($row === false || $row['revoked_at'] !== null) {
            return null;
        }
        $now = new DateTimeImmutable('now', new DateTimeZone('UTC'));
        $this->pdo->prepare(
            'UPDATE devices SET last_seen_at = ? WHERE device_id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)'
        )->execute([
            $now->format('Y-m-d\TH:i:s.v\Z'),
            $row['device_id'],
            $now->modify('-5 minutes')->format('Y-m-d\TH:i:s.v\Z'),
        ]);
        return ['deviceId' => $row['device_id'], 'name' => $row['name']];
    }

    public function listDevices(): array
    {
        $rows = $this->pdo->query(
            'SELECT device_id, name, created_at, last_seen_at, revoked_at FROM devices ORDER BY created_at'
        )->fetchAll();
        $devices = [];
        foreach ($rows as $row) {
            $device = [
                'deviceId' => $row['device_id'],
                'name' => $row['name'],
                'createdAt' => $row['created_at'],
                'revoked' => $row['revoked_at'] !== null,
            ];
            if ($row['last_seen_at'] !== null) {
                $device['lastSeenAt'] = $row['last_seen_at'];
            }
            $devices[] = $device;
        }
        return $devices;
    }

    public function countActiveDevices(): int
    {
        return (int)$this->pdo->query('SELECT COUNT(*) FROM devices WHERE revoked_at IS NULL')->fetchColumn();
    }

    /** 撤销（已撤销视为幂等成功；不存在返回 false）。 */
    public function revoke(string $deviceId): bool
    {
        $statement = $this->pdo->prepare(
            'UPDATE devices SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL'
        );
        $statement->execute([cyrene_iso_now(), $deviceId]);
        if ($statement->rowCount() > 0) {
            return true;
        }
        $exists = $this->pdo->prepare('SELECT 1 FROM devices WHERE device_id = ? LIMIT 1');
        $exists->execute([$deviceId]);
        return $exists->fetchColumn() !== false;
    }

    /** 轮换 token（旧 token 立即失效）；不存在或已撤销返回 null。 */
    public function rotate(string $deviceId): ?string
    {
        $token = 'cyn_' . cyrene_base64url(random_bytes(32));
        $statement = $this->pdo->prepare(
            'UPDATE devices SET token_hash = ? WHERE device_id = ? AND revoked_at IS NULL'
        );
        $statement->execute([cyrene_sha256_hex($token), $deviceId]);
        return $statement->rowCount() > 0 ? $token : null;
    }
}
