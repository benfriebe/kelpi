/**
 * Where the ⌘Q confirmation is DRAWN (§AGNT-116), and the rule for choosing.
 *
 * The Swift alert marks Quit destructive (`quitButton.hasDestructiveAction = true`) and makes
 * Cancel the default, so the keystroke one key away from ⌘W cannot confirm itself. Electron's
 * `dialog.showMessageBox` gives us the second half and has no answer at all for the first: its
 * buttons are all the same button.
 *
 * The client already draws a dialog that gets this right — the workspace-delete gate, whose
 * Delete is `#E0655C` (§AGNT-119) — but it lives in the RENDERER, and this gate has to work when
 * there is no renderer at all: a tray quit with the window closed, a SIGTERM, a logout. That is
 * why this was declined twice. The way out is neither of the two things that were considered: it
 * is a **hybrid**, decided per quit rather than once —
 *
 *   - a live, visible renderer that has installed the gate → ask it, and the user sees a real
 *     destructive Quit with Cancel focused and Escape cancelling;
 *   - anything else (no window, hidden window, crashed or still-loading renderer, a page with no
 *     gate, a probe that does not answer, a verdict that never comes) → `showMessageBox`,
 *     byte-for-byte the dialog that shipped before this module existed.
 *
 * The fallback is not a nicety, it is the invariant: **the quit must always be able to ask**.
 * Every failure mode of the renderer route lands on the native dialog rather than on a quit that
 * silently proceeds or a window that never appears.
 *
 * Pure by construction — no `electron` import — so both branches, including the two timeouts,
 * are unit-testable under plain Node (`vitest.config.mts`). `quit.ts` supplies the Electron
 * seams: `webContents.executeJavaScript` for the renderer, `dialog.showMessageBox` for the
 * native path.
 *
 * ## The renderer contract
 *
 * There is no preload and no `ipcRenderer` in this app (that is a deliberate security posture,
 * `main.ts`), so the only channel from the main process into the page is
 * `webContents.executeJavaScript`, which resolves with what the injected expression returns —
 * including, when it returns a promise, what that promise resolves to. The page installs
 * `window.__nexQuitGate` (`client/src/chrome/QuitConfirmDialog.tsx`):
 *
 *     { version: number, open(spec): Promise<{response, checkboxChecked}>, dismiss(): void }
 *
 * `response` is an index into `spec.buttons`, exactly as `showMessageBox` reports it, so the
 * caller's `response === 0` branch is unchanged whichever route answered.
 */

import type { QuitDialogSpec } from './settings.js';

/** The page-side global. Versioned so an older page can be refused rather than half-driven. */
export const QUIT_GATE_GLOBAL = '__nexQuitGate';
export const QUIT_GATE_VERSION = 1;

/**
 * How long the renderer gets to say "I have a gate" before the native dialog is used instead.
 *
 * Short on purpose: this is a synchronous property read on a page that is already loaded, so a
 * second of silence means the renderer is wedged, and a wedged renderer must not delay a dialog
 * the user is waiting for.
 */
export const QUIT_GATE_PROBE_TIMEOUT_MS = 1_000;

/**
 * How long the renderer gets to return a VERDICT. This one is generous, because the thing it is
 * waiting for is a person reading a sentence and deciding — a short timeout here would put a
 * second, native dialog on screen underneath the one they are still reading. It exists only to
 * bound the pathological case (a renderer that opened the dialog and then hung), and it dismisses
 * the page's dialog before falling back so the user is never asked twice at once.
 */
export const QUIT_GATE_VERDICT_TIMEOUT_MS = 120_000;

export interface QuitVerdict {
    /** Index into `spec.buttons` — 0 = Quit, matching `showMessageBox`. */
    readonly response: number;
    readonly checkboxChecked: boolean;
}

export interface QuitPromptOutcome extends QuitVerdict {
    /** Which dialog the user actually answered. Logged, and asserted by the smoke. */
    readonly route: 'renderer' | 'native';
}

/**
 * The renderer, reduced to the three things this module does with it. `quit.ts` implements it
 * over `webContents.executeJavaScript`; a test implements it with three functions.
 */
export interface QuitPromptRenderer {
    /** Is there a live, visible page with the gate installed? Never throws. */
    probe(): Promise<boolean>;
    /** Show the dialog and resolve with whatever the page returned (validated here). */
    ask(spec: QuitDialogSpec): Promise<unknown>;
    /** Close a dialog we have stopped waiting for. Best effort. */
    dismiss(): void;
}

export interface QuitPromptDeps {
    /** Null when there is no window at all — the tray/signal case. */
    readonly renderer: QuitPromptRenderer | null;
    readonly native: (spec: QuitDialogSpec) => Promise<QuitVerdict>;
    readonly probeTimeoutMs?: number | undefined;
    readonly verdictTimeoutMs?: number | undefined;
    readonly log?: ((message: string) => void) | undefined;
}

/** The expression that answers "does this page have a gate I can drive?". */
export function quitGateProbeScript(): string {
    return `(() => { const g = globalThis.${QUIT_GATE_GLOBAL}; return typeof g === 'object' && g !== null && typeof g.open === 'function' && Number(g.version) >= ${String(QUIT_GATE_VERSION)}; })()`;
}

/**
 * The expression that shows the dialog and resolves with the verdict.
 *
 * The spec is embedded as JSON rather than passed as an argument because `executeJavaScript`
 * takes source, not parameters. `JSON.stringify` twice (once for the object, once as a string
 * literal) is what keeps a workspace name full of quotes from becoming syntax.
 */
export function quitGateOpenScript(spec: QuitDialogSpec): string {
    const payload = JSON.stringify(JSON.stringify(spec));
    return `(() => { const g = globalThis.${QUIT_GATE_GLOBAL}; if (!g || typeof g.open !== 'function') return null; return g.open(JSON.parse(${payload})); })()`;
}

/** The expression that closes a dialog whose verdict we are no longer waiting for. */
export function quitGateDismissScript(): string {
    return `(() => { const g = globalThis.${QUIT_GATE_GLOBAL}; if (g && typeof g.dismiss === 'function') g.dismiss(); return true; })()`;
}

/**
 * Read the page's answer, or null when it is not one.
 *
 * Strict on purpose: a verdict is a decision about killing the window, and a half-read one
 * ("response" missing, out of range, not a number) must fall back to asking natively rather than
 * be rounded to a button. Out-of-range is included — a `response` naming a button that does not
 * exist tells us the page and this module disagree about the spec.
 */
export function normalizeQuitVerdict(value: unknown, spec: QuitDialogSpec): QuitVerdict | null {
    if (typeof value !== 'object' || value === null) return null;
    const source = value as Record<string, unknown>;
    const response = source['response'];
    if (typeof response !== 'number' || !Number.isInteger(response)) return null;
    if (response < 0 || response >= spec.buttons.length) return null;
    return { response, checkboxChecked: source['checkboxChecked'] === true };
}

function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
    return new Promise<T>((resolve) => {
        let settled = false;
        const finish = (value: T): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        const timer = setTimeout(() => finish(onTimeout()), ms);
        timer.unref?.();
        work.then(finish, () => finish(onTimeout()));
    });
}

/** A sentinel that cannot be confused with a verdict. */
const TIMED_OUT = Symbol('quit-gate-timeout');

/**
 * Ask the user whether to quit, in the best dialog available right now.
 *
 * Never rejects: every path either returns a verdict or falls through to the native dialog,
 * because a quit gate that throws is a quit gate that does not ask.
 */
export async function promptForQuit(spec: QuitDialogSpec, deps: QuitPromptDeps): Promise<QuitPromptOutcome> {
    const log = deps.log ?? ((): void => undefined);
    const renderer = deps.renderer;

    if (renderer === null) {
        log('quit: asking with the native dialog (no renderer)');
        return { ...(await deps.native(spec)), route: 'native' };
    }

    const available = await withTimeout(
        renderer.probe().catch(() => false),
        deps.probeTimeoutMs ?? QUIT_GATE_PROBE_TIMEOUT_MS,
        () => false
    );
    if (!available) {
        log('quit: asking with the native dialog (no renderer gate)');
        return { ...(await deps.native(spec)), route: 'native' };
    }

    log('quit: asking in the renderer');
    const answer = await withTimeout<unknown>(
        renderer.ask(spec).catch(() => TIMED_OUT),
        deps.verdictTimeoutMs ?? QUIT_GATE_VERDICT_TIMEOUT_MS,
        () => TIMED_OUT
    );
    const verdict = answer === TIMED_OUT ? null : normalizeQuitVerdict(answer, spec);
    if (verdict !== null) return { ...verdict, route: 'renderer' };

    // The page opened a dialog we have stopped waiting for (or answered nonsense). Take it off
    // the screen before putting a second question in front of the user.
    try {
        renderer.dismiss();
    } catch {
        // A renderer that cannot even be told to close is exactly why we are leaving.
    }
    log('quit: renderer dialog did not answer — falling back to the native dialog');
    return { ...(await deps.native(spec)), route: 'native' };
}
