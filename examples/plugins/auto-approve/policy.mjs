/**
 * The commands auto-approve never answers, and the provider's answer for one Bash command. Pure:
 * the backend judges the command Claude's PermissionRequest hook hands it with these. Plain ESM
 * with no imports, so the example installs byte for byte.
 */

/**
 * @typedef {object} NeverRule
 * @property {string} name
 * @property {(tokens: readonly string[], all: string) => boolean} test
 */

/** @typedef {{ allow: true } | { allow: false, reason: string }} Judgement */

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const INTERPRETERS = /^(?:python[0-9.]*|node|nodejs|perl|ruby|php|deno|bun)$/;
const AWS_WRITE = /^(?:delete|put|create|update|terminate|modify|remove)-/;
const WRAPPERS = new Set(['command', 'exec', 'env', 'nohup', 'time', 'builtin']);
/** @param {string} token */
const base = (token) => token.split('/').pop() ?? token;
/**
 * @param {readonly string[]} tokens
 * @param {string} name
 * @returns {readonly string[] | null}
 */
const after = (tokens, name) => {
    const i = tokens.findIndex((token) => base(token) === name);
    return i < 0 ? null : tokens.slice(i + 1);
};
/**
 * @param {readonly string[]} tokens
 * @param {string} name
 * @param {readonly string[]} verbs
 */
const sub = (tokens, name, verbs) => after(tokens, name)?.some((token) => verbs.includes(token)) ?? false;
/** @param {readonly string[]} tokens */
const commandWord = (tokens) => tokens.find((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) && !WRAPPERS.has(base(token)));

/**
 * Commands auto-approve never answers: the prompt is left for the user. Each rule sees one
 * segment's tokens and the whole text. Broad on purpose: a false match only costs a manual answer.
 * @type {readonly NeverRule[]}
 */
export const NEVER_AUTO_APPROVE = [
    { name: 'rm -r', test: (t) => t.some((x, i) => base(x) === 'rm' && t.slice(i + 1).some((f) => f === '--recursive' || /^-[A-Za-z]*[rR]/.test(f))) },
    { name: 'git push', test: (t) => after(t, 'git')?.includes('push') ?? false },
    { name: 'sudo', test: (t) => t.some((x) => base(x) === 'sudo') },
    { name: 'download piped into a shell', test: (t, all) => /\b(?:curl|wget)\b/.test(all) && t.some((x) => SHELLS.has(base(x))) },
    { name: 'download piped into an interpreter', test: (t, all) => /\b(?:curl|wget)\b/.test(all) && t.some((x) => INTERPRETERS.test(base(x))) },
    // Code fed to a shell or interpreter on stdin is hidden from every other rule: `… | base64 -d | sh`, `python3 <<EOF`.
    {
        name: 'piped or heredoc into a shell or interpreter',
        test: (t, all) => {
            const word = commandWord(t);
            if (word === undefined || (!SHELLS.has(base(word)) && !INTERPRETERS.test(base(word)))) return false;
            const piped = new RegExp(`\\|[^|]*(?:^|[\\s/])${base(word).replace(/[.]/g, '\\.')}(?:\\s|$)`).test(all.replace(/["'\\]/g, ''));
            // No script file to run means it reads its code from stdin, wherever that comes from.
            const args = t.slice(t.indexOf(word) + 1);
            const files = args.filter((f) => !f.startsWith('-') && !f.startsWith('<'));
            return piped || files.length === 0 || args.some((f) => f.startsWith('<') || f === '-' || f === '-s' || /^\/(?:dev|proc)\//.test(f));
        }
    },
    // `python -c '…'` hides its command from every rule below; so does `bash -c` with quotes in the way.
    {
        name: 'shell or interpreter running inline code',
        test: (t) =>
            t.some(
                (x, i) =>
                    (SHELLS.has(base(x)) || INTERPRETERS.test(base(x))) &&
                    t.slice(i + 1).some((f) => /^-[A-Za-z]*[ceE][A-Za-z]*$/.test(f) || ['--eval', '--print', '--command', 'eval'].includes(f))
            )
    },
    // Auto-approve must not be able to extend or restart itself, by the CLI or a raw socket write.
    { name: 'auto-approve itself', test: (_t, all) => /auto-?approve/i.test(all.replace(/["'\\]/g, '')) },
    { name: 'mkfs', test: (t) => t.some((x) => /^mkfs(?:\.|$)/.test(base(x))) },
    { name: 'dd of=', test: (t) => after(t, 'dd')?.some((f) => f.startsWith('of=')) ?? false },
    {
        name: 'find -delete or -exec rm',
        test: (t) => {
            const rest = after(t, 'find');
            return rest !== null && (rest.includes('-delete') || rest.some((x, i) => ['-exec', '-execdir', '-ok', '-okdir'].includes(x) && base(rest[i + 1] ?? '') === 'rm'));
        }
    },
    { name: 'git clean -f', test: (t) => { const rest = after(t, 'git'); return rest !== null && rest.includes('clean') && rest.some((f) => f === '--force' || /^-[A-Za-z]*f/.test(f)); } },
    { name: 'git reset --hard', test: (t) => { const rest = after(t, 'git'); return rest !== null && rest.includes('reset') && rest.includes('--hard'); } },
    {
        name: 'git checkout -- . or git restore .',
        test: (t) => {
            const rest = after(t, 'git');
            return rest !== null && ((rest.includes('checkout') && rest.includes('--') && rest.includes('.')) || (rest.includes('restore') && rest.includes('.')));
        }
    },
    { name: 'rsync --delete', test: (t) => after(t, 'rsync')?.some((f) => f.startsWith('--delete') || f.startsWith('--remove-source-files')) ?? false },
    {
        name: 'git branch -D',
        test: (t) => {
            // Force, -D, and the forced move or copy (-M, -C) can each drop a branch's commits.
            const rest = after(t, 'git');
            const i = rest?.indexOf('branch') ?? -1;
            return rest !== null && i >= 0 && rest.slice(i + 1).some((f) => /^--fo/.test(f) || /^-[A-Za-z]*[fDMC]/.test(f));
        }
    },
    // `git -c alias.x='!rm -rf ~' x` or `-c core.pager=…` runs a shell command named only in config.
    {
        name: 'git -c config',
        test: (t) =>
            (after(t, 'git')?.some((f) => f === '-c' || /^-c./.test(f) || f.startsWith('--config-env') || /alias\./i.test(f)) ?? false) ||
            t.some((x) => /^GIT_CONFIG/.test(x))
    },
    {
        name: 'chmod or chown -R',
        test: (t) => t.some((x, i) => (base(x) === 'chmod' || base(x) === 'chown') && t.slice(i + 1).some((f) => f === '--recursive' || /^-[A-Za-z]*R/.test(f)))
    },
    {
        name: 'gh api DELETE',
        test: (t) => {
            const rest = after(t, 'gh');
            return (
                rest !== null &&
                rest.includes('api') &&
                rest.some((f, i) => /^(?:-X=?|--method=?)DELETE$/i.test(f) || (['-X', '--method'].includes(f) && /^delete$/i.test(rest[i + 1] ?? '')))
            );
        }
    },
    {
        name: 'gh pr merge or gh repo delete',
        test: (t) => {
            const rest = after(t, 'gh');
            return rest !== null && ((rest.includes('pr') && rest.includes('merge')) || (rest.includes('repo') && rest.includes('delete')));
        }
    },
    { name: 'npm publish', test: (t) => ['npm', 'yarn', 'pnpm'].some((tool) => sub(t, tool, ['publish'])) },
    { name: 'kubectl write', test: (t) => sub(t, 'kubectl', ['delete', 'apply', 'replace', 'scale', 'drain', 'patch', 'edit', 'create']) },
    { name: 'terraform apply or destroy', test: (t) => ['terraform', 'terragrunt', 'tofu'].some((tool) => sub(t, tool, ['apply', 'destroy'])) },
    { name: 'helm install, upgrade or uninstall', test: (t) => sub(t, 'helm', ['install', 'upgrade', 'uninstall', 'delete', 'rollback']) },
    {
        name: 'aws write',
        test: (t) => {
            const rest = after(t, 'aws');
            if (rest === null) return false;
            if (rest.some((x) => AWS_WRITE.test(x))) return true;
            const s3 = rest.indexOf('s3');
            const verb = s3 < 0 ? undefined : rest[s3 + 1];
            return verb === 'rm' || verb === 'mv' || verb === 'rb' || (verb === 'sync' && rest.some((f) => f.startsWith('--delete')));
        }
    },
    // `R=rm; $R -rf x`: the real command word is only known when the shell runs it.
    { name: 'command word is a variable', test: (t) => /^\$/.test(commandWord(t) ?? '') },
    { name: 'alias or eval', test: (t) => t.some((x) => base(x) === 'alias' || base(x) === 'eval') },
    // `{rm,-rf,/x}` and `/bin/r? -rf x` only become a command once the shell expands them.
    { name: 'brace or glob expansion', test: (t) => t.some((x) => /[{}*?[]/.test(x)) }
];

/**
 * Quotes and backslashes are deleted, not spaced, so r"m" -rf and r\m -rf read as rm -rf, as the shell runs them.
 * @param {string} text
 * @returns {string[][]}
 */
const segments = (text) =>
    text
        .replace(/["'\\]/g, '')
        .split(/&&|\|\||[;|&\n`]|\$\(|[()]/)
        .map((segment) => segment.trim().split(/\s+/).filter(Boolean))
        .filter((tokens) => tokens.length > 0);

/**
 * The never-auto-approve rule `command` breaks, or null. A wrapped command is also read with its lines joined.
 * @param {string} command
 * @returns {string | null}
 */
export function neverAutoApprove(command) {
    if (!command) return null;
    const lines = command.split('\n').map((line) => line.trim());
    for (const text of [command, lines.join(' '), lines.join('')]) {
        for (const tokens of segments(text)) {
            const rule = NEVER_AUTO_APPROVE.find((candidate) => candidate.test(tokens, text));
            if (rule !== undefined) return rule.name;
        }
    }
    return null;
}

/**
 * The provider's whole answer for one Bash command. The whole command is judged: a command that
 * spans lines is never allowed, whatever the lines say, so nothing can ride in after a line that
 * only looks harmless.
 * @param {unknown} command
 * @returns {Judgement}
 */
export function judgeCommand(command) {
    if (typeof command !== 'string' || !command) return { allow: false, reason: 'no command' };
    if (/[\r\n]/.test(command)) return { allow: false, reason: 'multi-line command' };
    const rule = neverAutoApprove(command);
    return rule === null ? { allow: true } : { allow: false, reason: 'never auto-approved: ' + rule };
}
