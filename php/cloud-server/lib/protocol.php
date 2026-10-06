<?php
declare(strict_types=1);

/**
 * 同步协议 v0 读取器/校验器（PHP 移植，IKJN7C）。
 *
 * 与 TS（src/main/sync/sync-protocol.ts）/ C#（dotnet/cyrene-core/Sync/SyncProtocolV0.cs）
 * 逐字段一致：fixtures/sync-protocol/cases 为共享契约（tests/run.php 执行同一组向量）。
 * 行级容错 / 幂等去重（首见）/ 规范序 (lamport, deviceId 序数, seq) / truncatedTail 语义同双端。
 * v0.1（IKJK2O）：+memory.write / mood.shift（伪 sessionId 命名空间 __memory__ / __mood__ 强制）。
 */

const SYNC_EVENT_TYPES = ['session.create', 'message.append', 'turn_rewind', 'tombstone', 'memory.write', 'mood.shift'];
/** mood.shift 九值枚举（对齐端侧 RUNTIME_FEELINGS）。 */
const SYNC_MOOD_FEELINGS = ['平静', '开心', '温柔', '激动', '撒娇', '担心', '难过', '感动', '害羞'];
const SYNC_ERROR_CODES = ['E_SYNC_BAD_JSON', 'E_SYNC_ENVELOPE', 'E_SYNC_TYPE', 'E_SYNC_PAYLOAD'];
const SYNC_PRESENTATION_PATCH_KEYS = [
    'content', 'reasoning', 'reasoningBlocks', 'processMessages', 'agentRounds',
    'taskDelegations', 'channelSource', 'sticker', 'toolExecutions', 'runActivity',
    'runSnapshot', 'ttsCacheKey', 'ttsCacheVersion', 'musicCard', 'contextUsage', 'delta',
];
const SYNC_ENVELOPE_KEYS = [
    'eventId', 'sessionId', 'type', 'lamport', 'deviceId', 'seq', 'ts', 'payload', 'prevHash', 'hash',
];
const SYNC_MAX_SAFE_INT = 9007199254740991;

function sync_has_only_keys(array $value, array $allowed): bool
{
    foreach (array_keys($value) as $key) {
        if (!in_array($key, $allowed, true)) {
            return false;
        }
    }
    return true;
}

function sync_is_id(mixed $value): bool
{
    if (!is_string($value)) {
        return false;
    }
    // 与 TS（无 /u 正则）/ C# 一致：按 UTF-16 码元计数（astral 字符算 2 个）
    $units = cyrene_utf16_units($value);
    if ($units < 1 || $units > 200) {
        return false;
    }
    // 拒绝 U+0000-U+001F 与 U+007F（ASCII 字节扫描；多字节序列字节均 >= 0x80，不受影响）。
    // 注：这里不用 PCRE——`$` 默认容忍串尾换行（等价 \Z），字节扫描天然拒绝含 C0 的 id。
    $length = strlen($value);
    for ($i = 0; $i < $length; $i++) {
        $byte = ord($value[$i]);
        if ($byte < 0x20 || $byte === 0x7f) {
            return false;
        }
    }
    return true;
}

function sync_is_iso_utc(mixed $value): bool
{
    // D 修饰符：PCRE 的 `$` 默认可匹配串尾换行之前（等价 \Z），会误收 "...Z\n"；
    // D = $ 仅匹配绝对串尾，与 TS 的 `$`（JS 无 multiline 时仅匹配绝对串尾）/ C# 的 \z 对齐。
    return is_string($value)
        && preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/D', $value) === 1;
}

/** 安全整数（JS Number.isSafeInteger 语义：接受整数值浮点，如 2.0）。 */
function sync_is_safe_integer(mixed $value, int $min = 0): bool
{
    if (is_int($value)) {
        return $value >= $min && $value <= SYNC_MAX_SAFE_INT;
    }
    if (is_float($value)) {
        return $value >= $min && $value <= SYNC_MAX_SAFE_INT && floor($value) === $value;
    }
    return false;
}

function sync_optional_field(array $value, string $key, callable $predicate): bool
{
    return !array_key_exists($key, $value) || $predicate($value[$key]);
}

function sync_is_hex64(mixed $value): bool
{
    // D 修饰符：同 sync_is_iso_utc——`$` 不容忍串尾换行，与 TS / C# 对齐。
    return is_string($value) && preg_match('/^[0-9a-f]{64}$/D', $value) === 1;
}

/** 单事件校验：返回 null = 有效；错误码优先级 BAD_JSON > ENVELOPE > TYPE > PAYLOAD。 */
function sync_validate_event(mixed $value): ?string
{
    if (!is_array($value)) {
        return 'E_SYNC_ENVELOPE';
    }
    if (!sync_has_only_keys($value, SYNC_ENVELOPE_KEYS)) {
        return 'E_SYNC_ENVELOPE';
    }
    foreach (['eventId', 'sessionId', 'deviceId'] as $key) {
        if (!isset($value[$key]) || !sync_is_id($value[$key])) {
            return 'E_SYNC_ENVELOPE';
        }
    }
    if (!isset($value['lamport']) || !sync_is_safe_integer($value['lamport'])) {
        return 'E_SYNC_ENVELOPE';
    }
    if (!isset($value['seq']) || !sync_is_safe_integer($value['seq'])) {
        return 'E_SYNC_ENVELOPE';
    }
    if (!sync_is_iso_utc($value['ts'] ?? null)) {
        return 'E_SYNC_ENVELOPE';
    }
    if (!isset($value['type']) || !is_string($value['type'])) {
        return 'E_SYNC_ENVELOPE';
    }
    if (!sync_optional_field($value, 'prevHash', 'sync_is_hex64')) {
        return 'E_SYNC_ENVELOPE';
    }
    if (!sync_optional_field($value, 'hash', 'sync_is_hex64')) {
        return 'E_SYNC_ENVELOPE';
    }
    if (!in_array($value['type'], SYNC_EVENT_TYPES, true)) {
        return 'E_SYNC_TYPE';
    }
    if (!isset($value['payload']) || !is_array($value['payload'])) {
        return 'E_SYNC_PAYLOAD';
    }
    return sync_validate_payload($value['type'], $value['payload'], $value['sessionId']) ? null : 'E_SYNC_PAYLOAD';
}

function sync_validate_payload(string $type, array $payload, string $sessionId): bool
{
    switch ($type) {
        case 'session.create':
            return sync_has_only_keys($payload, ['title', 'createdAt'])
                && isset($payload['title']) && is_string($payload['title'])
                && cyrene_utf16_units($payload['title']) <= 200
                && sync_is_iso_utc($payload['createdAt'] ?? null);
        case 'message.append':
            if (!sync_has_only_keys($payload, ['role', 'text', 'turnId', 'presentation'])) {
                return false;
            }
            $role = $payload['role'] ?? null;
            if ($role !== 'user' && $role !== 'assistant') {
                return false;
            }
            if (!isset($payload['text']) || !is_string($payload['text'])) {
                return false;
            }
            if ($role === 'user') {
                if (!isset($payload['turnId']) || !sync_is_id($payload['turnId'])) {
                    return false;
                }
            } elseif (!sync_optional_field($payload, 'turnId', 'sync_is_id')) {
                return false;
            }
            return sync_optional_field($payload, 'presentation', 'sync_is_presentation_patch');
        case 'turn_rewind':
            if (!sync_has_only_keys($payload, ['anchorUserTurnId', 'disposition', 'reason', 'replacementUser', 'revision'])) {
                return false;
            }
            if (!isset($payload['anchorUserTurnId']) || !sync_is_id($payload['anchorUserTurnId'])) {
                return false;
            }
            $disposition = $payload['disposition'] ?? null;
            if ($disposition !== 'keep_user' && $disposition !== 'replace_user') {
                return false;
            }
            $reason = $payload['reason'] ?? null;
            if ($reason !== 'edit' && $reason !== 'regenerate') {
                return false;
            }
            if ($disposition === 'replace_user') {
                return isset($payload['replacementUser'])
                    && sync_is_replacement_user($payload['replacementUser'])
                    && isset($payload['revision'])
                    && sync_is_safe_integer($payload['revision'], 1);
            }
            return !array_key_exists('replacementUser', $payload) && !array_key_exists('revision', $payload);
        case 'tombstone':
            return sync_has_only_keys($payload, ['targetUserTurnId', 'reason'])
                && isset($payload['targetUserTurnId']) && sync_is_id($payload['targetUserTurnId'])
                && ($payload['reason'] ?? null) === 'pending_withdrawn';
        case 'memory.write':
            // 伪会话命名空间（设计 §1.3）：不匹配 → E_SYNC_PAYLOAD
            if ($sessionId !== '__memory__') {
                return false;
            }
            if (!sync_has_only_keys($payload, ['memoryId', 'op', 'content', 'weight', 'pinned'])) {
                return false;
            }
            if (!isset($payload['memoryId']) || !sync_is_id($payload['memoryId'])) {
                return false;
            }
            $op = $payload['op'] ?? null;
            if ($op === 'upsert') {
                // upsert = 全量快照：content + weight（安全整数 0–100）必填；pinned 可选 bool
                if (!isset($payload['content']) || !is_string($payload['content'])) {
                    return false;
                }
                if (!isset($payload['weight']) || !sync_is_safe_integer($payload['weight']) || $payload['weight'] > 100) {
                    return false;
                }
                return sync_optional_field($payload, 'pinned', 'is_bool');
            }
            if ($op === 'delete') {
                // delete = 墓碑：content / weight / pinned 必须缺省（出现即 E_SYNC_PAYLOAD）
                return !array_key_exists('content', $payload)
                    && !array_key_exists('weight', $payload)
                    && !array_key_exists('pinned', $payload);
            }
            return false;
        case 'mood.shift':
            // 单键闭合 + 九值枚举 + 伪会话命名空间
            return $sessionId === '__mood__'
                && sync_has_only_keys($payload, ['feeling'])
                && in_array($payload['feeling'] ?? null, SYNC_MOOD_FEELINGS, true);
    }
    return false;
}

function sync_is_replacement_user(mixed $value): bool
{
    return is_array($value)
        && sync_has_only_keys($value, ['text'])
        && isset($value['text']) && is_string($value['text']);
}

function sync_is_presentation_patch(mixed $value): bool
{
    if (!is_array($value) || !sync_has_only_keys($value, ['patchRevision', 'patch'])) {
        return false;
    }
    if (!isset($value['patchRevision']) || !sync_is_safe_integer($value['patchRevision'], 1)) {
        return false;
    }
    if (!isset($value['patch']) || !is_array($value['patch'])) {
        return false;
    }
    $keys = array_keys($value['patch']);
    if (count($keys) === 0) {
        return false;
    }
    foreach ($keys as $key) {
        if (!in_array($key, SYNC_PRESENTATION_PATCH_KEYS, true)) {
            return false;
        }
    }
    return true;
}

/** 规范化事件（仅保留已知字段；prevHash/hash 缺省不输出；整数归一化）。 */
function sync_to_event(array $value): array
{
    $event = [
        'eventId' => $value['eventId'],
        'sessionId' => $value['sessionId'],
        'type' => $value['type'],
        'lamport' => (int)$value['lamport'],
        'deviceId' => $value['deviceId'],
        'seq' => (int)$value['seq'],
        'ts' => $value['ts'],
        'payload' => $value['payload'],
    ];
    if (array_key_exists('prevHash', $value)) {
        $event['prevHash'] = $value['prevHash'];
    }
    if (array_key_exists('hash', $value)) {
        $event['hash'] = $value['hash'];
    }
    return $event;
}

/**
 * JSONL 批读取：容错 → 校验 → 去重（首见）→ 规范排序。
 * 返回 ['events' => [], 'errors' => [['index','code']], 'droppedDuplicates' => [], 'truncatedTail' => bool]。
 */
function sync_read_batch(string $text): array
{
    $result = ['events' => [], 'errors' => [], 'droppedDuplicates' => [], 'truncatedTail' => false];
    if (str_starts_with($text, "\xEF\xBB\xBF")) {
        $text = substr($text, 3);
    }
    $lines = explode("\n", $text);
    $lastNonEmpty = -1;
    foreach ($lines as $index => $line) {
        if (trim($line) !== '') {
            $lastNonEmpty = $index;
        }
    }
    $seen = [];
    foreach ($lines as $index => $line) {
        $line = trim($line);
        if ($line === '') {
            continue;
        }
        $value = json_decode($line, true);
        if (json_last_error() !== JSON_ERROR_NONE) {
            if ($index === $lastNonEmpty) {
                $result['truncatedTail'] = true;
            } else {
                $result['errors'][] = ['index' => $index, 'code' => 'E_SYNC_BAD_JSON'];
            }
            continue;
        }
        $code = sync_validate_event($value);
        if ($code !== null) {
            $result['errors'][] = ['index' => $index, 'code' => $code];
            continue;
        }
        $event = sync_to_event($value);
        if (isset($seen[$event['eventId']])) {
            $result['droppedDuplicates'][] = $event['eventId'];
            continue;
        }
        $seen[$event['eventId']] = true;
        $result['events'][] = $event;
    }
    usort($result['events'], static function (array $left, array $right): int {
        return $left['lamport'] <=> $right['lamport']
            ?: cyrene_utf16_compare($left['deviceId'], $right['deviceId'])
            ?: $left['seq'] <=> $right['seq'];
    });
    return $result;
}

/** eventId → 0 基物理行号（与读取错误索引同一空间；仅收录通过校验的事件行，首见生效）。 */
function sync_build_line_index(string $text): array
{
    $map = [];
    if (str_starts_with($text, "\xEF\xBB\xBF")) {
        $text = substr($text, 3);
    }
    foreach (explode("\n", $text) as $index => $line) {
        $line = trim($line);
        if ($line === '') {
            continue;
        }
        $value = json_decode($line, true);
        if (is_array($value) && isset($value['eventId']) && is_string($value['eventId'])
            && sync_validate_event($value) === null && !array_key_exists($value['eventId'], $map)) {
            $map[$value['eventId']] = $index;
        }
    }
    return $map;
}
