# DSH 适配层（dsh-immune-system）

把「踩坑 → 修好」这一次工具调用蒸馏成一条可复用的**抗体**，并在下次遇到同类场景前注入上下文。
`core/` 与 ZCode 版共用，只有宿主绑定不同，全部集中在 `dsh/src/dsh-adapter.ts`。

状态：**已按真实 DSH 源码核对**（`D:\deepseek harness\deepseek-harness\`）。原先 README 里那张
「UNVERIFIED 假设表」已删除——下面三个问题直接给答案和出处。

---

## 一、三个问题的答案

### 1. 事件叫什么

在 `dsh/src/dsh-adapter.ts` 里以 `DSH_EVENTS` 声明，全部从源码读出：

| 用途 | 真实事件名 | 出处 |
| --- | --- | --- |
| 会话开始 | `agent/session-start` | `packages\core\agent\src\runtime-types.ts:217`（`@mode emit`） |
| 每步之前 | `agent/pre-step` | `packages\core\agent\src\runtime-types.ts:231`（`@mode waterfall`） |
| 工具执行之后 | `tools/post-execute` | `packages\core\tools\src\index.ts:175`（`@mode waterfall`） |
| 回合结束 | `agent/turn-stopping` | `packages\core\agent\src\runtime-types.ts:278`（`@mode serial`，落库前 await） |

没有任何 `dsh/` 前缀的事件族——`'dsh/session-start'`、`'dsh/before-llm-request'`、
`'dsh/after-tool-call'` 这三个名字都是当初猜的，实际不存在。

### 2. 失败长什么样

**只有一个工具事件，用 `isError` 区分成功/失败，没有成功/失败两个事件**（ZCode 才有
`PostToolUse` / `PostToolUseFailure` 的分裂）。

但**只读 `isError` 会漏掉绝大多数失败**。`packages\shell\tool-bash\src\render.ts:19-21` 原文：

> Non-zero exits are reported, not errored -- the model decides how to react; only
> infrastructure failures (spawn errors, aborts) surface as isError results.

也就是说：`bash` 退出码非零到达插件时是 `isError: false`，真相在**渲染文本最后一行**：

- `[exit code: N]`（`N` 非零时才追加）
- `[killed by signal: X]`
- `[timed out after Nms]`

（`render.ts:44` 注释：Keep the exit marker last because parseExitStatus anchors there.；
解析函数 `parseExitStatus` 在 `packages\shell\shell\src\render.ts:36-41`，`tool-bash` 在
`render.ts:103` 复用。pwsh 工具共用同一套标记。）

所以 `dsh-adapter.ts` 的 `judgeOutcome()` 按**权威度**依次读：

1. `result.isError`（权威，但只覆盖基础设施失败）
2. 沙箱拒绝标记 `[sandbox: file access denied under … mode]` → 判失败但打上
   `sandboxDenied`，**不入库学习**（权限协商不是项目坑，宿主已自带升级提示）
3. `[killed by signal: X]` / `[timed out after Nms]` 或 `value.timedOut === true`
   （超时可能带 `exitCode: 0`，所以要同时看标志位）
4. 结构化 `value.exitCode`（`packages\shell\tool-bash\src\index.ts:159-182`）——
   **有则权威**：0 即成功，非 0 即失败，**不再看文本**
5. 有结构化 `value` 但没有退出状态 → **判成功且不扫文本**：工具已经用自己的
   载荷表态了，正文是数据（文件内容、grep 命中、工具 JSON 结果）。否则「读一个
   含 `Error:` 的日志文件」会被记成失败
6. 文本末行 `[exit code: N]`
7. `FAILURE_MARKERS` 特征词——**仅当上面没有任何结构化状态时**才用

第 4 步压过第 7 步是刻意的：`grep`、测试运行器、文档正文里出现 `command not found`
或 `Error:` 是常态，一条**退出码 0** 的命令不该因为它们被记成失败。反过来，只打印错误
文本、没有任何结构化状态的工具（返回 `value: {}` 或不返回 `value`）仍靠第 7 步兜底。

### 3. 怎么把文字塞给模型

**没有 `session.appendSystemReminder`**——那是猜的。真实通道有两个，插件两个都用：

- `agent.inject(message)`：**同步、返回 `void`**（`packages\core\agent\src\runtime-types.ts:143`）。
  它把消息排进 next-step 队列，**不唤醒**驱动器；官方文档明说它可能错过「pre-step 已经取了这一批」
  的那个请求。所以它只保证「下一步起可见」。
- `agent/pre-step` waterfall：`next()` 拿到决策后，插件返回
  `{ kind: 'enter', messages: [...decision.messages, 注入消息] }`，**保证进入本轮**。
  这是唯一能保证「这一轮就生效」的办法。

注入消息用 `createPluginMessage()` 构造，`source` 是 `{ kind: 'plugin', plugin: 'dsh-immune-system' }`
（对应 `MessageSourceMap`，`packages\llm\llm\src\message.ts:100-105`），这样它不会在派生历史里
被当成人说的话。正文包在 `<immune_memory>` 与 `</immune_memory>` 之间，抗体文本中的尖括号会被
`sanitize()` 抹掉，防止提前闭合标签。

**注入频率是「一回合最多一次，且只在 step 1」**。`agent/pre-step` 在工具循环里每一步都会跑；
若每步都 `store.match()`，一来同一段回忆会被重复灌进上下文，二来 `match()` 会给命中计数加 1，
于是「抗体的热度」变成「这一回合跑了几步」的函数——一个纯噪声指标。插件用
`lastInjectedTurn: Map<sessionId, turn>` 记录本会话已注入过的回合，非 step 1 或本回合已注入即直接返回
`decision` 不再插入。

### 4. 蒸馏在哪里跑

**在 `agent/turn-stopping`（`@mode serial`，回合边界提交前 await），不在 `tools/post-execute` 里。**
`drain()` 可能按配置向 LLM 端点发一次 HTTP 请求（预算 8s）；`tools/post-execute` 是 waterfall，
它的监听器被 await 在**工具结果路径**上，把蒸馏放在这里会让每一次「失败后成功」的工具调用都卡住
直到 HTTP 返回。`turn-stopping` 是回合结束的最后一个可 await 点，放这里既不影响工具延迟，
也不会丢活（未清空的队列还会在下次 `session-start` 由 `requeueStuckJobs()` 兜底）。
`post-execute` 只负责入队（`recordFailure` / `claimFailure` / `enqueueJob`）。

---

## 二、命令

两个命令都通过 `ctx.commands.register` 注册（`commands` 是服务，所以插件必须
`export const inject = ['commands']`，否则访问会抛 `cannot get property "..." without inject`）。
handler 接收 `CommandInvocation`，参数取 `invocation.rawInput`（没有单独的 `args` 字段），
返回值必须是 `CommandResult` 对象而不能是裸字符串。

| 命令 | 作用 | 参数 |
| --- | --- | --- |
| `/immune` | 列出本项目学到的抗体（含命中/失败计数与状态），末行附蒸馏预算 / 队列深度 / 库路径 | `--all` 连已退役的一起列；`--budget [ms]` 查看或本次会话内改蒸馏预算，`--budget auto` 复位 |
| `/immune-export` | 把已验证的抗体导出成 `SKILL.md` | 无（门槛：命中 ≥ 3） |

---

## 三、安装与目录布局

**发布/安装包根是 `dsh-immune-system/`**。它不是「ZCode 专用目录」，而是整个插件的发布包根：
ZCode 半读 `.zcode-plugin/plugin.json`，DSH 半读同一目录下的 `package.json` 与
`cordis.patch.yml`。两个宿主清单同处一个目录，所以不会漂移。

```
dsh-plugin-immune/
|- core/                              # 宿主无关：存储、蒸馏、检索、导出
|- dsh/src/                           # DSH 插件源码（本目录）
|  |- index.ts                        # 入口：name + inject + apply(ctx)
|  |- dsh-adapter.ts                  # 唯一绑定宿主契约的文件
|  '- cordis.patch.yml                # 源侧副本（供 review；安装根那份才是被读的）
'- dsh-immune-system/                 # <- 发布/安装包根
   |- package.json                    # DSH 安装 manifest（main / dsh.bundle.patch）
   |- cordis.patch.yml                # 被加载的 patch 层
   |- .zcode-plugin/plugin.json       # ZCode 清单
   |- hooks/、commands/               # ZCode 侧资源
   '- dist/                           # 构建产物（随包提交，无需工具链即可安装）
      |- dsh/src/index.js             # <- DSH 入口产物（main 指向这里）
      |- core/**                      # 共享 core 的产物
      '- zcode/**                     # ZCode 侧产物
```

`main` 与 `exports` **必须落在包目录内**：`exports` 目标逃出包目录是规范级禁止
（实测 `ERR_INVALID_PACKAGE_TARGET ... targets must start with "./"`），`main` 用 `..`
也只是靠目录回退侥幸。所以 manifest 放在持有 `dist/` 的目录里，`main` 写
`./dist/dsh/src/index.js`。

### 安装

把 `dsh-immune-system/` 作为一个 bundle 包加进 profile 依赖，并在该 profile 的
`dsh.profile.bundles` 数组里列出包名 `dsh-immune-system`：

```jsonc
// <DSH_HOME>/profiles/<profile>/package.json
{
  "dependencies": { "dsh-immune-system": "file:../../plugins/dsh-immune-system" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-immune-system"] } }
}
```

加载链（`packages\boot\app-boot\src\profile.ts:388-396`）：

```
dsh.profile.bundles 里的包名
  -> resolveBundleDir(binName, packageName, installAnchor, profileDir)   # 定位包目录
  -> 读该目录的 package.json
  -> 取 dsh.bundle.patch                                                # 例：'./cordis.patch.yml'
  -> patchPath = join(packageDir, declared)                             # 相对于包目录
  -> loadOverlayPatches(...)                                            # 顶层 YAML 数组
```

要点：

- 列进 `dsh.profile.bundles` 却没有 `dsh.bundle` 的包会**响亮失败**
  （`... declares no dsh.bundle in its package.json`），不会静默跳过。
- patch 文件必须是**顶层 YAML 数组**，否则报
  `... must be a top-level YAML array of loader patch entries`。
- `dsh.bundle.patch` 的路径**相对于包目录**，所以写 `./cordis.patch.yml`。
- `dsh-immune-system/` 下**没有 `node_modules`**，所以 `peerDependencies` 只作声明用途，
  全部标 `optional`——宿主已经提供了这些包，插件本身不解析它们（源码里也不 import
  `@deepseek-ai/*`，只用了 `node:crypto` 与 `node:sqlite`）。
- `package.json` 里**必须保留 `"type": "module"`**：`dist/zcode/src/hooks/*.js` 依赖它做 ESM。

---

## 四、存储

抗体库是 SQLite 单文件。DSH 侧（`dsh/src/index.ts` 的 `resolveStorePath()`）：

1. `IMMUNE_DB_PATH`（显式指定，最高优先；测试与 ZCode 版都走这条）
2. `<DSH_HOME>/storages/dsh-immune-system/<sha1(当前工作目录)[0..16]>.sqlite`（`DSH_HOME` 缺省为 `~/.dsh`）

即**默认按项目隔离**，不同工作区学到的抗体互不串味，且不往项目目录里写文件。`core/store/path.ts` 是 ZCode 与 DSH 共用的，没有 DSH_HOME 概念，所以 DSH 专属默认值放在 `dsh/src/index.ts`。两版插件指向同一个 `IMMUNE_DB_PATH` 就共用一份抗体库。

### 冷启动（resume / clear / compact）

`agent/pre-step` 在冷启动时拿到的是「seed 之后新增」的批次，**不含人类提问**，按提问匹配会静默落空。插件订阅 `session/event` 的 `user/message`（只认 `source.kind === 'user'`）记住每个会话最近的提问，pre-step 里优先用本批次的人类消息、取不到时回退到记住的那条。已在真实宿主验证：空批次 + 只有记住的提问 → 仍注入 `<immune_memory>`。

## 五、可用环境变量

| 变量 | 作用 |
| --- | --- |
| `IMMUNE_DB_PATH` | 抗体库路径；两版共用一份就指同一个文件 |
| `IMMUNE_LLM_BASE_URL` | OpenAI 兼容端点；与下一项**同时**配置才启用大模型蒸馏 |
| `IMMUNE_LLM_MODEL` | 模型名 |
| `IMMUNE_LLM_API_KEY` | Bearer 令牌 |
| `IMMUNE_LLM_TIMEOUT_MS` | 单次蒸馏超时，默认 `20000` |
| `IMMUNE_LLM_MAX_TOKENS` | 蒸馏输出上限，默认 `400` |
| `IMMUNE_DISTILL_BUDGET_MS` | 回合末单次蒸馏预算，默认 `12000`（与 ZCode 版同名同默认，钳制 1–60 s）；超出的队列顺延到下一次边界 |
| `IMMUNE_ALLOW_PRIVATE_ENDPOINT` | 设为 `1` 才允许回环/内网端点（默认拒绝，防 SSRF） |
| `IMMUNE_LOCALE` | `zh-CN` / `en` 强制单语；默认中英双语 |

不配 `IMMUNE_LLM_*` 也能跑：回落到确定性的规则蒸馏器，离线可用。

---

## 六、验证状态

| 命令 | 实测结果 |
| --- | --- |
| `npm run build` | exit 0，0 错误 |
| `npm test` | 89 条全绿（34 条 core、7 条 ZCode hook、29 条 `test/dsh.test.mjs` 假 Context 单测、4 条 `test/dsh-ui.test.mjs` tab 契约、3 条 MCP、3 条 LLM、5 条 UI 查询层、4 条 manifest 一致性（含「浏览器半按 `dsh.client` 契约可被发现」）；其中 DSH 单测含「存储打不开时 apply 只告警不崩会话」「一步回合只注入一次」「蒸馏只在 turn-stopping 落库」「结构化成功不被自身输出里的错误字样推翻」「超时带退出码 0 仍判失败」「沙箱拒绝不入库」「读含 `Error:` 的日志不算失败」「预算查看/覆盖」「列表页脚显示队列与库路径」） |
| 三步手验（`scripts/verify-step1.mjs`） | 15 断言全过（含 bash 非零退出必须判失败） |
| 三步手验（`scripts/verify-steps23.mjs`） | 22 断言全过（失败→成功在 `turn-stopping` 产出 1 行 antibodies；新 session 注入 `<immune_memory>`） |
| 真实宿主验证（`scripts/verify-live-host.mjs`） | 20 断言全过（真 Cordis Context + 真事件总线 + 真 sqlite：`tools/post-execute` 判失败→蒸馏落库，`agent/pre-step` 跨会话注入，`agent/session-start` 预热注入，冷启动空批次仍注入） |
| 本机安装验证（`scripts/verify-installed.mjs`，desktop / web 各 22 断言） | 全过：profile bundles 已登记、包可从 profile `node_modules` 解析、`dsh.bundle.patch` 存在且只有一行 insert、入口模块按裸包名导入且导出插件形状；**并且浏览器半三件事**（`dsh.client.platform === "web"`、`exports["./client"]` 指向存在的文件、该文件用 `window.__ModuleLoader__.load` 注册并导出 `name`/`apply`） |
| 浏览器半可服务性（`scripts/verify-client-serve.mjs`，desktop 10 断言） | 全过：用**生产** `ClientModuleRegistry` 在进程内组装，`graph` 里出现本插件行、`url` 形如 `/plugins/dsh-immune-system/client.js?rev=<12位hash>`、`row.inject` 含 `@deepseek-ai/dsh-client-ui-settings`；再用合成 req/res 调**真实路由处理器**，返回 200 + `text/javascript` + 与磁盘文件逐字节相同 |
| 延迟基准（`scripts/bench-tool-latency.mjs`） | PASS，19 断言：慢速 mock 模型 1500ms/次下 `tools/post-execute` 中位 **~1ms**（工具路径上无 HTTP）；`agent/turn-stopping` 随队列线性 1.5/3.0/4.6/7.5s（1/2/3/5 条）；`IMMUNE_DISTILL_BUDGET_MS=3000` 时 6 条只蒸馏 2 条、其余顺延 |

---

## 七、行为与 `core/` 共用

因为两版调用同一个 `core/`，以下行为完全一致：

- 抗体结构与 FTS5 三元组检索；
- 「失败 → 成功」配对，未配对的失败保留 30 分钟（`PENDING_TTL_MS`）；
- 注入记录 30 分钟内有效（`INJECTION_TTL_MS`），用于反哺失效判定；
- 反腐烂：一条抗体注入后工具**仍然**失败满 3 次（`RETIRE_AFTER_FAILURES`）即退役并联合新证据重蒸；
- 落盘前凭据脱敏；
- `SKILL.md` 导出格式。

---

## 八、故障排查：设置页 tab 不出现

宿主半（`/plugins/dsh-immune-system/api` 能返回 JSON）正常、但「设置 → 插件」里没有「免疫」这一栏时，按顺序查三件事：

1. **manifest 的两处声明**。`dsh-immune-system/package.json` 必须同时有
   `"dsh": { "client": { "platform": "web", ... } }` 与 `"exports": { "./client": "./client/client.js" }`。
   `npm test`（`test/manifests.test.mjs`）和 `scripts/verify-installed.mjs` 都会钉住这两点。
2. **进程启动时间必须晚于文件修改时间**。`client-modules` 对「没有浏览器半」的判定按进程**永久缓存**，所以改完 manifest 只刷新窗口没用，必须**完全退出应用再启动**。用 `/immune` 看页脚：
   `— distill budget 12000 ms · queued 0 · web tab registered · db …`
   `web tab` 有三个值：`registered`（宿主已组装 bundle 行）、`not registered`（服务在、但没组装——多半是 manifest 未生效或需要重启）、`not loaded`（该宿主没有 `clientModules` 服务）。
   启动时也会往日志里打一行同样的结论：`[immune] web tab: registered`——所以不敲命令、看日志也能判断（`clientModules` 就绪或模块图首次组装时才打印，只打一次）。
3. **浏览器半的接口面**。`scripts/verify-client-serve.mjs` 用**宿主自身的** `ClientModuleRegistry` 在进程内组装并调真实路由处理器；它绿就说明「按契约一定可服务」，剩下的只是重启。

> 注意：不要用 `curl http://127.0.0.1:<port>/plugins/dsh-immune-system/client.js` 判断。桌面版的该端口是网关，未带会话凭据时对**所有**插件的 `client.js` 都返回 401/404（实测 23 个插件一律 404），这个探测会产生假阴性。以 `/immune` 的 `web tab` 字段或设置页实见为准。

