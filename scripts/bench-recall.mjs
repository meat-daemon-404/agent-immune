/**
 * Recall-quality benchmark — the retrieval gate.
 *
 * Idea borrowed from deja-vu (vshulcz/deja-vu): publish recall numbers for the
 * memory instead of claiming it works. A fixed scenario matrix seeds one
 * in-memory library, queries it the way the hooks do, and checks the expected
 * rule lands in the top-k. Exits non-zero on a failed gate.
 *
 * Metrics: R@1 / R@3 over positives; FP rate over negatives (unrelated prompt
 * must not surface an unrelated rule in the top-3).
 */

import { ImmuneStore } from '../dsh-immune-system/dist/core/store/index.js';

const RULES = [
  {
    id: 'vite-env',
    trigger: 'vite.config.ts 环境变量 loadEnv',
    symptom: 'process.env 读客户端变量 undefined',
    fix: 'vite.config.ts 用 loadEnv',
    tool: 'Bash',
  },
  {
    id: 'cjk-trigram',
    trigger: 'trigram 分词 中文匹配',
    symptom: 'unicode61 整句中文匹配不到',
    fix: 'trigram + LIKE 兜底',
    tool: null,
  },
  {
    id: 'docker-perm',
    trigger: 'docker permission denied volume',
    symptom: '容器内写挂载目录被拒',
    fix: 'user uid gid 或 chown',
    tool: 'Bash',
  },
  {
    id: 'crlf',
    trigger: 'CRLF LF 换行符 autocrlf',
    symptom: '整个文件因换行符被判改动',
    fix: 'autocrlf=false 或 gitattributes',
    tool: 'Bash',
  },
  {
    id: 'npm-peer',
    trigger: 'npm peer dependency ERESOLVE',
    symptom: 'install 报 peer 冲突',
    fix: 'legacy-peer-deps 或对齐版本',
    tool: 'Bash',
  },
  {
    id: 'win-path',
    trigger: 'Windows 反斜杠 转义 JSON',
    symptom: 'printf 拼 JSON 反斜杠被吃',
    fix: '探针 JSON.stringify 生成',
    tool: 'Bash',
  },
];

/**
 * One paraphrase prompt per rule: deliberately different wording than the
 * trigger, the way a user actually phrases the next turn. Kept short — these
 * are the strings most at risk of a retrieval regression.
 */
const PARAPHRASES = [
  ['vite-env', '前端 读不到 环境变量'],
  ['cjk-trigram', '中文 搜索 不到'],
  ['docker-perm', '容器 写文件 没权限'],
  ['crlf', '换行符 改动 整个文件'],
  ['npm-peer', '装依赖 冲突 装不上'],
  ['win-path', '命令里 转义 丢字符'],
  ['docker-perm', '容器里写文件报 permission denied'],
  ['npm-peer', 'npm install 报 ERESOLVE 冲突'],
];

/** Unrelated prompts, gram-clean against every seed rule. */
const NEGATIVES = [
  '帮我写一首诗',
  '把配置改一下',
  '看看现状',
  '你好',
  'k8s 调度',
  '帮我看看这个报错',
];

function seed(store) {
  const ids = {};
  for (const rule of RULES) {
    ids[rule.id] = store.insert({
      trigger_pattern: rule.trigger,
      symptom: rule.symptom,
      prescription: rule.fix,
      tool_name: rule.tool,
    });
  }
  return ids;
}

function evaluate(store, ids) {
  let hit1 = 0;
  let hit3 = 0;
  const misses = [];
  for (const [key, query] of PARAPHRASES) {
    const rows = store.match(query, { limit: 3 });
    const idx = rows.findIndex((r) => r.id === ids[key]);
    if (idx === -1) misses.push(key + ' <- ' + query);
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
      fps.push(query + ' -> ' + rows.map((r) => r.id).join(','));
    }
  }
  return {
    total: PARAPHRASES.length,
    hit1,
    hit3,
    totalNeg: NEGATIVES.length,
    fp,
    misses,
    fps,
  };
}

const store = new ImmuneStore({ dbPath: ':memory:' });
const ids = seed(store);
const result = evaluate(store, ids);

console.log(
  `R@1 ${(result.hit1 * 100 / result.total).toFixed(0)}%  ` +
    `R@3 ${(result.hit3 * 100 / result.total).toFixed(0)}%  ` +
    `FP ${(result.fp * 100 / result.totalNeg).toFixed(0)}%  ` +
    `(${result.total} positives, ${result.totalNeg} negatives)`,
);
for (const miss of result.misses) console.log('  miss: ' + miss);
for (const fp of result.fps) console.log('  fp:   ' + fp);

// Gates sit one miss below current behavior: they fail on any NEW regression,
// not on the two known weak spots (short CJK paraphrases, 2-char LIKE window).
const GATE_R3 = 7;
const GATE_FP = 1;
const ok = result.hit3 >= GATE_R3 && result.fp <= GATE_FP;
console.log(
  `gate: R@3 >= ${GATE_R3}/${result.total} ${result.hit3 >= GATE_R3 ? 'ok' : 'FAIL'} | ` +
    `FP <= ${GATE_FP}/${result.totalNeg} ${result.fp <= GATE_FP ? 'ok' : 'FAIL'}`,
);
process.exitCode = ok ? 0 : 1;
