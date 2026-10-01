#!/usr/bin/env node
/**
 * mock OpenAI 兼容 /chat/completions 服务器 —— 供 --agent-loop 冒烟用。
 *
 * 每个 scenario 单独起一个实例（随机端口，首行 stdout 打 {"port":N}）。
 * 行为由 scenario 决定，对请求体只做最小解析（messages 里有没有 tool 结果
 * 决定"第一步"还是"收口轮"），保证循环侧每种语义都被逼出来。
 *
 * 运行: node scripts/mock-llm-server.mjs --scenario <name>
 */
import http from "node:http";

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const scenario = arg("scenario") ?? "no_tool";
const usage = { prompt_tokens: 21, completion_tokens: 7, total_tokens: 28 };

let requestIndex = 0;
let flakyFails = 0;

const assistantFinal = (content) => ({
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage,
});
const assistantTools = (calls) => ({
  choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: calls }, finish_reason: "tool_calls" }],
  usage,
});
function tc(id, name, args) {
  const call = {
    type: "function",
    function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
  };
  if (id !== null && id !== undefined) call.id = id; // id=null → 模拟缺 id 的坏端点
  return call;
}

const server = http.createServer((req, res) => {
  res.on("error", () => {}); // 客户端超时断开属预期
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    requestIndex++;
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      /* 非法请求体按空处理 */
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const hasToolResult = messages.some((m) => m && m.role === "tool");
    const lastUser = [...messages].reverse().find((m) => m && m.role === "user")?.content ?? "";
    const lastTool = [...messages].reverse().find((m) => m && m.role === "tool")?.content ?? "";
    process.stderr.write(
      `[mock:${scenario}] #${requestIndex} model=${body.model} messages=${messages.length} tools=${Array.isArray(body.tools) ? body.tools.length : 0} toolMsg=${hasToolResult}\n`,
    );

    const json = (obj, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const text = (value, status = 200) => {
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      res.end(value);
    };

    switch (scenario) {
      // 纯回答 + Unicode/多行回声（验证请求/响应 JSON 转义往返）
      case "no_tool":
        json(assistantFinal("回声：" + lastUser));
        break;
      // 单工具两轮：calculator → 收口带上工具结果
      case "single_tool":
        if (!hasToolResult) json(assistantTools([tc("c1", "calculator", { expression: "6*7" })]));
        else json(assistantFinal("计算结果：" + lastTool));
        break;
      // 并行工具调用：一轮两个 call，验证顺序与逐个回注
      case "parallel":
        if (!hasToolResult) {
          json(assistantTools([tc("c1", "calculator", { expression: "6*7" }), tc("c2", "now", { format: "iso" })]));
        } else {
          const ids = messages.filter((m) => m && m.role === "tool").map((m) => m.tool_call_id).join(",");
          json(assistantFinal("并行完成：" + ids));
        }
        break;
      // 工具全失败（未知工具 + 缺参），循环不得中断
      case "tool_error":
        if (!hasToolResult) json(assistantTools([tc("c1", "frobnicate", {}), tc("c2", "calculator", {})]));
        else json(assistantFinal("错误路径也收口"));
        break;
      // 响应体非法 JSON → E_LLM_PARSE
      case "bad_json":
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"choices": [');
        break;
      // 永远 500 → E_LLM_HTTP
      case "http_500":
        text("boom", 500);
        break;
      // 前 2 次 500、第 3 次成功 → 验证 --retries
      case "flaky_500":
        if (flakyFails < 2) {
          flakyFails++;
          text("临时故障", 500);
        } else {
          json(assistantFinal("三次后成功"));
        }
        break;
      // 永远要工具 → 验证 max_rounds 收口
      case "max_rounds":
        json(assistantTools([tc(`c${requestIndex}`, "now", { format: "epoch" })]));
        break;
      // arguments 为空串 → 循环侧按缺参处理
      case "empty_args":
        if (!hasToolResult) json(assistantTools([tc("c1", "calculator", "")]));
        else json(assistantFinal("空参数收口：" + lastTool));
        break;
      // 缺 tool_call.id → 循环侧合成 id 并告警
      case "missing_id":
        if (!hasToolResult) json(assistantTools([tc(null, "calculator", { expression: "6*7" })]));
        else json(assistantFinal("缺 id 收口：" + lastTool));
        break;
      // content=null 且无 tool_calls → 循环侧按空回答收口 + warn
      case "null_content":
        json({ choices: [{ index: 0, message: { role: "assistant", content: null }, finish_reason: "stop" }], usage });
        break;
      // tool_calls 空数组（非 null）→ 视为最终回答
      case "empty_tool_calls":
        json({
          choices: [{ index: 0, message: { role: "assistant", content: "空数组也算回答", tool_calls: [] }, finish_reason: "stop" }],
          usage,
        });
        break;
      // 读一个大文件（LOOP_TEST_FILE 注入，600 行）→ 验证循环侧工具结果截断
      case "fs_read":
        if (!hasToolResult) json(assistantTools([tc("c1", "fs_read_file", { path: process.env.LOOP_TEST_FILE ?? "" })]));
        else json(assistantFinal("文件已读：" + lastTool.slice(0, 80)));
        break;
      // sqrt(-1) → double.NaN 序列化（TS 语义应为 null）
      case "nan":
        if (!hasToolResult) json(assistantTools([tc("c1", "calculator", { expression: "sqrt(-1)" })]));
        else json(assistantFinal("NaN 收口：" + lastTool));
        break;
      // expression 传数字（坏端点行为）→ 应给出人话错误而不是 .NET 内部异常串
      case "number_args":
        if (!hasToolResult) json(assistantTools([tc("c1", "calculator", { expression: 42 })]));
        else json(assistantFinal("数字参数收口：" + lastTool));
        break;
      // 剪贴板写调用 → 循环侧只读守卫必须拦下
      case "clipboard_write":
        if (!hasToolResult) json(assistantTools([tc("c1", "clipboard", { action: "write", text: "LOOP-MUST-NOT-WRITE" })]));
        else json(assistantFinal("剪贴板守卫收口"));
        break;
      // 响应慢于 --timeout-ms → E_LLM_TIMEOUT
      case "slow":
        setTimeout(() => json(assistantFinal("迟到的回答")), 2500);
        break;
      // choices 空数组 → E_LLM_EMPTY
      case "empty_choices":
        json({ choices: [], usage });
        break;
      default:
        json({ error: { message: "未知 scenario: " + scenario } }, 400);
    }
  });
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }) + "\n");
});
