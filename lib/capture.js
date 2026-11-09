/* dsh-llm-reasoning-retry — 空轮原始流落盘。
 *
 * 为什么不能只靠 dsh-llm-wiretap：两个插件都包装 globalThis.fetch，
 * 谁在外层取决于加载顺序。一旦 wiretap 在外层，它 clone 到的就是本插件
 * 处理后的流——真出故障时它会看到「重试后的正常响应」，从而把那一轮记成
 * 正常，等于把最该留的证据抹掉。
 *
 * 所以本插件在这里自己留一份：判定为非交付的那一刻，把已经读到的原始
 * SSE 字节原样写盘。层级无关，永远有效。
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}

function stamp(date) {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}`
  );
}

export function createCapture({ root, keep }) {
  let seq = 0;

  function rotate() {
    try {
      const dirs = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
      while (dirs.length > keep) {
        const victim = dirs.shift();
        try {
          rmSync(join(root, victim), { recursive: true, force: true });
        } catch {
          /* 删不掉就算了，不能因为清理失败丢证据 */
        }
      }
    } catch {
      /* ignore */
    }
  }

  return {
    root,
    /**
     * @param {object} record
     * @param {string} record.url
     * @param {string|null} record.sessionId
     * @param {number} record.status
     * @param {string} record.verdict
     * @param {object} record.classifier
     * @param {Array<Uint8Array>} record.buffered 原始字节（已解压，未改写）
     * @param {object} [record.extra]
     * @returns {string|null} 目录路径
     */
    write(record) {
      try {
        const now = new Date();
        seq += 1;
        const id = `${stamp(now)}-${pad(seq, 3)}`;
        const dir = join(root, id);
        mkdirSync(dir, { recursive: true });

        const bytes = Buffer.concat(record.buffered.map((b) => Buffer.from(b)));
        writeFileSync(join(dir, "response.sse"), bytes);
        writeFileSync(
          join(dir, "meta.json"),
          JSON.stringify(
            {
              id,
              capturedAt: now.toISOString(),
              url: record.url,
              sessionId: record.sessionId,
              status: record.status,
              verdict: record.verdict,
              stopReason: record.classifier.stopReason,
              model: record.classifier.model,
              saidSomething: record.classifier.saidSomething,
              dataFrames: record.classifier.dataFrames,
              sseBytes: bytes.length,
              ...(record.extra ?? {}),
            },
            null,
            2,
          ),
        );
        // 与 wiretap 同形：带 pinned 的目录是证据，不该被当成普通轮转对象。
        writeFileSync(join(dir, "pinned"), "");
        rotate();
        return dir;
      } catch {
        return null;
      }
    },

    /** 重试结果补记，便于事后一眼看出这条证据最后是怎么收场的。 */
    annotate(dir, name, payload) {
      if (dir === null) return;
      try {
        writeFileSync(join(dir, name), JSON.stringify(payload, null, 2));
      } catch {
        /* ignore */
      }
    },
  };
}
