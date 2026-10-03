#!/usr/bin/env python3
"""cyrene-core 洁净断言（IKJK2G）：跨平台核心库不得引入 Windows-only 依赖。

规则：
  1. 工程文件只允许 net10.0，不得出现 net10.0-windows / UseWPF / UseWindowsForms /
     Microsoft.NET.Sdk.WindowsDesktop；
  2. 源码不得直接引用 WPF / WinForms / System.Drawing / Microsoft.Win32
     （Windows-only 能力经 Tools/ClipboardTool.PlatformImpl 由宿主注入）；
  3. P/Invoke 白名单：仅允许登记在 PINVOKE_ALLOW、且同文件带
     OperatingSystem.IsWindows() 守卫的只读查询；新增 Win32 调用必须先登记。
CI（Linux）与本地均可跑；退出码非 0 = 违规。
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORE = os.path.join(ROOT, "dotnet", "cyrene-core")

CSPROJ_FORBIDDEN = (
    "net10.0-windows",
    "UseWPF",
    "UseWindowsForms",
    "Microsoft.NET.Sdk.WindowsDesktop",
)
CS_FORBIDDEN = (
    "System.Windows.Forms",
    "System.Windows.",
    "System.Drawing",
    "Microsoft.Win32",
    "PresentationCore",
)

# P/Invoke 白名单：rel path -> 允许的库名集合。两项均为「只读查询 + IsWindows 运行时守卫」；
# 新增 Win32 调用必须显式登记（并保持同样的守卫纪律），否则断言失败。
PINVOKE_ALLOW = {
    "dotnet/cyrene-core/Tools/SysInfo.cs": {"kernel32.dll"},
    "dotnet/cyrene-core/Mcp/McpConnection.cs": {"kernel32.dll"},
}
DLLIMPORT_RE = re.compile(r'DllImport\(\s*"([^"]+)"')

violations = []
for dirpath, dirnames, filenames in os.walk(CORE):
    dirnames[:] = [d for d in dirnames if d not in ("bin", "obj", ".git")]
    for name in filenames:
        path = os.path.join(dirpath, name)
        rel = os.path.relpath(path, ROOT).replace("\\", "/")
        if name.endswith(".csproj"):
            text = open(path, encoding="utf-8").read()
            text = re.sub(r"<!--.*?-->", "", text, flags=re.S)  # 注释里允许提到禁用词（如本规则说明）
            for token in CSPROJ_FORBIDDEN:
                if token in text:
                    violations.append(f"{rel}: 工程含禁用引用 `{token}`")
            m = re.search(r"<TargetFramework>([^<]+)</TargetFramework>", text)
            if not m or m.group(1).strip() != "net10.0":
                actual = m.group(1).strip() if m else "缺失"
                violations.append(f"{rel}: TargetFramework 必须为 net10.0（实际 {actual}）")
        elif name.endswith(".cs"):
            text = open(path, encoding="utf-8").read()
            has_pinvoke = False
            for lineno, line in enumerate(text.splitlines(), 1):
                if line.strip().startswith("//"):
                    continue
                for token in CS_FORBIDDEN:
                    if token in line:
                        violations.append(f"{rel}:{lineno}: 源码引用禁用命名空间 `{token}`")
                m = DLLIMPORT_RE.search(line)
                if m:
                    has_pinvoke = True
                    lib = m.group(1).lower()
                    if lib not in PINVOKE_ALLOW.get(rel, set()):
                        violations.append(
                            f"{rel}:{lineno}: P/Invoke 库 `{lib}` 不在白名单"
                            "（新增须更新 scripts/check-cyrene-core-clean.py 并说明守卫）"
                        )
            if has_pinvoke and "OperatingSystem.IsWindows()" not in text:
                violations.append(f"{rel}: 含 P/Invoke 但缺少 OperatingSystem.IsWindows() 守卫")

if violations:
    print("cyrene-core 洁净断言 FAIL：")
    for v in violations:
        print("  -", v)
    sys.exit(1)
print("cyrene-core 洁净断言 PASS：net10.0 / 无 WPF / WinForms / System.Windows / P/Invoke 白名单与 IsWindows 守卫通过")
