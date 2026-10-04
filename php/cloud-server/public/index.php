<?php
declare(strict_types=1);

/**
 * cyrene-cloud-php 入口（IKJN7C）。
 *
 * 本地（便携 PHP）：
 *   php -S 127.0.0.1:8088 -t php/cloud-server/public php/cloud-server/public/index.php
 * 虚拟主机（Apache）：把 public/ 作为站点根（见同目录 .htaccess）；数据目录须可写（默认 ../data）。
 */
require_once __DIR__ . '/../lib/util.php';
require_once __DIR__ . '/../lib/config.php';
require_once __DIR__ . '/../lib/protocol.php';
require_once __DIR__ . '/../lib/store.php';
require_once __DIR__ . '/../lib/auth.php';
require_once __DIR__ . '/../lib/dialog.php';
require_once __DIR__ . '/../lib/server.php';

cyrene_run(__DIR__);
