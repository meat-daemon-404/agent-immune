# dsh-plugin-immune

[![npm](https://img.shields.io/npm/v/dsh-immune-system)](https://www.npmjs.com/package/dsh-immune-system)
![license](https://img.shields.io/badge/license-MIT-green)
![node](https://img.shields.io/badge/node-%E2%89%A522.5-blue)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin%20hub-4f9cf9)](https://dsh-plugin.org/plugins)

**自进化避坑免疫系统** — 让 Agent 踩一次坑，就自己长记性。

Agent 踩了坑、修好了，却没人写文档——这次的经验被自动提炼成一条**抗体**。
下次在同一个坑面前，相关抗体先一步进入它的上下文。

> Agent steps on a rake, fixes it, and the lesson is captured as an *antibody* —
> no docs required. Next session the relevant antibodies are injected before the
> mistake can repeat.

支持两个宿主：**DSH**（DeepSeek Harness，已按真实宿主契约实测）与 **ZCode**（按实测 hook 契约）。
两者共用同一份 `core/`，npm 包同名发布，一次踩坑、处处免疫。

[中文](#中文) · [English](#english)

---

## 中文

### 它解决什么问题

同一个坑反复踩，是 Agent 最浪费时间的模式：

- 改了 `vite.config.ts`，`process.env` 读不到客户端变量，报错，换 `loadEnv` 才好；
- 下次换个会话，**又这么写一遍**。

静态文档解决不了——没人维护，很快过期。这个插件让**踩坑现场自己变成规则**：

```
 工具失败 ─┐
           ├─► 配对 ─► 蒸馏 ─► 抗体（SQLite + FTS5，按项目隔离）
 工具成功 ─┘                          │
                                      ▼
        下一次会话提问 ─► <immune_memory> 注入模型上下文
```

### 安装

#### DSH

**npm（现在可用，最简）**：

```bash
dsh plugin --profile <profile> add dsh-immune-system
```

包发布在 https://www.npmjs.com/package/dsh-immune-system ，`dist/` 预构建随包。

**tarball / git**（等价，无需 npm 账号）：

```bash
cd dsh-immune-system && npm pack          # → dsh-immune-system-<version>.tgz
dsh plugin --profile <profile> add ./dsh-immune-system-<version>.tgz
dsh plugin --profile <profile> add github:meat-daemon-404/dsh-plugin-immune
```

`git:` 安装会在安装时跑 `prepare` 构建，被 pnpm 默认拦截——需要把 pnpm 打印的 key
加进 profile 的 `pnpm-workspace.yaml → allowBuilds`。除非你就要这个形态，否则用前两种。

装完**重启 DSH**（bundle 是启动时装配的，运行中的进程不会自己加载）。
`<profile>` 就是 `~/.dsh/profiles/` 下你实际在用的那个（桌面端通常是 `desktop`）。

装完可用 `/immune` 自检：能返回「暂无抗体」就说明挂上了。

**上架 DSH Plugin Hub**：仓库已打 `dsh-plugin` topic，Hub 会周期性自动抓取；
也可在 `dsh-plugin.org/submit` 主动提交。注意 Hub 索引的是仓库条目，**安装仍走
上面的 tarball / npm**。

#### ZCode

本仓库本身就是插件市场源：

```bash
node "<zcode.cjs 路径>" plugins marketplace add meat-daemon-404/dsh-plugin-immune
node "<zcode.cjs 路径>" plugins install dsh-immune-system@dev-dsh-plugin-immune
```

装完**新建一个任务**才生效（旧任务保留的是旧能力清单）。

### 怎么用

正常干活就行。踩坑 → 修好 → 下一回合自动提炼。
之后问到含相同文件名/命令的话，上下文里会出现 `<immune_memory>…</immune_memory>`。

| 命令 | 宿主 | 作用 |
| --- | --- | --- |
| `/immune` | DSH | 列出所有抗体（`/immune --all` 含已退役）；`/immune --budget` 查看蒸馏预算，`--budget <ms>` 本次会话内改（内存态，重启回到环境变量） |
| `/immune-export` | DSH | 把经过验证的抗体导出成 `SKILL.md` |
| `/immune-forget <id>` | DSH | 删除指定抗体 |
| `/immune-forget --last` | DSH | 撤销上一回合刚学的那条 |
| `/immune-forget --prune` | DSH | **退役**从未命中且超过 14 天的抗体（可恢复，不再注入） |
| `/immune-forget --purge` | DSH | **物理删除**上述抗体（不可恢复） |
| `/dsh-immune-system:immune` | ZCode | 同上（加 `--all`） |
| `/dsh-immune-system:immune-export` | ZCode | 同上 |
| `/dsh-immune-system:immune-forget` | ZCode | 同上（`<id>` / `--last` / `--prune` / `--purge`） |
| `/dsh-immune-system:immune-learn` | ZCode | 手动教一条规则 |
| `/dsh-immune-system:immune-ui` | ZCode | 启动本地仪表盘，给出地址 |
| `cli.js ui [--port N]` | 两者 | 同上（前台运行，默认 7788，端口占用自动顺延） |
| `cli.js learn <trigger> [symptom] <prescription>` | 两者 | 手动教一条规则（借鉴 pro-workflow 的 `/learn-rule`） |
| `cli.js search <query>` | 两者 | 只读检索——与仪表盘/MCP 同一条不计数通道 |
| `cli.js export-json <path>` / `import-json <path>` | 两者 | 库快照导出/导入——跨机器同步、git 提交、团队共享 |
| `cli.js doctor` | 两者 | 安装健康自检：node 版本、FTS5、数据库、marker、MCP 脚本 |

> 检索层同时跑两条通道：3 字以上走 FTS5 trigram，**2 字中文词（跨域/端口/权限/死锁）
> 走参数化 LIKE 兜底**——trigram 压根无法索引 2 字词，只靠 MATCH 会把这类词整段漏掉。

### 仪表盘

`/dsh-immune-system:immune-ui`（或 `cli.js ui`）会起一个本地页面：

- 搜索触发词/症状/处方，实时过滤；**浏览不计入命中数**，所以晋升和淘汰的统计不会被点鼠标污染
- 每条可**退役 / 恢复 / 删除**，分「项目库」「共享库」两个页签，可按「最近更新 / 命中最多 / 失效最多」排序
- 顶部 5 张 KPI：生效数、退役数、累计注入、共享库条数，外加**当前蒸馏预算**
- 跟随系统深浅色、窄屏自动把表格降级成卡片、骨架屏与空态都是有设计的那种

安全边界是刻意收窄的：只绑 `127.0.0.1`、每次启动生成随机 token 且所有 `/api` 都要带它
（跨站简单 POST 不需要预检，只靠 Origin 判断不够）、严格 CSP、页面不加载任何外部资源。

UI 是自建的而非宿主插件 UI——ZCode 插件没有 UI 插槽（只有 hooks/commands/skills/MCP），
所以走本地 HTTP，两个宿主通用。

#### the agent harness 原生 UI（设置页里的 tab）

the agent harness 有 web GUI 和客户端插槽，所以那边**不用另开页面**：
`设置 → 插件` 里会出现一个「免疫 / Immune」tab。它与独立仪表盘共用同一套设计：
KPI（含预算）、搜索与清除、页签计数、排序、状态圆点、窄屏卡片、骨架屏与空态。

- 客户端是 `dsh-immune-system/client/client.js`，按模块装载器契约手写
  （`window.__ModuleLoader__.load({ id, factory })`），**不需要打包器、不写 JSX**
- 样式是注入一段静态 `<style>`（选择器全部 scope 在 `.imm` 下），所以 hover、媒体查询、
  跟随宿主的 `--dsh-*` 深浅色变量都能用，而不是几十个 inline style
- 数据走宿主路由 `/plugins/dsh-immune-system/api`，用
  `ctx.inject(['webServer'], …)` 注册——这是可选依赖，CLI/桌面 profile 没有 web 服务时
  插件照常工作，只是没有这个 tab
- **manifest 必须同时声明** `dsh.client: { platform: "web" }` 与字符串
  `exports["./client"]`。宿主的 `client-modules` 只按这两条把包认成「浏览器半」，
  再把文件原样挂到 `/plugins/<id>/client.js?rev=<hash>`；少一条，文件在磁盘上存在
  但路由 404、tab 永不出现（而且判定在本进程内缓存，必须重启才生效）。
  `test/manifests.test.mjs` 与 `scripts/verify-installed.mjs` 把声明、导出目标与
  文件内容三件事都钉死了
- 变更类请求要求 `content-type: application/json` 且同源：JSON 会强制 CORS 预检，
  跨站页面过不去

> 诚实说明：客户端与路由的**契约**有测试（模拟 `__ModuleLoader__` 装载、假 ctx 验证路由、
> 跨源拒绝、无 web 服务时不注册、预算透传），布局则用真实 React 18 做过静态渲染自检
> （含深色模式、空态、窄屏）。
>
> **已在真实宿主里验证过**：0.9.8 补齐 `dsh.client` 声明后，`设置 → 插件` 里的 tab
> 确实出现了（此前 `/plugins/dsh-immune-system/client.js` 返回 404，只有宿主半在跑）。
> 0.9.12 进一步把它放进 **shadow root**——真实的设置弹窗会用自己的样式表重排裸
> `table`/`td`/`div`，导致行被压成几像素、下拉框空白；shadow root 双向隔离，
> 宿主 CSS 进不来、我们的样式也出不去。

### 同步与体检

库快照是纯 JSON（带格式标签），合并语义刻意保守：

- **处方是身份**——与库自身的去重规则一致
- 两侧都认识的规则，命中/失效计数取 **max**（两台机器各自独立计数，不该相乘）
- 状态任一侧 active 即 active——「退役」是一台机器的判断，不是共识

```bash
node "<plugin>/dist/zcode/src/cli.js" export-json library.json   # 快照
node "<plugin>/dist/zcode/src/cli.js" import-json library.json   # 合并进当前库
node "<plugin>/dist/zcode/src/cli.js" doctor                     # 安装自检
```

把 `library.json` 提交进仓库（或放进共享库 `global.sqlite` 所在目录的 git），团队每个
成员 `import-json` 一次就继承全部教训。`doctor` 逐项报告 node 版本、FTS5 trigram
探针、库可写性、marker、MCP 脚本，任何一项失败退出码非零，可以接进 CI。

### 四个关键设计

**① 失败感知不赌单一事件（这是最要命的一条）**

两个宿主上「bash 退出码非 0」都**不是**错误结果：

- ZCode：`PostToolUseFailure` 只在工具处理器**抛异常**时触发，命令非零退出是正常返回；
- DSH：`result.isError` **只覆盖基础设施失败**（spawn 错误、abort、监听器抛错），
  非零退出被明确设计为「reported, not errored」，模型自己决定怎么办。

所以两版都自己判结果。DSH 侧的判据按权威度排序：
`isError` → sandbox 拒绝标记（判失败但**不入库学习**）→ kill/timeout（含 `value.timedOut`）→
结构化 `value.exitCode`（**有则权威：0 成功、非 0 失败，不再看文本**）→
有结构化 `value` 但无退出状态（**载荷即结论，正文是数据，不扫**）→ 行尾 `[exit code: N]` →
窄口径失败标记正则（**仅当无任何结构化状态**）。后面两步刻意让位给结构化信号：一条退出 0
的命令在 `grep` 输出里顺带印出 `command not found` 是常事，而 `read` 一个含 `Error:` 的日志
文件更是日常——都不该被记成失败。

**② 抗体失效会被淘汰（Anti-Rot）**

一条抗体注入后工具**仍然**失败，说明它没起作用，扣分；满 3 次自动退役并联合新证据重新蒸馏。
扣分**带相关性判断**——失败内容必须与该抗体的触发词有共同词才算数，且**排除工具名本身**
（否则每条 `Bash …` 抗体都会被任何一次 Bash 失败冤枉）。

**②⁺ 泛型坑只学一条（Generic lessons）**

`File has been modified since read` 这类坑与具体文件无关——实测它在三个不同文件上
各学了一条重复规则。精选模式表（`core/lessons.ts`）把这类症状归一成泛型触发词和处方，
规则的处方级去重随后把所有实例合并成一条，教训靠命中数累积而不是繁殖。
规则蒸馏与模型蒸馏两条路径共用同一张表。

**②⁺⁺ 人类纠偏优先于模型猜测（Cross-turn hint）**

真实会话经常是：工具失败 → Agent 问人 → 人类说"这个仓库用 pnpm" → 重试成功。
那句人话是最好的蒸馏输入。`UserPromptSubmit` 会把**新回合的人类消息**挂到上一回合
未闭合的失败上，蒸馏时作为处方的最优来源（人类陈述规则，模型只能从 diff 里猜）。
"继续""ok"这类空话会被 `isSubstantiveHint` 挡掉——否则会变成 `do: 继续` 这种废处方。

**②⁺⁺⁺ 全局共享库（Shared library）**

按项目隔离防串味，代价是新项目从零开踩。泛型抗体（`core/lessons.ts` 判定的，
或触发词不含具体文件路径且命中 ≥5 次的）会同步到同目录的 `global.sqlite`，
新项目召回不足时从它补齐。

**没有用 `ATTACH DATABASE`**：SQLite 明确说明 WAL 模式下跨附加库的事务不原子，
而本插件每进程短连接、多 hook 并发。改用两条独立连接——每次写入仍是单文件事务。
代价只是召回变成两次查询，这个量级无所谓。项目库与共享库的 id 在合并时**从不按 id 混用**
（两个库的 AUTOINCREMENT 各自独立，会撞）。

**③ 事前检查（Guard，默认关闭）**

提示词是软建议，长上下文里模型偶尔照样照错发。`IMMUNE_GUARD` 提供一层确定性检查：
`off`（默认）/ `warn`（更醒目的提示）/ `deny`（拒绝执行该工具调用）。

三条只在任何环境都错的规则：强推 main、`rm -rf /`、`git reset --hard`。
**规则写在代码里，不进数据库**——蒸馏产物是模型输出，把它编译成正则去拦截工具调用
等于让未经审阅的字符串获得停止工作的权力，还有 ReDoS 风险。
`deny` 是唯一有破坏性的模式，所以它从不是默认值。

两侧都接上了：ZCode 用 `permissionDecision: deny`，the agent harness 用
`tools/pre-execute` 返回 `{ kind: 'deny', reason }`（`PreToolDecision` 的三种形态
查自 `packages/core/tools/src/index.ts:588`）。**`warn` 仅 ZCode 有效**——
`PreToolDecision` 没有携带上下文的字段，the agent harness 侧只能"拦或不拦"。

**③ 注入卫生**
注入内容只来自我们自己提炼的字段，从不放原始工具输出；抗体文本里的尖括号被剥离，
无法闭合包裹标签；有长度上限；明确标注「仅供参考」，避免模型把它当成用户指令。
一个回合最多注入一次、且只在回合第一步匹配（工具循环里每步都匹配既会重复灌入，
也会把抗体的命中计数灌成「这回合跑了几步」的噪声）。

**④ 蒸馏在回合边界跑，不在工具结果路径里**

`drain()` 可能向配置的 LLM 端点发一次 HTTP 请求。DSH 的 `tools/post-execute` 监听器被 await
在工具结果路径上，把蒸馏放进去会让每次「失败后成功」的工具调用都卡到 HTTP 返回；
所以它挂在 `agent/turn-stopping`（`@mode serial`，回合边界提交前 await）。
未清空的队列还会在下次 `session-start` 由 `requeueStuckJobs()` 兜底。

### 失败怎么被判出来（四层判定 × 三类失败）

`judgeOutcome` 不是「看一个 boolean」，而是按权威顺序逐层走。三类常见失败在四层里的落点并不相同：

| 层 | 判据 | bash 非零退出 | 超时 | 沙箱拒绝 |
| --- | --- | --- | --- | --- |
| 1 | `result.isError`（宿主**只**对基础设施失败置真） | ✗ 返回 `isError:false` | 可能 ✗ | 偶尔 ✓（file 工具抛异常） |
| 2 | 沙箱标记 `[sandbox: file access denied under … mode]` | ✗ | ✗ | ✓ 命中 → 打 `sandboxDenied`，**不记录、不惩罚、不蒸馏** |
| 3 | kill / timed-out 标记 + `value.timedOut` | ✗ | ✓ 命中（即便 `exitCode=0`） | ✗ |
| 4 | 结构化 `value.exitCode`（shell 工具的权威判据） | ✓ 非 0 即失败 | — | — |
| 5 | 尾标记 `[exit code: N]` / 特征词（**仅**当没有任何结构化状态） | 兜底 | 兜底 | — |

```
一次工具结果
  ├─ isError ──────────────────────────────→ 失败（error.message 原样记入 trace）
  ├─ 沙箱拒绝标记 ─────────────────────────→ 拒绝：不记录 / 不惩罚 / 不蒸馏
  ├─ killed / timed out ───────────────────→ 失败
  ├─ value.exitCode 存在 ──┬─ 0 ───────────→ 成功（此后不再扫文本）
  │                        └─ ≠0 ──────────→ 失败
  ├─ value 为非空对象（无退出码）──────────→ 成功（载荷即结论）
  ├─ [exit code: N] / 特征词 ──────────────→ 失败
  └─ 其余 ─────────────────────────────────→ 成功
```

要点：**结构化 exitCode 一旦存在就压过文本**——`grep` 命中内容、测试打印 `Error:` 都不会被误判成功/失败；而 bash 的非零退出正是靠第 4 层抓到的（宿主本身不会把它置成 `isError`）。这也解释了为什么「读一份含 `Error:` 的日志」不会凭空长出一条抗体。

### 存储

抗体库是 SQLite 单文件（含 FTS5 trigram 索引，中文按 3 字窗口匹配）。

- `IMMUNE_DB_PATH` 显式指定时最优先；两版指向同一个文件就共享抗体库。
- DSH 默认：`<DSH_HOME>/storages/dsh-immune-system/<sha1(当前目录)[0..16]>.sqlite`
  —— **按项目隔离**，不同工作区互不串味，也不往项目目录里丢文件。
- ZCode 默认：插件数据目录（`ZCODE_PLUGIN_DATA`），无则 `<项目>/.dsh/immune.sqlite`。

**冷启动**：`agent/pre-step` 在 `resume`/`clear`/`compact` 时拿到的是「seed 之后新增」的批次，
不含人类提问。DSH 版订阅 `session/event` 的 `user/message` 记住每个会话最近的提问，
作为匹配依据的兜底，所以冷启动后的第一句也能召回。

### 配置（全部可选）

不配也能跑——默认走确定性规则蒸馏器，离线可用。

| 环境变量 | 作用 |
| --- | --- |
| `IMMUNE_DB_PATH` | 抗体库路径；两版指向同一个即可共享 |
| `IMMUNE_LLM_BASE_URL` | OpenAI 兼容端点，如 `https://api.example.com/v1` |
| `IMMUNE_LLM_MODEL` | 模型名，与上面配对使用 |
| `IMMUNE_LLM_API_KEY` | Bearer 令牌 |
| `IMMUNE_DISTILL_BUDGET_MS` | 单次回合末蒸馏的时间预算，默认 `12000`（两版同名同默认，钳制在 1–60 s）；超预算的队列留到下次边界 |
| `IMMUNE_LOCALE` | `zh-CN` / `en` 强制单语；**默认中英双语** |
| `IMMUNE_ALLOW_PRIVATE_ENDPOINT` | 设为 `1` 才允许环回/私有端点。**默认拒绝**，防 SSRF |
| `IMMUNE_GLOBAL_LIBRARY` | 设为 `0` 关闭全局共享库。默认开启 |
| `IMMUNE_GUARD` | `off`（默认）/ `warn` / `deny` —— 高危错招事前检查，见下 |
| `IMMUNE_DEBUG_LOG` | 指定文件则记录执行细节，用于排障 |

### 什么时候值得开 LLM 蒸馏（成本 / 收益）

不配 `IMMUNE_LLM_*` 时走离线规则蒸馏器：零成本、结果确定，只从失败/成功的调用串里抽关键词拼出 trigger / prescription。配上模型后，同一段「失败→成功」会被改写成一句更像人话的处方（跨项目复用、导出成 `SKILL.md` 都更好），代价是**每条蒸馏一次模型往返**。

实测（`scripts/bench-tool-latency.mjs`，mock 端点 1500 ms/次）：

| 队列深度 | `agent/turn-stopping` 耗时 | 蒸馏条数 |
| --- | --- | --- |
| 1 | ~1.5 s | 1 |
| 2 | ~3.0 s | 2 |
| 3 | ~4.6 s | 3 |
| 5 | ~7.5 s | 5 |

- 成本只落在**回合边界**一次（`agent/turn-stopping`），不落在工具调用上——`tools/post-execute` 中位稳定在 ~1 ms。
- 预算默认 12 s（`IMMUNE_DISTILL_BUDGET_MS`）。队列超过预算时，多出的任务留到下一次边界：实测 3000 ms 预算 + 6 个任务只蒸馏 2 个，其余 4 个顺延。
- 经验阈值：**每回合最多攒几条**「失败→成功」时才开模型。如果一个回合常常攒十几条，先跑离线规则蒸馏，或把 `IMMUNE_DISTILL_BUDGET_MS` 调小、让它跨多个回合摊平。

### 安全

- **脱敏**：写入磁盘前擦除 Bearer 令牌、`*_KEY=` 类赋值、URL 内嵌凭证、JWT。
  这些记录之后可能被导出成团队共享的 `SKILL.md`，泄漏在那里比泄漏在日志更糟。
- **失败不致命**：DSH 版 `apply()` 把启动包在 try/catch 里，抗体库打不开只写一条
  `warn` 并把本会话降级为「无免疫」——插件坏了不能拖垮会话。ZCode 版 hook 永远 `exit 0`。
- **SQL 只走参数绑定**，不拼接；FTS 查询词逐条加引号并转义，用户文本无法注入 FTS 语法。

### 验证状态

| 检查 | 结果 |
| --- | --- |
| `npm run build` | exit 0 |
| `npm test` | **90 条全绿**（34 条 core、7 条 ZCode hook、29 条 DSH 单元、4 条原生 UI（tab 契约）、3 条 MCP、3 条 LLM、5 条 UI 查询层、5 条 manifest 一致性（含 `dsh.client` 浏览器半契约与 shadow root 隔离）） |
| `scripts/verify-step1.mjs` | 15 断言（真实载荷判失败，含 bash 非零退出） |
| `scripts/verify-steps23.mjs` | 22 断言（失败→成功在回合结束时产出抗体；新会话注入 `<immune_memory>`） |
| `scripts/verify-live-host.mjs` | 20 断言（**真 Cordis 宿主**：真事件总线 + 真 SQLite + 跨会话注入 + 冷启动注入） |
| `scripts/verify-installed.mjs` | desktop / web 各 22 断言（bundles 登记、裸包名解析、patch 形状，以及浏览器半的 `dsh.client` 声明 + `exports["./client"]` + 装载器注册面） |
| `scripts/bench-tool-latency.mjs` | PASS，19 断言（慢速 mock 模型 1500 ms/次：`tools/post-execute` 中位 ~1 ms；`agent/turn-stopping` 按队列线性 1.5/3.0/4.6/7.5 s（1/2/3/5 条）；3000 ms 预算下 6 条只蒸馏 2 条、其余顺延） |

### 已知限制

- **模型端点默认拒绝环回**：本地 Ollama 类服务需显式设 `IMMUNE_ALLOW_PRIVATE_ENDPOINT=1`。
  这是防 SSRF 的代价，不是疏漏。
- **外部 LLM 蒸馏未实测**：规则蒸馏器全流程有测试；接真实模型端点的路径只有 mock 覆盖
  （含批量路径的降级链）。
- **真实 agent 端到端未验**：验证期间模型额度返回 402，turn 到不了工具阶段。同一条链路改为
  向安装副本投喂真实事件载荷验证（含真 Cordis 宿主的 20 条断言）。
- **`IMMUNE_GUARD=warn` 仅 ZCode 有效**：DSH 的 `PreToolDecision` 没有携带上下文的字段，
  那边只能"拦或不拦"。

---

## English

### What it does

Repeating the same mistake is the most expensive pattern an agent has. Static docs
do not fix it — nobody maintains them, and they rot. This plugin turns the failure
scene itself into a rule.

Works on two hosts that share one `core/`: **DSH** (DeepSeek Harness, verified
against the real host contract) and **ZCode** (verified against its hooks).

### Install

**npm** — published as [`dsh-immune-system`](https://www.npmjs.com/package/dsh-immune-system),
prebuilt, no toolchain needed:

```bash
dsh plugin --profile <profile> add dsh-immune-system
```

**tarball / git** (equivalent, no npm account required):

```bash
cd dsh-immune-system && npm pack
dsh plugin --profile <profile> add ./dsh-immune-system-<version>.tgz
dsh plugin --profile <profile> add github:meat-daemon-404/dsh-plugin-immune
```

`git:` installs build at install time via `prepare`, which pnpm blocks until
allowlisted — see the Chinese section above for the exact fix. Prefer npm or the
tarball.

**Restart DSH** afterwards — bundles are composed at startup.

**ZCode** — this repository *is* a marketplace source:

```bash
node "<zcode.cjs>" plugins marketplace add meat-daemon-404/dsh-plugin-immune
node "<zcode.cjs>" plugins install dsh-immune-system@dev-dsh-plugin-immune
```

Start a **new task** afterwards; old tasks keep their earlier capability catalog.

### Design notes

**Sensing outcomes, not trusting one event.** On both hosts a shell command
exiting non-zero is *not* an error result: ZCode's `PostToolUseFailure` only fires
when a handler throws, and DSH documents that "non-zero exits are reported, not
errored" — `isError` covers infrastructure failures only. Both ports therefore
classify the result themselves (exit code, trailing `[exit code: N]` /
`[killed by signal: X]` / timed-out markers, and a narrow marker regex). A
structured `value` is authoritative: a non-zero exit code is a failure and a
zero one is a success even if the output mentions `Error:`; a payload object with
no exit status is a success and is not text-scanned at all.

**Anti-rot, relevance-guarded.** An injected antibody that still did not prevent
the failure loses credit and is retired after three such episodes. The penalty is
relevance-guarded: the failure must share a meaningful term with the antibody's
trigger, and the tool name is excluded — otherwise every `Bash …` rule would be
blamed for any Bash failure.

**Injection hygiene.** Injected text comes only from our own distilled fields,
never raw tool output; brackets are stripped so a line cannot close its wrapper
tag; length-capped; labelled advisory.

**Distillation cost sits at the turn boundary.** Jobs are queued during tool
use and drained once at turn end under `IMMUNE_DISTILL_BUDGET_MS` (default
12 s). Measured with a slow mock model (`scripts/bench-tool-latency.mjs`):
`tools/post-execute` stays ~1 ms median, while `agent/turn-stopping` pays one
round trip per queued job (~1.5 s each at 1500 ms/call) and defers whatever the
budget cannot fit to the next boundary. With a model configured the drain now
**batches four episodes per request**, so a backlog fits in one budget window
instead of four.

**Failure judgement — four layers.** A tool result is classified in this order,
and the first layer that yields a verdict wins:

| # | Signal | Verdict |
| --- | --- | --- |
| 1 | structured `value.exitCode` | non-zero = failure, zero = success — authoritative, output text is not scanned |
| 2 | `isError` / `error` payload | failure, and its message becomes the symptom |
| 3 | trailing markers (`[exit code: N]`, `[killed by signal: X]`, timed out) | failure when N≠0 |
| 4 | narrow marker regex over the body (`ENOENT`, `npm ERR!`, `Cannot find module`, …) | failure; a healthy log that merely mentions "error" does not match |

**Repeat suppression.** Asking three questions in a row about the same file
would otherwise inject the identical block three times and count three hits.
When the candidate set is unchanged and fewer than four turns have passed, the
injection is skipped and `hit_count` is left alone — that counter drives
promotion and anti-rot, so inflating it would corrupt the library's own
statistics. `resume` / `clear` / `compact` reset the state.

**Target-scoped pairing.** A failure only pairs with a success that is the
*same kind of work*: same file for file tools, same program family for commands
(`npm`/`npx`/`pnpm` are one family — a build failing under `npm` and passing
under `npx` is the same task's fix; `npm …` then `git …` is not). Read-only
probes (`ls`, `pwd`, `cat`, `git status`, `git log`, `git diff`, `which`, …)
never close an episode: they cannot have fixed anything, and they sit between
an error and its real fix constantly.

**Jaccard near-duplicate merge.** Before inserting, prescriptions within the
same trigger are compared with character-3-gram Jaccard (blended with a
character-set Jaccard for short CJK sentences, where inserting one character
shifts every trigram). At ≥0.70 the rule merges into the existing row and its
hit count increments; a human correction or a model rewrite then overwrites the
stored wording, because it outranks whatever was there.

**Path-affinity rerank.** Retrieval fetches twice the requested limit, then
re-ranks in memory: ×1.5 when the trigger names a file or directory the prompt
mentions, ×0.85 for shared-library rules (project rules always win ties), and a
time decay of `1 / (1 + 0.02 × days)` so a rule nobody has needed for a year
does not outrank a fresh one.

### Dashboard

`cli.js ui` serves a local page at `http://127.0.0.1:7788/`: search, retire /
restore / delete, project and shared tabs, live counts. Browsing is a
read-only path — it never counts as an injection.

Boundaries are deliberately narrow: binds `127.0.0.1` only, a random per-run
token is required on every `/api` call (a cross-origin simple POST needs no
preflight, so Origin checking alone would not do), strict CSP, and the page
loads nothing external.

### Native UI (dsh.client)

The DSH web app gets a real settings tab instead of a separate page. The client
is `dsh-immune-system/client/client.js`, hand-written against the module-loader
contract (`window.__ModuleLoader__.load({ id, factory })`) — no bundler, no JSX,
no new dependency. Data comes from a host route registered as an *optional*
`webServer` dependency, so CLI and desktop profiles still work without it.
Mutations require same-origin JSON, which forces a CORS preflight.

### Sync & Doctor

Library snapshots are plain tagged JSON, and merging is conservative:
prescription is the identity, tallies take the MAX (two machines count
independently and must not multiply), status is active when either side says
so, and malformed rows are counted invalid rather than aborting the import.

```bash
node "<plugin>/dist/zcode/src/cli.js" export-json library.json
node "<plugin>/dist/zcode/src/cli.js" import-json library.json
node "<plugin>/dist/zcode/src/cli.js" doctor
```

`doctor` reports node version, an FTS5 trigram probe, database and shared-library
readability, the plugin marker, the MCP script, the native-UI contract
(`dsh.client` + `exports["./client"]` + a loader-registered bundle) and counts.
Any failure exits non-zero, so it can gate a script.

### Guard (IMMUNE_GUARD)

Advisory text can be dropped by a model in a long turn, so a short curated list
of calls that are wrong in essentially every environment also gets a
deterministic pre-execution check: force-push to main, `rm -rf /`,
`git reset --hard`.

```bash
IMMUNE_GUARD=off   # default: no check
IMMUNE_GUARD=warn  # louder advisory (ZCode only)
IMMUNE_GUARD=deny  # refuse the call (both hosts)
```

Patterns live in code, never in the database: a distilled rule is model output,
and compiling it into a regex that can block tool calls would hand an
unreviewed string the power to stop work, plus ReDoS risk. `deny` is never the
default. `warn` is ZCode-only because DSH's `PreToolDecision` carries no
context channel.

### Layout

```
core/                  shared, host-agnostic, zero runtime deps
  ├── store/           SQLite + FTS5 trigram: antibodies, episodes, job queue
  ├── distiller.ts     episode -> antibody (LLM, rule-based fallback)
  ├── i18n.ts          zh/en strings
  ├── redact.ts        credential scrubbing before disk
  └── export.ts        render SKILL.md
dsh/                   DSH adapter — verified against the real host contract
dsh-immune-system/     installable bundle (manifest, patch, commands, dist)
zcode/                 ZCode adapter (hooks, CLI)
docs/                  dsh-host-contract.md — every contract claim with file:line
scripts/               the five verification & benchmark scripts above
test/                  node:test
```

Point both hosts at the same `IMMUNE_DB_PATH` and they share one antibody store.

### The first sketch vs. what the host actually does

The original design guessed a Cordis-style API. Reading the DSH source disproved
every one of those guesses:

| First sketch | What DSH actually has |
| --- | --- |
| `dsh/before-llm-request` event | no such event; recall rides `agent/pre-step` (waterfall) and `agent.inject()` |
| `dsh/after-tool-call` event | no such event; results arrive on `tools/post-execute` (waterfall) |
| success / failure as two events | one event plus `isError`, and `isError` is infrastructure-only |
| `session.appendSystemReminder()` | does not exist; use `agent.inject(createUserMessage(...))` |
| `ctx.command(name, desc, handler)` | `ctx.commands.register({ name, description, handler })`, needs `inject=['commands']`, returns a `CommandResult` |
| `agent/request` to add context | explicitly forbidden — "this waterfall cannot mutate messages" |

Every row above is sourced to a file and line in
[docs/dsh-host-contract.md](docs/dsh-host-contract.md).

See also [dsh/README.md](dsh/README.md) for the DSH-side operational details.
