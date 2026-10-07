/**
 * Shell integration: make an interactive zsh report its working directory (OSC 7).
 *
 * A pane's `workingDirectory` only moves when the shell reports it (terminal-surface.md §7.2),
 * and a split copies it. Stock zsh reports nothing: Terminal.app's `/etc/zshrc_Apple_Terminal`
 * only runs under Terminal.app, and Ghostty, iTerm2 and Kitty each inject their own. Without
 * one, a split opened in `~` however far the shell had `cd`ed, and `pane list`, the footer and
 * repo auto-detect all saw the spawn directory forever.
 *
 * The injection is Ghostty's and Kitty's: zsh is started with `ZDOTDIR` pointing at a directory
 * the daemon owns, so zsh reads OUR `.zshenv` first. That file puts `ZDOTDIR` back the way it
 * found it (the original travels in `KELPI_ZSH_ZDOTDIR`), sources the user's own `.zshenv`,
 * and in an interactive shell installs the OSC 7 hooks. zsh then reads `.zprofile`, `.zshrc`
 * and `.zlogin` from the user's `ZDOTDIR` exactly as it would have. Nothing the user's files
 * see differs, and the hooks only append to `precmd_functions` / `chpwd_functions`.
 *
 * The file is written by the daemon under its data directory rather than shipped in the
 * bundle, so a dev daemon, a packaged one and a sandbox each have it without a packaging
 * step, and a shell kept by the terminal host across an app update never reads a path inside
 * a bundle that was replaced (it only reads the file once, at startup, anyway).
 *
 * Only zsh, the macOS default, for now. bash and fish need different injections.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Daemon env: `0` stops the injection (the shell then reports nothing unless its rc does). */
export const SHELL_INTEGRATION_ENV = 'KELPID_SHELL_INTEGRATION';

/** The user's own `ZDOTDIR`, carried past our `.zshenv` (unset = they had none). */
export const ZSH_ZDOTDIR_ENV = 'KELPI_ZSH_ZDOTDIR';

export interface ShellIntegration {
    /** The directory zsh is pointed at with `ZDOTDIR`; holds our `.zshenv`. */
    readonly zshDir: string;
}

/**
 * Read by zsh in place of the user's `~/.zshenv` (or `$ZDOTDIR/.zshenv`).
 *
 * Every builtin is quoted so a user alias defined by their `.zshenv` cannot shadow it.
 *
 * The report runs at every prompt and on every `cd`: `precmd` catches a directory a command
 * changed, and `chpwd` catches the ones no prompt follows (`cd x && server`, a zle widget that
 * `cd`s and redraws). It stays quiet in a subshell, whose `cd` is not the shell's, and when
 * stdout is not the terminal, where the bytes would land in a file or a capture instead.
 *
 * The path is percent-encoded byte by byte (`no_multibyte`), because the daemon decodes it as
 * a `file://` URL (`parseOsc7`): a literal `%20` in a directory name must survive the trip.
 */
export const ZSHENV = `# Kelpi shell integration for zsh. Written by kelpid; edits are overwritten.
#
# Kelpi starts zsh with ZDOTDIR pointing here. This file puts ZDOTDIR back, sources
# your own .zshenv, and has an interactive shell report its working directory to
# Kelpi (OSC 7) so a split opens where you are. Set KELPID_SHELL_INTEGRATION=0 in
# the daemon's environment to turn it off.

if [[ -n "\${KELPI_ZSH_ZDOTDIR+X}" ]]; then
    'builtin' 'export' ZDOTDIR="$KELPI_ZSH_ZDOTDIR"
    'builtin' 'unset' 'KELPI_ZSH_ZDOTDIR'
else
    'builtin' 'unset' 'ZDOTDIR'
fi

{
    # zsh reads an unset ZDOTDIR as $HOME.
    'builtin' 'typeset' _kelpi_file="\${ZDOTDIR-$HOME}/.zshenv"
    [[ ! -r "$_kelpi_file" ]] || 'builtin' 'source' '--' "$_kelpi_file"
} always {
    'builtin' 'unset' '_kelpi_file'
    if [[ -o interactive ]]; then
        _kelpi_report_pwd() {
            'builtin' 'emulate' -L zsh -o extended_glob -o no_multibyte
            (( ZSH_SUBSHELL == 0 )) && [[ -t 1 ]] || 'builtin' 'return' 0
            'builtin' 'local' -a match mbegin mend
            'builtin' 'local' url_path="\${PWD//(#b)([^A-Za-z0-9\\/._~-])/%\${(l:2::0:)$(( [##16] #match ))}}"
            'builtin' 'print' -rn -- $'\\e]7;file://'"$HOST$url_path"$'\\a'
        }
        'builtin' 'autoload' -Uz -- add-zsh-hook
        add-zsh-hook precmd _kelpi_report_pwd
        add-zsh-hook chpwd _kelpi_report_pwd
    fi
}
`;

/**
 * Write the integration files under `root` (idempotent; a file already holding this build's
 * content is left alone). Throws when the directory cannot be written: the caller reports it
 * and spawns without the integration.
 */
export function installShellIntegration(root: string): ShellIntegration {
    const zshDir = path.join(root, 'zsh');
    writeIfChanged(path.join(zshDir, '.zshenv'), ZSHENV);
    return { zshDir };
}

/**
 * Point an interactive zsh at the integration. Mutates `env`, which is the spawn's own copy.
 * Any other shell, and zsh hosting a command (`-c`), is left alone.
 */
export function applyShellIntegration(
    shellPath: string,
    env: Record<string, string>,
    integration: ShellIntegration
): void {
    if (path.basename(shellPath) !== 'zsh') return;
    const original = env['ZDOTDIR'];
    delete env[ZSH_ZDOTDIR_ENV];
    // A daemon started from a shell whose `.zshenv` never ran (zsh -f) can carry our own
    // directory as ZDOTDIR; that is not the user's and must not be handed back as theirs.
    if (original !== undefined && original !== integration.zshDir) env[ZSH_ZDOTDIR_ENV] = original;
    env['ZDOTDIR'] = integration.zshDir;
}

function writeIfChanged(file: string, content: string): void {
    try {
        if (fs.readFileSync(file, 'utf8') === content) return;
    } catch {
        // Missing or unreadable: write it.
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Rename into place, so a shell starting while another daemon rewrites the file never
    // sources half of it.
    const staging = `${file}.tmp-${String(process.pid)}`;
    fs.writeFileSync(staging, content, { mode: 0o644 });
    try {
        fs.renameSync(staging, file);
    } catch (error) {
        fs.rmSync(staging, { force: true });
        throw error;
    }
}
