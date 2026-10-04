<?php
declare(strict_types=1);

/**
 * cyrene-cloud-php 零依赖测试（IKJN7C）：
 * - 协议读取器跑共享 fixtures（与 TS / C# 同一组向量，逐字段一致）；
 * - 工具函数（配对码 / 设备名 / 哈希 / base64url）；
 * - 存储 / 鉴权 / 生成集成冒烟（临时 SQLite）。
 * 运行：php php/cloud-server/tests/run.php
 */
require_once __DIR__ . '/../lib/util.php';
require_once __DIR__ . '/../lib/config.php';
require_once __DIR__ . '/../lib/protocol.php';
require_once __DIR__ . '/../lib/storage.php';
require_once __DIR__ . '/../lib/store.php';
require_once __DIR__ . '/../lib/auth.php';
require_once __DIR__ . '/../lib/dialog.php';
require_once __DIR__ . '/../lib/server.php';

cyrene_harden_umask(); // 与入口一致：测试建库前收紧 umask（Linux 权限断言依赖）

$passed = 0;
$failed = 0;
function check(string $name, bool $ok, string $detail = ''): void
{
    global $passed, $failed;
    if ($ok) {
        $passed++;
        echo "[PASS] $name\n";
    } else {
        $failed++;
        echo "[FAIL] $name" . ($detail !== '' ? " —— $detail" : '') . "\n";
    }
}

// ── fixtures（协议契约） ──
$casesDir = dirname(__DIR__, 3) . '/fixtures/sync-protocol/cases';
$files = glob($casesDir . '/*.json') ?: [];
check('fixtures 目录非空', count($files) > 0, $casesDir);
sort($files);
foreach ($files as $file) {
    $case = json_decode((string)file_get_contents($file), true);
    $result = sync_read_batch($case['input']);
    $actualEvents = array_map(static fn(array $event): string => $event['eventId'], $result['events']);
    $ok = $actualEvents === ($case['expect']['events'] ?? [])
        && $result['errors'] === ($case['expect']['errors'] ?? [])
        && $result['droppedDuplicates'] === ($case['expect']['droppedDuplicates'] ?? [])
        && $result['truncatedTail'] === ($case['expect']['truncatedTail'] ?? false);
    check('fixture ' . basename($file), $ok, json_encode([
        'events' => $actualEvents,
        'errors' => $result['errors'],
        'dups' => $result['droppedDuplicates'],
        'truncatedTail' => $result['truncatedTail'],
    ], JSON_UNESCAPED_UNICODE));
}

// ── 工具 ──
check('配对码：8 位字符集', preg_match('/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/', cyrene_random_pair_code()) === 1);
check('配对码：显示格式 9 位', cyrene_format_pair_code('ABCD2345') === 'ABCD-2345');
check(
    '配对码：规范化 / 非法拒绝',
    cyrene_normalize_pair_code(' abcd-2345 ') === 'ABCD2345'
        && cyrene_normalize_pair_code('ABCD-234') === null
        && cyrene_normalize_pair_code('ABCD-234O') === null
);
check('设备名：空白 → 默认', cyrene_normalize_device_name('   ') === '未命名设备');
check('设备名：63a+emoji → 63a（不切断代理对）', cyrene_normalize_device_name(str_repeat('a', 63) . '😀') === str_repeat('a', 63));
check('设备名：超长截断 64', cyrene_normalize_device_name(str_repeat('a', 80)) === str_repeat('a', 64));
check('sha256 已知向量', cyrene_sha256_hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
check('base64url 无填充 / URL 安全', preg_match('/[+\/=]/', cyrene_base64url(random_bytes(32))) !== 1);
check(
    'id 校验：astral 按 UTF-16 码元计数（100 emoji 可 / 101 拒）',
    sync_is_id(str_repeat('😀', 100)) && !sync_is_id(str_repeat('😀', 101))
);
check(
    '规范序：UTF-16 码元序（U+10000 < U+E000；UTF-8 字节序相反）',
    cyrene_utf16_compare("\u{10000}", "\u{E000}") < 0 && strcmp("\u{10000}", "\u{E000}") > 0
);

// ── 反向代理语义（XFF 最右受信跳 / healthz 回环判定） ──
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['HTTP_X_FORWARDED_FOR'] = '203.0.113.7, 10.0.0.1';
check('XFF：取最右受信跳（不取客户端可伪造的最左值）', cyrene_client_ip() === '10.0.0.1');
check('healthz 回环判定：同机反代下外部客户端需鉴权', cyrene_is_loopback() === false);
unset($_SERVER['HTTP_X_FORWARDED_FOR']);
check('healthz 回环判定：直连回环免鉴权', cyrene_is_loopback() === true);
$_SERVER['REMOTE_ADDR'] = '203.0.113.9';
check('healthz 回环判定：非回环需鉴权', cyrene_is_loopback() === false);
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['HTTP_X_FORWARDED_FOR'] = '127.0.0.1';
check('healthz 回环判定：受信代理转发自回环仍免鉴权', cyrene_is_loopback() === true);
unset($_SERVER['HTTP_X_FORWARDED_FOR']);

// ── 集成（临时 SQLite） ──
$dataDir = sys_get_temp_dir() . '/cyrene-php-test-' . bin2hex(random_bytes(4));
mkdir($dataDir, 0700, true);
$dbPath = $dataDir . '/events.db';
$store = new EventStore($dbPath);
$auth = new AuthStore($dbPath, 300);

if (PHP_OS_FAMILY !== 'Windows') {
    // P0 存储加固断言（Linux / CI）：目录 0700；库与 -wal/-shm 0600
    check(
        '权限：数据目录 0700',
        substr(sprintf('%o', fileperms($dataDir)), -4) === '0700',
        sprintf('%o', fileperms($dataDir))
    );
    check(
        '权限：events.db 0600',
        substr(sprintf('%o', fileperms($dbPath)), -4) === '0600',
        sprintf('%o', fileperms($dbPath))
    );
    $walPath = $dbPath . '-wal';
    $walMode = is_file($walPath) ? substr(sprintf('%o', fileperms($walPath)), -4) : null;
    check('权限：-wal 0600（存在时）', $walMode === null || $walMode === '0600', (string)$walMode);
}

/** clone 流 → 事件数组（测试辅助；分页语义与线上一致）。 */
function collect_clone(EventStore $store, ?string $sessionId = null): array
{
    $outcome = $store->cloneStream($sessionId);
    return ['cursor' => $outcome['cursor'], 'events' => iterator_to_array($outcome['stream'], false)];
}

$mk = function (
    string $id,
    string $session,
    int $lamport,
    string $device,
    int $seq,
    ?array $payload = null,
    ?string $prev = null,
    ?string $hash = null
): array {
    $event = [
        'eventId' => $id,
        'sessionId' => $session,
        'type' => 'message.append',
        'lamport' => $lamport,
        'deviceId' => $device,
        'seq' => $seq,
        'ts' => '2026-10-04T03:00:00.000Z',
        'payload' => $payload ?? ['role' => 'user', 'text' => 'msg', 'turnId' => 'turn-' . $id],
    ];
    if ($prev !== null) {
        $event['prevHash'] = $prev;
    }
    if ($hash !== null) {
        $event['hash'] = $hash;
    }
    return $event;
};

$outcome = $store->pushBatch([$mk('a1', 's1', 0, 'dev-a', 0), $mk('a2', 's1', 1, 'dev-a', 1), $mk('a3', 's1', 2, 'dev-a', 2)]);
check('push 首批 accepted=3', $outcome['accepted'] === 3 && $outcome['duplicates'] === 0, json_encode($outcome));
$outcome = $store->pushBatch([$mk('a1', 's1', 0, 'dev-a', 0), $mk('a2', 's1', 1, 'dev-a', 1), $mk('a3', 's1', 2, 'dev-a', 2)]);
check('重复批幂等（accepted=0 / duplicates=3）', $outcome['accepted'] === 0 && $outcome['duplicates'] === 3);

$store->pushBatch([$mk('b3', 's2', 5, 'dev-b', 2), $mk('b1', 's2', 3, 'dev-b', 0), $mk('b2', 's2', 4, 'dev-b', 1)]);
$page1 = $store->fetch(0, 2, null);
$page2 = $store->fetch($page1['cursor'], 2, null);
$page3 = $store->fetch($page2['cursor'], 2, null);
$all = collect_clone($store);
$pagedIds = array_merge(
    array_map(static fn(array $event): string => $event['eventId'], $page1['events']),
    array_map(static fn(array $event): string => $event['eventId'], $page2['events']),
    array_map(static fn(array $event): string => $event['eventId'], $page3['events'])
);
check('分页游标不重不漏', $pagedIds === array_map(static fn(array $event): string => $event['eventId'], $all['events']));
check('clone 游标 = 全量上界', $all['cursor'] === $store->currentCursor());

$h1 = str_repeat('a', 64);
$h2 = str_repeat('b', 64);
$h3 = str_repeat('c', 64);
$baseline = count(collect_clone($store)['events']);
check('链首接受', $store->pushBatch([$mk('ch1', 's4', 1, 'dev-c', 1, null, null, $h1)])['accepted'] === 1);
check('链续接受', $store->pushBatch([$mk('ch2', 's4', 2, 'dev-c', 2, null, $h1, $h2)])['accepted'] === 1);
$bad = $store->pushBatch([$mk('bad1', 's4', 3, 'dev-c', 3, null, $h3, $h3)]);
check('坏 link → E_SYNC_CHAIN', count($bad['errors']) === 1 && $bad['errors'][0]['code'] === 'E_SYNC_CHAIN', json_encode($bad['errors']));
$bad = $store->pushBatch([$mk('bad2', 's4', 4, 'dev-c', 4, null, $h2, null)]);
check('半链（prevHash 无 hash）→ E_SYNC_CHAIN', count($bad['errors']) === 1 && $bad['errors'][0]['code'] === 'E_SYNC_CHAIN');
$bad = $store->pushBatch([$mk('bad3', 's4', 5, 'dev-c', 2)]);
check('seq 非递增 → E_SYNC_SEQ', count($bad['errors']) === 1 && $bad['errors'][0]['code'] === 'E_SYNC_SEQ');
check('失败批整批回滚（总数不变）', count(collect_clone($store)['events']) === $baseline + 2);
$lineText = json_encode($mk('lb1', 's9', 9, 'dev-e', 9, null, $h3, $h3)) . "\n"
    . json_encode($mk('lg1', 's9', 1, 'dev-e', 1));
$bad = $store->pushBatch(
    [$mk('lb1', 's9', 9, 'dev-e', 9, null, $h3, $h3), $mk('lg1', 's9', 1, 'dev-e', 1)],
    sync_build_line_index($lineText)
);
check('errors index 指向物理行号', count($bad['errors']) === 1 && $bad['errors'][0]['index'] === 0, json_encode($bad['errors']));

[$code, $expiresAt] = $auth->createPairCode('master');
check('配对码格式（XXXX-XXXX）', strlen($code) === 9, $code);
$redeemed = $auth->redeem($code, '烟测手机');
check(
    '兑换签发 device token',
    $redeemed !== null && str_starts_with($redeemed['token'], 'cyn_') && str_starts_with($redeemed['deviceId'], 'dev_')
);
check('配对码一次性', $auth->redeem($code, 'again') === null);
check('device token 可用 / 伪造拒绝', $auth->tryAuthenticate($redeemed['token']) !== null && $auth->tryAuthenticate('cyn_forged') === null);
$newToken = $auth->rotate($redeemed['deviceId']);
check(
    '轮换即时生效（旧 401 / 新 200）',
    $newToken !== null && $auth->tryAuthenticate($redeemed['token']) === null && $auth->tryAuthenticate($newToken) !== null
);
check('撤销即时生效', $auth->revoke($redeemed['deviceId']) && $auth->tryAuthenticate($newToken) === null);
$truncated = $auth->redeem($auth->createPairCode('t')[0], str_repeat('a', 63) . '😀');
check('设备名截断（63a+emoji → 63a）', $truncated !== null && $truncated['name'] === str_repeat('a', 63));

putenv('CLOUD_LLM_MODE=echo');
$dialog = new DialogLoop($store, cyrene_config());
$userEvent = $mk('g1', 'sg', 1, 'dev-g', 1, ['role' => 'user', 'text' => '你好', 'turnId' => 'turn-g1']);
$store->pushBatch([$userEvent]);
$dialog->trigger([$userEvent]);
$generated = array_values(array_filter($store->loadSessionEvents('sg'), static fn(array $event): bool => str_starts_with($event['eventId'], 'gen-')));
check(
    '内联生成（echo）写回 assistant',
    count($generated) === 1 && $generated[0]['payload']['text'] === '回声：你好' && $generated[0]['deviceId'] === 'server',
    json_encode($generated, JSON_UNESCAPED_UNICODE)
);
$dialog->trigger([$userEvent]);
$generatedAgain = array_values(array_filter($store->loadSessionEvents('sg'), static fn(array $event): bool => str_starts_with($event['eventId'], 'gen-')));
check('生成幂等（不重复写回）', count($generatedAgain) === 1);
putenv('CLOUD_LLM_MODE');

foreach (glob($dataDir . '/*') ?: [] as $file) {
    @unlink($file);
}
@rmdir($dataDir);

echo "\ncyrene-cloud-php 测试：" . $passed . " passed / " . $failed . " failed\n";
exit($failed === 0 ? 0 : 1);
