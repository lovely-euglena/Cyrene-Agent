#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""cyrene-cloud-server 渠道 mock e2e 冒烟（阶段 8 / 收口轨 G；设计 §8.2/§8.4）。

真实启动 cyrene-cloud-server（`CLOUD_CHANNELS=wechat,feishu,qqbot` + mock LLM），
用本机 mock 上游驱动三渠道全链路，并验证归属控制面与主动消息：

  微信  mock iLink HTTP：get_bot_qrcode/get_qrcode_status 扫码登录 → getupdates 长轮询
        （文本 / 图片 / 断线 500 退避重连 / ret=-14 会话过期）→ sendmessage 断言；
        CDN download 图片（`CLOUD_CHANNEL_WECHAT_CDN_BASE_URL` 注入）。
  飞书  真实 HTTP webhook 打到服务：challenge 明文/密文回显、加密事件（复用
        `fixtures/channels/feishu-webhook/` 密文 + 现算签名与新鲜时间戳）、重投去重、
        坏签名 401；REST 发送/媒体下载打到 mock（`CLOUD_CHANNEL_FEISHU_BASE_URL`）。
  QQ    mock REST（token / gateway / 被动回复）+ mock 网关 WebSocket（Hello/Identify/
        READY/C2C dispatch）：断言被动回复 msg_id/msg_seq 与 `Authorization: QQBot <token>`。
  归属  claim/heartbeat/release（配对 device token）+ owner=desktop 门闩/409 + proactive
        幂等投递（Bearer）。

上游注入点（本轨新增，缺省官方端点 = 生产零变化）：
  `CLOUD_CHANNEL_WECHAT_CDN_BASE_URL` / `CLOUD_CHANNEL_QQBOT_API_BASE` / `CLOUD_CHANNEL_QQBOT_TOKEN_URL`。
飞书密文事件复用仓库 fixtures（不在冒烟脚本内实现 AES；签名 sha256 现算，时间戳新鲜）。
出站图片与 SILK 语音不在本冒烟覆盖（C# `channel-selftest wechat` 覆盖；设计 §1.3 分期）。

运行：
  python scripts/channel-smoke-test.py [cyrene-cloud-server.dll]
退出码：0 = 全过；1 = 存在 FAIL；2 = 启动/环境错误。
"""
import argparse
import base64
import hashlib
import http.server as http_server
import json
import os
import re
import socket
import struct
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
DEFAULT_DLL = os.path.join(REPO_ROOT, "dotnet/cloud-server/bin/Release/net10.0/cyrene-cloud-server.dll")

MASTER_TOKEN = "smoke-master"
FEISHU_VERIFICATION_TOKEN = "cyrene-test-token"
FEISHU_ENCRYPT_KEY = "cyrene-test-encrypt-key"

BASE = ""  # 服务端 base URL（main 覆盖）
results = []

# 1x1 透明 PNG（图片链路字节往返用）
PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


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
        request.add_header("Content-Type", "application/json; charset=utf-8")
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8", "replace"), dict(response.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace"), dict(exc.headers)


def api(method, path, body=None, token=MASTER_TOKEN, timeout=30):
    """服务端 /v1/* 调用（默认主控 Bearer；token=None 时不带鉴权）。"""
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    if body is not None and not isinstance(body, (str, bytes)):
        body = json.dumps(body, ensure_ascii=False)
    return http(method, BASE + path, body, timeout=timeout, headers=headers)


def api_json(method, path, body=None, token=MASTER_TOKEN, timeout=30):
    status, text, _ = api(method, path, body, token, timeout)
    try:
        return status, json.loads(text)
    except json.JSONDecodeError:
        return status, {"_raw": text[:300]}


def wait_until(fn, timeout=30.0, interval=0.25):
    """轮询直到 fn 返回真值；返回该真值或 None（超时）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            value = fn()
        except Exception:
            value = None
        if value:
            return value
        time.sleep(interval)
    return None


def fetch_events(limit=1000):
    status, text, _ = api("GET", f"/v1/sync/fetch?since=0&limit={limit}")
    if status != 200:
        return []
    return json.loads(text).get("events", [])


def events_for(events, channel):
    return [item for item in events if item.get("sessionId", "").startswith(f"channel:{channel}:")]


def user_contents(events):
    contents = []
    for item in events:
        payload = item.get("payload") or {}
        if payload.get("role") != "user":
            continue
        patch = ((payload.get("presentation") or {}).get("patch")) or {}
        contents.append(patch.get("content", ""))
    return contents


def assistant_contents(events):
    contents = []
    for item in events:
        payload = item.get("payload") or {}
        if payload.get("role") != "assistant":
            continue
        patch = ((payload.get("presentation") or {}).get("patch")) or {}
        contents.append(patch.get("content", ""))
    return contents


def channel_of(event):
    payload = event.get("payload") or {}
    patch = ((payload.get("presentation") or {}).get("patch")) or {}
    return (patch.get("channelSource") or {}).get("channel")


# ─────────────────────────────────────────────────────────────────────────────
# mock 上游（单个 HTTP 服务按路径路由 + 独立 WS 网关）
# ─────────────────────────────────────────────────────────────────────────────


class MockState:
    def __init__(self):
        self.lock = threading.Lock()
        # 微信 iLink
        self.ilink_queue = []            # 待投递 getupdates 消息
        self.ilink_buf = 0
        self.ilink_getupdates_calls = 0
        self.ilink_failures = 0          # 接下来 N 次 getupdates → 500
        self.ilink_expired = False       # getupdates → ret=-14
        self.ilink_sends = []            # sendmessage 请求体
        self.ilink_send_headers = []
        self.ilink_getuploads = []       # getuploadurl 请求体
        self.ilink_auth = set()          # (Authorization, X-WECHAT-UIN)
        self.ilink_qr_calls = 0
        self.ilink_qr_status_calls = 0
        self.cdn_downloads = []          # encrypted_query_param
        self.cdn_uploads = []            # filekey
        # 飞书
        self.feishu_token_calls = 0
        self.feishu_messages = []        # (query, body dict)
        self.feishu_resource_calls = []  # (message_id, file_key)
        # QQ
        self.qq_token_calls = 0
        self.qq_gateway_calls = 0
        self.qq_messages = []            # {path, body, authorization}
        # LLM
        self.llm_requests = []


def start_mock_upstreams(state, ws_port):
    """mock LLM + iLink + CDN + 飞书 REST + QQ REST 合一的 HTTP 服务。"""

    class QuietHttpServer(http_server.ThreadingHTTPServer):
        daemon_threads = True

        def handle_error(self, request, client_address):
            # 客户端（keep-alive 连接）正常断开不打印 traceback
            pass

    class Handler(http_server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        # ── 基础 ──
        def log_message(self, *args):  # 静默
            pass

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
            return self.rfile.read(length) if length else b""

        def _json(self, status, payload, extra_headers=None):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            for key, value in (extra_headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(body)

        def _bytes(self, status, payload, content_type="application/octet-stream"):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        # ── 路由 ──
        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            path, query = parsed.path, urllib.parse.parse_qs(parsed.query)
            try:
                if path == "/ilink/bot/get_bot_qrcode":
                    with state.lock:
                        state.ilink_qr_calls += 1
                    self._json(200, {
                        "qrcode": "qr-ticket-smoke",
                        "qrcode_img_content": "https://liteapp.weixin.qq.com/x/smoke-login",
                    })
                elif path == "/ilink/bot/get_qrcode_status":
                    with state.lock:
                        state.ilink_qr_status_calls += 1
                        first = state.ilink_qr_status_calls == 1
                    if first:
                        self._json(200, {"status": "pending"})
                    else:
                        self._json(200, {
                            "status": "confirmed",
                            "bot_token": "bot-token-smoke",
                            "ilink_bot_id": "bot-smoke-1",
                            "baseurl": f"http://127.0.0.1:{self.server.server_address[1]}",
                            "ilink_user_id": "wx-user-1",
                        })
                elif path == "/c2c/download":
                    param = (query.get("encrypted_query_param") or [""])[0]
                    with state.lock:
                        state.cdn_downloads.append(param)
                    self._bytes(200, PNG_1PX, "image/png")
                elif path == "/gateway":
                    with state.lock:
                        state.qq_gateway_calls += 1
                    self._json(200, {"url": f"ws://127.0.0.1:{ws_port}/"})
                elif path.startswith("/open-apis/im/v1/messages/") and "/resources/" in path:
                    match = re.match(r"^/open-apis/im/v1/messages/([^/]+)/resources/([^/]+)$", path)
                    message_id = urllib.parse.unquote(match.group(1)) if match else ""
                    file_key = urllib.parse.unquote(match.group(2)) if match else ""
                    with state.lock:
                        state.feishu_resource_calls.append((message_id, file_key))
                    self._bytes(200, PNG_1PX, "image/png")
                else:
                    self._json(404, {"error": f"no mock route: GET {path}"})
            except Exception as exc:  # noqa: BLE001 - mock 兜底
                self._json(500, {"error": str(exc)})

        def do_POST(self):
            parsed = urllib.parse.urlparse(self.path)
            path, query = parsed.path, urllib.parse.parse_qs(parsed.query)
            raw = self._read_body()
            try:
                if path == "/v1/chat/completions":
                    payload = json.loads(raw.decode("utf-8"))
                    with state.lock:
                        state.llm_requests.append(payload)
                        reply = f"渠道回复-{len(state.llm_requests)}"
                    self._json(200, {
                        "choices": [{"message": {"role": "assistant", "content": reply}}],
                        "usage": {"prompt_tokens": 12, "completion_tokens": 7},
                    })
                elif path == "/ilink/bot/getupdates":
                    self._handle_getupdates(raw)
                elif path == "/ilink/bot/sendmessage":
                    payload = json.loads(raw.decode("utf-8"))
                    with state.lock:
                        state.ilink_sends.append(payload)
                        state.ilink_send_headers.append({
                            "Authorization": self.headers.get("Authorization"),
                            "AuthorizationType": self.headers.get("AuthorizationType"),
                        })
                    self._json(200, {"ret": 0})
                elif path == "/ilink/bot/getuploadurl":
                    payload = json.loads(raw.decode("utf-8"))
                    with state.lock:
                        state.ilink_getuploads.append(payload)
                    self._json(200, {"upload_param": "up-param-smoke"})
                elif path == "/c2c/upload":
                    filekey = (query.get("filekey") or [""])[0]
                    with state.lock:
                        state.cdn_uploads.append({"filekey": filekey, "size": len(raw)})
                    self._json(200, {"ok": True}, extra_headers={"x-encrypted-param": "enc-upload-smoke"})
                elif path == "/open-apis/auth/v3/tenant_access_token/internal":
                    with state.lock:
                        state.feishu_token_calls += 1
                    self._json(200, {"code": 0, "tenant_access_token": "fs-tok-smoke", "expire": 7200})
                elif path == "/open-apis/im/v1/messages":
                    payload = json.loads(raw.decode("utf-8"))
                    with state.lock:
                        state.feishu_messages.append((query.get("receive_id_type", [""])[0], payload))
                    self._json(200, {"code": 0, "data": {"message_id": "om_out_smoke"}})
                elif path == "/app/getAppAccessToken":
                    payload = json.loads(raw.decode("utf-8"))
                    with state.lock:
                        state.qq_token_calls += 1
                    self._json(200, {"access_token": "qq-tok-smoke", "expires_in": 7200,
                                     "app_id": payload.get("appId")})
                elif re.match(r"^/v2/(users|groups)/[^/]+/messages$", path):
                    payload = json.loads(raw.decode("utf-8"))
                    with state.lock:
                        state.qq_messages.append({
                            "path": path,
                            "body": payload,
                            "authorization": self.headers.get("Authorization"),
                        })
                    self._json(200, {"code": 0})
                else:
                    self._json(404, {"error": f"no mock route: POST {path}"})
            except Exception as exc:  # noqa: BLE001 - mock 兜底
                self._json(500, {"error": str(exc)})

        def _handle_getupdates(self, raw):
            with state.lock:
                state.ilink_getupdates_calls += 1
                state.ilink_auth.add((
                    self.headers.get("Authorization"),
                    self.headers.get("X-WECHAT-UIN"),
                ))
                expired = state.ilink_expired
                failures = state.ilink_failures
                if failures > 0:
                    state.ilink_failures -= 1
            if expired:
                self._json(200, {"ret": -14, "errmsg": "mock session expired"})
                return
            if failures > 0:
                self._json(500, {"errmsg": "mock transient failure"})
                return
            # 长轮询语义：空队列最多挂 3s（客户端 40s 超时内），有新消息立即返回
            msgs, buf, deadline = [], "", time.time() + 3.0
            while time.time() < deadline:
                with state.lock:
                    if state.ilink_queue:
                        msgs = state.ilink_queue
                        state.ilink_queue = []
                        state.ilink_buf += 1
                        buf = f"buf-{state.ilink_buf}"
                        break
                time.sleep(0.1)
            if not buf:
                with state.lock:
                    buf = f"buf-{state.ilink_buf}"
            self._json(200, {"msgs": msgs, "get_updates_buf": buf})

    server = QuietHttpServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


class QqMockGateway(threading.Thread):
    """QQ 官方网关最小 mock：握手 + op10 Hello + Identify → READY + C2C dispatch + op11 心跳 ACK。"""

    def __init__(self, state, openid="OPENUSER-SMOKE-1", message_id="QQMSG-SMOKE-1", text="你好"):
        super().__init__(daemon=True)
        self.state = state
        self.openid = openid
        self.message_id = message_id
        self.text = text
        self.sock = socket.socket()
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(4)
        self.port = self.sock.getsockname()[1]
        self.identify_seen = threading.Event()

    def run(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    def stop(self):
        try:
            self.sock.close()
        except OSError:
            pass

    # ── WS 帧 ──
    @staticmethod
    def _recv_exact(conn, size):
        data = b""
        while len(data) < size:
            chunk = conn.recv(size - len(data))
            if not chunk:
                raise ConnectionError("peer closed")
            data += chunk
        return data

    def _read_frame(self, conn):
        """返回 (opcode, payload)；FIN 分片自动拼接。"""
        opcode, payload = None, b""
        while True:
            head = self._recv_exact(conn, 2)
            fin = bool(head[0] & 0x80)
            current = head[0] & 0x0F
            masked = bool(head[1] & 0x80)
            length = head[1] & 0x7F
            if length == 126:
                length = struct.unpack(">H", self._recv_exact(conn, 2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._recv_exact(conn, 8))[0]
            mask = self._recv_exact(conn, 4) if masked else b""
            chunk = self._recv_exact(conn, length) if length else b""
            if masked:
                chunk = bytes(byte ^ mask[index % 4] for index, byte in enumerate(chunk))
            if opcode is None:
                opcode = current
            payload += chunk
            if fin:
                return opcode, payload

    @staticmethod
    def _send_frame(conn, opcode, payload=b""):
        header = bytes([0x80 | opcode])
        size = len(payload)
        if size < 126:
            header += bytes([size])
        elif size < 65536:
            header += bytes([126]) + struct.pack(">H", size)
        else:
            header += bytes([127]) + struct.pack(">Q", size)
        conn.sendall(header + payload)

    def _send_text(self, conn, text):
        self._send_frame(conn, 0x1, text.encode("utf-8"))

    def _serve(self, conn):
        try:
            self._handshake(conn)
            self._send_text(conn, json.dumps({"op": 10, "d": {"heartbeat_interval": 30000}}))
            while True:
                opcode, payload = self._read_frame(conn)
                if opcode == 0x8:  # close
                    self._send_frame(conn, 0x8, payload[:2])
                    break
                if opcode == 0x9:  # ping → pong
                    self._send_frame(conn, 0xA, payload)
                    continue
                if opcode != 0x1:
                    continue
                message = json.loads(payload.decode("utf-8"))
                if message.get("op") == 2:
                    self.identify_seen.set()
                    self._send_text(conn, json.dumps({
                        "op": 0, "s": 1, "t": "READY",
                        "d": {"session_id": "sess-smoke-1", "user": {"username": "冒烟bot"}},
                    }))
                    self._send_text(conn, json.dumps({
                        "op": 0, "s": 2, "t": "C2C_MESSAGE_CREATE",
                        "d": {
                            "id": self.message_id,
                            "author": {"user_openid": self.openid, "username": "小昔"},
                            "content": self.text,
                            "timestamp": "2026-10-05T12:00:00+08:00",
                        },
                    }))
                elif message.get("op") == 1:
                    self._send_text(conn, json.dumps({"op": 11, "d": None}))
        except Exception:  # noqa: BLE001 - mock 连接异常直接结束
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def _handshake(self, conn):
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = conn.recv(4096)
            if not chunk:
                raise ConnectionError("handshake closed")
            data += chunk
        headers = {}
        for line in data.decode("latin-1").split("\r\n")[1:]:
            if ":" in line:
                key, value = line.split(":", 1)
                headers[key.strip().lower()] = value.strip()
        key = headers.get("sec-websocket-key", "")
        accept = base64.b64encode(hashlib.sha1(
            (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()).decode("ascii")
        conn.sendall((
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
        ).encode("ascii"))


# ─────────────────────────────────────────────────────────────────────────────
# 服务端实例
# ─────────────────────────────────────────────────────────────────────────────


def wait_ready(base, timeout=40):
    for _ in range(int(timeout / 0.5)):
        try:
            if http("GET", base + "/healthz", timeout=3)[0] == 200:
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def start_instance(dll, data_dir, extra_env, log_path):
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    env = dict(os.environ)
    env.update({
        "CYRENE_CLOUD_DATA": data_dir,
        "CLOUD_TOKEN": MASTER_TOKEN,
        "CLOUD_LLM_API_KEY": "smoke-key",
        "CLOUD_LLM_MODEL": "mock-model",
        "CLOUD_LLM_BASE_URL": extra_env.get("CLOUD_LLM_BASE_URL"),
    })
    env.update(extra_env)
    log_handle = open(log_path, "w", encoding="utf-8", errors="replace")
    server = subprocess.Popen(
        ["dotnet", dll, "--urls", base],
        env=env, stdout=log_handle, stderr=subprocess.STDOUT,
    )
    if not wait_ready(base):
        server.terminate()
        raise RuntimeError(f"服务启动失败（{base}；日志 {log_path}）")
    return server, base, log_handle


def stop_instance(server, log_handle):
    try:
        server.terminate()
        server.wait(timeout=10)
    except Exception:
        try:
            server.kill()
        except Exception:
            pass
    try:
        log_handle.close()
    except Exception:
        pass


# ─────────────────────────────────────────────────────────────────────────────
# 飞书 webhook 辅助
# ─────────────────────────────────────────────────────────────────────────────


def feishu_sign(timestamp, nonce, body_bytes):
    prefix = (timestamp + nonce + FEISHU_ENCRYPT_KEY).encode("utf-8")
    return hashlib.sha256(prefix + body_bytes).hexdigest()


def post_feishu_webhook(body, signature=None, timestamp=None, nonce=None):
    body_bytes = body.encode("utf-8") if isinstance(body, str) else body
    stamp = timestamp or str(int(time.time()))
    nonce_value = nonce or f"smoke-{int(time.time() * 1000)}"
    sig = signature if signature is not None else feishu_sign(stamp, nonce_value, body_bytes)
    headers = {
        "Content-Type": "application/json",
        "X-Lark-Request-Timestamp": stamp,
        "X-Lark-Request-Nonce": nonce_value,
    }
    if sig is not None:
        headers["X-Lark-Signature"] = sig
    return http("POST", BASE + "/v1/channels/feishu/webhook", body_bytes, headers=headers)


def fixture_body(name):
    path = os.path.join(REPO_ROOT, "fixtures/channels/feishu-webhook", f"{name}.json")
    with open(path, "r", encoding="utf-8") as handle:
        document = json.load(handle)
    return document["requests"][0]["body"]


def mock_sleep(seconds):
    time.sleep(seconds)


# ─────────────────────────────────────────────────────────────────────────────
# 各阶段
# ─────────────────────────────────────────────────────────────────────────────


def phase_startup(state, caps):
    status, body, _ = http("GET", BASE + "/healthz", timeout=5)
    check("healthz 就绪", status == 200, f"{status} {body[:120]}")
    try:
        rss = json.loads(body).get("rssMB")
        print(f"  [INFO] 服务端 RSS={rss}MB（渠道批目标 ≤420MB，仅观测不作门禁）")
    except Exception:
        pass

    channels = caps.get("channels") or {}
    hosted = set(channels.get("hosted") or [])
    proactive = set(channels.get("proactive") or [])
    check("capabilities.channels.hosted = wechat/feishu/qqbot",
          hosted == {"wechat", "feishu", "qqbot"}, json.dumps(channels, ensure_ascii=False))
    check("capabilities.channels.ownership=lease / proactive=wechat,feishu / voice=false",
          channels.get("ownership") == "lease" and proactive == {"wechat", "feishu"}
          and channels.get("voice") is False and channels.get("mediaMaxMB") == 20,
          json.dumps(channels, ensure_ascii=False))

    status, data = api_json("GET", "/v1/channels/status")
    by_id = {item["id"]: item for item in (data.get("channels") or [])}
    check("status：三渠道已注册（feishu running / qqbot starting / wechat config_missing）",
          status == 200 and set(by_id) == {"wechat", "feishu", "qqbot"}
          and by_id["feishu"]["phase"] == "running"
          and by_id["wechat"]["phase"] == "config_missing",
          json.dumps(data, ensure_ascii=False))


def phase_wechat_login(state):
    status, data = api_json("POST", "/v1/channels/wechat/login/start")
    png = base64.b64decode(data.get("pngBase64") or "")
    check("微信登录 start：返回 loginId + PNG 二维码",
          status == 200 and data.get("loginId") and png[:8] == b"\x89PNG\r\n\x1a\n",
          f"{status} {str(data)[:160]}")
    check("微信登录 start：mock get_bot_qrcode 被调用（bot_type=3）",
          state.ilink_qr_calls >= 1, f"calls={state.ilink_qr_calls}")

    login_id = data.get("loginId")

    def confirmed():
        _, current = api_json("GET", f"/v1/channels/wechat/login/status?loginId={login_id}")
        return current if current.get("status") == "confirmed" else None

    confirmed_state = wait_until(confirmed, timeout=15)
    check("微信登录 status：confirmed + botId",
          confirmed_state is not None and confirmed_state.get("botId") == "bot-smoke-1",
          json.dumps(confirmed_state, ensure_ascii=False) if confirmed_state else "timeout")

    def running():
        _, current = api_json("GET", "/v1/channels/status")
        wechat = next((item for item in current.get("channels", []) if item["id"] == "wechat"), None)
        return wechat if wechat and wechat.get("phase") == "running" else None

    wechat_status = wait_until(running, timeout=20)
    detail = (wechat_status or {}).get("detail") or {}
    check("微信登录后适配器自动重启并进入 running（凭据 AES-GCM 落库）",
          wechat_status is not None and detail.get("credentialProtection") == "aes-gcm"
          and detail.get("botId") == "bot-smoke-1",
          json.dumps(wechat_status, ensure_ascii=False) if wechat_status else "timeout")

    def polled():
        with state.lock:
            return len(state.ilink_auth) > 0

    auth_ok = wait_until(polled, timeout=20) is not None and any(
        auth == "Bearer bot-token-smoke" and uin for auth, uin in state.ilink_auth)
    check("微信适配器已带 Bearer bot-token-smoke / X-WECHAT-UIN 长轮询 getupdates",
          auth_ok,
          json.dumps(sorted(str(item) for item in state.ilink_auth), ensure_ascii=False))


def enqueue_wechat(state, message):
    with state.lock:
        state.ilink_queue.append(message)


def wechat_text_message(message_id, text, context_token):
    return {
        "message_id": message_id,
        "from_user_id": "wx-user-1",
        "to_user_id": "bot-smoke-1",
        "message_type": 1,
        "context_token": context_token,
        "create_time_ms": int(time.time() * 1000),
        "item_list": [{"type": 1, "text_item": {"text": text}}],
    }


def wechat_image_message(message_id, context_token):
    return {
        "message_id": message_id,
        "from_user_id": "wx-user-1",
        "to_user_id": "bot-smoke-1",
        "message_type": 1,
        "context_token": context_token,
        "create_time_ms": int(time.time() * 1000),
        "item_list": [{
            "type": 2,
            "image_item": {
                "file_name": "照片.png",
                "media": {
                    "encrypt_query_param": "enc-img-smoke-1",
                    "aes_key": "00112233445566778899aabbccddeeff",
                    "encrypt_type": 0,
                },
            },
        }],
    }


def phase_wechat_text(state):
    enqueue_wechat(state, wechat_text_message("wx-msg-1", "你好", "ctx-smoke-1"))
    got = wait_until(lambda: len(state.ilink_sends) >= 1, timeout=30)
    body = state.ilink_sends[0] if state.ilink_sends else {}
    msg = body.get("msg") or {}
    items = msg.get("item_list") or []
    text = ((items[0] or {}).get("text_item") or {}).get("text", "") if items else ""
    check("微信文本收发：getupdates → 生成 → sendmessage（context_token 原样回传）",
          got is not None and msg.get("to_user_id") == "wx-user-1"
          and msg.get("context_token") == "ctx-smoke-1" and msg.get("message_type") == 2
          and items and items[0].get("type") == 1 and text.startswith("渠道回复-"),
          json.dumps(body, ensure_ascii=False)[:300])

    events = events_for(fetch_events(), "wechat")
    users = [item for item in events if (item.get("payload") or {}).get("role") == "user"]
    assistants = [item for item in events if (item.get("payload") or {}).get("role") == "assistant"]
    user_texts = user_contents(events)
    check("微信事件流：user（channelSource=wechat）+ assistant 回复",
          "你好" in user_texts and len(assistants) >= 1
          and all(channel_of(item) == "wechat" for item in users),
          json.dumps(user_texts, ensure_ascii=False)[:200])
    if users and assistants:
        user_turn = (users[0].get("payload") or {}).get("turnId")
        assistant_turn = (assistants[0].get("payload") or {}).get("turnId")
        check("微信事件流：assistant turnId 锚定 user turnId",
              bool(user_turn) and user_turn == assistant_turn, f"{user_turn} vs {assistant_turn}")


def phase_wechat_reconnect(state):
    with state.lock:
        state.ilink_failures = 2
        base_calls = state.ilink_getupdates_calls

    def failures_consumed():
        with state.lock:
            return state.ilink_failures == 0 and state.ilink_getupdates_calls >= base_calls + 2

    check("微信断线重连：mock getupdates 连续 500（两次）被适配器退避重试吸收",
          wait_until(failures_consumed, timeout=15) is not None,
          f"calls={state.ilink_getupdates_calls} failures={state.ilink_failures}")

    enqueue_wechat(state, wechat_text_message("wx-msg-2", "重连测试", "ctx-smoke-2"))

    def recovered():
        texts = user_contents(events_for(fetch_events(), "wechat"))
        return "重连测试" in texts

    check("微信断线重连：失败后仍能收消息并回复",
          wait_until(recovered, timeout=30) is not None,
          f"sends={len(state.ilink_sends)}")


def phase_wechat_image(state):
    enqueue_wechat(state, wechat_image_message("wx-msg-3", "ctx-smoke-3"))

    def downloaded():
        with state.lock:
            return len(state.cdn_downloads) >= 1 and len(state.ilink_sends) >= 3

    ok = wait_until(downloaded, timeout=30)
    check("微信图片入站：CDN download 命中（encrypt_type=0 明文）",
          ok is not None and "enc-img-smoke-1" in state.cdn_downloads,
          f"downloads={state.cdn_downloads} sends={len(state.ilink_sends)}")

    def placeholder_seen():
        return "[图片]" in user_contents(events_for(fetch_events(), "wechat"))

    check("微信图片入站：事件文本写稳定占位 [图片] 并回复",
          wait_until(placeholder_seen, timeout=20) is not None,
          json.dumps(user_contents(events_for(fetch_events(), "wechat")), ensure_ascii=False)[:200])

    media_dir = os.path.join(os.environ.get("SMOKE_DATA_DIR", ""), "media", "wechat")
    files = os.listdir(media_dir) if os.path.isdir(media_dir) else []
    check("微信图片入站：媒体落盘 data/media/wechat", len(files) >= 1, f"files={files}")


def phase_feishu(state):
    # 1) 明文 challenge（签名强制：Encrypt Key 已配置）
    status, text, _ = post_feishu_webhook(json.dumps({
        "type": "url_verification", "challenge": "smoke-challenge-plain",
        "token": FEISHU_VERIFICATION_TOKEN,
    }, ensure_ascii=False))
    check("飞书 webhook：明文 challenge 回显",
          status == 200 and json.loads(text).get("challenge") == "smoke-challenge-plain",
          f"{status} {text[:160]}")

    # 2) 加密 challenge（复用 fixtures 密文 + 现算签名/时间戳）
    status, text, _ = post_feishu_webhook(fixture_body("challenge-encrypted"))
    check("飞书 webhook：加密 challenge 解密回显",
          status == 200 and json.loads(text).get("challenge") == "cyrene-challenge-2",
          f"{status} {text[:160]}")

    # 3) 坏签名 401
    status, text, _ = post_feishu_webhook(fixture_body("challenge-encrypted"), signature="deadbeef" * 8)
    check("飞书 webhook：坏签名 → 401 E_FEISHU_SIGNATURE",
          status == 401 and json.loads(text).get("code") == "E_FEISHU_SIGNATURE",
          f"{status} {text[:160]}")

    # 4) challenge token 不匹配 401
    status, text, _ = post_feishu_webhook(json.dumps({
        "type": "url_verification", "challenge": "x", "token": "wrong-token",
    }))
    check("飞书 webhook：Verification Token 不匹配 → 401 E_FEISHU_TOKEN",
          status == 401 and json.loads(text).get("code") == "E_FEISHU_TOKEN",
          f"{status} {text[:160]}")

    # 5) 加密文本事件 → 归一化 → LLM → REST 发送（mock）
    llm_before = len(state.llm_requests)
    status, text, _ = post_feishu_webhook(fixture_body("message-text-encrypted"))
    check("飞书 webhook：加密文本事件 200（异步处理）", status == 200, f"{status} {text[:160]}")

    def feishu_sent():
        return len(state.feishu_messages) >= 1

    sent = wait_until(feishu_sent, timeout=30)
    if sent is not None:
        receive_type, payload = state.feishu_messages[0]
        content = json.loads(payload.get("content") or "{}")
        check("飞书出站：im/v1/messages 文本请求体（receive_id_type=open_id）",
              receive_type == "open_id" and payload.get("msg_type") == "text"
              and content.get("text", "").startswith("渠道回复-")
              and payload.get("receive_id") == "oc_chat_1",
              json.dumps(payload, ensure_ascii=False)[:240])
    else:
        check("飞书出站：im/v1/messages 文本请求体（receive_id_type=open_id）", False, "timeout")

    def feishu_event_seen():
        events = events_for(fetch_events(), "feishu")
        return "你好，昔涟" in user_contents(events) and len(assistant_contents(events)) >= 1

    check("飞书事件流：user 文本（channelSource=feishu）+ assistant",
          wait_until(feishu_event_seen, timeout=20) is not None,
          json.dumps(user_contents(events_for(fetch_events(), "feishu")), ensure_ascii=False)[:200])

    # 6) 重投去重：同一加密事件再发一次 → 不重复处理
    llm_after_first = len(state.llm_requests)
    sends_after_first = len(state.feishu_messages)
    status, text, _ = post_feishu_webhook(fixture_body("message-text-encrypted"))
    mock_sleep(1.5)
    check("飞书重投去重：重复事件 200 且不再触发 LLM/发送",
          status == 200 and len(state.llm_requests) == llm_after_first
          and len(state.feishu_messages) == sends_after_first,
          f"llm {llm_after_first}->{len(state.llm_requests)} sends {sends_after_first}->{len(state.feishu_messages)}")
    check("飞书重投去重：确实触发过一次生成",
          llm_after_first > llm_before, f"llm {llm_before}->{llm_after_first}")

    # 7) 加密图片事件 → 资源下载（mock）→ 附件注入 → 回复
    status, text, _ = post_feishu_webhook(fixture_body("message-image-encrypted"))

    def resource_seen():
        return len(state.feishu_resource_calls) >= 1

    resource = wait_until(resource_seen, timeout=30)
    check("飞书图片入站：im/v1/messages/{id}/resources/{key} 下载命中",
          resource is not None and state.feishu_resource_calls[0][0] == "om_image_1"
          and state.feishu_resource_calls[0][1] == "img_key_fixture_1",
          json.dumps(state.feishu_resource_calls, ensure_ascii=False))

    def attachment_seen():
        return any("[附件:" in item for item in user_contents(events_for(fetch_events(), "feishu")))

    check("飞书图片入站：附件路径注入事件文本并回复",
          wait_until(attachment_seen, timeout=20) is not None and len(state.feishu_messages) >= 2,
          json.dumps(user_contents(events_for(fetch_events(), "feishu")), ensure_ascii=False)[:240])

    # 8) 群消息忽略（fixture：chat_type=group）
    llm_before_group = len(state.llm_requests)
    status, text, _ = post_feishu_webhook(fixture_body("message-group-ignored"))
    mock_sleep(1.0)
    check("飞书群消息：200 但忽略（不触发 LLM）",
          status == 200 and len(state.llm_requests) == llm_before_group,
          f"llm {llm_before_group}->{len(state.llm_requests)}")


def phase_qq(state, gateway):
    def qq_running():
        _, current = api_json("GET", "/v1/channels/status")
        qq = next((item for item in current.get("channels", []) if item["id"] == "qqbot"), None)
        return qq if qq and qq.get("phase") == "running" else None

    qq_status = wait_until(qq_running, timeout=25)
    check("QQ 网关：token → /gateway → WS Identify → READY（状态 running）",
          qq_status is not None and gateway.identify_seen.is_set()
          and (qq_status.get("detail") or {}).get("wsReady") is True,
          json.dumps(qq_status, ensure_ascii=False) if qq_status else "timeout")
    check("QQ REST：getAppAccessToken 请求命中",
          state.qq_token_calls >= 1 and state.qq_gateway_calls >= 1,
          f"token={state.qq_token_calls} gateway={state.qq_gateway_calls}")

    def passive_reply():
        return state.qq_messages[0] if state.qq_messages else None

    reply = wait_until(passive_reply, timeout=30)
    if reply is not None:
        body = reply["body"]
        check("QQ 被动回复：/v2/users/{openid}/messages（msg_id/msg_seq/Authorization）",
              reply["path"] == "/v2/users/OPENUSER-SMOKE-1/messages"
              and body.get("msg_type") == 0 and body.get("msg_id") == "QQMSG-SMOKE-1"
              and body.get("msg_seq") == 1 and body.get("content", "").startswith("渠道回复-")
              and reply["authorization"] == "QQBot qq-tok-smoke",
              json.dumps(reply, ensure_ascii=False)[:300])
    else:
        check("QQ 被动回复：/v2/users/{openid}/messages（msg_id/msg_seq/Authorization）", False, "timeout")

    def qq_event_seen():
        events = events_for(fetch_events(), "qqbot")
        return "你好" in user_contents(events) and len(assistant_contents(events)) >= 1

    check("QQ 事件流：user（channelSource=qqbot）+ assistant",
          wait_until(qq_event_seen, timeout=20) is not None,
          json.dumps(user_contents(events_for(fetch_events(), "qqbot")), ensure_ascii=False)[:200])


def phase_ownership(state):
    # 配对一台设备（device token 走桌面路径）
    status, data = api_json("POST", "/v1/pair/code")
    code = data.get("code")
    status, text, _ = http("POST", BASE + "/v1/pair", json.dumps(
        {"code": code, "deviceName": "channel-smoke-desktop"}), headers={})
    pair = json.loads(text) if status == 200 else {}
    device_token, device_id = pair.get("token"), pair.get("deviceId")
    check("归属：配对 device token（claim/heartbeat 用）",
          bool(device_token) and bool(device_id), json.dumps(pair, ensure_ascii=False)[:160])

    status, snapshot = api_json("GET", "/v1/channels/ownership")
    channels = snapshot.get("channels") or {}
    check("归属快照：serverId/leaseTtlSeconds=180/三渠道 owner=server",
          status == 200 and snapshot.get("serverId") and snapshot.get("leaseTtlSeconds") == 180
          and all(channels.get(item, {}).get("owner") == "server"
                  for item in ("wechat", "feishu", "qqbot")),
          json.dumps(snapshot, ensure_ascii=False)[:240])

    status, claim = api_json("POST", "/v1/channels/ownership/claim",
                             {"channels": ["wechat"]}, token=device_token)
    check("归属 claim（device token）：granted=wechat + leaseExpiresAt",
          status == 200 and claim.get("granted") == ["wechat"] and claim.get("leaseExpiresAt"),
          json.dumps(claim, ensure_ascii=False)[:200])

    def wechat_offline():
        _, current = api_json("GET", "/v1/channels/status")
        wechat = next((item for item in current.get("channels", []) if item["id"] == "wechat"), None)
        return wechat if wechat and wechat.get("phase") == "offline" else None

    check("归属 claim：服务端先停 wechat 适配器（R2）",
          wait_until(wechat_offline, timeout=10) is not None)

    with state.lock:
        calls_after_stop = state.ilink_getupdates_calls
    mock_sleep(1.5)
    with state.lock:
        calls_later = state.ilink_getupdates_calls
    check("归属 claim：owner=desktop 期间服务端停止拉取（无新 getupdates）",
          calls_later == calls_after_stop, f"calls {calls_after_stop}->{calls_later}")

    status, heartbeat = api_json("POST", "/v1/channels/ownership/heartbeat",
                                 {"channels": ["wechat"]}, token=device_token)
    check("归属 heartbeat：renewed=wechat", status == 200 and heartbeat.get("renewed") == ["wechat"],
          json.dumps(heartbeat, ensure_ascii=False)[:160])

    status, snapshot = api_json("GET", "/v1/channels/ownership")
    check("归属快照：holder=deviceId（桌面持有）",
          (snapshot.get("channels") or {}).get("wechat", {}).get("holder") == device_id,
          json.dumps(snapshot, ensure_ascii=False)[:200])

    status, body = api_json("POST", "/v1/channels/wechat/proactive",
                            {"intentId": "owned-1", "text": "不应发出"}, token=device_token)
    check("归属门闩：owner=desktop 时 proactive → 409 E_CHANNEL_OWNED_BY_OTHER",
          status == 409 and body.get("code") == "E_CHANNEL_OWNED_BY_OTHER",
          f"{status} {json.dumps(body, ensure_ascii=False)[:160]}")

    status, release = api_json("POST", "/v1/channels/ownership/release",
                               {"channels": ["wechat"]}, token=device_token)
    check("归属 release：released=wechat", status == 200 and release.get("released") == ["wechat"],
          json.dumps(release, ensure_ascii=False)[:160])

    def wechat_running():
        _, current = api_json("GET", "/v1/channels/status")
        wechat = next((item for item in current.get("channels", []) if item["id"] == "wechat"), None)
        return wechat if wechat and wechat.get("phase") == "running" else None

    check("归属 release：宽限（5s）后服务端适配器恢复 running",
          wait_until(wechat_running, timeout=15) is not None)

    # 适配器重启后微信内存态 context_token 清空（设计已知：需一条新入站重新学习），
    # 主动消息前先发一条预热消息（真机语义一致）。
    sends_before_warmup = len(state.ilink_sends)
    enqueue_wechat(state, wechat_text_message("wx-msg-warmup", "预热", "ctx-smoke-warmup"))

    def warmed():
        return len(state.ilink_sends) > sends_before_warmup and \
            "预热" in user_contents(events_for(fetch_events(), "wechat"))

    check("归属 release 后：预热入站恢复 context_token（主动消息前置条件）",
          wait_until(warmed, timeout=30) is not None,
          f"sends={len(state.ilink_sends)}")


def phase_proactive(state):
    sends_before = len(state.ilink_sends)
    status, body = api_json("POST", "/v1/channels/wechat/proactive",
                            {"intentId": "pro-smoke-1", "text": "主动消息-微信"})
    check("主动消息（微信）：delivered=true + proactive 事件 id",
          status == 200 and body.get("delivered") is True
          and (body.get("eventId") or "").startswith("proactive-"),
          f"{status} {json.dumps(body, ensure_ascii=False)[:200]}")

    def proactive_sent():
        return len(state.ilink_sends) > sends_before

    sent = wait_until(proactive_sent, timeout=15)
    text = ""
    if sent is not None:
        items = ((state.ilink_sends[-1] or {}).get("msg") or {}).get("item_list") or []
        text = ((items[0] or {}).get("text_item") or {}).get("text", "") if items else ""
    check("主动消息（微信）：sendmessage 文本与 intent 内容一致",
          sent is not None and text == "主动消息-微信", f"text={text!r}")

    status, duplicate = api_json("POST", "/v1/channels/wechat/proactive",
                                 {"intentId": "pro-smoke-1", "text": "主动消息-微信"})
    mock_sleep(0.8)
    check("主动消息（微信）：intentId 幂等 duplicate 不重发",
          status == 200 and duplicate.get("duplicate") is True
          and len(state.ilink_sends) == sends_before + 1,
          f"{json.dumps(duplicate, ensure_ascii=False)[:200]} sends={len(state.ilink_sends)}")

    feishu_before = len(state.feishu_messages)
    status, body = api_json("POST", "/v1/channels/feishu/proactive",
                            {"intentId": "pro-smoke-2", "text": "主动消息-飞书"})
    check("主动消息（飞书）：delivered=true + REST 发送命中",
          status == 200 and body.get("delivered") is True
          and wait_until(lambda: len(state.feishu_messages) > feishu_before, timeout=15) is not None,
          f"{status} {json.dumps(body, ensure_ascii=False)[:200]}")

    status, body = api_json("POST", "/v1/channels/wechat/proactive", {"text": "缺 intentId"})
    check("主动消息：缺 intentId → 400 E_CHANNEL_REQUEST",
          status == 400 and body.get("code") == "E_CHANNEL_REQUEST",
          f"{status} {json.dumps(body, ensure_ascii=False)[:160]}")

    status, body = api_json("POST", "/v1/channels/nope/proactive",
                            {"intentId": "x", "text": "x"})
    check("主动消息：未知渠道 → 400 E_CHANNEL_UNKNOWN",
          status == 400 and body.get("code") == "E_CHANNEL_UNKNOWN",
          f"{status} {json.dumps(body, ensure_ascii=False)[:160]}")


def phase_wechat_expired(state):
    with state.lock:
        state.ilink_expired = True

    def expired_error():
        _, current = api_json("GET", "/v1/channels/status")
        wechat = next((item for item in current.get("channels", []) if item["id"] == "wechat"), None)
        detail = (wechat or {}).get("detail") or {}
        return wechat if wechat and wechat.get("phase") == "error" \
            and detail.get("lastErrorCode") == "E_CHANNEL_LOGIN_EXPIRED" else None

    wechat = wait_until(expired_error, timeout=20)
    check("微信 ret=-14：状态 error + detail.lastErrorCode=E_CHANNEL_LOGIN_EXPIRED（等待人工重登）",
          wechat is not None,
          json.dumps(wechat, ensure_ascii=False)[:260] if wechat else "timeout")

    mock_sleep(3.5)  # 排空在途长轮询
    with state.lock:
        calls_settled = state.ilink_getupdates_calls
    mock_sleep(1.0)
    with state.lock:
        calls_final = state.ilink_getupdates_calls
    check("微信 ret=-14：轮询停止（不重试）",
          calls_final == calls_settled, f"calls {calls_settled}->{calls_final}")


# ─────────────────────────────────────────────────────────────────────────────
# main
# ─────────────────────────────────────────────────────────────────────────────


def main():
    global BASE
    parser = argparse.ArgumentParser(description="cyrene-cloud-server 渠道 mock e2e 冒烟（设计 §8.4）")
    parser.add_argument("dll", nargs="?", default=None, help="cloud-server 产物 dll（默认 Release 构建输出）")
    parser.add_argument("--keep-data", action="store_true", help="保留临时数据目录（排查用）")
    args = parser.parse_args()

    dll = args.dll or os.environ.get("CHANNEL_SMOKE_DLL") or DEFAULT_DLL
    if not os.path.isfile(dll):
        print(f"[FAIL] 找不到 dll: {dll}（先 dotnet build dotnet/cloud-server -c Release）")
        return 2

    state = MockState()
    gateway = QqMockGateway(state)
    gateway.start()
    mock_server = start_mock_upstreams(state, gateway.port)
    mock_port = mock_server.server_address[1]

    data_dir = tempfile.mkdtemp(prefix="cyrene-channel-smoke-")
    os.environ["SMOKE_DATA_DIR"] = data_dir
    log_path = os.path.join(data_dir, "server.log")
    extra_env = {
        "CLOUD_CHANNELS": "wechat,feishu,qqbot",
        "CLOUD_CHANNEL_WECHAT_BASE_URL": f"http://127.0.0.1:{mock_port}",
        "CLOUD_CHANNEL_WECHAT_CDN_BASE_URL": f"http://127.0.0.1:{mock_port}/c2c",
        "CLOUD_CHANNEL_FEISHU_APP_ID": "cli_smoke",
        "CLOUD_CHANNEL_FEISHU_APP_SECRET": "feishu-secret-smoke",
        "CLOUD_CHANNEL_FEISHU_VERIFICATION_TOKEN": FEISHU_VERIFICATION_TOKEN,
        "CLOUD_CHANNEL_FEISHU_ENCRYPT_KEY": FEISHU_ENCRYPT_KEY,
        "CLOUD_CHANNEL_FEISHU_BASE_URL": f"http://127.0.0.1:{mock_port}",
        "CLOUD_CHANNEL_FEISHU_AUDIO": "0",  # 本机无 ffmpeg 也可跑；语音转码由 C# selftest 覆盖
        "CLOUD_CHANNEL_QQBOT_APP_ID": "102000001",
        "CLOUD_CHANNEL_QQBOT_APP_SECRET": "qq-secret-smoke",
        "CLOUD_CHANNEL_QQBOT_ALLOW_ANY_PRIVATE": "1",
        "CLOUD_CHANNEL_QQBOT_API_BASE": f"http://127.0.0.1:{mock_port}",
        "CLOUD_CHANNEL_QQBOT_TOKEN_URL": f"http://127.0.0.1:{mock_port}/app/getAppAccessToken",
        "CLOUD_LLM_BASE_URL": f"http://127.0.0.1:{mock_port}/v1",
    }

    server = None
    log_handle = None
    exit_code = 1
    try:
        server, BASE, log_handle = start_instance(dll, data_dir, extra_env, log_path)
        print(f"服务端已启动: {BASE}（mock 上游 :{mock_port}，QQ 网关 :{gateway.port}）\n")

        status, text, _ = http("GET", BASE + "/v1/capabilities")
        caps = json.loads(text) if status == 200 else {}

        print("=== 1. 启动与能力声明 ===")
        phase_startup(state, caps)
        print("\n=== 2. 微信扫码登录（mock iLink QR）===")
        phase_wechat_login(state)
        print("\n=== 3. 微信文本收发 ===")
        phase_wechat_text(state)
        print("\n=== 4. 微信断线重连 ===")
        phase_wechat_reconnect(state)
        print("\n=== 5. 微信图片入站（mock CDN）===")
        phase_wechat_image(state)
        print("\n=== 6. 飞书 webhook（真实 HTTP 打到服务）===")
        phase_feishu(state)
        print("\n=== 7. QQ 网关与被动回复 ===")
        phase_qq(state, gateway)
        print("\n=== 8. 归属权控制面 ===")
        phase_ownership(state)
        print("\n=== 9. 主动消息（Bearer 幂等投递）===")
        phase_proactive(state)
        print("\n=== 10. 微信会话过期（ret=-14）===")
        phase_wechat_expired(state)
    except Exception as exc:  # noqa: BLE001 - 冒烟脚本兜底：打印日志尾部便于排查
        check("冒烟执行异常", False, repr(exc))
        try:
            with open(log_path, "r", encoding="utf-8", errors="replace") as handle:
                tail = handle.read().splitlines()[-30:]
            print("── 服务端日志尾部 ──")
            print("\n".join(tail))
        except Exception:
            pass
    finally:
        if server is not None:
            stop_instance(server, log_handle)
        mock_server.shutdown()
        gateway.stop()

    passed = sum(1 for _, ok, _ in results if ok)
    failed = len(results) - passed
    print(f"\n{'=' * 50}\n渠道冒烟汇总: {passed} passed / {failed} failed")
    exit_code = 1 if failed else 0
    if failed:
        print(f"（数据目录保留: {data_dir}）")
    elif not args.keep_data:
        import shutil
        shutil.rmtree(data_dir, ignore_errors=True)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
