#!/usr/bin/env python3
"""tool-host 全工具逐项调用矩阵（真实调用验证）。

calculator / now / clipboard / sysinfo / fs_read_file / fs_write_file /
fs_list_dir
每个工具多组输入：正常 + 参数缺失 + 参数类型错。验响应形状与错误语义。
"""
import subprocess, json, os, tempfile, sys

NATIVE = "dotnet/smoke-host/bin/Release/net10.0/cyrene-smoke.dll"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
results = []

def run(frames, timeout=90):
    env = dict(os.environ)
    dr = os.path.expanduser("~/.dotnet")
    if os.path.isdir(dr):  # Linux 独立安装常见位置；不存在时（如 Windows）不污染环境
        env["DOTNET_ROOT"] = dr
        env["PATH"] = dr + os.pathsep + env.get("PATH", "")
    p = subprocess.run(["dotnet", NATIVE, "--tool-host"], input="\n".join(frames),
                       capture_output=True, text=True, timeout=timeout,
                       cwd=ROOT, env=env)
    out = []
    for line in p.stdout.strip().splitlines():
        try: out.append(json.loads(line))
        except Exception: out.append({"_raw": line[:100]})
    return out

def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"{'[PASS]' if ok else '[FAIL]'} {name}" + (f" —— {str(detail)[:160]}" if not ok else (f" —— {str(detail)[:80]}" if detail else "")))

tmp = tempfile.mkdtemp(prefix="tools-matrix-")

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
# evidence 帧协议 v1：新建/追加/覆盖三态的 changes 证据（append 末尾补换行）
c_w4 = req("fs_write_file", {"path": os.path.join(tmp, "w3.txt"), "content": "a\nb"})
c_w5 = req("fs_write_file", {"path": os.path.join(tmp, "w3.txt"), "content": "c", "append": True})
c_w6 = req("fs_write_file", {"path": os.path.join(tmp, "w4.txt"), "content": "a\nb\nc"})
c_w7 = req("fs_write_file", {"path": os.path.join(tmp, "w4.txt"), "content": "x"})
# fs_read_file
c_r1 = req("fs_read_file", {"path": os.path.join(tmp, "w1.txt")})
c_r2 = req("fs_read_file", {"path": os.path.join(tmp, "w1.txt"), "startLine": 2, "maxLines": 1})
c_r3 = req("fs_read_file", {"path": os.path.join(tmp, "nonexistent.txt")})
c_r4 = req("fs_read_file", {})
# fs_list_dir
c_l1 = req("fs_list_dir", {"path": tmp})
c_l2 = req("fs_list_dir", {"path": "/definitely/not/exist"})

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
d = data_json(c_w1); check("写两行文件", d and d.get("sizeBytes", 0) > 0, d)
check("文件真实落盘", os.path.exists(os.path.join(tmp, "w1.txt")))
d = data_json(c_w3); check("写缺 path 报错", isinstance(d, dict) and d.get("errorCode") == "E_FS_PATH", d)
d = data_json(c_w4); check("写证据 added(insertions=2, diff=2)", d and d.get("changes") and d["changes"][0].get("kind") == "added"
               and d["changes"][0].get("insertions") == 2 and len(d["changes"][0].get("diff") or []) == 2, d)
w3 = os.path.join(tmp, "w3.txt")
d = data_json(c_w5); check("append 补换行 + 证据 added(1)", d and d.get("changes") and d["changes"][0].get("kind") == "added"
               and d["changes"][0].get("insertions") == 1 and os.path.exists(w3)
               and open(w3, encoding="utf-8").read() == "a\nb\nc", d)
d2 = data_json(c_w7)
diff_types = [l.get("type") for l in (d2.get("changes", [{}])[0].get("diff") or [])] if isinstance(d2, dict) else []
check("覆盖写证据 modified(1/3) + remove/add diff", d2 and d2.get("success") and d2.get("changes")
      and d2["changes"][0].get("kind") == "modified"
      and d2["changes"][0].get("insertions") == 1 and d2["changes"][0].get("deletions") == 3
      and diff_types == ["remove", "remove", "remove", "add"], d2)

print("\n=== fs_read_file ===")
d = data_json(c_r1); check("读全文件带行号", d and "第二行" in json.dumps(d, ensure_ascii=False), d)
d = data_json(c_r2); check("startLine=2 只读第二行", d and d.get("startLine") == 2 and d.get("endLine") == 2, d)
d = data_json(c_r3); check("读不存在 E_FS_NOT_FOUND", isinstance(d, dict) and d.get("errorCode") == "E_FS_NOT_FOUND", d)
d = data_json(c_r4); check("读缺参报错", isinstance(d, dict) and d.get("errorCode") == "E_FS_PATH", d)

print("\n=== fs_list_dir ===")
d = data_json(c_l1); check("列目录", d and "w1.txt" in json.dumps(d), d)
d = data_json(c_l2); check("列不存在目录报错", by.get(c_l2, {}).get("ok") is False, by.get(c_l2, d))

passed = sum(1 for _, ok, _ in results if ok)
print(f"\n{'='*50}\n工具矩阵汇总: {passed} passed / {len(results)-passed} failed")
sys.exit(0 if passed == len(results) else 1)
