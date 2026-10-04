<?php
declare(strict_types=1);

/**
 * 运行配置（IKJN7C）：环境变量为主，命名与 .NET / CF 版 CLOUD_* 对齐。
 * 真实虚拟主机不便设置 env 时，可在 php/cloud-server/ 放 config.local.php
 * （返回覆盖数组；示例见 README）。
 */

function cyrene_config(): array
{
    $config = [
        'data_dir' => getenv('CYRENE_CLOUD_DATA') ?: dirname(__DIR__) . '/data',
        'master_token' => (getenv('CLOUD_TOKEN') ?: '') ?: null,
        'allowed_hosts' => getenv('CLOUD_ALLOWED_HOSTS') ?: '',
        'pair_ttl_seconds' => cyrene_int_env('CLOUD_PAIR_TTL_SECONDS', 300),
        'rate_sync_per_min' => cyrene_int_env('CLOUD_RATE_SYNC_PER_MIN', 300),
        'rate_pair_per_min' => cyrene_int_env('CLOUD_RATE_PAIR_PER_MIN', 10),
        'llm_api_key' => (getenv('CLOUD_LLM_API_KEY') ?: '') ?: null,
        'llm_model' => getenv('CLOUD_LLM_MODEL') ?: 'gpt-4o-mini',
        'llm_base_url' => getenv('CLOUD_LLM_BASE_URL') ?: 'https://api.openai.com/v1',
        'llm_mode' => strtolower(trim(getenv('CLOUD_LLM_MODE') ?: '')),
        'llm_system_prompt' => getenv('CLOUD_LLM_SYSTEM_PROMPT') ?: '',
        'llm_context_chars' => cyrene_int_env('CLOUD_LLM_CONTEXT_CHARS', 24000),
        'llm_max_tokens' => cyrene_int_env('CLOUD_LLM_MAX_TOKENS', 1024),
        'llm_timeout_seconds' => cyrene_int_env('CLOUD_LLM_TIMEOUT_SECONDS', 60),
        'max_push_bytes' => 10 * 1024 * 1024,
    ];
    $local = dirname(__DIR__) . '/config.local.php';
    if (is_file($local)) {
        $overrides = require $local;
        if (is_array($overrides)) {
            $config = array_merge($config, $overrides);
        }
    }
    return $config;
}

/** 服务端生成是否启用：echo mock 或模型 API 密钥（与 .NET / CF 口径一致）。 */
function cyrene_generation_enabled(): bool
{
    $config = cyrene_config();
    return $config['llm_mode'] === 'echo' || $config['llm_api_key'] !== null;
}
