## Context

用户提供了《高 Star 开源产品化与演进方案》（基于 v1.0.33）。对照 v1.0.34 现状修正后：`sync-md` 已存在（`sync-doc`）、注入隔离已实现（决策 #18）、EMA/dormant 与向量重排被决策 #19 明确搁置、Action-Diff 大半已存在（`repair_actions` 缓冲）。**唯一既新、不冲突、且 roadmap 标为最高优先级的是 `connect` 一键钩子安装器。**

外部实测确认可行性：
- **Claude Code**（code.claude.com/docs/en/hooks）：hook 契约与 ZCode 几乎同构——同样的 `hookSpecificOutput.{hookEventName, additionalContext}` 注入 schema、`permissionDecision: deny` 拒绝 schema、matcher 语法；有 `PostToolUseFailure` 事件；`${CLAUDE_PLUGIN_ROOT}/CLAUDE_PLUGIN_DATA/CLAUDE_PROJECT_DIR` 回退早已写在 `zcode/src/root-marker.ts:15-57` 和 `core/store/path.ts:23-26`。
- **Codex CLI**（官方 hooks 文档）：`~/.codex/hooks.json` 或 config.toml 内联，同 schema；**无 `PostToolUseFailure`**（失败判定走 `classifyOutcome` 主路径，正好兼容）；非托管 hook 需用户 `/hooks` 信任，connect 输出必须提示。

范围：本轮只做 connect（claude-code + codex）。audit 留下一轮。

## 实施

### 1. 新文件 `core/connect.ts`（纯逻辑，可测）

- `HookSpec` 表：6 事件（SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/PostToolUseFailure/Stop），沿用 `dsh-immune-system/hooks/hooks.json` 的 matcher（仅 PreToolUse：`Bash|Edit|Write|MultiEdit|Read|Grep|Glob`）与超时（秒：20/5/4/5/5/30）；**codex dialect 剔除 PostToolUseFailure**。
- `buildHookConfig(host, scriptDir)`：生成宿主方言条目 —— `{"type":"command","command":"node \"<scriptDir>/<name>.js\"","timeout":N}`（路径用正斜杠）；目标文件：`~/.claude/settings.json` 的 `hooks` 键、`~/.codex/hooks.json` 顶层。
- `mergeHooks(existing, ours)`：只追加含 `dsh-immune-system` 标记的条目，幂等（重复 connect 零变化）；`removeHooks` 只摘除我们的条目；不碰用户其它 hooks。
- 首次修改前写 `<file>.bak-immune` 备份（不存在才写）。
- `scriptDir` 由 `fileURLToPath(import.meta.url)` 推导（dist/zcode/src/ 同级 `hooks/`）——npm 装机即在 `node_modules/dsh-immune-system/dsh-immune-system/dist/zcode/src/hooks/`（决策 #11 前缀，探针必须打前缀路径）。
- 所有路径接受 `home` 参数（默认 `os.homedir()`），测试传临时目录，**验证绝不碰真实 `~/.claude`**。
- 返回结构化报告：新增/已存在/移除条目数、配置路径、后续步骤文案。

### 2. `zcode/src/cli.ts`

- `connect` 在 `demo`/`ui` 同层特判（**不开 ImmuneStore**，纯配置文件操作）。
- `connect claude-code|codex [--remove|--status]`；裸 `connect` 列出支持宿主与配置路径。输出含：写了什么、Codex 需 `/hooks` 信任、重启会话生效、`connect --remove` 卸载、`immune doctor` 验证。

### 3. 测试 `test/connect.test.mjs`

临时目录下：全新配置生成正确条目；已有用户 hooks 完整保留；二次 connect 幂等；`--remove` 只删我们的；codex 无 PostToolUseFailure；命令路径指向真实存在的 dist 文件（`fs.existsSync`）。

### 4. 文档

- `README.md` + `README.zh-CN.md`：新增 "Hooking Claude Code & Codex" 章节（npx 命令、信任/重启提示、--remove）；Comparison 表 Hosts 行与 "two hosts" 表述更新为 "two native hosts + connect for Claude Code & Codex"。
- `AGENTS.md` change-map 表加一行：connect 安装器 | `core/connect.ts` | `test/connect.test.mjs`。

### 5. 收尾（既有流程）

`npm run build`（dist 入提交）→ 4 个 manifest 升 **1.0.35** → `plugins validate` → 全套验收（npm test、verify-step1/steps23/live-host/client-serve、bench-recall、bench-tool-latency）→ 临时 HOME 冒烟 `connect claude-code` + `--remove` → 提交推送。

## 明确不做（本轮）

- audit 命令（下一轮）；EMA/dormant、本地向量重排、自动合并 Checklist（决策 #19/#24/#28 搁置，不翻案）；仓库改名（用户决策）；README 截图门面（需要实机截图，单独安排）。

## 验证方式

`npm test` 全绿 + 4 个验收脚本 + 两个 bench + `plugins validate`；`test/connect.test.mjs` 钉住合并/幂等/卸载；临时 HOME 冒烟确认生成的 settings.json 可被 JSON.parse 且指向存在的脚本，随后 `--remove` 还原。