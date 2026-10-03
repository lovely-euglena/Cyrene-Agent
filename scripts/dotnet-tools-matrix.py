#!/usr/bin/env python3
"""tool-host 全工具逐项调用矩阵（真实调用验证）。

calculator / now / clipboard / sysinfo / fs / expense / search_text /
str_replace / apply_patch / download_file / git 八件（真实仓库 + 本地 bare 远程）
每个工具多组输入：正常 + 参数缺失 + 参数类型错。验响应形状与错误语义。
"""
import subprocess, json, os, tempfile, sys, re, shutil

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

print("\n=== git ===")
if not shutil.which("git"):
    print("[SKIP] git 段（未检测到系统 git）")
else:
    gbase = tempfile.mkdtemp(prefix="tools-git-")
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
    g = grun([
        ("g_status2", "git_status", {"__cyreneRoot": grepo, "__sessionId": "gs1", **GITC}),
        ("g_diff1", "git_diff", {"__cyreneRoot": grepo, **GITC}),
        ("g_log1", "git_log", {"__cyreneRoot": grepo, **GITC}),
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
    g = grun([("g_revert", "git_revert", {"commit": g_hash2[:12], "__cyreneRoot": grepo, "__sessionId": "gs1", **GITC})])
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
    ])
    d = gdata(g, "g_norepo")
    check("git status 非仓库（not_repository 形状）",
          isinstance(d, dict) and d.get("state") == "not_repository" and d.get("message") == "这个目录还不是 Git 仓库"
          and d.get("executable") is None and d.get("branch") is None and d.get("files") == [], d)
    for cid, name in [("g_bad_ident", "无身份拒绝"), ("g_bad_ref", "空 ref 拒绝"), ("g_bad_branch", "非法分支名拒绝"),
                      ("g_bad_path", "路径逃逸拒绝"), ("g_bad_count", "maxCount 0 拒绝"), ("g_bad_revert", "非法 hash 拒绝")]:
        check(f"git 校验（{name}）", g.get(cid, {}).get("ok") is False, g.get(cid))

passed = sum(1 for _, ok, _ in results if ok)
print(f"\n{'='*50}\n工具矩阵汇总: {passed} passed / {len(results)-passed} failed")
sys.exit(0 if passed == len(results) else 1)
