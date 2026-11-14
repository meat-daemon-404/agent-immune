/**
 * Seed-pack recall benchmark — the starter rules must actually be findable.
 *
 * bench-recall.mjs gates the RETRIEVAL ENGINE with a fixed synthetic matrix;
 * this gates the CONTENT: every rule shipped in core/packs.ts gets one
 * paraphrased user prompt (different wording from its trigger, the way a
 * user actually phrases the next turn) and must land in the top-3. A rule
 * nobody can recall is worse than no rule — it occupies the injection budget.
 *
 * Also checks negatives: an unrelated prompt must not surface a seed rule.
 */
import { ImmuneStore } from '../dsh-immune-system/dist/core/store/index.js';
import { BUILTIN_PACKS } from '../dsh-immune-system/dist/core/packs.js';

/** key = `${pack.id}:${trigger's unique fragment}`; query = a paraphrase. */
const QUESTIONS = [
  // git-safety
  ['git-safety', 'git push --force', '强推把别人提交冲掉了怎么避免'],
  ['git-safety', 'git clean -fd', '清理工作区时把没跟踪的文件误删'],
  ['git-safety', 'git reset --hard', '想回到上个提交但不想丢手头改动'],
  ['git-safety', 'commit 消息 printf', '用命令行拼 commit 消息，百分号把格式搞坏了'],
  ['git-safety', 'push protection xoxp', '测试夹具里的令牌把 git push 卡住了'],
  ['git-safety', 'git rebase 冲突', '变基到一半冲突了不知道该继续还是放弃'],
  // node-ts
  ['node-ts', 'npm install ERESOLVE', '装包时 peer 依赖打架装不上'],
  ['node-ts', 'ESM Windows 绝对路径', '动态导入 Windows 路径报协议不支持'],
  ['node-ts', 'node:sqlite node 版本', '低版本 Node 上内置 sqlite 模块不可用'],
  ['node-ts', 'old_string not found', '替换文本明明存在却提示找不到'],
  ['node-ts', 'File has not been read yet', '改文件前忘了先读，编辑器不让改'],
  ['node-ts', 'File has been modified since read', '并行会话动过文件后 Edit 失败'],
  ['node-ts', '__dirname ReferenceError', 'ES 模块里拿目录名报错'],
  // python-uv
  ['python-uv', 'externally-managed PEP 668', '系统 Python 不让直接 pip 装包'],
  ['python-uv', 'uv run lockfile', '脚本跑的依赖版本和锁文件不一致'],
  ['python-uv', '缩进 tab 空格', '缩进混用导致解析报错'],
  ['python-uv', 'python 相对路径 cwd', '换个工作目录跑脚本就找不到数据文件'],
  ['python-uv', 'pip uv 环境不一致', '包装进了一个解释器，另一个里看不到'],
  ['python-uv', 'requirements.txt pyproject', '手改依赖清单被工具重新生成覆盖'],
  // docker
  ['docker', 'Dockerfile COPY 缓存失效', '每次改源码都把依赖层缓存打穿'],
  ['docker', '.dockerignore', '构建上下文把本地密钥和依赖都传进去了'],
  ['docker', 'EXPOSE 端口 -p', '容器起来了但端口访问不到'],
  ['docker', 'alpine musl', '小镜像里原生模块编译不过'],
  ['docker', 'compose up 配置没生效', '改完 Dockerfile 服务还是跑旧镜像'],
  ['docker', '容器内 localhost', '容器里连不上宿主机开的服务'],
  // modern-web
  ['modern-web', 'modal dialog', '弹窗总被别的 z-index 挡住怎么原生实现模态框'],
  ['modern-web', 'popover dropdown', '下拉浮层点击外部关闭手写事件太乱怎么办'],
  ['modern-web', 'anchor getBoundingClientRect', '悬浮提示坐标测量定位总闪怎么替代 getBoundingClientRect'],
  ['modern-web', 'view transition', '单页应用路由切换怎么流畅做页面转场过渡动画'],
  ['modern-web', 'subgrid :has()', '卡片列表网格对齐还得写死高度或监听子状态吗'],
  ['modern-web', 'inp main thread', '页面滚动输入卡顿、INP 交互延迟很高怎么优化'],
  ['modern-web', 'structuredClone', '深拷贝不想用 JSON.parse 且请求要加 AbortSignal 超时'],
];

/** Unrelated prompts — gram-clean enough that no seed rule should surface. */
const NEGATIVES = [
  '帮我写一首关于秋天的诗',
  '看看现在几点了',
  '把这个函数重命名为 calculate',
  '你好',
  'k8s 调度策略怎么配',
  '给我讲讲量子计算',
];

const store = new ImmuneStore({ dbPath: ':memory:' });
const ids = new Map();
for (const pack of BUILTIN_PACKS) {
  store.seedPack(pack.id, pack.rules);
  // Resolve ids by trigger pattern, not by row-diff: insert can merge a
  // near-identical prescription into an existing row, which makes a diff
  // of "added" rows nondeterministic across runs.
  const all = store.listAll(true);
  for (const rule of pack.rules) {
    const row = all.find((r) => r.trigger_pattern === rule.trigger_pattern);
    if (row) ids.set(`${pack.id}:${rule.trigger_pattern}`, row.id);
  }
}

let hit1 = 0;
let hit3 = 0;
const misses = [];
for (const [pack, fragment, query] of QUESTIONS) {
  const key = [...ids.keys()].find((k) => k.startsWith(`${pack}:`) && k.includes(fragment));
  const expected = key ? ids.get(key) : null;
  if (expected === null) {
    misses.push(`NO-RULE ${pack}:${fragment}`);
    continue;
  }
  const rows = store.match(query, { limit: 3 });
  const idx = rows.findIndex((r) => r.id === expected);
  if (idx === -1) misses.push(`${pack}:${fragment} <- "${query}"`);
  else {
    hit3 += 1;
    if (idx === 0) hit1 += 1;
  }
}

let fp = 0;
const fps = [];
for (const query of NEGATIVES) {
  const rows = store.match(query, { limit: 3 });
  if (rows.length > 0) {
    fp += 1;
    fps.push(`${query} -> ${rows.map((r) => `#${r.id}`).join(',')}`);
  }
}

const total = QUESTIONS.length;
console.log(
  `seed rules ${store.listAll(true).length} · questions ${total}\n` +
    `R@1 ${(hit1 * 100 / total).toFixed(0)}%  R@3 ${(hit3 * 100 / total).toFixed(0)}%  ` +
    `FP ${(fp * 100 / NEGATIVES.length).toFixed(0)}% (${fp}/${NEGATIVES.length})`,
);
if (misses.length > 0) console.log('misses:\n  ' + misses.join('\n  '));
if (fps.length > 0) console.log('false positives:\n  ' + fps.join('\n  '));

// Gate: every shipped seed rule must be recallable, and unrelated prompts
// must not fill the injection budget. Fail the build otherwise.
const gateOk = hit3 === total && fp === 0;
console.log(`gate: R@3 ${hit3}/${total} ${hit3 === total ? 'ok' : 'FAIL'} | FP ${fp}/${NEGATIVES.length} ${fp === 0 ? 'ok' : 'FAIL'}`);
store.close();
process.exitCode = gateOk ? 0 : 1;
