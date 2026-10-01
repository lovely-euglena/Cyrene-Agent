# install-bge-m3.ps1
# 下载 BGE-M3（Xenova ONNX 量化版）到 models/Xenova/bge-m3/
# 目录布局与 src/main/rag/model-status.ts 的探测约定一致：
#   tokenizer.json / config.json / onnx/model_quantized.onnx  （必装，三缺一判「未安装」）
#   tokenizer_config.json / special_tokens_map.json / sentencepiece.bpe.model （可选附属）
#
# 用法（PowerShell）：
#   .\scripts\install-bge-m3.ps1                    # 自动选源：hf-mirror → 官方源
#   .\scripts\install-bge-m3.ps1 -Mirror official   # 只用官方源
#   .\scripts\install-bge-m3.ps1 -Force             # 已存在文件也重新下载
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-bge-m3.ps1

param(
    [switch]$Force,
    [ValidateSet("auto", "hf-mirror", "official")]
    [string]$Mirror = "auto"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # 关掉 IWR 进度条（大文件下会严重拖慢）

$repoRoot = Split-Path -Parent $PSScriptRoot
$targetDir = Join-Path $repoRoot "models\Xenova\bge-m3"

# rel：目标相对路径（/ 分隔）；minBytes：低于此值视为不完整；required：缺失 = 安装失败
$files = @(
    @{ rel = "onnx/model_quantized.onnx"; minBytes = 50MB; required = $true },
    @{ rel = "tokenizer.json";            minBytes = 1MB;  required = $true },
    @{ rel = "config.json";               minBytes = 10;   required = $true },
    @{ rel = "tokenizer_config.json";     minBytes = 10;   required = $false },
    @{ rel = "special_tokens_map.json";   minBytes = 10;   required = $false },
    @{ rel = "sentencepiece.bpe.model";   minBytes = 1MB;  required = $false }
)

# ── 候选下载源（按尝试顺序） ──
$sources = @()
if ($Mirror -ne "official") {
    $sources += @{ name = "hf-mirror.com（国内镜像）"; base = "https://hf-mirror.com/Xenova/bge-m3/resolve/main/" }
}
if ($Mirror -ne "hf-mirror") {
    $sources += @{ name = "huggingface.co（官方源）"; base = "https://huggingface.co/Xenova/bge-m3/resolve/main/" }
}

# ── 工具函数 ──

function Get-LocalPath([string]$rel) {
    return Join-Path $targetDir ($rel -replace '/', '\')
}

# HEAD 探测；服务器不支持 HEAD（405）时退回 Range: 0-0 的 GET。
function Test-UrlReachable([string]$url, [int]$timeoutSec = 20) {
    foreach ($method in @("HEAD", "GET")) {
        try {
            $req = [System.Net.HttpWebRequest]::Create($url)
            $req.Method = $method
            $req.Timeout = $timeoutSec * 1000
            $req.UserAgent = "Mozilla/5.0 (cyrene-model-installer)"
            if ($method -eq "GET") { $req.AddRange(0, 0) }
            $resp = $req.GetResponse()
            $status = [int]$resp.StatusCode
            $resp.Close()
            if ($status -ge 200 -and $status -lt 400) { return $status }
        } catch {
            $resp = $_.Exception.Response
            if ($resp) {
                $status = [int]$resp.StatusCode
                if ($status -ge 200 -and $status -lt 400) { return $status }
            }
        }
    }
    return $null
}

# 下载：优先 BITS（支持断点续传），失败退回 Invoke-WebRequest。
function Download-File([string]$url, [string]$dest, [string]$label) {
    Write-Host "        下载 $label ..." -ForegroundColor DarkGray
    $attempts = @()
    if (Get-Command Start-BitsTransfer -ErrorAction SilentlyContinue) {
        $attempts += { Start-BitsTransfer -Source $url -Destination $dest -ErrorAction Stop }
    }
    $attempts += { Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 3600 }
    foreach ($attempt in $attempts) {
        try {
            & $attempt
            return $true
        } catch {
            if (Test-Path $dest) { Remove-Item $dest -Force -ErrorAction SilentlyContinue }
        }
    }
    return $false
}

# 已完成文件集合（本次会话内：下载成功或确认已完整）
$downloaded = @{}

# ── 主流程 ──
Write-Host ""
Write-Host "[install-bge-m3] 目标目录：$targetDir" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

$anyDownload = $false
foreach ($src in $sources) {
    # 计算当前待下载文件（已有完整文件且非 -Force 时直接跳过）
    $pendingFiles = @()
    foreach ($f in $files) {
        if ($downloaded.ContainsKey($f.rel)) { continue }
        $local = Get-LocalPath $f.rel
        if ((-not $Force) -and (Test-Path $local) -and ((Get-Item $local).Length -ge $f.minBytes)) {
            $downloaded[$f.rel] = $true
            continue
        }
        $pendingFiles += $f
    }
    if ($pendingFiles.Count -eq 0) { break }

    Write-Host ""
    Write-Host "[install-bge-m3] 尝试源：$($src.name)" -ForegroundColor Cyan
    foreach ($f in $pendingFiles) {
        $rel = [string]$f.rel
        $remote = if ($src.ContainsKey("remap") -and $src.remap.ContainsKey($rel)) { $src.remap[$rel] } else { $rel }
        $url = [string]$src.base + $remote
        $local = Get-LocalPath $rel

        $status = Test-UrlReachable $url
        if (-not $status) {
            Write-Host "  ✗ $rel 不可达（跳过）" -ForegroundColor DarkGray
            continue
        }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $local) | Out-Null
        if (-not (Download-File $url $local $rel)) {
            Write-Host "  ✗ $rel 下载失败（跳过）" -ForegroundColor DarkGray
            continue
        }

        $size = (Get-Item $local).Length
        if ($size -lt $f.minBytes) {
            Write-Host "  ✗ $rel 大小异常（$([math]::Round($size / 1MB, 2)) MB），删除后尝试其它源" -ForegroundColor Red
            Remove-Item $local -Force -ErrorAction SilentlyContinue
            continue
        }
        $downloaded[$rel] = $true
        $anyDownload = $true
        Write-Host "  ✓ $rel（$([math]::Round($size / 1MB, 2)) MB）" -ForegroundColor Green
    }
}

# ── 结果校验 ──
$missingRequired = @()
$missingOptional = @()
$totalBytes = 0
foreach ($f in $files) {
    $local = Get-LocalPath $f.rel
    $ok = (Test-Path $local) -and ((Get-Item $local).Length -ge $f.minBytes)
    if ($ok) { $totalBytes += (Get-Item $local).Length; continue }
    if ($f.required) { $missingRequired += $f.rel } else { $missingOptional += $f.rel }
}

Write-Host ""
if ($missingRequired.Count -gt 0) {
    Write-Host "[install-bge-m3] ✗ 安装未完成，缺少必装文件：" -ForegroundColor Red
    foreach ($m in $missingRequired) { Write-Host "  - $m" -ForegroundColor Red }
    Write-Host "  可切换镜像源重试（-Mirror hf-mirror / -Mirror official），或参考 docs/local-models.md 手动下载。" -ForegroundColor Yellow
    exit 1
}

if (-not $anyDownload) {
    Write-Host "[install-bge-m3] ✓ 文件已齐全，无需下载（-Force 可强制重新下载）。" -ForegroundColor Green
} else {
    Write-Host "[install-bge-m3] ✓ BGE-M3 安装完成（共 $([math]::Round($totalBytes / 1MB, 1)) MB）" -ForegroundColor Green
}
if ($missingOptional.Count -gt 0) {
    Write-Host "[install-bge-m3] 提示：可选文件未下载（不影响使用）：$($missingOptional -join '、')" -ForegroundColor Yellow
}
Write-Host "[install-bge-m3] 回到 设置 → 昔涟设置 → RAG 页面「刷新状态」即可看到「已下载」。" -ForegroundColor Green
exit 0
