/**
 * Target signatures for failure/recovery pairing.
 *
 * A failure and a later success are only an episode when they are about the SAME
 * thing. Pairing by tool name alone conflates unrelated calls: `npm run build`
 * failing and then `git status` succeeding would distil a rule that teaches
 * nothing.
 *
 * Two additional guards:
 *  - read-only probes (`ls`, `git status`, …) must never close an episode: they
 *    cannot have fixed anything, and they are extremely common between an error
 *    and its real fix.
 *  - paths are normalised to a project-relative form so a failure in
 *    `./src/a.ts` and a success in `<cwd>/src/a.ts` still match.
 */
/** Programs that never change state; their success proves nothing. */
const PROBE_PROGRAMS = new Set([
    'ls',
    'dir',
    'pwd',
    'cd',
    'echo',
    'cat',
    'type',
    'which',
    'where',
    'head',
    'tail',
    'wc',
    'stat',
]);
/** `git` subcommands that only read. */
const GIT_PROBE_SUBCOMMANDS = new Set([
    'status',
    'log',
    'diff',
    'show',
    'branch',
    'remote',
    'rev-parse',
    'describe',
    'blame',
]);
const FILE_TOOLS = new Set(['read', 'edit', 'write', 'multiedit', 'applypatch', 'notebookedit']);
function asRecord(value) {
    return typeof value === 'object' && value !== null ? value : {};
}
/** First string field among `keys`, if any. */
function pickString(obj, keys) {
    for (const key of keys) {
        const value = obj[key];
        if (typeof value === 'string' && value.trim())
            return value.trim();
    }
    return null;
}
/**
 * Normalise a path to a project-relative, forward-slash form.
 *
 * Works on both platforms: drive-letter paths are absolute everywhere (the
 * check is explicit, because POSIX `isAbsolute` does not recognise `C:/…`), and
 * a path inside `cwd` is made relative to it so the same file matches across
 * machines and checkouts.
 */
export function normaliseTargetPath(rawPath, cwd) {
    const p = rawPath.replace(/\\/g, '/').trim();
    if (!p)
        return '';
    if (cwd) {
        const base = cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        if (base) {
            const lower = p.toLowerCase();
            if (lower === base)
                return '';
            if (lower.startsWith(`${base}/`))
                return p.slice(base.length + 1);
        }
    }
    if (/^[A-Za-z]:[\/]/.test(p) || p.startsWith('/')) {
        // Outside the project: collapse to the basename (matches the original
        // Windows behaviour and keeps signatures comparable across checkouts).
        const parts = p.split('/').filter(Boolean);
        return parts[parts.length - 1] ?? p;
    }
    return p.replace(/^\.\//, '');
}
/** Split a shell command into `program` and its first non-flag subcommand. */
export function parseCommand(command) {
    const tokens = command
        .split(/\s*(?:&&|\|\||[;|])\s*/)
        .join(' ')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    // Skip leading env assignments (FOO=bar cmd), then strip a leading path from
    // the program token ("C:\tools\npm.cmd test" -> "npm.cmd") on any platform.
    let index = 0;
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? ''))
        index += 1;
    const programToken = (tokens[index] ?? '').replace(/^["']|["']$/g, '');
    const program = (programToken.split(/[\\/]/).pop() ?? programToken).toLowerCase();
    let sub = '';
    for (let i = index + 1; i < tokens.length; i += 1) {
        const token = tokens[i] ?? '';
        if (!token || token === '-')
            continue;
        if (token.startsWith('-') || token.startsWith('/'))
            continue;
        sub = token.replace(/^["']|["']$/g, '');
        break;
    }
    return { program: program.toLowerCase(), sub: sub.toLowerCase() };
}
/** Compute the pairing signature for one tool call. */
export function targetSignature(toolName, input, cwd) {
    const obj = asRecord(input);
    // Hosts differ in tool-name casing (the DSH harness emits "bash", ZCode
    // emits "Bash"): the branch checks are case-insensitive, the SIGNATURE
    // casing stays verbatim so stored signatures keep matching their producers.
    const tool = toolName.trim().toLowerCase();
    if (FILE_TOOLS.has(tool)) {
        const raw = pickString(obj, ['file_path', 'path', 'notebook_path', 'TargetFile', 'AbsolutePath', 'Path']);
        const target = raw ? normaliseTargetPath(raw, cwd) : '';
        return { signature: `${toolName}:${target || '?'}`, probeOnly: tool === 'read' };
    }
    if (tool === 'bash') {
        const command = pickString(obj, ['command', 'cmd', 'script', 'CommandLine']) ?? '';
        if (!command)
            return { signature: 'Bash:?', probeOnly: false };
        const { program, sub } = parseCommand(command);
        const probeOnly = PROBE_PROGRAMS.has(program) || (program === 'git' && GIT_PROBE_SUBCOMMANDS.has(sub));
        return { signature: `Bash:${program || '?'}:${sub || '-'}`, probeOnly };
    }
    // Unknown tool: fall back to its name plus the first path-ish field.
    const raw = pickString(obj, ['file_path', 'path', 'notebook_path', 'TargetFile', 'AbsolutePath', 'Path', 'command', 'CommandLine']);
    return {
        signature: `${toolName}:${raw ? normaliseTargetPath(raw, cwd) : '?'}`,
        probeOnly: false,
    };
}
/**
 * Programs that belong to the same toolchain: a fix for one routinely uses
 * another (`npm run build` fails, `npx vite build` works; `pnpm` replaced by
 * `npm` and vice versa).
 */
const PROGRAM_FAMILIES = [
    new Set(['npm', 'npx', 'pnpm', 'yarn', 'bun', 'bunx', 'node', 'corepack']),
    new Set(['python', 'python3', 'py', 'pip', 'pip3', 'uv', 'poetry']),
    new Set(['git', 'gh']),
    new Set(['docker', 'docker-compose', 'podman']),
];
/** Family id for a program, or the program itself when it has none. */
function programFamily(program) {
    for (const family of PROGRAM_FAMILIES) {
        if (family.has(program))
            return [...family][0] ?? program;
    }
    return program;
}
/**
 * Whether an incoming success may close a stored failure's episode.
 *
 * The rule is "same kind of work on the same target":
 *  - a read-only probe never closes anything (it cannot have fixed it);
 *  - file tools must name the same file;
 *  - commands must belong to the same PROGRAM FAMILY (npm/npx/pnpm are one
 *    family: a build failing under npm and succeeding under npx is the same
 *    task's fix), while `npm …` then `git …` is not;
 *  - a missing target on either side is tolerated, since some tools omit it.
 */
export function canCloseEpisode(failedSignature, incoming) {
    if (incoming.probeOnly)
        return false;
    if (!failedSignature || failedSignature === '?')
        return true;
    if (failedSignature === incoming.signature)
        return true;
    const failedParts = failedSignature.split(':');
    const incomingParts = incoming.signature.split(':');
    const failedTool = failedParts[0] ?? '';
    const incomingTool = incomingParts[0] ?? '';
    if (failedTool.toLowerCase() !== incomingTool.toLowerCase())
        return false;
    if (failedTool.toLowerCase() === 'bash') {
        const failedTarget = failedParts[1] ?? '';
        const incomingTarget = incomingParts[1] ?? '';
        if (!failedTarget || failedTarget === '?' || !incomingTarget || incomingTarget === '?')
            return true;
        return programFamily(failedTarget) === programFamily(incomingTarget);
    }
    const failedTarget = failedParts.slice(1).join(':');
    const incomingTarget = incomingParts.slice(1).join(':');
    if (failedTarget === incomingTarget)
        return true;
    return !failedTarget || failedTarget === '?' || !incomingTarget || incomingTarget === '?';
}
