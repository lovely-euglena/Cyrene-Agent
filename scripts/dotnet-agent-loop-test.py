#!/usr/bin/env python3
"""Agent 循环（--agent-host）深度测试——多轮工具环/硬闸/并发/销毁。

场景：
  1. 多轮工具环：step → llm_request → toolCalls → tool_request →
     tool_result → 再 llm_request → 纯文本 → finished（全闭环状态机）
  2. MaxTurns 硬闸：连续工具结果灌满上限 → 拒绝继续（不失控）
  3. 并发会话：两 session 交错 step 互不串扰
  4. destroy 后 step → 拒绝
  5. 畸形 llm_response（无 content）→ 有错误应答不崩
  6. E1 回归：幽灵会话 → result ok:false（promise 不挂死）
"""
import subprocess, json, os, sys

NATIVE = "dotnet/smoke-host/bin/Release/net10.0/cyrene-smoke.dll"
results = []

def run(frames, timeout=90):
    env = dict(os.environ)
    dr = os.path.expanduser("~/.dotnet")
    env["DOTNET_ROOT"] = dr
    env["PATH"] = dr + os.pathsep + env.get("PATH", "")
    p = subprocess.run(["dotnet", NATIVE, "--agent-host"], input="\n".join(frames),
                       capture_output=True, text=True, timeout=timeout,
                       cwd="/home/z/my-project/repos/Cyrene-Agent", env=env)
    out = []
    for line in p.stdout.strip().splitlines():
        try: out.append(json.loads(line))
        except Exception: out.append({"_raw": line[:100]})
    return out, p.returncode, p.stderr[:200]

def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"{'[PASS]' if ok else '[FAIL]'} {name}" + (f" —— {str(detail)[:160]}" if not ok else ""))

# ── 1. 多轮工具环闭环 ──────────────────────────
print("=== 1. 多轮工具环闭环 ===")
frames = [
    json.dumps({"op": "create", "callId": "c1", "sessionId": "s1",
                "config": {"allowedTools": ["read_file", "calculator"], "systemPrompt": "测试"}}),
    json.dumps({"op": "step", "callId": "t1", "sessionId": "s1", "message": "第一轮"}),
    # 模拟 LLM：第一轮要工具
    json.dumps({"op": "llm_response", "callId": "t1", "content": {"toolCalls": [
        {"id": "tc1", "name": "calculator", "args": {"expression": "1+1"}}]}}),
    # 工具结果回注 → 应触发第二次 llm_request
    json.dumps({"op": "tool_result", "callId": "t1", "sessionId": "s1", "result": [
        {"id": "tc1", "output": "2"}]}),
    # 第二轮 LLM 纯文本 → 完成
    json.dumps({"op": "llm_response", "callId": "t1", "content": {"text": "答案是2"}}),
    json.dumps({"op": "shutdown"}),
]
out, code, err = run(frames)
llm_reqs = [f for f in out if isinstance(f, dict) and f.get("op") == "llm_request"]
tool_reqs = [f for f in out if isinstance(f, dict) and f.get("op") == "tool_request"]
fin = [f for f in out if isinstance(f, dict) and f.get("callId") == "t1" and f.get("op") == "result" and f.get("ok")]
check("两次 llm_request（多轮闭环）", len(llm_reqs) == 2, f"数={len(llm_reqs)}")
check("工具请求一轮", len(tool_reqs) == 1, f"数={len(tool_reqs)}")
check("纯文本收尾 result ok", len(fin) >= 1, json.dumps([f for f in out if isinstance(f, dict) and f.get('callId') == 't1'])[:200])
# 会话历史应含 tool 消息
second_req = llm_reqs[1] if len(llm_reqs) > 1 else {}
sess = second_req.get("session") or {}
msgs = sess.get("messages") or []
check("历史含 tool 角色消息", any(m.get("role") == "tool" for m in msgs), json.dumps(msgs)[:180])

# ── 2. MaxTurns 硬闸 ──────────────────────────
print("=== 2. MaxTurns 硬闸 ===")
frames = [
    json.dumps({"op": "create", "callId": "c1", "sessionId": "s2", "config": {}}),
    json.dumps({"op": "step", "callId": "t1", "sessionId": "s2", "message": "go"}),
]
# 灌满：每轮都要求工具（看上限行为）
for i in range(40):
    frames.append(json.dumps({"op": "llm_response", "callId": "t1", "content": {"toolCalls": [
        {"id": f"tc{i}", "name": "read_file", "args": {"path": "/tmp/x"}}]}}))
    frames.append(json.dumps({"op": "tool_result", "callId": "t1", "results": [{"id": f"tc{i}", "output": "ok"}]}))
frames.append(json.dumps({"op": "shutdown"}))
out, code, err = run(frames, timeout=120)
over = [f for f in out if isinstance(f, dict) and f.get("callId") == "t1" and f.get("op") == "result" and f.get("ok") is False]
llm_reqs = [f for f in out if isinstance(f, dict) and f.get("op") == "llm_request"]
check("轮数被硬闸截断（<40）", 0 < len(llm_reqs) < 40, f"llm_request 数={len(llm_reqs)}")
check("超限 result ok:false", len(over) >= 1, json.dumps(over)[:160])

# ── 3. 并发会话 ────────────────────────────────
print("=== 3. 并发会话 ===")
frames = [
    json.dumps({"op": "create", "callId": "c1", "sessionId": "A", "config": {"systemPrompt": "会话A"}}),
    json.dumps({"op": "create", "callId": "c2", "sessionId": "B", "config": {"systemPrompt": "会话B"}}),
    json.dumps({"op": "step", "callId": "sa", "sessionId": "A", "message": "给A"}),
    json.dumps({"op": "step", "callId": "sb", "sessionId": "B", "message": "给B"}),
    json.dumps({"op": "llm_response", "callId": "sa", "content": {"text": "A答"}}),
    json.dumps({"op": "llm_response", "callId": "sb", "content": {"text": "B答"}}),
    json.dumps({"op": "sessions", "callId": "ls"}),
    json.dumps({"op": "shutdown"}),
]
out, code, err = run(frames)
reqs = {f.get("callId"): f for f in out if isinstance(f, dict) and f.get("op") == "llm_request"}
ra = (reqs.get("sa") or {}).get("session") or {}
rb = (reqs.get("sb") or {}).get("session") or {}
msgs_a = [m.get("content") for m in (ra.get("messages") or []) if m.get("role") == "user"]
msgs_b = [m.get("content") for m in (rb.get("messages") or []) if m.get("role") == "user"]
check("A 收到自己的消息", msgs_a == ["给A"], str(msgs_a))
check("B 收到自己的消息", msgs_b == ["给B"], str(msgs_b))
check("A 的 systemPrompt 不串到 B", (ra.get("config") or {}).get("systemPrompt") == "会话A"
      and (rb.get("config") or {}).get("systemPrompt") == "会话B",
      json.dumps([ra.get("config"), rb.get("config")])[:160])

# ── 4. destroy 后 step ─────────────────────────
print("=== 4. destroy 语义 ===")
frames = [
    json.dumps({"op": "create", "callId": "c1", "sessionId": "s9", "config": {}}),
    json.dumps({"op": "destroy", "callId": "d1", "sessionId": "s9"}),
    json.dumps({"op": "step", "callId": "t9", "sessionId": "s9", "message": "死后"}),
    json.dumps({"op": "shutdown"}),
]
out, code, err = run(frames)
d1 = next((f for f in out if isinstance(f, dict) and f.get("callId") == "t9" and f.get("op") == "result"), None)
check("destroy 后 step → result ok:false（E1）", d1 is not None and d1.get("ok") is False, json.dumps(d1)[:150])

# ── 5. 畸形 llm_response ──────────────────────
print("=== 5. 畸形 llm_response ===")
frames = [
    json.dumps({"op": "create", "callId": "c1", "sessionId": "s5", "config": {}}),
    json.dumps({"op": "step", "callId": "t5", "sessionId": "s5", "message": "x"}),
    json.dumps({"op": "llm_response", "callId": "t5"}),  # 无 content
    json.dumps({"op": "llm_response", "callId": "t5", "content": {"text": "恢复"}}),
    json.dumps({"op": "shutdown"}),
]
out, code, err = run(frames)
r5 = [f for f in out if isinstance(f, dict) and f.get("callId") == "t5" and f.get("op") == "result"]
check("畸形回注不崩且有应答", code == 0 and len(r5) >= 1, json.dumps(r5)[:180])

# ── 6. unknown tool 拒绝（J6 白名单在环内）────
print("=== 6. 白名单环内拦截 ===")
frames = [
    json.dumps({"op": "create", "callId": "c1", "sessionId": "s6",
                "config": {"allowedTools": ["calculator"]}}),
    json.dumps({"op": "step", "callId": "t6", "sessionId": "s6", "message": "x"}),
    json.dumps({"op": "llm_response", "callId": "t6", "content": {"toolCalls": [
        {"id": "bad", "name": "run_shell", "args": {"cmd": "echo pwned"}}]}}),
    json.dumps({"op": "shutdown"}),
]
out, code, err = run(frames)
tr = [f for f in out if isinstance(f, dict) and f.get("op") == "tool_request"]
check("白名单外工具不产生 tool_request", len(tr) == 0, json.dumps(tr)[:150])
check("白名单拦截后不崩", code == 0, f"exit={code}")

# ── 汇总 ───────────────────────────────────────
passed = sum(1 for _, ok, _ in results if ok)
print(f"\n{'='*50}\nAgent 循环汇总: {passed} passed / {len(results)-passed} failed")
sys.exit(0 if passed == len(results) else 1)
