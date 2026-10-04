<?php
declare(strict_types=1);

/**
 * 同步协议 v0 读取器/校验器（PHP 移植，IKJN7C）。
 *
 * 与 TS（src/main/sync/sync-protocol.ts）/ C#（dotnet/cyrene-core/Sync/SyncProtocolV0.cs）
 * 逐字段一致：fixtures/sync-protocol/cases 为共享契约（tests/run.php 执行同一组向量）。
 * 行级容错 / 幂等去重（首见）/ 规范序 (lamport, deviceId 序数, seq) / truncatedTail 语义同双端。
 */

const SYNC_EVENT_TYPES = ['session.create', 'message.append', 'turn_rewind', 'tombstone'];
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
    return is_string($value) && preg_match('/^[^\x00-\x1f\x7f]{1,200}$/u', $value) === 1;
}

function sync_is_iso_utc(mixed $value): bool
{
    return is_string($value)
        && preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/', $value) === 1;
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
    return is_string($value) && preg_match('/^[0-9a-f]{64}$/', $value) === 1;
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
    return sync_validate_payload($value['type'], $value['payload']) ? null : 'E_SYNC_PAYLOAD';
}

function sync_validate_payload(string $type, array $payload): bool
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
            ?: strcmp($left['deviceId'], $right['deviceId'])
            ?: $left['seq'] <=> $right['seq'];
    });
    return $result;
}

/** eventId → 0 基物理行号（与读取错误索引同一空间；首见生效）。 */
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
        if (is_array($value) && isset($value['eventId']) && is_string($value['eventId']) && !array_key_exists($value['eventId'], $map)) {
            $map[$value['eventId']] = $index;
        }
    }
    return $map;
}
