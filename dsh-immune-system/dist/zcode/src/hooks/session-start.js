/**
 * SessionStart — prime a new session and catch up on leftover work.
 *
 * Two jobs: drain any distillation jobs a previous session never finished, and
 * inject the project's most-used antibodies so the session starts already
 * aware of its own history.
 *
 * The priming injection is RECORDED against the session. That matters twice:
 * the anti-rot penalty can then attribute later failures to rules injected at
 * session start (previously they were exempt and could never retire), and
 * prompt-time matching skips rules this session has already seen.
 *
 * The runtime only passes a match value for `startup` and `resume` (the
 * `clear`/`compact` sources are documented but not dispatched in this build),
 * so hooks.json uses no matcher at all — that matches every source.
 */
import { ImmuneStore } from '../../../core/store/index.js';
import { looksEchoPrescription } from '../../../core/rewrite.js';
import { runHook, sessionIdOf } from '../hook-io.js';
import { formatImmuneContext } from '../format.js';
import { drainJobs } from '../drain.js';
await runHook('SessionStart', async (event) => {
    const store = new ImmuneStore();
    try {
        // resume / clear / compact are new contexts: a rule suppressed before them
        // must be eligible again.
        const source = typeof event.source === 'string' ? event.source : '';
        if (source === 'resume' || source === 'clear' || source === 'compact') {
            store.resetTurnState(sessionIdOf(event));
        }
        await drainJobs(store);
        // Priming has NO context to match against, so an echo-grade prescription
        // (a raw command dump) is pure noise here: nothing says this session will
        // run that command. The same rule stays fully eligible in PreToolUse and
        // UserPromptSubmit recall, where the concrete call/prompt matches its
        // trigger — and there the echoed command IS the answer. Measured on the
        // maintainer's machine: a foreign project's command-dump rules owned the
        // top slots and rode into every new session of an unrelated project.
        const top = store
            .listAll(false)
            .filter((a) => !looksEchoPrescription(a.prescription))
            .slice(0, 3);
        if (top.length > 0) {
            store.recordInjection(sessionIdOf(event), top.map((a) => a.id), top.map((a) => a.prescription));
        }
        return formatImmuneContext(top);
    }
    finally {
        store.close();
    }
});
