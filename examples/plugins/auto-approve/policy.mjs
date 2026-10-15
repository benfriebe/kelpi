/**
 * The commands auto-approve never answers, and the provider's answer for one Bash command. Pure:
 * the backend judges the command Claude's PermissionRequest hook hands it with these. Plain ESM
 * with no imports, so the example installs byte for byte.
 */

/**
 * @typedef {object} NeverRule
 * @property {string} name
 * @property {(tokens: readonly string[], all: string) => boolean} test
 * @property {boolean} [whole] Reads only the whole text, so it runs once per reading of it, not once per segment.
 */

/** @typedef {{ allow: true } | { allow: false, reason: string }} Judgement */

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const INTERPRETERS = /^(?:python[0-9.]*|node|nodejs|perl|ruby|php|deno|bun)$/;
const AWS_WRITE = /^(?:delete|put|create|update|terminate|modify|remove)-/;
const S3_URL = /^s3:\/\//i;
const S3_VERBS = /^(?:cp|mv|sync|rm|rb|mb|website)$/;
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
const KELPI = new Set(['kelpi', 'kelpi_test', 'kelpi.js']);
/** `$(` or a backtick opening a word, or right after a separator inside one: `x;$(echo rm)`. */
const SUBSTITUTION = /^(?:\$\(|`)/;
const SUBSTITUTION_AFTER = /[;&|(](?:\$\(|`)/;
/** A separator inside a word, then a `NAME=value` or a keyword ending the word, or nothing: `x;A=1`, `x;then`, `x;`. */
const PREFIX_AFTER = /[;&|(](?:[A-Za-z_]\w*=|(?:!|if|then|else|elif|do|while|until)?$)/;
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
 * Whether a command substitution stands where a command word goes, past any `NAME=value` and keyword
 * prefixes: `$(echo rm) -rf x`, `X=1 $(…)`, `then \`echo rm\``. Read once from the last word back, so a
 * word holding thousands of separators costs only its length.
 * @param {string} all
 */
const substitutionAsCommand = (all) => {
    const words = all.replace(/["'\\]/g, '').replace(/\n/g, ' ; ').trim().split(/\s+/);
    // Whether the words after this one start with a substitution, past any prefixes.
    let next = false;
    for (let i = words.length - 1; i >= 0; i--) {
        const word = words[i] ?? '';
        if (SUBSTITUTION_AFTER.test(word) || (next && PREFIX_AFTER.test(word))) return true;
        next = SUBSTITUTION.test(word) || (next && (/^[A-Za-z_]\w*=/.test(word) || KEYWORDS.has(word)));
    }
    return next;
};
/**
 * Whether the kelpi CLI's verb is `plugin`. The verb is its first word, but a word after a flag is
 * read as the verb too, in case the flag takes a value: `kelpi --json plugin list`.
 * @param {readonly string[]} tokens
 */
const kelpiPlugin = (tokens) =>
    tokens.some((x, i) => {
        if (!KELPI.has(base(x))) return false;
        for (let j = i + 1; j < tokens.length; j++) {
            const word = tokens[j] ?? '';
            // The next kelpi token reads its own words, so each word is read once.
            if (KELPI.has(base(word))) return false;
            // A verb only known when the shell runs: `kelpi $(echo plugin)`, `kelpi $V`.
            if (word === 'plugin' || word.includes('$')) return true;
            // The shell drops redirections before kelpi sees its words: `kelpi 2>/dev/null plugin`.
            if (REDIRECTION.test(word)) {
                if (BARE_REDIRECTION.test(word)) j++;
                continue;
            }
            if (!word.startsWith('-') && !(tokens[j - 1] ?? '').startsWith('-')) return false;
        }
        return false;
    });

/**
 * Commands auto-approve never answers: the prompt is left for the user. Each rule sees one
 * segment's tokens and the whole text, or with `whole`, only the text. Broad on purpose: a false
 * match only costs a manual answer.
 * @type {readonly NeverRule[]}
 */
export const NEVER_AUTO_APPROVE = [
    // GNU rm takes any unique prefix of a long option: `--rec` is `--recursive`. The words after the
    // first rm hold any later rm's flags too, so one pass serves (likewise chmod and the interpreters).
    { name: 'rm -r', test: (t) => after(t, 'rm')?.some((f) => /^--r/.test(f) || /^-[A-Za-z]*[rR]/.test(f)) ?? false },
    { name: 'git push', test: (t) => after(t, 'git')?.includes('push') ?? false },
    { name: 'sudo', test: (t) => t.some((x) => ['sudo', 'doas', 'pkexec'].includes(base(x))) },
    // The segment first: the whole text is only read for a segment that runs a shell or interpreter.
    { name: 'download piped into a shell', test: (t, all) => t.some((x) => SHELLS.has(base(x))) && /\b(?:curl|wget)\b/.test(all) },
    { name: 'download piped into an interpreter', test: (t, all) => t.some((x) => INTERPRETERS.test(base(x))) && /\b(?:curl|wget)\b/.test(all) },
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
        test: (t) => {
            const i = t.findIndex((x) => SHELLS.has(base(x)) || INTERPRETERS.test(base(x)));
            const p = t.findIndex((x) => PRINTERS.test(base(x)));
            return (
                (i >= 0 && t.slice(i + 1).some((f) => /^-[A-Za-z]*[ceE]/.test(f) || /^--(?:eval|print|command)(?:=|$)/.test(f) || f === 'eval')) ||
                (p >= 0 && t.slice(p + 1).some((f) => /^-[A-Za-z]*p/.test(f)))
            );
        }
    },
    // `env -S'rm -rf x'` runs its attached string as a command line, which reads `-Srm` once the quotes go.
    // GNU env takes any unique prefix of a long option too: `--s` is `--split-string`.
    { name: 'env -S', test: (t) => after(t, 'env')?.some((f) => /^-[A-Za-z0-9]*S/.test(f) || /^--s/.test(f)) ?? false },
    // Auto-approve must not be able to extend or restart itself, by the CLI or a raw socket write.
    { name: 'auto-approve itself', whole: true, test: (_t, all) => /auto-?approve/i.test(all.replace(/["'\\]/g, '')) },
    // Nor hand the decision to another provider, which would outlast the window and survive `off`.
    { name: 'kelpi plugin', test: kelpiPlugin },
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
        test: (t) => ['chmod', 'chown'].some((tool) => after(t, tool)?.some((f) => /^--rec/.test(f) || /^-[A-Za-z]*R/.test(f)) ?? false)
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
                'uncordon', 'exec', 'cp', 'expose', 'run', 'autoscale', 'debug', 'attach', 'port-forward'
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
            // The verb may come after options: `aws s3 --region x cp …`.
            const s3 = rest.indexOf('s3');
            const at = s3 < 0 ? -1 : rest.findIndex((x, i) => i > s3 && S3_VERBS.test(x));
            const verb = rest[at];
            if (verb === undefined) return false;
            if (verb !== 'cp' && verb !== 'sync') return true;
            if (verb === 'sync' && rest.some((f) => f.startsWith('--delete'))) return true;
            // An upload or a bucket-to-bucket copy: an s3:// destination, wherever the options put it.
            const args = rest.slice(at + 1).filter((f) => f === '-' || !f.startsWith('-'));
            const buckets = args.filter((f) => S3_URL.test(f)).length;
            return buckets > 1 || (buckets === 1 && (!S3_URL.test(args[0] ?? '') || S3_URL.test(args.at(-1) ?? '')));
        }
    },
    // Bash splits an unquoted `$IFS` into words: `rm$IFS-rf$IFS/x` is rm -rf.
    { name: '$IFS expansion', whole: true, test: (_t, all) => /\$\{?IFS\b/.test(all) },
    // `R=rm; $R -rf x` or `r$M -rf x`: the real command word is only known when the shell runs it.
    { name: 'command word is a variable', test: (t) => /\$/.test(commandWord(t) ?? '') },
    // Likewise `$(echo rm) -rf x` and `` `echo rm` -rf x ``. As an argument (`cd $(…)`) a substitution is fine.
    { name: 'command substitution as the command word', whole: true, test: (_t, all) => substitutionAsCommand(all) },
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
 * The never-auto-approve rule `command` breaks, or null: for the first segment that breaks any, the
 * first in list order. A wrapped command is also read with its lines joined.
 * @param {string} command
 * @returns {string | null}
 */
export function neverAutoApprove(command) {
    if (!command) return null;
    const lines = command.split('\n').map((line) => line.trim());
    for (const text of new Set([command, lines.join(' '), lines.join('')])) {
        // Once per reading, not once per segment: a long command can hold thousands of segments.
        const whole = NEVER_AUTO_APPROVE.map((rule) => rule.whole === true && rule.test([], text));
        for (const tokens of segments(text)) {
            const rule = NEVER_AUTO_APPROVE.find((candidate, i) => (candidate.whole ? whole[i] : candidate.test(tokens, text)));
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
