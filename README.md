# dsh-llm-reasoning-retry

给 DeepSeek Harness 的**上游 reasoning-only 空轮恢复器**：上游以 `HTTP 200` + `end_turn` 正常结束，但整条响应只有 `thinking` 块、没有正文也没有工具调用时，用同一份请求原样重发一次。

## 它解决什么问题

长会话里会间歇出现"这一轮没有正文"。本机 2026-10-20 抓到 4 次完整上游证据：

| 时间（UTC+8） | reasoning 字符 | text 增量 | tool 块 | stop_reason |
| --- | ---: | ---: | ---: | --- |
| 20:25:55 | 1,896 | 0 | 0 | `end_turn` |
| 20:30:21 | 2,397 | 0 | 0 | `end_turn` |
| 20:30:49 | 226 | 0 | 0 | `end_turn` |
| 20:35:54 | 1,685 | 0 | 0 | `end_turn` |

四份原始 SSE 里内容块事件只有：

```text
content_block_start(index=0, type=thinking)
content_block_delta(type=thinking_delta)
content_block_delta(type=signature_delta)
content_block_stop(index=0)
```

**上游根本没生成正文**，所以这不是适配器丢内容，是上游就停在了思考阶段。

而 `@deepseek-ai/dsh-llm-pi-ai` 把 `thinking` 也计入 `blocks`，空响应判定是 `blocks.size === 0 && reason.kind === "stop"`，`blocks.size = 1` 不成立 → 这一轮被记成 `completed`，界面上就是一次空轮。

## 怎么工作

在 `globalThis.fetch` 这一层包装响应流，不改 asar、不改请求体、不注入任何头：

1. **边读边判**：`thinking` 不算交付，正文块（`text`）或工具块（`tool_use` / `input_json_delta`）才算；
2. **一出现正文/工具就立即放行**——正常轮次几乎零延迟；
3. **流终止仍无交付** → 用同一份请求（`Request.clone()`）原样重发一次；
4. **第二次仍无交付** → 原样放行并写 `exhausted`，**绝不抛错**；
5. **缓冲超过 `maxBufferChars`** → 不再尝试重试，直接放行（正常的长思考不受影响）。

### 为什么第二次空轮也不报错

`dsh-llm-pi-ai` 对非 `LlmError` 的异常一律收敛成 `TRANSPORT`：

```js
if (options.signal?.aborted) throw new LlmError(..., "ABORTED", ...);
if (error instanceof LlmError) throw error;
throw new LlmError("DeepSeek Messages transport failed", "TRANSPORT", { cause: error });
```

而默认重试策略是

```text
["normal", 5, ["EMPTY_RESPONSE","RATE_LIMIT","SERVER","TIMEOUT","TRANSPORT"], 500, 10000, 0.1]
```

`TRANSPORT` 就在名单里。插件抛出的普通 `Error` 因此会让 DSH 再重试 5 次，每次重试还会再次触发本插件——最坏 12 次上游请求。所以这里改成原样放行：**一次 fetch 最多两次上游请求**，上限确定、成本可解释；代价是用户偶尔看到一个空轮。

重试的两次请求都会各自被 `dsh-llm-wiretap` 落盘（见「与 wiretap 的关系」一节，层级决定两边各留哪一份），本插件自己也留一份故障流。

## 配置

默认值在 `lib/index.js` 的 `DEFAULT_CONFIG`：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `mode` | `"retry"` | `retry` = 判定为空轮后重发；`log` = 只记录不干预 |
| `maxRetries` | `1` | 最多重发几次（1 就是只重试一次） |
| `maxBufferChars` | `8192` | 缓冲上限，超过就不再尝试重试 |

在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: llm-reasoning-retry
  config:
    mode: log
    maxRetries: 1
```

**第一次上线建议先 `mode: log` 跑一段**，确认日志里判定的都是真空轮、且没有误伤正常轮次，再切回 `retry`。

## 日志与诊断

日志：`%DSH_HOME%\logs\dsh-llm-reasoning-retry.log`

事件类型：

| 事件 | 含义 |
| --- | --- |
| `host-ready` | 插件已挂上 fetch |
| `layering` | 启动 1.5 秒后自检：本插件是否处在 fetch 包装链最外层 |
| `observed` | 判定为空轮，但按配置没有重试（`action` 说明原因） |
| `recovered` | 重试拿到了正文/工具，已交付 |
| `retry-still-empty` | 重试仍是空轮 |
| `exhausted` | 重试次数用尽仍是空轮：已原样放行，本次最多两次上游请求 |
| `retry-failed` / `retry-unusable` | 重试请求本身失败 |

诊断端点（宿主 webServer）：

```text
GET http://127.0.0.1:<port>/dsh-llm-reasoning-retry/stats
```

返回 `mode`、计数（`deliverable` / `reasoningOnly` / `retried` / `recovered` / `exhausted`）与日志路径。

## 证据落盘

判定为空轮时，本插件把**已经读到的原始 SSE 字节原样**写到：

```text
%DSH_HOME%\logs\reasoning-retry\<时间戳>-<序号>\
    response.sse    原始字节（已解压，未改写）
    meta.json       url / sessionId / status / verdict / stopReason / model / sseBytes
    pinned          标记为证据
    recovered.json  重试结果的补记（若重试成功）
    exhausted.json  重试耗尽时的补记
```

字段与 `dsh-llm-wiretap` 的 `meta.json` 对齐，便于逐项比对。默认保留 100 份（`keep`）。

**为什么要自己留一份**：见下一节——wiretap 不一定在本插件外层。

## 空轮发生后的操作

恢复侧的 wiretap 目录在 wiretap 眼里是「正常响应」，**不会自动 pin**，继续跑够 `keep=50` 个请求就会被轮转删掉。所以真发生空轮时要尽快冻结：

```bash
node freeze-evidence.mjs                 # 自动取最新一份捕获并配对 wiretap
node freeze-evidence.mjs <id>            # 指定 reasoning-retry 捕获
node freeze-evidence.mjs <id> <wiretap>  # 手动指定配对的 wiretap 目录
```

输出结构：

```text
<OUT>\<retry-id>\
    01-failure\          response.sse  meta.json  pinned  recovered.json | exhausted.json
    02-recovery\         response.sse  meta.json
    03-client-events.jsonl   turn/start、step/start、assistant/message、turn/end、usage
    manifest.json        配对依据、recoveryStatus、验证结果、每个文件的大小与 SHA-256
```

**恢复状态分两种，都归档**

| `manifest.recoveryStatus` | 含义 | 归档内容 |
| --- | --- | --- |
| `recovered` | 第二次拿到了正文或工具 | `01-failure` + `02-recovery` + `recovered.json` |
| `still_reasoning_only` | 第二次仍是空轮（recovery failure） | 同上，但补记是 `exhausted.json`，没有 `recovered.json` |

只有 `recovered` 能计入「重试可恢复」的统计；`still_reasoning_only` 单独算 recovery failure，去支持恢复率或「重试有效」的结论。脚本在后者会明确打印提示。

**三项硬约束**

1. **会话必须相同**：`retry meta.sessionId` 与 wiretap 的 `sessionId`（或请求头 `x-deepseek-harness-session-id`）必须完全相等。时间接近只用于排序和一致性检验，不能单独证明配对。
2. **歧义时拒绝自动选择**：同会话候选多于一个时，只有恰好一个通过一致性检验才自动采用；否则以非零退出码报错并列出全部候选的偏差，要求用第三个参数人工指定。
3. **同时保存客户端事件**：按时间窗定位涉及的 `turn`，把该 turn 的全部会话事件整段带走，保证 turn 结构完整。

**一致性检验**：第一次响应时长 `≈ totalMs - retryMs`，所以 `wiretap.timing.startedAt + (totalMs - retryMs)` 应约等于 retry 目录名时间（判定完成时刻），容差 10 秒。`totalMs`/`retryMs` 在 `recovered.json` 和 `exhausted.json` 里都记，双空时同样可检验。

**自动验证**（结果写进 `manifest.json` 的 `checks`，不通过会明确提示「先别动论文记录」）：

| 检查 | 期望 |
| --- | --- |
| 第一次只有 thinking | `verdict = reasoning-only` |
| 第一次终止原因 | `stopReason = end_turn` |
| 第二次有交付（`recovered`） | `verdict = deliverable`，且存在 `recovered.json` |
| 第二次仍空（`still_reasoning_only`） | `verdict = reasoning-only`，且存在 `exhausted.json` |
| 两次 message_id | 不同 |
| `retryMs < totalMs` | 成立 |
| 两端时间自洽 | 偏差 ≤ 容差 |

## 与 dsh-llm-wiretap 的关系（重要）

两个插件都包装 `globalThis.fetch`，谁在外层**由加载顺序决定，不是由 `bundles` 数组顺序保证**。2026-10-20 实测：`bundles` 里 retry 排在 wiretap 之后，日志却是 retry 先 `host-ready`、wiretap 晚 111ms，实际是 **wiretap 在外层**。

两种层级的差别：

| 层级 | wiretap 看到什么 | 空轮证据在哪 |
| --- | --- | --- |
| retry 在外层 | 第一次（thinking-only）与重试各一份 | 两边都有 |
| **wiretap 在外层**（实测现状） | 只有一份，内容是**重试后的正常响应** | **只在 `logs\reasoning-retry\`** |

也就是说，wiretap 在外层时，它会把一次空轮记成正常响应——不能拿它当"上游只给了 thinking"的证据。这正是本插件自己落盘的原因。

启动日志里的 `layering` 行会写清当前是哪种，字段 `outermost` 为 `true` 表示本插件在最外层。

所以本插件**不依赖**与 wiretap 的加载顺序也能保留完整证据。

## 边界（已确认 / 未确认）

**已确认（实测）**

- 判定器：54 份真实 SSE 回放，判定全对，包含 4 份 reasoning-only；
- 链路：mock fetch 下 25 项通过——恢复、双空时原样放行且上游请求数严格为 2、正常轮不重试、工具轮不重试、`log` 模式原样透传、非 SSE 请求不拦截、空轮原始流与 `exhausted.json` 确实落盘；
- 冻结：25 项通过——会话必须相同、歧义时拒绝自动选择、双空也能完整归档并标记 `still_reasoning_only`；
- 加载与正常流量路径：插件在真实 DSH 进程里 `host-ready`，重启后的真实请求全部判定为有交付并原样放行，未观察到误拦。

**不要把上面的结论读过头**：这些只支持「测试环境与正常流量路径已验证」，**不支持**「已验证能处理 reasoning-only」。后者要求首条真实 `reasoning-retry` 捕获走完冻结与校验；在那一刻之前，空轮捕获、单次重试、证据冻结在真实流量中都还没有发生过。

**未确认**

- 真实故障发生时的端到端恢复效果（要等下一次空轮才看得到 `recovered`）；双空分支（`still_reasoning_only`）已实现并有回归测试，但真实数据里还没出现过；
- 上游 `br` 压缩下的头部处理（已主动删除 `content-encoding` / `content-length` / `transfer-encoding`，因为我们交出去的是已解压字节，但尚未在一次真实空轮上验证）；
- 重试的成本：每次重发都是完整输入（含缓存读取），空轮本身 output 很小，但输入不便宜；
- 当上游是确定性采样时，重试可能原样复现——那时需要切换到「加扰动」策略，当前不做。

## 安装 / 卸载

```bash
node install.mjs          # 装进 %DSH_HOME%\profiles\desktop（幂等、自动备份）
node install.mjs <profile>
```

卸载：从 profile 的 `package.json` 删掉 `dependencies` 与 `dsh.profile.bundles` 里的条目，删掉 `node_modules\dsh-llm-reasoning-retry` 这个 junction，重启。

## 测试

```bash
node test/replay-classify.mjs   # 用真实落盘 SSE 回放判定器
node test/test-retry.mjs        # mock fetch 跑重试链路（含双空：请求数严格 2、exhausted 日志）
node test/test-freeze.mjs       # 冻结脚本：配对/歧义拒绝/双空归档
```
