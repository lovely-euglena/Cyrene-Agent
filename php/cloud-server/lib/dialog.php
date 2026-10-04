<?php
declare(strict_types=1);

require_once __DIR__ . '/store.php';

/** 模型确定性配置错误（密钥/模型/地址）：重试无意义。 */
final class ModelConfigException extends RuntimeException
{
}

/**
 * 服务端生成（IKJN7C，降级档：push 内联尽力 + 可选 cron 排空 + 桌面兜底）。
 *
 * - 幂等：assistant eventId = gen-<sha256(sessionId:锚点事件id)[..32]>（与 .NET / CF 一致）；
 * - 重放与 .NET DialogLoop.Replay 逐条对齐（keep_user / replace_user / tombstone）；
 * - 超预算（max_execution_time 内放不下）或失败 → dialog_pending 挂起，由 bin/drain.php（cron）重试；
 * - 日志只含会话 id / 状态，不含消息正文与密钥。
 */
final class DialogLoop
{
    private const SERVER_DEVICE_ID = 'server';
    private const MAX_ATTEMPTS = 3;

    public function __construct(
        private readonly EventStore $store,
        private readonly array $config,
    ) {
    }

    /** push 成功后触发：有新用户消息 / 回退的会话 → 内联尽力生成（超预算转挂起）。 */
    public function trigger(array $events): void
    {
        if (!cyrene_generation_enabled()) {
            return;
        }
        $sessions = [];
        foreach ($events as $event) {
            if ($event['type'] === 'turn_rewind') {
                $sessions[$event['sessionId']] = true;
                continue;
            }
            if ($event['type'] === 'message.append' && ($event['payload']['role'] ?? null) === 'user') {
                $sessions[$event['sessionId']] = true;
            }
        }
        $deadline = $this->inlineDeadline();
        foreach (array_keys($sessions) as $sessionId) {
            if (microtime(true) >= $deadline - 5) {
                $this->enqueue($sessionId); // 超预算：挂起，交给 cron / 桌面兜底
                continue;
            }
            if ($this->processSession($sessionId, $deadline) === 'retry') {
                $this->enqueue($sessionId);
            }
        }
    }

    /** cron 排空（bin/drain.php）：处理到期挂起项，返回处理条数。 */
    public function drain(int $limit = 20): int
    {
        if (!cyrene_generation_enabled()) {
            return 0;
        }
        $statement = $this->store->pdo()->prepare(
            'SELECT session_id, attempts FROM dialog_pending WHERE next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?'
        );
        $statement->execute([(int)(microtime(true) * 1000), $limit]);
        $processed = 0;
        foreach ($statement->fetchAll() as $row) {
            $processed++;
            $sessionId = $row['session_id'];
            $attempts = (int)$row['attempts'];
            if ($this->processSession($sessionId, $this->inlineDeadline()) === 'done') {
                $this->dequeue($sessionId);
                continue;
            }
            if ($attempts + 1 >= self::MAX_ATTEMPTS) {
                error_log('生成重试耗尽 session=' . $sessionId);
                $this->dequeue($sessionId);
                continue;
            }
            $delaySeconds = 30 * (2 ** ($attempts + 1)); // 60s / 120s
            $this->store->pdo()->prepare(
                'UPDATE dialog_pending SET attempts = ?, next_attempt_at = ? WHERE session_id = ?'
            )->execute([$attempts + 1, (int)(microtime(true) * 1000) + $delaySeconds * 1000, $sessionId]);
        }
        return $processed;
    }

    /** 处理一个会话；'done' = 完成/无需处理，'retry' = 交给挂起重试。 */
    public function processSession(string $sessionId, float $deadline): string
    {
        $events = $this->store->loadSessionEvents($sessionId);
        if (count($events) === 0) {
            return 'done';
        }
        $branch = $this->replayBranch($events);
        if (count($branch) === 0 || $branch[count($branch) - 1]['role'] !== 'user') {
            return 'done';
        }
        $pending = $branch[count($branch) - 1];
        if (trim($pending['text']) === '') {
            return 'done';
        }

        $assistantEventId = 'gen-' . substr(cyrene_sha256_hex($sessionId . ':' . $pending['anchorEventId']), 0, 32);
        if ($this->store->eventIdExists($assistantEventId)) {
            return 'done';
        }

        $context = array_map(
            static fn(array $message): array => ['role' => $message['role'], 'content' => $message['text']],
            $branch
        );
        if ($this->config['llm_system_prompt'] !== '') {
            array_unshift($context, ['role' => 'system', 'content' => $this->config['llm_system_prompt']]);
        }
        $context = $this->trimContext($context, (int)$this->config['llm_context_chars']);

        try {
            $completion = $this->complete($context, $deadline);
        } catch (ModelConfigException $error) {
            error_log('模型配置不可用（不重试）session=' . $sessionId . ' ' . $error->getMessage());
            return 'done';
        } catch (Throwable $error) {
            error_log('模型调用失败 session=' . $sessionId . ' ' . $error->getMessage());
            return 'retry';
        }
        if (trim($completion) === '') {
            return 'done';
        }

        $watermark = $this->store->sessionWatermark($sessionId, self::SERVER_DEVICE_ID);
        $generated = [
            'eventId' => $assistantEventId,
            'sessionId' => $sessionId,
            'type' => 'message.append',
            'lamport' => $watermark['maxLamport'] + 1,
            'deviceId' => self::SERVER_DEVICE_ID,
            'seq' => $watermark['maxSeq'] + 1,
            'ts' => cyrene_iso_now(),
            'payload' => ['role' => 'assistant', 'text' => $completion, 'turnId' => $pending['turnId']],
        ];
        $outcome = $this->store->pushBatch([$generated], null);
        if (count($outcome['errors']) > 0) {
            error_log('生成写回被拒 session=' . $sessionId . ' errors=' . json_encode($outcome['errors']));
            return 'retry';
        }
        return 'done';
    }

    /** 事件重放 → 活动分支消息流（与 .NET DialogLoop.Replay 对齐）。 */
    private function replayBranch(array $events): array
    {
        $messages = [];
        $turnIndex = [];
        foreach ($events as $event) {
            if ($event['type'] === 'message.append') {
                $payload = $event['payload'];
                $role = $payload['role'];
                $text = $payload['text'];
                $turnId = is_string($payload['turnId'] ?? null) ? $payload['turnId'] : '';
                if ($role === 'user' && $turnId !== '') {
                    $turnIndex[$turnId] = count($messages);
                }
                $messages[] = ['role' => $role, 'text' => $text, 'turnId' => $turnId, 'anchorEventId' => $event['eventId']];
            } elseif ($event['type'] === 'turn_rewind') {
                $payload = $event['payload'];
                $anchor = $payload['anchorUserTurnId'];
                if (!array_key_exists($anchor, $turnIndex)) {
                    continue;
                }
                $index = $turnIndex[$anchor];
                if ($payload['disposition'] === 'keep_user') {
                    $messages = array_slice($messages, 0, $index + 1);
                    $messages[$index]['anchorEventId'] = $event['eventId'];
                } else {
                    $messages = array_slice($messages, 0, $index);
                    $messages[] = [
                        'role' => 'user',
                        'text' => $payload['replacementUser']['text'],
                        'turnId' => $anchor,
                        'anchorEventId' => $event['eventId'],
                    ];
                }
                $turnIndex = $this->reindex($messages);
            } elseif ($event['type'] === 'tombstone') {
                $target = $event['payload']['targetUserTurnId'];
                if (!array_key_exists($target, $turnIndex)) {
                    continue;
                }
                $index = $turnIndex[$target];
                $end = $index + 1;
                while ($end < count($messages) && $messages[$end]['role'] === 'assistant') {
                    $end++;
                }
                array_splice($messages, $index, $end - $index);
                $turnIndex = $this->reindex($messages);
            }
        }
        return $messages;
    }

    private function reindex(array $messages): array
    {
        $turnIndex = [];
        foreach ($messages as $index => $message) {
            if ($message['role'] === 'user' && $message['turnId'] !== '') {
                $turnIndex[$message['turnId']] = $index;
            }
        }
        return $turnIndex;
    }

    /** 按字符预算从最旧开始丢（保留 system prompt 与最后一条待回复 user；UTF-16 码元口径）。 */
    private function trimContext(array $context, int $contextChars): array
    {
        $startIndex = (count($context) > 0 && $context[0]['role'] === 'system') ? 1 : 0;
        $total = 0;
        foreach ($context as $item) {
            $total += cyrene_utf16_units($item['content']);
        }
        $drop = $startIndex;
        $maxDrop = count($context) - 1;
        while ($total > $contextChars && $drop < $maxDrop) {
            $total -= cyrene_utf16_units($context[$drop]['content']);
            $drop++;
        }
        if ($drop > $startIndex) {
            array_splice($context, $startIndex, $drop - $startIndex);
        }
        return $context;
    }

    /** 模型调用：echo mock（测试）或 OpenAI 兼容 Chat Completions。 */
    private function complete(array $context, float $deadline): string
    {
        if ($this->config['llm_mode'] === 'echo') {
            $lastUser = '';
            foreach (array_reverse($context) as $item) {
                if ($item['role'] === 'user') {
                    $lastUser = $item['content'];
                    break;
                }
            }
            return '回声：' . $lastUser;
        }
        $timeout = min(
            (int)$this->config['llm_timeout_seconds'],
            max(1, (int)floor($deadline - microtime(true)) - 1)
        );
        $payload = json_encode([
            'model' => $this->config['llm_model'],
            'messages' => $context,
            'max_tokens' => (int)$this->config['llm_max_tokens'],
        ], JSON_UNESCAPED_UNICODE);
        $curl = curl_init(rtrim($this->config['llm_base_url'], '/') . '/chat/completions');
        curl_setopt_array($curl, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $payload,
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'Authorization: Bearer ' . $this->config['llm_api_key'],
            ],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_CONNECTTIMEOUT => min(10, $timeout),
        ]);
        $body = curl_exec($curl);
        if ($body === false) {
            $error = curl_error($curl);
            curl_close($curl);
            throw new RuntimeException('model: ' . $error);
        }
        $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        curl_close($curl);
        if ($status === 401 || $status === 403 || $status === 404) {
            throw new ModelConfigException('model config ' . $status);
        }
        if ($status < 200 || $status >= 300) {
            throw new RuntimeException('model http ' . $status);
        }
        $data = json_decode((string)$body, true);
        $text = $data['choices'][0]['message']['content'] ?? '';
        error_log('生成成功 model=' . $this->config['llm_model'] . ' messages=' . count($context));
        return is_string($text) ? $text : '';
    }

    /** 内联预算：max_execution_time 内留 2s 余量（CLI/0 = 保守 30s）。 */
    private function inlineDeadline(): float
    {
        $maxExecution = (int)ini_get('max_execution_time');
        if ($maxExecution <= 0) {
            $maxExecution = 30;
        }
        return microtime(true) + max(5, $maxExecution - 2);
    }

    private function enqueue(string $sessionId): void
    {
        $this->store->pdo()->prepare(
            'INSERT OR IGNORE INTO dialog_pending (session_id, enqueued_at, attempts, next_attempt_at) VALUES (?, ?, 0, ?)'
        )->execute([$sessionId, cyrene_iso_now(), (int)(microtime(true) * 1000)]);
    }

    private function dequeue(string $sessionId): void
    {
        $this->store->pdo()->prepare('DELETE FROM dialog_pending WHERE session_id = ?')->execute([$sessionId]);
    }
}
