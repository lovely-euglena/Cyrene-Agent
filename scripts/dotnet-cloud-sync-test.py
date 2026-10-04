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
  18. 配对接口限流（超限 → 429；按转发头真实 IP 分区）。

运行：dotnet build/publish 后 python scripts/dotnet-cloud-sync-test.py [发布产物 dll 路径]
"""
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
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 可选参数：发布产物 dll 路径（裸跑直测）；默认用 Release 构建输出
DLL = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(
    REPO_ROOT, "dotnet/cloud-server/bin/Release/net10.0/cyrene-cloud-server.dll")
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


def push(base, lines):
    return http("POST", base + "/v1/sync/push", "\n".join(lines))


def chunked_oversized_push_probe(port, total=11 * 1024 * 1024, chunk_size=8 * 1024):
    """裸 socket：chunked（无 Content-Length）超限——验证读取触顶时回 413（而非 500）。

    Windows 上服务端拒绝后关闭连接可能发 RST、丢掉已回写的 413（已知抖动，服务端每次正确）；
    用小 chunk 降低「超限后在途字节数」，客户端侧再由调用方重试兜底。
    """
    with socket.create_connection(("127.0.0.1", port), timeout=15) as sock:
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
                    break  # 服务端已开始回包，停止发送
                sock.sendall(f"{chunk_size:x}\r\n".encode("ascii") + payload + b"\r\n")
                sent += chunk_size
            try:
                sock.sendall(b"0\r\n\r\n")
            except OSError:
                pass
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


def main():
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

    passed = sum(1 for _, ok, _ in results if ok)
    failed = len(results) - passed
    print(f"\n{'='*50}\ncloud-server 同步冒烟汇总: {passed} passed / {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
