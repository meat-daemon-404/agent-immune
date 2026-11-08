<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
    <img src="docs/logo-light.svg" alt="dsh-immune — 自进化避坑免疫系统" width="360">
  </picture>

  <p><b>让 coding agent 别再重复调试自己已经修好的问题。</b></p>

  <p>
    <a href="https://www.npmjs.com/package/dsh-immune-system"><img src="https://img.shields.io/npm/v/dsh-immune-system" alt="npm 版本"></a>
    <a href="https://github.com/meat-daemon-404/dsh-plugin-immune/actions/workflows/ci.yml"><img src="https://github.com/meat-daemon-404/dsh-plugin-immune/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <img src="https://img.shields.io/badge/coverage-82.6%25-4c9f4c" alt="覆盖率 82.6%">
    <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT">
    <img src="https://img.shields.io/badge/node-%E2%89%A522.5-blue" alt="node ≥22.5">
    <a href="https://dsh-plugin.org/plugins/meat-daemon-404/dsh-plugin-immune"><img src="https://dsh-plugin.org/badges/listed.svg" alt="已收录于 DSH 插件市场"></a>
  </p>

  <p><a href="README.md">English</a> | <b>简体中文</b></p>
</div>

工具调用报错、下一次调用修好，这两条会被存成一条规则。之后遇到类似场景，匹配上的规则先一步进入上下文，agent 就不会在同一个地方摔第二遍。

只有一个 `core/`，同时给两个宿主用：**DSH**（DeepSeek Harness，按真实宿主契约验证过）和 **ZCode**（按它的 hook 生命周期验证过）。同一个 npm 包。

<div align="center">
  <img src="docs/hero.svg" alt="免疫系统：蒸馏、召回、注入" width="720">
</div>

### 先跑三十秒

不装东西、不写任何文件，全程内存里跑：

```bash
npx dsh-immune-system@latest demo
```

它会真的蒸馏一条失败→成功的记录，用一句换了说法的提问去召回，然后把 hook 实际会注入的 `<immune_memory>` 打印出来。

### 装

**DSH**，从 npm 装（有预构建产物，不用本地编译）：

```bash
dsh plugin --profile <profile> add dsh-immune-system
```

想用 tarball 或直接从 git 装：

```bash
cd dsh-immune-system && npm pack
dsh plugin --profile <profile> add ./dsh-immune-system-<version>.tgz
dsh plugin --profile <profile> add github:meat-daemon-404/dsh-plugin-immune
```

`github:` 这种方式会在安装时跑 `prepare`，pnpm 10 默认拦构建脚本，得先 `pnpm approve-builds` 把 `dsh-immune-system` 加进 `onlyBuiltDependencies`。不想折腾就用 npm 或 tarball。装完记得重启 DSH —— 插件 bundle 是启动时组装的。

**ZCode**，这个仓库本身就是市场源：

```bash
node "<zcode.cjs>" plugins marketplace add meat-daemon-404/dsh-plugin-immune
node "<zcode.cjs>" plugins install dsh-immune-system@dev-dsh-plugin-immune
```

装完开新任务；老任务还拿着它启动时的能力清单。

### 不跑 hook 的 agent 怎么办

Cursor、Codex 这些不认我们的 hook，但它们都读 `AGENTS.md` / `CLAUDE.md`。所以加了条命令，把成熟的规则写进这些文件：

```bash
immune sync-doc                        # 默认写 AGENTS.md
immune sync-doc --out CLAUDE.md --min-hits 5
```

内容写在 `<!-- immune:generated -->` 标记之间。标记外的内容一个字不动，规则里的尖括号先剥掉再写，重复执行是替换那一段，不会越写越长。

想让它每回合自动同步，开两个环境变量：`IMMUNE_SYNC_DOC=AGENTS.md`（或 `1` 表示用默认目标），`IMMUNE_SYNC_DOC_MIN_HITS=3`（少于三次命中的规则不导出）。

### 跑分和 CI

每次 push 都在 Node 22 和 24 上跑一遍召回闸和单测：

* **召回**：固定的中英场景矩阵，8 条改述正例、6 条 gram 干净的负例。现在是 R@1 100%、R@3 100%、误报 0%。低于 R@3 7/8 或高于误报 1/6 就红。
* **索引和查询**（`scripts/bench-scale.mjs`）：300 条规则入库 41 ms（每条 0.14 ms）；67 次匹配 p50 0.37 ms、p95 0.66 ms。
* **hook 开销**（`scripts/bench-tool-latency.mjs`）：工具执行路径永远不碰模型，蒸馏的钱花在回合边界上。
* **真机验证 LLM**（`scripts/verify-llm.mjs`）：配了端点就一条命令走通全链路。

### 和别的工具比

|  | dsh-plugin-immune | [deja-vu](https://github.com/vshulcz/deja-vu) | [mem0](https://github.com/mem0ai/mem0) | [claude-memory-compiler](https://github.com/nicobailon/claude-memory-compiler) |
| --- | --- | --- | --- | --- |
| 存什么 | 失败→成功的配对，蒸馏成规则 | 完整会话记录 | 对话里的事实 | 编译好的 skill 文件 |
| 怎么用上 | 靠 hook，在重蹈之前注入 | 需要时搜索（MCP / TUI） | SDK 层召回 | 模型得主动去读 |
| 依赖 | 无（`node:sqlite` FTS5） | 一个 Go 二进制 | Python + 向量库 | Node |
| 宿主 | DSH、ZCode | Claude Code、Codex、Cursor 等 36+ | 走 SDK 都行 | Claude Code |

其实是两件不同的事：deja-vu 把你做过的全量索引起来供搜索，这里只留教训，然后不请自来地塞进上下文。

### 实现上几个躲不过去的问题

**怎么判断一次调用失败了。** 两个宿主都不会因为退出码非零就报错：ZCode 的 `PostToolUseFailure` 只有 handler 抛异常才触发，DSH 文档写得很清楚——非零退出是"报告"，不是"错误"。所以两边都自己判，顺序是：结构化 `value.exitCode` 优先；其次是 `isError` 或 `error` 载荷；再其次是尾部的 `[exit code: N]`、`[killed by signal: X]`、超时标记；最后才是窄范围的关键字正则。有结构化载荷但没有退出状态的，一律当成功，正文不扫——不然 grep 一个日志、日志里写着 `Error:`，就被记成一次失败。

**配对的边界。** 失败的调用只跟"同一类活"的成功配对：文件工具看同一个文件，命令看是否同族（`npm`、`npx`、`pnpm` 算一族，所以 `npm` 编译失败换 `npx` 编译成功是同一次修复；`npm …` 后面接 `git …` 不算）。只读探测（`ls`、`cat`、`git status`、`git diff`、`which`）永远不会闭合一次失败——它没可能修好任何东西。

**合并与淘汰。** 处方用字符 3-gram 的 Jaccard 比（中文短句会和字符集相似度取最大值，因为插一个字就把所有 trigram 错位了）。到 0.70 就并进已有那条，同时把新触发词拼进去，所以每换个说法，规则的召回面就宽一点。被注入过却还是没能阻止失败的规则，三次就退役；扣分带相关性门控，免得一条 `Bash …` 规则被无关的 Bash 失败连坐。

**检索。** 三个字以上走 FTS5 trigram，两个字的词（跨域、端口、权限这种）走绑定参数的 LIKE——trigram 根本索引不了两个字。候选再做一次重排：prompt 里提到的路径 ×1.5，来自共享库的规则 ×0.85，时间衰减是 `1 / (1 + 0.02 × 天数)`。

**注入和预算。** 注入的文字只来自我们自己蒸馏出来的字段，尖括号剥掉（不然一行就能把包装标签提前闭合），长度截断，并且标注是"仅供参考"。同一组候选在四回合内不重复注入，被跳过的那几回合也不计命中数——那个计数驱动晋升和淘汰，灌水会让统计说谎。蒸馏任务在工具调用期间入队，回合末按 `IMMUNE_DISTILL_BUDGET_MS`（默认 12 秒）排空，有模型时一次请求处理四条。

那些做过的决定、以及试过又撤回的改动，都写在 [AGENTS.md](AGENTS.md) 里。
