# install-bge-reranker-v2-m3.ps1
# 下载 bge-reranker-v2-m3（ONNX 量化版）到 models/bge-reranker-v2-m3/
# 目录布局与 src/main/rag/model-status.ts 的探测约定一致（bare 布局，不在 Xenova 下）：
#   tokenizer.json / config.json / onnx/model_quantized.onnx  （必装，三缺一判「未安装」）
#   tokenizer_config.json / special_tokens_map.json / sentencepiece.bpe.model （可选附属）
# 源仓库 = onnx-community/bge-reranker-v2-m3-ONNX（Xenova/bge-reranker-v2-m3 不存在）。
# MinBytes 与 dotnet/native-windows/ModelDownload/ModelDownloader.cs 的 ModelDownloadSpecs 同口径。
#
# 用法（PowerShell）：
#   .\scripts\install-bge-reranker-v2-m3.ps1                    # 自动选源：hf-mirror → 官方源
#   .\scripts\install-bge-reranker-v2-m3.ps1 -Mirror official   # 只用官方源
#   .\scripts\install-bge-reranker-v2-m3.ps1 -Force             # 已存在文件也重新下载
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-bge-reranker-v2-m3.ps1

param(
    [switch]$Force,
    [ValidateSet("auto", "hf-mirror", "official")]
    [string]$Mirror = "auto"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # 关掉 IWR 进度条（大文件下会严重拖慢）

$repoRoot = Split-Path -Parent $PSScriptRoot
$targetDir = Join-Path $repoRoot "models\bge-reranker-v2-m3"

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
    $sources += @{ name = "hf-mirror.com（国内镜像）"; base = "https://hf-mirror.com/onnx-community/bge-reranker-v2-m3-ONNX/resolve/main/" }
}
if ($Mirror -ne "hf-mirror") {
    $sources += @{ name = "huggingface.co（官方源）"; base = "https://huggingface.co/onnx-community/bge-reranker-v2-m3-ONNX/resolve/main/" }
}

. (Join-Path $PSScriptRoot "lib\model-install-common.ps1")
$result = Install-ModelFiles -TargetDir $targetDir -Files $files -Sources $sources -LogTag "install-bge-reranker-v2-m3" -Force:$Force

if ($result.ExitCode -ne 0) { exit $result.ExitCode }
if (-not $result.AnyDownload) {
    Write-Host "[install-bge-reranker-v2-m3] ✓ 文件已齐全，无需下载（-Force 可强制重新下载）。" -ForegroundColor Green
} else {
    Write-Host "[install-bge-reranker-v2-m3] ✓ bge-reranker-v2-m3 安装完成（共 $([math]::Round($result.TotalBytes / 1MB, 1)) MB）" -ForegroundColor Green
}
if ($result.MissingOptional.Count -gt 0) {
    Write-Host "[install-bge-reranker-v2-m3] 提示：可选文件未下载（不影响使用）：$($result.MissingOptional -join '、')" -ForegroundColor Yellow
}
Write-Host "[install-bge-reranker-v2-m3] 回到 设置 → 昔涟设置 → RAG 页面「刷新状态」即可看到「已下载」。" -ForegroundColor Green
exit 0
