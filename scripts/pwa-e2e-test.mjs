#!/usr/bin/env node
/**
 * 手机 PWA 端到端冒烟（IKJK2L 验收）：
 *   桌面离线 → 手机配对登录 → 打开最近会话 → 发送文字 → 收到服务端生成回复 → 离线只读缓存。
 *
 * 组成：真实 cloud-server（发布产物）+ 进程内 mock LLM + Playwright（默认 Microsoft Edge；
 *   CYRENE_PWA_BROWSER=chromium 可切 Chromium，CI 用 msedge 通道）。
 * 前置：
 *   ① 构建 PWA：npm --prefix src/pwa run build（产物进 dotnet/cloud-server/wwwroot）；
 *   ② 发布 cloud-server：dotnet publish dotnet/cloud-server -c Release -o artifacts/cyrene-cloud（wwwroot 随产物）。
 * 运行：
 *   node scripts/pwa-e2e-test.mjs [发布产物 dll 路径]                      # 本地（起服务 + mock LLM，断言生成回复）
 *   node scripts/pwa-e2e-test.mjs --base-url URL --master-token TOKEN      # 远端（不 spawn；默认不断言生成回复）
 *   node scripts/pwa-e2e-test.mjs --base-url URL --master-token TOKEN --expect-echo   # 远端且部署接了回声 mock
 *   [--user-agent UA]   # 覆盖 Node 侧请求 UA（部分 WAF 如 CF Bot Fight Mode 会拦脚本 UA）
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARGV = process.argv.slice(2);

function argValue(name) {
  const index = ARGV.indexOf(name);
  return index >= 0 ? ARGV[index + 1] : undefined;
}

const BASE_URL_ARG = argValue("--base-url");
const MASTER_TOKEN_ARG = argValue("--master-token");
/** 覆盖 Node 侧请求 UA（部分 WAF 如 CF Bot Fight Mode 会拦脚本 UA；不传 = Node 默认 UA）。 */
const USER_AGENT_ARG = argValue("--user-agent");
/** 远端默认不断言生成回复文本（需部署接回声 mock 时用 --expect-echo 显式开启）。 */
const EXPECT_ECHO = ARGV.includes("--expect-echo") || !BASE_URL_ARG;
const DLL = (() => {
  const valueFlags = new Set(["--base-url", "--master-token", "--user-agent"]);
  for (let index = 0; index < ARGV.length; index++) {
    const item = ARGV[index];
    if (valueFlags.has(item)) {
      index++;
      continue;
    }
    if (item.startsWith("--")) continue;
    return resolve(item);
  }
  return join(REPO_ROOT, "dotnet/cloud-server/bin/Release/net10.0/cyrene-cloud-server.dll");
})();
const MASTER_TOKEN = MASTER_TOKEN_ARG ?? "pwa-e2e-master";
const SESSION_ID = `sess-desktop-${Math.floor(Date.now() / 1000)}`;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${!ok && detail ? ` —— ${detail}` : ""}`);
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
    probe.on("error", reject);
  });
}

async function waitFor(fn, { timeoutMs = 15000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // 未就绪：继续重试
    }
    if (Date.now() > deadline) return null;
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
}

async function httpJson(method, url, body, headers = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(USER_AGENT_ARG ? { "User-Agent": USER_AGENT_ARG } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // 非 JSON 响应：保留原文供诊断
  }
  return { status: response.status, body: parsed, text };
}

/** 进程内 OpenAI 兼容 mock：回复「回声：<最后一条 user 文本>」。 */
function startMockLlm() {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let payload = {};
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        // 空请求体按空处理
      }
      requests.push(payload);
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const lastUser = [...messages].reverse().find((item) => item?.role === "user")?.content ?? "";
      const body = JSON.stringify({
        choices: [{ message: { role: "assistant", content: `回声：${lastUser}` } }],
        usage: { prompt_tokens: 8, completion_tokens: 6 },
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    });
  });
  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => {
      resolveServer({ server, requests, port: server.address().port });
    });
  });
}

async function startServer(dataDir, llmPort, port) {
  const env = {
    ...process.env,
    CYRENE_CLOUD_DATA: dataDir,
    CLOUD_TOKEN: MASTER_TOKEN,
    CLOUD_LLM_API_KEY: "sk-e2e",
    CLOUD_LLM_MODEL: "mock-model",
    CLOUD_LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
    CLOUD_LLM_TIMEOUT_SECONDS: "15",
    ASPNETCORE_URLS: `http://127.0.0.1:${port}`,
  };
  const child = spawn("dotnet", [DLL], { env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", (chunk) => {
    logs += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    logs += chunk.toString();
  });
  const base = `http://127.0.0.1:${port}`;
  const ready = await waitFor(async () => (await fetch(`${base}/healthz`)).status === 200, { timeoutMs: 30000 });
  if (!ready) {
    throw new Error(`cloud-server 未就绪：\n${logs.slice(-2000)}`);
  }
  return { child, base, getLogs: () => logs };
}

/** 桌面设备种子：session.create + 一条 user 消息（触发服务端生成，充当“最近会话”历史）。 */
async function seedDesktopSession(base) {
  const codeResponse = await httpJson("POST", `${base}/v1/pair/code`, undefined, {
    Authorization: `Bearer ${MASTER_TOKEN}`,
  });
  const pairResponse = await httpJson("POST", `${base}/v1/pair`, {
    code: codeResponse.body.code,
    deviceName: "桌面",
  });
  const desktop = pairResponse.body;
  const events = [
    {
      eventId: "desk-1",
      sessionId: SESSION_ID,
      type: "session.create",
      lamport: 1,
      deviceId: desktop.deviceId,
      seq: 1,
      ts: "2026-10-04T01:00:00.000Z",
      payload: { title: "最近会话", createdAt: "2026-10-04T01:00:00.000Z" },
    },
    {
      eventId: "desk-2",
      sessionId: SESSION_ID,
      type: "message.append",
      lamport: 2,
      deviceId: desktop.deviceId,
      seq: 2,
      ts: "2026-10-04T01:01:00.000Z",
      payload: { role: "user", text: "桌面说：你好", turnId: "t-desk-1" },
    },
  ];
  const pushResponse = await httpJson("POST", `${base}/v1/sync/push`, events.map((event) => JSON.stringify(event)).join("\n"), {
    Authorization: `Bearer ${desktop.token}`,
    "Content-Type": "application/x-ndjson; charset=utf-8",
  });
  if (pushResponse.status !== 200) {
    throw new Error(`种子推送失败：${pushResponse.status} ${pushResponse.text}`);
  }
  return desktop;
}

async function runBrowser(base) {
  const channel = process.env.CYRENE_PWA_BROWSER?.trim() || "msedge";
  console.log(`[info] Playwright 浏览器通道：${channel}`);
  const browser = await chromium.launch(channel === "chromium" ? {} : { channel });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN" });
  const page = await context.newPage();
  try {
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });

    // 静态托管与缓存头
    const indexResponse = await context.request.get(`${base}/`);
    check(
      "静态托管：GET / 返回 HTML",
      indexResponse.status() === 200 && (indexResponse.headers()["content-type"] ?? "").includes("text/html"),
      `status=${indexResponse.status()} type=${indexResponse.headers()["content-type"]}`,
    );
    const manifest = await context.request.get(`${base}/manifest.webmanifest`);
    check("静态托管：manifest 200", manifest.status() === 200, `status=${manifest.status()}`);
    const sw = await context.request.get(`${base}/sw.js`);
    check(
      "静态托管：sw.js 200 且 no-cache",
      sw.status() === 200 && (sw.headers()["cache-control"] ?? "") === "no-cache",
      `status=${sw.status()} cc=${sw.headers()["cache-control"]}`,
    );

    // 能力声明（公开只读；驱动生成回复断言是否可用）
    const capsResponse = await context.request.get(`${base}/v1/capabilities`);
    let caps = {};
    try {
      caps = await capsResponse.json();
    } catch {
      // 老服务端：按兼容默认（不断言生成）
    }
    check(
      "能力声明 /v1/capabilities（generation 字段）",
      capsResponse.status() === 200 && ["realtime", "inline", "none"].includes(caps.generation),
      `status=${capsResponse.status()} generation=${caps.generation}`,
    );
    const echoExpected = EXPECT_ECHO && caps.generation === "realtime";

    // 配对登录
    check("登录页渲染", await page.getByTestId("pair-code").isVisible());
    const codeResponse = await httpJson("POST", `${base}/v1/pair/code`, undefined, {
      Authorization: `Bearer ${MASTER_TOKEN}`,
    });
    await page.getByTestId("pair-code").fill(codeResponse.body.code);
    await page.getByTestId("pair-name").fill("E2E手机");
    await page.getByTestId("pair-submit").click();

    // 会话列表（来自桌面种子）
    const sessionItem = page.getByTestId("session-item").filter({ hasText: "最近会话" });
    await sessionItem.waitFor({ state: "visible", timeout: 15000 });
    check("配对后可见桌面会话", true);

    await sessionItem.click();
    await page.getByTestId("messages").getByText("桌面说：你好", { exact: true }).waitFor({ timeout: 10000 });
    check("打开会话看到桌面消息（桌面已离线）", true);
    if (echoExpected) {
      await page.getByTestId("messages").getByText("回声：桌面说：你好", { exact: true }).waitFor({ timeout: 15000 });
      check("看到服务端对桌面消息的生成回复", true);
    } else {
      console.log("[SKIP] 桌面消息生成回复断言（远端未接回声 mock / generation != realtime）");
    }

    // 手机发送 → 服务端生成回复（轮询可见）
    await page.getByTestId("chat-input").fill("手机说：在吗");
    await page.getByTestId("send").click();
    await page.getByTestId("messages").getByText("手机说：在吗", { exact: true }).waitFor({ timeout: 10000 });
    if (echoExpected) {
      await page.getByTestId("messages").getByText("回声：手机说：在吗", { exact: true }).waitFor({ timeout: 20000 });
      check("手机发送文字并收到回复", true);
    } else {
      check("手机发送文字（乐观渲染；远端未断言生成回复）", true);
    }

    // 刷新后登录态保持
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("session-item").first().waitFor({ timeout: 10000 });
    check("刷新后保持登录态（token 持久化）", true);

    // 离线只读缓存（SW 应用壳 + localStorage 事件缓存）
    await page.waitForFunction(
      () => navigator.serviceWorker && navigator.serviceWorker.controller !== null,
      null,
      { timeout: 10000 },
    ).catch(() => {});
    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("offline-banner").waitFor({ state: "visible", timeout: 10000 });
    await page.getByTestId("session-item").first().waitFor({ timeout: 10000 });
    check("离线可打开缓存会话（只读横幅）", true);
    await context.setOffline(false);
  } finally {
    await browser.close();
  }
}

async function main() {
  const remote = Boolean(BASE_URL_ARG);
  if (!remote) {
    const wwwrootIndex = join(dirname(DLL), "wwwroot", "index.html");
    if (!existsSync(DLL)) {
      console.error(`找不到 cloud-server 产物：${DLL}`);
      process.exit(2);
    }
    if (!existsSync(wwwrootIndex)) {
      console.error(`找不到 PWA 产物：${wwwrootIndex}\n先 npm --prefix src/pwa run build 并重新发布 cloud-server`);
      process.exit(2);
    }
  }

  let dataDir = null;
  let llm = null;
  let server = null;
  let base = null;
  try {
    if (remote) {
      base = BASE_URL_ARG.replace(/\/+$/, "");
      console.log(`[info] 远端模式 base=${base}（不 spawn 服务；生成回复断言默认关闭）`);
    } else {
      dataDir = mkdtempSync(join(tmpdir(), "cyrene-pwa-e2e-"));
      llm = await startMockLlm();
      const port = await freePort();
      server = await startServer(dataDir, llm.port, port);
      base = server.base;
    }
    await seedDesktopSession(base);
    await runBrowser(base);
  } catch (error) {
    check(`执行异常：${error instanceof Error ? error.message : String(error)}`, false);
    if (server) {
      console.error(server.getLogs().slice(-3000));
    }
  } finally {
    if (server) {
      server.child.kill();
      await new Promise((resolveExit) => {
        if (server.child.exitCode !== null || server.child.signalCode !== null) {
          resolveExit();
          return;
        }
        server.child.once("exit", resolveExit);
        setTimeout(resolveExit, 5000);
      });
    }
    llm?.server.close();
    if (dataDir) {
      try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Windows 下 SQLite 句柄释放可能滞后：临时目录清理失败不影响冒烟结果
      }
    }
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\nPWA E2E 冒烟：${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
