/**
 * The ⌘Q confirmation, drawn by the client (§AGNT-116).
 *
 * The Swift alert marks Quit destructive and makes Cancel the default button, so the keystroke
 * one key away from ⌘W cannot confirm itself. Electron's `dialog.showMessageBox` can do the
 * second half and has no way at all to do the first — its buttons are all the same button — and
 * the app already draws a dialog that gets this right: the workspace-delete gate, whose Delete
 * is `#E0655C` (§AGNT-119). This is that dialog, for quitting.
 *
 * It cannot simply REPLACE the native one, and that is why the item was declined twice: the
 * quit gate has to work when there is no renderer at all (a tray quit with the window closed, a
 * SIGTERM). So the main process decides per quit — a live, visible renderer with this gate
 * installed gets asked, anything else falls back to `showMessageBox`
 * (`shell/src/quit-prompt.ts`). This half is the renderer's side of that contract.
 *
 * **How the main process reaches it.** There is no preload and no `ipcRenderer` in this app, by
 * design. The one channel into the page is `webContents.executeJavaScript`, which resolves with
 * what the injected expression returns — including, when it returns a promise, what that promise
 * resolves to. So the page installs a global:
 *
 *     window.__nexQuitGate = { version, open(spec) → Promise<verdict>, dismiss() }
 *
 * `open` resolves `{response, checkboxChecked}` where `response` indexes `spec.buttons`, exactly
 * as `showMessageBox` reports it, so the main process's `response === 0` branch does not care
 * which dialog answered. `dismiss` exists for the one case the main process gives up on: it has
 * already put a native dialog on screen, and a second question must not still be sitting behind
 * it.
 *
 * The spec is rendered GENERICALLY — buttons from `spec.buttons`, `cancelId` naming the safe
 * one, everything else destructive, `defaultId` taking focus — so the index the page returns is
 * correct by construction rather than by a hard-coded agreement about which button is which.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';

import { useModalPresence } from './modal-presence';
import { tokens } from './tokens';

/** The page-side global's name. Must match `shell/src/quit-prompt.ts`. */
export const QUIT_GATE_GLOBAL = '__nexQuitGate';
/** Bumped only when the shape below changes incompatibly; the shell probes for it. */
export const QUIT_GATE_VERSION = 1;

/** The destructive tone the workspace-delete gate uses (§AGNT-119), shared deliberately. */
export const DESTRUCTIVE_COLOR = '#E0655C';

/** The `QuitDialogSpec` the shell sends, as the page receives it. */
export interface QuitGateSpec {
    readonly message: string;
    readonly detail: string;
    readonly buttons: readonly string[];
    /** The button that takes focus — Cancel, so Return is safe. */
    readonly defaultId: number;
    /** The button Escape chooses. */
    readonly cancelId: number;
    readonly checkboxLabel: string;
    readonly checkboxChecked: boolean;
}

export interface QuitGateVerdict {
    /** Index into `spec.buttons`. */
    readonly response: number;
    readonly checkboxChecked: boolean;
}

function readIndex(value: unknown, buttons: number, fallback: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
    if (value < 0 || value >= buttons) return fallback;
    return value;
}

/**
 * Read what the main process sent, or null when it is not a dialog spec.
 *
 * Defensive because this is a global anything on the page could call: a request with no buttons
 * cannot be answered, and a `defaultId` pointing nowhere would leave the dialog with no focused
 * control, i.e. no keyboard route out of it.
 */
export function normalizeQuitGateSpec(value: unknown): QuitGateSpec | null {
    if (typeof value !== 'object' || value === null) return null;
    const source = value as Record<string, unknown>;
    const buttons = Array.isArray(source['buttons'])
        ? (source['buttons'] as unknown[]).filter((entry): entry is string => typeof entry === 'string')
        : [];
    if (buttons.length === 0) return null;
    const cancelId = readIndex(source['cancelId'], buttons.length, buttons.length - 1);
    return {
        message: typeof source['message'] === 'string' ? source['message'] : 'Quit Nex?',
        detail: typeof source['detail'] === 'string' ? source['detail'] : '',
        buttons,
        // Both default to Cancel: the safe answer is the one a stray Return or Escape gives.
        defaultId: readIndex(source['defaultId'], buttons.length, cancelId),
        cancelId,
        checkboxLabel: typeof source['checkboxLabel'] === 'string' ? source['checkboxLabel'] : '',
        checkboxChecked: source['checkboxChecked'] === true
    };
}

interface PendingQuitRequest {
    readonly spec: QuitGateSpec;
    readonly settle: (verdict: QuitGateVerdict) => void;
}

export interface QuitGateHost {
    [key: string]: unknown;
}

export interface InstallQuitGateOptions {
    /** Where to install; defaults to `globalThis` (the page's main world). */
    readonly scope?: QuitGateHost | undefined;
    /** Show the dialog; resolves with the user's answer. */
    readonly onOpen: (spec: QuitGateSpec) => Promise<QuitGateVerdict>;
    /** Take a dialog off the screen because nobody is waiting for it any more. */
    readonly onDismiss: () => void;
}

/**
 * Install `window.__nexQuitGate`. Returns the uninstall, which restores whatever was there
 * before (nothing, in practice — but a component that mounts twice must not leave a corpse).
 */
export function installQuitGate(options: InstallQuitGateOptions): () => void {
    const scope = options.scope ?? (globalThis as unknown as QuitGateHost);
    const previous = scope[QUIT_GATE_GLOBAL];
    const gate = {
        version: QUIT_GATE_VERSION,
        open: async (raw: unknown): Promise<QuitGateVerdict | null> => {
            const spec = normalizeQuitGateSpec(raw);
            // Null rather than a guess: the shell reads an unusable answer as "the renderer
            // cannot do this" and shows its own dialog, which is the right outcome.
            if (spec === null) return null;
            return await options.onOpen(spec);
        },
        dismiss: (): void => options.onDismiss()
    };
    scope[QUIT_GATE_GLOBAL] = gate;
    return () => {
        if (scope[QUIT_GATE_GLOBAL] !== gate) return;
        if (previous === undefined) delete scope[QUIT_GATE_GLOBAL];
        else scope[QUIT_GATE_GLOBAL] = previous;
    };
}

export interface QuitGateProps {
    /** Test seam; defaults to the real page global. */
    readonly scope?: QuitGateHost | undefined;
}

/**
 * Mounts the gate: installs the global and renders the dialog whenever the shell opens one.
 *
 * Assembly renders exactly one of these. It draws nothing until the main process asks, so in a
 * browser (where nothing ever will) it is inert.
 */
export function QuitGate(props: QuitGateProps = {}): ReactElement | null {
    const [request, setRequest] = useState<PendingQuitRequest | null>(null);
    const pending = useRef<PendingQuitRequest | null>(null);
    pending.current = request;

    useEffect(() => {
        const install = installQuitGate({
            ...(props.scope === undefined ? {} : { scope: props.scope }),
            onOpen: (spec) =>
                new Promise<QuitGateVerdict>((resolve) => {
                    // A second ⌘Q while one is open should not stack dialogs — the shell guards
                    // this too, but a promise left unsettled here would hang the main process.
                    const previous = pending.current;
                    if (previous !== null) previous.settle({ response: previous.spec.cancelId, checkboxChecked: false });
                    setRequest({ spec, settle: resolve });
                }),
            onDismiss: () => {
                const current = pending.current;
                if (current !== null) current.settle({ response: current.spec.cancelId, checkboxChecked: false });
                setRequest(null);
            }
        });
        return () => {
            install();
            const current = pending.current;
            // Unmounting with a question outstanding: answer it safely rather than leave the
            // main process waiting for a page that is gone.
            if (current !== null) current.settle({ response: current.spec.cancelId, checkboxChecked: false });
        };
        // Installed once: `props.scope` is a test seam that never changes at runtime.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const answer = useCallback((verdict: QuitGateVerdict): void => {
        const current = pending.current;
        if (current === null) return;
        setRequest(null);
        current.settle(verdict);
    }, []);

    if (request === null) return null;
    return <QuitConfirmDialog spec={request.spec} onAnswer={answer} />;
}

export interface QuitConfirmDialogProps {
    readonly spec: QuitGateSpec;
    readonly onAnswer: (verdict: QuitGateVerdict) => void;
}

/**
 * The dialog itself — the delete gate's posture, for quitting (§AGNT-116/§AGNT-119).
 *
 * Cancel is focused (so Return is the safe answer, which is the whole point of the item), Escape
 * chooses `cancelId`, and every button that is not the cancel one is painted destructive.
 */
export function QuitConfirmDialog(props: QuitConfirmDialogProps): ReactElement | null {
    const { spec } = props;
    const [suppress, setSuppress] = useState(spec.checkboxChecked);
    const defaultRef = useRef<HTMLButtonElement | null>(null);
    const answered = useRef(false);

    /*
     * H1: park a live web pane while this is up. The audit frame that proves the gap is this
     * dialog's own — `docs/audit/run-O/53-agent-lifecycle-quit-dialog.png`, sliced at the page's
     * left edge with Cancel entirely off-screen — because the assembly's `modalOpen` predicate
     * had no way to see a dialog the SHELL opens.
     */
    useModalPresence();

    const answer = useCallback(
        (response: number): void => {
            if (answered.current) return;
            answered.current = true;
            props.onAnswer({ response, checkboxChecked: suppress });
        },
        [props, suppress]
    );

    useEffect(() => {
        defaultRef.current?.focus();
    }, []);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                answer(spec.cancelId);
                return;
            }
            if (event.key === 'Enter') {
                // macOS's default button, made explicit: Return takes the SAFE answer even if
                // focus has wandered off it.
                event.preventDefault();
                event.stopPropagation();
                answer(spec.defaultId);
            }
        };
        // Capture, so a pane's own key handling cannot swallow the way out of a modal.
        globalThis.window?.addEventListener('keydown', onKeyDown, true);
        return () => globalThis.window?.removeEventListener('keydown', onKeyDown, true);
    }, [answer, spec.cancelId, spec.defaultId]);

    const container = globalThis.document?.body;
    if (container === undefined || container === null) return null;

    return createPortal(
        <div
            data-testid="quit-dialog-backdrop"
            className="fixed inset-0 z-50"
            style={{ background: 'rgba(0,0,0,0.4)' }}
        >
            <div
                data-testid="quit-dialog"
                role="dialog"
                aria-modal="true"
                aria-label={spec.message}
                className="fixed left-1/2 top-1/3 w-[360px] -translate-x-1/2 rounded-lg p-4 text-[12px]"
                style={{
                    background: tokens.surfaceBackground,
                    border: `1px solid ${tokens.divider}`,
                    color: tokens.textPrimary,
                    boxShadow: '0 16px 48px rgba(0,0,0,0.45)'
                }}
            >
                <div className="mb-3">
                    <div data-testid="quit-dialog-message">{spec.message}</div>
                    {spec.detail === '' ? null : (
                        <div
                            data-testid="quit-dialog-detail"
                            className="mt-1 text-[11px]"
                            style={{ color: tokens.textSecondary }}
                        >
                            {spec.detail}
                        </div>
                    )}
                </div>
                {spec.checkboxLabel === '' ? null : (
                    <label className="mb-3 flex items-center gap-2 text-[11px]" style={{ color: tokens.textSecondary }}>
                        <input
                            type="checkbox"
                            data-testid="quit-suppress"
                            checked={suppress}
                            onChange={(event) => setSuppress(event.target.checked)}
                        />
                        {spec.checkboxLabel}
                    </label>
                )}
                <div className="flex justify-end gap-2">
                    {spec.buttons.map((label, index) => {
                        const isCancel = index === spec.cancelId;
                        const isDefault = index === spec.defaultId;
                        return (
                            <button
                                key={`${label}-${String(index)}`}
                                type="button"
                                ref={isDefault ? defaultRef : undefined}
                                data-testid={isCancel ? 'quit-cancel' : 'quit-confirm'}
                                data-default={isDefault ? 'true' : 'false'}
                                data-destructive={isCancel ? 'false' : 'true'}
                                /*
                                 * SPACING-REVIEW S53 — `QuitGate.swift:81-105` is an `NSAlert`,
                                 * and the macOS push button it stands in for has ~10 pt of side
                                 * padding and a ~68 pt MINIMUM width. `px-2` left the default
                                 * button's accent ring drawn hard against the "C" and the "l" of
                                 * Cancel, and both buttons narrower than any AppKit alert draws
                                 * them — in the most consequential dialog in the app.
                                 */
                                className="min-w-[68px] rounded px-3 py-1"
                                style={{
                                    // Destructive is a COLOUR, which is the whole gap this
                                    // closes: `showMessageBox` has no way to say it.
                                    color: isCancel ? tokens.textPrimary : DESTRUCTIVE_COLOR,
                                    ...(isDefault
                                        ? { border: `1px solid ${tokens.accent}`, background: 'rgba(111,155,216,0.16)' }
                                        : { border: '1px solid transparent' })
                                }}
                                onClick={() => answer(index)}
                            >
                                {label}
                            </button>
                        );
                    })}
                </div>
            </div>
        </div>,
        container
    );
}
