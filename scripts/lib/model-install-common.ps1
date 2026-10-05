# scripts/lib/model-install-common.ps1
# RAG 模型安装脚本公共函数（install-e5-small.ps1 / install-bge-reranker-v2-m3.ps1 共用）。
# 与 ModelDownloader.cs 的 ModelDownloadSpecs 同口径：
#   rel（/ 分隔）、minBytes（低于视为不完整）、required（缺失 = 安装失败）。
# 下载策略：HEAD（失败退 Range: 0-0）探测可达性；BITS（断点续传）优先，失败退 Invoke-WebRequest；
# 每个源按顺序尝试，已完整文件（>= minBytes）非 -Force 时跳过。

function Get-ModelLocalPath([string]$TargetDir, [string]$Rel) {
    return Join-Path $TargetDir ($Rel -replace '/', '\')
}

# HEAD 探测；服务器不支持 HEAD（405）时退回 Range: 0-0 的 GET。
function Test-ModelUrlReachable([string]$Url, [int]$TimeoutSec = 20) {
    foreach ($method in @("HEAD", "GET")) {
        try {
            $req = [System.Net.HttpWebRequest]::Create($Url)
            $req.Method = $method
            $req.Timeout = $TimeoutSec * 1000
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
function Download-ModelFile([string]$Url, [string]$Dest, [string]$Label) {
    Write-Host "        下载 $Label ..." -ForegroundColor DarkGray
    $attempts = @()
    if (Get-Command Start-BitsTransfer -ErrorAction SilentlyContinue) {
        $attempts += { Start-BitsTransfer -Source $Url -Destination $Dest -ErrorAction Stop }
    }
    $attempts += { Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing -TimeoutSec 3600 }
    foreach ($attempt in $attempts) {
        try {
            & $attempt
            return $true
        } catch {
            if (Test-Path $Dest) { Remove-Item $Dest -Force -ErrorAction SilentlyContinue }
        }
    }
    return $false
}

# 主安装流程；返回 [pscustomobject]：
#   ExitCode / MissingRequired / MissingOptional / AnyDownload / TotalBytes
function Install-ModelFiles {
    param(
        [Parameter(Mandatory = $true)][string]$TargetDir,
        [Parameter(Mandatory = $true)][array]$Files,
        [Parameter(Mandatory = $true)][array]$Sources,
        [Parameter(Mandatory = $true)][string]$LogTag,
        [switch]$Force
    )

    $downloaded = @{}
    Write-Host ""
    Write-Host "[$LogTag] 目标目录：$TargetDir" -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null

    $anyDownload = $false
    foreach ($src in $Sources) {
        $pendingFiles = @()
        foreach ($f in $Files) {
            if ($downloaded.ContainsKey($f.rel)) { continue }
            $local = Get-ModelLocalPath $TargetDir $f.rel
            if ((-not $Force) -and (Test-Path $local) -and ((Get-Item $local).Length -ge $f.minBytes)) {
                $downloaded[$f.rel] = $true
                continue
            }
            $pendingFiles += $f
        }
        if ($pendingFiles.Count -eq 0) { break }

        Write-Host ""
        Write-Host "[$LogTag] 尝试源：$($src.name)" -ForegroundColor Cyan
        foreach ($f in $pendingFiles) {
            $rel = [string]$f.rel
            $remote = if ($src.ContainsKey("remap") -and $src.remap.ContainsKey($rel)) { $src.remap[$rel] } else { $rel }
            $url = [string]$src.base + $remote
            $local = Get-ModelLocalPath $TargetDir $rel

            $status = Test-ModelUrlReachable $url
            if (-not $status) {
                Write-Host "  ✗ $rel 不可达（跳过）" -ForegroundColor DarkGray
                continue
            }
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $local) | Out-Null
            if (-not (Download-ModelFile $url $local $rel)) {
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
    foreach ($f in $Files) {
        $local = Get-ModelLocalPath $TargetDir $f.rel
        $ok = (Test-Path $local) -and ((Get-Item $local).Length -ge $f.minBytes)
        if ($ok) { $totalBytes += (Get-Item $local).Length; continue }
        if ($f.required) { $missingRequired += $f.rel } else { $missingOptional += $f.rel }
    }

    Write-Host ""
    if ($missingRequired.Count -gt 0) {
        Write-Host "[$LogTag] ✗ 安装未完成，缺少必装文件：" -ForegroundColor Red
        foreach ($m in $missingRequired) { Write-Host "  - $m" -ForegroundColor Red }
        Write-Host "  可切换镜像源重试（-Mirror hf-mirror / -Mirror official），或参考 docs/local-models.md 手动下载。" -ForegroundColor Yellow
        return [pscustomobject]@{
            ExitCode        = 1
            MissingRequired = $missingRequired
            MissingOptional = $missingOptional
            AnyDownload     = $anyDownload
            TotalBytes      = $totalBytes
        }
    }

    return [pscustomobject]@{
        ExitCode        = 0
        MissingRequired = $missingRequired
        MissingOptional = $missingOptional
        AnyDownload     = $anyDownload
        TotalBytes      = $totalBytes
    }
}
