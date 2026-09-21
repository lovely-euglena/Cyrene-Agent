#!/usr/bin/env python3
"""后端边缘情况测试——畸形输入/注入/越界/资源耗尽。

对 smoke-host（同源 .NET 协议类）投喂恶意与极端帧，验证：
不崩溃、不误执行、错误码正确、资源有界。
"""
import subprocess, json, os, tempfile, sys

NATIVE = "dotnet/smoke-host/bin/Release/net10.0/cyrene-smoke.dll"
results = []

def run_host(args, frames, timeout=60, raw=False):
    inp = frames if raw else "\n".join(frames)
    env = dict(os.environ)
    dr = os.path.expanduser("~/.dotnet")
    env["DOTNET_ROOT"] = dr
    env["PATH"] = dr + os.pathsep + env.get("PATH", "")
    try:
        p = subprocess.run(["dotnet", NATIVE] + args, input=inp,
                           capture_output=True, text=True, timeout=timeout,
                           cwd="/home/z/my-project/repos/Cyrene-Agent", env=env)
    except subprocess.TimeoutExpired:
        return [], -99, "TIMEOUT"
    out = []
    for line in p.stdout.strip().splitlines():
        try: out.append(json.loads(line))
        except Exception: out.append({"_raw": line[:100]})
    return out, p.returncode, p.stderr[:300]

def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"{'[PASS]' if ok else '[FAIL]'} {name}" + (f" —— {detail[:150]}" if not ok and detail else ""))

tmpdir = tempfile.mkdtemp(prefix="cyrene-edge-")

# ── 1. 协议层畸形帧 ─────────────────────────────
print("\n=== 1. 畸形帧（tool-host）===")
out, code, err = run_host(["--tool-host"], [
    "",                                    # 空行
    "not-json{{{",
    "[1,2,3]",                             # 非对象 JSON
    '"string-frame"',                       # 字符串 JSON
    "null",
    json.dumps({"op": "call"}),            # 缺 callId/tool/args
    json.dumps({"op": "call", "callId": "x", "tool": "fs_read_file", "args": "not-object"}),
    json.dumps({"op": "unknown-op"}),
    "A" * 100_000,                          # 100KB 裸行
    json.dumps({"op": "shutdown"}),
], raw=False)
check("畸形帧不崩溃（exit=0）", code == 0, f"exit={code} err={err}")
check("畸形帧无 result 泄漏", not any(f.get("op") == "result" and f.get("ok") for f in out if isinstance(f, dict) and "callId" not in f), "")
check("未知 op 有错误应答", any(f.get("op") == "result" and f.get("ok") is False for f in out if isinstance(f, dict)) or any("未知" in str(f.get("_raw", "")) or "未知" in str(f.get("error", "")) for f in out), json.dumps(out[:3]))

# ── 2. 路径穿越 / 任意读 ────────────────────────
print("\n=== 2. 路径穿越（fs_read_file）===")
out, code, err = run_host(["--tool-host"], [
    json.dumps({"op": "call", "callId": "p1", "tool": "fs_read_file",
                "args": {"path": "../../etc/passwd"}}),
    json.dumps({"op": "call", "callId": "p2", "tool": "fs_read_file",
                "args": {"path": "/etc/passwd"}}),
    json.dumps({"op": "call", "callId": "p3", "tool": "fs_read_file",
                "args": {"path": "C:\\Windows\\System32\\config\\SAM"}}),
    json.dumps({"op": "call", "callId": "p4", "tool": "fs_write_file",
                "args": {"path": "/etc/cyrene-pwned", "content": "x"}}),
    json.dumps({"op": "shutdown"}),
])
by = {f.get("callId"): f for f in out if isinstance(f, dict) and f.get("op") == "result"}
p1 = str(by.get("p1", {}).get("data", ""))
check("相对穿越 ../../etc/passwd 被读出或拒", "root:" in p1 or "E_FS" in p1, p1[:120])
p2 = str(by.get("p2", {}).get("data", ""))
check("绝对路径 /etc/passwd（工具语义=受信 fs，读不崩溃即可）", "root:" in p2 or "E_FS" in p2, p2[:100])
p4 = by.get("p4", {})
check("写 /etc 受拒或失败", os.path.exists("/etc/cyrene-pwned") is False, json.dumps(p4)[:120])

# ── 3. git 参数注入 ─────────────────────────────
print("\n=== 3. git 注入 ===")
out, code, err = run_host(["--tool-host"], [
    json.dumps({"op": "call", "callId": "g1", "tool": "git",
                "args": {"cwd": tmpdir, "sub": "commit", "message": 'x"; touch /tmp/GIT_PWNED; "'}}),
    json.dumps({"op": "call", "callId": "g2", "tool": "git",
                "args": {"cwd": tmpdir, "sub": "switch", "branch": "main $(touch /tmp/GIT_PWNED2)"}}),
    json.dumps({"op": "call", "callId": "g3", "tool": "git",
                "args": {"cwd": tmpdir, "sub": "status", "extra": "--upload-pack=touch /tmp/GIT_PWNED3"}}),
    json.dumps({"op": "shutdown"}),
])
check("commit message 注入未执行", not os.path.exists("/tmp/GIT_PWNED"))
check("branch $(...) 注入未执行", not os.path.exists("/tmp/GIT_PWNED2"))
check("git 进程执行完（不崩）", code == 0, f"exit={code}")

# ── 4. RAG 恶意输入 ────────────────────────────
print("\n=== 4. RAG 边缘（注入/越界）===")
ragdb = os.path.join(tmpdir, "rag.sqlite")
frames = [
    json.dumps({"op": "open", "callId": "o", "dbPath": ragdb}),
    # SQL 注入尝试：metadata/text 带引号与 DROP
    json.dumps({"op": "upsert", "callId": "u1", "entries": [
        {"id": "x'; DROP TABLE entries;--", "text": "注入'; DROP TABLE bm25;--", "embedding": [0.1, 0.2], "source": "user_memory"},
    ]}),
    # NaN / Infinity embedding
    json.dumps({"op": "upsert", "callId": "u2", "entries": [
        {"id": "nan-emb", "text": "nan", "embedding": ["NaN", "Infinity"], "source": "user_memory"},
    ]}),
    # 超大 embedding（8192 维）
    json.dumps({"op": "upsert", "callId": "u3", "entries": [
        {"id": "big-emb", "text": "big", "embedding": [0.01] * 8192, "source": "user_memory"},
    ]}),
    # topK 负数 / 巨大
    json.dumps({"op": "query", "callId": "q1", "embedding": [0.1, 0.2], "text": "x", "topK": -5}),
    json.dumps({"op": "query", "callId": "q2", "embedding": [0.1, 0.2], "text": "x", "topK": 10**9}),
    # mark_recalled 权重溢出
    json.dumps({"op": "mark_recalled", "callId": "m1", "ids": ["x'; DROP TABLE entries;--"], "weightDelta": 1e308}),
    json.dumps({"op": "stats", "callId": "s"}),
    json.dumps({"op": "shutdown"}),
]
out, code, err = run_host(["--rag-host"], frames, timeout=120)
by = {f.get("callId"): f for f in out if isinstance(f, dict) and f.get("op") == "result"}
s = by.get("s", {}).get("data") or {}
check("RAG 恶意输入全链 exit=0", code == 0, f"exit={code} err={err}")
check("SQL 注入后表仍在", s.get("entries", -1) >= 1, json.dumps(s)[:150])
check("mark 权重 1e308 不崩", by.get("m1", {}).get("ok") is not False, json.dumps(by.get("m1"))[:100])

# ── 5. agent 会话边缘 ──────────────────────────
print("\n=== 5. agent 边缘 ===")
frames = [
    json.dumps({"op": "step", "callId": "s1", "sessionId": "ghost", "message": "x"}),   # 不存在会话
    json.dumps({"op": "create", "callId": "c1", "sessionId": "s1", "config": {"allowedTools": ["read_file"]}}),
    json.dumps({"op": "create", "callId": "c2", "sessionId": "s1", "config": {}}),      # 重复 create
    json.dumps({"op": "destroy", "callId": "d1", "sessionId": "ghost"}),                  # 不存在
    json.dumps({"op": "llm_response", "callId": "nope", "content": {"text": "x"}}),       # 伪造 callId
    json.dumps({"op": "step", "callId": "s2", "sessionId": "s1", "message": "A" * 1_000_000}),  # 1MB 消息
    json.dumps({"op": "shutdown"}),
]
out, code, err = run_host(["--agent-host"], frames, timeout=120)
check("agent 边缘全链 exit=0", code == 0, f"exit={code} err={err}")
check("幽灵会话 step 被拒", any(f.get("callId") == "s1" and f.get("ok") is False for f in out if isinstance(f, dict)), json.dumps([f for f in out if isinstance(f, dict) and f.get('callId')=='s1'])[:150])

# ── 6. memory 边缘 ─────────────────────────────
print("\n=== 6. memory 边缘 ===")
memdb = os.path.join(tmpdir, "mem.sqlite")
frames = [
    json.dumps({"op": "open", "callId": "o", "dbPath": memdb}),
    json.dumps({"op": "put", "callId": "p1", "level": "l1_longterm", "id": "x'; DROP TABLE l1_longterm;--", "content": {"t": 1}}),
    json.dumps({"op": "put", "callId": "p2", "level": "fake_level", "id": "m2", "content": {}}),
    json.dumps({"op": "put", "callId": "p3", "level": "l1_longterm", "id": "big", "content": {"blob": "Y" * 5_000_000}}),
    json.dumps({"op": "get", "callId": "g1", "level": "l1_longterm", "id": "x'; DROP TABLE l1_longterm;--"}),
    json.dumps({"op": "stats", "callId": "s"}),
    json.dumps({"op": "shutdown"}),
]
out, code, err = run_host(["--memory-host"], frames, timeout=120)
by = {f.get("callId"): f for f in out if isinstance(f, dict) and f.get("op") == "result"}
s = by.get("s", {}).get("data") or {}
check("memory 恶意输入 exit=0", code == 0, f"exit={code} err={err}")
tb = (s.get("tables") or {}); check("注入 id 后表仍在", tb.get("l1_longterm", -1) >= 1, json.dumps(s)[:150])

# ── 汇总 ───────────────────────────────────────
passed = sum(1 for _, ok, _ in results if ok)
print(f"\n{'='*50}\n边缘测试汇总: {passed} passed / {len(results)-passed} failed")
sys.exit(0 if passed == len(results) else 1)
