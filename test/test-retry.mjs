// 集成测试：用 mock fetch 验证「判定 → 重试一次 → 恢复 / 报错」的完整链路。
// 不联网、不写正式日志（DSH_HOME 指到临时目录）。
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, resolveConfig, DEFAULT_CONFIG } from "../lib/index.js";

const HOME = mkdtempSync(join(tmpdir(), "dsh-retry-test-"));
process.env.DSH_HOME = HOME;

let pass = 0;
let fail = 0;
function check(label, ok, extra) {
  if (ok) {
    pass += 1;
    console.log(`OK   ${label}`);
  } else {
    fail += 1;
    console.log(`FAIL ${label}${extra === undefined ? "" : "  " + JSON.stringify(extra)}`);
  }
}

function sse(events) {
  const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const THINKING_ONLY = [
  { type: "message_start", message: { id: "m1", model: "deepseek-flash", content: [] } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "做。" } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" } },
  { type: "message_stop" },
];

const WITH_TEXT = [
  { type: "message_start", message: { id: "m2", model: "deepseek-flash", content: [] } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想好了。" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "这是正文。" } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "end_turn" } },
  { type: "message_stop" },
];

const WITH_TOOL = [
  { type: "message_start", message: { id: "m3", model: "deepseek-flash", content: [] } },
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "read", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" } },
  { type: "message_stop" },
];

const originalFetch = globalThis.fetch;
let calls = 0;

/** 装一次插件，seq 是第 n 次 fetch 要返回的 SSE 事件序列。 */
function install(seq, config) {
  calls = 0;
  const fetchImpl = () => {
    const events = seq[Math.min(calls, seq.length - 1)];
    calls += 1;
    return Promise.resolve(sse(events));
  };
  const ctx = {
    effect(fn) {
      return fn();
    },
    inject() {},
  };
  // 每次重新 apply：先把 globalThis.fetch 还原成 mock 基线。
  globalThis.fetch = fetchImpl;
  apply(ctx, config);
  return ctx;
}

function makeRequest() {
  return new Request("https://api.deepseek.com/anthropic/v1/messages", {
    method: "POST",
    headers: { accept: "text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-flash", messages: [{ role: "user", content: "hi" }] }),
  });
}

// ── 用例 1：第一次空轮，第二次有正文 → 恢复 ──────────────────────────
install([THINKING_ONLY, WITH_TEXT]);
{
  const response = await globalThis.fetch(makeRequest());
  const text = await response.text();
  check("用例1 消费到正文", text.includes("这是正文。"), { len: text.length });
  check("用例1 共发出 2 次请求", calls === 2, { calls });
  check("用例1 响应头已去掉 content-encoding", !response.headers.get("content-encoding"), {
    ce: response.headers.get("content-encoding"),
  });
}

// ── 用例 2：两次都空 → 原样放行，不抛错，上游请求数严格为 2 ──────────
install([THINKING_ONLY, THINKING_ONLY]);
{
  const response = await globalThis.fetch(makeRequest());
  let error = null;
  let text = "";
  try {
    text = await response.text();
  } catch (e) {
    error = e;
  }
  check("用例2 不抛错（方案A：抛错会被 DSH 当 TRANSPORT 再重试 5 次）", error === null, {
    error: error === null ? null : error.message,
  });
  check("用例2 空轮内容被原样放行", text.includes("thinking_delta"), { len: text.length });
  check("用例2 上游请求数严格为 2", calls === 2, { calls });
}

// ── 用例 3：第一次就正常 → 不重试 ────────────────────────────────────
install([WITH_TEXT]);
{
  const response = await globalThis.fetch(makeRequest());
  const text = await response.text();
  check("用例3 消费到正文", text.includes("这是正文。"), { len: text.length });
  check("用例3 只发出 1 次请求", calls === 1, { calls });
}

// ── 用例 4：工具调用算交付 → 不重试 ──────────────────────────────────
install([WITH_TOOL]);
{
  const response = await globalThis.fetch(makeRequest());
  const text = await response.text();
  check("用例4 消费到 tool_use", text.includes('"tool_use"'), { len: text.length });
  check("用例4 只发出 1 次请求", calls === 1, { calls });
}

// ── 用例 5：log 模式 → 不重试，原样透传（与未装插件一致）─────────────
install([THINKING_ONLY], { mode: "log" });
{
  const response = await globalThis.fetch(makeRequest());
  const text = await response.text();
  check("用例5 thinking 被原样透传", text.includes("thinking_delta"), { len: text.length });
  check("用例5 只发出 1 次请求", calls === 1, { calls });
}

// ── 用例 6：非流式请求不拦截 ─────────────────────────────────────────
{
  let seen = 0;
  globalThis.fetch = () => {
    seen += 1;
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  apply({ effect: (fn) => fn(), inject() {} }, {});
  await globalThis.fetch("https://example.com/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  check("用例6 非 SSE 请求放行且不计入", seen === 1, { seen });
}

// ── 用例 7：空轮原始证据确实落盘 ─────────────────────────────────────
{
  const capRoot = join(HOME, "logs", "reasoning-retry");
  let caps = [];
  try {
    caps = readdirSync(capRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    caps = [];
  }
  check("用例7 有落盘目录（用例1/2/5 各一份）", caps.length === 3, { caps });
  if (caps.length > 0) {
    const dir = join(capRoot, caps[0]);
    check("用例7 含 response.sse", existsSync(join(dir, "response.sse")));
    check("用例7 含 pinned", existsSync(join(dir, "pinned")));
    check("用例7 含 recovered.json", existsSync(join(dir, "recovered.json")));
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    check("用例7 meta 记为 reasoning-only", meta.verdict === "reasoning-only", { verdict: meta.verdict });
    const rawSse = readFileSync(join(dir, "response.sse"), "utf8");
    check(
      "用例7 存的原始流只有 thinking、无正文",
      rawSse.includes("thinking_delta") && !rawSse.includes("text_delta"),
      { len: rawSse.length },
    );
  }
  if (caps.length > 1) {
    const dir2 = join(capRoot, caps[1]);
    check("用例7 双空目录含 exhausted.json 且无 recovered.json", existsSync(join(dir2, "exhausted.json")) && !existsSync(join(dir2, "recovered.json")));
    const ex = JSON.parse(readFileSync(join(dir2, "exhausted.json"), "utf8"));
    check("用例7 exhausted.json 标记 still-reasoning-only", ex.outcome === "still-reasoning-only", { outcome: ex.outcome });
    check("用例7 exhausted.json 带 retryMs/totalMs（供冻结脚本配对）", typeof ex.retryMs === "number" && typeof ex.totalMs === "number", {
      retryMs: ex.retryMs,
      totalMs: ex.totalMs,
    });
  }
}

// ── 用例 8：日志确实记下 exhausted ───────────────────────────────────
{
  const logFile = join(HOME, "logs", "dsh-llm-reasoning-retry.log");
  const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  check("用例8 日志含 exhausted 事件", log.includes(" exhausted "), { len: log.length });
  check("用例8 日志标记 still-reasoning-only", log.includes("still-reasoning-only"));
  check("用例8 日志含 retry-still-empty", log.includes("retry-still-empty"));
}

globalThis.fetch = originalFetch;
try {
  rmSync(HOME, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
