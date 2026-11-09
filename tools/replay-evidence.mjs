// 用 wiretap 里真实落盘的 SSE 回放验证分类器判定。
// 只读：不写任何东西。
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createClassifier, classify } from "../lib/classify.js";

const ROOT = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "logs", "wiretap");

const dirs = readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

let pass = 0;
let fail = 0;
const rows = [];

for (const name of dirs) {
  const dir = join(ROOT, name);
  const ssePath = join(dir, "response.sse");
  const metaPath = join(dir, "meta.json");
  if (!existsSync(ssePath) || !existsSync(metaPath)) continue;

  const raw = readFileSync(ssePath);
  let meta;
  try { meta = JSON.parse(readFileSync(metaPath, "utf8")); } catch { continue; }
  if (meta.completed !== true) continue;

  // 分块喂入，模拟真实网络 chunk，并强制在 7 字节处切开以制造跨帧边界。
  const text = raw.toString("utf8");
  const c = createClassifier();
  const CHUNK = 7;
  for (let i = 0; i < text.length; i += CHUNK) c.feed(text.slice(i, i + CHUNK));
  c.flush();
  const verdict = classify(c);

  // 期望值：以 meta.sse 的统计为准。
  const sse = meta.sse ?? {};
  const expectedDeliverable = (sse.textChars ?? 0) > 0 || (sse.toolBlocks ?? 0) > 0;
  const expected = expectedDeliverable ? "deliverable" : (sse.thinkingDeltas ?? 0) > 0 ? "reasoning-only" : "empty";

  const ok = verdict === expected;
  if (ok) pass += 1; else fail += 1;
  rows.push({
    dir: name,
    verdict,
    expected,
    ok,
    stop: sse.stopReason,
    reasoning: sse.reasoningChars,
    textChars: sse.textChars,
    toolBlocks: sse.toolBlocks,
  });
}

rows.sort((a, b) => a.dir.localeCompare(b.dir));
for (const r of rows) {
  console.log(
    `${r.ok ? "OK  " : "FAIL"} ${r.dir}  verdict=${r.verdict} expected=${r.expected} stop=${r.stop} reasoning=${r.reasoning} text=${r.textChars} tool=${r.toolBlocks}`,
  );
}
console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
