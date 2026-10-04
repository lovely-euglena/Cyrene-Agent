#!/usr/bin/env python3
"""cloud-server 同步收敛冒烟（IKJK2J / IKJK2K 验收）：真实起服务 + 两客户端并发 push/fetch + 配对令牌。

覆盖：
  1. /healthz 就绪 + RSS 观测（信息输出，不作 CI 门禁）；
  2. push 幂等（重复批：duplicates、不重复入库）；
  3. 乱序批 + 分页游标（limit 步进，不重不漏；服务端按协议 v0 规范序入库）；
  4. 两客户端并发 push → 双方全量 fetch 后按 (lamport, deviceId, seq) 收敛一致；
  5. 链校验 E_SYNC_CHAIN / E_SYNC_SEQ（整批回滚，失败批不入库）；
  6. clone 全量 JSONL + X-Sync-Cursor 与 fetch 游标一致；
  7. 畸形批 → 400 E_SYNC_BATCH_INVALID；
  8. 请求体上限（Content-Length 快检 + chunked 触顶均 → 413 E_SYNC_BATCH_TOO_LARGE，不落库）；
  9. fetch?sessionId= 会话过滤；
  10. 链过渡混用（同设备 未上链/已上链）；
  11. CLOUD_TOKEN 门闩（独立实例：/v1 无/错 401、正确 200）；
  12. 批内重复 eventId（读取器丢弃重复 → accepted=2/duplicates=0）；
  13. 半截尾行 truncatedTail → 400；
  14. 分页步进序 == 单次全量序（不重不漏）；
  15. 链拒绝 errors[].index 指向输入物理行号（排序错位场景）；
  16. 配对与设备令牌（master 出码 → 兑换；一次性/过期/轮换/撤销/设备列表；设备名代理对安全截断；
      越权管理 403 / healthz 设备计数）；
  17. 转发头只信回环代理（XFF 生效：远程 healthz 401）、Host 白名单（421）、日志脱敏、
      Linux 凭据权限（目录 0700 / DB 及 -wal/-shm 0600）；
  18. 配对接口限流（超限 → 429；按转发头真实 IP 分区）；
  19. 服务端生成闭环（mock LLM：用户消息 → assistant 事件，turnId 对齐）；
  20. 断网重试幂等（重推 user 事件不二次生成）与上下文重放（历史注入）；
  21. turn_rewind 编辑语义（替换后分支重生成）+ 上下文裁剪保护 system prompt + 用量日志/密钥脱敏；
  22. PWA 静态托管（wwwroot 存在 / capabilities.pwa=true）：GET / 返回 HTML、sw.js no-cache、HTML 附 CSP；
  23. 能力声明 GET /v1/capabilities（impl / 字段枚举 / pwa / generation；IKJN78）。

运行：
  python scripts/dotnet-cloud-sync-test.py [发布产物 dll 路径]   # 本地 full profile（起真实实例，全量检查）
  python scripts/dotnet-cloud-sync-test.py --base-url URL --master-token TOKEN [--profile core]
                                                                # 远端/核心档：对任意 HTTP 形态跑同步核心 + 配对 + 能力声明
                                                                # （跳过生成闭环/限流/环境注入类检查；本地 --profile core 亦可）
                                                                # 注意：会向实例累积测试事件/设备（id 带运行前缀，可重复跑；
                                                                # CI 定期跑建议用独立实例）
"""
import argparse
import http.server as http_server
import json
import os
import select
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 默认发布产物（Release 构建输出）；positional dll 由 parse_args 解析后在 main 覆盖（勿直接读 sys.argv）
DEFAULT_DLL = os.path.join(REPO_ROOT, "dotnet/cloud-server/bin/Release/net10.0/cyrene-cloud-server.dll")
DLL = DEFAULT_DLL
MAIN_TOKEN = "smoke-master"  # 主实例主控令牌（IKJK2K 起 /v1 始终鉴权）
BASE_HEADERS = {}            # 默认注入请求头（主实例；显式 headers 覆盖）
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"{'[PASS]' if ok else '[FAIL]'} {name}" + (f" —— {detail}" if detail and not ok else ""))


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def http(method, url, body=None, timeout=30, headers=None):
    data = body.encode("utf-8") if isinstance(body, str) else body
    request = urllib.request.Request(url, data=data, method=method)
    if isinstance(body, str):
        request.add_header("Content-Type", "application/x-ndjson; charset=utf-8")
    for key, value in {**BASE_HEADERS, **(headers or {})}.items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8"), dict(response.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8"), dict(exc.headers)


def ev(event_id, session_id="s1", lamport=0, device="dev-a", seq=0, payload=None,
       prev=None, hashed=None, typ="message.append"):
    item = {
        "eventId": event_id, "sessionId": session_id, "type": typ,
        "lamport": lamport, "deviceId": device, "seq": seq,
        "ts": "2026-10-04T03:00:00.000Z",
        "payload": payload if payload is not None else {"role": "user", "text": "message", "turnId": f"turn-{event_id}"},
    }
    if prev is not None:
        item["prevHash"] = prev
    if hashed is not None:
        item["hash"] = hashed
    return json.dumps(item, ensure_ascii=False)


def push(base, lines, headers=None):
    return http("POST", base + "/v1/sync/push", "\n".join(lines), headers=headers)


def chunked_oversized_push_probe(port, limit=10 * 1024 * 1024, chunk_size=16 * 1024):
    """裸 socket：chunked（无 Content-Length）超限——最小溢出（limit+1 字节）验证读取触顶回 413。

    只多发 1 字节：服务端触顶后基本无剩余未读体、连接干净关闭；多发会触发 RST 丢响应（Windows 实测）。
    16KB chunk 兼顾 CI 耗时；调用方对 Windows 偶发 RST 丢响应做重试兜底（服务端每次正确 413）。
    limit 与 CloudApi.MaxPushBodyBytes（README 10MB）保持同步。
    """
    total = limit + 1
    with socket.create_connection(("127.0.0.1", port), timeout=30) as sock:
        head = (
            "POST /v1/sync/push HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
            f"Authorization: Bearer {MAIN_TOKEN}\r\n"
            "Content-Type: application/x-ndjson; charset=utf-8\r\n"
            "Transfer-Encoding: chunked\r\n"
            "Connection: close\r\n\r\n"
        ).encode("ascii")
        sock.sendall(head)
        payload = b"x" * chunk_size
        try:
            sent = 0
            while sent < total:
                if select.select([sock], [], [], 0)[0]:
                    break  # 服务端已回包：立即停止发送
                size = min(chunk_size, total - sent)
                sock.sendall(f"{size:x}\r\n".encode("ascii") + payload[:size] + b"\r\n")
                sent += size
        except OSError:
            pass  # 服务端提前拒绝并关闭连接属预期
        data = bytearray()
        while True:
            try:
                chunk = sock.recv(4096)
            except (OSError, socket.timeout):
                break
            if not chunk:
                break
            data.extend(chunk)
        return data.decode("utf-8", "replace")


def raw_http_probe(port, request_lines, timeout=10):
    """裸 socket 发任意请求行（如伪造 Host），返回原始响应文本。"""
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as sock:
        sock.sendall(("\r\n".join(request_lines) + "\r\n\r\n").encode("ascii"))
        data = bytearray()
        while True:
            try:
                chunk = sock.recv(4096)
            except (OSError, socket.timeout):
                break
            if not chunk:
                break
            data.extend(chunk)
        return data.decode("utf-8", "replace")


def fetch_all(base, limit=200):
    events, cursor, has_more, guard = [], "0", True, 0
    while has_more and guard < 50:
        status, body, _ = http("GET", f"{base}/v1/sync/fetch?since={cursor}&limit={limit}")
        if status != 200:
            raise RuntimeError(f"fetch {status}: {body[:200]}")
        data = json.loads(body)
        events.extend(data["events"])
        cursor = data["cursor"]
        has_more = data["hasMore"]
        guard += 1
    if has_more:
        raise RuntimeError(f"fetch_all 超过 {guard} 页仍 hasMore（拒绝静默截断）")
    return events, cursor


def canonical_ids(events):
    ordered = sorted(events, key=lambda item: (item["lamport"], item["deviceId"], item["seq"]))
    return [item["eventId"] for item in ordered]


def wait_ready(base, timeout=40):
    for _ in range(int(timeout / 0.5)):
        try:
            if http("GET", base + "/healthz", timeout=3)[0] == 200:
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def start_instance(dll, base_env, extra_env, log_handle=None, attempts=3):
    """启动实例：端口探测 + 就绪等待；失败重试，抑制 bind 与启动之间的 TOCTOU 抖动。"""
    for attempt in range(attempts):
        port = free_port()
        base = f"http://127.0.0.1:{port}"
        env = dict(base_env)
        env.update(extra_env)
        server = subprocess.Popen(
            ["dotnet", dll, "--urls", base],
            env=env, stdout=log_handle or subprocess.DEVNULL, stderr=subprocess.STDOUT,
        )
        if wait_ready(base):
            return server, base, port
        server.terminate()
        try:
            server.wait(timeout=10)
        except Exception:
            server.kill()
    raise RuntimeError(f"服务启动失败（{attempts} 次尝试）")


def start_mock_llm():
    """本地 OpenAI 兼容 mock：记录请求体，回复「服务端回复-N」，带 usage。"""
    captured = []

    class Handler(http_server.BaseHTTPRequestHandler):
        def _read_body(self):
            if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                data = bytearray()
                while True:
                    size = int(self.rfile.readline().strip().split(b";")[0] or b"0", 16)
                    if size == 0:
                        self.rfile.readline()
                        break
                    data.extend(self.rfile.read(size))
                    self.rfile.readline()
                return bytes(data)
            length = int(self.headers.get("Content-Length", 0))
            return self.rfile.read(length)

        def do_POST(self):
            payload = json.loads(self._read_body().decode("utf-8"))
            captured.append(payload)
            reply = f"服务端回复-{len(captured)}"
            body = json.dumps({
                "choices": [{"message": {"role": "assistant", "content": reply}}],
                "usage": {"prompt_tokens": 12, "completion_tokens": 7},
            }).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = http_server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, captured, server.server_address[1]


def oversized_push_probe(port, content_length=11 * 1024 * 1024):
    """裸 socket：只发请求头（超大 Content-Length）、不发 body——验证服务端在读取前就拒绝。"""
    with socket.create_connection(("127.0.0.1", port), timeout=10) as sock:
        head = (
            "POST /v1/sync/push HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
            f"Authorization: Bearer {MAIN_TOKEN}\r\n"
            f"Content-Length: {content_length}\r\n"
            "Content-Type: application/x-ndjson; charset=utf-8\r\n"
            "Connection: close\r\n\r\n"
        ).encode("ascii")
        sock.sendall(head)
        data = bytearray()
        while True:
            try:
                chunk = sock.recv(4096)
            except (OSError, socket.timeout):
                break
            if not chunk:
                break
            data.extend(chunk)
        return data.decode("utf-8", "replace")


def summarize():
    passed = sum(1 for _, ok, _ in results if ok)
    failed = len(results) - passed
    print(f"\n{'='*50}\ncloud-server 同步冒烟汇总: {passed} passed / {failed} failed")
    return 1 if failed else 0


def parse_args():
    parser = argparse.ArgumentParser(description="cloud-server 同步冒烟（本地 full / 远端 core；IKJK2J / IKJK2K / IKJN78）")
    parser.add_argument("dll", nargs="?", default=None, help="本地模式：cloud-server 发布产物 dll")
    parser.add_argument("--base-url", dest="base_url", default=None,
                        help="远端模式：已部署实例的 base URL（不再起本地实例）")
    parser.add_argument("--master-token", dest="master_token", default=None,
                        help="主控令牌（远端模式必填；本地模式默认 smoke-master）")
    parser.add_argument("--profile", choices=["full", "core"], default=None,
                        help="检查档位（默认：本地 full / 远端 core；core 跳过生成/限流/环境注入类检查）")
    return parser.parse_args()


def run_core_checks(base, master_token):
    """核心档（IKJN78）：对任意 HTTP 形态跑协议 v0 同步核心 + 配对令牌 + 能力声明（+ PWA 静态）。

    用于远端形态（CF / PHP / …）与本地 core profile；事件/会话 id 带运行前缀（对持久化实例可重复跑）。
    对启用服务端生成的实例（如 CF 验收的回声 mock）：计数 / 集合断言只统计 run 前缀事件
    （生成事件 id 前缀 gen-），clone 允许生成事件在快照边界间落入（单调夹逼 + run 集合）。
    不覆盖需实例环境注入的检查：生成闭环 / 限流阈值 / Host 白名单 / 日志脱敏 / Linux 权限 /
    裸 socket 请求体上限探测（这些仅本地 full profile）。
    """
    BASE_HEADERS["Authorization"] = f"Bearer {master_token}"
    run = str(int(time.time()))

    def sess(name):
        return f"s-{run}-{name}"

    def run_only(items):
        """仅本 run 前缀事件（并发生成下计数断言保持确定）。"""
        return [item for item in items if item["eventId"].startswith(run + "-")]

    # 0. healthz + 能力声明
    status, body, _ = http("GET", base + "/healthz", timeout=5)
    check("healthz 就绪（核心档）", status == 200, f"{status} {body[:120]}")
    status, body, _ = http("GET", base + "/v1/capabilities")
    caps = json.loads(body) if status == 200 else {}
    check("能力声明 /v1/capabilities（impl/sync/clone/cursor/generation/pairing/pwa/maxBatchBytes）",
          status == 200 and isinstance(caps.get("impl"), str) and bool(caps.get("impl"))
          and caps.get("sync") is True and caps.get("clone") is True
          and caps.get("cursor") in ("server", "file-offset")
          and caps.get("generation") in ("realtime", "inline", "none")
          and isinstance(caps.get("pairing"), str) and isinstance(caps.get("pwa"), bool)
          and isinstance(caps.get("maxBatchBytes"), int),
          f"{status} {body[:200]}")

    # 0b. PWA 静态托管（按能力声明）
    if caps.get("pwa") is True:
        status, _, headers = http("GET", base + "/")
        check("PWA 静态托管：GET / 返回 HTML",
              status == 200 and "text/html" in headers.get("Content-Type", ""), f"status={status}")
        status, _, headers = http("GET", base + "/sw.js")
        check("PWA 静态托管：sw.js no-cache",
              status == 200 and headers.get("Cache-Control") == "no-cache",
              f"status={status} cc={headers.get('Cache-Control')}")
        status, _, headers = http("GET", base + "/index.html")
        check("PWA 静态托管：HTML 附 CSP",
              status == 200 and "default-src 'self'" in headers.get("Content-Security-Policy", ""),
              f"csp={headers.get('Content-Security-Policy')}")
    else:
        print("[SKIP] PWA 静态托管（capabilities.pwa=false）")

    # 1. push 幂等
    batch = [
        ev(f"{run}-a1", session_id=sess("1"), lamport=0, seq=0, typ="session.create",
           payload={"title": "会话", "createdAt": "2026-10-04T03:00:00.000Z"}),
        ev(f"{run}-a2", session_id=sess("1"), lamport=1, seq=1),
        ev(f"{run}-a3", session_id=sess("1"), lamport=2, seq=2, payload={"role": "assistant", "text": "回复"}),
    ]
    status, body, _ = push(base, batch)
    data = json.loads(body) if status == 200 else {}
    check("push 首批 accepted=3", status == 200 and data.get("accepted") == 3 and data.get("duplicates") == 0, body[:200])
    status, body, _ = push(base, batch)
    data = json.loads(body) if status == 200 else {}
    check("重复批幂等（accepted=0 / duplicates=3）",
          status == 200 and data.get("accepted") == 0 and data.get("duplicates") == 3, body[:200])

    # 2. 乱序批 + 分页
    shuffled = [
        ev(f"{run}-b3", session_id=sess("2"), device="dev-b", lamport=5, seq=2),
        ev(f"{run}-b1", session_id=sess("2"), device="dev-b", lamport=3, seq=0),
        ev(f"{run}-b2", session_id=sess("2"), device="dev-b", lamport=4, seq=1),
    ]
    status, body, _ = push(base, shuffled)
    check("乱序批 accepted=3（服务端按协议 v0 规范序入库）",
          status == 200 and json.loads(body).get("accepted") == 3, body[:200])
    events, _ = fetch_all(base, limit=2)
    whole, _ = fetch_all(base, limit=1000)
    check("分页游标不重不漏（步进序 == 单次全量序）",
          canonical_ids(run_only(events)) == canonical_ids(run_only(whole)),
          f"paged={len(events)} whole={len(whole)}")
    run_ids = [item["eventId"] for item in events if item["eventId"].startswith(run + "-")]
    check("插入序（run 内前三条 a1,a2,a3）",
          run_ids[:3] == [f"{run}-a1", f"{run}-a2", f"{run}-a3"], str(run_ids[:5]))

    # 2b. 批内重复 eventId
    dup_batch = [
        ev(f"{run}-d1", session_id=sess("6"), device="dev-d", lamport=1, seq=1),
        ev(f"{run}-d1", session_id=sess("6"), device="dev-d", lamport=1, seq=1),
        ev(f"{run}-d2", session_id=sess("6"), device="dev-d", lamport=2, seq=2),
    ]
    status, body, _ = push(base, dup_batch)
    data = json.loads(body) if status == 200 else {}
    check("批内重复 eventId（丢弃重复 → accepted=2 / duplicates=0）",
          status == 200 and data.get("accepted") == 2 and data.get("duplicates") == 0, body[:200])

    # 3. 两客户端并发
    errors = []

    def client(name, device):
        for i in range(1, 6):
            status, body, _ = push(base, [ev(f"{run}-{name}{i}", session_id=sess("3"), device=device, lamport=i, seq=i)])
            if status != 200:
                errors.append((name, i, status, body[:120]))

    pre_run = len(run_only(fetch_all(base)[0]))
    thread_a = threading.Thread(target=client, args=("ca", "dev-a"))
    thread_b = threading.Thread(target=client, args=("cb", "dev-b"))
    thread_a.start()
    thread_b.start()
    thread_a.join()
    thread_b.join()
    check("两客户端并发 push 全 200", not errors, str(errors)[:200])
    view_a, _ = fetch_all(base)
    view_b, _ = fetch_all(base)
    run_view_a = run_only(view_a)
    run_view_b = run_only(view_b)
    run_ca = sum(1 for item in run_view_a if item["eventId"].startswith(f"{run}-ca"))
    run_cb = sum(1 for item in run_view_a if item["eventId"].startswith(f"{run}-cb"))
    check("并发后双端收敛一致（(lamport, deviceId, seq) 全序）",
          canonical_ids(run_view_a) == canonical_ids(run_view_b) and len(run_view_a) == pre_run + 10
          and run_ca == 5 and run_cb == 5,
          f"run={len(run_view_a)} ca={run_ca} cb={run_cb}")

    # 4. 链校验
    baseline = len(run_only(fetch_all(base)[0]))
    h1, h2, h3 = "a" * 64, "b" * 64, "c" * 64
    status, body, _ = push(base, [ev(f"{run}-ch1", session_id=sess("4"), device="dev-c", lamport=1, seq=1, hashed=h1)])
    check("链首（hash 无 prevHash）接受", status == 200, body[:160])
    status, body, _ = push(base, [ev(f"{run}-ch2", session_id=sess("4"), device="dev-c", lamport=2, seq=2, prev=h1, hashed=h2)])
    check("链续（prevHash=链尾）接受", status == 200, body[:160])
    status, body, _ = push(base, [ev(f"{run}-bad1", session_id=sess("4"), device="dev-c", lamport=3, seq=3, prev=h3, hashed=h3)])
    data = json.loads(body) if status == 400 else {}
    check("坏 link → 400 E_SYNC_CHAIN",
          status == 400 and data.get("code") == "E_SYNC_BATCH_REJECTED"
          and any(e.get("code") == "E_SYNC_CHAIN" for e in data.get("errors", [])), body[:200])
    status, body, _ = push(base, [ev(f"{run}-bad2", session_id=sess("4"), device="dev-c", lamport=4, seq=4, prev=h2)])
    data = json.loads(body) if status == 400 else {}
    check("半链（prevHash 无 hash）→ E_SYNC_CHAIN",
          status == 400 and any(e.get("code") == "E_SYNC_CHAIN" for e in data.get("errors", [])), body[:200])
    status, body, _ = push(base, [ev(f"{run}-bad3", session_id=sess("4"), device="dev-c", lamport=5, seq=2)])
    data = json.loads(body) if status == 400 else {}
    check("seq 非递增 → E_SYNC_SEQ",
          status == 400 and any(e.get("code") == "E_SYNC_SEQ" for e in data.get("errors", [])), body[:200])
    events, _ = fetch_all(base)
    check("失败批整批回滚（总数不变）", len(run_only(events)) == baseline + 2,
          f"run={len(run_only(events))} baseline={baseline}")

    # 4b. 链拒绝 errors[].index = 物理行号
    bad_first = [
        ev(f"{run}-lb1", session_id=sess("9"), device="dev-e", lamport=9, seq=9, prev=h3, hashed=h3),
        ev(f"{run}-lg1", session_id=sess("9"), device="dev-e", lamport=1, seq=1),
        ev(f"{run}-lg2", session_id=sess("9"), device="dev-e", lamport=5, seq=5),
    ]
    status, body, _ = push(base, bad_first)
    data = json.loads(body) if status == 400 else {}
    check("链拒绝 errors[].index 指向物理行号（排序错位场景）",
          status == 400 and data.get("code") == "E_SYNC_BATCH_REJECTED"
          and [e.get("index") for e in data.get("errors", [])] == [0], body[:200])

    # 5. 畸形批 + 半截尾行
    status, body, _ = push(base, [ev(f"{run}-ok1"), "这不是 JSON", ev(f"{run}-ok2")])
    data = json.loads(body) if status == 400 else {}
    check("畸形批 → 400 E_SYNC_BATCH_INVALID",
          status == 400 and data.get("code") == "E_SYNC_BATCH_INVALID", body[:160])
    half = ('{"eventId":"' + run + '-t1","sessionId":"' + sess("7") + '","type":"message.append","lamport":1,'
            '"deviceId":"dev-t","seq":1,"ts":"2026-10-04T03:00:00.000Z","payl')
    status, body, _ = http("POST", base + "/v1/sync/push", half)
    data = json.loads(body) if status == 400 else {}
    check("半截尾行 → 400 E_SYNC_BATCH_INVALID（truncatedTail）",
          status == 400 and data.get("code") == "E_SYNC_BATCH_INVALID" and data.get("truncatedTail") is True,
          body[:160])

    # 6. clone（对启用生成的实例：允许生成事件在快照边界间落入；run 前缀集合 + 游标边界断言）
    events_before, cursor_before = fetch_all(base)
    status, clone_body, headers = http("GET", base + "/v1/sync/clone")
    clone_ids = [json.loads(line)["eventId"] for line in clone_body.splitlines() if line.strip()]
    events_after, cursor_after = fetch_all(base)
    clone_run = sorted(item for item in clone_ids if item.startswith(run + "-"))
    after_run = sorted(item["eventId"] for item in run_only(events_after))
    clone_header = int(headers.get("X-Sync-Cursor", "-1"))
    check("clone 全量 + X-Sync-Cursor 对齐（run 前缀 + 游标边界）",
          status == 200 and clone_run == after_run and int(cursor_before) <= clone_header <= int(cursor_after),
          f"clone={len(clone_ids)} header={clone_header} cursor={cursor_before}..{cursor_after}")
    check("clone 快照单调（前 ⊆ clone ⊆ 后）",
          {item["eventId"] for item in events_before} <= set(clone_ids) <= {item["eventId"] for item in events_after},
          f"before={len(events_before)} clone={len(clone_ids)} after={len(events_after)}")

    # 7. 会话过滤（run 前缀 3 条；生成回复（gen-）可存在但必须同会话）
    status, body, _ = http("GET", base + f"/v1/sync/fetch?since=0&limit=200&sessionId={sess('2')}")
    data = json.loads(body) if status == 200 else {}
    items = data.get("events", [])
    check("fetch?sessionId= 过滤（run 内 3 条且不串会话）",
          status == 200 and sorted(item["eventId"] for item in run_only(items)) == [f"{run}-b1", f"{run}-b2", f"{run}-b3"]
          and all(item["sessionId"] == sess("2") for item in items), body[:160])

    # 8. 链过渡混用
    status, body, _ = push(base, [ev(f"{run}-mix1", session_id=sess("5"), device="dev-c", lamport=1, seq=1, hashed=h1)])
    mix1 = status == 200
    status, body, _ = push(base, [ev(f"{run}-mix2", session_id=sess("5"), device="dev-c", lamport=2, seq=2)])
    mix2 = status == 200
    status, body, _ = push(base, [ev(f"{run}-mix3", session_id=sess("5"), device="dev-c", lamport=3, seq=3, prev=h1, hashed=h2)])
    check("链过渡策略：未上链/已上链混用允许（链尾 = 最近已上链）", mix1 and mix2 and status == 200, body[:160])

    # 9. 配对与设备令牌（HTTP 级；master 出码）
    master = {"Authorization": f"Bearer {master_token}"}
    status, body, _ = http("POST", base + "/v1/pair/code", headers=master)
    code = json.loads(body).get("code", "") if status == 200 else ""
    check("配对出码（master → 一次性配对码，格式 XXXX-XXXX）", status == 200 and len(code) == 9, body[:160])
    redeem_body = json.dumps({"code": code, "deviceName": "烟测手机"}, ensure_ascii=False)
    status, body, _ = http("POST", base + "/v1/pair", redeem_body, headers={"Content-Type": "application/json"})
    data = json.loads(body) if status == 200 else {}
    device_token = data.get("token", "")
    device_id = data.get("deviceId", "")
    check("配对兑换（device token 仅此一次回显）",
          status == 200 and device_token.startswith("cyn_") and device_id.startswith("dev_"), body[:160])
    status, body, _ = http("POST", base + "/v1/pair", redeem_body, headers={"Content-Type": "application/json"})
    check("配对码一次性（二次兑换 400 E_PAIR_CODE）",
          status == 400 and json.loads(body).get("code") == "E_PAIR_CODE", body[:160])
    ok_dev = http("GET", base + "/v1/sync/fetch?since=0", headers={"Authorization": f"Bearer {device_token}"})[0] == 200
    forged = http("GET", base + "/v1/sync/fetch?since=0", headers={"Authorization": "Bearer cyn_forged"})[0]
    check("device token 可用 / 伪造 token 401", ok_dev and forged == 401, f"ok={ok_dev} forged={forged}")
    status, body, _ = http("POST", base + f"/v1/devices/{device_id}/rotate",
                           headers={"Authorization": f"Bearer {device_token}"})
    new_token = json.loads(body).get("token", "") if status == 200 else ""
    old_after = http("GET", base + "/v1/sync/fetch?since=0", headers={"Authorization": f"Bearer {device_token}"})[0]
    new_ok = http("GET", base + "/v1/sync/fetch?since=0", headers={"Authorization": f"Bearer {new_token}"})[0]
    check("轮换即时生效（旧 token 401 / 新 token 200）",
          status == 200 and old_after == 401 and new_ok == 200, f"rotate={status} old={old_after} new={new_ok}")
    status, body, _ = http("POST", base + f"/v1/devices/{device_id}/revoke",
                           headers={"Authorization": f"Bearer {new_token}"})
    revoked_after = http("GET", base + "/v1/sync/fetch?since=0", headers={"Authorization": f"Bearer {new_token}"})[0]
    check("撤销即时生效（撤销后 401）", status == 200 and revoked_after == 401, f"revoke={status} after={revoked_after}")
    status, body, _ = http("GET", base + "/v1/devices", headers=master)
    devices = json.loads(body).get("devices", []) if status == 200 else []
    check("设备列表（含撤销标记）",
          status == 200 and any(d.get("deviceId") == device_id and d.get("revoked") for d in devices), body[:160])
    status, body, _ = http("POST", base + "/v1/pair/code", headers=master)
    code3 = json.loads(body).get("code", "") if status == 200 else ""
    status, body, _ = http("POST", base + "/v1/pair",
                           json.dumps({"code": code3, "deviceName": "a" * 63 + "😀"}, ensure_ascii=False),
                           headers={"Content-Type": "application/json"})
    data = json.loads(body) if status == 200 else {}
    token3 = data.get("token", "")
    check("设备名截断不切断代理对（63a+emoji → 63a）",
          status == 200 and data.get("name") == "a" * 63, f"status={status} name={data.get('name')!r}")
    cross_rotate = http("POST", base + f"/v1/devices/{device_id}/rotate",
                        headers={"Authorization": f"Bearer {token3}"})[0]
    cross_list = http("GET", base + "/v1/devices", headers={"Authorization": f"Bearer {token3}"})[0]
    check("设备管理越权（他设备 rotate 403、清单仅 master 403）",
          cross_rotate == 403 and cross_list == 403, f"rotate={cross_rotate} list={cross_list}")


def main():
    global DLL
    args = parse_args()
    DLL = os.path.abspath(args.dll) if args.dll else DEFAULT_DLL
    remote = bool(args.base_url)
    profile = args.profile or ("core" if remote else "full")
    master_token = args.master_token or MAIN_TOKEN
    if remote and not args.master_token:
        print("[FAIL] 远端模式需显式 --master-token（避免静默回退 smoke-master 造成连续 401）")
        return 1

    if remote or profile == "core":
        # 核心档：对任意 HTTP 形态（远端或本地实例）跑同步核心 + 配对 + 能力声明
        dll = DLL
        server = None
        data_dir = None
        log_file = None
        if remote:
            base = args.base_url.rstrip("/")
            parsed = urllib.parse.urlparse(base)
            port = parsed.port or (443 if parsed.scheme == "https" else 80)
            print(f"[info] 远端模式 base={base}（跳过需本地进程/环境注入的检查）")
        else:
            if not os.path.exists(dll):
                print(f"[FAIL] 未找到 {dll}，先 dotnet build dotnet/cloud-server -c Release")
                return 1
            data_dir = tempfile.mkdtemp(prefix="cloud-sync-core-")
            env = dict(os.environ)
            env["CYRENE_CLOUD_DATA"] = data_dir
            env["Logging__LogLevel__Default"] = "Warning"
            env["CLOUD_TOKEN"] = master_token
            dotnet_home = os.path.expanduser("~/.dotnet")
            if os.path.isdir(dotnet_home):
                env["DOTNET_ROOT"] = dotnet_home
                env["PATH"] = dotnet_home + os.pathsep + env.get("PATH", "")
            log_path = os.path.join(data_dir, "server-out.log")
            log_file = open(log_path, "w", encoding="utf-8", errors="replace")
            try:
                server, base, port = start_instance(dll, env, {}, log_handle=log_file)
            except RuntimeError as exc:
                log_file.close()
                print(f"[FAIL] {exc}")
                shutil.rmtree(data_dir, ignore_errors=True)
                return 1
        try:
            run_core_checks(base, master_token)
        finally:
            if server is not None:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except Exception:
                    server.kill()
                log_file.close()
                shutil.rmtree(data_dir, ignore_errors=True)
        return summarize()

    if not os.path.exists(DLL):
        print(f"[FAIL] 未找到 {DLL}，先 dotnet build dotnet/cloud-server -c Release")
        return 1
    data_dir = tempfile.mkdtemp(prefix="cloud-sync-")
    env = dict(os.environ)
    env["CYRENE_CLOUD_DATA"] = data_dir
    env["Logging__LogLevel__Default"] = "Warning"
    env["CLOUD_TOKEN"] = MAIN_TOKEN
    dotnet_home = os.path.expanduser("~/.dotnet")
    if os.path.isdir(dotnet_home):
        env["DOTNET_ROOT"] = dotnet_home
        env["PATH"] = dotnet_home + os.pathsep + env.get("PATH", "")
    log_path = os.path.join(data_dir, "server-out.log")
    log_file = open(log_path, "w", encoding="utf-8", errors="replace")
    try:
        server, base, port = start_instance(DLL, env, {}, log_handle=log_file)
    except RuntimeError as exc:
        log_file.close()
        try:
            with open(log_path, encoding="utf-8", errors="replace") as handle:
                print(handle.read()[-2000:])
        except Exception:
            pass
        shutil.rmtree(data_dir, ignore_errors=True)
        print(f"[FAIL] {exc}")
        return 1
    try:
        status, body, _ = http("GET", base + "/healthz", timeout=3)
        health = json.loads(body) if status == 200 else {}
        BASE_HEADERS["Authorization"] = f"Bearer {MAIN_TOKEN}"
        check("healthz 就绪 + RSS 观测", isinstance(health.get("rssMB"), (int, float)), json.dumps(health)[:120])
        rss = health.get("rssMB")
        print(f"  healthz: cursor={health.get('cursor')} rssMB={rss}")
        if isinstance(rss, (int, float)) and rss >= 300:
            print("  [WARN] RSS 超过参考阈值 300MB（不计入 failed；口径：进程硬上限 512M / VPS 总预算 2G，见 README）")

        # 0. 能力声明（IKJN78；公开只读）
        status, body, _ = http("GET", base + "/v1/capabilities")
        caps = json.loads(body) if status == 200 else {}
        check("能力声明 /v1/capabilities（impl/sync/clone/cursor/generation/pairing/pwa/maxBatchBytes）",
              status == 200 and isinstance(caps.get("impl"), str) and bool(caps.get("impl"))
              and caps.get("sync") is True and caps.get("clone") is True
              and caps.get("cursor") in ("server", "file-offset")
              and caps.get("generation") in ("realtime", "inline", "none")
              and isinstance(caps.get("pairing"), str) and isinstance(caps.get("pwa"), bool)
              and isinstance(caps.get("maxBatchBytes"), int),
              f"{status} {body[:200]}")
        check("能力声明：实例配置一致（无 LLM → generation=none；pwa 与 wwwroot 存在性一致）",
              caps.get("generation") == "none"
              and caps.get("pwa") == os.path.exists(os.path.join(os.path.dirname(DLL), "wwwroot")),
              f"generation={caps.get('generation')} pwa={caps.get('pwa')}")

        # 1b. PWA 静态托管（wwwroot 随发布产物；未构建 PWA 时跳过）
        wwwroot_index = os.path.join(os.path.dirname(DLL), "wwwroot", "index.html")
        if os.path.exists(wwwroot_index):
            status, _, headers = http("GET", base + "/")
            check("PWA 静态托管：GET / 返回 HTML",
                  status == 200 and "text/html" in headers.get("Content-Type", ""),
                  f"status={status} type={headers.get('Content-Type')}")
            status, _, headers = http("GET", base + "/sw.js")
            check("PWA 静态托管：sw.js no-cache",
                  status == 200 and headers.get("Cache-Control") == "no-cache",
                  f"status={status} cc={headers.get('Cache-Control')}")
            status, _, headers = http("GET", base + "/index.html")
            check("PWA 静态托管：HTML 附 CSP",
                  status == 200 and "default-src 'self'" in headers.get("Content-Security-Policy", ""),
                  f"csp={headers.get('Content-Security-Policy')}")
        else:
            print("[SKIP] PWA 静态托管（wwwroot 未构建：npm --prefix src/pwa run build）")

        # 1. 幂等
        batch = [
            ev("a1", lamport=0, seq=0, typ="session.create",
               payload={"title": "会话", "createdAt": "2026-10-04T03:00:00.000Z"}),
            ev("a2", lamport=1, seq=1),
            ev("a3", lamport=2, seq=2, payload={"role": "assistant", "text": "回复"}),
        ]
        status, body, _ = push(base, batch)
        data = json.loads(body)
        check("push 首批 accepted=3", status == 200 and data.get("accepted") == 3 and data.get("duplicates") == 0, body[:200])
        status, body, _ = push(base, batch)
        data = json.loads(body)
        check("重复批幂等（accepted=0 / duplicates=3）",
              status == 200 and data.get("accepted") == 0 and data.get("duplicates") == 3, body[:200])

        # 2. 乱序批 + 分页
        shuffled = [
            ev("b3", session_id="s2", device="dev-b", lamport=5, seq=2),
            ev("b1", session_id="s2", device="dev-b", lamport=3, seq=0),
            ev("b2", session_id="s2", device="dev-b", lamport=4, seq=1),
        ]
        status, body, _ = push(base, shuffled)
        check("乱序批 accepted=3（服务端按协议 v0 规范序入库）",
              status == 200 and json.loads(body).get("accepted") == 3, body[:200])
        events, _ = fetch_all(base, limit=2)
        whole, _ = fetch_all(base, limit=1000)
        check("分页游标不重不漏（步进序 == 单次全量序）",
              canonical_ids(events) == canonical_ids(whole) and len(events) == 6,
              f"paged={len(events)} whole={len(whole)}")
        check("首批插入序 a1,a2,a3",
              [item["eventId"] for item in events[:3]] == ["a1", "a2", "a3"],
              str([item["eventId"] for item in events])[:120])

        # 2b. 批内重复 eventId（读取器丢弃重复；首见入库 → accepted=2 / duplicates=0）
        dup_batch = [
            ev("d1", session_id="s6", device="dev-d", lamport=1, seq=1),
            ev("d1", session_id="s6", device="dev-d", lamport=1, seq=1),
            ev("d2", session_id="s6", device="dev-d", lamport=2, seq=2),
        ]
        status, body, _ = push(base, dup_batch)
        data = json.loads(body)
        check("批内重复 eventId（丢弃重复 → accepted=2 / duplicates=0）",
              status == 200 and data.get("accepted") == 2 and data.get("duplicates") == 0, body[:200])

        # 3. 两客户端并发
        errors = []

        def client(name, device):
            for i in range(1, 6):
                status, body, _ = push(base, [ev(f"{name}{i}", session_id="s3", device=device, lamport=i, seq=i)])
                if status != 200:
                    errors.append((name, i, status, body[:120]))

        thread_a = threading.Thread(target=client, args=("ca", "dev-a"))
        thread_b = threading.Thread(target=client, args=("cb", "dev-b"))
        pre_concurrent = len(fetch_all(base)[0])
        thread_a.start()
        thread_b.start()
        thread_a.join()
        thread_b.join()
        check("两客户端并发 push 全 200", not errors, str(errors)[:200])
        view_a, _ = fetch_all(base)
        view_b, _ = fetch_all(base)
        ordered = canonical_ids(view_a)
        check("并发后双端收敛一致（(lamport, deviceId, seq) 全序）",
              canonical_ids(view_a) == canonical_ids(view_b) and len(view_a) == pre_concurrent + 10
              and sum(1 for i in ordered if i.startswith("ca")) == 5
              and sum(1 for i in ordered if i.startswith("cb")) == 5,
              f"n={len(view_a)}")

        # 4. 链校验（基线动态计算）
        baseline = len(fetch_all(base)[0])
        h1, h2, h3 = "a" * 64, "b" * 64, "c" * 64
        status, body, _ = push(base, [ev("ch1", session_id="s4", device="dev-c", lamport=1, seq=1, hashed=h1)])
        check("链首（hash 无 prevHash）接受", status == 200, body[:160])
        status, body, _ = push(base, [ev("ch2", session_id="s4", device="dev-c", lamport=2, seq=2, prev=h1, hashed=h2)])
        check("链续（prevHash=链尾）接受", status == 200, body[:160])
        status, body, _ = push(base, [ev("bad1", session_id="s4", device="dev-c", lamport=3, seq=3, prev=h3, hashed=h3)])
        data = json.loads(body)
        check("坏 link → 400 E_SYNC_CHAIN",
              status == 400 and data.get("code") == "E_SYNC_BATCH_REJECTED"
              and any(e.get("code") == "E_SYNC_CHAIN" for e in data.get("errors", [])), body[:200])
        status, body, _ = push(base, [ev("bad2", session_id="s4", device="dev-c", lamport=4, seq=4, prev=h2)])
        data = json.loads(body)
        check("半链（prevHash 无 hash）→ E_SYNC_CHAIN",
              status == 400 and any(e.get("code") == "E_SYNC_CHAIN" for e in data.get("errors", [])), body[:200])
        status, body, _ = push(base, [ev("bad3", session_id="s4", device="dev-c", lamport=5, seq=2)])
        data = json.loads(body)
        check("seq 非递增 → E_SYNC_SEQ",
              status == 400 and any(e.get("code") == "E_SYNC_SEQ" for e in data.get("errors", [])), body[:200])
        events, _ = fetch_all(base)
        check("失败批整批回滚（总数不变）", len(events) == baseline + 2,
              f"n={len(events)} baseline={baseline}")

        # 4b. 链拒绝 errors[].index = 物理行号（构造排序错位：坏行在 line0、按 lamport 排到最后）
        bad_first = [
            ev("lb1", session_id="s9", device="dev-e", lamport=9, seq=9, prev=h3, hashed=h3),
            ev("lg1", session_id="s9", device="dev-e", lamport=1, seq=1),
            ev("lg2", session_id="s9", device="dev-e", lamport=5, seq=5),
        ]
        status, body, _ = push(base, bad_first)
        data = json.loads(body)
        check("链拒绝 errors[].index 指向物理行号（排序错位场景）",
              status == 400 and data.get("code") == "E_SYNC_BATCH_REJECTED"
              and [e.get("index") for e in data.get("errors", [])] == [0], body[:200])

        # 5. 畸形批
        status, body, _ = push(base, [ev("ok1"), "这不是 JSON", ev("ok2")])
        data = json.loads(body)
        check("畸形批 → 400 E_SYNC_BATCH_INVALID",
              status == 400 and data.get("code") == "E_SYNC_BATCH_INVALID", body[:160])

        # 5b. 半截尾行（truncatedTail）→ 400 E_SYNC_BATCH_INVALID
        half = ('{"eventId":"t1","sessionId":"s7","type":"message.append","lamport":1,'
                '"deviceId":"dev-t","seq":1,"ts":"2026-10-04T03:00:00.000Z","payl')
        status, body, _ = http("POST", base + "/v1/sync/push", half)
        data = json.loads(body)
        check("半截尾行 → 400 E_SYNC_BATCH_INVALID（truncatedTail）",
              status == 400 and data.get("code") == "E_SYNC_BATCH_INVALID" and data.get("truncatedTail") is True,
              body[:160])

        # 6. 请求体上限（>10MB → 413，不落库；裸 socket 只发头不发体，验证读取前即拒绝）
        response = oversized_push_probe(port)
        first_line = response.split("\r\n", 1)[0]
        check("请求体上限（Content-Length >10MB → 413 E_SYNC_BATCH_TOO_LARGE）",
              " 413 " in first_line and "E_SYNC_BATCH_TOO_LARGE" in response,
              response[:200].replace("\r\n", " "))
        response = ""
        chunked_attempts = 0
        for _ in range(3):  # Windows RST 抖动：重试至多 3 次（服务端每次正确 413）
            chunked_attempts += 1
            response = chunked_oversized_push_probe(port)
            if " 413 " in response.split("\r\n", 1)[0] and "E_SYNC_BATCH_TOO_LARGE" in response:
                break
        first_line = response.split("\r\n", 1)[0]
        check("chunked 超限（无 Content-Length）→ 413 E_SYNC_BATCH_TOO_LARGE",
              " 413 " in first_line and "E_SYNC_BATCH_TOO_LARGE" in response,
              f"attempts={chunked_attempts} resp={response[:160]}".replace("\r\n", " "))

        # 7. clone
        status, clone_body, headers = http("GET", base + "/v1/sync/clone")
        clone_ids = [json.loads(line)["eventId"] for line in clone_body.splitlines() if line.strip()]
        events, cursor = fetch_all(base)
        check("clone 全量 + X-Sync-Cursor 对齐",
              status == 200 and len(clone_ids) == len(events) and headers.get("X-Sync-Cursor") == cursor,
              f"clone={len(clone_ids)} fetch={len(events)} header={headers.get('X-Sync-Cursor')} cursor={cursor}")
        check("clone 集合与 fetch 一致", set(clone_ids) == {item["eventId"] for item in events})

        # 8. 会话过滤（fetch?sessionId=）
        status, body, _ = http("GET", base + "/v1/sync/fetch?since=0&limit=200&sessionId=s2")
        data = json.loads(body)
        check("fetch?sessionId= 过滤（s2 只回 3 条）",
              status == 200 and len(data.get("events", [])) == 3
              and all(item["sessionId"] == "s2" for item in data.get("events", [])), body[:160])

        # 9. 链过渡：未上链/已上链混用（同设备）允许
        status, body, _ = push(base, [ev("mix1", session_id="s5", device="dev-c", lamport=1, seq=1, hashed=h1)])
        mix1 = status == 200
        status, body, _ = push(base, [ev("mix2", session_id="s5", device="dev-c", lamport=2, seq=2)])
        mix2 = status == 200
        status, body, _ = push(base, [ev("mix3", session_id="s5", device="dev-c", lamport=3, seq=3, prev=h1, hashed=h2)])
        check("链过渡策略：未上链/已上链混用允许（链尾 = 最近已上链）",
              mix1 and mix2 and status == 200, body[:160])

        # 10. CLOUD_TOKEN 门闩（独立实例）：无/错 token → 401，正确 → 200
        token_dir = tempfile.mkdtemp(prefix="cloud-sync-token-")
        token_server = None
        try:
            token_server, token_base, _ = start_instance(
                DLL, env, {"CYRENE_CLOUD_DATA": token_dir, "CLOUD_TOKEN": "s3cret"})
            no_token = http("GET", token_base + "/v1/sync/fetch?since=0", headers={"Authorization": ""})[0]
            wrong_token = http("GET", token_base + "/v1/sync/fetch?since=0",
                               headers={"Authorization": "Bearer nope"})[0]
            ok_token = http("GET", token_base + "/v1/sync/fetch?since=0",
                            headers={"Authorization": "Bearer s3cret"})[0]
            check("CLOUD_TOKEN 门闩（无/错 token 401，正确 200）",
                  no_token == 401 and wrong_token == 401 and ok_token == 200,
                  f"no={no_token} wrong={wrong_token} ok={ok_token}")
        finally:
            if token_server is not None:
                token_server.terminate()
                try:
                    token_server.wait(timeout=10)
                except Exception:
                    token_server.kill()
            shutil.rmtree(token_dir, ignore_errors=True)

        # 11. 配对与设备令牌（IKJK2K；独立实例：TTL 2s + Host 白名单 + 日志落文件）
        pair_dir = tempfile.mkdtemp(prefix="cloud-sync-pair-")
        pair_log = os.path.join(pair_dir, "server-out.log")
        pair_handle = open(pair_log, "w", encoding="utf-8", errors="replace")
        pair_server = None
        try:
            pair_server, pair_base, pair_port = start_instance(DLL, env, {
                "CYRENE_CLOUD_DATA": pair_dir,
                "CLOUD_TOKEN": "pair-master",
                "CLOUD_PAIR_TTL_SECONDS": "2",
                "CLOUD_ALLOWED_HOSTS": "example.com",
            }, log_handle=pair_handle)
            master = {"Authorization": "Bearer pair-master"}
            status, body, _ = http("POST", pair_base + "/v1/pair/code", headers=master)
            code = json.loads(body).get("code", "") if status == 200 else ""
            check("配对出码（master → 一次性配对码，格式 XXXX-XXXX）",
                  status == 200 and len(code) == 9, body[:160])

            redeem_body = json.dumps({"code": code, "deviceName": "烟测手机"}, ensure_ascii=False)
            status, body, _ = http("POST", pair_base + "/v1/pair", redeem_body,
                                   headers={"Content-Type": "application/json"})
            data = json.loads(body)
            device_token = data.get("token", "")
            device_id = data.get("deviceId", "")
            check("配对兑换（device token 仅此一次回显）",
                  status == 200 and device_token.startswith("cyn_") and device_id.startswith("dev_"), body[:160])

            status, body, _ = http("POST", pair_base + "/v1/pair", redeem_body,
                                   headers={"Content-Type": "application/json"})
            data = json.loads(body)
            check("配对码一次性（二次兑换 400 E_PAIR_CODE）",
                  status == 400 and data.get("code") == "E_PAIR_CODE", body[:160])

            ok_dev = http("GET", pair_base + "/v1/sync/fetch?since=0",
                          headers={"Authorization": f"Bearer {device_token}"})[0] == 200
            forged = http("GET", pair_base + "/v1/sync/fetch?since=0",
                          headers={"Authorization": "Bearer cyn_forged"})[0]
            check("device token 可用 / 伪造 token 401", ok_dev and forged == 401,
                  f"ok={ok_dev} forged={forged}")

            status, body, _ = http("POST", pair_base + "/v1/pair/code", headers=master)
            code2 = json.loads(body).get("code", "") if status == 200 else ""
            time.sleep(3)
            status, body, _ = http("POST", pair_base + "/v1/pair",
                                   json.dumps({"code": code2, "deviceName": "迟到"}, ensure_ascii=False),
                                   headers={"Content-Type": "application/json"})
            data = json.loads(body)
            check("配对码过期（TTL 2s）→ 400 E_PAIR_CODE",
                  status == 400 and data.get("code") == "E_PAIR_CODE", body[:160])

            status, body, _ = http("POST", pair_base + f"/v1/devices/{device_id}/rotate",
                                   headers={"Authorization": f"Bearer {device_token}"})
            new_token = json.loads(body).get("token", "") if status == 200 else ""
            old_after = http("GET", pair_base + "/v1/sync/fetch?since=0",
                             headers={"Authorization": f"Bearer {device_token}"})[0]
            new_ok = http("GET", pair_base + "/v1/sync/fetch?since=0",
                          headers={"Authorization": f"Bearer {new_token}"})[0]
            check("轮换即时生效（旧 token 401 / 新 token 200）",
                  status == 200 and old_after == 401 and new_ok == 200,
                  f"rotate={status} old={old_after} new={new_ok}")

            status, body, _ = http("POST", pair_base + f"/v1/devices/{device_id}/revoke",
                                   headers={"Authorization": f"Bearer {new_token}"})
            revoked_after = http("GET", pair_base + "/v1/sync/fetch?since=0",
                                 headers={"Authorization": f"Bearer {new_token}"})[0]
            check("撤销即时生效（撤销后 401）", status == 200 and revoked_after == 401,
                  f"revoke={status} after={revoked_after}")

            status, body, _ = http("GET", pair_base + "/v1/devices", headers=master)
            devices = json.loads(body).get("devices", []) if status == 200 else []
            check("设备列表（含撤销标记）",
                  status == 200 and any(d.get("deviceId") == device_id and d.get("revoked") for d in devices),
                  body[:160])

            # 转发头：只信任回环代理（Caddy 同机）——XFF 生效后该请求视为远程，healthz 需令牌
            # （去掉默认 Authorization：确保 401 来自「远程需令牌」而非 token 不匹配）
            saved_auth = BASE_HEADERS.pop("Authorization", None)
            try:
                local_healthz = http("GET", pair_base + "/healthz")[0]
                fwd_healthz = http("GET", pair_base + "/healthz",
                                   headers={"X-Forwarded-For": "203.0.113.7"})[0]
            finally:
                if saved_auth is not None:
                    BASE_HEADERS["Authorization"] = saved_auth
            check("转发头信任回环代理（本机探针 200 / XFF=远程 → healthz 401）",
                  local_healthz == 200 and fwd_healthz == 401,
                  f"local={local_healthz} fwd={fwd_healthz}")

            # 设备名截断：63×a + emoji（UTF-16 长 65）截到 64 恰落代理对中间，须回退为 63
            status, body, _ = http("POST", pair_base + "/v1/pair/code", headers=master)
            code3 = json.loads(body).get("code", "") if status == 200 else ""
            status, body, _ = http("POST", pair_base + "/v1/pair",
                                   json.dumps({"code": code3, "deviceName": "a" * 63 + "😀"}, ensure_ascii=False),
                                   headers={"Content-Type": "application/json"})
            data = json.loads(body)
            token3 = data.get("token", "")
            check("设备名截断不切断代理对（63a+emoji → 63a）",
                  status == 200 and data.get("name") == "a" * 63,
                  f"status={status} name={data.get('name')!r}")

            # 越权：普通 device token 不得管理他人设备 / 枚举设备清单（403）
            cross_rotate = http("POST", pair_base + f"/v1/devices/{device_id}/rotate",
                                headers={"Authorization": f"Bearer {token3}"})[0]
            cross_revoke = http("POST", pair_base + f"/v1/devices/{device_id}/revoke",
                                headers={"Authorization": f"Bearer {token3}"})[0]
            cross_list = http("GET", pair_base + "/v1/devices",
                              headers={"Authorization": f"Bearer {token3}"})[0]
            check("设备管理越权（他设备 rotate/revoke 403、清单仅 master）",
                  cross_rotate == 403 and cross_revoke == 403 and cross_list == 403,
                  f"rotate={cross_rotate} revoke={cross_revoke} list={cross_list}")

            # healthz 设备计数（O(1) 聚合）：此时 device_id 已撤销，仅剩 63a 设备活跃
            status, body, _ = http("GET", pair_base + "/healthz")
            active_devices = json.loads(body).get("devices") if status == 200 else None
            check("healthz 设备计数（撤销后仅剩活跃设备）", active_devices == 1, f"devices={active_devices}")

            evil = raw_http_probe(pair_port, ["GET /healthz HTTP/1.1", "Host: evil.com", "Connection: close"])
            good = raw_http_probe(pair_port, ["GET /healthz HTTP/1.1", "Host: example.com", "Connection: close"])
            check("Host 白名单（evil.com 421 / example.com 200）",
                  " 421 " in evil.split("\r\n", 1)[0] and " 200 " in good.split("\r\n", 1)[0],
                  f"evil={evil.splitlines()[:1]} good={good.splitlines()[:1]}")

            pair_handle.close()
            with open(pair_log, encoding="utf-8", errors="replace") as handle:
                pair_log_text = handle.read()
            log_ok = (bool(device_token) and device_token not in pair_log_text
                      and bool(code) and code not in pair_log_text
                      and bool(code2) and code2 not in pair_log_text
                      and "pair-master" not in pair_log_text)
            if new_token:
                log_ok = log_ok and new_token not in pair_log_text
            if token3:
                log_ok = log_ok and token3 not in pair_log_text
            if code3:
                log_ok = log_ok and code3 not in pair_log_text
            check("日志脱敏（token/配对码/master 不明文）", log_ok)

            if os.name == "posix":
                import stat as stat_module

                def _mode(path):
                    return stat_module.S_IMODE(os.stat(path).st_mode) if os.path.exists(path) else None

                dir_mode = _mode(pair_dir)
                db_mode = _mode(os.path.join(pair_dir, "events.db"))
                aux_modes = {suf: _mode(os.path.join(pair_dir, "events.db" + suf)) for suf in ("-wal", "-shm")}
                aux_ok = all(mode is None or mode == 0o600 for mode in aux_modes.values())
                check("Linux 凭据权限（目录 0700 / events.db 及 -wal/-shm 0600）",
                      dir_mode == 0o700 and db_mode == 0o600 and aux_ok,
                      f"dir={dir_mode and oct(dir_mode)} db={db_mode and oct(db_mode)} "
                      f"wal={aux_modes['-wal'] and oct(aux_modes['-wal'])} shm={aux_modes['-shm'] and oct(aux_modes['-shm'])}")
        finally:
            if pair_server is not None:
                pair_server.terminate()
                try:
                    pair_server.wait(timeout=10)
                except Exception:
                    pair_server.kill()
            try:
                pair_handle.close()
            except Exception:
                pass
            shutil.rmtree(pair_dir, ignore_errors=True)

        # 12. 配对接口限流（独立实例：2/min/IP → 第 3 次 429）
        rate_dir = tempfile.mkdtemp(prefix="cloud-sync-rate-")
        rate_server = None
        try:
            rate_server, rate_base, _ = start_instance(DLL, env, {
                "CYRENE_CLOUD_DATA": rate_dir,
                "CLOUD_RATE_PAIR_PER_MIN": "2",
            })
            garbage = json.dumps({"code": "ZZZZ-ZZZZ"})
            statuses = [
                http("POST", rate_base + "/v1/pair", garbage,
                     headers={"Content-Type": "application/json"})[0]
                for _ in range(3)
            ]
            check("配对接口限流（2/min → 第 3 次 429）",
                  statuses[:2] == [400, 400] and statuses[2] == 429, f"statuses={statuses}")

            # 转发头参与限流分区：匿名（无 Bearer → 按 IP 分区）先耗尽回环配额，再验证 XFF 真实 IP 独立
            saved_auth = BASE_HEADERS.pop("Authorization", None)
            try:
                anon = [http("POST", rate_base + "/v1/pair", garbage,
                             headers={"Content-Type": "application/json"})[0]
                        for _ in range(3)]
                fwd1 = [http("POST", rate_base + "/v1/pair", garbage,
                             headers={"Content-Type": "application/json", "X-Forwarded-For": "203.0.113.1"})[0]
                        for _ in range(3)]
                fwd2 = http("POST", rate_base + "/v1/pair", garbage,
                            headers={"Content-Type": "application/json", "X-Forwarded-For": "203.0.113.2"})[0]
            finally:
                if saved_auth is not None:
                    BASE_HEADERS["Authorization"] = saved_auth
            check("匿名限流按回环 IP（2/min → 第 3 次 429）", anon == [400, 400, 429], f"anon={anon}")
            check("限流按转发头真实 IP 分区（.1 三连 → 400,400,429；.2 独立 → 400）",
                  fwd1 == [400, 400, 429] and fwd2 == 400, f"fwd1={fwd1} fwd2={fwd2}")
        finally:
            if rate_server is not None:
                rate_server.terminate()
                try:
                    rate_server.wait(timeout=10)
                except Exception:
                    rate_server.kill()
            shutil.rmtree(rate_dir, ignore_errors=True)

        # 13. 服务端文本对话闭环（IKJK2M；独立实例 + 本地 mock LLM）
        llm_server, llm_requests, llm_port = start_mock_llm()
        dlg_dir = tempfile.mkdtemp(prefix="cloud-sync-dialog-")
        dlg_log = os.path.join(dlg_dir, "server-out.log")
        dlg_handle = open(dlg_log, "w", encoding="utf-8", errors="replace")
        dlg_server = None
        try:
            dlg_server, dlg_base, _ = start_instance(DLL, env, {
                "CYRENE_CLOUD_DATA": dlg_dir,
                "CLOUD_TOKEN": "dlg-master",
                "CLOUD_LLM_BASE_URL": f"http://127.0.0.1:{llm_port}/v1",
                "CLOUD_LLM_API_KEY": "sk-test-secret",
                "CLOUD_LLM_MODEL": "mock-model",
                "CLOUD_LLM_SYSTEM_PROMPT": "你是昔涟",
                "CLOUD_LLM_CONTEXT_CHARS": "200",
                "Logging__LogLevel__Default": "Information",
            }, log_handle=dlg_handle)
            dlg = {"Authorization": "Bearer dlg-master"}
            status, body, _ = http("GET", dlg_base + "/v1/capabilities")
            check("能力声明：LLM 实例 generation=realtime",
                  status == 200 and json.loads(body).get("generation") == "realtime", body[:160])

            def fetch_session(session_id):
                status, body, _ = http(
                    "GET", f"{dlg_base}/v1/sync/fetch?since=0&limit=1000&sessionId={session_id}", headers=dlg)
                return json.loads(body).get("events", []) if status == 200 else []

            def wait_for_assistant(session_id, expected_texts, timeout=20):
                deadline = time.time() + timeout
                while time.time() < deadline:
                    events = fetch_session(session_id)
                    texts = [e["payload"].get("text") for e in events
                             if e["type"] == "message.append" and e["payload"].get("role") == "assistant"]
                    if all(text in texts for text in expected_texts):
                        return events
                    time.sleep(0.3)
                return fetch_session(session_id)

            # 13.1 用户消息 → 服务端生成 assistant 事件
            status, body, _ = push(dlg_base, [ev("m-u1", session_id="m1", device="dev-a", lamport=1, seq=1,
                                                 payload={"role": "user", "text": "第一问", "turnId": "t-m1"})],
                                   headers=dlg)
            events = wait_for_assistant("m1", ["服务端回复-1"])
            assistants = [e for e in events
                          if e["type"] == "message.append" and e["payload"].get("role") == "assistant"]
            check("生成闭环：用户消息 → 服务端 assistant 事件（turnId 对齐）",
                  status == 200 and len(assistants) == 1 and assistants[0]["payload"].get("turnId") == "t-m1"
                  and assistants[0]["deviceId"] == "server", str(assistants)[:200])

            # 13.2 重推同一 user 事件（模拟断网重试）→ 不产生二次生成
            status, body, _ = push(dlg_base, [ev("m-u1", session_id="m1", device="dev-a", lamport=1, seq=1,
                                                 payload={"role": "user", "text": "第一问", "turnId": "t-m1"})],
                                   headers=dlg)
            duplicates = json.loads(body).get("duplicates")
            time.sleep(2)
            events = fetch_session("m1")
            assistants = [e for e in events if e["payload"].get("role") == "assistant"]
            check("断网重试不重复：重推 user 事件 → 无二次生成",
                  duplicates == 1 and len(assistants) == 1, f"duplicates={duplicates} assistants={len(assistants)}")

            # 13.3 第二条消息 → 上下文注入历史（u1 → a1 → u2）
            status, body, _ = push(dlg_base, [ev("m-u2", session_id="m1", device="dev-a", lamport=3, seq=2,
                                                 payload={"role": "user", "text": "第二问", "turnId": "t-m2"})],
                                   headers=dlg)
            events = wait_for_assistant("m1", ["服务端回复-2"])
            sent = [(item.get("role"), item.get("content")) for item in llm_requests[-1].get("messages", [])]
            check("重放上下文：system + 历史消息（u1/a1/u2）注入模型请求",
                  sent == [("system", "你是昔涟"), ("user", "第一问"), ("assistant", "服务端回复-1"), ("user", "第二问")],
                  str(sent)[:220])

            # 13.4 编辑（replace_user）→ 裁掉旧分支并以替换文本重生成
            status, body, _ = push(dlg_base, [ev("m-edit", session_id="m1", device="dev-a", lamport=5, seq=3,
                                                 typ="turn_rewind",
                                                 payload={"anchorUserTurnId": "t-m1", "disposition": "replace_user",
                                                          "reason": "edit", "replacementUser": {"text": "改问"},
                                                          "revision": 2})],
                                   headers=dlg)
            events = wait_for_assistant("m1", ["服务端回复-3"])
            sent = [(item.get("role"), item.get("content")) for item in llm_requests[-1].get("messages", [])]
            edited = [e for e in events
                      if e["payload"].get("role") == "assistant" and e["payload"].get("text") == "服务端回复-3"]
            check("turn_rewind 编辑语义：上下文=system+替换后分支，重生成同轮回复",
                  sent == [("system", "你是昔涟"), ("user", "改问")] and edited and edited[0]["payload"].get("turnId") == "t-m1",
                  f"context={str(sent)[:120]} edited={str(edited)[:120]}")

            # 13.5 超预算裁剪：system prompt 不被裁掉（只丢最旧历史、保留最后一条 user）
            long_text = "丁" * 300
            status, body, _ = push(dlg_base, [ev("m-u3", session_id="m1", device="dev-a", lamport=7, seq=4,
                                                 payload={"role": "user", "text": long_text, "turnId": "t-m3"})],
                                   headers=dlg)
            events = wait_for_assistant("m1", ["服务端回复-4"])
            sent = [(item.get("role"), item.get("content")) for item in llm_requests[-1].get("messages", [])]
            check("上下文裁剪保护 system prompt（超预算仅丢最旧历史）",
                  sent == [("system", "你是昔涟"), ("user", long_text)],
                  str([(role, (text or "")[:16]) for role, text in sent])[:220])

            # 13.6 用量日志 + 密钥脱敏
            dlg_handle.close()
            with open(dlg_log, encoding="utf-8", errors="replace") as handle:
                dlg_log_text = handle.read()
            check("生成用量记录（prompt/completion tokens）+ 密钥不落日志",
                  "prompt_tokens=12" in dlg_log_text and "completion_tokens=7" in dlg_log_text
                  and "sk-test-secret" not in dlg_log_text)
        finally:
            if dlg_server is not None:
                dlg_server.terminate()
                try:
                    dlg_server.wait(timeout=10)
                except Exception:
                    dlg_server.kill()
            try:
                dlg_handle.close()
            except Exception:
                pass
            llm_server.shutdown()
            shutil.rmtree(dlg_dir, ignore_errors=True)
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except Exception:
            server.kill()
        log_file.close()
        try:
            with open(log_path, encoding="utf-8", errors="replace") as handle:
                server_log = handle.read()
        except Exception:
            server_log = ""
        if server_log.strip():
            print("--- server log (tail 30) ---")
            print("\n".join(server_log.strip().splitlines()[-30:]))
        shutil.rmtree(data_dir, ignore_errors=True)

    return summarize()


if __name__ == "__main__":
    sys.exit(main())
