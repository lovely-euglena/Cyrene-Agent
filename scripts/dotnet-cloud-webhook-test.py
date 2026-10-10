#!/usr/bin/env python3
"""cloud-server webhook 入站冒烟（IKKIZR 批次 1 验收）：真实起服务 + HMAC 签名投递 + 失败路径。

覆盖：
  1. capabilities.webhooks 声明（endpointId 列表，不含密钥）；
  2. 合法签名投递 → 200 accepted，事件入流（deviceId=server，sessionId=webhook-{id}）；
  3. 幂等：同 body 重发 → duplicate=true，不重复入库；
  4. 坏签名 / 缺签名头 / 过期时间戳 → 401 E_WEBHOOK_SIGNATURE_INVALID；
  5. 未知 endpointId → 404 E_WEBHOOK_ENDPOINT_NOT_FOUND；
  6. 超限 body（> CLOUD_WEBHOOK_BODY_MAX_BYTES）→ 413 E_WEBHOOK_BODY_TOO_LARGE；
  7. fetch（主控令牌）读回 webhook.received 事件：payload 形状（endpointId/source/body/
     receivedAt/truncated=false）、eventId 内容寻址（wh-{sha256(body)[..32]}）；
  8. source 缺省端点：payload 不含 source 键（省键，非 null）；
  9. 限流复用 sync 桶（低阈值实例连续投递 → 429 E_RATE_LIMITED）。

运行：
  python scripts/dotnet-cloud-webhook-test.py [发布产物 dll 路径]   # 起真实实例，全量检查
  python scripts/dotnet-cloud-webhook-test.py --base-url URL        # 远端核心档（跳过需要
                                                                    # 环境注入的 413/限流用例）
"""

import hashlib
import hmac
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DLL = os.path.join(REPO_ROOT, "dotnet/cloud-server/bin/Release/net10.0/cyrene-cloud-server.dll")

MASTER_TOKEN = "webhook-smoke-master"
SECRET = "whsec-0123456789abcdef"  # ≥16 字符
TOLERANCE = 300

passed = []
failed = []


def check(name, ok, detail=""):
    (passed if ok else failed).append(name)
    print(("[PASS] " if ok else "[FAIL] ") + name + (f"  {detail}" if detail and not ok else ""))


def http(method, url, body=None, headers=None, timeout=10):
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method)
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return 0, str(e)


def sign(secret: str, timestamp: str, body: bytes) -> str:
    mac = hmac.new(secret.encode(), f"{timestamp}.".encode() + body, hashlib.sha256)
    return "v1=" + mac.hexdigest()


def deliver(base, endpoint_id, body: bytes, secret=SECRET, timestamp=None, signature=None,
            send_timestamp=True, send_signature=True):
    ts = timestamp if timestamp is not None else str(int(time.time()))
    headers = {"Content-Type": "application/json"}
    if send_timestamp:
        headers["X-Webhook-Timestamp"] = ts
    if send_signature:
        headers["X-Webhook-Signature"] = signature if signature is not None else sign(secret, ts, body)
    return http("POST", f"{base}/v1/webhook/{endpoint_id}", body=body, headers=headers)


def free_port():
    import socket
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_ready(base, timeout=40):
    for _ in range(int(timeout / 0.5)):
        try:
            if http("GET", base + "/healthz", timeout=3)[0] == 200:
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def start_instance(dll, extra_env):
    env = dict(os.environ)
    env.update(extra_env)
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    server = subprocess.Popen(
        ["dotnet", dll, "--urls", base],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    if wait_ready(base):
        return server, base
    server.terminate()
    try:
        server.wait(timeout=10)
    except Exception:
        server.kill()
    raise RuntimeError("服务启动失败")


def stop(server):
    if server is None:
        return
    server.terminate()
    try:
        server.wait(timeout=10)
    except Exception:
        server.kill()


def main():
    args = [item for item in sys.argv[1:] if not item.startswith("--")]
    dll = args[0] if args else DEFAULT_DLL
    remote_base = None
    for item in sys.argv[1:]:
        if item.startswith("--base-url="):
            remote_base = item.split("=", 1)[1].rstrip("/")
    is_local = remote_base is None

    body_a = json.dumps({"build": "ok", "pipeline": "ci-42"}).encode()

    # ── 实例 1：两个 endpoint（ci 带 source；alerts 缺省 source）+ 低限流阈值用独立实例 ──
    endpoints = [
        {"id": "ci", "secret": SECRET, "source": "github-actions"},
        {"id": "alerts", "secret": "whsec-fedcba9876543210"},
    ]
    server, base = None, None
    data_dir = tempfile.mkdtemp(prefix="cloud-webhook-")
    try:
        if is_local:
            server, base = start_instance(dll, {
                "CYRENE_CLOUD_DATA": data_dir,
                "CLOUD_TOKEN": MASTER_TOKEN,
                "CLOUD_LLM_MODE": "echo",
                "CLOUD_WEBHOOK_ENDPOINTS": json.dumps(endpoints),
                "CLOUD_RATE_SYNC_PER_MIN": "1000",
            })
        else:
            base = remote_base
            check("远端模式：跳过环境注入类用例（413/限流）", True)

        # 1. capabilities 声明
        status, body = http("GET", base + "/v1/capabilities")
        caps = json.loads(body) if status == 200 else {}
        if is_local:
            check("capabilities.webhooks 声明 endpointId 列表",
                  status == 200 and caps.get("webhooks") == ["ci", "alerts"], body[:120])
        else:
            check("capabilities 可读（远端 webhooks 含目标 endpoint）",
                  status == 200 and isinstance(caps.get("webhooks"), list), body[:120])

        # 2. 合法投递 → 200
        status, body = deliver(base, "ci", body_a)
        payload = json.loads(body) if status == 200 else {}
        event_id = payload.get("eventId", "")
        check("合法签名投递 200 accepted", status == 200 and payload.get("accepted") == 1
              and event_id.startswith("wh-"), f"status={status} body={body[:120]}")

        # 3. 幂等：同 body 重发 → duplicate
        status, body = deliver(base, "ci", body_a)
        payload = json.loads(body) if status == 200 else {}
        check("同 body 重发 duplicate（eventId 内容寻址幂等）",
              status == 200 and payload.get("duplicate") is True and payload.get("eventId") == event_id,
              f"status={status} body={body[:120]}")

        # 4. 失败路径
        status, body = deliver(base, "ci", b'{"x":1}', signature="v1=" + "0" * 64)
        check("坏签名 401", status == 401 and "E_WEBHOOK_SIGNATURE_INVALID" in body,
              f"status={status} body={body[:120]}")
        status, body = deliver(base, "ci", b'{"x":1}', send_signature=False)
        check("缺签名头 401", status == 401 and "E_WEBHOOK_SIGNATURE_INVALID" in body,
              f"status={status} body={body[:120]}")
        stale = str(int(time.time()) - TOLERANCE - 60)
        status, body = deliver(base, "ci", b'{"x":1}', timestamp=stale)
        check("过期时间戳 401（防重放）", status == 401 and "E_WEBHOOK_SIGNATURE_INVALID" in body,
              f"status={status} body={body[:120]}")

        # 5. 未知 endpoint
        status, body = deliver(base, "nope", b'{"x":1}')
        check("未知 endpointId 404", status == 404 and "E_WEBHOOK_ENDPOINT_NOT_FOUND" in body,
              f"status={status} body={body[:120]}")

        # 7. fetch 读回：payload 形状 + source 透传
        status, body = http("GET", base + "/v1/sync/fetch?since=0",
                            headers={"Authorization": f"Bearer {MASTER_TOKEN}"})
        events = []
        if status == 200:
            data = json.loads(body)
            events = [item for item in data.get("events", [])
                      if isinstance(item, dict) and item.get("type") == "webhook.received"]
        wh_ci = next((item for item in events if item.get("eventId") == event_id), None)
        pl = (wh_ci or {}).get("payload", {})
        expect_event_id = "wh-" + hashlib.sha256(body_a).hexdigest()[:32]
        check("fetch 读回 webhook.received（payload 形状 + source 透传 + eventId 内容寻址）",
              wh_ci is not None
              and wh_ci.get("sessionId") == "webhook-ci"
              and wh_ci.get("deviceId") == "server"
              and pl.get("endpointId") == "ci"
              and pl.get("source") == "github-actions"
              and pl.get("body") == body_a.decode()
              and pl.get("truncated") is False
              and wh_ci.get("eventId") == expect_event_id,
              f"event={json.dumps(wh_ci, ensure_ascii=False)[:200]}")

        # 8. source 缺省端点：payload 无 source 键（alerts 端点独立密钥）
        status, body = deliver(base, "alerts", b'{"alert":"disk"}',
                               secret="whsec-fedcba9876543210")
        alert_id = json.loads(body).get("eventId", "") if status == 200 else ""
        wh_alert = next((item for item in events if item.get("eventId") == alert_id), None)
        if wh_alert is None:
            # fetch 一次拿全（上面读回的是投递 ci 之后的快照；alerts 事件在其后投递，需重拉）
            status, body = http("GET", base + "/v1/sync/fetch?since=0",
                                headers={"Authorization": f"Bearer {MASTER_TOKEN}"})
            fetched = json.loads(body).get("events", [])
            events = [item for item in fetched if item.get("type") == "webhook.received"]
            wh_alert = next((item for item in events if item.get("eventId") == alert_id), None)
        pl = (wh_alert or {}).get("payload", {})
        check("source 缺省端点 payload 省键（非 null）",
              wh_alert is not None and "source" not in pl and pl.get("endpointId") == "alerts",
              f"payload={json.dumps(pl, ensure_ascii=False)[:160]}")

        # ── 本地专属：413 超限 + 限流（需环境注入）──
        if is_local:
            status, resp = deliver(base, "ci", b'{"big":"' + b"a" * (256 * 1024) + b'"}')
            check("超限 body 413", status == 413 and "E_WEBHOOK_BODY_TOO_LARGE" in resp,
                  f"status={status} body={resp[:120]}")

            rate_dir = tempfile.mkdtemp(prefix="cloud-webhook-rate-")
            rate_server = None
            try:
                rate_server, rate_base = start_instance(dll, {
                    "CYRENE_CLOUD_DATA": rate_dir,
                    "CLOUD_TOKEN": MASTER_TOKEN,
                    "CLOUD_WEBHOOK_ENDPOINTS": json.dumps(endpoints),
                    "CLOUD_RATE_SYNC_PER_MIN": "3",
                })
                codes = [deliver(rate_base, "ci", b'{"n":%d}' % n)[0] for n in range(6)]
                check("限流复用 sync 桶（429 E_RATE_LIMITED）",
                      codes[:3] == [200, 200, 200] and 429 in codes[3:],
                      f"codes={codes}")
            finally:
                stop(rate_server)
                shutil.rmtree(rate_dir, ignore_errors=True)
    finally:
        stop(server)
        shutil.rmtree(data_dir, ignore_errors=True)

    print(f"\nwebhook 套件：{len(passed)} 通过 / {len(failed)} 失败")
    if failed:
        print("失败项：", "；".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
