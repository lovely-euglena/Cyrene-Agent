#!/usr/bin/env python3
"""cyrene-native Linux 侧后端协议全链冒烟（发布产物实测）。

直接跑 win-x64 publish 目录里的 dll（.NET 跨平台：net10.0-windows 的
Windows API 只在调用时才触发——协议层 op 全部可用；fs 工具传 Linux
路径即可真实读写）。逐 host 帧序实测，对照契约文档。
"""
import subprocess, json, os, tempfile, sys

NATIVE = "dotnet/smoke-host/bin/Release/net10.0/cyrene-smoke.dll"
results = []

def run_host(args, frames, timeout=60):
    """spawn host → 逐行喂帧 → 收全部输出行（dict 化）。"""
    p = subprocess.run(
        ["dotnet", os.path.basename(NATIVE)] if False else ["dotnet", NATIVE] + args,
        input="\n".join(frames), capture_output=True, text=True, timeout=timeout,
        cwd="/home/z/my-project/repos/Cyrene-Agent")
    out = []
    for line in p.stdout.strip().splitlines():
        try:
            out.append(json.loads(line))
        except Exception:
            out.append({"_raw": line[:120]})
    return out, p.returncode, p.stderr

def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"{'[PASS]' if ok else '[FAIL]'} {name}" + (f" —— {detail}" if detail and not ok else ""))

# ── 1. tool-host：list 握手 + 六工具调用 ──
print("\n=== 1. tool-host ===")
tmpdir = tempfile.mkdtemp(prefix="cyrene-smoke-")
test_file = os.path.join(tmpdir, "hello.txt")
with open(test_file, "w") as f:
    f.write("line1 你好\nline2 world\nline3 test\n")

frames = [
    json.dumps({"op": "list"}),
    json.dumps({"op": "call", "callId": "c1", "tool": "fs_write_file",
                "args": {"path": os.path.join(tmpdir, "w.txt"), "content": "写入测试"}}),
    json.dumps({"op": "call", "callId": "c2", "tool": "fs_read_file",
                "args": {"path": test_file, "startLine": 1, "maxLines": 2}}),
    json.dumps({"op": "call", "callId": "c3", "tool": "fs_list_dir",
                "args": {"path": tmpdir}}),
    json.dumps({"op": "call", "callId": "c4", "tool": "fs_read_file",
                "args": {"path": "/nonexistent/xx.txt"}}),
    json.dumps({"op": "call", "callId": "c5", "tool": "git",
                "args": {"cwd": "/home/z/my-project/repos/Cyrene-Agent", "sub": "status"}}),
    json.dumps({"op": "call", "callId": "c6", "tool": "calculator",
                "args": {"expression": "1+2*3"}}),
    json.dumps({"op": "shutdown"}),
]
out, code, err = run_host(["--tool-host"], frames)
tools_list = next((f for f in out if f.get("op") == "tools"), None)
check("tool-host list 握手", tools_list is not None and "calculator" in json.dumps(tools_list))
by_id = {f.get("callId"): f for f in out if f.get("op") == "result"}
c1 = by_id.get("c1"); check("fs_write_file 写入", c1 and c1.get("ok") and "w.txt" in json.dumps(c1))
c2 = by_id.get("c2")
c2ok = c2 and c2.get("ok") and "line2" in json.dumps(c2.get("data", "")) if isinstance(c2.get("data"), str) else False
check("fs_read_file 行号分页+中文", c2ok and "1" in str(c2.get("data", ""))[:50] if c2 else False)
c3 = by_id.get("c3"); check("fs_list_dir", c3 and c3.get("ok") and "hello.txt" in json.dumps(c3))
c4 = by_id.get("c4")
c4ok = c4 and c4.get("ok") and "E_FS_NOT_FOUND" in str(c4.get("data", ""))
check("read 不存在文件 → E_FS_NOT_FOUND", bool(c4ok), json.dumps(c4)[:100] if c4 else "no result")
c5 = by_id.get("c5"); check("git status", c5 and c5.get("ok"))
c6 = by_id.get("c6"); check("calculator", c6 and c6.get("ok") and "7" in str(c6.get("data")))

# ── 2. rag-host：迁移→upsert→query→mark_recalled→stats ──
print("\n=== 2. rag-host ===")
ragdb = os.path.join(tmpdir, "rag.sqlite")
memjson = os.path.join(tmpdir, "memory.json")
with open(memjson, "w") as f:
    json.dump([
        {"id": "e1", "text": "今天天气很好，阳光明媚", "embedding": [0.1, 0.2, 0.3], "source": "user_memory", "weight": 1.0, "createdAt": 1700000000000, "lastRecalledAt": 0},
        {"id": "e2", "text": "我喜欢吃苹果和香蕉", "embedding": [0.9, 0.1, 0.05], "source": "user_memory", "weight": 1.0, "createdAt": 1700000000001, "lastRecalledAt": 0},
        {"id": "e3", "text": "项目代码已经写完了", "embedding": [0.05, 0.8, 0.15], "source": "user_memory", "weight": 1.0, "createdAt": 1700000000002, "lastRecalledAt": 0},
    ], f, ensure_ascii=False)

frames = [
    json.dumps({"op": "open", "callId": "o1", "dbPath": ragdb, "jsonImportPath": memjson}),
    json.dumps({"op": "query", "callId": "q1", "embedding": [0.12, 0.18, 0.28], "text": "天气", "topK": 2}),
    json.dumps({"op": "query", "callId": "q2", "embedding": [0.9, 0.1, 0.05], "text": "水果 苹果", "topK": 1}),
    json.dumps({"op": "mark_recalled", "callId": "m1", "ids": ["e1"], "weightDelta": 0.1}),
    json.dumps({"op": "stats", "callId": "s1"}),
    json.dumps({"op": "shutdown"}),
]
out, code, err = run_host(["--rag-host"], frames)
by_id = {f.get("callId"): f for f in out if f.get("op") == "result"}
o1 = by_id.get("o1"); check("rag open+JSON迁移", o1 and o1.get("ok"), json.dumps(o1)[:120] if o1 else "none")
q1 = by_id.get("q1")
q1data = q1.get("data") if q1 else None
q1ok = q1 and q1.get("ok") and isinstance(q1data, dict) and "results" in q1data
top1 = q1data["results"][0]["id"] if q1ok and q1data["results"] else None
check("query 向量召回 e1 置顶", top1 == "e1", f"top1={top1}, data={json.dumps(q1data)[:200] if q1data else None}")
q2 = by_id.get("q2")
q2data = q2.get("data") if q2 else None
q2ok = q2 and q2.get("ok") and isinstance(q2data, dict) and q2data.get("results")
top2 = q2data["results"][0]["id"] if q2ok and q2data["results"] else None
check("query BM25+向量混合召回 e2", top2 == "e2", f"top={top2}, data={json.dumps(q2data)[:200] if q2data else None}")
m1 = by_id.get("m1"); check("mark_recalled", m1 and m1.get("ok"))
s1 = by_id.get("s1")
s1ok = s1 and s1.get("ok") and "3" in json.dumps(s1.get("data"))
check("stats total=3", bool(s1ok))

# ── 3. agent-host：create→step→llm_response 闭环（LLM 由测试扮演）──
print("\n=== 3. agent-host（LLM 回调由测试扮演）===")
frames = [
    json.dumps({"op": "create", "callId": "a1", "sessionId": "s1",
                "config": {"allowedTools": ["read_file"], "systemPrompt": "测试"}}),
    json.dumps({"op": "step", "callId": "st1", "sessionId": "s1", "message": "你好"}),
    json.dumps({"op": "llm_response", "callId": "st1", "content": {"text": "回复完成"}}),
    json.dumps({"op": "step", "callId": "st2", "sessionId": "s1", "message": "再走一轮"}),
    json.dumps({"op": "llm_response", "callId": "st2", "content": {"toolCalls": [{"id": "tc1", "name": "read_file", "args": {"path": test_file}}]}}),
    json.dumps({"op": "tool_result", "callId": "st2", "results": [{"id": "tc1", "output": "内容OK"}]}),
    json.dumps({"op": "destroy", "callId": "d1", "sessionId": "s1"}),
    json.dumps({"op": "shutdown"}),
]
out, code, err = run_host(["--agent-host"], frames)
llm_reqs = [f for f in out if f.get("op") == "llm_request"]
check("step → llm_request 回调", len(llm_reqs) >= 2, f"llm_request 数={len(llm_reqs)}")
tool_reqs = [f for f in out if f.get("op") == "tool_request"]
check("toolCalls → tool_request", len(tool_reqs) >= 1, f"tool_request 数={len(tool_reqs)}")
fin = [f for f in out if f.get("op") == "step_finished" or (f.get("op") == "result" and f.get("callId") == "st1" and f.get("ok"))]
check("llm_response 纯文本 → 完成", len(fin) >= 1)

# ── 4. loop-host：状态机骨架 ──
print("\n=== 4. loop-host ===")
frames = [
    json.dumps({"op": "start", "callId": "L1", "sessionId": "ls1", "messages": [{"role": "user", "content": "hi"}]}),
    json.dumps({"op": "llm_response", "callId": "L1", "content": {"text": "loop 完成"}}),
    json.dumps({"op": "shutdown"}),
]
out, code, err = run_host(["--loop-host"], frames)
check("loop ready 帧", any(f.get("op") == "ready" for f in out))
loop_llm = [f for f in out if f.get("op") == "llm_request"]
check("loop start → llm_request", len(loop_llm) >= 1)
loop_fin = [f for f in out if f.get("op") == "finished"]
check("loop 纯文本 → finished", len(loop_fin) >= 1, json.dumps(out)[:300])

# ── 5. memory-host：六表 CRUD ──
print("\n=== 5. memory-host ===")
memdb = os.path.join(tmpdir, "memory.sqlite")
frames = [
    json.dumps({"op": "open", "callId": "mo", "dbPath": memdb}),
    json.dumps({"op": "put", "callId": "mp", "level": "l1_longterm", "id": "m1", "content": {"text": "长期记忆条目", "salience": 1.5}}),
    json.dumps({"op": "get", "callId": "mg", "level": "l1_longterm", "id": "m1"}),
    json.dumps({"op": "append", "callId": "ma", "level": "l0_working", "content": {"key": "ctx", "value": "滚动窗口"}}),
    json.dumps({"op": "record_conflict", "callId": "mc", "old": "旧事实", "new": "新事实"}),
    json.dumps({"op": "stats", "callId": "ms"}),
    json.dumps({"op": "shutdown"}),
]
out, code, err = run_host(["--memory-host"], frames)
by_id = {f.get("callId"): f for f in out if f.get("op") == "result"}
mo = by_id.get("mo"); check("memory open 六表", mo and mo.get("ok"), json.dumps(mo)[:150] if mo else "none")
mp = by_id.get("mp"); check("put l1", mp and mp.get("ok"), json.dumps(mp)[:150] if mp else "none")
mg = by_id.get("mg")
mgd = (mg or {}).get("data") or {}
try:
    mg_text = json.loads(mgd.get("content") or "{}").get("text", "")
except Exception:
    mg_text = ""
check("get l1 roundtrip", mg and mg.get("ok") and mg_text == "长期记忆条目", f"text={mg_text!r}")
ma = by_id.get("ma"); check("append l0", ma and ma.get("ok"))
ms = by_id.get("ms"); check("stats", ms and ms.get("ok"))

# ── 6. selftest agents（J6 越权保护）──
print("\n=== 6. selftest（越权保护）===")
out, code, err = run_host(["--selftest", "agents"], [])
for line in (err or "").strip().splitlines():
    if "PASS" in line or "FAIL" in line:
        print("  ", line.strip())
check("selftest agents 退出码=0", code == 0, f"exit={code}")

# ── 汇总 ──
passed = sum(1 for _, ok, _ in results if ok)
failed = sum(1 for _, ok, _ in results if not ok)
print(f"\n{'='*50}\n后端冒烟汇总: {passed} passed / {failed} failed")
sys.exit(1 if failed else 0)
