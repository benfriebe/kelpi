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

/** Longer than this is left for the user unread, so judging stays well inside the daemon's 2 second deadline. */
const MAX_COMMAND = 16_384;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'yash', 'fish', 'csh', 'tcsh', 'pwsh']);
const INTERPRETERS = /^(?:python[0-9.]*|node|nodejs|perl|ruby|php|deno|bun)$/;
const AWS_WRITE = /^(?:(?:delete|put|create|update|terminate|modify|remove|stop|start|reboot|send|run|invoke|execute|attach|detach|associate|disassociate|restore|reset)-|(?:invoke|deploy)$)/;
const S3_URL = /^s3:\/\//i;
const S3_VERBS = /^(?:cp|mv|sync|rm|rb|mb|website)$/;
const WRAPPERS = new Set(['command', 'exec', 'env', 'nohup', 'time', 'builtin', 'nice', 'stdbuf', 'timeout', 'caffeinate']);
/** Words that come before a command without being it: `then $R -rf x`. */
const KEYWORDS = new Set(['!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'coproc']);
/** A wrapper's options that take the next word as their value: `env -u NAME`, `exec -a NAME`, `time -o FILE`. */
const WRAPPER_VALUES = new Map([
    ['env', /^-[A-Za-z0-9]*[uCP]$|^--(?:unset|chdir)$/],
    ['exec', /^-[A-Za-z]*a$/],
    ['time', /^-[A-Za-z]*[fo]$|^--(?:format|output)$/],
    ['nice', /^-[A-Za-z]*n$|^--adjustment$/],
    ['stdbuf', /^-[A-Za-z]*[ioe]$|^--(?:input|output|error)$/],
    ['timeout', /^-[A-Za-z]*[sk]$|^--(?:signal|kill-after)$/],
    ['caffeinate', /^-[A-Za-z]*[tw]$/]
]);
/** `2>/dev/null`, `</dev/null`, `>out`, `2>1` (how `2>&1` reads whole); a bare `>` or `2>` takes the next word as its target. */
const REDIRECTION = /^(?:[0-9]*|&)[<>]/;
const BARE_REDIRECTION = /^(?:[0-9]*|&)[<>][<>&|-]*$/;
/**
 * A redirection operator glued to the word before it (`kelpi>/dev/null`, `cat<in`, `a&>b`), but not
 * a file descriptor's own digits (`2>&1`): the operator is spaced off, its target stays attached.
 */
const GLUED = /(?=&?[<>])(?<=[^\s<>&])(?<!(?:^|[\s;&|()])[0-9]+)&?(?:<<<|<<-?|<>|>>|>\||[<>])/g;
const KELPI = new Set(['kelpi', 'kelpi_test', 'kelpi.js', 'nex', 'nex.js']);
const KELPI_PLUGIN = [/^plugin$/];
const KELPI_PANE_SEND = [/^pane$/, /^send/];
/** Words with a rule here, so what they are told must be readable: `xargs rm`, `rm $F`. */
const RULED = new Set([
    'rm', 'git', 'sudo', 'doas', 'pkexec', 'chmod', 'chown', 'find', 'gfind', 'rsync', 'dd', 'gh', 'npm', 'pnpm', 'yarn', 'kubectl', 'terraform',
    'terragrunt', 'tofu', 'helm', 'aws', 'claude', 'codex', 'env', 'xargs', 'gxargs', 'diskutil'
]);
/**
 * Claude's and Codex's own settings: `settings` in any `.claude` or `.claude_1` directory, anything at
 * home named for Claude (`~/.claude/`, `~/.claude_1/`, `~/.claude.json`), `.codex`, and the variables that move them.
 */
const AGENT_SETTINGS =
    /\.claude[^/]*\/settings|\.claude\.json|(?:~[^/]*|\$\{?HOME\}?|\/(?:Users|home)\/[^/]+|\/root|\/var\/root)\/\.claude|(?:^|[/=<>])\.codex(?:[/.]|$)|CLAUDE_CONFIG_DIR|CODEX_HOME/;
/** Commands that may name those settings and still only read them. */
const READERS = new Set(['cat', 'ls', 'grep', 'jq']);
/** Claude permission modes that ask no less than the default does. */
const ASKING_MODES = /^(?:default|plan)$/;
/** `$(` or a backtick opening a word, or right after a separator inside one: `x;$(echo rm)`. */
const SUBSTITUTION = /^(?:\$\(|`)/;
const SUBSTITUTION_AFTER = /[;&|(](?:\$\(|`)/;
/** A separator inside a word, then a `NAME=value` or a keyword ending the word, or nothing: `x;A=1`, `x;then`, `x;`. */
const PREFIX_AFTER = /[;&|(](?:[A-Za-z_]\w*=|(?:!|if|then|else|elif|do|while|until)?$)/;
/** @param {string} token */
const base = (token) => token.split('/').pop() ?? token;
/** @param {string} word */
const ruled = (word) => RULED.has(word) || KELPI.has(word) || SHELLS.has(word) || INTERPRETERS.test(word) || /^(?:mkfs|newfs)/.test(word);
/** @param {string} form */
const spaced = (form) => form.replace(GLUED, ' $&');
/**
 * @param {string} letters
 * @param {string} [more]
 */
const inline = (letters, more = '') => new RegExp(`^-[A-Za-z]*[${letters}]|^--(?:eval|print|command)(?:=|$)|^eval$${more}`);
/**
 * The flags that carry code, per shell or interpreter. Each keeps `-c`, `-e`, `-E`, `--eval`, `--print`,
 * `--command` and `eval`, the one class all of them were once read with, so none is refused less.
 * @type {ReadonlyArray<readonly [(word: string) => boolean, RegExp]>}
 */
const INLINE = [
    [(word) => SHELLS.has(word), inline('ceE')],
    [(word) => /^python[0-9.]*$/.test(word), inline('ceE')],
    [(word) => word === 'ruby', inline('ceE')],
    // `perl -M'strict;system …'` splices its value into a `use` line.
    [(word) => word === 'perl', inline('ceEmM')],
    // `-r` (`--run`) runs its code; `-R`, `-B` and `-E` (`--process-code`, `--process-begin`, `--process-end`) run it per input line, before and after.
    [(word) => word === 'php', inline('ceErRBE', '|^--(?:run|process-(?:begin|code|end))(?:=|$)')],
    // `-p` evaluates and prints its argument; `--import=data:…` runs code held in the word itself.
    [(word) => /^(?:node|nodejs|bun)$/.test(word), inline('ceEp', '|data:')],
    [(word) => word === 'deno', inline('ceE', '|data:')]
];
/**
 * The last reading's answer, so a rule that needs the whole text once per segment works it out once per reading.
 * @template T
 * @param {(all: string) => T} read
 * @returns {(all: string) => T}
 */
const perReading = (read) => {
    /** @type {string | null} */
    let last = null;
    /** @type {T} */
    let value;
    return (all) => {
        if (all !== last) {
            value = read(all);
            last = all;
        }
        return value;
    };
};
const downloads = perReading((all) => /\b(?:curl|wget)\b/.test(all));
/** zsh's `=(…)` process substitution, which splits off as a bare `=`: `source =(curl …)`. */
const zshSubstitution = perReading((all) => /(?:^|[\s;&|(])=\(/.test(all));
/** The words standing in a pipeline stage after the first, by name: `… | base64 -d | sh` holds `sh`. */
const pipedWords = perReading((all) => {
    const stripped = all.replace(/["'\\]/g, '');
    /** @type {Set<string>} */
    const words = new Set();
    for (const form of new Set([stripped, spaced(stripped)])) {
        for (const stage of form.split('|').slice(1)) for (const word of stage.split(/\s+/)) words.add(base(word));
    }
    return words;
});
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
/** @param {string} f A short option cluster or a long option that forces: `-f`, `-fd`, `--force`, `--fo`. */
const forced = (f) => /^--f/.test(f) || /^-[A-Za-z]*f/.test(f);
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
 * Whether a kelpi CLI command's verbs are `path`: `plugin`, or `pane` then `send` or `send-key`. A verb
 * is the first word, but a word after a flag is read as the verb too, in case the flag takes a value:
 * `kelpi --json plugin list`.
 * @param {readonly string[]} tokens
 * @param {readonly RegExp[]} path
 */
const kelpiVerbs = (tokens, path) =>
    tokens.some((x, i) => {
        if (!KELPI.has(base(x))) return false;
        // How many of the verbs each reading so far has matched.
        let levels = new Set([0]);
        for (let j = i + 1; j < tokens.length && levels.size > 0; j++) {
            const word = tokens[j] ?? '';
            // The next kelpi token reads its own words, so each word is read once.
            if (KELPI.has(base(word))) return false;
            // A verb only known when the shell runs: `kelpi $(echo plugin)`, `kelpi $V`.
            if (word.includes('$')) return true;
            // The shell drops redirections before kelpi sees its words: `kelpi 2>/dev/null plugin`.
            if (REDIRECTION.test(word)) {
                if (BARE_REDIRECTION.test(word)) j++;
                continue;
            }
            const optional = word.startsWith('-') || (tokens[j - 1] ?? '').startsWith('-');
            /** @type {Set<number>} */
            const next = new Set();
            for (const level of levels) {
                if (path[level]?.test(word)) {
                    if (level + 1 === path.length) return true;
                    next.add(level + 1);
                }
                if (optional) next.add(level);
            }
            levels = next;
        }
        return false;
    });
/**
 * The words after git's verb when the verb is `verb`, or null. The verb is the first word that is not
 * an option or a redirection, but a word after an option is read as the verb too, in case the option
 * takes a value: `git -C repo checkout .` gives `.`.
 * @param {readonly string[]} tokens
 * @param {string} verb
 * @returns {readonly string[] | null}
 */
const gitVerb = (tokens, verb) => {
    const rest = after(tokens, 'git');
    if (rest === null) return null;
    for (let j = 0; j < rest.length; j++) {
        const word = rest[j] ?? '';
        if (word === verb) return rest.slice(j + 1);
        if (REDIRECTION.test(word)) {
            if (BARE_REDIRECTION.test(word)) j++;
            continue;
        }
        if (!word.startsWith('-') && !(rest[j - 1] ?? '').startsWith('-')) return null;
    }
    return null;
};
/**
 * Whether xargs runs a word with a rule here, in any case. Its own options come first; a word after one is read as
 * the command too, in case the option takes a value: `xargs -n 1 rm`.
 * @param {readonly string[]} tokens
 */
const xargsRuled = (tokens) => {
    const rest = after(tokens, 'xargs') ?? after(tokens, 'gxargs');
    if (rest === null) return false;
    for (let j = 0; j < rest.length; j++) {
        const word = rest[j] ?? '';
        if (word.includes('$')) return true;
        if (REDIRECTION.test(word)) {
            if (BARE_REDIRECTION.test(word)) j++;
            continue;
        }
        if (word.startsWith('-')) continue;
        const name = base(word).toLowerCase();
        if (ruled(name) || WRAPPERS.has(name)) return true;
        if (!(rest[j - 1] ?? '').startsWith('-')) return false;
    }
    return false;
};

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
    // The segment first: the whole text is only read for a segment that runs a shell or interpreter, once per reading.
    { name: 'download piped into a shell', test: (t, all) => t.some((x) => SHELLS.has(base(x))) && downloads(all) },
    { name: 'download piped into an interpreter', test: (t, all) => t.some((x) => INTERPRETERS.test(base(x))) && downloads(all) },
    // Code fed to a shell or interpreter on stdin is hidden from every other rule: `… | base64 -d | sh`, `python3 <<EOF`.
    {
        name: 'piped or heredoc into a shell or interpreter',
        test: (t, all) => {
            const at = commandAt(t);
            const word = t[at];
            if (word === undefined) return false;
            const args = t.slice(at + 1);
            /** @param {string} f A process substitution, which splits off as a bare `<`, or as a bare `=` for zsh's `=(…)`. */
            const substituted = (f) => f.startsWith('<') || (f === '=' && zshSubstitution(all));
            // `source` and `.` read stdin from `/dev/stdin`, `-`, or a process substitution.
            if (word === 'source' || word === '.') return args.some((f) => f === '-' || substituted(f) || /^\/(?:dev|proc)\//.test(f));
            if (!SHELLS.has(base(word)) && !INTERPRETERS.test(base(word))) return false;
            // No script file to run means it reads its code from stdin, wherever that comes from.
            const files = args.filter((f, i) => !f.startsWith('-') && !REDIRECTION.test(f) && !BARE_REDIRECTION.test(args[i - 1] ?? ''));
            return (
                pipedWords(all).has(base(word)) ||
                files.length === 0 ||
                args.some((f) => substituted(f) || f === '-' || f === '-s' || /^\/(?:dev|proc)\//.test(f))
            );
        }
    },
    // A download that is then sourced runs as one piped in does: `curl -o a.sh …; . ./a.sh`.
    { name: 'download then sourced', test: (t, all) => ['source', '.'].includes(commandWord(t) ?? '') && downloads(all) },
    // `python -c '…'` hides its command from every rule below; so does `bash -c` with quotes in the way.
    // Attached code counts too: `-c=…`, `--eval=…`, and `-c'…'`, which reads `-cimport` once the quotes go.
    {
        name: 'shell or interpreter running inline code',
        test: (t) => {
            const words = t.map(base);
            return INLINE.some(([is, flag]) => {
                const i = words.findIndex(is);
                return i >= 0 && t.slice(i + 1).some((f) => flag.test(f));
            });
        }
    },
    // `env -S'rm -rf x'` runs its attached string as a command line, which reads `-Srm` once the quotes go.
    // GNU env takes any unique prefix of a long option too: `--s` is `--split-string`.
    { name: 'env -S', test: (t) => after(t, 'env')?.some((f) => /^-[A-Za-z0-9]*S/.test(f) || /^--s/.test(f)) ?? false },
    // Auto-approve must not be able to extend or restart itself, by the CLI or a raw socket write.
    { name: 'auto-approve itself', whole: true, test: (_t, all) => /auto-?approve/i.test(all.replace(/["'\\]/g, '')) },
    // Nor hand the decision to another provider, which would outlast the window and survive `off`.
    { name: 'kelpi plugin', test: (t) => kelpiVerbs(t, KELPI_PLUGIN) },
    // Nor rewrite Claude's and Codex's hooks, `PermissionRequest` included: `kelpi install-hooks --command x` makes them run x.
    { name: 'kelpi install-hooks', test: (t) => kelpiVerbs(t, [/^install-hooks$/]) },
    { name: 'mkfs', test: (t) => t.some((x) => /^(?:mkfs(?:\.|$)|newfs)/.test(base(x))) },
    { name: 'dd of=', test: (t) => after(t, 'dd')?.some((f) => f.startsWith('of=')) ?? false },
    {
        name: 'find -delete or -exec rm',
        test: (t) => {
            const rest = after(t, 'find') ?? after(t, 'gfind');
            return rest !== null && (rest.includes('-delete') || rest.some((x, i) => ['-exec', '-execdir', '-ok', '-okdir'].includes(x) && base(rest[i + 1] ?? '') === 'rm'));
        }
    },
    // git takes any unique prefix of a long option: `--f` is `--force`, `--h` is `--hard` (`--help` is not).
    { name: 'git clean -f', test: (t) => { const rest = after(t, 'git'); return rest !== null && rest.includes('clean') && rest.some(forced); } },
    { name: 'git reset --hard', test: (t) => { const rest = after(t, 'git'); return rest !== null && rest.includes('reset') && rest.some((f) => /^--h(?!elp$)/.test(f)); } },
    {
        name: 'git checkout -- . or git restore .',
        test: (t) => {
            const rest = after(t, 'git');
            return rest !== null && ((rest.includes('checkout') && rest.includes('--') && rest.includes('.')) || (rest.includes('restore') && rest.includes('.')));
        }
    },
    {
        // Each overwrites uncommitted work: any restore, a forced or discarding switch, and a checkout
        // that forces, names paths (`.`, `--`, a pathspec file) or a ref and then a path.
        name: 'git checkout, restore or switch discarding changes',
        test: (t) => {
            if (gitVerb(t, 'restore') !== null || gitVerb(t, 'switch')?.some((f) => forced(f) || /^--di/.test(f))) return true;
            const args = gitVerb(t, 'checkout');
            if (args === null) return false;
            // `.`, `./` and every `:` pathspec (`:/`, `:(top)`) name the whole tree; a ref never starts with `:`.
            if (args.some((f) => forced(f) || f === '--' || /^(?:\.\/*|:.*)$/.test(f) || /^--pa/.test(f))) return true;
            // The value of `-b`, `-B` or `--orphan` names the new branch, and a redirection's target is no path.
            const named = args.filter((f, j) => !f.startsWith('-') && !REDIRECTION.test(f) && !/^(?:-[bB]|--orphan)$/.test(args[j - 1] ?? '') && !BARE_REDIRECTION.test(args[j - 1] ?? ''));
            return named.length > 1;
        }
    },
    { name: 'rsync --delete', test: (t) => after(t, 'rsync')?.some((f) => /^--del/.test(f) || /^--remove-s/.test(f)) ?? false },
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
        // A field (`-f`, `-F`) or `--input` makes the call a POST unless the method says GET.
        name: 'gh api write',
        test: (t) => {
            const rest = after(t, 'gh');
            if (rest === null || !rest.includes('api')) return false;
            const methods = rest.flatMap((f, i) => {
                const attached = /^(?:-X=?|--method=)(.+)$/.exec(f);
                return attached !== null ? [attached[1] ?? ''] : ['-X', '--method'].includes(f) ? [rest[i + 1] ?? ''] : [];
            });
            if (methods.some((m) => /^(?:PUT|POST|PATCH)$/i.test(m))) return true;
            return !methods.some((m) => /^GET$/i.test(m)) && rest.some((f) => /^-[fF]/.test(f) || /^--(?:field|raw-field|input)(?:=|$)/.test(f));
        }
    },
    {
        name: 'gh pr merge or gh repo delete',
        test: (t) => {
            const rest = after(t, 'gh');
            return rest !== null && ((rest.includes('pr') && rest.includes('merge')) || (rest.includes('repo') && rest.includes('delete')));
        }
    },
    { name: 'npm publish', test: (t) => ['npm', 'yarn', 'pnpm', 'bun'].some((tool) => sub(t, tool, ['publish'])) },
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
    // The Mac's file system ignores case, so `RM -rf x` runs rm. Only the command word: `ls Bash` is fine.
    {
        name: 'command word in another case',
        test: (t) => {
            const word = base(commandWord(t) ?? '');
            const name = word.toLowerCase();
            return word !== name && (ruled(name) || WRAPPERS.has(name) || name === 'source');
        }
    },
    { name: 'alias or eval', test: (t) => t.some((x) => base(x) === 'alias' || base(x) === 'eval') },
    // `{rm,-rf,/x}` and `/bin/r? -rf x` only become a command once the shell expands them.
    { name: 'brace or glob expansion', test: (t) => t.some((x) => /[{}*?[]/.test(x)) },
    // A session started like this approves for itself, past the window and `off`.
    {
        name: 'claude permission flags',
        test: (t) => {
            const rest = after(t, 'claude');
            return (
                rest !== null &&
                (rest[0] === 'config' ||
                    rest.some(
                        (f, i) =>
                            /^--(?:allow-)?dangerously/.test(f) ||
                            /^--allowed-?tools(?:=|$)/i.test(f) ||
                            /^--(?:settings|permission-prompt-tool)(?:=|$)/.test(f) ||
                            (f === '--permission-mode' && !ASKING_MODES.test(rest[i + 1] ?? '')) ||
                            (f.startsWith('--permission-mode=') && !ASKING_MODES.test(f.slice('--permission-mode='.length)))
                    ))
            );
        }
    },
    {
        name: 'codex permission flags',
        test: (t) =>
            after(t, 'codex')?.some(
                (f, i, rest) =>
                    /^--(?:dangerously|yolo|full-auto)/.test(f) ||
                    f.includes('danger-full-access') ||
                    /^(?:--ask-for-approval=|-a=?)never$/.test(f) ||
                    (/^(?:-a|--ask-for-approval)$/.test(f) && rest[i + 1] === 'never') ||
                    (/^(?:-c|--config)$/.test(f) && /approval|sandbox/.test(rest[i + 1] ?? '')) ||
                    /^(?:-c|--config=).*(?:approval|sandbox)/.test(f)
            ) ?? false
    },
    // Any mention but a plain read: `sed -i`, `tee`, `cp`, a redirection or `cd` there and a write after.
    {
        name: 'agent settings write',
        test: (t) => t.some((x) => AGENT_SETTINGS.test(x)) && !(READERS.has(base(commandWord(t) ?? '')) && !t.some((x) => /[<>]/.test(x)))
    },
    // Typing into another pane can answer a prompt left there for the user.
    { name: 'kelpi pane send', test: (t) => kelpiVerbs(t, KELPI_PANE_SEND) },
    { name: 'xargs into a ruled command', test: xargsRuled },
    { name: 'diskutil erase', test: (t) => after(t, 'diskutil')?.some((f) => /^(?:erase|zero|secureErase|reformat|partitionDisk|delete)/i.test(f)) ?? false },
    // `F=-rf; rm $F dir` and `git pu$()sh`: what a ruled command is told is only known when the shell runs it.
    {
        name: 'expansion in a ruled command',
        test: (t) => {
            const at = commandAt(t);
            const from = at < 0 ? -1 : t.findIndex((x, i) => i <= at && (i === at || WRAPPERS.has(base(x))) && ruled(base(x)));
            return from >= 0 && t.slice(from + 1).some((x) => /[$`]/.test(x));
        }
    }
];

/**
 * Quotes and backslashes are deleted, not spaced, so r"m" -rf and r\m -rf read as rm -rf, as the shell runs them.
 * The text is also read three more ways, each only adding segments: with the `$` of `$'…'` and `$"…"` dropped
 * (r$'m' is rm), with `2>&1`, `&>` and `>|` kept whole, and with a substitution's words run into the command around
 * it, the substitution itself left as a `$` on the word before it (git $(echo push), x=$(date) stays an assignment).
 * Each reading is read again with a redirection glued to a word spaced off it: `kelpi>/dev/null plugin`.
 * @param {string} text
 * @returns {string[][]}
 */
const segments = (text) => {
    const dollars = text.replace(/\$(?=["'])/g, '');
    // `>|` is one operator, not a pipe: `rm >| /dev/null -rf x` is rm -rf.
    const redirections = dollars.replace(/([<>])&|&(?=>)/g, '$1').replace(/>\|/g, '>');
    const substitutions = redirections.replace(/\$\(/g, '$ ').replace(/\)/g, ' ').replace(/`([^`]*)`?/g, '$ $1 ');
    const forms = [dollars, text, redirections, substitutions];
    return [...new Set([...forms, ...forms.map(spaced)])].flatMap((form) =>
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
 * only looks harmless. One longer than 16 KiB is never read at all.
 * @param {unknown} command
 * @returns {Judgement}
 */
export function judgeCommand(command) {
    if (typeof command !== 'string' || !command.trim()) return { allow: false, reason: 'no command' };
    if (command.length > MAX_COMMAND) return { allow: false, reason: 'command too long' };
    if (/[\r\n]/.test(command)) return { allow: false, reason: 'multi-line command' };
    const rule = neverAutoApprove(command);
    return rule === null ? { allow: true } : { allow: false, reason: 'never auto-approved: ' + rule };
}
