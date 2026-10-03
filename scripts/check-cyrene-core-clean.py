#!/usr/bin/env python3
"""cyrene-core 洁净断言（IKJK2G）：跨平台核心库不得引入 Windows-only 依赖。

规则：
  1. 工程文件只允许 net10.0，不得出现 net10.0-windows / UseWPF / UseWindowsForms /
     Microsoft.NET.Sdk.WindowsDesktop；
  2. 源码不得直接引用 WPF / WinForms / System.Drawing / Microsoft.Win32
     （Windows-only 能力经 Tools/ClipboardTool.PlatformImpl 由宿主注入）。
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
            for lineno, line in enumerate(open(path, encoding="utf-8"), 1):
                if line.strip().startswith("//"):
                    continue
                for token in CS_FORBIDDEN:
                    if token in line:
                        violations.append(f"{rel}:{lineno}: 源码引用禁用命名空间 `{token}`")

if violations:
    print("cyrene-core 洁净断言 FAIL：")
    for v in violations:
        print("  -", v)
    sys.exit(1)
print("cyrene-core 洁净断言 PASS：net10.0 / 无 net10.0-windows / 无 WPF / 无 WinForms / 无 System.Windows")
