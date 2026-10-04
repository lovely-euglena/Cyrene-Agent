<?php
declare(strict_types=1);

/**
 * PHP 空间版通用工具（IKJN7C）：随机 / 哈希 / 配对码 / 设备名。
 * 语义与 .NET AuthStore / TS util / CF util 逐项对齐（字母表、格式、UTF-16 截断规则）。
 */

const PAIR_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const PAIR_CODE_LENGTH = 8;
const MAX_DEVICE_NAME_UNITS = 64;
const DEFAULT_DEVICE_NAME = '未命名设备';

function cyrene_sha256_hex(string $value): string
{
    return hash('sha256', $value);
}

/** RFC 4648 base64url（无填充；与 .NET Convert.ToBase64String + 替换一致）。 */
function cyrene_base64url(string $bytes): string
{
    return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
}

function cyrene_random_hex(int $bytes): string
{
    return bin2hex(random_bytes($bytes));
}

/** 8 位配对码（random_int 均匀采样）。 */
function cyrene_random_pair_code(): string
{
    $length = strlen(PAIR_CODE_ALPHABET);
    $code = '';
    for ($i = 0; $i < PAIR_CODE_LENGTH; $i++) {
        $code .= PAIR_CODE_ALPHABET[random_int(0, $length - 1)];
    }
    return $code;
}

/** 显示格式 XXXX-XXXX（与 .NET FormatCode 一致）。 */
function cyrene_format_pair_code(string $code): string
{
    return substr($code, 0, 4) . '-' . substr($code, 4);
}

/** 规范化用户输入的配对码（去空格/连字符、大写、校验字符集与长度；非法返回 null）。 */
function cyrene_normalize_pair_code(mixed $input): ?string
{
    if (!is_string($input) || trim($input) === '') {
        return null;
    }
    $upper = strtoupper($input); // ASCII 逐字节（非 ASCII 字节不匹配字母表 → null）
    $normalized = '';
    $length = strlen($upper);
    for ($i = 0; $i < $length; $i++) {
        $char = $upper[$i];
        if ($char === ' ' || $char === '-') {
            continue;
        }
        if (strpos(PAIR_CODE_ALPHABET, $char) === false) {
            return null;
        }
        $normalized .= $char;
        if (strlen($normalized) > PAIR_CODE_LENGTH) {
            return null;
        }
    }
    return strlen($normalized) === PAIR_CODE_LENGTH ? $normalized : null;
}

/** UTF-16 码元长度（与 JS .length / C# string.Length 对齐）。 */
function cyrene_utf16_units(string $value): int
{
    return intdiv(strlen(mb_convert_encoding($value, 'UTF-16LE', 'UTF-8')), 2);
}

/** 设备名：空白 → 默认名；超 64 UTF-16 码元截断且不切断代理对（与 .NET / TS 一致）。 */
function cyrene_normalize_device_name(mixed $input): string
{
    $trimmed = is_string($input) ? trim($input) : '';
    $name = $trimmed !== '' ? $trimmed : DEFAULT_DEVICE_NAME;
    $utf16 = mb_convert_encoding($name, 'UTF-16LE', 'UTF-8');
    if (strlen($utf16) > MAX_DEVICE_NAME_UNITS * 2) {
        $utf16 = substr($utf16, 0, MAX_DEVICE_NAME_UNITS * 2);
        $last = unpack('v', substr($utf16, -2))[1];
        if ($last >= 0xD800 && $last <= 0xDBFF) {
            $utf16 = substr($utf16, 0, -2); // 不切断代理对
        }
        $name = mb_convert_encoding($utf16, 'UTF-8', 'UTF-16LE');
    }
    return $name;
}

/** 正整数环境变量（非法/缺省回退；与 .NET ReadIntEnv 一致）。 */
function cyrene_int_env(string $name, int $fallback): int
{
    $value = getenv($name);
    if ($value === false || !preg_match('/^\d+$/', $value)) {
        return $fallback;
    }
    $parsed = (int)$value;
    return $parsed > 0 ? $parsed : $fallback;
}
