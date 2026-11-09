// 重启后一次性核对 dsh-llm-reasoning-retry 是否按预期接管。
// 用法：node check.mjs [端口]
// 只读：不改任何东西。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const LOG = join(DSH_HOME, "logs", "dsh-llm-reasoning-retry.log");
const WIRETAP_LOG = join(DSH_HOME, "logs", "dsh-llm-wiretap.log");
const CAP = join(DSH_HOME, "logs", "reasoning-retry");
const port = process.argv[2];

/** 期望版本直接从插件自己的 package.json 取，避免每次改版本都要同步这里。 */
const EXPECTED_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
})();

function readLines(path) {
  try {
    return readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l !== "");
  } catch {
    return [];
  }
}

/** 取最后一条匹配的事件，并尝试把 JSON 尾巴解出来。 */
function lastEvent(lines, needle) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const at = line.indexOf(needle);
    if (at === -1) continue;
    const head = line.slice(0, at).trim();
    const tail = line.slice(at + needle.length).trim();
    let payload = null;
    try {
      payload = JSON.parse(tail);
    } catch {
      payload = tail;
    }
    return { head, payload, raw: line };
  }
  return null;
}

const lines = readLines(LOG);
const wireLines = readLines(WIRETAP_LOG);

console.log("=== 1) 启动日志 / 版本");
const ready = lastEvent(lines, "host-ready");
if (ready === null) {
  console.log("  ✗ 没有 host-ready —— 插件没加载");
} else {
  const version = ready.payload?.version ?? "?";
  const ok = EXPECTED_VERSION === null ? true : version === EXPECTED_VERSION;
  console.log(`  ${ok ? "✓" : "✗"} version = ${version}${EXPECTED_VERSION === null ? "" : `（期望 ${EXPECTED_VERSION}）`}`);
  console.log(`  mode=${ready.payload?.mode} maxRetries=${ready.payload?.maxRetries} maxBufferChars=${ready.payload?.maxBufferChars} keep=${ready.payload?.keep}`);
  console.log(`  captureRoot = ${ready.payload?.captureRoot}`);
  console.log(`  时间 ${ready.head}`);
}

console.log("\n=== 2) 层级自检");
const layer = lastEvent(lines, "layering");
if (layer === null) {
  console.log("  · 还没有 layering 行（启动后 1.5 秒才写）");
} else {
  console.log(`  outermost = ${layer.payload?.outermost}`);
  console.log(`  ${layer.payload?.hint ?? ""}`);
}

console.log("\n=== 3) 运行计数");
if (port === undefined) {
  console.log("  · 未给端口，跳过（其余项目不受影响）");
} else {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/dsh-llm-reasoning-retry/stats`);
    const body = await res.json();
    const s = body.stats ?? {};
    console.log(
      `  tapped=${s.tapped} deliverable=${s.deliverable} reasoningOnly=${s.reasoningOnly} retried=${s.retried} recovered=${s.recovered} exhausted=${s.exhausted}`,
    );
    const bad = (s.reasoningOnly ?? 0) > (s.deliverable ?? 0);
    console.log(`  ${bad ? "?" : "✓"} 无交付计数未超过有交付计数`);
  } catch (error) {
    console.log(`  ✗ 请求失败: ${error.message}`);
  }
}

console.log("\n=== 4) 空轮原始证据");
let caps = [];
try {
  caps = readdirSync(CAP, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
} catch {
  caps = [];
}
if (caps.length === 0) {
  console.log("  · 还没有空轮证据目录（未发生 reasoning-only，或尚未触发）");
} else {
  console.log(`  共 ${caps.length} 份，最近 3 份：`);
  for (const name of caps.slice(-3)) {
    const dir = join(CAP, name);
    const need = ["response.sse", "meta.json", "pinned"];
    const optional = ["recovered.json", "exhausted.json"];
    const missing = need.filter((f) => !existsSync(join(dir, f)));
    const present = optional.filter((f) => existsSync(join(dir, f)));
    let meta = null;
    try {
      meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    } catch {
      meta = null;
    }
    console.log(
      `  ${missing.length === 0 ? "✓" : "✗"} ${name}  verdict=${meta?.verdict} stop=${meta?.stopReason} sseBytes=${meta?.sseBytes} 补记=[${present.join(",")}]${missing.length ? " 缺:" + missing.join(",") : ""}`,
    );
  }
}

console.log("\n=== 5) wiretap 是否也在跑");
const wt = lastEvent(wireLines, "host-ready");
console.log(wt === null ? "  · 没有 wiretap host-ready" : `  ✓ wiretap ${wt.payload?.version} · ${wt.head}`);

console.log("\n=== 6) 空轮后需要对齐的字段（真发生时用）");
console.log("  reasoning-retry/meta.json: sessionId, verdict, stopReason, model, sseBytes");
console.log("  wiretap/meta.json:         messageId, sse.stopReason, sse.reasoningChars, sse.timing");
