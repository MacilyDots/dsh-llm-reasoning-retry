// 冻结脚本的三类场景测试：正常配对、多候选按一致性唯一选中、会话不同必须拒绝。
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";

const SELF = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(dirname(SELF), "freeze-evidence.mjs");

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

function p2(n, w = 2) {
  return String(n).padStart(w, "0");
}
function localStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}T${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.${p2(d.getMilliseconds(), 3)}`;
}

const THINKING_ONLY = (id) =>
  [
    { type: "message_start", message: { id, model: "deepseek-flash", content: [] } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "做。" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ];
const WITH_TEXT = (id) =>
  [
    { type: "message_start", message: { id, model: "deepseek-flash", content: [] } },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "正文" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ];
function sseText(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

const HOME = mkdtempSync(join(tmpdir(), "freeze-test-"));
const SESSION = "session-test-0001";
const T0 = Date.now() - 600_000;

function setup() {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(join(HOME, "logs", "reasoning-retry"), { recursive: true });
  mkdirSync(join(HOME, "logs", "wiretap"), { recursive: true });
  mkdirSync(join(HOME, "sessions", "--B-DSH--", SESSION), { recursive: true });

  // 客户端事件：一个 turn 内有 step/assistant/turn 结束
  const events = [
    { type: "turn/start", seq: 1, time: T0 + 500, data: { turn: 7 } },
    { type: "step/start", seq: 2, time: T0 + 600, data: { turn: 7, step: 1 } },
    { type: "assistant/message", seq: 3, time: T0 + 3000, data: { turn: 7, step: 1, message: { content: [] } } },
    { type: "step/end", seq: 4, time: T0 + 3100, data: { turn: 7, step: 1 } },
    { type: "turn/end", seq: 5, time: T0 + 5200, data: { turn: 7, reason: { kind: "stop" } } },
  ];
  const jsonl = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(HOME, "sessions", "--B-DSH--", SESSION, "session.v1.jsonl.zstd"), zstdCompressSync(Buffer.from(jsonl)));
}

/**
 * 写一份 retry 捕获。firstMs 是第一次响应时长，retryMs 是重试时长。
 * variant="exhausted" 时写 exhausted.json（双空），否则写 recovered.json。
 */
function writeRetry(id, { startedAt, firstMs, retryMs, sessionId = SESSION, variant = "recovered" }) {
  const pressMs = startedAt + firstMs;
  const name = `${localStamp(pressMs)}-${id}`;
  const dir = join(HOME, "logs", "reasoning-retry", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "response.sse"), sseText(THINKING_ONLY("msg-first-" + id)));
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({ id: name, sessionId, verdict: "reasoning-only", stopReason: "end_turn", sseBytes: 100 }),
  );
  writeFileSync(join(dir, "pinned"), "");
  const timing = { retryMs, totalMs: firstMs + retryMs };
  if (variant === "exhausted") {
    writeFileSync(
      join(dir, "exhausted.json"),
      JSON.stringify({ retries: 1, outcome: "still-reasoning-only", secondVerdict: "reasoning-only", ...timing }),
    );
  } else {
    writeFileSync(
      join(dir, "recovered.json"),
      JSON.stringify({ attempt: 1, second: { stopReason: "end_turn" }, ...timing }),
    );
  }
  return name;
}

function writeWiretap(name, { startedAt, endedAt, sessionId = SESSION, text = true }) {
  const dir = join(HOME, "logs", "wiretap", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "response.sse"), sseText(text ? WITH_TEXT("msg-second-" + name) : THINKING_ONLY("msg-second-" + name)));
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      id: name,
      sessionId,
      requestHeaders: { "x-deepseek-harness-session-id": sessionId },
      timing: { startedAt, endedAt },
      sse: { stopReason: "end_turn", usage: { input_tokens: 17300, output_tokens: 420 } },
    }),
  );
}

function run(extraArgs = []) {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [SCRIPT, ...extraArgs], {
        env: { ...process.env, DSH_HOME: HOME, FREEZE_OUT: join(HOME, "OUT") },
        encoding: "utf8",
      }),
    };
  } catch (error) {
    return { code: error.status ?? 1, out: String(error.stdout ?? "") + String(error.stderr ?? "") };
  }
}

// ── 场景 1：单候选，正常冻结 ─────────────────────────────────────────
setup();
{
  const retryId = writeRetry("001", { startedAt: T0 + 1000, firstMs: 3000, retryMs: 2000 });
  writeWiretap(`${localStamp(T0 + 1000)}-007`, { startedAt: T0 + 1000, endedAt: T0 + 6000 });
  const r = run();
  check("场景1 退出码 0", r.code === 0, { code: r.code, out: r.out.slice(-400) });
  check("场景1 声明会话相同", r.out.includes(SESSION));
  const manifestPath = join(HOME, "OUT", retryId, "manifest.json");
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    manifest = null;
  }
  check("场景1 生成 manifest.json", manifest !== null);
  if (manifest !== null) {
    check("场景1 全部校验通过", manifest.allChecksPassed === true, { checks: manifest.checks?.filter((c) => !c.ok) });
    check("场景1 记下两个不同 message_id", manifest.messageIds.failure !== manifest.messageIds.recovery, manifest.messageIds);
    check("场景1 manifest 含 sha256", Array.isArray(manifest.files) && manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)), {
      files: manifest.files?.map((f) => f.path),
    });
    check("场景1 带客户端事件", manifest.clientEvents?.turns?.includes(7) === true, manifest.clientEvents);
  }
}

// ── 场景 2：同会话多候选，只有一个是真正的第一次请求 ─────────────────
setup();
{
  const retryId = writeRetry("001", { startedAt: T0 + 1000, firstMs: 3000, retryMs: 2000 });
  // 干扰：同会话更早的一次请求，时间差 120s，超出容差
  writeWiretap(`${localStamp(T0 + 1000 - 120_000)}-003`, { startedAt: T0 + 1000 - 120_000, endedAt: T0 + 1000 - 117_000 });
  // 真身
  writeWiretap(`${localStamp(T0 + 1000)}-007`, { startedAt: T0 + 1000, endedAt: T0 + 6000 });
  const r = run();
  check("场景2 多候选中唯一一致者被选中", r.code === 0, { code: r.code, out: r.out.slice(-500) });
  const manifest = JSON.parse(readFileSync(join(HOME, "OUT", retryId, "manifest.json"), "utf8"));
  check("场景2 选中的是时间一致那份", /-007$/.test(manifest.wiretapCapture), { picked: manifest.wiretapCapture });
  check("场景2 记录了候选数", manifest.candidatesConsidered === 2, { n: manifest.candidatesConsidered });
}

// ── 场景 3：会话不同必须拒绝 ─────────────────────────────────────────
setup();
{
  writeRetry("001", { startedAt: T0 + 1000, firstMs: 3000, retryMs: 2000 });
  writeWiretap(`${localStamp(T0 + 1000)}-007`, { startedAt: T0 + 1000, endedAt: T0 + 6000, sessionId: "session-other" });
  const r = run();
  check("场景3 会话不同时退出码非 0", r.code !== 0, { code: r.code });
  check("场景3 明确报错", /匹配的捕获|拒绝/.test(r.out), { out: r.out.slice(-300) });
}

// ── 场景 4：两个同会话候选都落在容差内 → 拒绝自动选择 ────────────────
setup();
{
  const retryId = writeRetry("001", { startedAt: T0 + 1000, firstMs: 3000, retryMs: 2000 });
  writeWiretap(`${localStamp(T0 + 1000)}-007`, { startedAt: T0 + 1000, endedAt: T0 + 6000 });
  writeWiretap(`${localStamp(T0 + 1002)}-008`, { startedAt: T0 + 1002, endedAt: T0 + 6002 });
  const r = run();
  check("场景4 歧义时拒绝自动选择", r.code !== 0, { code: r.code });
  check("场景4 提示手动指定", /第三个参数/.test(r.out), { out: r.out.slice(-300) });

  const forced = run([retryId, `${localStamp(T0 + 1002)}-008`]);
  check("场景4 手动指定后可冻结", forced.code === 0, { code: forced.code, out: forced.out.slice(-300) });
}

// ── 场景 5：双空（recovery failure）也必须冻结并可审计 ───────────────
setup();
{
  const retryId = writeRetry("001", { startedAt: T0 + 1000, firstMs: 3000, retryMs: 2000, variant: "exhausted" });
  writeWiretap(`${localStamp(T0 + 1000)}-007`, { startedAt: T0 + 1000, endedAt: T0 + 6000, text: false });
  const r = run();
  check("场景5 双空仍能冻结（退出码 0）", r.code === 0, { code: r.code, out: r.out.slice(-400) });

  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(join(HOME, "OUT", retryId, "manifest.json"), "utf8"));
  } catch {
    manifest = null;
  }
  check("场景5 生成 manifest.json", manifest !== null);
  if (manifest !== null) {
    check("场景5 recoveryStatus = still_reasoning_only", manifest.recoveryStatus === "still_reasoning_only", {
      status: manifest.recoveryStatus,
    });
    check("场景5 recovery 记为 reasoning-only", manifest.recovery.verdict === "reasoning-only", { v: manifest.recovery.verdict });
    check("场景5 归档 exhausted.json", manifest.exhausted !== null);
    check("场景5 没有 recovered.json", manifest.recovered === null);
    check("场景5 两次 message_id 不同", manifest.messageIds.failure !== manifest.messageIds.recovery, manifest.messageIds);
    check("场景5 校验全部通过", manifest.allChecksPassed === true, { failed: manifest.checks.filter((c) => !c.ok) });
    check("场景5 带客户端事件", manifest.clientEvents?.turns?.includes(7) === true);
  }
  check("场景5 输出明确提示 recovery failure", /recovery failure/.test(r.out), { tail: r.out.slice(-200) });
}

rmSync(HOME, { recursive: true, force: true });
console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
