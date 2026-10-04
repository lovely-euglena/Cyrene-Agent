<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/protocol.php';
require_once __DIR__ . '/storage.php';
require_once __DIR__ . '/store.php';
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/dialog.php';

const CYRENE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " .
    "connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'";

/** 入口：路由（API + 能力声明 + 静态托管）。 */
function cyrene_run(string $publicDir): void
{
    cyrene_harden_umask(); // 建库 / 写文件前收紧 umask（Windows 无效果）
    $config = cyrene_config();
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
    try {
        if (!cyrene_host_allowed($config)) {
            cyrene_send_json(['code' => 'E_HOST_NOT_ALLOWED'], 421);
            return;
        }
        if ($path === '/v1/capabilities' && $method === 'GET') {
            cyrene_send_json(cyrene_capabilities($publicDir));
            return;
        }
        if ($path === '/healthz' || str_starts_with($path, '/v1/')) {
            cyrene_handle_api($method, $path, $config);
            return;
        }
        cyrene_serve_static($path, $publicDir);
    } catch (Throwable $error) {
        error_log('cyrene-cloud-php: ' . $error->getMessage());
        cyrene_send_json(['code' => 'E_INTERNAL'], 500);
    }
}

/** 存储实例（同库文件：事件 + 鉴权；每请求进程内缓存）。 */
function cyrene_stores(array $config): array
{
    static $stores = null;
    if ($stores === null) {
        $dbPath = rtrim($config['data_dir'], '/\\') . DIRECTORY_SEPARATOR . 'events.db';
        $stores = [
            'events' => new EventStore($dbPath),
            'auth' => new AuthStore($dbPath, (int)$config['pair_ttl_seconds']),
        ];
    }
    return $stores;
}

function cyrene_capabilities(string $publicDir): array
{
    return [
        'impl' => 'php-shared',
        'protocol' => 'v0',
        'sync' => true,
        'clone' => true,
        'cursor' => 'server',
        'generation' => cyrene_generation_enabled() ? 'inline' : 'none',
        'pairing' => 'device-token',
        'pwa' => is_file($publicDir . '/index.html'),
        'maxBatchBytes' => cyrene_config()['max_push_bytes'],
    ];
}

function cyrene_handle_api(string $method, string $path, array $config): void
{
    $stores = cyrene_stores($config);
    $events = $stores['events'];
    $auth = $stores['auth'];

    // 先鉴权后限流：分区键只信任已验证主体（避免随机 Bearer 换桶），匿名固定按客户端 IP。
    $principal = cyrene_authenticate($config, $auth, cyrene_extract_bearer());
    $limited = cyrene_enforce_rate_limit($config, $path, $events, $principal);
    if ($limited !== null) {
        cyrene_send_json($limited, 429);
        return;
    }

    $isPairRedeem = $method === 'POST' && $path === '/v1/pair';
    $isLoopbackHealthz = $method === 'GET' && $path === '/healthz' && cyrene_is_loopback();
    if (!$isPairRedeem && !$isLoopbackHealthz && $principal === null) {
        cyrene_send_json(['code' => 'E_UNAUTHORIZED'], 401);
        return;
    }

    if ($path === '/healthz' && $method === 'GET') {
        cyrene_send_json([
            'status' => 'ok',
            'rssMB' => round(memory_get_peak_usage(true) / 1048576, 1),
            'cursor' => $events->currentCursor(),
            'devices' => $auth->countActiveDevices(),
        ]);
        return;
    }
    if ($path === '/v1/pair/code' && $method === 'POST') {
        $createdBy = $principal['kind'] === 'master' ? 'master' : $principal['deviceId'];
        [$code, $expiresAt] = $auth->createPairCode($createdBy);
        cyrene_send_json(['code' => $code, 'expiresAt' => $expiresAt]);
        return;
    }
    if ($isPairRedeem) {
        $body = cyrene_read_json_body();
        $outcome = $auth->redeem($body['code'] ?? null, $body['deviceName'] ?? null);
        if ($outcome === null) {
            cyrene_send_json(['code' => 'E_PAIR_CODE'], 400);
            return;
        }
        cyrene_send_json($outcome);
        return;
    }
    if ($path === '/v1/devices' && $method === 'GET') {
        if ($principal['kind'] !== 'master') {
            cyrene_send_json(['code' => 'E_FORBIDDEN'], 403);
            return;
        }
        cyrene_send_json(['devices' => $auth->listDevices()]);
        return;
    }
    if (preg_match('#^/v1/devices/([^/]+)/(revoke|rotate)$#', $path, $matches) === 1 && $method === 'POST') {
        $deviceId = urldecode($matches[1]);
        $action = $matches[2];
        $allowed = $principal['kind'] === 'master' || $principal['deviceId'] === $deviceId;
        if (!$allowed) {
            cyrene_send_json(['code' => 'E_FORBIDDEN'], 403);
            return;
        }
        if ($action === 'revoke') {
            if (!$auth->revoke($deviceId)) {
                cyrene_send_json(['code' => 'E_DEVICE_NOT_FOUND'], 404);
                return;
            }
            cyrene_send_json(['deviceId' => $deviceId, 'revoked' => true]);
            return;
        }
        $newToken = $auth->rotate($deviceId);
        if ($newToken === null) {
            cyrene_send_json(['code' => 'E_DEVICE_NOT_FOUND'], 404);
            return;
        }
        cyrene_send_json(['deviceId' => $deviceId, 'token' => $newToken]);
        return;
    }
    if ($path === '/v1/sync/push' && $method === 'POST') {
        cyrene_handle_push($config, $events);
        return;
    }
    if ($path === '/v1/sync/fetch' && $method === 'GET') {
        cyrene_handle_fetch($events);
        return;
    }
    if ($path === '/v1/sync/clone' && $method === 'GET') {
        cyrene_handle_clone($events);
        return;
    }
    cyrene_send_json(['code' => 'E_NOT_FOUND'], 404);
}

function cyrene_handle_push(array $config, EventStore $events): void
{
    $contentLength = $_SERVER['CONTENT_LENGTH'] ?? null;
    if ($contentLength !== null && is_numeric($contentLength) && (int)$contentLength > $config['max_push_bytes']) {
        cyrene_send_json(['code' => 'E_SYNC_BATCH_TOO_LARGE'], 413);
        return;
    }
    $text = cyrene_read_body_limited((int)$config['max_push_bytes']);
    if ($text === null) {
        cyrene_send_json(['code' => 'E_SYNC_BATCH_TOO_LARGE'], 413);
        return;
    }
    $batch = sync_read_batch($text);
    if ($batch['truncatedTail'] || count($batch['errors']) > 0) {
        cyrene_send_json([
            'code' => 'E_SYNC_BATCH_INVALID',
            'truncatedTail' => $batch['truncatedTail'],
            'errors' => $batch['errors'],
        ], 400);
        return;
    }
    $outcome = $events->pushBatch($batch['events'], sync_build_line_index($text));
    if (count($outcome['errors']) > 0) {
        cyrene_send_json(['code' => 'E_SYNC_BATCH_REJECTED', 'errors' => $outcome['errors']], 400);
        return;
    }
    if ($outcome['accepted'] > 0) {
        try {
            (new DialogLoop($events, $config))->trigger($batch['events']);
        } catch (Throwable $error) {
            // 内联生成尽力而为：失败不影响同步结果（挂起 / 桌面兜底由 trigger 内部与 cron 承担）
            error_log('生成触发失败（不影响同步）：' . $error->getMessage());
        }
    }
    cyrene_send_json([
        'accepted' => $outcome['accepted'],
        'duplicates' => $outcome['duplicates'],
        'cursor' => (string)$outcome['cursor'],
    ]);
}

function cyrene_handle_fetch(EventStore $events): void
{
    $sinceRaw = $_GET['since'] ?? '0';
    if (!is_string($sinceRaw) || preg_match('/^\d+$/', $sinceRaw) !== 1) {
        cyrene_send_json(['code' => 'E_SYNC_CURSOR'], 400);
        return;
    }
    $limitRaw = $_GET['limit'] ?? null;
    $limit = (is_string($limitRaw) && preg_match('/^\d+$/', $limitRaw) === 1) ? (int)$limitRaw : 200;
    $limit = max(1, min(1000, $limit));
    $sessionId = (isset($_GET['sessionId']) && is_string($_GET['sessionId'])) ? $_GET['sessionId'] : null;
    $outcome = $events->fetch((int)$sinceRaw, $limit, $sessionId);
    cyrene_send_json([
        'events' => $outcome['events'],
        'cursor' => (string)$outcome['cursor'],
        'hasMore' => $outcome['hasMore'],
    ]);
}

function cyrene_handle_clone(EventStore $events): void
{
    $sessionId = (isset($_GET['sessionId']) && is_string($_GET['sessionId'])) ? $_GET['sessionId'] : null;
    $outcome = $events->cloneStream($sessionId);
    header('Content-Type: application/x-ndjson; charset=utf-8');
    header('X-Sync-Cursor: ' . $outcome['cursor']);
    // 逐行流式输出（生成器按 id 分页；内存有界）
    foreach ($outcome['stream'] as $event) {
        echo json_encode($event, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n";
    }
}

function cyrene_enforce_rate_limit(array $config, string $path, EventStore $events, ?array $principal): ?array
{
    if ($path === '/v1/pair' || $path === '/v1/pair/code') {
        $prefix = 'pair';
        $limit = (int)$config['rate_pair_per_min'];
    } elseif (str_starts_with($path, '/v1/sync/') || $path === '/v1/devices' || str_starts_with($path, '/v1/devices/')) {
        $prefix = 'sync';
        $limit = (int)$config['rate_sync_per_min'];
    } else {
        return null;
    }
    $partition = $principal === null
        ? 'i:' . cyrene_client_ip()
        : ($principal['kind'] === 'master' ? 'p:master' : 'p:' . $principal['deviceId']);
    return $events->rateLimitHit($prefix . ':' . $partition, $limit) ? ['code' => 'E_RATE_LIMITED'] : null;
}

/**
 * 客户端 IP：直连用 REMOTE_ADDR；回环（受信代理）时取 X-Forwarded-For **最右**一跳
 * （nginx `$proxy_add_x_forwarded_for` 追加直连对端，最右值为代理实际看到的客户端；
 * 取最左值会被客户端自带 XFF 伪造——与 .NET ForwardedHeaders ForwardLimit=1 口径一致）。
 */
function cyrene_client_ip(): string
{
    $remote = (string)($_SERVER['REMOTE_ADDR'] ?? 'unknown');
    if (in_array($remote, ['127.0.0.1', '::1'], true)) {
        $forwarded = cyrene_forwarded_client_ip();
        if ($forwarded !== null) {
            return $forwarded;
        }
    }
    return $remote;
}

/** X-Forwarded-For 最右非空跳（无则 null）。 */
function cyrene_forwarded_client_ip(): ?string
{
    $forwarded = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? '';
    if (!is_string($forwarded) || trim($forwarded) === '') {
        return null;
    }
    $parts = explode(',', $forwarded);
    for ($i = count($parts) - 1; $i >= 0; $i--) {
        $candidate = trim($parts[$i]);
        if ($candidate !== '') {
            return $candidate;
        }
    }
    return null;
}

/**
 * 回环判定（healthz 免鉴权）：仅「直连回环」或「受信代理转发且真实客户端为回环」；
 * 同机反代下外部请求 REMOTE_ADDR=127.0.0.1 但 XFF 指向外部客户端 → 需鉴权
 * （与 .NET 经 ForwardedHeaders 重写 RemoteIpAddress 后的行为一致）。
 */
function cyrene_is_loopback(): bool
{
    $remote = (string)($_SERVER['REMOTE_ADDR'] ?? '');
    if (!in_array($remote, ['127.0.0.1', '::1'], true)) {
        return false;
    }
    $forwarded = cyrene_forwarded_client_ip();
    if ($forwarded === null) {
        return true;
    }
    return in_array($forwarded, ['127.0.0.1', '::1'], true);
}

function cyrene_extract_bearer(): ?string
{
    $header = $_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? null);
    if (!is_string($header) || preg_match('/^Bearer\s+(.+)$/i', trim($header), $matches) !== 1) {
        return null;
    }
    $token = trim($matches[1]);
    return $token !== '' ? $token : null;
}

/** 主控令牌或 device token；返回 ['kind' => 'master'] 或 ['kind' => 'device', 'deviceId', 'name']。 */
function cyrene_authenticate(array $config, AuthStore $auth, ?string $token): ?array
{
    if ($token === null) {
        return null;
    }
    if ($config['master_token'] !== null && hash_equals($config['master_token'], $token)) {
        return ['kind' => 'master'];
    }
    $device = $auth->tryAuthenticate($token);
    return $device === null ? null : ['kind' => 'device', 'deviceId' => $device['deviceId'], 'name' => $device['name']];
}

function cyrene_host_allowed(array $config): bool
{
    $allowed = array_values(array_filter(
        array_map('trim', explode(',', (string)$config['allowed_hosts'])),
        static fn(string $item): bool => $item !== ''
    ));
    if (count($allowed) === 0) {
        return true;
    }
    $host = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
    $host = preg_replace('/:\d+$/', '', $host) ?? $host;
    $host = trim($host, '[]'); // [::1]:8080 → ::1
    if ($host === 'localhost' || $host === '127.0.0.1' || $host === '::1' || str_ends_with($host, '.localhost')) {
        return true;
    }
    foreach ($allowed as $item) {
        if (strtolower($item) === $host) {
            return true;
        }
    }
    return false;
}

/** 静态托管：缓存策略 / CSP / nosniff 与 .NET / CF 口径一致。 */
function cyrene_serve_static(string $path, string $publicDir): void
{
    $relative = $path === '/' ? '/index.html' : $path;
    $root = realpath($publicDir);
    $target = realpath($publicDir . $relative);
    if ($target === false || $root === false || !is_file($target)
        || !str_starts_with($target, $root . DIRECTORY_SEPARATOR)) {
        http_response_code(404);
        header('Content-Type: text/plain; charset=utf-8');
        echo 'Not Found';
        return;
    }
    $basename = basename($target);
    $extension = strtolower(pathinfo($target, PATHINFO_EXTENSION));
    if ($extension === 'php' || str_starts_with($basename, '.')) {
        // 不回显入口源码 / .htaccess / 点文件
        http_response_code(404);
        header('Content-Type: text/plain; charset=utf-8');
        echo 'Not Found';
        return;
    }
    $types = [
        'html' => 'text/html; charset=utf-8', 'js' => 'text/javascript; charset=utf-8',
        'mjs' => 'text/javascript; charset=utf-8', 'css' => 'text/css; charset=utf-8',
        'json' => 'application/json; charset=utf-8', 'webmanifest' => 'application/manifest+json; charset=utf-8',
        'svg' => 'image/svg+xml', 'png' => 'image/png', 'ico' => 'image/x-icon',
        'txt' => 'text/plain; charset=utf-8', 'map' => 'application/json; charset=utf-8',
        'woff2' => 'font/woff2',
    ];
    header('Content-Type: ' . ($types[$extension] ?? 'application/octet-stream'));
    header('X-Content-Type-Options: nosniff');
    header('Cache-Control: ' . (str_starts_with($relative, '/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'));
    if ($extension === 'html') {
        header('Content-Security-Policy: ' . CYRENE_CSP);
    }
    readfile($target);
}

function cyrene_read_json_body(int $maxBytes = 65536): array
{
    $text = cyrene_read_body_limited($maxBytes);
    $decoded = json_decode($text === null ? '' : $text, true);
    return is_array($decoded) ? $decoded : [];
}

/** 请求体限长读取（超限返回 null）；chunked 请求同样受 maxlen 约束。 */
function cyrene_read_body_limited(int $maxBytes): ?string
{
    $data = file_get_contents('php://input', false, null, 0, $maxBytes + 1);
    if ($data === false) {
        return '';
    }
    return strlen($data) > $maxBytes ? null : $data;
}

function cyrene_send_json(mixed $body, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}
