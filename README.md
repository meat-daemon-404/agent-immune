# dsh-plugin-immune

**自进化避坑免疫系统** — 让 Agent 踩一次坑，就自己长记性。

Agent 踩了坑、修好了，却没人写文档——这次的经验就被自动提炼成一条**抗体**。
下次在同一个坑面前，相关抗体先一步进入它的上下文。

> Agent steps on a rake, fixes it, and the lesson is captured as an *antibody* —
> no documentation required. Next session, the relevant antibodies are injected
> before the mistake can repeat.

[English](#english) · [中文](#中文)

---

## 中文

### 它解决什么问题

同一个坑反复踩，是 Agent 最浪费时间的模式：

- 改了 `vite.config.ts`，`process.env` 读不到客户端变量，报错，换 `loadEnv` 才好；
- 下次换个会话，**又这么写一遍**。

静态文档解决不了这个问题——没人维护，很快就过期。
这个插件让**踩坑现场自己变成规则**。

```
 工具失败 ─┐
           ├─► 配对 ─► 蒸馏 ─► 抗体（SQLite + FTS5）
 工具成功 ─┘                          │
                                      ▼
        下次工具调用 ─► PreToolUse 即时预警
        下次对话     ─► <immune_memory> 上下文注入
```

### 装

本仓库**本身就是插件市场源**，不用克隆：

```bash
node "<zcode.cjs 路径>" plugins marketplace add meat-daemon-404/dsh-plugin-immune
node "<zcode.cjs 路径>" plugins install dsh-immune-system@dev-dsh-plugin-immune
```

装完**新建一个任务**才生效（旧任务保留的是旧能力清单）。

### 怎么用

正常干活就行。踩坑 → 修好 → 回合结束时自动提炼。
下一个会话问一句含相同文件名/命令的话，上下文里就会出现 `<immune_memory>`。

查看学到了什么：

```
/dsh-immune-system:immune           # 列出所有抗体（加 --all 含已退役的）
/dsh-immune-system:immune-export    # 把经过验证的抗体导出成 SKILL.md
```

### 两个关键设计

**抗体失效会被淘汰（Anti-Rot）**
一条抗体注入后工具**仍然**失败，说明它没起作用，扣分；满 3 次自动退役并联合新证据重新提炼。
扣分**带相关性判断**——失败内容必须与该抗体的触发词有共同词才算数，且**排除工具名本身**
（否则每条 `Bash …` 抗体都会被任何一次 Bash 失败冤枉）。

**失败感知不赌单一事件**
ZCode 的 `PostToolUseFailure` **只在工具处理器抛异常时**才触发，而 bash 命令非零退出
通常是正常返回。所以本插件在 `PostToolUse` 里自己判断结果（`exitCode` / `is_error` /
窄口径输出标记）。这是实测出来的坑，不是推测。

### 配置（全部可选）

不配也能跑——默认用确定性规则蒸馏器，离线可用。

| 环境变量 | 作用 |
| --- | --- |
| `IMMUNE_DB_PATH` | 数据库路径。两版指向同一个即可共享抗体库 |
| `IMMUNE_LLM_BASE_URL` | OpenAI 兼容端点，如 `https://api.example.com/v1` |
| `IMMUNE_LLM_MODEL` | 模型名，与上面配对使用 |
| `IMMUNE_LLM_API_KEY` | Bearer 令牌 |
| `IMMUNE_LOCALE` | `zh-CN` / `en` 强制单语；**默认中英双语** |
| `IMMUNE_ALLOW_PRIVATE_ENDPOINT` | 设为 `1` 才允许环回/私有端点。**默认拒绝**，防 SSRF |
| `IMMUNE_DEBUG_LOG` | 指定文件则记录每个 hook 的执行，用于排障 |

### 安全

- **脱敏**：写入磁盘前擦除 Bearer 令牌、`*_KEY=` 类赋值、URL 内嵌凭证、JWT。
  这些记录之后可能被导出成团队共享的 SKILL.md，泄漏在那里比泄漏在日志更糟。
- **注入卫生**：注入内容只来自我们自己提炼的字段，从不放原始工具输出；
  抗体文本里的尖括号被剥离，无法闭合包裹标签；有长度上限；明确标注"仅供参考"，
  避免模型把它当成用户指令。
- **失败不致命**：hook 永远 exit 0，stdin 畸形则忽略，FTS 表达式出错返回空，
  模型不可达则回落到规则蒸馏器。插件坏了不能拖垮会话。
- **SQL 只走参数绑定**，不拼接。

### 状态

- 17 条测试全绿
- 在本机真实运行时里验证：5 个 hook 全部被分发，`${ZCODE_PLUGIN_ROOT}` 正确展开，
  数据库落在插件数据目录
- 用**安装副本**重放全链路：失败→成功→蒸馏→新会话收到 `<immune_memory>`
- **未验**：Agent 自主端到端（当时模型额度返回 402，turn 到不了工具阶段）

---

## English

### What it does

Repeating the same mistake is the most expensive pattern an agent has. Static
docs do not fix it — nobody maintains them, and they rot.

This plugin turns the failure scene itself into a rule.

### Install

The repository **is** a marketplace source:

```bash
node "<zcode.cjs>" plugins marketplace add meat-daemon-404/dsh-plugin-immune
node "<zcode.cjs>" plugins install dsh-immune-system@dev-dsh-plugin-immune
```

Start a **new task** afterwards; old tasks keep their earlier capability catalog.

### Design notes

**Sensing outcomes, not trusting one event.** `PostToolUseFailure` fires only when
a tool *handler throws*. A shell command exiting non-zero usually returns
normally, so that event alone misses the failures this plugin exists to learn
from. `PostToolUse` therefore classifies its own result.

**Anti-rot, relevance-guarded.** An injected antibody that still did not prevent
the failure loses credit and is retired after three such episodes. The penalty is
relevance-guarded: the failure must share a meaningful term with the antibody's
trigger, and the tool name is excluded — otherwise every `Bash …` rule would be
blamed for any Bash failure.

**Redaction and injection hygiene.** Credentials are scrubbed before anything
touches disk; injected text comes only from our own distilled fields, is
length-capped, cannot close its wrapper tag, and is labelled advisory.

---

## 仓库结构 / Layout

```
core/                 共用、与宿主无关、零运行时依赖
  ├── store/          SQLite + FTS5：抗体、episode、任务队列
  ├── distiller.ts    episode → 抗体（模型 + 规则兜底）
  ├── i18n.ts         中英双语文案
  ├── redact.ts       落盘前凭证脱敏
  └── export.ts       导出 SKILL.md
zcode/                ZCode 适配（hooks、CLI），按实测契约实现
dsh/                  DSH 适配骨架，契约未核实
dsh-immune-system/    可安装插件（manifest、hooks.json、commands、dist）
test/                 node:test
```

两版共用同一份 `core/`。指向同一个 `IMMUNE_DB_PATH` 就能共享抗体库。

**DSH 交接**：[HANDOFF-DSH.md](HANDOFF-DSH.md) — 只需回答三个问题，改一个文件。

## 与最初设计的偏差 / Why this differs from the first sketch

初版设计假设了 Cordis 风格的 API（`ctx.on('dsh/before-llm-request')`、
`ctx.llm.complete`、`async: true` 后台蒸馏）。本机真实运行时里这些都不成立：

| 初版假设 | 实测情况 |
| --- | --- |
| `dsh/before-llm-request` | 无此事件。靠 `UserPromptSubmit` / `SessionStart` 注入 |
| `after-tool-call` + `is_error` | 成功/失败是两个独立事件，且**没有** `is_error` |
| `ctx.llm.complete()` | hook 是独立进程，无宿主 LLM；改用 HTTP 客户端 |
| `ctx.command('immune')` | 命令是 Markdown 提示词，调用一个小 CLI |
| `async: true` 后台跑 | 官方明确：`async` **无运行时效果** |
| `new Map()` 记失败 | 每个 hook 独立进程，状态必须落 SQLite |
