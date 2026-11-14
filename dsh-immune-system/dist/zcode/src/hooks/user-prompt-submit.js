/**
 * UserPromptSubmit — the injector.
 *
 * Runs synchronously (the only reliable way to get context in front of the
 * model; a background hook's output is discarded) and injects at most a few
 * antibodies matched against the user's message.
 *
 * The prompt text is the strongest available signal for "what is this turn
 * about", so it is used both to retrieve antibodies and to remember what was
 * injected, which is what later failure penalties are attributed to.
 */
import { ImmuneStore } from '../../../core/store/index.js';
import { isSubstantiveHint } from '../../../core/distiller.js';
import { runHook, sessionIdOf } from '../hook-io.js';
import { formatImmuneContext } from '../format.js';
await runHook('UserPromptSubmit', (event) => {
    // Antigravity PreInvocation fires before every model call in a turn; only
    // the initial step attaches the human prompt / injects once per turn.
    if (typeof event.invocationNum === 'number' && event.invocationNum > 1)
        return null;
    const prompt = typeof event.prompt === 'string' ? event.prompt : '';
    if (!prompt.trim())
        return null;
    const store = new ImmuneStore();
    try {
        // A prompt arriving now is the human's response to whatever failed last
        // turn. Attaching it turns "tool failed, human explained, retry worked"
        // into a much better prescription than the model could infer alone.
        // Trivial acknowledgements are filtered out here so they never become one.
        if (isSubstantiveHint(prompt))
            store.attachHumanHint(sessionIdOf(event), prompt);
        const hits = store.match(prompt, {
            limit: 3,
            sessionId: sessionIdOf(event),
            // Session-start priming already delivered these within the TTL window;
            // re-injecting them at the first prompt would pay twice for one block.
            excludeInjected: true,
            // Asking several things in a row about the same file must not re-inject
            // an identical block (or inflate hit_count) on every turn.
            suppressRepeats: true,
        });
        return formatImmuneContext(hits);
    }
    finally {
        store.close();
    }
});
