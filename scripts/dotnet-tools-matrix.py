#!/usr/bin/env python3
"""tool-host 全工具逐项调用矩阵（真实调用验证）。

calculator / now / clipboard / sysinfo / fs / expense / search_text /
str_replace / apply_patch / download_file / git 八件（真实仓库 + 本地 bare 远程）/
web_search / weather / plan_trip / fetch_url（本地 HTTP fixture + GitHub mock）/
文档四件（write_markdown/excel/word/pdf，zip 结构与 PdfPig 文本提取断言）/
邮件四件（本地 fake SMTP + fake IMAP）/ ast_grep 两件（随包 CLI）
每个工具多组输入：正常 + 参数缺失 + 参数类型错。验响应形状与错误语义。
"""
import subprocess, json, os, tempfile, sys, re, shutil, atexit, socket

# Windows 控制台默认 GBK：错误 detail 含 emoji（如 🚗）会撑爆 print；强制 UTF-8 输出
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

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
                       encoding="utf-8", errors="replace",
                       cwd=ROOT, env=env)
    out = []
    for line in (p.stdout or "").strip().splitlines():
        try: out.append(json.loads(line))
        except Exception: out.append({"_raw": line[:100]})
    return out

def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"{'[PASS]' if ok else '[FAIL]'} {name}" + (f" —— {str(detail)[:160]}" if not ok else (f" —— {str(detail)[:80]}" if detail else "")))

tmp = tempfile.mkdtemp(prefix="tools-matrix-")
# 任意退出路径（含断言失败 sys.exit(1)）清理临时目录
atexit.register(lambda: shutil.rmtree(tmp, ignore_errors=True))

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

# expense（config 帧注入 dataDir；record 两笔 + 负数拒绝 + 汇总/明细）
c_exp_dir = os.path.join(tmp, "expenses")
frames.append(json.dumps({"op": "config", "dataDir": c_exp_dir, "timezone": "Asia/Shanghai", "dateLocale": "zh-CN"}))
c_ex1 = req("record_expense", {"amount": 12.5, "category": "餐饮", "note": "午饭"})
c_ex2 = req("record_expense", {"amount": 40.5, "category": "交通", "note": "打车"})
c_ex3 = req("record_expense", {"amount": -1})
# 数字字符串：JS Number() 语义双轨等价（模型偶发把金额/天数写成字符串）
c_ex4 = req("record_expense", {"amount": "7.5", "category": "娱乐", "note": "电影"})
c_ex5 = req("record_expense", {"amount": "abc"})
c_eq1 = req("query_expense", {"summary": True})
c_eq2 = req("query_expense", {})
c_eq3 = req("query_expense", {"days": "30", "summary": True})

# search_text（内部工作区根注入；忽略 node_modules）
sws = os.path.join(tmp, "searchws")
os.makedirs(os.path.join(sws, "src"))
os.makedirs(os.path.join(sws, "node_modules"))
open(os.path.join(sws, "src", "a.ts"), "w", encoding="utf-8").write("hello world\nconst x = 1;\nHELLO again\n")
open(os.path.join(sws, "src", "b.py"), "w", encoding="utf-8").write("hello python\n")
open(os.path.join(sws, "node_modules", "c.js"), "w", encoding="utf-8").write("hello dep\n")
c_s1 = req("search_text", {"query": "hello", "contextLines": 1, "__cyreneWorkspaceRoot": sws})
c_s2 = req("search_text", {"query": "he.*o", "mode": "regex", "caseSensitive": True, "__cyreneWorkspaceRoot": sws})
c_s3 = req("search_text", {"query": "zzz-not-exist", "__cyreneWorkspaceRoot": sws})
# 字符串数字：JS Number() 语义（与 c_s1 输出应完全一致）
c_s4 = req("search_text", {"query": "hello", "contextLines": "1", "maxMatches": "3", "__cyreneWorkspaceRoot": sws})

# str_replace（两段式：__dryRun 预检 → 提交；失败诊断）
srf = os.path.join(tmp, "sr.txt")
srf_dry = os.path.join(tmp, "sr_dry.txt")
open(srf, "w", encoding="utf-8").write("alpha\nbeta\ngamma\n")
open(srf_dry, "w", encoding="utf-8").write("alpha\nbeta\ngamma\n")
c_sr1 = req("str_replace", {"file_path": srf_dry, "old_string": "beta", "new_string": "BETA", "__dryRun": True})
c_sr2 = req("str_replace", {"file_path": srf, "old_string": "beta", "new_string": "BETA"})
c_sr3 = req("str_replace", {"file_path": srf, "old_string": "nope", "new_string": "x"})
# 空文件播种：old_string="" + 空内容（矩阵补充边界用例）
srf2 = os.path.join(tmp, "sr_empty.txt")
open(srf2, "w", encoding="utf-8").write("")
c_sr4 = req("str_replace", {"file_path": srf2, "old_string": "", "new_string": "seed content\n"})

# apply_patch（Codex 补丁格式：dry-run 预检 → 提交；事务/逃逸/Move/删除）
ap_ws = os.path.join(tmp, "apws")
os.makedirs(ap_ws)
open(os.path.join(ap_ws, "a.txt"), "w", encoding="utf-8").write("alpha\nbeta\ngamma\n")
open(os.path.join(ap_ws, "m.txt"), "w", encoding="utf-8").write("m1\nm2\n")
open(os.path.join(ap_ws, "dry.txt"), "w", encoding="utf-8").write("d1\nd2\n")
ap_dry_patch = "*** Begin Patch\n*** Update File: dry.txt\n@@\n-d1\n+D1\n*** End Patch"
ap_patch1 = ("*** Begin Patch\n*** Update File: a.txt\n@@\n alpha\n-beta\n+BETA\n gamma\n"
             "*** Add File: sub/new.txt\n+hello\n+world\n*** End Patch")
c_ap0 = req("apply_patch", {"patch": ap_dry_patch, "__cyreneRoot": ap_ws, "__dryRun": True})
c_ap1 = req("apply_patch", {"patch": ap_patch1, "__cyreneRoot": ap_ws})
c_ap2 = req("apply_patch", {"patch": "*** Begin Patch\n*** Update File: a.txt\n@@\n-nope\n+X\n*** End Patch", "__cyreneRoot": ap_ws, "__dryRun": True})
c_ap3 = req("apply_patch", {"patch": "*** Begin Patch\n*** Update File: a.txt\n@@\n-nope\n+X\n*** End Patch", "__cyreneRoot": ap_ws})
c_ap4 = req("apply_patch", {"patch": "*** Begin Patch\n*** Add File: a.txt\n+z\n*** End Patch", "__cyreneRoot": ap_ws})
c_ap5 = req("apply_patch", {"patch": "*** Begin Patch\n*** Delete File: ghost.txt\n*** End Patch", "__cyreneRoot": ap_ws})
c_ap6 = req("apply_patch", {"patch": "*** Begin Patch\n*** Add File: ../escape.txt\n+x\n*** End Patch", "__cyreneRoot": ap_ws})
c_ap7 = req("apply_patch", {"patch": "*** Begin Patch\n*** Update File: a.txt\n@@\n-nope\n+X\n*** Add File: ../escape2.txt\n+z\n*** End Patch", "__cyreneRoot": ap_ws})
c_ap8 = req("apply_patch", {"patch": "*** Begin Patch\n*** Update File: m.txt\n*** Move to: moved/m.txt\n@@\n-m1\n+M1\n*** End Patch", "__cyreneRoot": ap_ws})
c_ap9 = req("apply_patch", {"patch": "not a patch", "__cyreneRoot": ap_ws})

# download_file 扩展黑名单（联网前拒绝，无需 HTTP；与 TS 两侧同步）
c_dl1 = req("download_file", {"url": "https://example.com/x.hta", "filename": "x.hta", "__cyreneRoot": ap_ws})
c_dl2 = req("download_file", {"url": "https://example.com/x.js", "filename": "x.js", "__cyreneRoot": ap_ws})
c_dl3 = req("download_file", {"url": "https://example.com/x.wsf", "filename": "x.wsf", "__cyreneRoot": ap_ws})

# web_search：config 帧注入（引擎/key），覆盖确定性校验路径（不联网）
frames.append(json.dumps({"op": "config", "timezone": "Asia/Shanghai", "dateLocale": "zh-CN",
                          "webSearch": {"engine": "off", "bochaKey": "", "tavilyKey": "", "anySearchKey": ""}}))
c_ws1 = req("web_search", {"query": "test"})
frames.append(json.dumps({"op": "config", "timezone": "Asia/Shanghai", "dateLocale": "zh-CN",
                          "webSearch": {"engine": "bocha", "bochaKey": "", "tavilyKey": "", "anySearchKey": ""}}))
c_ws2 = req("web_search", {"query": "test"})
c_ws3 = req("web_search", {"query": "   "})
frames.append(json.dumps({"op": "config", "timezone": "Asia/Shanghai", "dateLocale": "zh-CN",
                          "webSearch": {"engine": "no-such", "bochaKey": "", "tavilyKey": "", "anySearchKey": ""}}))
c_ws4 = req("web_search", {"query": "test"})

# weather：config 帧注入（确定性路径，不联网）
frames.append(json.dumps({"op": "config", "weather": {"city": "北京", "source": "open-meteo", "amapKey": "", "enabled": False, "language": "zh"}}))
c_wt1 = req("weather", {})
frames.append(json.dumps({"op": "config", "weather": {"city": "", "source": "open-meteo", "amapKey": "", "enabled": True, "language": "zh"}}))
c_wt2 = req("weather", {})
frames.append(json.dumps({"op": "config", "weather": {"city": "", "source": "bogus", "amapKey": "", "enabled": True, "language": "zh"}}))
c_wt3 = req("weather", {"city": "上海"})
frames.append(json.dumps({"op": "config", "weather": {"city": "", "source": "amap", "amapKey": "", "enabled": True, "language": "zh"}}))
c_wt4 = req("weather", {"city": "上海"})

# plan_trip：config 帧注入（确定性路径，不联网）
frames.append(json.dumps({"op": "config", "travel": {"amapKey": "", "enabled": False}}))
c_pt1 = req("plan_trip", {"origin": "A", "destination": "B"})
frames.append(json.dumps({"op": "config", "travel": {"amapKey": "", "enabled": True}}))
c_pt2 = req("plan_trip", {"origin": "A", "destination": "B"})
frames.append(json.dumps({"op": "config", "travel": {"amapKey": "k", "enabled": True}}))
c_pt3 = req("plan_trip", {"destination": "B"})

# fetch_url：本地 HTTP fixture（正文提取/markdown/raw/截断/404/缓存）+ GitHub API mock
import http.server, socketserver, threading
FU_FILLER = "填充文字" * 30  # 120 字：保证 article 正文稳定 ≥200 字阈值（走正文容器路径）
FU_PAGE = """<!doctype html><html><head><title>Fixture</title><style>.x{}</style><script>var a=1;</script></head>
<body><nav>导航链接 首页</nav><header>页头</header>
<article><h1>大标题</h1>
<p>这是正文段落，包含<strong>加粗</strong>与<em>斜体</em>以及<a href="https://example.com/x">链接</a>。""" + FU_FILLER + """</p>
<ul><li>项目一</li><li>项目二</li></ul>
<pre><code>const x = 1;</code></pre>
<table><thead><tr><th>列A</th><th>列B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>
<p>结尾段落：""" + FU_FILLER + """</p>
</article><footer>页脚</footer><aside>侧栏</aside></body></html>"""

class _FuHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, body, ctype):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/page.html":
            self._send(200, FU_PAGE, "text/html; charset=utf-8")
        elif path == "/big.html":
            self._send(200, "<html><body><article><p>" + ("很长的正文" * 40000) + "</p></article></body></html>", "text/html; charset=utf-8")
        elif path == "/repos/o/r":
            self._send(200, json.dumps({"description": "演示仓库", "stargazers_count": 42, "forks_count": 7,
                                        "language": "TypeScript", "default_branch": "main",
                                        "license": {"spdx_id": "MIT"}}), "application/json")
        elif path == "/repos/o/r/readme":
            self._send(200, "# 演示 README\n\n这是 README 正文。\n", "text/plain; charset=utf-8")
        else:
            self._send(404, "not found", "text/plain; charset=utf-8")

fu_srv = socketserver.TCPServer(("127.0.0.1", 0), _FuHandler)
fu_base = "http://127.0.0.1:" + str(fu_srv.server_address[1])
threading.Thread(target=fu_srv.serve_forever, daemon=True).start()
c_fu1 = req("fetch_url", {"url": fu_base + "/page.html"})
c_fu2 = req("fetch_url", {"url": fu_base + "/page.html"})          # 缓存命中
c_fu3 = req("fetch_url", {"url": fu_base + "/page.html", "format": "raw"})
c_fu4 = req("fetch_url", {"url": fu_base + "/big.html"})
c_fu5 = req("fetch_url", {"url": fu_base + "/missing"})
c_fu6 = req("fetch_url", {"url": "ftp://example.com/x"})
c_fu7 = req("fetch_url", {"url": "https://github.com/o/r", "__githubApiBase": fu_base})

# 文档四件（write_markdown / write_excel / write_word / write_pdf）
docdir = os.path.join(tmp, "docs")
os.makedirs(docdir, exist_ok=True)
DOC_MD_NEW = os.path.join(docdir, "新建.md")
DOC_MD_APPEND = os.path.join(docdir, "追加.md")
DOC_MD_OVER = os.path.join(docdir, "覆盖.md")
DOC_XLSX = os.path.join(docdir, "成绩.xlsx")
DOC_DOCX = os.path.join(docdir, "报告.docx")
DOC_PDF = os.path.join(docdir, "合同.pdf")
DOC_THEME_XLSX = {"headerFill": "FF1F4E79", "headerFont": "FFFFFFFF", "headerBorder": "FF1F4E79",
                  "zebraFill": "FFF2F2F2", "borderColor": "FFBFBFBF"}
DOC_THEME_WORD = {"titleColor": "1F4E79", "titleSize": 28, "titleFont": "微软雅黑", "bodyFont": "微软雅黑",
                  "bodySize": 24, "bodyColor": "333333", "lineSpacing": 360, "headingColor": "1F4E79"}
c_dm1 = req("write_markdown", {"path": DOC_MD_NEW, "content": "第一行\n第二行"})
c_dm2a = req("write_markdown", {"path": DOC_MD_APPEND, "content": "第一行\n第二行"})
c_dm2b = req("write_markdown", {"path": DOC_MD_APPEND, "content": "第三行", "append": True})
c_dm3a = req("write_markdown", {"path": DOC_MD_OVER, "content": "第一行\n第二行\n第三行"})
c_dm3b = req("write_markdown", {"path": DOC_MD_OVER, "content": "x"})
c_dm4 = req("write_markdown", {"path": "", "content": "x"})
c_dx1 = req("write_excel", {"path": DOC_XLSX, "theme": DOC_THEME_XLSX, "sheets": [
    {"name": "成绩", "headers": ["姓名", "分数", "比率"], "rows": [["张三", 95, 0.5], ["李四", 1200, 0.25]]}]})
c_dx2 = req("write_excel", {"path": os.path.join(docdir, "空.xlsx"), "sheets": []})
c_dw1 = req("write_word", {"path": DOC_DOCX, "title": "季度报告", "theme": DOC_THEME_WORD,
                           "paragraphs": ["第一段正文。", "第二段正文。"]})
c_dw2 = req("write_word", {"path": "", "title": "x", "paragraphs": []})
c_dp1 = req("write_pdf", {"path": DOC_PDF, "title": "PDF Report 合作协议", "paragraphs": ["Alpha 甲方：示例公司", "Beta 乙方：测试公司"]})
c_dp2 = req("write_pdf", {"path": "", "title": "x", "paragraphs": []})

# 邮件四件：本地 fake SMTP + fake IMAP（ASCII fixture；中文 MIME 编码由 MimeKit 库保证）
_SMTP_MESSAGES = []

class _SmtpHandler(socketserver.StreamRequestHandler):
    def handle(self):
        self.wfile.write(b"220 fake ESMTP ready\r\n")
        in_data = False
        data_lines = []
        auth_login_step = 0
        while True:
            line = self.rfile.readline()
            if not line:
                break
            text = line.decode("utf-8", "replace").rstrip("\r\n")
            if in_data:
                if text == ".":
                    in_data = False
                    _SMTP_MESSAGES.append("\n".join(data_lines))
                    self.wfile.write(b"250 OK queued\r\n")
                else:
                    data_lines.append(text[1:] if text.startswith("..") else text)
                continue
            if auth_login_step == 1:
                auth_login_step = 2
                self.wfile.write(b"334 UGFzc3dvcmQ6\r\n")
                continue
            if auth_login_step == 2:
                auth_login_step = 0
                self.wfile.write(b"235 Authentication successful\r\n")
                continue
            upper = text.upper()
            if upper.startswith("EHLO") or upper.startswith("HELO"):
                self.wfile.write(b"250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n")
            elif upper.startswith("AUTH LOGIN"):
                auth_login_step = 1
                self.wfile.write(b"334 VXNlcm5hbWU6\r\n")
            elif upper.startswith("AUTH PLAIN"):
                if len(text.split(" ")) >= 3:
                    self.wfile.write(b"235 Authentication successful\r\n")
                else:
                    self.rfile.readline()
                    self.wfile.write(b"235 Authentication successful\r\n")
            elif upper.startswith("MAIL FROM") or upper.startswith("RCPT TO"):
                self.wfile.write(b"250 OK\r\n")
            elif upper.startswith("DATA"):
                in_data = True
                self.wfile.write(b"354 End data with <CR><LF>.<CR><LF>\r\n")
            elif upper.startswith("RSET"):
                self.wfile.write(b"250 OK\r\n")
            elif upper.startswith("QUIT"):
                self.wfile.write(b"221 Bye\r\n")
                break
            else:
                self.wfile.write(b"250 OK\r\n")

_IMAP_MAILS = [
    {"uid": 1, "flags": ["\\Seen"], "subject": "Hello One", "name": "Sender A", "addr": "a@example.com",
     "date": "Mon, 05 Oct 2026 01:00:00 +0800", "body": "Body one"},
    {"uid": 2, "flags": [], "subject": "Hello Two", "name": "Sender B", "addr": "b@example.com",
     "date": "Mon, 05 Oct 2026 02:00:00 +0800", "body": "Body two",
     "attachment": "note.txt"},
]

def _imap_raw(m):
    if m.get("attachment"):
        att = "A" * 2048
        return ("From: {name} <{addr}>\r\nTo: to@example.com\r\nSubject: {subject}\r\nDate: {date}\r\n"
                "Message-ID: <m{uid}@example.com>\r\nMIME-Version: 1.0\r\n"
                "Content-Type: multipart/mixed; boundary=\"BOUND\"\r\n\r\n"
                "--BOUND\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}\r\n"
                "--BOUND\r\nContent-Type: text/plain; name=\"note.txt\"\r\n"
                "Content-Disposition: attachment; filename=\"note.txt\"\r\n"
                "Content-Transfer-Encoding: 8bit\r\n\r\n{att}\r\n--BOUND--\r\n"
                ).format(att=att, **m).encode("utf-8")
    return ("From: {name} <{addr}>\r\nTo: to@example.com\r\nSubject: {subject}\r\nDate: {date}\r\n"
            "Message-ID: <m{uid}@example.com>\r\nMIME-Version: 1.0\r\n"
            "Content-Type: text/plain; charset=utf-8\r\n\r\n{body}\r\n").format(**m).encode("utf-8")

def _imap_envelope(m):
    from_addr = '(({name} NIL {mailbox} {host}))'.format(name=m["name"], mailbox=m["addr"].split("@")[0], host=m["addr"].split("@")[1])
    return '("{date}" "{subject}" {from_addr} {from_addr} {from_addr} NIL NIL NIL NIL "msgid")'.format(
        date=m["date"], subject=m["subject"], from_addr=from_addr)

def _parse_uid_set(spec):
    ids = set()
    for part in spec.split(","):
        if ":" in part:
            a, b = part.split(":", 1)
            lo, hi = min(int(a), int(b)), max(int(a), int(b))
            for i in range(lo, hi + 1):
                ids.add(i)
        elif part.isdigit():
            ids.add(int(part))
    return ids

class _ImapHandler(socketserver.StreamRequestHandler):
    def _ok(self, tag, text):
        self.wfile.write(f"{tag} OK {text}\r\n".encode())

    def handle(self):
        self.wfile.write(b"* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] Fake IMAP ready\r\n")
        while True:
            line = self.rfile.readline()
            if not line:
                break
            text = line.decode("utf-8", "replace").rstrip("\r\n")
            parts = text.split(" ")
            tag = parts[0] if parts else "?"
            cmd = parts[1].upper() if len(parts) > 1 else ""
            if cmd == "AUTHENTICATE":
                self.wfile.write(b"+ \r\n")
                self.rfile.readline()  # base64 凭据（fake 不校验）
                self._ok(tag, "AUTHENTICATE completed")
            elif cmd == "CAPABILITY":
                self.wfile.write(b"* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n")
                self._ok(tag, "CAPABILITY completed")
            elif cmd == "LIST":
                pattern = parts[-1].strip('"') if len(parts) > 2 else ""
                if pattern == "":
                    self.wfile.write(b"* LIST (\\Noselect) \"/\" \"\"\r\n")
                elif "INBOX" in pattern.upper() or pattern == "*":
                    self.wfile.write(b"* LIST (\\HasNoChildren) \"/\" \"INBOX\"\r\n")
                self._ok(tag, "LIST completed")
            elif cmd == "LOGIN":
                self._ok(tag, "LOGIN completed")
            elif cmd in ("SELECT", "EXAMINE"):
                self.wfile.write(b"* 2 EXISTS\r\n* 0 RECENT\r\n")
                self.wfile.write(b"* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)\r\n")
                self.wfile.write(b"* OK [PERMANENTFLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft \\*)] Flags permitted.\r\n")
                self.wfile.write(b"* OK [UIDVALIDITY 1] UIDs valid\r\n")
                self.wfile.write(b"* OK [UIDNEXT 3] Predicted next UID\r\n")
                mode = "READ-ONLY" if cmd == "EXAMINE" else "READ-WRITE"
                self._ok(tag, f"[{mode}] {cmd} completed")
            elif cmd == "CLOSE":
                self._ok(tag, "CLOSE completed")
            elif cmd == "LOGOUT":
                self.wfile.write(b"* BYE Logging out\r\n")
                self._ok(tag, "LOGOUT completed")
                break
            elif cmd == "NOOP":
                self._ok(tag, "NOOP completed")
            elif cmd == "UID":
                sub = parts[2].upper() if len(parts) > 2 else ""
                if sub == "SEARCH":
                    crit = " ".join(parts[3:]).upper()
                    ids = [m["uid"] for m in _IMAP_MAILS if "UNSEEN" not in crit or "\\Seen" not in m["flags"]]
                    self.wfile.write(("* SEARCH" + "".join(f" {i}" for i in ids) + "\r\n").encode())
                    self._ok(tag, "UID SEARCH completed")
                elif sub == "FETCH":
                    uids = _parse_uid_set(parts[3]) if len(parts) > 3 else set()
                    items = text[text.find("("):].upper() if "(" in text else ""
                    for m in _IMAP_MAILS:
                        if m["uid"] not in uids:
                            continue
                        if "BODY" in items or "RFC822" in items:
                            raw = _imap_raw(m)
                            self.wfile.write(f"* {m['uid']} FETCH (UID {m['uid']} BODY[] {{{len(raw)}}}\r\n".encode())
                            self.wfile.write(raw + b")\r\n")
                        else:
                            size = len(_imap_raw(m))
                            flags = " ".join(m["flags"])
                            self.wfile.write(
                                f"* {m['uid']} FETCH (UID {m['uid']} FLAGS ({flags}) ENVELOPE {_imap_envelope(m)} RFC822.SIZE {size})\r\n".encode())
                    self._ok(tag, "UID FETCH completed")
                elif sub == "STORE":
                    uids = _parse_uid_set(parts[3]) if len(parts) > 3 else set()
                    op = parts[4] if len(parts) > 4 else ""
                    for m in _IMAP_MAILS:
                        if m["uid"] not in uids:
                            continue
                        if op.startswith("+"):
                            if "\\Seen" in text and "\\Seen" not in m["flags"]:
                                m["flags"].append("\\Seen")
                        elif op.startswith("-"):
                            if "\\Seen" in text and "\\Seen" in m["flags"]:
                                m["flags"].remove("\\Seen")
                    self._ok(tag, "UID STORE completed")
                else:
                    self._ok(tag, "unsupported UID subcommand")
            else:
                self._ok(tag, "unsupported command")

smtp_srv = socketserver.TCPServer(("127.0.0.1", 0), _SmtpHandler)
imap_srv = socketserver.TCPServer(("127.0.0.1", 0), _ImapHandler)
threading.Thread(target=smtp_srv.serve_forever, daemon=True).start()
threading.Thread(target=imap_srv.serve_forever, daemon=True).start()
frames.append(json.dumps({"op": "config", "email": {
    "enabled": True, "smtpHost": "127.0.0.1", "smtpPort": smtp_srv.server_address[1], "smtpSecure": False,
    "user": "sender@example.com", "pass": "authcode", "fromName": "Cyrene",
    "imapHost": "127.0.0.1", "imapPort": imap_srv.server_address[1], "imapSecure": False}}))
c_em1 = req("send_email", {"to": ["to@example.com"], "cc": ["cc@example.com"], "subject": "Hello Subject", "body": "Hello body"})
c_em2 = req("send_email", {"to": [], "subject": "s", "body": "b"})
c_em3 = req("send_email", {"to": ["bad"], "subject": "s", "body": "b"})
c_em4 = req("email_list", {})
c_em5 = req("email_list", {"unreadOnly": True})
c_em6 = req("email_read", {"uid": 2, "markSeen": True})
c_em7 = req("email_list", {})
c_em8 = req("email_mark", {"uid": 1, "seen": False})
c_em9 = req("email_read", {"uid": 99})
c_em10 = req("email_list", {})
frames.append(json.dumps({"op": "config", "email": None}))
c_em11 = req("email_list", {})
c_em12 = req("send_email", {"to": ["a@b.com"], "subject": "s", "body": "b"})
# PR #20 复审 P1：SMTP 连接拒绝（连接阶段失败，确定未发出）→ ok=false + E_EMAIL_PRECONDITION
_refused = socket.socket()
_refused.bind(("127.0.0.1", 0))
_refused_port = _refused.getsockname()[1]
_refused.close()
frames.append(json.dumps({"op": "config", "email": {
    "enabled": True, "smtpHost": "127.0.0.1", "smtpPort": _refused_port, "smtpSecure": False,
    "user": "sender@example.com", "pass": "authcode", "fromName": "Cyrene",
    "imapHost": "127.0.0.1", "imapPort": imap_srv.server_address[1], "imapSecure": False}}))
c_em13 = req("send_email", {"to": ["to@example.com"], "subject": "s", "body": "b"})
frames.append(json.dumps({"op": "config", "email": None}))

# ast_grep：随包 CLI（__astGrepCommand 注入；搜索/校验/dryRun/写入）
import glob as _glob
def _ast_grep_cli():
    hits = []
    for exe in ("ast-grep.exe", "ast-grep"):
        # pnpm 布局：node_modules/.pnpm/@ast-grep+cli-*@ver/node_modules/@ast-grep/cli-*/<exe>
        hits += _glob.glob(os.path.join(ROOT, "node_modules", ".pnpm", "@ast-grep+cli-*",
                                        "node_modules", "@ast-grep", "cli-*", exe))
        # npm 平铺布局（CI 用 npm install）：node_modules/@ast-grep/cli-*/<exe>
        hits += _glob.glob(os.path.join(ROOT, "node_modules", "@ast-grep", "cli-*", exe))
    cli = hits[0] if hits else None
    if cli and os.name != "nt":
        try:
            os.chmod(cli, 0o755)  # npm 解包可能丢可执行位（Linux CI）
        except Exception:
            pass
    return cli

sg_ws = os.path.join(tmp, "sgws")
os.makedirs(os.path.join(sg_ws, "src"))
open(os.path.join(sg_ws, "src", "a.ts"), "w", encoding="utf-8").write('console.log("a", x);\nconst y = 1;\nconsole.log(y);\n')
open(os.path.join(sg_ws, "src", "b.ts"), "w", encoding="utf-8").write('function f() { console.log("b"); }\n')
AST_CLI = _ast_grep_cli()
SG = {"__cyreneWorkspaceRoot": sg_ws, "__astGrepCommand": AST_CLI}
c_sg1 = req("ast_grep_search", {"pattern": "console.log($$$A)", **SG})
c_sg2 = req("ast_grep_search", {"pattern": "console.log($$$A)", "paths": ["src/a.ts"], "language": "TypeScript", **SG})
c_sg3 = req("ast_grep_search", {"pattern": "zzz_no_match", **SG})
c_sg4 = req("ast_grep_search", {"pattern": "console.log($$$A)", "maxMatches": 1, **SG})
c_sg5 = req("ast_grep_search", {"pattern": "x", "language": "Bogus", **SG})
c_sg6 = req("ast_grep_search", {"pattern": "", **SG})
c_sg7 = req("ast_grep_search", {"pattern": "x", "paths": ["../escape"], **SG})
c_sg8 = req("ast_grep_replace", {"pattern": "console.log($$$A)", "rewrite": "logger.info($$$A)", "dryRun": True, **SG})
c_sg8b = req("ast_grep_search", {"pattern": "logger.info($$$A)", "paths": ["src/a.ts"], **SG})
c_sg9 = req("ast_grep_replace", {"pattern": "console.log($$$A)", "rewrite": "logger.info($$$A)", "dryRun": False, "paths": ["src/a.ts"], **SG})
c_sg9b = req("ast_grep_search", {"pattern": "logger.info($$$A)", "paths": ["src/a.ts"], **SG})
c_sg10 = req("ast_grep_search", {"pattern": "x", "__cyreneWorkspaceRoot": sg_ws})

frames.append(json.dumps({"op": "shutdown"}))
out = run(frames)
fu_srv.shutdown()
smtp_srv.shutdown()
imap_srv.shutdown()
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
raw_iso = by.get(c_now1, {}).get("data"); check("now iso（真实实现：裸 ISO 8601 串）", isinstance(raw_iso, str) and re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", raw_iso) is not None, raw_iso)
d = data_json(c_now2); check("now epoch", d is not None, d)
d = data_json(c_now3); check("now 非法 format 容错", by.get(c_now3, {}).get("ok") is True or d is not None, d)

print("\n=== clipboard / sysinfo ===")
d = data_json(c_clip1); check("clipboard（无注入平台不可用=正常）", by.get(c_clip1, {}).get("ok") is True, d)
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
l1_text = str(by.get(c_l1, {}).get("data") or "")
check("列目录", "w1.txt" in l1_text, l1_text[:160])
d = data_json(c_l2); check("列不存在目录报错", by.get(c_l2, {}).get("ok") is False, by.get(c_l2, d))

print("\n=== expense ===")
def data_text(cid):
    d = by.get(cid, {}).get("data")
    return d if isinstance(d, str) else json.dumps(d, ensure_ascii=False)

check("记账 12.5 餐饮", data_text(c_ex1) == "[record_expense] 已记录：12.5 元 / 餐饮 / 午饭", data_text(c_ex1))
check("记账 40.5 交通", data_text(c_ex2) == "[record_expense] 已记录：40.5 元 / 交通 / 打车", data_text(c_ex2))
check("记账负数拒绝", data_text(c_ex3) == "[错误] amount 必须是正数", data_text(c_ex3))
check("记账字符串金额（Number 语义）", data_text(c_ex4) == "[record_expense] 已记录：7.5 元 / 娱乐 / 电影", data_text(c_ex4))
check("记账非法字符串拒绝", data_text(c_ex5) == "[错误] amount 必须是正数", data_text(c_ex5))
eq1 = data_text(c_eq1)
check("查账汇总（60.50 + 分类键序）",
      eq1 == "[query_expense] 最近 30 天共 3 笔，合计 60.50 元\n分类：{\"餐饮\":12.5,\"交通\":40.5,\"娱乐\":7.5}", eq1)
eq2 = data_text(c_eq2)
check("查账明细三行", eq2.count("\n") == 3 and "12.5元 餐饮 午饭" in eq2 and "40.5元 交通 打车" in eq2 and "7.5元 娱乐 电影" in eq2, eq2)
check("查账字符串天数（Number 语义）", data_text(c_eq3) == eq1, data_text(c_eq3))
try:
    store = json.loads(open(os.path.join(c_exp_dir, "expenses.json"), encoding="utf-8").read())
    check("账本 JSON 三条且字段顺序可读", len(store) == 3 and store[0]["category"] == "餐饮" and store[1]["amount"] == 40.5 and store[2]["amount"] == 7.5, store)
except Exception as exc:
    check("账本 JSON 可解析", False, str(exc))

print("\n=== search_text ===")
s1 = data_json(c_s1)
paths = sorted({m.get("path") for m in (s1.get("matches") or [])}) if isinstance(s1, dict) else []
check("literal 命中 3 处且忽略 node_modules",
      isinstance(s1, dict) and s1.get("totalMatches") == 3 and paths == ["src/a.ts", "src/b.py"]
      and all("node_modules" not in str(m.get("path")) for m in s1.get("matches", [])), s1)
check("命中项带行号与上下文", isinstance(s1, dict) and s1["matches"][0].get("line") == 1
      and isinstance(s1["matches"][0].get("before"), list), s1.get("matches", [])[:1])
s2 = data_json(c_s2)
check("regex 模式大小写敏感命中 2 处", isinstance(s2, dict) and s2.get("totalMatches") == 2, s2)
s3 = data_json(c_s3)
check("未命中给 message", isinstance(s3, dict) and s3.get("totalMatches") == 0 and "未找到匹配内容" in str(s3.get("message")), s3)
s4 = data_json(c_s4)
check("字符串数值参数（Number 语义）", s4 == s1, s4)

print("\n=== str_replace ===")
sr1 = data_json(c_sr1)
check("dryRun 预检成功且不落盘", isinstance(sr1, dict) and sr1.get("prepared") is True
      and open(srf_dry, encoding="utf-8").read() == "alpha\nbeta\ngamma\n", (sr1, open(srf_dry, encoding="utf-8").read()))
sr2 = data_json(c_sr2)
check("提交替换成功 + changes", isinstance(sr2, dict) and sr2.get("success") is True
      and sr2.get("appliedEdits") == 1 and sr2.get("changes", [{}])[0].get("kind") == "modified"
      and open(srf, encoding="utf-8").read() == "alpha\nBETA\ngamma\n", sr2)
sr3 = data_json(c_sr3)
check("未命中诊断 OLD_STRING_NOT_FOUND", isinstance(sr3, dict) and sr3.get("errorCode") == "OLD_STRING_NOT_FOUND"
      and (sr3.get("diagnostic") or {}).get("kind") == "not_found", sr3)
sr4 = data_json(c_sr4)
check("空文件播种（old_string 空）",
      isinstance(sr4, dict) and sr4.get("success") is True
      and open(srf2, encoding="utf-8").read() == "seed content\n",
      (sr4, open(srf2, encoding="utf-8").read()))

print("\n=== apply_patch ===")
d0 = data_json(c_ap0)
check("dry-run prepared + hunks（不落盘）",
      isinstance(d0, dict) and d0.get("prepared") is True
      and d0.get("hunks") == [{"type": "update", "path": "dry.txt"}]
      and open(os.path.join(ap_ws, "dry.txt"), encoding="utf-8").read() == "d1\nd2\n", d0)
d1 = data_json(c_ap1)
check("更新+新增事务成功",
      isinstance(d1, dict) and d1.get("success") is True
      and d1.get("applied") == ["更新文件: a.txt", "新增文件: sub/new.txt"], d1)
check("更新内容落盘（保留 LF）",
      open(os.path.join(ap_ws, "a.txt"), encoding="utf-8").read() == "alpha\nBETA\ngamma\n")
check("新增文件落盘",
      open(os.path.join(ap_ws, "sub", "new.txt"), encoding="utf-8").read() == "hello\nworld")
check("evidence changes（modified/added + diff 行序）",
      isinstance(d1, dict) and [c.get("kind") for c in d1.get("changes", [])] == ["modified", "added"]
      and d1["changes"][0].get("insertions") == 1 and d1["changes"][0].get("deletions") == 1
      and [l.get("type") for l in d1["changes"][0].get("diff", [])] == ["context", "remove", "add", "context"]
      and d1["changes"][1].get("insertions") == 2, d1.get("changes"))
d = data_json(c_ap2)
check("dry-run 预检失败透传", isinstance(d, dict) and d.get("success") is False
      and d.get("errors") == ["a.txt: 第 1 个编辑块未找到匹配的上下文"], d)
d = data_json(c_ap3)
check("正式调用预检失败（同错误）", isinstance(d, dict) and d.get("success") is False
      and d.get("errors") == ["a.txt: 第 1 个编辑块未找到匹配的上下文"], d)
d = data_json(c_ap4)
check("新增已存在拒绝", isinstance(d, dict) and d.get("errors") == ["文件已存在，无法新增: a.txt"], d)
d = data_json(c_ap5)
check("删除不存在拒绝", isinstance(d, dict) and d.get("errors") == ["文件不存在，无法删除: ghost.txt"], d)
d = data_json(c_ap6)
check("路径逃逸拒绝", isinstance(d, dict) and d.get("errors") == ["路径逃逸: ../escape.txt 在工作区外"], d)
d = data_json(c_ap7)
check("事务原子性：任一失败全部不执行",
      isinstance(d, dict) and d.get("success") is False
      and not os.path.exists(os.path.join(tmp, "escape2.txt"))
      and open(os.path.join(ap_ws, "a.txt"), encoding="utf-8").read() == "alpha\nBETA\ngamma\n", d)
d = data_json(c_ap8)
check("Move to 更新并移动",
      isinstance(d, dict) and d.get("success") is True
      and d.get("applied") == ["更新并移动: m.txt → moved/m.txt"]
      and os.path.exists(os.path.join(ap_ws, "moved", "m.txt"))
      and not os.path.exists(os.path.join(ap_ws, "m.txt"))
      and d.get("changes", [{}])[0].get("file") == "moved/m.txt"
      and d["changes"][0].get("kind") == "renamed", d)
d = data_json(c_ap9)
check("非补丁文本拒绝", isinstance(d, dict) and d.get("errors") == ["patch 必须以 *** Begin Patch 开头"], d)

print("\n=== download_file（黑名单扩展）===")
check("hta 扩展名拒绝", data_text(c_dl1) == "[错误] 禁止下载可执行/脚本文件: .hta", data_text(c_dl1))
check("js 扩展名拒绝", data_text(c_dl2) == "[错误] 禁止下载可执行/脚本文件: .js", data_text(c_dl2))
check("wsf 扩展名拒绝", data_text(c_dl3) == "[错误] 禁止下载可执行/脚本文件: .wsf", data_text(c_dl3))

print("\n=== web_search（config 帧 + 校验路径）===")
def ws_error(cid):
    f = by.get(cid, {})
    return f.get("error") if isinstance(f, dict) and f.get("ok") is False else None

check("ws 未启用拒绝", ws_error(c_ws1) == "E_SEARCH_NOT_ENABLED", by.get(c_ws1))
check("ws 缺 key 拒绝", ws_error(c_ws2) == "E_SEARCH_KEY_MISSING", by.get(c_ws2))
check("ws 空 query 拒绝（先于 key 校验）", ws_error(c_ws3) == "E_SEARCH_QUERY_EMPTY", by.get(c_ws3))
check("ws 未知引擎拒绝", ws_error(c_ws4) == "E_SEARCH_ENGINE_NOT_SUPPORTED:no-such", by.get(c_ws4))

print("\n=== weather / plan_trip（config 帧 + 确定性路径）===")
check("weather 未启用", data_text(c_wt1) == "[错误] 天气查询功能未启用，请在设置里开启", data_text(c_wt1))
check("weather 无城市提示",
      data_text(c_wt2) == "[提示] 没有指定城市，也没设置默认城市。请告诉用户：在 设置 → 我的信息 填默认城市，或直接说出要查的城市名。",
      data_text(c_wt2))
check("weather 未知源", data_text(c_wt3) == "[错误] 未知的天气源\"bogus\"。请在 设置 → 插件 → 天气查询 选择 Open-Meteo 或 高德天气。", data_text(c_wt3))
check("weather 高德缺 key",
      data_text(c_wt4) == "[错误] 还没有配置高德天气 Key。请在 设置 → 插件 → 天气查询 填入高德 Key，或切换天气源为 Open-Meteo（免配置）。",
      data_text(c_wt4))
check("plan_trip 未启用", data_text(c_pt1) == "[错误] 出行工具未启用，请在设置里开启", data_text(c_pt1))
check("plan_trip 缺 key",
      data_text(c_pt2) == "[提示] 高德 API Key 未配置。可在 设置→插件 中找到 🚗出行工具，填入高德 Web 服务 API Key（注册地址：https://lbs.amap.com）。",
      data_text(c_pt2))
check("plan_trip 缺起点", data_text(c_pt3) == "[错误] 请提供起点和终点", data_text(c_pt3))

print("\n=== fetch_url（本地 HTTP fixture + GitHub API mock）===")
fu1 = data_text(c_fu1)
check("fetch_url markdown 正文提取（标题/列表/代码/表格）",
      "# 大标题" in fu1 and "- 项目一" in fu1 and "```" in fu1 and "| 列A |" in fu1, fu1[:200])
check("fetch_url 剥导航/页头/页脚/侧栏",
      "导航链接" not in fu1 and "页头" not in fu1 and "页脚" not in fu1 and "侧栏" not in fu1, fu1[:200])
check("fetch_url 缓存命中标注", data_text(c_fu2).startswith("[缓存] 摄取于 "), data_text(c_fu2)[:60])
fu3 = data_text(c_fu3)
check("fetch_url raw 原文（不转换）", "<article>" in fu3 and "Content-Type: text/html" in fu3, fu3[:120])
fu4 = data_text(c_fu4)
check("fetch_url 512KB 截断标注", "[已截断到 524288 字节]" in fu4, fu4[:160])
check("fetch_url 404", data_text(c_fu5).startswith("[错误] HTTP 404"), data_text(c_fu5))
check("fetch_url 非法协议拒绝", data_text(c_fu6) == "[错误] url 必须以 http:// 或 https:// 开头", data_text(c_fu6))
fu7 = data_text(c_fu7)
check("fetch_url GitHub API 特化（元信息 + README）",
      "# o/r" in fu7 and "> 演示仓库" in fu7 and "stars: 42" in fu7 and "license: MIT" in fu7
      and "这是 README 正文" in fu7, fu7[:300])

print("\n=== 文档四件（write_markdown / write_excel / write_word / write_pdf）===")
import zipfile
d = data_json(c_dm1)
check("write_markdown 新建（added 证据 2 行）", d and d.get("success") and d.get("append") is False
      and d["changes"][0].get("kind") == "added" and d["changes"][0].get("insertions") == 2, d)
check("write_markdown 新建文件内容", open(DOC_MD_NEW, encoding="utf-8").read() == "第一行\n第二行",
      open(DOC_MD_NEW, encoding="utf-8").read())
d = data_json(c_dm2b)
check("write_markdown 追加补换行（added 1 行）", d and d.get("append") is True
      and d["changes"][0].get("insertions") == 1
      and open(DOC_MD_APPEND, encoding="utf-8").read() == "第一行\n第二行\n第三行", d)
d = data_json(c_dm3b)
check("write_markdown 覆盖（modified 3→1 + remove/add diff）", d and d["changes"][0].get("kind") == "modified"
      and d["changes"][0].get("insertions") == 1 and d["changes"][0].get("deletions") == 3
      and [l.get("type") for l in d["changes"][0]["diff"]] == ["remove", "remove", "remove", "add"], d)
check("write_markdown 空 path 拒绝", by.get(c_dm4, {}).get("ok") is False, by.get(c_dm4))

check("write_excel 生成结果文案", data_text(c_dx1) == "[write_excel] 已生成：" + DOC_XLSX, data_text(c_dx1))
if os.path.exists(DOC_XLSX):
    z = zipfile.ZipFile(DOC_XLSX)
    ss = z.read("xl/sharedStrings.xml").decode("utf-8")
    st = z.read("xl/styles.xml").decode("utf-8")
    sh = z.read("xl/worksheets/sheet1.xml").decode("utf-8")
    check("write_excel 单元格值（sharedStrings）",
          all(s in ss for s in ["姓名", "分数", "比率", "张三", "李四"]), ss[:200])
    check("write_excel 数字格式（0.0% / #,##0 / #,##0.00）",
          'formatCode="0.0%"' in st and 'formatCode="#,##0"' in st and 'formatCode="#,##0.00"' in st, "")
    check("write_excel 主题色（表头/斑马纹 solid fill）",
          'rgb="FF1F4E79"' in st and 'rgb="FFF2F2F2"' in st, "")
    check("write_excel 冻结首行 + 自动筛选 + 列宽",
          "<x:pane" in sh and 'ySplit="1"' in sh and "<x:autoFilter" in sh and "<x:cols>" in sh, "")
else:
    check("write_excel 文件存在", False)
check("write_excel sheets 为空拒绝", by.get(c_dx2, {}).get("ok") is False, by.get(c_dx2))

check("write_word 生成结果文案", data_text(c_dw1) == "[write_word] 已生成：" + DOC_DOCX, data_text(c_dw1))
if os.path.exists(DOC_DOCX):
    doc = zipfile.ZipFile(DOC_DOCX).read("word/document.xml").decode("utf-8")
    check("write_word 文本与样式（标题/正文/字号/颜色/加粗/行距）",
          "季度报告" in doc and "第一段正文。" in doc and "第二段正文。" in doc
          and 'w:val="28"' in doc and 'w:val="24"' in doc
          and 'w:val="1F4E79"' in doc and 'w:val="333333"' in doc
          and "<w:b />" in doc and 'w:after="200"' in doc and 'w:after="120"' in doc, doc[:200])
else:
    check("write_word 文件存在", False)
check("write_word 空 path 拒绝", by.get(c_dw2, {}).get("ok") is False, by.get(c_dw2))

check("write_pdf 生成结果文案", data_text(c_dp1) == "[write_pdf] 已生成：" + DOC_PDF, data_text(c_dp1))
check("write_pdf 文件签名", os.path.exists(DOC_PDF) and open(DOC_PDF, "rb").read(5) == b"%PDF-")
check("write_pdf 空 path 拒绝", by.get(c_dp2, {}).get("ok") is False, by.get(c_dp2))
if os.path.exists(DOC_PDF):
    probe = subprocess.run(["dotnet", NATIVE, "--pdf-text", DOC_PDF], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", cwd=ROOT)
    pdf_text = probe.stdout or ""
    ascii_ok = "PDF Report" in pdf_text and "Alpha" in pdf_text and "Beta" in pdf_text
    # Linux 无 CJK 字体（QuestPDF 回退 Lato），中文断言仅在 Windows 跑
    cjk_ok = os.name != "nt" or ("合作协议" in pdf_text and "甲方：示例公司" in pdf_text and "乙方：测试公司" in pdf_text)
    check("write_pdf 文本提取（标题/段落）", ascii_ok and cjk_ok, pdf_text[:120])
else:
    check("write_pdf 文本提取（文件缺失）", False)

print("\n=== 邮件四件（fake SMTP + fake IMAP）===")
check("send_email 成功文案", data_text(c_em1) == "[send_email] 已发送：to@example.com 主题：Hello Subject", data_text(c_em1))
if _SMTP_MESSAGES:
    raw = _SMTP_MESSAGES[-1]
    check("send_email SMTP 捕获（To/Cc/Subject/正文）",
          "to@example.com" in raw and "cc@example.com" in raw and "Hello Subject" in raw and "Hello body" in raw,
          raw[:220])
else:
    check("send_email SMTP 捕获", False)
check("send_email 空收件人拒绝", data_text(c_em2) == "[错误] 收件人列表为空", data_text(c_em2))
check("send_email 收件人无效拒绝", data_text(c_em3) == "[错误] 收件人邮箱无效：bad", data_text(c_em3))
el4 = data_text(c_em4)
check("email_list 两封（uid/已读/发件人/主题）",
      "uid=2" in el4 and "uid=1" in el4 and "未读" in el4 and "已读" in el4
      and "Sender A <a@example.com>" in el4 and "Hello One" in el4 and "共 2 封" in el4, el4[:220])
el5 = data_text(c_em5)
check("email_list 仅未读（uid=2）", "uid=2" in el5 and "uid=1" not in el5 and "未读" in el5, el5[:220])
er6 = data_text(c_em6)
check("email_read 详情（主题/发件人/收件人/附件/正文）",
      "uid=2" in er6 and "Hello Two" in er6 and "Sender B <b@example.com>" in er6
      and "to@example.com" in er6 and "note.txt" in er6 and "Body two" in er6, er6[:300])
el7 = data_text(c_em7)
check("email_read 默认标已读（再列两封均已读）", el7.count("已读") == 2, el7[:220])
check("email_mark 标未读", data_text(c_em8) == "[email_mark] uid=1 已标记为未读（folder=INBOX）", data_text(c_em8))
el10 = data_text(c_em10)
check("email_mark 生效（uid=1 未读）", "uid=1" in el10 and "未读" in el10, el10[:220])
check("email_read 不存在 uid", data_text(c_em9) == "[错误] 未找到 uid=99 的邮件（folder=INBOX）", data_text(c_em9))
check("email 关闭后校验（list）", data_text(c_em11) == "[错误] 邮件功能未启用，请在设置里开启", data_text(c_em11))
check("email 关闭后校验（send）", data_text(c_em12) == "[错误] 邮件功能未启用，请在设置里开启", data_text(c_em12))
r_em13 = by.get(c_em13, {})
check("send_email SMTP 连接拒绝 → ok=false 且 E_EMAIL_PRECONDITION",
      r_em13.get("ok") is False and r_em13.get("errorCode") == "E_EMAIL_PRECONDITION", r_em13)

print("\n=== ast_grep（随包 CLI）===")
if not AST_CLI:
    # CI 的矩阵步骤早于 npm install（node 依赖此时未安装）；ast-grep 由后续 dual-track 步骤覆盖
    print("[SKIP] ast-grep CLI 未安装（本地安装 pnpm deps 后全量跑；CI 由 dual-track 覆盖）")
else:
    check("ast-grep CLI 已解析", True)
    d = data_json(c_sg1)
    check("ast_grep_search 全工作区（3 处 / 2 文件 / 坐标）",
          d and d.get("matchCount") == 3 and d.get("filesWithMatches") == 2 and d.get("scannedFiles") == 2
          and d["matches"][0] == {"line": 1, "column": 1, "endLine": 1, "text": 'console.log("a", x)', "file": "src/a.ts"}, d)
    d = data_json(c_sg2)
    check("ast_grep_search 限定路径/语言", d and d.get("scannedFiles") == 1 and d.get("matchCount") == 2
          and d.get("language") == "TypeScript", d)
    d = data_json(c_sg3)
    check("ast_grep_search 无匹配", d and d.get("matchCount") == 0 and d.get("truncated") is False, d)
    d = data_json(c_sg4)
    check("ast_grep_search maxMatches 截断", d and d.get("matchCount") == 1 and d.get("truncated") is True, d)
    d = data_json(c_sg5)
    check("ast_grep_search 非法语言", d and d.get("success") is False and "不支持的语言" in d["errors"][0], d)
    d = data_json(c_sg6)
    check("ast_grep_search 空 pattern", d and d.get("errors")[0] == "pattern 参数不能为空", d)
    d = data_json(c_sg7)
    check("ast_grep_search 路径逃逸跳过", d and d.get("scannedFiles") == 0 and "skipped" in d, d)
    d = data_json(c_sg8)
    check("ast_grep_replace dryRun（2 文件 / 3 处 + diff 证据）",
          d and d.get("dryRun") is True and d.get("filesToChange") == 2 and d.get("totalMatches") == 3
          and d["changes"][0]["diff"][1]["text"] == 'logger.info("a", x)'
          and "note" in d, d)
    d = data_json(c_sg8b)
    check("ast_grep_replace dryRun 不落盘", d and d.get("matchCount") == 0, d)
    d = data_json(c_sg9)
    check("ast_grep_replace 写入（限定路径）", d and d.get("dryRun") is False and d.get("changedFiles") == 1
          and d.get("changed") == ["src/a.ts"], d)
    d = data_json(c_sg9b)
    check("ast_grep_replace 落盘生效（改写后可搜到）", d and d.get("matchCount") == 2, d)
    check("ast_grep_replace 落盘内容", open(os.path.join(sg_ws, "src", "a.ts"), encoding="utf-8").read()
          == 'logger.info("a", x);\nconst y = 1;\nlogger.info(y);\n', open(os.path.join(sg_ws, "src", "a.ts"), encoding="utf-8").read())
    f10 = by.get(c_sg10, {})
    check("ast_grep_search 缺 CLI 错误帧", f10.get("ok") is False and "ast-grep CLI 不可用" in (f10.get("error") or ""), f10)

print("\n=== git ===")
if not shutil.which("git"):
    print("[SKIP] git 段（未检测到系统 git）")
else:
    gbase = tempfile.mkdtemp(prefix="tools-git-")
    atexit.register(lambda: shutil.rmtree(gbase, ignore_errors=True))
    grepo = os.path.join(gbase, "repo")
    os.makedirs(grepo)
    gplain = os.path.join(gbase, "plain")
    os.makedirs(gplain)
    GITC = {"__gitCommand": "git", "__gitSource": "system", "__gitVersion": "matrix"}
    GIDENT = {"name": "Matrix", "email": "matrix@test.local"}

    def grun(calls):
        frames = [json.dumps({"op": "call", "callId": cid, "tool": tool, "args": args}) for cid, tool, args in calls]
        frames.append(json.dumps({"op": "shutdown"}))
        out = run(frames)
        return {f.get("callId"): f for f in out if isinstance(f, dict) and f.get("op") == "result"}

    def gdata(by, cid):
        d = by.get(cid, {}).get("data")
        if isinstance(d, str):
            try: return json.loads(d)
            except Exception: return {"_raw": d[:100]}
        return d

    # 批 1：init + 播种文件（真实仓库）
    g = grun([("g_init", "git_init", {"__cyreneRoot": grepo, **GITC})])
    check("git init 输出", g.get("g_init", {}).get("ok") is True
          and g["g_init"].get("data") == "已初始化 Git 仓库", g.get("g_init"))
    open(os.path.join(grepo, "a.txt"), "w", encoding="utf-8").write("alpha\nbeta\ngamma\n")
    os.makedirs(os.path.join(grepo, "sub"))
    open(os.path.join(grepo, "sub", "b.txt"), "w", encoding="utf-8").write("one\ntwo\n")

    # 批 2：未提交 status / 无 HEAD diff / commit（40 位 hash）
    g = grun([
        ("g_status1", "git_status", {"__cyreneRoot": grepo, "__sessionId": "gs1", **GITC}),
        ("g_diff0", "git_diff", {"__cyreneRoot": grepo, **GITC}),
        ("g_commit1", "git_commit", {"message": "initial commit", "paths": ["a.txt", "sub/b.txt"],
                                      "__cyreneRoot": grepo, "__gitIdentity": GIDENT, "__sessionId": "gs1", **GITC}),
    ])
    d = gdata(g, "g_status1")
    check("git status 未提交（untracked/行数/空分支）",
          isinstance(d, dict) and d.get("state") == "ready" and d["branch"]["current"] == "main"
          and d["branch"]["branches"] == [] and [f["path"] for f in d["files"]] == ["a.txt", "sub/b.txt"]
          and [f["kind"] for f in d["files"]] == ["added", "added"] and d["files"][0]["insertions"] == 3
          and d["lines"]["insertions"] == 5 and d["lines"]["deletions"] == 0
          and d["summary"] == {"added": 2, "modified": 0, "deleted": 0, "renamed": 0, "conflicted": 0}, d)
    check("git status 未提交 staged/unstaged=false",
          isinstance(d, dict) and all(f["staged"] is False and f["unstaged"] is False for f in d["files"]), d)
    d = gdata(g, "g_diff0")
    check("git diff 无 HEAD 视为空",
          isinstance(d, dict) and d.get("patch") == "" and d.get("changes") == [] and d.get("perFile") == [], d)
    commit_text = g.get("g_commit1", {}).get("data")
    check("git commit 输出 40 位 hash",
          isinstance(commit_text, str) and re.match(r"^已创建提交 [0-9a-f]{40}$", commit_text), commit_text)
    g_hash = commit_text.split(" ")[-1] if isinstance(commit_text, str) else ""

    # 批 3：提交后修改/新增的 status + diff + log
    open(os.path.join(grepo, "a.txt"), "w", encoding="utf-8").write("alpha\nBETA\ngamma\n")
    open(os.path.join(grepo, "c.txt"), "w", encoding="utf-8").write("new file\nline2\n")
    # 独立配置文件（IKJMO8）：__gitConfigGlobal 注入生效的可观察点（diff noprefix）
    gcfg = os.path.join(gbase, "dedicated.gitconfig")
    with open(gcfg, "w", encoding="utf-8") as cfg_handle:
        cfg_handle.write("[diff]\n\tnoprefix = true\n")
    g = grun([
        ("g_status2", "git_status", {"__cyreneRoot": grepo, "__sessionId": "gs1", **GITC}),
        ("g_diff1", "git_diff", {"__cyreneRoot": grepo, **GITC}),
        ("g_log1", "git_log", {"__cyreneRoot": grepo, **GITC}),
        ("g_diff_cfg", "git_diff", {"__cyreneRoot": grepo, "__gitConfigGlobal": gcfg, **GITC}),
    ])
    d = gdata(g, "g_status2")
    check("git status 混合变更（modified/added + 行数）",
          isinstance(d, dict) and {f["path"]: (f["kind"], f["staged"], f["unstaged"]) for f in d["files"]}
          == {"a.txt": ("modified", False, True), "c.txt": ("added", False, False)}
          and d["lines"]["insertions"] == 3 and d["lines"]["deletions"] == 1
          and d["summary"] == {"added": 1, "modified": 1, "deleted": 0, "renamed": 0, "conflicted": 0}, d)
    d = gdata(g, "g_diff1")
    g_types = [l.get("type") for l in (d.get("changes", [{}])[0].get("diff") or [])] if isinstance(d, dict) else []
    check("git diff 工作区（patch/perFile/changes 行序）",
          isinstance(d, dict) and d.get("perFile") == [{"file": "a.txt", "insertions": 1, "deletions": 1}]
          and "-beta" in d.get("patch", "") and "+BETA" in d.get("patch", "")
          and [c.get("kind") for c in d.get("changes", [])] == ["modified"]
          and g_types == ["hunk", "context", "remove", "add", "context", "context"], d)
    patch_default = d.get("patch", "") if isinstance(d, dict) else ""
    d = gdata(g, "g_diff_cfg")
    patch_cfg = d.get("patch", "") if isinstance(d, dict) else ""
    check("独立配置文件生效（__gitConfigGlobal → diff noprefix）",
          "--- a/a.txt" in patch_default and "--- a.txt" in patch_cfg and "--- a/a.txt" not in patch_cfg,
          f"default={patch_default[:60]!r} cfg={patch_cfg[:60]!r}")
    d = gdata(g, "g_log1")
    check("git log 单条（hash/日期/作者/信息）",
          isinstance(d, list) and len(d) == 1 and d[0]["message"] == "initial commit"
          and re.match(r"^[0-9a-f]{40}$", d[0]["hash"]) and re.match(r"^\d{4}-\d{2}-\d{2}$", d[0]["date"])
          and d[0]["author"] == "Matrix", d)

    # 批 4：分支切换 + 提交 + revert（HEAD 反向）
    g = grun([("g_switch", "git_switch_branch", {"branch": "feat", "create": "true", "__cyreneRoot": grepo, "__sessionId": "gs1", **GITC})])
    check("git switch 创建 feat", g.get("g_switch", {}).get("data") == "已切换到分支 feat", g.get("g_switch"))
    g = grun([
        ("g_status3", "git_status", {"__cyreneRoot": grepo, "__sessionId": "gs1", **GITC}),
        ("g_commit2", "git_commit", {"message": "feat changes", "paths": ["a.txt"],
                                      "__cyreneRoot": grepo, "__gitIdentity": GIDENT, "__sessionId": "gs1", **GITC}),
    ])
    d = gdata(g, "g_status3")
    check("git status feat 分支列表（feat/main 排序）",
          isinstance(d, dict) and d["branch"]["current"] == "feat" and d["branch"]["branches"] == ["feat", "main"], d)
    commit2_text = g.get("g_commit2", {}).get("data")
    check("git commit #2 输出", isinstance(commit2_text, str) and re.match(r"^已创建提交 [0-9a-f]{40}$", commit2_text), commit2_text)
    g_hash2 = commit2_text.split(" ")[-1] if isinstance(commit2_text, str) else ""
    g = grun([("g_revert", "git_revert", {"commit": g_hash2[:12], "__cyreneRoot": grepo, "__gitIdentity": GIDENT, "__sessionId": "gs1", **GITC})])
    check("git revert 消息", g.get("g_revert", {}).get("data") == f"已创建回退提交 {g_hash2[:12]}"
          and g.get("g_revert", {}).get("ok") is True, g.get("g_revert"))

    # 批 5：push（本地 bare 远程：建立跟踪 → 已跟踪）+ log 复核
    subprocess.run(["git", "init", "--bare", os.path.join(gbase, "remote.git")], capture_output=True, text=True)
    subprocess.run(["git", "-C", grepo, "remote", "add", "origin", os.path.join(gbase, "remote.git")], capture_output=True, text=True)
    g = grun([
        ("g_push1", "git_push", {"__cyreneRoot": grepo, "__sessionId": "gs1", **GITC}),
        ("g_status4", "git_status", {"__cyreneRoot": grepo, "__sessionId": "gs1", **GITC}),
        ("g_log2", "git_log", {"__cyreneRoot": grepo, "__sessionId": "gs1", **GITC}),
    ])
    check("git push 建立跟踪（origin/feat）",
          g.get("g_push1", {}).get("data") == "已推送到 origin/feat 并建立跟踪关系", g.get("g_push1"))
    d = gdata(g, "g_status4")
    check("git status 跟踪 origin/feat（ahead=0）",
          isinstance(d, dict) and d["branch"]["tracking"] == "origin/feat" and d["ahead"] == 0 and d["behind"] == 0, d)
    d = gdata(g, "g_log2")
    check("git log revert 后（3 条，首条为 Revert）",
          isinstance(d, list) and len(d) == 3 and d[0]["message"] == 'Revert "feat changes"', d)

    # 批 6：已跟踪的二次 push
    open(os.path.join(grepo, "d.txt"), "w", encoding="utf-8").write("push me\n")
    g = grun([
        ("g_commit3", "git_commit", {"message": "third commit", "paths": ["d.txt"],
                                      "__cyreneRoot": grepo, "__gitIdentity": GIDENT, "__sessionId": "gs1", **GITC}),
        ("g_push2", "git_push", {"__cyreneRoot": grepo, "__sessionId": "gs1", **GITC}),
    ])
    check("git push 已跟踪（不带 --set-upstream）",
          g.get("g_push2", {}).get("data") == "已推送到 origin", g.get("g_push2"))

    # 批 7：非仓库 + 错误路径（校验先于命令，不产生副作用）
    g = grun([
        ("g_norepo", "git_status", {"__cyreneRoot": gplain, "__sessionId": "gs2", **GITC}),
        ("g_bad_ident", "git_commit", {"message": "x", "paths": ["a.txt"], "__cyreneRoot": grepo, "__sessionId": "gs1", **GITC}),
        ("g_bad_ref", "git_diff", {"ref": "", "__cyreneRoot": grepo, **GITC}),
        ("g_bad_branch", "git_switch_branch", {"branch": "bad..name", "__cyreneRoot": grepo, "__sessionId": "gs1", **GITC}),
        ("g_bad_path", "git_commit", {"message": "x", "paths": ["../escape.txt"], "__cyreneRoot": grepo, "__gitIdentity": GIDENT, "__sessionId": "gs1", **GITC}),
        ("g_bad_count", "git_log", {"maxCount": 0, "__cyreneRoot": grepo, **GITC}),
        ("g_bad_revert", "git_revert", {"commit": "zzz", "__cyreneRoot": grepo, "__sessionId": "gs1", **GITC}),
        ("g_revert_noident", "git_revert", {"commit": g_hash2[:12], "__cyreneRoot": grepo, "__sessionId": "gs1", **GITC}),
    ])
    d = gdata(g, "g_norepo")
    check("git status 非仓库（not_repository 形状）",
          isinstance(d, dict) and d.get("state") == "not_repository" and d.get("message") == "这个目录还不是 Git 仓库"
          and d.get("executable") is None and d.get("branch") is None and d.get("files") == [], d)
    for cid, name in [("g_bad_ident", "无身份拒绝"), ("g_bad_ref", "空 ref 拒绝"), ("g_bad_branch", "非法分支名拒绝"),
                      ("g_bad_path", "路径逃逸拒绝"), ("g_bad_count", "maxCount 0 拒绝"), ("g_bad_revert", "非法 hash 拒绝")]:
        check(f"git 校验（{name}）", g.get(cid, {}).get("ok") is False, g.get(cid))
    check("git 校验（无身份 revert → 友好错误）",
          g.get("g_revert_noident", {}).get("ok") is False
          and "Git 提交邮箱" in (g.get("g_revert_noident", {}).get("error") or ""),
          g.get("g_revert_noident"))

passed = sum(1 for _, ok, _ in results if ok)
print(f"\n{'='*50}\n工具矩阵汇总: {passed} passed / {len(results)-passed} failed")
sys.exit(0 if passed == len(results) else 1)
