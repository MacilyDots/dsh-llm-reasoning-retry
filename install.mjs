// 把 dsh-llm-reasoning-retry 装进 profile：
//   1. 备份 package.json
//   2. dependencies 加 link: 条目
//   3. dsh.profile.bundles 里排在 dsh-llm-wiretap 之后（后加载 = 包装在 fetch 外层）
//   4. node_modules/<name> 建 junction 指向本目录
// 幂等：重复运行不会重复插入。
import { copyFileSync, existsSync, readFileSync, symlinkSync, lstatSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

// install.mjs 就在插件根目录，只退一层。
const SELF = dirname(fileURLToPath(import.meta.url));
const NAME = "dsh-llm-reasoning-retry";
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const PROFILE = join(DSH_HOME, "profiles", process.argv[2] ?? "desktop");

if (!existsSync(join(PROFILE, "package.json"))) {
  console.error("找不到 profile:", PROFILE);
  process.exit(1);
}

const pkgPath = join(PROFILE, "package.json");
const original = readFileSync(pkgPath, "utf8");
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 13);
copyFileSync(pkgPath, `${pkgPath}.bak-reasoning-retry-${stamp}`);
console.log("已备份 package.json →", `${pkgPath}.bak-reasoning-retry-${stamp}`);

let text = original;

// ── dependencies ──────────────────────────────────────────────────────
const desiredLink = `link:${SELF.replace(/\\/g, "/")}`;
const depRe = new RegExp(`^(\\s*)"${NAME}":\\s*"([^"]*)",$`, "m");
const depLine = `    "${NAME}": "${desiredLink}",\n`;
const depMatch = text.match(depRe);
if (depMatch !== null) {
  if (depMatch[2] === desiredLink) {
    console.log("dependencies 条目已正确:", desiredLink);
  } else {
    text = text.replace(depRe, depLine.trimEnd());
    console.log("dependencies 路径已纠正:", depMatch[2], "→", desiredLink);
  }
} else {
  const anchor = `    "dsh-llm-wiretap": "link:`;
  if (!text.includes(anchor)) {
    console.error("找不到 dsh-llm-wiretap 的 dependencies 行，放弃");
    process.exit(1);
  }
  text = text.replace(anchor, depLine + anchor);
  console.log("dependencies 已插入", NAME, "→", desiredLink);
}

// ── bundles ───────────────────────────────────────────────────────────
const bundleLine = `        "${NAME}",\n`;
if (text.includes(bundleLine)) {
  console.log("bundles 已有条目，跳过");
} else {
  const anchor = `        "dsh-llm-wiretap",\n`;
  if (!text.includes(anchor)) {
    console.error("找不到 dsh-llm-wiretap 的 bundles 行，放弃");
    process.exit(1);
  }
  text = text.replace(anchor, anchor + bundleLine);
  console.log("bundles 已插入（排在 dsh-llm-wiretap 之后，即 fetch 包装的外层）");
}

if (text !== original) {
  JSON.parse(text); // 写之前先确认还是合法 JSON
  writeFileSync(pkgPath, text, "utf8");
  console.log("package.json 已更新");
}

// ── node_modules junction ─────────────────────────────────────────────
const linkPath = join(PROFILE, "node_modules", NAME);
let currentTarget = null;
try {
  lstatSync(linkPath);
  currentTarget = resolve(dirname(linkPath), readlinkSync(linkPath));
} catch {
  currentTarget = null;
}

if (currentTarget !== null && currentTarget === resolve(SELF)) {
  console.log("junction 已正确指向:", currentTarget);
} else {
  if (currentTarget !== null) {
    console.log("junction 指向错误，重建:", currentTarget, "→", SELF);
    rmSync(linkPath, { recursive: true, force: true });
  }
  try {
    symlinkSync(SELF, linkPath, "junction");
    console.log("已建立 junction:", linkPath, "→", SELF);
  } catch (error) {
    console.error("建 junction 失败:", error.message);
    process.exit(1);
  }
}

console.log("\n完成。重启 DSH 后生效。");
console.log("日志: " + join(DSH_HOME, "logs", "dsh-llm-reasoning-retry.log"));
