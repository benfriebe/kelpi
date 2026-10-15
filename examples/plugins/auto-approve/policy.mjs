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
const S3_URL = /^s3:\/\//i;
const WRAPPERS = new Set(['command', 'exec', 'env', 'nohup', 'time', 'builtin', 'nice', 'stdbuf', 'timeout']);
/** Words that come before a command without being it: `then $R -rf x`. */
const KEYWORDS = new Set(['!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until']);
/** A wrapper's options that take the next word as their value: `env -u NAME`, `exec -a NAME`, `time -o FILE`. */
const WRAPPER_VALUES = new Map([
    ['env', /^-[A-Za-z0-9]*[uCP]$|^--(?:unset|chdir)$/],
    ['exec', /^-[A-Za-z]*a$/],
    ['time', /^-[A-Za-z]*[fo]$|^--(?:format|output)$/],
    ['nice', /^-[A-Za-z]*n$|^--adjustment$/],
    ['stdbuf', /^-[A-Za-z]*[ioe]$|^--(?:input|output|error)$/],
    ['timeout', /^-[A-Za-z]*[sk]$|^--(?:signal|kill-after)$/]
]);
/** `2>/dev/null`, `</dev/null`, `>out`, `2>1` (how `2>&1` reads whole); a bare `>` or `2>` takes the next word as its target. */
const REDIRECTION = /^(?:[0-9]*|&)[<>]/;
const BARE_REDIRECTION = /^(?:[0-9]*|&)[<>][<>&|-]*$/;
/** `node -p` evaluates and prints its argument. */
const PRINTERS = /^(?:node|nodejs|bun)$/;
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
/**
 * Where the command word is, or -1: past `NAME=value` prefixes, redirections, keywords, and wrappers
 * with their options, so `| env -i sh` and `| 2>/dev/null sh` still read as sh.
 * @param {readonly string[]} tokens
 */
const commandAt = (tokens) => {
    /** @type {string | null} */
    let wrapper = null;
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i] ?? '';
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || KEYWORDS.has(token)) continue;
        if (REDIRECTION.test(token)) {
            if (BARE_REDIRECTION.test(token)) i++;
        } else if (WRAPPERS.has(base(token))) wrapper = base(token);
        // `timeout 5 sh`: the duration comes before the command.
        else if (wrapper === 'timeout' && /^[0-9.]+[smhd]?$/.test(token)) continue;
        else if (wrapper === null || !token.startsWith('-')) return i;
        else if (WRAPPER_VALUES.get(wrapper)?.test(token)) i++;
    }
    return -1;
};
/** @param {readonly string[]} tokens */
const commandWord = (tokens) => tokens[commandAt(tokens)];

/**
 * Commands auto-approve never answers: the prompt is left for the user. Each rule sees one
 * segment's tokens and the whole text. Broad on purpose: a false match only costs a manual answer.
 * @type {readonly NeverRule[]}
 */
export const NEVER_AUTO_APPROVE = [
    // GNU rm takes any unique prefix of a long option: `--rec` is `--recursive`.
    { name: 'rm -r', test: (t) => t.some((x, i) => base(x) === 'rm' && t.slice(i + 1).some((f) => /^--r/.test(f) || /^-[A-Za-z]*[rR]/.test(f))) },
    { name: 'git push', test: (t) => after(t, 'git')?.includes('push') ?? false },
    { name: 'sudo', test: (t) => t.some((x) => base(x) === 'sudo') },
    { name: 'download piped into a shell', test: (t, all) => /\b(?:curl|wget)\b/.test(all) && t.some((x) => SHELLS.has(base(x))) },
    { name: 'download piped into an interpreter', test: (t, all) => /\b(?:curl|wget)\b/.test(all) && t.some((x) => INTERPRETERS.test(base(x))) },
    // Code fed to a shell or interpreter on stdin is hidden from every other rule: `… | base64 -d | sh`, `python3 <<EOF`.
    {
        name: 'piped or heredoc into a shell or interpreter',
        test: (t, all) => {
            const at = commandAt(t);
            const word = t[at];
            if (word === undefined || (!SHELLS.has(base(word)) && !INTERPRETERS.test(base(word)))) return false;
            const piped = new RegExp(`\\|[^|]*(?:^|[\\s/])${base(word).replace(/[.]/g, '\\.')}(?:\\s|$)`).test(all.replace(/["'\\]/g, ''));
            // No script file to run means it reads its code from stdin, wherever that comes from.
            const args = t.slice(at + 1);
            const files = args.filter((f, i) => !f.startsWith('-') && !REDIRECTION.test(f) && !BARE_REDIRECTION.test(args[i - 1] ?? ''));
            return piped || files.length === 0 || args.some((f) => f.startsWith('<') || f === '-' || f === '-s' || /^\/(?:dev|proc)\//.test(f));
        }
    },
    // `python -c '…'` hides its command from every rule below; so does `bash -c` with quotes in the way.
    // Attached code counts too: `-c=…`, `--eval=…`, and `-c'…'`, which reads `-cimport` once the quotes go.
    {
        name: 'shell or interpreter running inline code',
        test: (t) =>
            t.some(
                (x, i) =>
                    (SHELLS.has(base(x)) || INTERPRETERS.test(base(x))) &&
                    t
                        .slice(i + 1)
                        .some((f) => /^-[A-Za-z]*[ceE]/.test(f) || (PRINTERS.test(base(x)) && /^-[A-Za-z]*p/.test(f)) || /^--(?:eval|print|command)(?:=|$)/.test(f) || f === 'eval')
            )
    },
    // Auto-approve must not be able to extend or restart itself, by the CLI or a raw socket write.
    { name: 'auto-approve itself', test: (_t, all) => /auto-?approve/i.test(all.replace(/["'\\]/g, '')) },
    // Nor hand the decision to another provider, which would outlast the window and survive `off`.
    { name: 'kelpi plugin', test: (t) => ['kelpi', 'kelpi_test', 'kelpi.js'].some((tool) => sub(t, tool, ['plugin'])) },
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
        test: (t) => t.some((x, i) => (base(x) === 'chmod' || base(x) === 'chown') && t.slice(i + 1).some((f) => /^--rec/.test(f) || /^-[A-Za-z]*R/.test(f)))
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
    {
        name: 'kubectl write',
        test: (t) =>
            sub(t, 'kubectl', [
                'delete', 'apply', 'replace', 'scale', 'drain', 'patch', 'edit', 'create', 'rollout', 'set', 'annotate', 'label', 'taint', 'cordon',
                'uncordon', 'exec', 'cp', 'expose', 'run', 'autoscale'
            ])
    },
    { name: 'terraform apply or destroy', test: (t) => ['terraform', 'terragrunt', 'tofu'].some((tool) => sub(t, tool, ['apply', 'destroy'])) },
    { name: 'helm install, upgrade or uninstall', test: (t) => sub(t, 'helm', ['install', 'upgrade', 'uninstall', 'delete', 'rollback', 'push']) },
    {
        name: 'aws write',
        test: (t) => {
            const rest = after(t, 'aws');
            if (rest === null) return false;
            if (rest.some((x) => AWS_WRITE.test(x))) return true;
            const s3 = rest.indexOf('s3');
            const verb = s3 < 0 ? undefined : rest[s3 + 1];
            if (verb === 'rm' || verb === 'mv' || verb === 'rb' || (verb === 'sync' && rest.some((f) => f.startsWith('--delete')))) return true;
            if (verb !== 'cp' && verb !== 'sync') return false;
            // An upload or a bucket-to-bucket copy: an s3:// destination, wherever the options put it.
            const args = rest.slice(s3 + 2).filter((f) => f === '-' || !f.startsWith('-'));
            const buckets = args.filter((f) => S3_URL.test(f)).length;
            return buckets > 1 || (buckets === 1 && (!S3_URL.test(args[0] ?? '') || S3_URL.test(args.at(-1) ?? '')));
        }
    },
    // Bash splits an unquoted `$IFS` into words: `rm$IFS-rf$IFS/x` is rm -rf.
    { name: '$IFS expansion', test: (_t, all) => /\$\{?IFS\b/.test(all) },
    // `R=rm; $R -rf x` or `r$M -rf x`: the real command word is only known when the shell runs it.
    { name: 'command word is a variable', test: (t) => /\$/.test(commandWord(t) ?? '') },
    // Likewise `$(echo rm) -rf x` and `` `echo rm` -rf x ``. As an argument (`cd $(…)`) a substitution is fine.
    {
        name: 'command substitution as the command word',
        test: (_t, all) => /(?:^|&&|\|\||[;|&(\n])\s*(?:(?:[A-Za-z_]\w*=\S*|!|if|then|else|elif|do|while|until)\s+)*(?:\$\(|`)/.test(all.replace(/["'\\]/g, ''))
    },
    { name: 'alias or eval', test: (t) => t.some((x) => base(x) === 'alias' || base(x) === 'eval') },
    // `{rm,-rf,/x}` and `/bin/r? -rf x` only become a command once the shell expands them.
    { name: 'brace or glob expansion', test: (t) => t.some((x) => /[{}*?[]/.test(x)) }
];

/**
 * Quotes and backslashes are deleted, not spaced, so r"m" -rf and r\m -rf read as rm -rf, as the shell runs them.
 * The text is also read three more ways, each only adding segments: with the `$` of `$'…'` and `$"…"` dropped
 * (r$'m' is rm), with `2>&1` and `&>` kept whole, and with a substitution's words run into the command around
 * it, the substitution itself left as a `$` on the word before it (git $(echo push), x=$(date) stays an assignment).
 * @param {string} text
 * @returns {string[][]}
 */
const segments = (text) => {
    const dollars = text.replace(/\$(?=["'])/g, '');
    const redirections = dollars.replace(/([<>])&|&(?=>)/g, '$1');
    const substitutions = redirections.replace(/\$\(/g, '$ ').replace(/\)/g, ' ').replace(/`([^`]*)`?/g, '$ $1 ');
    return [...new Set([dollars, text, redirections, substitutions])].flatMap((form) =>
        form
            .replace(/["'\\]/g, '')
            .split(/&&|\|\||[;|&\n`]|\$\(|[()]/)
            .map((segment) => segment.trim().split(/\s+/).filter(Boolean))
            .filter((tokens) => tokens.length > 0)
    );
};

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
    if (typeof command !== 'string' || !command.trim()) return { allow: false, reason: 'no command' };
    if (/[\r\n]/.test(command)) return { allow: false, reason: 'multi-line command' };
    const rule = neverAutoApprove(command);
    return rule === null ? { allow: true } : { allow: false, reason: 'never auto-approved: ' + rule };
}
