// 空轮发生后，把两侧证据 + 客户端事件冻结到独立目录，并做一致性验证。
//
// 为什么必须尽快：retry 自己写的故障目录带 pinned，不会被轮转；
// 但恢复侧的 wiretap 目录在 wiretap 眼里是「正常响应」，不会 pin，
// 继续跑够 keep=50 个请求就会被删掉。
//
// 硬约束：
//   1. retry 与 wiretap 的 sessionId 必须完全相等，时间接近只用于排序；
//   2. 同会话候选多于一个时，只有恰好一个通过时间一致性检验才自动选择，
//      否则报错并要求用第三个参数人工指定；
//   3. 同时保存客户端会话事件（turn/start、assistant/message、turn/end、usage）。
//
// 用法：
//   node freeze-evidence.mjs                  # 自动取最新一份，自动配对
//   node freeze-evidence.mjs <retry-id>
//   node freeze-evidence.mjs <retry-id> <wiretap-id>
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { createClassifier, classify } from "./lib/classify.js";

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const RETRY_ROOT = join(DSH_HOME, "logs", "reasoning-retry");
const WIRETAP_ROOT = join(DSH_HOME, "logs", "wiretap");
const SESSIONS_ROOT = join(DSH_HOME, "sessions");
const OUT_ROOT = process.env.FREEZE_OUT ?? join(DSH_HOME, "logs", "freeze-evidence");

/** 配对时允许的时钟差（毫秒），超过就认为不是同一次请求。 */
const PAIR_TOLERANCE_MS = 10_000;

function fail(message) {
  console.error("✗ " + message);
  process.exit(1);
}

function listDirs(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** 目录名形如 20261020T203048.249-005，前段是本地时间。 */
function stampOf(name) {
  return name.split("-")[0];
}

/** 把 20261020T203048.249 解析成本地时区的毫秒 epoch。 */
function stampToMs(name) {
  const s = stampOf(name);
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})$/);
  if (m === null) return null;
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
    Number(m[7]),
  ).getTime();
}

function messageIdOf(ssePath) {
  try {
    const text = readFileSync(ssePath, "utf8");
    const hit = text.match(/"type":"message_start"[\s\S]{0,400}?"id":"([^"]+)"/);
    return hit === null ? null : hit[1];
  } catch {
    return null;
  }
}

function classifyFile(ssePath) {
  try {
    const text = readFileSync(ssePath, "utf8");
    const c = createClassifier();
    c.feed(text);
    c.flush();
    return { verdict: classify(c), stopReason: c.stopReason, saidSomething: c.saidSomething, dataFrames: c.dataFrames };
  } catch (error) {
    return { verdict: "unreadable", error: String(error?.message ?? error) };
  }
}

function sha256Of(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// ── 1. 找到 retry 捕获 ────────────────────────────────────────────────
const retryDirs = listDirs(RETRY_ROOT);
if (retryDirs.length === 0) {
  console.log("reasoning-retry 还没有任何捕获，无需冻结。");
  process.exit(0);
}
const retryId = process.argv[2] ?? retryDirs[retryDirs.length - 1];
const retryDir = join(RETRY_ROOT, retryId);
if (!existsSync(retryDir)) fail(`找不到 reasoning-retry 目录: ${retryDir}`);

const retryMeta = readJson(join(retryDir, "meta.json"));
if (retryMeta === null) fail(`${retryDir}\\meta.json 读不出来`);
if (typeof retryMeta.sessionId !== "string" || retryMeta.sessionId === "") {
  fail("retry meta.json 没有 sessionId，无法在硬约束下配对（拒绝盲选）");
}

const retryStampMs = stampToMs(retryId);
const recovered = readJson(join(retryDir, "recovered.json"));
const exhaustedRecord = readJson(join(retryDir, "exhausted.json"));
/** 恢复成功有 recovered.json，双空只有 exhausted.json；两者都带 retryMs/totalMs。 */
const timingRecord = recovered ?? exhaustedRecord;

// ── 2. 配 wiretap（会话必须相同）─────────────────────────────────────
const candidates = [];
for (const name of listDirs(WIRETAP_ROOT)) {
  const stamp = stampOf(name);
  if (retryStampMs !== null && stampToMs(name) !== null && stampToMs(name) > retryStampMs) continue;
  const meta = readJson(join(WIRETAP_ROOT, name, "meta.json"));
  if (meta === null) continue;
  const sid = meta.sessionId ?? meta.requestHeaders?.["x-deepseek-harness-session-id"] ?? null;
  if (sid !== retryMeta.sessionId) continue;
  candidates.push({ name, meta, startedAt: meta.timing?.startedAt ?? null, endedAt: meta.timing?.endedAt ?? null });
}

if (candidates.length === 0) {
  fail(`wiretap 里没有与该会话（${retryMeta.sessionId}）匹配的捕获；可能已被轮转，或配对条件过严`);
}

/**
 * 一致性检验：第一次响应时长 ≈ totalMs - retryMs。
 * 判定完成时刻（retry 目录名）应约等于 wiretap 请求开始 + (totalMs - retryMs)。
 */
function consistency(candidate) {
  if (candidate.startedAt === null || retryStampMs === null) return null;
  if (timingRecord === null) return null;
  if (typeof timingRecord.retryMs !== "number" || typeof timingRecord.totalMs !== "number") return null;
  const firstMs = timingRecord.totalMs - timingRecord.retryMs;
  const expectedEnd = candidate.startedAt + firstMs;
  return { gapMs: Math.abs(expectedEnd - retryStampMs), expectedEnd, firstMs };
}

let chosen = null;
if (process.argv[3] !== undefined) {
  chosen = candidates.find((c) => c.name === process.argv[3]);
  if (chosen === undefined) fail(`指定的 wiretap 捕获 ${process.argv[3]} 不满足会话相同条件`);
} else if (candidates.length === 1) {
  chosen = candidates[0];
} else {
  const scored = candidates.map((c) => ({ ...c, consistency: consistency(c) }));
  const passing = scored.filter((c) => c.consistency !== null && c.consistency.gapMs <= PAIR_TOLERANCE_MS);
  if (passing.length === 1) {
    chosen = passing[0];
  } else {
    console.error(`✗ 同会话候选 ${candidates.length} 个，通过一致性检验的 ${passing.length} 个，拒绝自动选择。`);
    for (const c of scored) {
      const gap = c.consistency === null ? "无法检验" : `偏差 ${c.consistency.gapMs}ms`;
      console.error(`    ${c.name}  请求开始=${c.startedAt}  ${gap}`);
    }
    console.error("  请用第三个参数指定：node freeze-evidence.mjs " + retryId + " <wiretap-id>");
    process.exit(1);
  }
}

const wiretapDir = join(WIRETAP_ROOT, chosen.name);
const pairGap = consistency(chosen);

console.log("=== 配对（会话相同已校验）");
console.log(`  sessionId        ${retryMeta.sessionId}`);
console.log(`  reasoning-retry  ${retryId}  verdict=${retryMeta.verdict} stop=${retryMeta.stopReason}`);
console.log(`  wiretap          ${chosen.name}  候选数=${candidates.length}`);
if (pairGap !== null) console.log(`  一致性偏差       ${pairGap.gapMs}ms（容差 ${PAIR_TOLERANCE_MS}ms）`);
if (candidates.length > 1) console.log(`  其它同会话候选   ${candidates.filter((c) => c.name !== chosen.name).map((c) => c.name).join(", ")}`);

// ── 3. 复制两侧文件 ───────────────────────────────────────────────────
const outDir = join(OUT_ROOT, retryId);
mkdirSync(join(outDir, "01-failure"), { recursive: true });
mkdirSync(join(outDir, "02-recovery"), { recursive: true });

const SIDE_FILES = ["response.sse", "meta.json", "pinned", "recovered.json", "exhausted.json"];
function copySet(from, to) {
  const copied = [];
  for (const name of SIDE_FILES) {
    const src = join(from, name);
    if (!existsSync(src)) continue;
    copyFileSync(src, join(to, name));
    copied.push(name);
  }
  return copied;
}
const gotFailure = copySet(retryDir, join(outDir, "01-failure"));
const gotRecovery = copySet(wiretapDir, join(outDir, "02-recovery"));

// ── 4. 客户端会话事件 ────────────────────────────────────────────────
function decompressSession(file) {
  const buf = readFileSync(file);
  const parts = [];
  let start = 0;
  for (let i = 1; i < buf.length - 4; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) {
      try {
        parts.push(zstdDecompressSync(buf.subarray(start, i)));
        start = i;
      } catch {
        /* 不是真边界 */
      }
    }
  }
  try {
    parts.push(zstdDecompressSync(buf.subarray(start)));
  } catch {
    /* 尾部 */
  }
  return Buffer.concat(parts).toString("utf8");
}

function findSessionLog(sessionId) {
  for (const ws of listDirs(SESSIONS_ROOT)) {
    const dir = join(SESSIONS_ROOT, ws, sessionId);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter((f) => f.startsWith("session.v") && f.endsWith(".jsonl.zstd")).sort();
    if (files.length > 0) return join(dir, files[files.length - 1]);
  }
  return null;
}

let clientEvents = null;
const sessionLog = findSessionLog(retryMeta.sessionId);
if (sessionLog === null) {
  console.log("\n! 找不到客户端会话日志，跳过 03-client-events.jsonl");
} else {
  const startedAt = chosen.startedAt ?? retryStampMs;
  const endedAt = chosen.endedAt ?? retryStampMs;
  const lo = startedAt - 5000;
  const hi = endedAt + 60000;

  const all = decompressSession(sessionLog)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((e) => e !== null);

  // 先按时间窗找涉及的 turn，再把这些 turn 的全部事件带走，保证 turn 结构完整。
  const turns = new Set();
  for (const e of all) {
    if (typeof e.time !== "number" || e.time < lo || e.time > hi) continue;
    const turn = e.data?.turn;
    if (turn !== undefined) turns.add(turn);
  }
  const picked = all.filter((e) => {
    if (e.data?.turn !== undefined && turns.has(e.data.turn)) return true;
    return typeof e.time === "number" && e.time >= lo && e.time <= hi;
  });
  writeFileSync(join(outDir, "03-client-events.jsonl"), picked.map((e) => JSON.stringify(e)).join("\n") + "\n");
  clientEvents = { file: sessionLog, turns: [...turns].sort((a, b) => a - b), events: picked.length };
  console.log(`\n=== 客户端事件`);
  console.log(`  来源 ${sessionLog}`);
  console.log(`  turn ${clientEvents.turns.join(",")}，事件 ${picked.length} 条 → 03-client-events.jsonl`);
}

// ── 5. 自动验证 ──────────────────────────────────────────────────────
const first = classifyFile(join(retryDir, "response.sse"));
const second = classifyFile(join(wiretapDir, "response.sse"));
const firstMsgId = messageIdOf(join(retryDir, "response.sse"));
const secondMsgId = messageIdOf(join(wiretapDir, "response.sse"));

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail === undefined ? "" : "  " + detail}`);
}

/**
 * 恢复状态：
 *   recovered            第二次拿到了正文或工具
 *   still_reasoning_only 第二次仍是空轮 —— 这是 recovery failure 样本，必须照样归档
 * 两种都必须产出证据；只有 recovered 计入「恢复成功」。
 */
const recoveryStatus = second.verdict === "deliverable" ? "recovered" : "still_reasoning_only";

console.log("\n=== 自动验证");
console.log(`  recovery.status = ${recoveryStatus}`);
check("第一次只有 thinking（无 text / 无 tool）", first.verdict === "reasoning-only", `verdict=${first.verdict}`);
check("第一次终止原因是 end_turn", first.stopReason === "end_turn", `stop=${first.stopReason}`);
if (recoveryStatus === "recovered") {
  check("第二次产生了 text 或 tool", second.verdict === "deliverable", `verdict=${second.verdict}`);
  check("存在 recovered.json", recovered !== null);
} else {
  check("第二次仍只有 thinking（按 recovery failure 归档）", second.verdict === "reasoning-only", `verdict=${second.verdict}`);
  check("存在 exhausted.json（双空时由插件写入）", exhaustedRecord !== null);
}
check("两个 message_id 不同", firstMsgId !== null && secondMsgId !== null && firstMsgId !== secondMsgId, `${firstMsgId} vs ${secondMsgId}`);
if (timingRecord !== null && typeof timingRecord.retryMs === "number" && typeof timingRecord.totalMs === "number") {
  check("retryMs 小于 totalMs", timingRecord.retryMs < timingRecord.totalMs, `retryMs=${timingRecord.retryMs} totalMs=${timingRecord.totalMs}`);
  check(
    "两端时间与 totalMs-retryMs 自洽",
    pairGap !== null && pairGap.gapMs <= PAIR_TOLERANCE_MS,
    pairGap === null ? "无法检验" : `偏差 ${pairGap.gapMs}ms`,
  );
} else {
  check("存在时间记录（recovered.json 或 exhausted.json）", false, "两者都缺 retryMs/totalMs");
}

// ── 6. manifest ─────────────────────────────────────────────────────
const files = [];
for (const sub of ["01-failure", "02-recovery"]) {
  for (const name of readdirSync(join(outDir, sub))) {
    const p = join(outDir, sub, name);
    files.push({ path: `${sub}/${name}`, bytes: readFileSync(p).byteLength, sha256: sha256Of(p) });
  }
}
const eventPath = join(outDir, "03-client-events.jsonl");
if (existsSync(eventPath)) {
  files.push({ path: "03-client-events.jsonl", bytes: readFileSync(eventPath).byteLength, sha256: sha256Of(eventPath) });
}

const manifest = {
  frozenAt: new Date().toISOString(),
  sessionId: retryMeta.sessionId,
  retryCapture: retryId,
  wiretapCapture: chosen.name,
  candidatesConsidered: candidates.length,
  pairConsistencyGapMs: pairGap === null ? null : pairGap.gapMs,
  recoveryStatus,
  failure: first,
  recovery: { status: recoveryStatus, ...second },
  messageIds: { failure: firstMsgId, recovery: secondMsgId },
  recovered: recovered ?? null,
  exhausted: exhaustedRecord ?? null,
  clientEvents,
  checks,
  allChecksPassed: checks.every((c) => c.ok),
  files,
};
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

console.log("\n=== 冻结结果");
console.log(`  ${outDir}`);
console.log(`  01-failure/  ${gotFailure.join(", ")}`);
console.log(`  02-recovery/ ${gotRecovery.join(", ")}`);
console.log(`  03-client-events.jsonl ${clientEvents === null ? "（跳过）" : "已写入"}`);
console.log(`  manifest.json  校验 ${checks.filter((c) => c.ok).length}/${checks.length} 通过`);
console.log(`  recovery.status = ${recoveryStatus}`);
if (recoveryStatus !== "recovered") {
  console.log(
    "\n  ! 本次是 recovery failure（第二次仍然只有 thinking）：证据已按原样归档，" +
      "但它只能记入 recovery failure 统计，不能用来支撑「重试可恢复」的结论。",
  );
}
if (!manifest.allChecksPassed) {
  console.log("\n  ! 有校验项未通过，先别动论文记录，先看 manifest.json 的 checks。");
}
