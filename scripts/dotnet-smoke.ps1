# Cyrene .NET 后端实机冒烟脚本（C3）——Windows PowerShell 运行
# 用法：发布 cyrene-native 后，在本仓库根：powershell -File scripts\dotnet-smoke.ps1
# 前置：dotnet publish dotnet/native-windows -c Release；exe 路径按需改 $exe

$ErrorActionPreference = "Stop"
$exe = Resolve-Path ".\dotnet\native-windows\bin\Release\net10.0-windows\cyrene-native.exe" -ErrorAction SilentlyContinue
if (-not $exe) { $exe = Join-Path $env:APPDATA "cyrene\resources\native-windows\cyrene-native.exe" }
if (-not (Test-Path $exe)) { Write-Host "[SMOKE] 找不到 cyrene-native.exe，先 dotnet publish" -f Red; exit 1 }

function Invoke-HostFrames([string]$mode, [string[]]$frames) {
    $input_text = ($frames -join "`n")
    return ($input_text | & $exe $mode) 2>$null
}

$pass = 0; $fail = 0
function Check([string]$name, [bool]$ok) {
    if ($ok) { $script:pass++; Write-Host "[PASS] $name" -f Green }
    else { $script:fail++; Write-Host "[FAIL] $name" -f Red }
}

# ── 1. tool-host：六工具 + 双轨 diff（D4 语义等价）──
$out = Invoke-HostFrames "--tool-host" @(
    '{"op":"call","callId":"c1","tool":"calculator","args":{"expression":"2^10"}}',
    '{"op":"call","callId":"c2","tool":"fs_list_dir","args":{"path":"."}}',
    '{"op":"shutdown"}')
Check "tool-host calculator/fs 输出 JSON 帧" ($out -match '"op":"result"')

# ── 2. agent-host：LLM 回调闭环（H4）──
$out = Invoke-HostFrames "--agent-host" @(
    '{"op":"create","sessionId":"s1","config":{"allowedTools":["read_file"]}}',
    '{"op":"step","callId":"a1","sessionId":"s1","message":"hi"}',
    '{"op":"llm_response","callId":"a1","content":{"text":"done"}}',
    '{"op":"shutdown"}')
Check "agent-host 闭环 result done" ($out -match '"state":"done"')

# ── 3. rag-host：迁移 + 逐 query（E8）──
$tmp = Join-Path $env:TEMP "cyrene-rag-smoke"
New-Item -ItemType Directory -Force $tmp | Out-Null
'{"entries":[{"id":"e1","text":"今天天气很好","embedding":[0.1,0.2],"source":"user_memory"}]}' | Set-Content "$tmp\mem.json"
$out = Invoke-HostFrames "--rag-host" @(
    ('{"op":"open","dbPath":"' + ($tmp -replace '\\','\\') + '\\rag.db","jsonImportPath":"' + ($tmp -replace '\\','\\') + '\\mem.json"}'),
    '{"op":"query","callId":"q1","embedding":[0.1,0.2],"text":"天气","topK":4}',
    '{"op":"stats"}',
    '{"op":"shutdown"}')
Check "rag-host 迁移+查询" ($out -match '"ok":true')

# ── 4. VAD 三模式（G5）——CyreneVoice 需另行发布 ──
$vexe = Join-Path (Split-Path $exe) "CyreneVoice.exe"
if (Test-Path $vexe) {
    $pcm = [Convert]::ToBase64String((New-Object byte[] 1024))  # 静音帧
    $out = Invoke-HostFrames $vexe @(
        '{"op":"vad_config","mode":"local","threshold":0.5}',
        ('{"op":"vad_audio","callId":"v1","pcm16Base64":"' + $pcm + '"}'),
        '{"op":"shutdown"}')
    Check "voice VAD local 静音判定" ($out -match '"speech":false')
} else {
    Write-Host "[SKIP] CyreneVoice.exe 未发布（语音冒烟跳过）" -f Yellow
}

# ── 5. 双轨开关（C4）──
$env:CYRENE_TOOL_HOST = "0"
Check "CYRENE_TOOL_HOST=0 读取" (-not $env:CYRENE_TOOL_HOST.Equals("1"))
$env:CYRENE_TOOL_HOST = "1"

Write-Host "`n冒烟汇总: $pass 通过 / $fail 失败" -f Cyan
if ($fail -gt 0) { exit 1 }
