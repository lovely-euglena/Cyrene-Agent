#!/usr/bin/env python3
"""cloud-server 同步收敛冒烟（IKJK2J 验收）：真实起服务 + 两客户端并发 push/fetch。

覆盖：
  1. /healthz 就绪 + RSS 观测（D5 预算证据）；
  2. push 幂等（重复批：duplicates、不重复入库）；
  3. 乱序批 + 分页游标（limit 步进，不重不漏；服务端按协议 v0 规范序入库）；
  4. 两客户端并发 push → 双方全量 fetch 后按 (lamport, deviceId, seq) 收敛一致；
  5. 链校验 E_SYNC_CHAIN / E_SYNC_SEQ（整批回滚，失败批不入库）；
  6. clone 全量 JSONL + X-Sync-Cursor 与 fetch 游标一致；
  7. 畸形批 → 400 E_SYNC_BATCH_INVALID；
  8. 请求体上限（Content-Length 快检 + chunked 触顶均 → 413 E_SYNC_BATCH_TOO_LARGE，不落库）；
  9. fetch?sessionId= 会话过滤；
  10. 链过渡混用（同设备 未上链/已上链）；
  11. CLOUD_TOKEN 门闩（独立实例 401/200）。

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
    for key, value in (headers or {}).items():
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


def chunked_oversized_push_probe(port, total=11 * 1024 * 1024, chunk_size=64 * 1024):
    """裸 socket：chunked（无 Content-Length）超限——验证读取触顶时回 413（而非 500）。"""
    with socket.create_connection(("127.0.0.1", port), timeout=15) as sock:
        head = (
            "POST /v1/sync/push HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
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


def oversized_push_probe(port, content_length=11 * 1024 * 1024):
    """裸 socket：只发请求头（超大 Content-Length）、不发 body——验证服务端在读取前就拒绝。"""
    with socket.create_connection(("127.0.0.1", port), timeout=10) as sock:
        head = (
            "POST /v1/sync/push HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
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
    port = free_port()
    data_dir = tempfile.mkdtemp(prefix="cloud-sync-")
    env = dict(os.environ)
    env["CYRENE_CLOUD_DATA"] = data_dir
    env["Logging__LogLevel__Default"] = "Warning"
    dotnet_home = os.path.expanduser("~/.dotnet")
    if os.path.isdir(dotnet_home):
        env["DOTNET_ROOT"] = dotnet_home
        env["PATH"] = dotnet_home + os.pathsep + env.get("PATH", "")
    base = f"http://127.0.0.1:{port}"
    log_path = os.path.join(data_dir, "server-out.log")
    log_file = open(log_path, "w", encoding="utf-8", errors="replace")
    server = subprocess.Popen(
        ["dotnet", DLL, "--urls", base],
        env=env, stdout=log_file, stderr=subprocess.STDOUT,
    )
    try:
        ready, health = False, {}
        for _ in range(80):
            try:
                status, body, _ = http("GET", base + "/healthz", timeout=3)
                if status == 200:
                    health = json.loads(body)
                    ready = True
                    break
            except Exception:
                pass
            time.sleep(0.5)
        if not ready:
            print("[FAIL] 服务未就绪（服务日志见下方）")
            return 1
        check("healthz 就绪 + RSS 观测", isinstance(health.get("rssMB"), (int, float)), json.dumps(health)[:120])
        print(f"  healthz: events={health.get('events')} rssMB={health.get('rssMB')}")
        check("RSS 预算（基准 <300MB；空载 ≤150MB 以 Linux 容器复测）",
              health.get("rssMB", 999) < 300, f"rssMB={health.get('rssMB')}")

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
        check("分页游标不重不漏（limit=2 步进）",
              len(events) == 6 and len({item["eventId"] for item in events}) == 6, f"n={len(events)}")
        check("首批插入序 a1,a2,a3",
              [item["eventId"] for item in events[:3]] == ["a1", "a2", "a3"],
              str([item["eventId"] for item in events])[:120])

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

        # 5. 畸形批
        status, body, _ = push(base, [ev("ok1"), "这不是 JSON", ev("ok2")])
        data = json.loads(body)
        check("畸形批 → 400 E_SYNC_BATCH_INVALID",
              status == 400 and data.get("code") == "E_SYNC_BATCH_INVALID", body[:160])

        # 6. 请求体上限（>10MB → 413，不落库；裸 socket 只发头不发体，验证读取前即拒绝）
        response = oversized_push_probe(port)
        first_line = response.split("\r\n", 1)[0]
        check("请求体上限（Content-Length >10MB → 413 E_SYNC_BATCH_TOO_LARGE）",
              " 413 " in first_line and "E_SYNC_BATCH_TOO_LARGE" in response,
              response[:200].replace("\r\n", " "))
        response = chunked_oversized_push_probe(port)
        first_line = response.split("\r\n", 1)[0]
        check("chunked 超限（无 Content-Length）→ 413 E_SYNC_BATCH_TOO_LARGE",
              " 413 " in first_line and "E_SYNC_BATCH_TOO_LARGE" in response,
              response[:200].replace("\r\n", " "))

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
        token_port = free_port()
        token_dir = tempfile.mkdtemp(prefix="cloud-sync-token-")
        token_env = dict(env)
        token_env["CYRENE_CLOUD_DATA"] = token_dir
        token_env["CLOUD_TOKEN"] = "s3cret"
        token_server = subprocess.Popen(
            ["dotnet", DLL, "--urls", f"http://127.0.0.1:{token_port}"],
            env=token_env, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
        )
        try:
            token_base = f"http://127.0.0.1:{token_port}"
            token_ready = False
            for _ in range(80):
                try:
                    status, _, _ = http("GET", token_base + "/healthz", timeout=3)
                    if status == 200:
                        token_ready = True
                        break
                except Exception:
                    pass
                time.sleep(0.5)
            no_token = http("GET", token_base + "/v1/sync/fetch?since=0")[0]
            wrong_token = http("GET", token_base + "/v1/sync/fetch?since=0",
                               headers={"Authorization": "Bearer nope"})[0]
            ok_token = http("GET", token_base + "/v1/sync/fetch?since=0",
                            headers={"Authorization": "Bearer s3cret"})[0]
            check("CLOUD_TOKEN 门闩（无/错 token 401，正确 200）",
                  token_ready and no_token == 401 and wrong_token == 401 and ok_token == 200,
                  f"ready={token_ready} no={no_token} wrong={wrong_token} ok={ok_token}")
        finally:
            token_server.terminate()
            try:
                token_server.wait(timeout=10)
            except Exception:
                token_server.kill()
            shutil.rmtree(token_dir, ignore_errors=True)
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
