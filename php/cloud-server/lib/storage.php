<?php
declare(strict_types=1);

/**
 * 存储权限加固（IKJN7C 评审 P0）：对照 .NET StorageHardening.cs 的三层 best-effort。
 *
 * - 入口 / cron 在建库前调用 cyrene_harden_umask()（@umask(0077)；Windows 无效果）；
 * - 数据目录 0700；events.db / -wal / -shm 0600（存在才 chmod）；
 * - 失败一律 best-effort（虚拟主机可能不支持 chmod）；Linux 权限断言见 tests/run.php。
 */

function cyrene_harden_umask(): void
{
    @umask(0077);
}

function cyrene_harden_storage(string $dir, string $dbPath): void
{
    if (!is_dir($dir)) {
        @mkdir($dir, 0700, true);
    }
    @chmod($dir, 0700);
    foreach ([$dbPath, $dbPath . '-wal', $dbPath . '-shm'] as $file) {
        if (is_file($file)) {
            @chmod($file, 0600);
        }
    }
}
