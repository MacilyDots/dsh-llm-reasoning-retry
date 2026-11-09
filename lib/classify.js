/* dsh-llm-reasoning-retry — SSE 分类器（纯函数，无 I/O）。
 *
 * 目的：在不改变字节的前提下，判断一条上游流是否「交付了东西」。
 * 交付 = 正文块 / 工具调用块，任一出现即算。
 * thinking（reasoning）不算交付——它正是本插件要抓的那种「只说没做」。
 *
 * 支持两种线协议：
 *   Anthropic Messages（content_block_start/delta + message_stop）
 *   OpenAI Completions（choices[].delta + finish_reason / [DONE]）
 * 其它帧一律忽略，绝不抛错。
 */

/** 一个 content_block 的类型是否算「交付」。 */
const DELIVERABLE_BLOCKS = new Set(["text", "tool_use", "server_tool_use"]);
/** 一个 delta 的类型是否算「交付」。 */
const DELIVERABLE_DELTAS = new Set(["text_delta", "input_json_delta", "citations_delta"]);
/** 认识但不交付的块类型（用于区分「只思考」和「什么都没给」）。 */
const THINKING_BLOCKS = new Set(["thinking", "redacted_thinking"]);

export function createClassifier() {
  let buf = "";
  let dataFrames = 0;
  let deliverable = false;
  let terminated = false;
  let thinkingOnly = false;
  let sawContentBlock = false;
  let stopReason = null;
  let model = null;
  let errorType = null;

  function handleFrame(rawFrame) {
    const lines = rawFrame.split(/\r?\n/);
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (dataLines.length === 0) return;
    const payload = dataLines.join("\n").trim();
    if (payload === "") return;
    dataFrames += 1;

    if (payload === "[DONE]") {
      terminated = true;
      return;
    }

    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      return;
    }
    if (obj === null || typeof obj !== "object") return;

    // ── Anthropic Messages ──────────────────────────────────────────
    if (obj.type === "content_block_start") {
      sawContentBlock = true;
      const type = obj.content_block?.type;
      if (DELIVERABLE_BLOCKS.has(type)) deliverable = true;
      else if (THINKING_BLOCKS.has(type)) thinkingOnly = true;
      return;
    }
    if (obj.type === "content_block_delta") {
      const type = obj.delta?.type;
      if (DELIVERABLE_DELTAS.has(type)) deliverable = true;
      return;
    }
    if (obj.type === "message_delta") {
      if (typeof obj.delta?.stop_reason === "string") stopReason = obj.delta.stop_reason;
      return;
    }
    if (obj.type === "message_stop") {
      terminated = true;
      return;
    }
    if (obj.type === "message_start") {
      if (typeof obj.message?.model === "string") model = obj.message.model;
      return;
    }
    if (obj.type === "error") {
      terminated = true;
      errorType = obj.error?.type ?? "error";
      return;
    }

    // ── OpenAI Completions（含兼容端点）─────────────────────────────
    if (Array.isArray(obj.choices)) {
      for (const choice of obj.choices) {
        const delta = choice?.delta;
        if (delta !== null && typeof delta === "object") {
          if (typeof delta.content === "string" && delta.content.length > 0) deliverable = true;
          if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) deliverable = true;
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) thinkingOnly = true;
        }
        if (typeof choice?.finish_reason === "string" && choice.finish_reason !== "") {
          terminated = true;
          stopReason = choice.finish_reason;
        }
      }
      return;
    }
  }

  return {
    /** 喂入一段已解码的文本增量；跨 chunk 的不完整帧留在内部缓冲里。 */
    feed(text) {
      if (typeof text !== "string" || text.length === 0) return;
      buf += text;
      // 帧边界是空行；\n\n 与 \r\n\r\n 都要认。
      for (;;) {
        const m = buf.match(/\r?\n\r?\n/);
        if (m === null) break;
        const frame = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        if (frame.length > 0) handleFrame(frame);
      }
    },
    /** 流已结束：把残留缓冲当成最后一帧处理。 */
    flush() {
      const rest = buf;
      buf = "";
      if (rest.trim() !== "") handleFrame(rest);
    },
    /** 是否已交付正文或工具调用（一旦为 true 就永不回退）。 */
    get deliverable() {
      return deliverable;
    },
    /** 是否已看到终止帧（message_stop / finish_reason / [DONE] / error）。 */
    get terminated() {
      return terminated;
    },
    /** 是否见过 thinking 块（用于区分 reasoning-only 与彻底空响应）。 */
    get saidSomething() {
      return sawContentBlock || thinkingOnly;
    },
    get stopReason() {
      return stopReason;
    },
    get model() {
      return model;
    },
    get errorType() {
      return errorType;
    },
    get dataFrames() {
      return dataFrames;
    },
  };
}

/**
 * 判定一条已经结束的流属于哪一种。
 * @param {object} classifier createClassifier() 的实例（应已 flush）
 * @returns {"deliverable"|"reasoning-only"|"empty"|"incomplete"|"upstream-error"}
 */
export function classify(classifier) {
  if (classifier.errorType !== null) return "upstream-error";
  if (classifier.deliverable) return "deliverable";
  if (!classifier.terminated) return "incomplete";
  if (classifier.saidSomething) return "reasoning-only";
  return "empty";
}
