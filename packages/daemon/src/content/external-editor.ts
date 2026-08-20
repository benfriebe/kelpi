/**
 * `$VISUAL` / `$EDITOR` resolution — the port of `Nex/Services/EditorService.swift` (CONT-082…088).
 *
 * The problem the Swift service exists to solve is unchanged by the rewrite: a GUI-launched
 * process does not inherit the user's shell environment. On macOS a `.app` started from Finder
 * gets a minimal env where `$EDITOR` is almost always empty and `$SHELL` frequently is too — and
 * the daemon inherits whatever launched it, which for the packaged app is the Electron shell,
 * i.e. the same minimal env. So the only reliable answer is to **ask the user's login shell**.
 *
 * The five defences the Swift version grew, all kept:
 *
 *  - **The login shell comes from the passwd database**, not `$SHELL` (CONT-082). `os.userInfo()`
 *    reads the same `getpwuid(3)` record ghostty does; `$SHELL` then `/bin/sh` are the fallbacks.
 *  - **`-l -i -c`** so both login files (`.zprofile`) and interactive files (`.zshrc`, `.bashrc`)
 *    are sourced — most people set `$EDITOR` in an interactive-only file.
 *  - **Sentinel-bracketed output** (CONT-084). `.zshrc` prints banners, `direnv: loading …`,
 *    gitstatus debug, MOTDs; a positional parse without markers reads a banner line as the
 *    editor. `__NEX_EDITOR_BEGIN__` … `__NEX_EDITOR_END__` make the parse noise-proof.
 *  - **Both pipes drained concurrently** (CONT-085). Node's `child_process.spawn` gives us this
 *    for free — `stdout`/`stderr` `data` listeners are attached before the process can fill a
 *    64 KB pipe buffer — plus a 2 s watchdog that kills a shell hung for any other reason.
 *  - **Resolution is cached** (CONT-086): a success for the daemon's lifetime, a failure for
 *    `FAILURE_RETRY_MS` so one slow cold-cache init does not disable the feature forever. It runs
 *    off the request path (`warmUp()` at boot, CONT-087) and never blocks a reply.
 *
 * `$VISUAL` wins over `$EDITOR` (CONT-083, POSIX). With neither set, resolution answers `null`
 * and the caller falls back to the built-in editor — exactly what ⌘E does today.
 *
 * The launch command is built the Swift way (CONT-088):
 * `/usr/bin/env PATH='<login PATH>' <editor> '<file>'`. The `env` prefix rather than a
 * `VAR=value` assignment is not cosmetic — the command is handed to a shell as `sh -c '<command>'`
 * (here) / `bash -c "exec -l <command>"` (ghostty, there), and `exec`'s first argument must be a
 * program name. Keeping the byte-for-byte format also means a pane's persisted
 * `externalEditorCommand` reads identically to one written by the Swift app.
 */

import { spawn } from 'node:child_process';
import { userInfo } from 'node:os';

/** Sentinels bracketing the `printf`, so rc-file noise cannot shift the positional parse. */
export const EDITOR_BEGIN_MARKER = '__NEX_EDITOR_BEGIN__';
export const EDITOR_END_MARKER = '__NEX_EDITOR_END__';

/** How long the shell may take before the watchdog kills it (EditorService.swift: 2 s). */
export const SHELL_TIMEOUT_MS = 2000;
/** A *failed* resolution is retried after this; a success is cached for the process lifetime. */
export const FAILURE_RETRY_MS = 30_000;

const FALLBACK_SHELL = '/bin/sh';

export interface EditorResolution {
    /** The raw editor command as the user wrote it (`nvim`, `code -w`). */
    readonly editor: string;
    /** The login shell's `$PATH`, or null when the shell reported none. */
    readonly path: string | null;
    /** Which source answered — useful in logs and in the `{ok:false}` explanation. */
    readonly source: 'shell' | 'process-env';
}

/** POSIX single-quote escape: `'` becomes `'\''` (close, escaped quote, reopen). */
export function singleQuoteEscape(value: string): string {
    return value.replaceAll("'", "'\\''");
}

/**
 * The command string a shell will run (CONT-088). Without a login `PATH` the editor is invoked
 * bare and the spawning shell's own `PATH` has to find it.
 */
export function formatEditorCommand(
    editor: string,
    filePath: string,
    loginPath: string | null
): string {
    const file = singleQuoteEscape(filePath);
    if (loginPath === null || loginPath === '') return `${editor} '${file}'`;
    return `/usr/bin/env PATH='${singleQuoteEscape(loginPath)}' ${editor} '${file}'`;
}

/** CONT-082's shell resolution order: passwd record → `$SHELL` → `/bin/sh`. */
export function resolveUserShell(env: NodeJS.ProcessEnv = process.env): string {
    try {
        const shell = userInfo().shell;
        if (typeof shell === 'string' && shell.length > 0) return shell;
    } catch {
        // No passwd entry (a container with a bare uid): fall through.
    }
    const fromEnv = env['SHELL']?.trim();
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
    return FALLBACK_SHELL;
}

/**
 * Pull VISUAL / EDITOR / PATH out of an arbitrarily noisy shell transcript (CONT-084).
 *
 * The three values are the three lines AFTER the begin marker. A missing marker (the shell died
 * before `printf`, or the watchdog killed it mid-init) yields three empty strings rather than
 * three lines of somebody's MOTD.
 */
export function parseShellOutput(output: string): {
    visual: string;
    editor: string;
    path: string;
} {
    const lines = output.split('\n');
    const begin = lines.indexOf(EDITOR_BEGIN_MARKER);
    if (begin < 0) return { visual: '', editor: '', path: '' };
    const at = (offset: number): string => {
        const line = lines[begin + offset];
        if (line === undefined) return '';
        const trimmed = line.trim();
        // Never mistake the end marker for a value.
        return trimmed === EDITOR_END_MARKER ? '' : trimmed;
    };
    return { visual: at(1), editor: at(2), path: at(3) };
}

/** The `printf` the login shell runs. Exported so the test asserts the exact contract. */
export function editorProbeScript(): string {
    return `printf '\\n%s\\n%s\\n%s\\n%s\\n%s\\n' "${EDITOR_BEGIN_MARKER}" "$VISUAL" "$EDITOR" "$PATH" "${EDITOR_END_MARKER}"`;
}

/** `$VISUAL` beats `$EDITOR` (CONT-083); both empty = unresolvable. */
export function chooseEditor(visual: string, editor: string): string | null {
    const v = visual.trim();
    if (v !== '') return v;
    const e = editor.trim();
    return e === '' ? null : e;
}

/** The process env fallback — unlikely for a GUI launch, but it is what a dev/test run has. */
export function resolveFromProcessEnv(env: NodeJS.ProcessEnv = process.env): EditorResolution | null {
    const chosen = chooseEditor(env['VISUAL'] ?? '', env['EDITOR'] ?? '');
    if (chosen === null) return null;
    const path = env['PATH']?.trim();
    return { editor: chosen, path: path === undefined || path === '' ? null : path, source: 'process-env' };
}

export interface ShellProbeOptions {
    readonly shell?: string | undefined;
    readonly timeoutMs?: number | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly onLog?: ((message: string) => void) | undefined;
}

/**
 * Run the login shell once and read the three values off it.
 *
 * Resolves to `null` on any failure (spawn error, non-zero exit, watchdog kill, no editor set) —
 * the caller's job is to fall back, not to explain a shell's exit code to a user.
 */
export function probeLoginShell(options: ShellProbeOptions = {}): Promise<EditorResolution | null> {
    const shellPath = options.shell ?? resolveUserShell(options.env);
    const timeoutMs = options.timeoutMs ?? SHELL_TIMEOUT_MS;
    return new Promise<EditorResolution | null>((resolve) => {
        let settled = false;
        const finish = (value: EditorResolution | null): void => {
            if (settled) return;
            settled = true;
            clearTimeout(watchdog);
            resolve(value);
        };

        let child;
        try {
            child = spawn(shellPath, ['-l', '-i', '-c', editorProbeScript()], {
                stdio: ['ignore', 'pipe', 'pipe'],
                ...(options.env === undefined ? {} : { env: options.env })
            });
        } catch (error) {
            options.onLog?.(`external-editor: cannot spawn ${shellPath}: ${String(error)}`);
            resolve(null);
            return;
        }

        // CONT-085: both pipes are drained from the start. A chatty init writing >64 KB would
        // otherwise block on `write(2)` and only the watchdog would end it.
        let out = '';
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
            out += chunk;
        });
        child.stderr?.resume();

        const watchdog = setTimeout(() => {
            options.onLog?.(`external-editor: ${shellPath} timed out after ${String(timeoutMs)}ms`);
            try {
                child.kill('SIGTERM');
            } catch {
                // already gone
            }
            finish(null);
        }, timeoutMs);
        watchdog.unref?.();

        child.on('error', (error: Error) => {
            options.onLog?.(`external-editor: ${shellPath} failed: ${error.message}`);
            finish(null);
        });

        child.on('close', (code: number | null) => {
            if (code !== 0) {
                options.onLog?.(`external-editor: ${shellPath} exited with ${String(code)}`);
                finish(null);
                return;
            }
            const parsed = parseShellOutput(out);
            const chosen = chooseEditor(parsed.visual, parsed.editor);
            if (chosen === null) {
                options.onLog?.(`external-editor: ${shellPath} reported no $VISUAL or $EDITOR`);
                finish(null);
                return;
            }
            finish({
                editor: chosen,
                path: parsed.path === '' ? null : parsed.path,
                source: 'shell'
            });
        });
    });
}

export interface EditorResolverOptions {
    /** Test seam: replaces the login-shell probe. */
    readonly probe?: (() => Promise<EditorResolution | null>) | undefined;
    /** Test seam: replaces the process-env fallback. */
    readonly fromEnv?: (() => EditorResolution | null) | undefined;
    readonly now?: (() => number) | undefined;
    readonly failureRetryMs?: number | undefined;
    readonly onLog?: ((message: string) => void) | undefined;
}

export interface EditorResolver {
    /**
     * The cached answer, or null when resolution has not finished (or recently failed).
     * **Never blocks** — CONT-086's contract, and the reason a first ⌘E before warm-up
     * completes falls back to the built-in editor rather than stalling the reply.
     */
    current(): EditorResolution | null;
    /** Kick resolution off; idempotent. Called at boot (CONT-087). */
    warmUp(): void;
    /** Await the in-flight (or a fresh) resolution — what a user-initiated request wants. */
    resolve(): Promise<EditorResolution | null>;
    /** `formatEditorCommand` against the current answer; null when unresolvable. */
    buildCommand(filePath: string): string | null;
}

/**
 * The cache (CONT-086). A success is kept for the process lifetime; a failure is kept only for
 * `failureRetryMs`, after which the next `resolve()` tries the shell again.
 */
export function createEditorResolver(options: EditorResolverOptions = {}): EditorResolver {
    const probe =
        options.probe ??
        ((): Promise<EditorResolution | null> =>
            probeLoginShell(options.onLog === undefined ? {} : { onLog: options.onLog }));
    const fromEnv = options.fromEnv ?? ((): EditorResolution | null => resolveFromProcessEnv());
    const now = options.now ?? Date.now;
    const retryMs = options.failureRetryMs ?? FAILURE_RETRY_MS;

    let resolved: EditorResolution | null = null;
    let failedAt: number | null = null;
    let inFlight: Promise<EditorResolution | null> | null = null;

    const start = (): Promise<EditorResolution | null> => {
        if (inFlight !== null) return inFlight;
        const run = (async (): Promise<EditorResolution | null> => {
            let value: EditorResolution | null = null;
            try {
                value = await probe();
            } catch (error) {
                options.onLog?.(`external-editor: probe threw: ${String(error)}`);
            }
            if (value === null) value = fromEnv();
            if (value === null) failedAt = now();
            else {
                resolved = value;
                failedAt = null;
                options.onLog?.(`external-editor: resolved '${value.editor}' via ${value.source}`);
            }
            inFlight = null;
            return value;
        })();
        inFlight = run;
        return run;
    };

    return {
        current(): EditorResolution | null {
            if (resolved !== null) return resolved;
            // A recent failure short-circuits; a stale one re-arms the probe in the background
            // and still answers null for THIS call (never block the caller).
            if (failedAt !== null && now() - failedAt < retryMs) return null;
            void start();
            return null;
        },
        warmUp(): void {
            if (resolved !== null || inFlight !== null) return;
            void start();
        },
        async resolve(): Promise<EditorResolution | null> {
            if (resolved !== null) return resolved;
            if (failedAt !== null && now() - failedAt < retryMs) return null;
            return start();
        },
        buildCommand(filePath: string): string | null {
            const current = resolved;
            if (current === null) return null;
            return formatEditorCommand(current.editor, filePath, current.path);
        }
    };
}
