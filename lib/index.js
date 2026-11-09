/* dsh-llm-reasoning-retry — 宿主半。
 *
 * 问题：长会话里，上游会以 HTTP 200 + end_turn 正常结束，但整条响应只有
 * thinking 块，没有 text、没有 tool_use。适配器把 thinking 计入 blocks，
 * 所以 blocks.size === 0 不成立，EMPTY_RESPONSE 不会触发，该轮被记成
 * completed，用户看到一次"没有正文"的空轮。
 *
 * 做法：在 globalThis.fetch 这一层包装响应流。
 *   1. 边读边判定，不许把 thinking 当成交付；
 *   2. 一旦出现正文块或工具调用块 → 立即放行（正常轮次几乎零延迟）；
 *   3. 流终止仍无交付 → 用同一份请求原样重发一次；
 *   4. 第二次仍无交付 → 原样放行并记 exhausted，绝不抛错（抛错会被 DSH 的
 *      默认重试策略当作 TRANSPORT 再重试 5 次，请求数会失控）；
 *   5. 缓冲超过 maxBufferChars 就不再尝试重试，直接放行（正常长思考不受影响）。
 *
 * 只改变「这条流是否交给调用方」，不修改请求体、不注入头、不碰 asar。
 * 判定为空轮时自己落盘一份原始 SSE：wiretap 可能被加载在本插件外层，
 * 那时它看到的是重试后的流，不能作为「上游只给了 thinking」的证据。
 */
import { appendFileSync, mkdirSync, statSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClassifier, classify } from "./classify.js";
import { createCapture } from "./capture.js";

export const name = "dsh-llm-reasoning-retry";

const PATCHED = Symbol.for("dsh-llm-reasoning-retry.patched");
const MAX_LOG_BYTES = 512 * 1024;

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

function logPath() {
  return join(dshHome(), "logs", "dsh-llm-reasoning-retry.log");
}

function appendLog(line) {
  try {
    const dir = join(dshHome(), "logs");
    mkdirSync(dir, { recursive: true });
    const file = logPath();
    try {
      if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, file + ".1");
    } catch {
      /* 文件不存在时继续追加即可 */
    }
    appendFileSync(file, line + "\n");
  } catch {
    /* 日志绝不能影响主链路 */
  }
}

export const DEFAULT_CONFIG = {
  enabled: true,
  /**
   * retry = 判定为空轮后重发一次；log = 只记录不干预。
   * 第一次上线建议先 log 观察若干轮，确认没有误伤再切 retry。
   */
  mode: "retry",
  /** 每次请求最多重发几次。1 就是「只重试一次」。 */
  maxRetries: 1,
  /**
   * 缓冲上限（字符）。超过就不再尝试重试，直接放行。
   * 已观察到的 reasoning-only 事件 thinking 都在 2,400 字符以内，
   * 8 KiB 留了三倍余量；正常长思考越过这条线后与未装插件时一致。
   */
  maxBufferChars: 8192,
  /** 空轮原始证据最多保留多少个目录（带 pinned，不参与普通轮转）。 */
  keep: 100,
};

export function resolveConfig(raw) {
  const out = { ...DEFAULT_CONFIG };
  if (raw === null || typeof raw !== "object") return out;
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (raw.mode === "retry" || raw.mode === "log") out.mode = raw.mode;
  if (Number.isInteger(raw.maxRetries) && raw.maxRetries >= 0 && raw.maxRetries <= 3) out.maxRetries = raw.maxRetries;
  if (Number.isInteger(raw.maxBufferChars) && raw.maxBufferChars >= 1024) out.maxBufferChars = raw.maxBufferChars;
  if (Number.isInteger(raw.keep) && raw.keep >= 1) out.keep = raw.keep;
  return out;
}

function headerMap(headers) {
  const map = new Map();
  if (headers === undefined || headers === null) return map;
  if (typeof headers.entries === "function") {
    for (const [name, value] of headers.entries()) map.set(String(name).toLowerCase(), String(value));
    return map;
  }
  if (typeof headers === "object") {
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value === "string") map.set(name.toLowerCase(), value);
    }
  }
  return map;
}

/** 只看 POST + JSON body + text/event-stream 的 Messages / Completions 请求。 */
function shouldTap(input, init) {
  const method = String(init?.method ?? (typeof input === "object" && input !== null ? input.method : "GET")).toUpperCase();
  if (method !== "POST") return false;
  let url;
  if (typeof input === "string") url = input;
  else if (input instanceof URL) url = input.href;
  else if (input !== null && typeof input === "object" && typeof input.url === "string") url = input.url;
  else return false;
  const path = url.split("?")[0];
  if (!/\/(messages|chat\/completions)$/.test(path)) return false;
  const headers = headerMap(init?.headers ?? (input !== null && typeof input === "object" ? input.headers : undefined));
  if (!/text\/event-stream/i.test(headers.get("accept") ?? "")) return false;
  if (!/application\/json/i.test(headers.get("content-type") ?? "")) return false;
  return true;
}

/** 取请求 URL 与会话 id，供证据落盘对齐（wiretap 的 meta.json 用同一套字段）。 */
function describeRequest(input, init) {
  let url = "";
  if (typeof input === "string") url = input;
  else if (input instanceof URL) url = input.href;
  else if (input !== null && typeof input === "object" && typeof input.url === "string") url = input.url;
  const headers = headerMap(init?.headers ?? (input !== null && typeof input === "object" ? input.headers : undefined));
  return { url, sessionId: headers.get("x-deepseek-harness-session-id") ?? null };
}

/**
 * 读一条流，直到能确定「它交付了东西」或「它结束了」。
 * 已交付时把缓冲原样放行并返回放行状态；结束仍无交付则返回 verdict 供上层决定。
 */
async function probe(reader, controller, maxBufferChars) {
  const decoder = new TextDecoder("utf-8");
  const classifier = createClassifier();
  const buffered = [];
  let bufferedChars = 0;
  let released = false;

  function release() {
    for (const chunk of buffered) controller.enqueue(chunk);
    buffered.length = 0;
    released = true;
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value === null) continue;
      buffered.push(value);
      const text = decoder.decode(value, { stream: true });
      bufferedChars += text.length;
      classifier.feed(text);
      if (classifier.deliverable) {
        release();
        break;
      }
      if (classifier.terminated) break;
      if (bufferedChars > maxBufferChars) {
        release();
        break;
      }
    }
  } catch (error) {
    // 读流失败：已放行的照常结束，未放行的交给上层按 incomplete 处理。
    classifier.flush();
    return { released, classifier, verdict: released ? "deliverable" : "incomplete", error, reader, buffered };
  }

  classifier.flush();
  const verdict = released ? "deliverable" : classify(classifier);
  return { released, classifier, verdict, error: null, reader, buffered };
}

/** 未重试时把已读到的字节原样放行，保持与未装插件时完全一致的行为。 */
async function passthrough(controller, result) {
  for (const chunk of result.buffered) controller.enqueue(chunk);
  await drain(result.reader, controller);
}

/** 把已放行的流余下部分原样透传，然后关闭。 */
async function drain(reader, controller) {
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined && value !== null) controller.enqueue(value);
    }
  } catch {
    /* 上游断开：照常关闭，消费者自己会看到结束 */
  }
  controller.close();
}

function describe(classifier) {
  return {
    dataFrames: classifier.dataFrames,
    stopReason: classifier.stopReason,
    model: classifier.model,
    saidSomething: classifier.saidSomething,
  };
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const stats = {
    intercepted: 0,
    tapped: 0,
    deliverable: 0,
    reasoningOnly: 0,
    retried: 0,
    recovered: 0,
    exhausted: 0,
    overflow: 0,
    incomplete: 0,
    retryFailed: 0,
    passthroughLogMode: 0,
    skippedNoReplayable: 0,
  };

  const capture = createCapture({ root: join(dshHome(), "logs", "reasoning-retry"), keep: config.keep });

  ctx.effect(() => {
    if (!config.enabled) return () => {};
    const original = globalThis.fetch;
    if (typeof original !== "function") {
      appendLog(new Date().toISOString() + " host-warn fetch is not a function; disabled");
      return () => {};
    }
    if (original[PATCHED] === true) {
      appendLog(new Date().toISOString() + " host-warn fetch already patched by another instance");
      return () => {};
    }

    const patched = async function reasoningRetryFetch(input, init) {
      stats.intercepted += 1;
      if (!shouldTap(input, init)) return original.call(globalThis, input, init);

      const requestInfo = describeRequest(input, init);

      // 重发用的请求必须在这一轮 fetch 消费 body 之前准备好。
      let replay = null;
      if ((init?.body === undefined || init?.body === null) && input !== null && typeof input === "object") {
        if (typeof input.clone === "function" && input.bodyUsed !== true) {
          try {
            replay = input.clone();
          } catch {
            replay = null;
          }
        }
      } else if (typeof init?.body === "string") {
        replay = "string-body";
      }

      const response = await original.call(globalThis, input, init);
      if (response === null || typeof response !== "object" || !response.body || response.status !== 200) {
        return response;
      }

      stats.tapped += 1;
      const startedAt = Date.now();

      const retryFetch = async () => {
        if (replay === null) return null;
        const nextInput = replay === "string-body" ? input : replay;
        const nextInit = replay === "string-body" ? { ...init } : init;
        return original.call(globalThis, nextInput, nextInit);
      };

      const body = new ReadableStream({
        start(controller) {
          void run(controller).catch((error) => {
            try {
              controller.error(error);
            } catch {
              /* 已经关闭 */
            }
          });
        },
      });

      const headers = new Headers(response.headers);
      // 我们交出去的是已解压的字节，这两个头必须去掉，否则消费者会二次解码。
      headers.delete("content-encoding");
      headers.delete("content-length");
      headers.delete("transfer-encoding");

      async function run(controller) {
        const first = await probe(response.body.getReader(), controller, config.maxBufferChars);

        if (first.released) {
          stats.deliverable += 1;
          await drain(first.reader, controller);
          return;
        }

        // 未交付：正常空轮。先把原始证据落盘，再决定要不要重试。
        if (first.verdict === "incomplete") stats.incomplete += 1;
        else stats.reasoningOnly += 1;

        // wiretap 可能被加载在本插件外层，那时它记录的是重试后的流，
        // 所以「上游只给了 thinking」这一层证据必须由本插件自己留。
        const captureDir = capture.write({
          url: requestInfo.url,
          sessionId: requestInfo.sessionId,
          status: response.status,
          verdict: first.verdict,
          classifier: first.classifier,
          buffered: first.buffered,
        });

        const detail = {
          ...describe(first.classifier),
          verdict: first.verdict,
          elapsedMs: Date.now() - startedAt,
          captureDir,
        };

        // 这三种情况一律不重试，原样放行，行为与没装插件时一致。
        const why =
          config.mode !== "retry"
            ? "log-only"
            : replay === null
              ? "skip-no-replay"
              : config.maxRetries < 1
                ? "skip-no-retries"
                : null;
        if (why !== null) {
          if (why === "log-only") stats.passthroughLogMode += 1;
          if (why === "skip-no-replay") stats.skippedNoReplayable += 1;
          appendLog(new Date().toISOString() + " observed " + JSON.stringify({ action: why, ...detail }));
          await passthrough(controller, first);
          return;
        }

        try {
          await first.reader.cancel();
        } catch {
          /* ignore */
        }

        let lastEmpty = null;
        let lastRetryMs = 0;

        for (let attempt = 1; attempt <= config.maxRetries; attempt += 1) {
          stats.retried += 1;
          const retryStarted = Date.now();
          let second = null;
          try {
            second = await retryFetch();
          } catch (error) {
            stats.retryFailed += 1;
            appendLog(
              new Date().toISOString() +
                " retry-failed " +
                JSON.stringify({ attempt, message: String(error?.message ?? error), ...detail }),
            );
            break;
          }
          if (second === null || typeof second !== "object" || !second.body || second.status !== 200) {
            stats.retryFailed += 1;
            appendLog(
              new Date().toISOString() +
                " retry-unusable " +
                JSON.stringify({ attempt, status: second?.status ?? null, ...detail }),
            );
            break;
          }

          const again = await probe(second.body.getReader(), controller, config.maxBufferChars);
          if (again.released) {
            stats.recovered += 1;
            const recovered = {
              attempt,
              firstVerdict: detail.verdict,
              firstStopReason: detail.stopReason,
              second: describe(again.classifier),
              retryMs: Date.now() - retryStarted,
              totalMs: Date.now() - startedAt,
            };
            capture.annotate(captureDir, "recovered.json", recovered);
            appendLog(new Date().toISOString() + " recovered " + JSON.stringify({ ...recovered, captureDir }));
            await drain(again.reader, controller);
            return;
          }

          // 仍是空轮：这条流要留着最后原样放行，不能丢。
          if (lastEmpty !== null) {
            try {
              await lastEmpty.reader.cancel();
            } catch {
              /* ignore */
            }
          }
          lastEmpty = again;
          lastRetryMs = Date.now() - retryStarted;
          appendLog(
            new Date().toISOString() +
              " retry-still-empty " +
              JSON.stringify({
                attempt,
                firstVerdict: detail.verdict,
                secondVerdict: again.verdict,
                second: describe(again.classifier),
                captureDir,
              }),
          );
        }

        stats.exhausted += 1;
        const exhausted = {
          retries: config.maxRetries,
          firstVerdict: detail.verdict,
          secondVerdict: lastEmpty === null ? null : lastEmpty.verdict,
          secondStopReason: lastEmpty === null ? null : lastEmpty.classifier.stopReason,
          retryMs: lastRetryMs,
          totalMs: Date.now() - startedAt,
          outcome: "still-reasoning-only",
        };
        capture.annotate(captureDir, "exhausted.json", exhausted);
        appendLog(new Date().toISOString() + " exhausted " + JSON.stringify({ ...exhausted, ...detail }));

        // 方案 A：这里绝不抛错。
        // 普通 Error 会被 dsh-llm-pi-ai 收敛成 TRANSPORT，而 TRANSPORT 就在默认
        // 重试策略的名单里（maxRetries=5），每次重试还会再次触发本插件——请求数会失控。
        // 改为原样放行最后一次的空轮流：一次 fetch 最多两次上游请求，代价可解释。
        if (lastEmpty !== null) {
          for (const chunk of lastEmpty.buffered) controller.enqueue(chunk);
          await drain(lastEmpty.reader, controller);
        } else {
          await passthrough(controller, first);
        }
      }

      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    };
    patched[PATCHED] = true;

    globalThis.fetch = patched;
    appendLog(
      new Date().toISOString() +
        " host-ready " +
        JSON.stringify({
          version: "0.1.2",
          mode: config.mode,
          maxRetries: config.maxRetries,
          maxBufferChars: config.maxBufferChars,
          keep: config.keep,
          captureRoot: capture.root,
        }),
    );

    // 层级自检：两个插件都包装 fetch，谁在外层由加载顺序决定。
    // 只有本插件在最外层时，才可能让内层（wiretap）看不到重试请求反过来污染证据；
    // 反过来若本插件在内层，wiretap 记录的就是处理后的流——所以这里必须留痕。
    const layeringTimer = setTimeout(() => {
      try {
        appendLog(
          new Date().toISOString() +
            " layering " +
            JSON.stringify({
              outermost: globalThis.fetch === patched,
              hint:
                globalThis.fetch === patched
                  ? "retry 在 fetch 链最外层：wiretap 会分别记录第一次和重试请求"
                  : "retry 被包在内层：wiretap 记录的是处理后的流，空轮证据以 captureRoot 下的为准",
            }),
        );
      } catch {
        /* ignore */
      }
    }, 1500);
    layeringTimer.unref?.();

    return () => {
      clearTimeout(layeringTimer);
      if (globalThis.fetch === patched) globalThis.fetch = original;
    };
  }, "dsh-llm-reasoning-retry: fetch interceptor");

  ctx.inject(["webServer"], (host) => {
    host.effect(() => {
      const handler = (req, res) => {
        if (req.method !== "GET") {
          res.writeHead(405);
          res.end();
          return;
        }
        const body = JSON.stringify({ ok: true, mode: config.mode, maxRetries: config.maxRetries, stats, log: logPath() });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(body);
      };
      const dispose = host.webServer.register({ kind: "exact", path: "/dsh-llm-reasoning-retry/stats", handler });
      return () => {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      };
    }, "dsh-llm-reasoning-retry: stats route");
  });
}
