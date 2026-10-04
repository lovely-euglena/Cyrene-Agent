<?php
declare(strict_types=1);

/**
 * 挂起生成排空（IKJN7C）：真实空间 cron 示例
 *   * * * * * php /path/to/cyrene-cloud-php/bin/drain.php >> /path/to/drain.log 2>&1
 * 未接 cron 时由桌面端在线兜底生成（推送内联尽力失败不影响同步）。
 */
require_once __DIR__ . '/../lib/util.php';
require_once __DIR__ . '/../lib/config.php';
require_once __DIR__ . '/../lib/protocol.php';
require_once __DIR__ . '/../lib/storage.php';
require_once __DIR__ . '/../lib/store.php';
require_once __DIR__ . '/../lib/auth.php';
require_once __DIR__ . '/../lib/dialog.php';

cyrene_harden_umask(); // 与入口一致：cron 建库前收紧 umask

$config = cyrene_config();
$dbPath = rtrim($config['data_dir'], '/\\') . DIRECTORY_SEPARATOR . 'events.db';
$store = new EventStore($dbPath);
$dialog = new DialogLoop($store, $config);
echo 'drained: ' . $dialog->drain(20) . PHP_EOL;
