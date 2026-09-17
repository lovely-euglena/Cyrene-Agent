@echo off
setlocal enabledelayedexpansion
chcp 936 >nul
cd /d "%~dp0"
title Cyrene 一键解压

set BASE=Cyrene-Portable-2.0.0-test.4-x64.tar.xz
set PARTMASK=%BASE%.part.*

echo ============================================
echo   Cyrene 便携版一键解压
echo ============================================
echo.

REM ── 1. 收集分卷（cmd 字典序 = 00,01,02...）
set N=0
set LIST=
for %%f in (%PARTMASK%) do (
  set /a N+=1
  set LIST=!LIST!+%%f
)
set LIST=!LIST:~1!
if %N%==0 (
  echo [错误] 未找到分卷文件（%PARTMASK%）
  echo 请把所有 .part.xx 和本脚本放在同一目录
  pause & exit /b 1
)
echo [1/4] 找到 %N% 个分卷

REM ── 2. 逐卷校验 SHA256（SHA256SUMS.txt 必须同目录）
if not exist SHA256SUMS.txt (
  echo [错误] 缺少 SHA256SUMS.txt，请和分卷一起下载
  pause & exit /b 1
)
echo [2/4] 校验分卷完整性...
set BAD=0
for /f "tokens=1,*" %%a in (SHA256SUMS.txt) do (
  if not "%%b"=="%BASE%" (
    if exist "%%b" (
      for /f "skip=1 delims=" %%h in ('certutil -hashfile "%%b" SHA256 ^| findstr /v /i "certutil"') do (
        set ACT=%%h
        set ACT=!ACT: =!
        if /i not "!ACT!"=="%%a" (
          echo   [损坏] %%b —— 请重新下载这一卷
          set BAD=1
        )
      )
    ) else (
      echo   [缺失] %%b —— 请下载这一卷
      set BAD=1
    )
  )
)
if %BAD%==1 (
  echo.
  echo [中止] 分卷不完整，按上面提示补齐后重跑
  pause & exit /b 1
)
echo   全部通过

REM ── 3. 合并 + 总校验
echo [3/4] 合并分卷...
copy /b %LIST% full.tar.xz >nul
for /f "tokens=1,*" %%a in ('findstr /c:"%BASE%" SHA256SUMS.txt') do (
  for /f "skip=1 delims=" %%h in ('certutil -hashfile full.tar.xz SHA256 ^| findstr /v /i "certutil"') do (
    set ACT=%%h
    set ACT=!ACT: =!
    if /i not "!ACT!"=="%%a" (
      echo   [错误] 合并后校验失败——分卷有静默损坏，逐卷重下
      del full.tar.xz
      pause & exit /b 1
    )
  )
)
echo   合并校验通过

REM ── 4. 解压 + 启动
echo [4/4] 解压中（约 1-3 分钟）...
tar -xJf full.tar.xz
if errorlevel 1 (
  echo [错误] 解压失败
  pause & exit /b 1
)
del full.tar.xz
echo.
echo 完成！正在启动 Cyrene...
start "" Cyrene.exe
exit /b 0
