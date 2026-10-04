<?php
declare(strict_types=1);

require_once __DIR__ . '/protocol.php';
require_once __DIR__ . '/storage.php';

/**
 * append-only 事件库（SQLite；IKJN7C）。语义与 .NET EventStore / CF CloudStore 对齐：
 * - 幂等：event_id 唯一索引，首见生效（重复只计数）；
 * - 排序：客户端收敛序 = (lamport, deviceId, seq)；服务端游标 = 插入序 id（AUTOINCREMENT）；
 * - 链校验（v0 过渡策略）：per-(sessionId, deviceId)；已上链事件 prevHash 必须等于链尾
 *   （无链尾 ⇒ prevHash 必须缺省）；未上链事件 prevHash 必须缺省；同对 seq 严格递增（重复除外）；
 * - 原子性：整批校验 + 插入同一事务；任一错误整批回滚（fail-closed）。
 */
final class EventStore
{
    private PDO $pdo;

    public function __construct(string $dbPath)
    {
        $dir = dirname($dbPath);
        if (!is_dir($dir)) {
            mkdir($dir, 0700, true);
        }
        $this->pdo = new PDO('sqlite:' . $dbPath, null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
        $this->pdo->exec('PRAGMA journal_mode=WAL');
        $this->pdo->exec('PRAGMA synchronous=FULL');
        $this->pdo->exec('PRAGMA busy_timeout=5000');
        $this->pdo->exec('CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL UNIQUE,
            session_id TEXT NOT NULL,
            type TEXT NOT NULL,
            lamport INTEGER NOT NULL,
            device_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            ts TEXT NOT NULL,
            payload TEXT NOT NULL,
            prev_hash TEXT,
            hash TEXT,
            received_at TEXT NOT NULL
        )');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_events_order ON events(session_id, lamport, device_id, seq)');
        $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_events_chain ON events(session_id, device_id, seq)');
        $this->pdo->exec('CREATE TABLE IF NOT EXISTS rate_limits (
            key TEXT NOT NULL,
            window INTEGER NOT NULL,
            count INTEGER NOT NULL,
            PRIMARY KEY (key, window)
        )');
        $this->pdo->exec('CREATE TABLE IF NOT EXISTS dialog_pending (
            session_id TEXT PRIMARY KEY,
            enqueued_at TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at INTEGER NOT NULL
        )');
        // 存储加固（P0）：目录 0700 / 库与 -wal/-shm 0600（best-effort；umask 由入口设置）
        cyrene_harden_storage($dir, $dbPath);
    }

    /**
     * 整批校验 + 幂等插入（事务；任一错误整批回滚）。
     * $lineByEventId：eventId → 输入 JSONL 0 基物理行号（缺省回退规范序下标）。
     * 返回 ['accepted','duplicates','cursor','errors'=>[['index','code']]]。
     */
    public function pushBatch(array $events, ?array $lineByEventId = null): array
    {
        // BEGIN IMMEDIATE：先读（幂等/链校验）后写，WAL 下需立即取写锁，避免并发 worker
        // 的 SQLITE_BUSY_SNAPSHOT（busy_timeout 对快照冲突无效）。
        $this->pdo->exec('BEGIN IMMEDIATE');
        try {
            $accepted = 0;
            $duplicates = 0;
            $hasError = false;
            $errors = [];
            foreach ($events as $index => $event) {
                if ($this->eventIdExists($event['eventId'])) {
                    $duplicates++;
                    continue;
                }
                $code = $this->checkChain($event);
                if ($code !== null) {
                    $errorIndex = ($lineByEventId !== null && array_key_exists($event['eventId'], $lineByEventId))
                        ? $lineByEventId[$event['eventId']]
                        : $index;
                    $errors[] = ['index' => $errorIndex, 'code' => $code];
                    $hasError = true;
                    continue;
                }
                if (!$hasError) {
                    $this->insertEvent($event);
                    $accepted++;
                }
            }
            if (count($errors) > 0) {
                $this->pdo->rollBack();
                return ['accepted' => 0, 'duplicates' => 0, 'cursor' => $this->currentCursor(), 'errors' => $errors];
            }
            $this->pdo->commit();
            return ['accepted' => $accepted, 'duplicates' => $duplicates, 'cursor' => $this->currentCursor(), 'errors' => []];
        } catch (Throwable $error) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            throw $error;
        }
    }

    private function checkChain(array $event): ?string
    {
        if (!array_key_exists('hash', $event) && array_key_exists('prevHash', $event)) {
            return 'E_SYNC_CHAIN';
        }
        $statement = $this->pdo->prepare(
            'SELECT seq FROM events WHERE session_id = ? AND device_id = ? ORDER BY seq DESC LIMIT 1'
        );
        $statement->execute([$event['sessionId'], $event['deviceId']]);
        $tailSeq = $statement->fetchColumn();
        if ($tailSeq !== false && $event['seq'] <= (int)$tailSeq) {
            return 'E_SYNC_SEQ';
        }
        if (array_key_exists('hash', $event)) {
            $statement = $this->pdo->prepare(
                'SELECT hash FROM events WHERE session_id = ? AND device_id = ? AND hash IS NOT NULL ORDER BY seq DESC LIMIT 1'
            );
            $statement->execute([$event['sessionId'], $event['deviceId']]);
            $lastChainedHash = $statement->fetchColumn();
            if ($lastChainedHash === false) {
                if (array_key_exists('prevHash', $event)) {
                    return 'E_SYNC_CHAIN';
                }
            } elseif (($event['prevHash'] ?? null) !== $lastChainedHash) {
                return 'E_SYNC_CHAIN';
            }
        }
        return null;
    }

    public function eventIdExists(string $eventId): bool
    {
        $statement = $this->pdo->prepare('SELECT 1 FROM events WHERE event_id = ? LIMIT 1');
        $statement->execute([$eventId]);
        return $statement->fetchColumn() !== false;
    }

    private function insertEvent(array $event): void
    {
        $statement = $this->pdo->prepare(
            'INSERT INTO events (event_id, session_id, type, lamport, device_id, seq, ts, payload, prev_hash, hash, received_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $statement->execute([
            $event['eventId'],
            $event['sessionId'],
            $event['type'],
            $event['lamport'],
            $event['deviceId'],
            $event['seq'],
            $event['ts'],
            json_encode($event['payload'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            $event['prevHash'] ?? null,
            $event['hash'] ?? null,
            cyrene_iso_now(),
        ]);
    }

    /** 插入序增量读取（cursor 为本页最后一条 id；无新事件时原样返回 since）。 */
    public function fetch(int $since, int $limit, ?string $sessionId): array
    {
        $sql = $sessionId === null
            ? 'SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?'
            : 'SELECT * FROM events WHERE id > ? AND session_id = ? ORDER BY id LIMIT ?';
        $statement = $this->pdo->prepare($sql);
        $parameters = $sessionId === null ? [$since, $limit + 1] : [$since, $sessionId, $limit + 1];
        $statement->execute($parameters);
        $rows = $statement->fetchAll();
        $hasMore = count($rows) > $limit;
        $page = array_slice($rows, 0, $limit);
        $events = array_map('cyrene_row_to_event', $page);
        $cursor = count($page) > 0 ? (int)$page[count($page) - 1]['id'] : $since;
        return ['events' => $events, 'cursor' => $cursor, 'hasMore' => $hasMore];
    }

    /**
     * 全量流（clone；插入序，以 maxId 为上界固定快照）。
     * 生成器按 id 分页（200/页），内存有界；客户端断连时输出失败即停止拉页。
     * 返回 ['cursor' => int, 'stream' => Generator<int, array>]。
     */
    public function cloneStream(?string $sessionId): array
    {
        $cursor = $this->currentCursor();
        $pdo = $this->pdo;
        $stream = (static function () use ($pdo, $sessionId, $cursor): Generator {
            $lastId = 0;
            $pageSize = 200;
            while (true) {
                if ($sessionId === null) {
                    $statement = $pdo->prepare(
                        'SELECT * FROM events WHERE id <= ? AND id > ? ORDER BY id LIMIT ?'
                    );
                    $statement->execute([$cursor, $lastId, $pageSize]);
                } else {
                    $statement = $pdo->prepare(
                        'SELECT * FROM events WHERE id <= ? AND id > ? AND session_id = ? ORDER BY id LIMIT ?'
                    );
                    $statement->execute([$cursor, $lastId, $sessionId, $pageSize]);
                }
                $rows = $statement->fetchAll();
                if (count($rows) === 0) {
                    break;
                }
                $lastId = (int)$rows[count($rows) - 1]['id'];
                foreach ($rows as $row) {
                    yield cyrene_row_to_event($row);
                }
            }
        })();
        return ['cursor' => $cursor, 'stream' => $stream];
    }

    public function currentCursor(): int
    {
        return (int)$this->pdo->query('SELECT COALESCE(MAX(id), 0) FROM events')->fetchColumn();
    }

    /** 会话水位：最大 lamport（任意设备）与指定设备最大 seq（生成事件用）。 */
    public function sessionWatermark(string $sessionId, string $deviceId): array
    {
        $statement = $this->pdo->prepare(
            'SELECT COALESCE(MAX(lamport), 0) AS max_lamport,
                    COALESCE(MAX(CASE WHEN device_id = ? THEN seq END), 0) AS max_seq
             FROM events WHERE session_id = ?'
        );
        $statement->execute([$deviceId, $sessionId]);
        $row = $statement->fetch();
        return ['maxLamport' => (int)$row['max_lamport'], 'maxSeq' => (int)$row['max_seq']];
    }

    /** 会话全量事件（规范序：lamport, deviceId 序数, seq）。 */
    public function loadSessionEvents(string $sessionId): array
    {
        $statement = $this->pdo->prepare('SELECT * FROM events WHERE session_id = ? ORDER BY id');
        $statement->execute([$sessionId]);
        $events = array_map('cyrene_row_to_event', $statement->fetchAll());
        usort($events, static function (array $left, array $right): int {
            return $left['lamport'] <=> $right['lamport']
                ?: cyrene_utf16_compare($left['deviceId'], $right['deviceId'])
                ?: $left['seq'] <=> $right['seq'];
        });
        return $events;
    }

    /** 固定窗口限流（返回 true = 已超限）。key 建议含分组前缀与 token 哈希/IP。 */
    public function rateLimitHit(string $key, int $limit, int $windowSeconds = 60): bool
    {
        $window = intdiv(time(), $windowSeconds);
        $this->pdo->prepare('DELETE FROM rate_limits WHERE window < ?')->execute([$window - 1]);
        $this->pdo->prepare(
            'INSERT INTO rate_limits (key, window, count) VALUES (?, ?, 1)
             ON CONFLICT(key, window) DO UPDATE SET count = count + 1'
        )->execute([$key, $window]);
        $statement = $this->pdo->prepare('SELECT count FROM rate_limits WHERE key = ? AND window = ?');
        $statement->execute([$key, $window]);
        return (int)$statement->fetchColumn() > $limit;
    }

    public function pdo(): PDO
    {
        return $this->pdo;
    }
}

function cyrene_row_to_event(array $row): array
{
    $event = [
        'eventId' => $row['event_id'],
        'sessionId' => $row['session_id'],
        'type' => $row['type'],
        'lamport' => (int)$row['lamport'],
        'deviceId' => $row['device_id'],
        'seq' => (int)$row['seq'],
        'ts' => $row['ts'],
        'payload' => json_decode($row['payload'], true),
    ];
    if ($row['prev_hash'] !== null) {
        $event['prevHash'] = $row['prev_hash'];
    }
    if ($row['hash'] !== null) {
        $event['hash'] = $row['hash'];
    }
    return $event;
}

/** 毫秒精度 ISO 8601 UTC（与双端 ts 格式一致）。 */
function cyrene_iso_now(): string
{
    return (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.v\Z');
}
