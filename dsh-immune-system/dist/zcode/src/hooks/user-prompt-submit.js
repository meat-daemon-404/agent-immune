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
import { runHook, sessionIdOf } from '../hook-io.js';
import { formatImmuneContext } from '../format.js';
await runHook('UserPromptSubmit', (event) => {
    const prompt = typeof event.prompt === 'string' ? event.prompt : '';
    if (!prompt.trim())
        return null;
    const store = new ImmuneStore();
    try {
        const hits = store.match(prompt, {
            limit: 3,
            sessionId: sessionIdOf(event),
            // Session-start priming already delivered these within the TTL window;
            // re-injecting them at the first prompt would pay twice for one block.
            excludeInjected: true,
        });
        return formatImmuneContext(hits);
    }
    finally {
        store.close();
    }
});
