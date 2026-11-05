# DSH 适配层核实记录 / Verification record

**状态：已按真实 DSH 源码核实。** 出处是本地 checkout
`D:\deepseek harness\deepseek-harness`，每条都标了文件与行号。

> 早先这份文档是一份「待对齐清单」，写着事件名都是猜的。那些猜测已经被源码取代，
> 所以下面直接给答案；只剩最后一节保留「怎么重新核对」，用于 DSH 升级后复查。

`core/` 与 ZCode 版共用，宿主差异全部集中在 `dsh/src/dsh-adapter.ts`。

---

## 事件与用途

| 用途 | 事件 | 模式 | 出处 |
| --- | --- | --- | --- |
| 召回注入 | `agent/pre-step` | waterfall | `core/agent/src/runtime-types.ts:231` |
| 会话开始 | `agent/session-start` | emit | `runtime-types.ts:217` |
| 事前拦截 | `tools/pre-execute` | waterfall | `core/tools/src/index.ts:152` |
| 感知结果 | `tools/post-execute` | waterfall | `core/tools/src/index.ts:175` |
| 回合收尾 | `agent/turn-stopping` | serial | `runtime-types.ts:278` |

这些名字有一条**契约钉住测试**（`test/dsh.test.mjs` 的 `DSH_EVENTS names the real host events`）：
新增或改名会立刻失败，逼你回到源码核对，而不是顺手改断言。

## 注入通道

`agent.inject(message)` 是官方说明里点名的通道（"Queue model-facing context for the
next pre-step"）。注入内容在 `agent/pre-step` 的 waterfall 里也能改——返回
`{ kind: 'enter', messages: [...] }` 即替换本步进入模型的消息。

一回合只注入一次：`lastInjectedTurn` 记住已注入的回合号。工具循环里每步都注入既会重复灌入，
也会把命中数灌成「这回合跑了几步」的噪声。

## 失败语义（最容易做错的一条）

`isError` **不足以判断失败**。`packages/shell/tool-bash/src/render.ts:17-21` 写明：

> 非零退出被「上报」，不是「出错」——只有基础设施级失败（spawn 错误、中断）才表现为 isError。

所以 `bash` 退出码 1 会以 `isError: false` 到达，真相埋在渲染文本最后一行
（`[exit code: 1]`）和结构化的 `value.exitCode` 里。`judgeOutcome()` 三个信号一起读：
结构化退出码 → `isError` → 渲染尾行标记。

## 事前拦截的返回形状

`PreToolDecision`（`core/tools/src/index.ts:588`）：

```ts
type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }
```

`allow` 要调 `next()` 交给下一层；`deny` 直接返回、不调 `next()`。
**这个类型没有携带上下文的字段**，所以 `IMMUNE_GUARD=warn` 只能在 ZCode 侧生效——
the agent harness 侧只能「拦或不拦」。

## 存储

`$DSH_HOME/storages/dsh-immune-system/<sha1(cwd)[0..16]>.sqlite`，按项目隔离。
`IMMUNE_DB_PATH` 可覆盖。全局共享库是同目录下的 `global.sqlite`。

用两条独立连接而非 `ATTACH DATABASE`：SQLite 明确说明 WAL 下跨附加库事务不原子，
而本插件每进程短连接、多 hook 并发。

---

## DSH 升级后怎么重新核对

改动 `dsh-adapter.ts` 之前，按顺序确认这四件事，每条都要有源码行号：

1. **事件名还在不在。** `grep -rn "tools/pre-execute\|agent/pre-step" packages/core/*/src`
   ——事件声明都是生成进 subsystem 文档的，源码里带 `@mode` 注释。
2. **失败判定有没有变。** 看 `packages/shell/tool-bash/src/render.ts` 与
   `judgeOutcome()`；如果上游改成真的抛异常，可以简化成读 `isError`。
3. **`PreToolDecision` / `PostToolDecision` 的成员。** 有没有多出携带上下文的形态
   ——如果有，`warn` 模式就能在 the agent harness 侧也实现。
4. **`agent.inject` 与 `agent/pre-step` 的关系。** 注入是「排队」还是「当步生效」，
   决定要不要同时保留两处。

跑：

```bash
npm run build     # 0 错误
npm test          # 59 条
```

`test/dsh.test.mjs` 里有真 Cordis 式的假宿主（`fakeContext` + `waterfall` 链式调用），
钉住事件名、失败判定和拦截返回形状。改动适配层后先看它。

---

## 激活验证（2026-11-06）

宿主半区已在**真实 DSH profile 启动**中验证加载与激活：

1. 最小 profile（dsh-base + 本插件）boot 曾失败，根因是第三方主题包
   `@linxin666/dsh-client-ui-skin-blue-fantasy` 缺失（`dsh-web-ui-all` 的跨插件
   依赖）——**与本项目无关**；如果 DSH web 启动报同样的包缺失，先补装它。
2. 补齐后 boot 成功：50 秒运行窗口内 0 错误 0 崩溃（此前两次均死于皮肤包）。
3. 激活证据：`8636c0f2f7cb7f49.sqlite`（= sha1("D:\deepseek harness\deepseek-harness")
   前 16 位）的 WAL/SHM 时间戳落在 boot 窗口内——插件的
   `ctx.inject(['webServer'])` 可选路由与全部事件注册在真实 cordis 树中执行。

仍未验：浏览器侧 tab 的实际渲染（需要带 GUI 的 web 会话）。

---

## 一句话

> 契约已核实，不是猜的。要改就从 `dsh-adapter.ts` 一处改，
> 改完让 `npm test` 里的契约钉住测试告诉你哪里不一致。
