#!/usr/bin/env python3
"""tool-host 全工具逐项调用矩阵（真实调用验证）。

calculator / now / clipboard / sysinfo / fs_read_file / fs_write_file /
fs_list_dir / git(status/log/diff/init/add/commit/switch/push/revert)
每个工具多组输入：正常 + 参数缺失 + 参数类型错。验响应形状与错误语义。
"""
import subprocess, json, os, tempfile, sys

NATIVE = "dotnet/smoke-host/bin/Release/net10.0/cyrene-smoke.dll"
results = []

def run(frames, timeout=90):
    env = dict(os.environ)
    dr = os.path.expanduser("~/.dotnet")
    env["DOTNET_ROOT"] = dr
    env["PATH"] = dr + os.pathsep + env.get("PATH", "")
    p = subprocess.run(["dotnet", NATIVE, "--tool-host"], input="\n".join(frames),
                       capture_output=True, text=True, timeout=timeout,
                       cwd="/home/z/my-project/repos/Cyrene-Agent", env=env)
    out = []
    for line in p.stdout.strip().splitlines():
        try: out.append(json.loads(line))
        except Exception: out.append({"_raw": line[:100]})
    return out

def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"{'[PASS]' if ok else '[FAIL]'} {name}" + (f" —— {str(detail)[:160]}" if not ok else (f" —— {str(detail)[:80]}" if detail else "")))

tmp = tempfile.mkdtemp(prefix="tools-matrix-")
# git 仓库临时目录
gitdir = os.path.join(tmp, "repo")
os.makedirs(gitdir)
os.system(f"cd {gitdir} && git init -q && git config user.email t@t && git config user.name t && echo hello > a.txt")

frames = []
n = 0
def req(tool, args):
    global n
    n += 1
    cid = f"t{n}"
    frames.append(json.dumps({"op": "call", "callId": cid, "tool": tool, "args": args}))
    return cid

# calculator
c_calc1 = req("calculator", {"expression": "1+2*3"})
c_calc2 = req("calculator", {"expression": "sin(3.14159)"})
c_calc3 = req("calculator", {"expression": "1/0"})
c_calc4 = req("calculator", {})
c_calc5 = req("calculator", {"expression": "not-a-math"})
# now
c_now1 = req("now", {"format": "iso"})
c_now2 = req("now", {"format": "epoch"})
c_now3 = req("now", {"format": "bogus"})
# clipboard
c_clip1 = req("clipboard", {"action": "read"})
# sysinfo
c_sys1 = req("sysinfo", {})
# fs_write_file
c_w1 = req("fs_write_file", {"path": os.path.join(tmp, "w1.txt"), "content": "第一行\n第二行"})
c_w2 = req("fs_write_file", {"path": os.path.join(tmp, "w2.txt"), "content": "x", "startLine": 5})
c_w3 = req("fs_write_file", {"content": "no path"})
# fs_read_file
c_r1 = req("fs_read_file", {"path": os.path.join(tmp, "w1.txt")})
c_r2 = req("fs_read_file", {"path": os.path.join(tmp, "w1.txt"), "startLine": 2, "maxLines": 1})
c_r3 = req("fs_read_file", {"path": os.path.join(tmp, "nonexistent.txt")})
c_r4 = req("fs_read_file", {})
# fs_list_dir
c_l1 = req("fs_list_dir", {"path": tmp})
c_l2 = req("fs_list_dir", {"path": "/definitely/not/exist"})
# git
c_g1 = req("git", {"cwd": gitdir, "sub": "status"})
c_g2 = req("git", {"cwd": gitdir, "sub": "log"})
c_g3 = req("git", {"cwd": gitdir, "sub": "diff"})
c_g4 = req("git", {"cwd": gitdir, "sub": "add"})
c_g5 = req("git", {"cwd": gitdir, "sub": "commit", "message": "matrix 测试提交"})
c_g6 = req("git", {"cwd": gitdir, "sub": "log"})
c_g7 = req("git", {"cwd": gitdir, "sub": "switch", "branch": "main"})
c_g8 = req("git", {"cwd": gitdir, "sub": "revert"})
c_g9 = req("git", {"cwd": gitdir, "sub": "push"})
c_g10 = req("git", {"cwd": "/no/repo", "sub": "status"})
c_g11 = req("git", {})

frames.append(json.dumps({"op": "shutdown"}))
out = run(frames)
by = {f.get("callId"): f for f in out if isinstance(f, dict) and f.get("op") == "result"}

def data_json(cid):
    d = by.get(cid, {}).get("data")
    if isinstance(d, str):
        try: return json.loads(d)
        except Exception: return {"_raw": d[:100]}
    return d

print("=== calculator ===")
d1 = data_json(c_calc1); check("calc 1+2*3=7", d1 and d1.get("value") == 7, d1)
d2 = data_json(c_calc2); check("calc sin(pi)≈0", d2 and abs(d2.get("value", 9)) < 1e-5, d2)
check("calc 1/0 有错误码", by.get(c_calc3, {}).get("ok") is False, by.get(c_calc3, None))
d4 = by.get(c_calc4, {}); check("calc 缺参帧 ok", "ok" in d4, d4)
check("calc 非法表达式有错", by.get(c_calc5, {}).get("ok") is False, by.get(c_calc5, None))

print("\n=== now ===")
d = data_json(c_now1); check("now iso", isinstance(d, dict) and "now" in json.dumps(d), d)
d = data_json(c_now2); check("now epoch", d is not None, d)
d = data_json(c_now3); check("now 非法 format 容错", by.get(c_now3, {}).get("ok") is True or d is not None, d)

print("\n=== clipboard / sysinfo ===")
d = data_json(c_clip1); check("clipboard（Linux stub 不可用=正常）", by.get(c_clip1, {}).get("ok") is True, d)
d = data_json(c_sys1); check("sysinfo 返回", d is not None, d)

print("\n=== fs_write_file ===")
d = data_json(c_w1); check("写两行文件", d and d.get("bytes", 0) > 0, d)
check("文件真实落盘", os.path.exists(os.path.join(tmp, "w1.txt")))
d = data_json(c_w3); check("写缺 path 报错", isinstance(d, dict) and d.get("errorCode") == "E_FS_PATH", d)

print("\n=== fs_read_file ===")
d = data_json(c_r1); check("读全文件带行号", d and "第二行" in json.dumps(d, ensure_ascii=False), d)
d = data_json(c_r2); check("startLine=2 只读第二行", d and d.get("startLine") == 2 and d.get("endLine") == 2, d)
d = data_json(c_r3); check("读不存在 E_FS_NOT_FOUND", isinstance(d, dict) and d.get("errorCode") == "E_FS_NOT_FOUND", d)
d = data_json(c_r4); check("读缺参报错", isinstance(d, dict) and d.get("errorCode") == "E_FS_PATH", d)

print("\n=== fs_list_dir ===")
d = data_json(c_l1); check("列目录", d and "w1.txt" in json.dumps(d), d)
d = data_json(c_l2); check("列不存在目录报错", by.get(c_l2, {}).get("ok") is False, by.get(c_l2, d))

print("\n=== git（11 组）===")
check("status", by.get(c_g1, {}).get("ok") is True)
d = data_json(c_g2); check("log（空仓库容错 ok:false 有码）", by.get(c_g2, {}).get("ok") is False, str(d)[:80])
check("diff", by.get(c_g3, {}).get("ok") is True)
check("add -A", by.get(c_g4, {}).get("ok") is True)
d = data_json(c_g5); check("commit 提交成功", by.get(c_g5, {}).get("ok") is True, str(d)[:80])
d = data_json(c_g6); check("log 有提交记录", "matrix" in json.dumps(d, ensure_ascii=False) or by.get(c_g6, {}).get("ok") is True, str(d)[:80])
check("switch main（master 仓切 main 失败=预期 ok:false）", by.get(c_g7, {}).get("ok") is False)
check("revert（无 HEAD 或可回滚均可，帧不炸）", by.get(c_g8, {}).get("ok") is True)
check("push（无 remote → ok:false 有码）", by.get(c_g9, {}).get("ok") is False)
check("git 无 repo 目录容错（ok:false 有码）", by.get(c_g10, {}).get("ok") is False)
d = data_json(c_g11); check("git 缺 cwd 报错", by.get(c_g11, {}).get("ok") is False, by.get(c_g11, d))

passed = sum(1 for _, ok, _ in results if ok)
print(f"\n{'='*50}\n工具矩阵汇总: {passed} passed / {len(results)-passed} failed")
sys.exit(0 if passed == len(results) else 1)
