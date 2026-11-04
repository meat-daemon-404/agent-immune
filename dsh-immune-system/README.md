# dsh-immune-system

自进化避坑免疫：捕获每次「失败 → 修复」的工具调用，蒸馏成可复用的抗体，并在下次遇到同样场景前注入。

- **宿主**：DeepSeek Harness（DSH）0.2.x，Cordis 插件形态
- **同源**：与本仓库的 ZCode 版本共用 `core/`（SQLite + FTS5 存储、蒸馏、脱敏、导出），行为与存储格式一致
- **入口**：`dist/dsh/src/index.js`（`export const name` / `export const inject = ['commands']` / `export function apply(ctx)`）

## 它做什么

1. **感知**：挂 `tools/post-execute`（waterfall）。DSH 里 bash 非零退出**不会**置 `isError`，所以判定同时读三路信号——`isError` → `result.value.exitCode` → 输出末尾的 `[exit code: N]` / `[killed by signal: X]` 标记。
2. **沉淀**：同一会话同一工具「先失败后成功」时，把失败轨迹与成功轨迹交给 `core/distiller.ts` 蒸馏；配了 `IMMUNE_LLM_*` 走模型，否则退回确定性规则蒸馏。结果写入 SQLite `antibodies` 表。
3. **注入**：`agent/session-start` 预热最常用的三条；`agent/pre-step` 按当前人类提问做 FTS 匹配，把命中项包成 `<immune_memory>…</immune_memory>` 拼进模型上下文。冷启动 `resume`/`compact` 的首个批次不含人类提问，插件会从 `session/event` 的 `user/message` 流里补取。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/immune` | 列出本项目学到的抗体（含命中/失败计数与状态） |
| `/immune` `--all` | 连同已退役抗体一起列出 |
| `/immune-export` | 把验证过的抗体（命中 ≥ 3）导出成 `project-pitfalls` 技能 Markdown |

## 存储

优先级：

1. `IMMUNE_DB_PATH`（显式指定，测试与 ZCode 版都走这条）
2. `<DSH_HOME>/storages/dsh-immune-system/<sha1(当前工作目录)[0..16]>.sqlite`

即默认按项目隔离，互不串味，也不会往项目目录里写文件。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `IMMUNE_DB_PATH` | 覆盖抗体库路径 |
| `IMMUNE_LLM_BASE_URL` / `IMMUNE_LLM_API_KEY` / `IMMUNE_LLM_MODEL` | 可选，启用模型蒸馏；缺省用规则蒸馏 |
| `IMMUNE_LOCALE` | `zh-CN` / `en` / `both`（默认 `both`） |

## 安装

本目录既是 ZCode 插件目录（`.zcode-plugin/plugin.json`），也是 DSH 可安装 bundle 根（`package.json` 的 `dsh.bundle.patch` + `cordis.patch.yml`）。

把本目录作为 DSH profile 的依赖包安装，并把包名 `dsh-immune-system` 加进该 profile `package.json` 的 `dsh.profile.bundles`，重启 DSH 即生效。

## 验证

见仓库 `dsh/README.md` 的「验证状态」一节：`npm run build` 0 错误、`npm test` 31 条全绿、四个 `scripts/verify-*.mjs` 断言全过（含真实 Cordis 宿主下的跨会话注入与冷启动注入、本机 profile 已安装校验）。
