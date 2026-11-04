# DSH 宿主契约审计（免疫插件移植用）

- 审计对象：DSH 真实实现 checkout `D:\deepseek harness\deepseek-harness\`
- 审计方式：**只读**静态审计。下文所有 `路径:行号` 均相对该 checkout 根；引文为逐字摘录。
- 本文只回答下面 7 个契约问题；每条先给一句话结论，再给证据。无法在本 checkout 证实的，明确标「未证实」。

---

## a. `ToolExecutionResult.content` 如何生成；`tools/post-execute` 处 `result.content[0].text` 是否已含渲染文本（含末行 `[exit code: N]`）

**结论：是。** `content` 在工具 body 返回后、`tools/post-execute` 之前就已由 `ToolRuntime.createSuccessResult` 同步生成；对 `dsh-tool-bash`，它来自 `output.render` → `renderResult(...)`，因此监听 `tools/post-execute` 时 `result.content[0].text` 已包含 stdout / `[stderr]` 段 / 末尾 `[exit code: N]` 标记。

### 把 value 变成 content 的运行时代码位置

`packages/core/tools/src/index.ts:1532-1560`（`dispatchToolBody`）——body 返回值立刻进入 `createSuccessResult`：

```
1548:      state.bodyInvoked = true
1549:      const returned = await tool.execute(exec.arguments, exec)
1550:      const result = this.createSuccessResult(exec, tool, returned)
```

`packages/core/tools/src/index.ts:1792-1804`（`createSuccessResult`）——这里就是 value → content 的转换点：

```
1793:  private createSuccessResult(exec: ToolExecution, tool: ToolDefinition, candidate: unknown): ToolExecutionSuccess {
1794:    const detached = snapshotToolValue(tool.name, candidate)
1795:    const violations = validateJsonSchemaValue(tool.output.schema, detached, 'value')
1796:    if (violations.length > 0) throw new ToolOutputError(tool.name, violations)
1797:    const value = deepFreeze(detached)
1798:    let rendered: ContentBlock[]
1799:    try {
1800:      rendered = tool.output.render(exec.arguments, value)
1801:    } catch (error: unknown) {
1802:      throw projectionError(tool.name, 'render', error)
1803:    }
1804:    const content = snapshotProjection(tool.name, 'render', rendered)
```

契约声明（`packages/core/tools/src/index.ts:211-219`）：

```
211: export interface ToolOutputDefinition {
212:   /** Raw supported JSON Schema enforced against every successful canonical value. */
213:   readonly schema: JsonSchemaNode
214:   /** Pure projection from validated arguments and value to Native/model content. */
215:   render(args: unknown, value: JsonValue): ContentBlock[]
```

### post-execute 能看到的确实是这份 content

`packages/core/tools/src/index.ts:1609-1621` → `:1742-1746`：dispatch 结果（已含 content）原样作为 `postExecute` 的 `result` 参数进入 waterfall：

```
1611:      const postResult = await this.postExecute(exec, result)
...
1743:    const decision = await this.ctx.waterfall(
1744:      scopeTarget(this, exec.agent), 'tools/post-execute', exec, result,
```

### bash 侧：render 产出含末行 exit code 标记

`packages/shell/tool-bash/src/index.ts:323-328`：

```
323:      render: (_args, value) => [{
324:        type: 'text',
325:        text: value.kind === 'background'
326:          ? `started background job ${value.jobId}`
327:          : renderResult(value as { kind: 'foreground' } & ShellRunResult, escalationModes),
328:      }],
```

`packages/shell/tool-bash/src/index.ts:389`（body 只返回 value，不产出 content）：

```
389:      return { kind: 'foreground' as const, ...canonicalBashResult(result) }
```

`packages/shell/tool-bash/src/render.ts:17-21` JSDoc 逐字：

```
 * Shape one finished run into the text the model sees: stdout, then a marked stderr section, then exit-status markers.
 * Non-zero exits are reported, not errored — the model decides how to react; only infrastructure failures (spawn errors, aborts) surface as isError results.
```

`packages/shell/tool-bash/src/render.ts:54-62`（marker 生成，exit code 恒为最后一个）：

```
54:  if (result.signal !== null) {
55:    markers.push(`[killed by signal: ${result.signal}]`)
56:  } else if (result.exitCode !== 0) {
57:    markers.push(`[exit code: ${result.exitCode}]`)
...
59:  if (markers.length === 0) return body
60:  if (!body.endsWith('\n')) body += '\n'
61:  return body + markers.join('\n')
```

`packages/shell/tool-bash/src/render.ts:44` 注释：`// Keep the exit marker last because parseExitStatus anchors there.`

### bash 测试断言（作证）

`packages/shell/tool-bash/tests/tools.spec.ts:255-260`——非零退出既不是 isError，文本末行就是 exit 标记：

```
255:  it('reports non-zero exits without isError', async () => {
257:    const result = await call(ctx, 'bash', { command: 'echo failing; exit 3', description: 'test command' })
258:    expect(result.isError).toBe(false)
259:    expect(text(result)).toBe('failing\n[exit code: 3]')
```

同文件 `:224-240` 断言成功路径 `text(result) === 'hello\n'` 且 `result.value` 形状完整；`:245` 静默命令 → `'(no output)'`；`:251` stderr → `'out\n[stderr]\nerr\n'`；`:266` 超时 → `'(no output)\n[timed out after 100ms]\n[killed by signal: SIGTERM]'`。

其中 `text()` 定义在 `packages/shell/tool-bash/tests/tools.spec.ts:82-84`，即「拼接全部 text block」：

```
82: function text(result: { content: { type: string; text?: string }[] }): string {
83:   return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
```

### 重要边界（移植时必须知道）

1. 在 `tools/post-execute` 里，`result` **已冻结**，不能原地修改：`packages/core/tools/tests/tools.spec.ts:685-695` 断言 `Reflect.set(result, 'content', [])` 为 `false`；`:1700-1717` 断言 around/post 两处 mutation 尝试均失败。
2. post-execute 对**失败结果同样触发**：`packages/core/tools/tests/tools.spec.ts:1719-1738`（body 抛错后 `result.content[0]` 匹配 `Error: exploded`）。
3. 若监听器返回 `kind:'accept', content}` 或 `value}`，最终 content 会被替换/重算——见问题 e。
4. `tools/pre-execute` 抛错时**不**进 post-execute：`packages/core/tools/tests/code-mode.spec.ts:970`（`'a throwing tools/pre-execute listener settles the sub-call without post-execute'`）。

---

## b. `tools/post-execute` 处 `result.value` 是否原样保留为未变形 JsonValue

**结论：是。** `value` 在 post-execute 处未经任何形状改写：它经 `snapshotJsonValue` 深拷贝 + `deepFreeze` 冻结 + schema 校验后原样携带。语义上「原样保留」，但**不是原对象引用**（是 detached 的等价快照，且被冻结）。

`packages/core/tools/src/index.ts:1794-1797`：detach（校验/深拷贝）→ 校验 → 冻结：

```
1794:    const detached = snapshotToolValue(tool.name, candidate)
1795:    const violations = validateJsonSchemaValue(tool.output.schema, detached, 'value')
1797:    const value = deepFreeze(detached)
```

`packages/core/session/src/json.ts:165-179` JSDoc + 实现——snapshot 只做校验与脱离，不做形变：

```
165: /**
166:  * Validate and detach lossless JSON in one read per property, so a stateful
167:  * getter cannot change between validation and copying. ... Accepts ordinary arrays, plain or null-prototype objects, and JSON
170:  * scalars; rejects sparse, cyclic, exotic, negative-zero, and non-finite values.
177: export function snapshotJsonValue<T>(value: T): T | undefined {
178:   return walkJsonValue(value, true) as T | undefined
```

`packages/core/tools/src/index.ts:1846-1862`（`materializeFinalResult`）——成功分支把 value 原样并入冻结结果：

```
1856:    const detached = materializePresentation({
...
1861:    return deepFreeze({ ...detached, value: result.value })
```

类型契约（`packages/core/tools/src/index.ts:556-566`）：

```
558:  /** Execution-local canonical value; deliberately omitted from durable events. */
559:  readonly value: JsonValue
560:  readonly content: ContentBlock[]
```

测试作证：
- `packages/core/tools/tests/tools.spec.ts:92`：`expect(result).toEqual({ content: [{ type: 'text', text: 'hi' }], isError: false, value: 'hi' })` —— value 与 content 并存且互不污染。
- `packages/shell/tool-bash/tests/tools.spec.ts:230-238`：`expect(result.value).toMatchObject({ kind: 'foreground', exitCode: 0, signal: null, timedOut: false, aborted: false, stdout: { text: 'hello\n', truncated: false }, stderr: { text: '', truncated: false } })`。

**注意**：`value` 只存在于执行期内（类型注释：`deliberately omitted from durable events`）；`packages/core/agent-loop/src/tool-calls.ts:276-289` 写 `session.append('tool/result', ...)` 时只带 `content`/`isError`/`error.info`/`meta`，不带 value。

---

## c. `Agent.id` 与 `Agent.session.header.id` 是否同值

**结论：是，恒等。** `Agent.id` 就是创建时传入的 `SessionId`，同一个值被交给 `Session` 作为 header 里的 id；`Session.id` 又从 header 派生，因此三者同值。

类型契约 `packages/core/agent/src/runtime-types.ts:64-70`：

```
64: export interface Agent {
65:   /** The single identity shared with {@link session}. */
66:   readonly id: SessionId
...
70:   readonly session: Session
```

实现 `packages/core/agent-loop/src/agent.ts:80-85`——构造时 id 与 session 成对传入：

```
80:  constructor(
81:    private loopCtx: Context,
82:    public readonly id: SessionId,
83:    public readonly options: AgentOptions,
84:    public readonly session: Session,
85:  ) {
```

`Session.id` 由 header 派生 `packages/core/session/src/index.ts:443-448`：

```
443:   readonly header: SessionHeader
...
445:   /** The session identity, derived from its durable header's single copy. */
446:   get id(): SessionId {
447:     return this.header.id
448:   }
```

`packages/core/session/src/types.ts:61-69`：

```
61: export interface SessionHeader {
...
68:   /** The session's id (mirrors the {@link Session}'s id). */
69:   readonly id: SessionId
```

测试断言：
- `packages/core/agent-loop/tests/loop.spec.ts:1446`：`expect(agent.id).toBe(agent.session.id)`
- `packages/core/agent-loop/tests/config-session-id.spec.ts:362` / `:381`：`expect(a1.id).toBe(a1.session.id)` / `expect(a2.id).toBe(a2.session.id)`
- `packages/core/agent-loop/tests/resume.spec.ts:188-189`：`expect(agent.session.id).toBe('custom-session')`

⇒ 插件里用 `agent.id` 与 `agent.session.header.id` 作会话标识等价；宿主自身也这么用，如 `packages/shell/shell-env/src/index.ts:158`：`values[DSH_SESSION_ID_KEY] = execution.agent.session.header.id`。

---

## d. 外部插件可用的 Context 面：`on` / `effect` / `logger` / `get` / `inject` / `commands`

**结论：`on`、`effect`、`logger`、`get`、`inject` 全部存在于 `@deepseek-ai/cordis` 的 `Context` 类型上，且都是固有属性或 mixin，插件无需 `inject` 即可访问；`commands` 是 DSH 的服务属性，必须 `inject: ['commands']`（或 `ctx.inject(['commands'], ...)`）才能访问。**

cordis 固有属性 `vendor/cordis/src/context.ts:16-33`：

```
16: export interface Context {
...
25:   /** The event bus. Its methods are also mixed onto ctx (ctx.on, ctx.emit, ...). */
26:   events: EventsService
27:   /** The logging service. Call ctx.logger(name) for a named logger. */
28:   logger: LoggerService
29:   /** The reflection layer backing the context proxy (ctx.get, ctx.provide, ...). */
30:   reflect: ReflectService
31:   /** The plugin registry. Its methods are mixed onto ctx (ctx.plugin, ctx.inject). */
32:   registry: RegistryService
33: }
```

构造函数 `vendor/cordis/src/context.ts:71-84` 给它们赋实体实例（`this.logger = new LoggerService(self)` 等）⇒ 非服务注册，无需 inject。

mixin 表 `vendor/cordis/src/reflect.ts:219-222`：

```
219:    this.mixin('reflect', ['get', 'set', 'provide', 'accessor', 'mixin'])
220:    this.mixin('fiber', ['runtime', 'effect'])
221:    this.mixin('registry', ['inject', 'plugin'])
222:    this.mixin('events', ['on', 'once', 'parallel', 'emit', 'serial', 'bail', 'waterfall'])
```

逐项位置：

| 面 | 类型声明 | 说明 |
| --- | --- | --- |
| `on` | `vendor/cordis/src/events.ts:97` `on<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean` | JSDoc:90-96 `Register an event listener owned by the current fiber.`；`:106` 另有 `once` |
| `effect` | `vendor/cordis/src/fiber.ts:415-418` `effect(execute: () => Effect, label = 'anonymous'): any` | JSDoc:402-414 `Register a cleanup-aware effect on this fiber. execute runs immediately; the disposers it produces are collected and run (in reverse order)… Throws CordisError('INACTIVE_EFFECT') if the fiber is already disposed`；`fiber.ts:9-14` 声明 `Context extends Pick<Fiber, 'effect'>` |
| `logger` | `vendor/cordis/src/context.ts:27-28` `logger: LoggerService` | `vendor/cordis/src/logger.ts:183-186` `export interface LoggerService extends Record<LoggerType, LoggerMethod> { (name?: string): Logger }`；`logger.ts:13` `export type LoggerType = 'error' | 'info' | 'warn' | 'debug'` |
| `get` | `vendor/cordis/src/reflect.ts:8-19` `get<K extends string & keyof this>(name: K, strict?: boolean): undefined | this[K]` | JSDoc:9-16 逐字 `Read a service from the store without the inject requirement.` ⇒ 明确免 inject；实现 `reflect.ts:233-235` |
| `inject` | `vendor/cordis/src/registry.ts:176` `inject(deps: Inject, callback: Plugin.Function<void>): Fiber & PromiseLike<Fiber>` | 实现 `registry.ts:300-302` `inject(inject: Inject, callback) { return this.plugin({ inject, apply: callback, name: callback.name }) }` |
| `commands` | **DSH 扩充**：`packages/interaction/commands/src/index.ts:104-108` `declare module '@deepseek-ai/cordis' { interface Context { commands: CommandRuntime } }` | 是服务属性 ⇒ 必须 inject |

### 哪些必须先 `inject` 才能访问

**只有服务（service）属性需要。** 访问未声明的服务名会被 Proxy 直接抛错 `vendor/cordis/src/reflect.ts:135-171`：

```
144:            const error = new Error(`cannot get property "${prop}" without inject`)
...
153:            return ctx.events.waterfall('internal/get', ctx, prop, error, () => {
```

（`logger` / `events` / `reflect` / `registry` / `effect` / `get` / `on` / `emit` / … 是自有属性或 mixin，不经过该分支，因此免 inject。）

服务名是否参与插件激活，只由插件自己声明的 `inject` 决定：`vendor/cordis/src/fiber.ts:314-319`、`:611-623`（`for (const name of Object.keys(this.inject)) { const impl = this._store[name]; if (!impl) { epoch = INACTIVE; break } ... }`）。

⇒ `commands` 需 inject。插件级实例：`packages/compaction/command-compact/src/index.ts:10-11` `export const inject = ['commands', 'compaction']`。工具插件同理，如 `packages/shell/tool-bash/src/index.ts:31` `export const inject = ['tools', 'shell', 'systemPrompt', 'shellEnv']`。

未 inject 就加载会当场抛错的证据注释：`packages/fs/tool-fs-search/tests/load-path.spec.ts:7` 逐字 `* \`cannot get property … without inject\` the moment it loads (postmortem 0001).`

**命令面签名（移植用）** `packages/interaction/commands/src/index.ts`：

```
33: export interface CommandInvocation {
35:   readonly commandId: CommandId
36:   readonly agent: Agent
37:   /** Exact text following the registered command name, including separator whitespace. */
38:   readonly rawInput: string
39:   readonly attachments: readonly ImageBlock[]
40:   readonly signal: AbortSignal
```

```
53: export interface CommandDefinition {
54:   readonly name: string
55:   readonly description: string
...
67:   readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
```

`register` 返回注销函数：`:270-277`（JSDoc:265-269 `Register a global or calling-agent-scoped command. @returns the exact effect disposer that unregisters this definition.`）。结果归一化在 `:216-243`（`kind:'success'` 可选 text；`kind:'error'` 必须非空 text）。

---

## e. `PostToolDecision.additionalContexts` 运行期如何应用；`accept` 三种变体的差别

**结论：** `additionalContexts` 与 `result.additionalContexts` 拼接后挂到最终 `result` 上，由 agent-loop 逐条塞回 inbox 的 `next-step`，成为**下一次** `agent/pre-step` 的 `messages` 成员。`kind:'accept'}` 不带其他字段 = 原样透传（`...result}`）。`kind:'accept', content}` **只**替换 content，value/meta 保留；`kind:'accept', value}` 会**重新走一遍 `createSuccessResult`**：schema 重新校验、`output.render` 重新派生 content、`presentationMeta` 重算 meta。

### 运行期应用位置

`packages/core/tools/src/index.ts:1742-1781`（`postExecute`）：

```
1743:    const decision = await this.ctx.waterfall(
1744:      scopeTarget(this, exec.agent), 'tools/post-execute', exec, result,
1745:      () => Promise.resolve<PostToolDecision>( kind: 'accept' }),
1746:    )
1747:    const decisionContexts = decision.additionalContexts ?? []
1748:    if (decision.kind === 'block') {
1749:      const message = failureMessageFromContent(decision.feedback)
1750:      return this.markCanonical(exec, {
1751:        content: decision.feedback,
1752:        isError: true,
1753:        error: { message },
1754:        ...decisionContexts.length > 0 ? { additionalContexts: decisionContexts } : {},
1755:      })
1756:    }
1757:    if (Object.hasOwn(decision, 'content') && Object.hasOwn(decision, 'value')) {
1758:      throw new TypeError('tools/post-execute accept decision cannot replace both value and content')
1759:    }
1760:    const additionalContexts = [
1761:      ...result.additionalContexts ?? [],
1762:      ...decisionContexts,
1763:    ]
1764:    if (Object.hasOwn(decision, 'value')) {
1765:      if (result.isError) {
1766:        throw new TypeError('tools/post-execute cannot replace the value of a failed result')
1767:      }
1768:      const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== undefined)
1769:      if (tool === undefined) throw new ToolNotFoundError(exec.name)
1770:      const replaced = this.createSuccessResult(exec, tool, decision.value)
1771:      return this.markCanonical(exec, {
1772:        ...replaced,
1773:        ...additionalContexts.length > 0 ? { additionalContexts } : {},
1774:      })
1775:    }
1776:    return this.markCanonical(exec, {
1777:      ...result,
1778:      ...decision.content !== undefined ? { content: decision.content } : {},
1779:      ...additionalContexts.length > 0 ? { additionalContexts } : {},
1780:    })
```

类型定义 `packages/core/tools/src/index.ts:597-600`：

```
597: export type PostToolDecision =
598:   | { kind: 'accept'; content?: ContentBlock[]; value?: never; additionalContexts?: UserMessage[] }
599:   | { kind: 'accept'; value: JsonValue; content?: never; additionalContexts?: UserMessage[] }
600:   | { kind: 'block'; feedback: ContentBlock[]; additionalContexts?: UserMessage[] }
```

### 从 result 到「下一步的 messages」

`packages/core/agent-loop/src/tool-calls.ts:151-157`：

```
151:      const result = slot.needsPost
152:        ? await ctx.tools[TOOL_RUNTIME_SCHEDULER].finalize(slot.exec, slot.result)
153:        : ctx.tools[TOOL_RUNTIME_SCHEDULER].finish(slot.exec, slot.result)
...
155:      appendToolResult(session, turn, step, call!.block, result, callSeqs[committed]!)
156:      for (const context of result.additionalContexts ?? []) acceptContext(context)
157:      concluded ||= result.concludesTurn === true
```

`acceptContext` 实为 `packages/core/agent-loop/src/agent.ts:414-417` 传入的闭包：

```
414:      const { concluded } = await executeToolCalls(
415:        this.loopCtx, turn, step, toolCalls, signal,
416:        context => this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context]),
417:      )
```

⇒ 这些上下文成为 `next-step` 待处理项，在下一次 `agent/pre-step` 时被 `inbox.claim` 取走（`packages/core/agent-loop/src/agent.ts:229`：`const claimed = this.inbox.claim(target, position.turn)`），从而出现在 `agent/pre-step` 的 `payload.messages` 中。

### 三个变体的实测差别（测试作证）

`packages/core/tools/tests/tools.spec.ts:342-395`（测试名逐字：`keeps value/meta through content replacement and recomputes both projections after value replacement`）：

- `kind:'accept', content}` 变体：`expect(content).toEqual({ isError: false, value: { text: 'body' }, content: [{ type: 'text', text: 'policy content' }], meta: { projected: 'body' } })` ⇒ **value 与 meta 原样保留**，只有 content 被换。
- `kind:'accept', value}` 变体：`expect(value).toEqual({ isError: false, value: { text: 'policy value' }, content: [{ type: 'text', text: 'render:policy value' }], meta: { projected: 'policy value' }, additionalContexts: [...] })` ⇒ **content 由新 value 经 `output.render` 重新派生，meta 由 `presentationMeta` 重算**。

其它边界（同文件）：
- `:397-417` 同时给 content 与 value → `error.message === 'tools/post-execute accept decision cannot replace both value and content'`；`:419-434` block → ` isError: true, error: { message: 'blocked by policy' }, content: [{ type: 'text', text: 'blocked by policy' }] }`，无 value。
- `:449-459` 空 feedback / 纯 reasoning feedback → 稳定消息 `tool result blocked by post-execute policy` / `[reasoning content]`。
- `:476-490` 对失败结果替换 value → `'tools/post-execute cannot replace the value of a failed result'`。
- `:856-866` `kind:'accept', content}` → `result.isError === false` 且 `content[0].text === 'rewritten'`。
- `:929-946` block + additionalContexts → `result.additionalContexts` 含 ` content: [{ type: 'text', text: 'why it was rejected' }], source: { kind: 'plugin', plugin: 'test' } }`。
- `:948-959`（测试名逐字 `post-execute additionalContexts ride on the result for the loop to buffer`）：`kind:'accept', additionalContexts:[…]}` 挂到 `result.additionalContexts`。
- `:961-1010` 顺序：nested-1 / nested-2（工具自身 defer）→ wrapper（`tools/execute`）→ post（`tools/post-execute`），`result.additionalContexts` 的来源数组精确等于这四者 ⇒ defer 的上下文排在被 block 的外层之前；`:1012-1028` 复合工具抛错时保留 deferred contexts，外层被 block 时丢弃。

另有一个「不能原地改」的前提：post-execute 收到的 `result` 已冻结（`packages/core/tools/tests/tools.spec.ts:685-695`、`:1700-1717`），必须返回新的 decision。

---

## f. `agent/session-start` 是否在真实 loop 的首个 `agent/pre-step` 之前发射

**结论：是，且是同步在 `create`/`resume` 内发射的——早于任何 turn、早于首个 pre-step。** 扩展点收到事件时，agent 已注册、session 已宣布，且可以直接向 inbox 注入上下文并让**第一个**请求就看到它。

发射点 `packages/core/agent-loop/src/index.ts:553-569`（`publish`）：

```
556:        publish: (source) => {
557:          assertLive()
558:          detachSession = agent.ctx.sessions.enter(session)
559:          detachAgent = loopCtx.agents.enter(agent, ownerCtx.agent)
560:          agent.ctx.sessions.announce(session)
561:          assertLive()
562:          loopCtx.agents.announce(agent)
563:          assertLive()
564:          // A synchronous announce/session-start listener may have started
565:          // teardown; the machine is already live (delivery works from the
566:          // session-start extension point), so only the liveness recheck is owed.
567:          emitAgentEvent(loopCtx, agent, 'agent/session-start', { source })
568:          assertLive()
```

而 pre-step 只在驱动被唤醒后发生：`packages/core/agent-loop/src/agent.ts:210-212`（`kick` → `while (await this.turn()) {}`）、`:225-227`（preStep 首行 `if (this.phase.kind !== 'running') throw new Error(...)`）、`:234-240`（`agent/pre-step` waterfall）。

契约注释 `packages/core/agent/src/runtime-types.ts:150-151`：

```
150:      * A fully configured agent and live session were published. Setup is
151:      * composition-only; `agent/session-start` is the first startup-driving extension point.
```

`packages/core/agent/src/index.ts:186-189`：

```
187:    * both session and agent, emits their creation notifications in order, emits
188:    * `agent/session-start`, and only then starts the loop.
```

`packages/core/agent/src/index.ts:128-130`（setup 阶段禁止驱动）：

```
128:    * **Setup composes, it never drives**: the callback is trusted same-process code ...
130:    * than a runtime restriction. Drive the agent only after creation resolves.
```

测试作证 `packages/core/agent-loop/tests/interception.spec.ts:556-573`（测试名逐字 `fires once with source "startup" for a fresh create, before the first turn`）：

```
564:    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
565:    // fires synchronously at create, before any turn
566:    expect(sources).toEqual(['startup'])
567:    expect(events(agent).some(e => e.type === 'turn/start')).toBe(false)
```

同文件 `:575-592` 证明 session-start 监听器里 `agent.inject(...)` 的内容能被**第一个**请求看到：

```
588:    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('session preamble')
591:    expect(ctxMsg?.type === 'user/message' && ctxMsg.data.source).toEqual({ kind: 'plugin', plugin: 'test' })
```

`:594-608` 证明监听器抛错**不会**中断 agent 构造。顺序断言另见 `packages/core/agent-loop/tests/scope-lifecycle.spec.ts:217-238`（`expect(order).toEqual(['setup', 'session-start', 'persona:You are the child.'])`）。

`source` 取值为 `'startup' | 'resume' | 'clear' | 'compact'`（`packages/core/agent/src/runtime-types.ts:61`）。

---

## g. resume / clear / compact 冷启动时，`agent/pre-step` 的 `messages` 是否仍包含人类直接提示（`source.kind === 'user'`）

**结论：不包含（就 resume 而言已在本 checkout 证实）。** `agent/pre-step` 的 `messages` 只等于该步从 inbox `claim` 到的那一批：**冷启动后 inbox 为空**，人类直接提示只有在用户显式 followup/steer/send 唤醒时才出现。`clear` / `compact` 两个 source 值**未证实**——本 monorepo 没有任何生产代码以这两个值发布 agent。

payload 契约 `packages/core/agent/src/runtime-types.ts:220-231`：

```
228:   * @param payload.messages - messages removed from the inbox for this step.
231:  'agent/pre-step'(this: Scoped<Agent>, payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
```

messages 来源 `packages/core/agent-loop/src/agent.ts:229`：

```
229:    const claimed = this.inbox.claim(target, position.turn)
```

`claim` 只取 pending 项 `packages/core/agent/src/inbox.ts:71-78`：

```
71:  claim(target: InboxTarget, turn: number): UserMessage[] {
72:    const claimed = this.mutate('next-step', 0, this.nextStep.length, [], false)
73:    if (target === 'next-turn') {
74:      claimed.push(...this.mutate('next-turn', 0, 1, [], false))
75:    }
```

inbox 只从「seed 之后新增的 `agent/inbox/spliced`」重建，**不读历史 user/message**（`packages/core/agent/src/inbox.ts:32`：`for (const event of session.events.slice(session.header.seedLength ?? 0))`）。

resume 后 inbox 为空的测试作证 `packages/core/agent-loop/tests/resume.spec.ts:146-159`：

```
146:    expect(handle.agent.session.deriveMessages()).toMatchObject([
147:      { id: `legacy-message:${sessionId}:1`, role: 'user' },
...
151:    expect(handle.agent.inbox.nextTurn).toEqual([])
152:    expect(handle.agent.inbox.nextStep).toEqual([])
154:    handle.agent.followup(createUserMessage({
155:      content: [{ type: 'text', text: 'new question' }],
156:      source: { kind: 'user' },
157:    }))
```

⇒ 历史确实在 `session.deriveMessages()`（请求上下文）里，但**不在** `pre-step.messages` 里；resume 后必须再一次 `followup`（`source: { kind: 'user' }`）才产生第 5 条消息并驱动新 turn。

未消费的 inject 会跨 resume 存活并成为 pending（`packages/core/agent-loop/tests/resume.spec.ts:604-630`，测试名逐字 `a pending idle inject() survives persist + resume without a synthetic turn`；`:630` 断言 `JSON.stringify(a2.inbox.nextStep)).toContain('background job 42 finished')`）——但它带的是插件 source，不是人类提示。

语义区分（`packages/core/agent/src/runtime-types.ts:119-143`）：
- `followup`：`:120-121` `Queue an ordinary follow-up turn and wake the driver. The item becomes the sole ordinary message of its own turn.`
- `steer`：`:127-128` `Submit steering for the nearest step. An idle driver starts a turn; a running driver consumes it at its next step boundary.`
- `inject`：`:136-138` `Queue model-facing context for the next pre-step without waking the driver. A running driver claims it at the nearest later step boundary; idle drivers leave it pending…`

### 未证实

1. **`source: 'clear'` / `'compact'` 的冷启动语义未证实。** 全仓 grep 只命中类型定义 `packages/core/agent/src/runtime-types.ts:61`、`packages/core/agent-loop/src/index.ts:155/:632/:640`（`publish(source: SessionStartSource)` 参数位）与 API 目录文档 `packages/extensions/tool-cordis/src/api-catalog.ts:4232-4233`；**没有任何生产调用点传入这两个值**。实际只观察到：
   - `agentLoop.create(...)` → `'startup'`：`packages/core/agent-loop/src/index.ts:593` `return prepared.publish('startup').agent`
   - `createAgent(...)` → `'startup'`：`packages/core/agent-loop/src/index.ts:611-619`
   - `resume(...)` → `'resume'`：`packages/core/agent-loop/src/index.ts:695-703`
   测试中出现的 `source: 'resume'` 亦多为手工 `emit` 构造（如 `packages/goal/tool-goal/tests/tool-goal.spec.ts:407`）。⇒ 若宿主以 clear/compact 重启 agent，本条结论可否外推，**未证实**。
2. **`compact`（压缩）本身不影响 `pre-step.messages` 的直接证据未取。** 本次只证实了 inbox 不读历史消息这一机制；压缩改写的是 session log / 请求重建，未在本审计取证。
3. `session.header.seedLength` 在 resume 路径来自**持久化 header**（`packages/core/agent-loop/tests/resume.spec.ts:563-597`，`:597` `expect(a2.session.header.seedLength).toBe(seed.length)`）；fork 会话（`seedLength` 非 0）下 inbox 重建边界随之变化，但其与 `pre-step.messages` 的关系本次未逐例验证。

---

## 附：本次审计中被证实、但不属于上述 7 问的两条事实

1. 失败是**单事件判别式**：真实插件按 `result.isError` 判别，见 `packages/context/agent-instructions/src/index.ts:350-353`：
   ```
   350:  ctx.on('tools/result', (exec: ToolExecution, result: ToolExecutionResult) => {
   351:    const touches = executionTouches.get(exec.token) ?? []
   352:    executionTouches.delete(exec.token)
   353:    if (!result.isError && exec.agent !== undefined && !exec.signal.aborted) {
   ```
   `tools/result` 契约 `packages/core/tools/src/index.ts:197`（`@mode emit`，监听到的是冻结后的最终结果）。
2. `tools/result` 在 `post-execute` **之后**、且在 `finalizeContent` 之后发射：`packages/core/tools/src/index.ts:1631-1646`（`materializeFinalResult` → `applyFinalContent` → `notifyResult`）与 `:1657-1667`（`Object.freeze(exec)` 后 dispatch `'tools/result'`）。
