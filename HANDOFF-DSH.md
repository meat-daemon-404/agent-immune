# DSH 交接说明 / Handing this over to DSH

ZCode 版已完整实现并在真实运行时验证过。
DSH 版只差**宿主契约对齐**——`core/` 全部可复用，需要改的只有一个文件。

> The ZCode side is done and verified. The DSH side needs only contract
> alignment: all of `core/` is reusable, and a single file changes.

---

## 一分钟看懂现状

```
core/           ← 已完成、已验证、与宿主无关
zcode/          ← 已完成，按实测契约实现，运行时验证通过
dsh/            ← 骨架，编译通过，但从未在真实 DSH 上跑过
  └─ dsh-adapter.ts   ← 唯一的待改文件
```

`dsh/src/index.ts` 的业务逻辑（注入、配对、扣分、导出）**不用动**。
它只通过 `dsh-adapter.ts` 暴露的接触点与宿主交互。

---

## 第一步：回答三个问题

每条都要有**源码或文档证据**，不接受"应该是这样"。

### 问题一：事件叫什么

现在假设的是：

```ts
export const DSH_EVENTS = {
  sessionStart: 'dsh/session-start',
  beforeRequest: 'dsh/before-llm-request',
  afterToolCall: 'dsh/after-tool-call',
} as const;
```

**这三个名字是猜的。** 去 DSH 的事件注册表/文档里找真实名字，改掉即可。

### 问题二：失败怎么表示（决定架构）

| 如果 DSH 是… | 那么 |
| --- | --- |
| 单个工具事件 + `isError` 布尔 | 保留现在的 `normaliseToolEvent`，直接用 `ok` 分支 |
| **成功/失败拆成两个事件** | 必须订阅两个事件，都调用同一个记录函数 |

ZCode 是第二种（`PostToolUse` / `PostToolUseFailure`），而且有个坑值得提前知道：

> **失败事件只在工具处理器抛异常时才触发。** bash 非零退出通常不抛，
> 所以 ZCode 版最终在 `PostToolUse` 里自己判断结果（见 `zcode/src/outcome.ts`）。

如果 DSH 也是拆分式，**强烈建议照搬这个分类逻辑**，否则会对最常见的失败完全失明。

### 问题三：怎么把文字塞给模型

现在假设 `session.appendSystemReminder(text)`。要确认：

- 真实方法名；
- **是否同步**。ZCode 的后台 hook 输出会被丢弃，所以注入必须同步。
  如果 DSH 也有类似约束，注入就不能放进异步分支。

### 模型访问：可以完全绕开

`dsh/src/index.ts` **不依赖宿主 LLM**，走 `core/distiller.ts`：

- 配了 `IMMUNE_LLM_BASE_URL` + `IMMUNE_LLM_MODEL` → 用 HTTP 客户端；
- 没配 → 用确定性规则蒸馏器（离线可跑）。

所以 `ctx.llm.complete()` 这条假设可以**直接删掉**，不用去核实。

---

## 第二步：改完怎么验

```bash
npm run build          # 必须 0 错误
npm test               # 53 条，core 与 DSH 部分应全绿
```

DSH 侧没有自动化测试，按这个顺序手验：

1. **单元级**：给 `normaliseToolEvent` 喂一条真实捕获的载荷，断言
   `sessionId / toolName / ok / errorText` 都对。
2. **闭环级**：同一工具先失败、后成功 → 等一个回合 → 查
   `IMMUNE_DB_PATH` 指向的 sqlite 里 `antibodies` 表有记录。
3. **跨会话级**：换一个新会话，问一句包含该触发词的话 →
   上下文里应出现 `<immune_memory>`。**这条是整件事的意义所在，必须验。**

---

## 第三步：删掉临时兼容

`dsh-adapter.ts` 里所有 `??` 兜底（多种字段拼写、`isError === true || is_error === true`）
都是为"未知契约"付的保险费。对齐后请**全部删掉**，让错误响亮地失败，
而不是静默地用错误字段继续跑。

---

## 共享同一份抗体库（推荐）

两版指向同一个数据库即可共用积累：

```
IMMUNE_DB_PATH=/path/to/immune.sqlite
```

ZCode 版默认落在 `plugins/data/dsh-immune-system@<market>/immune.sqlite`。
DSH 版让它指到同一个文件，就能读到 ZCode 学到的坑，反之亦然。

---

## 一句话总结

> 你只需要回答"DSH 的事件叫什么、失败长什么样、怎么把文字塞给模型"这三个问题，
> 改 `dsh/src/dsh-adapter.ts` 一个文件，其余全部复用。

如果这三个问题里有任何一个在 DSH 那边找不到明确答案，**先别写代码**——
按 ZCode 的经验，猜错事件名的代价是整个插件静默失效。
