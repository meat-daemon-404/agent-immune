/**
 * Scale benchmark: does retrieval stay fast when the library grows?
 *
 * The recall bench proves quality; this one proves the FTS5 trigram + LIKE
 * fallback + rerank path stays cheap at hundreds of rules. Publishes the
 * numbers (the deja-vu habit) and gates on a generous p95 so a pathological
 * slowdown fails instead of silently shipping.
 *
 * Usage: node scripts/bench-scale.mjs
 */

import { ImmuneStore } from '../dsh-immune-system/dist/core/store/index.js';

const N = 300;

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

const store = new ImmuneStore({ dbPath: ':memory:' });

const t0 = Date.now();
for (let i = 0; i < N; i += 1) {
  store.insert({
    trigger_pattern: `topic${i} 主题${i} 错误码E${1000 + i} module${i}.ts`,
    symptom: `场景${i} 的症状描述 failure-${i}`,
    prescription: `修复场景${i} 的确定性步骤 step-${i}`,
    tool_name: 'Bash',
  });
}
const indexMs = Date.now() - t0;

// Queries: a slice of the synthetic space (known hits), the real bench
// paraphrases (known hits), and negatives. Every query exercises the same
// path the hooks do: match() with rerank.
const queries = [];
for (let i = 0; i < N; i += 5) queries.push(`主题${i} 怎么解决`);
queries.push('前端 读不到 环境变量', '中文 搜索 不到', '容器 写文件 没权限', '换行符 改动 整个文件');
queries.push('帮我写一首诗', 'k8s 调度', '看看现状');

const latencies = [];
for (const q of queries) {
  const t = process.hrtime.bigint();
  store.match(q, { limit: 3, sessionId: 'scale-sess', suppressRepeats: true });
  latencies.push(Number(process.hrtime.bigint() - t) / 1e6);
}
latencies.sort((a, b) => a - b);

const p50 = percentile(latencies, 50);
const p95 = percentile(latencies, 95);
const max = latencies[latencies.length - 1];

console.log(`seeded ${N} rules in ${indexMs} ms (${(indexMs / N).toFixed(2)} ms/rule)`);
console.log(`${queries.length} matches: p50 ${p50.toFixed(2)} ms · p95 ${p95.toFixed(2)} ms · max ${max.toFixed(2)} ms`);

// Gates are generous: the risk they catch is a pathological regression
// (a scan replacing an index), not normal jitter.
const GATE_INDEX = 10_000;
const GATE_P95 = 50;
const ok = indexMs < GATE_INDEX && p95 < GATE_P95;
console.log(
  `gate: index < ${GATE_INDEX} ms ${indexMs < GATE_INDEX ? 'ok' : 'FAIL'} · p95 < ${GATE_P95} ms ${p95 < GATE_P95 ? 'ok' : 'FAIL'}`,
);
process.exitCode = ok ? 0 : 1;
