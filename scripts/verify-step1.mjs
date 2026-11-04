import { normaliseToolEvent, DSH_EVENTS, PLUGIN_NAME } from '../dsh-immune-system/dist/dsh/src/dsh-adapter.js';

const agent = { id: 'sess-1', session: { header: { id: 'sess-1' } }, inject() {} };
const exec = { callId: 'c1', name: 'bash', arguments: { command: 'npm run build' }, agent, signal: { aborted: false } };

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`); }
}

console.log('events:', DSH_EVENTS, 'plugin:', PLUGIN_NAME);

console.log('\n[1] bash non-zero exit — isError:false, truth in the text trailer + value');
const bashFail = {
  isError: false,
  value: { exitCode: 1, stdout: { text: 'boom' } },
  content: [{ type: 'text', text: 'boom\n[exit code: 1]' }],
};
const r1 = normaliseToolEvent(exec, bashFail);
check('ok', r1.ok, false);
check('errorText', r1.errorText, 'exit code 1');
check('sessionId', r1.sessionId, 'sess-1');
check('toolName', r1.toolName, 'bash');
check('toolInput', r1.toolInput, { command: 'npm run build' });
check('resultText', r1.resultText, 'boom\n[exit code: 1]');

console.log('\n[2] bash non-zero exit with NO structured value — text trailer only');
const r2 = normaliseToolEvent(exec, {
  isError: false,
  value: undefined,
  content: [{ type: 'text', text: 'nope\n[exit code: 2]' }],
});
check('ok', r2.ok, false);
check('errorText', r2.errorText, 'exit code 2');

console.log('\n[3] thrown tool — isError:true');
const r3 = normaliseToolEvent(exec, {
  isError: true,
  error: { message: 'spawn ENOENT' },
  content: [{ type: 'text', text: 'spawn ENOENT' }],
});
check('ok', r3.ok, false);
check('errorText', r3.errorText, 'spawn ENOENT');

console.log('\n[4] clean success');
const r4 = normaliseToolEvent(exec, {
  isError: false,
  value: { exitCode: 0 },
  content: [{ type: 'text', text: 'all good' }],
});
check('ok', r4.ok, true);
check('errorText', r4.errorText, '');

console.log('\n[5] killed by signal');
const r5 = normaliseToolEvent(exec, {
  isError: false, value: undefined,
  content: [{ type: 'text', text: 'partial\n[killed by signal: SIGKILL]' }],
});
check('ok', r5.ok, false);
check('errorText', r5.errorText, 'killed by signal SIGKILL');

console.log('\n[6] no agent -> undefined');
const r6 = normaliseToolEvent({ ...exec, agent: undefined }, bashFail);
check('undefined', r6, undefined);

console.log(`\n=== step 1: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
