/**
 * #286: the update sheet, the whole update flow drawn in the Kelpi window.
 *
 * It replaced native alerts that macOS placed on its own (off to the right of the window, since
 * they had no parent) and that showed the release notes as plain text cut at 1200 characters.
 * The sheet is centred in the window like the app's other sheets (the group repository sheet,
 * New Workspace), and draws whichever state the shell's update flow is in
 * (`protocol/src/ws/update.ts` lists them):
 *
 *   checking      an indeterminate bar
 *   up-to-date    the running version
 *   available     current → new version, the release notes as markdown, Update Now / Later;
 *                 or, when Kelpi runs from somewhere an install cannot replace, why not
 *   downloading   an indeterminate bar (Squirrel reports no progress, so no percentage) and
 *                 the promise that Kelpi asks before it restarts
 *   ready         "Kelpi X is ready", Restart Now / Later, and that Kelpi reopens by itself
 *   restarting    the moment between Restart Now and the window closing
 *   failed        what went wrong, readably, and Retry
 *   unsupported   why this build cannot update
 *
 * It holds no state of its own beyond the shell's view: every button goes back to the shell
 * (`onAction`), and the shell answers with the next state. Escape and the backdrop mean Later for
 * a question and dismiss for anything else; a restart in progress cannot be dismissed.
 */

import { useEffect, useRef, type ReactElement } from 'react';
import { createPortal } from 'react-dom';

import type { UpdateUserAction, UpdateView } from '@kelpi/protocol';

import { DESTRUCTIVE_COLOR } from './QuitConfirmDialog';
import { ReleaseNotes } from './release-notes';
import { useModalPresence } from './modal-presence';
import { withAlpha } from './theme';
import { tokens } from './tokens';

export interface UpdateSheetProps {
    readonly view: UpdateView;
    readonly notesHTML?: string | undefined;
    readonly onAction: (action: UpdateUserAction) => void;
    /** Test seam: how a release-note link opens (defaults to the system browser). */
    readonly openLink?: ((href: string) => void) | undefined;
    /** Test seam: where the portal mounts (defaults to `document.body`). */
    readonly container?: Element | undefined;
}

interface SheetButton {
    readonly label: string;
    readonly action: UpdateUserAction;
    readonly testID: string;
}

interface SheetCopy {
    readonly title: string;
    readonly subtitle?: string;
    readonly primary?: SheetButton;
    readonly secondary?: SheetButton;
    /** What Escape and the backdrop mean; undefined = they do nothing. */
    readonly escape?: UpdateUserAction;
    readonly progress?: boolean;
}

/** Said the same way in the native dialog (`shell/src/update-surface.ts` ▸ `RESTART_EXPLAINED`). */
const RESTART_EXPLAINED =
    'Kelpi closes and reopens by itself in about ten seconds, so there is no need to open it again yourself. Your terminals and agents keep running.';

/** A failure's headline, by what failed (the shell's `failureTitle`, restated for the page). */
export function updateFailureTitle(view: UpdateView): string {
    const version = view.version === undefined ? 'The update' : `Kelpi ${view.version}`;
    if (view.retry === 'download') return `${version} could not be downloaded`;
    if (view.retry === 'install') return `${version} could not be installed`;
    return 'Kelpi could not check for updates';
}

/** The words and buttons for a view. Exported so the tests can read them without rendering. */
export function updateSheetCopy(view: UpdateView): SheetCopy {
    const version = view.version ?? '';
    const later: SheetButton = { label: 'Later', action: 'later', testID: 'update-later' };
    const ok: SheetButton = { label: 'OK', action: 'dismiss', testID: 'update-ok' };
    switch (view.phase) {
        case 'checking':
            return { title: 'Checking for Updates…', subtitle: `You have Kelpi ${view.currentVersion}.`, secondary: { label: 'Hide', action: 'dismiss', testID: 'update-hide' }, escape: 'dismiss', progress: true };
        case 'up-to-date':
            return { title: 'Kelpi is up to date', subtitle: `${view.currentVersion} is the latest version.`, primary: ok, escape: 'dismiss' };
        case 'available':
            if (view.location?.blocked === true) {
                return {
                    title: `Kelpi ${version} is available`,
                    subtitle: 'It cannot be installed from where Kelpi is running.',
                    primary: { label: 'OK', action: 'later', testID: 'update-ok' },
                    escape: 'later'
                };
            }
            return {
                title: `Kelpi ${version} is available`,
                subtitle: 'It downloads in the background, and Kelpi asks before it restarts.',
                primary: { label: 'Update Now', action: 'update-now', testID: 'update-now' },
                secondary: later,
                escape: 'later'
            };
        case 'downloading':
            return {
                title: `Downloading Kelpi ${version}…`,
                subtitle: 'This can take a minute or two. Kelpi will ask before it restarts; until then, keep working.',
                secondary: { label: 'Hide', action: 'dismiss', testID: 'update-hide' },
                escape: 'dismiss',
                progress: true
            };
        case 'ready':
            return {
                title: `Kelpi ${version} is ready`,
                subtitle: `Restart Kelpi to finish updating. ${RESTART_EXPLAINED}`,
                primary: { label: 'Restart Now', action: 'restart', testID: 'update-restart' },
                secondary: later,
                escape: 'later'
            };
        case 'restarting':
            return { title: `Restarting into Kelpi ${version}…`, subtitle: RESTART_EXPLAINED, progress: true };
        case 'failed':
            return {
                title: updateFailureTitle(view),
                primary: { label: 'Retry', action: 'retry', testID: 'update-retry' },
                secondary: { label: 'Close', action: 'dismiss', testID: 'update-close' },
                escape: 'dismiss'
            };
        case 'unsupported':
            return { title: 'Updates are unavailable in this build', primary: ok, escape: 'dismiss' };
        case 'idle':
            return { title: '' };
    }
}

export function UpdateSheet(props: UpdateSheetProps): ReactElement | null {
    const { view } = props;
    const copy = updateSheetCopy(view);
    // §N26: a sheet parks the window's web views while it is up, like its sibling sheets.
    useModalPresence();

    const escapeRef = useRef<() => void>(() => undefined);
    escapeRef.current = () => {
        if (copy.escape !== undefined) props.onAction(copy.escape);
    };
    // Escape answers from anywhere, in the capture phase, as the other sheets do, so no pane's
    // own key handling can swallow the way out.
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            escapeRef.current();
        };
        globalThis.window?.addEventListener('keydown', onKeyDown, true);
        return () => globalThis.window?.removeEventListener('keydown', onKeyDown, true);
    }, []);
    // The primary button takes focus whenever the state changes, so Return answers the question
    // being asked; focus goes back where it was when the sheet closes.
    const primaryRef = useRef<HTMLButtonElement | null>(null);
    const sheetRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        (primaryRef.current ?? sheetRef.current)?.focus();
    }, [view.phase]);
    useEffect(() => {
        const before = globalThis.document?.activeElement;
        return () => {
            if (before instanceof HTMLElement && before.isConnected) before.focus();
        };
    }, []);

    const container = props.container ?? globalThis.document?.body;
    if (container === undefined || container === null || view.phase === 'idle') return null;
    const showNotes = view.phase === 'available' && view.notes !== undefined;
    const { primary, secondary } = copy;

    return createPortal(
        <div
            data-testid="update-backdrop"
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{ background: 'rgba(0,0,0,0.45)' }}
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) escapeRef.current();
            }}
        >
            <div
                ref={sheetRef}
                tabIndex={-1}
                data-testid="update-sheet"
                data-phase={view.phase}
                role="dialog"
                aria-modal="true"
                aria-labelledby="update-sheet-title"
                className="flex max-h-[80vh] w-[480px] max-w-full flex-col overflow-hidden rounded-lg text-[12px] outline-none"
                style={{
                    background: tokens.surfaceBackground,
                    border: `1px solid ${tokens.divider}`,
                    color: tokens.textPrimary,
                    boxShadow: '0 16px 48px rgba(0,0,0,0.45)'
                }}
            >
                <div className="flex items-start gap-3 px-5 pt-5 pb-3">
                    <UpdateGlyph phase={view.phase} />
                    <div className="flex min-w-0 flex-col gap-1">
                        <div id="update-sheet-title" data-testid="update-title" className="text-[14px] font-semibold leading-snug">
                            {copy.title}
                        </div>
                        {copy.subtitle === undefined ? null : (
                            <div data-testid="update-subtitle" className="text-[12px] leading-relaxed" style={{ color: tokens.textSecondary }}>
                                {copy.subtitle}
                            </div>
                        )}
                        {view.phase === 'available' || view.phase === 'ready' || view.phase === 'downloading' ? (
                            <VersionLine current={view.currentVersion} next={view.version ?? ''} />
                        ) : null}
                    </div>
                </div>

                {copy.progress === true ? (
                    <div className="px-5 pb-3">
                        <div
                            data-testid="update-progress"
                            role="progressbar"
                            aria-label={copy.title}
                            aria-busy="true"
                            className="relative h-1 w-full overflow-hidden rounded-full"
                            style={{ background: withAlpha(tokens.textPrimary, 0.1) }}
                        >
                            <div className="kelpi-update-progress absolute inset-y-0 left-0 w-2/5 rounded-full" style={{ background: tokens.accent }} />
                        </div>
                    </div>
                ) : null}

                {view.location !== undefined && view.phase === 'available' ? (
                    <div className="px-5 pb-3">
                        <div
                            data-testid="update-location"
                            data-blocked={view.location.blocked ? 'true' : 'false'}
                            className="rounded-md px-3 py-2 text-[12px] leading-relaxed"
                            style={{
                                background: withAlpha(view.location.blocked ? DESTRUCTIVE_COLOR : tokens.activeAgent, 0.12),
                                border: `1px solid ${withAlpha(view.location.blocked ? DESTRUCTIVE_COLOR : tokens.activeAgent, 0.35)}`
                            }}
                        >
                            {view.location.message}
                        </div>
                    </div>
                ) : null}

                {(view.phase === 'failed' || view.phase === 'unsupported') && view.message !== undefined ? (
                    <div className="px-5 pb-3">
                        <div
                            data-testid="update-message"
                            className="rounded-md px-3 py-2 text-[12px] leading-relaxed"
                            style={{
                                background: withAlpha(view.phase === 'failed' ? DESTRUCTIVE_COLOR : tokens.textPrimary, 0.08),
                                border: `1px solid ${withAlpha(view.phase === 'failed' ? DESTRUCTIVE_COLOR : tokens.textPrimary, 0.2)}`
                            }}
                        >
                            {view.message}
                        </div>
                    </div>
                ) : null}

                {view.phase === 'ready' ? (
                    <div data-testid="update-later-note" className="px-5 pb-3 text-[11px]" style={{ color: tokens.textTertiary }}>
                        Choose Later to install it the next time you quit Kelpi.
                    </div>
                ) : null}

                {showNotes ? (
                    <div className="flex min-h-0 flex-col px-5 pb-3">
                        <div className="pb-1.5 text-[11px] font-semibold uppercase tracking-wide" style={{ color: tokens.textTertiary }}>
                            What's new
                        </div>
                        <div
                            className="min-h-0 overflow-y-auto rounded-md px-3.5 py-2.5"
                            style={{ background: withAlpha(tokens.textPrimary, 0.04), border: `1px solid ${tokens.divider}` }}
                        >
                            <ReleaseNotes markdown={view.notes ?? ''} html={props.notesHTML} openLink={props.openLink} />
                        </div>
                    </div>
                ) : null}

                {primary === undefined && secondary === undefined ? null : (
                    <div className="flex items-center justify-end gap-2 border-t px-5 py-3" style={{ borderColor: tokens.divider }}>
                        {secondary === undefined ? null : (
                            <button
                                type="button"
                                data-testid={secondary.testID}
                                className="rounded border px-3 py-1 text-[12px]"
                                style={{ borderColor: tokens.divider, color: tokens.textSecondary }}
                                onClick={() => props.onAction(secondary.action)}
                            >
                                {secondary.label}
                            </button>
                        )}
                        {primary === undefined ? null : (
                            <button
                                ref={primaryRef}
                                type="button"
                                data-testid={primary.testID}
                                data-default-action="true"
                                className="rounded border px-3 py-1 text-[12px] font-medium"
                                style={{ background: tokens.accent, borderColor: tokens.accent, color: '#fff' }}
                                onClick={() => props.onAction(primary.action)}
                            >
                                {primary.label}
                            </button>
                        )}
                    </div>
                )}
            </div>
        </div>,
        container
    );
}

/** `0.2.2 → 0.2.3`, the current version muted and the new one in the accent. */
function VersionLine(props: { readonly current: string; readonly next: string }): ReactElement {
    return (
        <div data-testid="update-versions" className="mt-1 flex items-center gap-1.5 font-mono text-[11px]">
            <span className="rounded px-1.5 py-px" style={{ background: withAlpha(tokens.textPrimary, 0.08), color: tokens.textSecondary }}>
                {props.current}
            </span>
            <span aria-label="to" style={{ color: tokens.textTertiary }}>
                →
            </span>
            <span className="rounded px-1.5 py-px font-semibold" style={{ background: withAlpha(tokens.accent, 0.18), color: tokens.accent }}>
                {props.next}
            </span>
        </div>
    );
}

/** A round badge with an arrow (or a tick, or a mark) saying at a glance what the state is. */
function UpdateGlyph(props: { readonly phase: UpdateView['phase'] }): ReactElement {
    const failed = props.phase === 'failed';
    const done = props.phase === 'up-to-date' || props.phase === 'ready';
    const color = failed ? DESTRUCTIVE_COLOR : done ? tokens.statusRunning : tokens.accent;
    return (
        <div
            aria-hidden="true"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
            style={{ background: withAlpha(color, 0.16), color }}
        >
            <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                {failed ? (
                    <path d="M8 4.2v4.6M8 11.4v.2" />
                ) : props.phase === 'up-to-date' ? (
                    <path d="M4 8.4l2.6 2.6L12 5.6" />
                ) : (
                    <path d="M8 3v7.2M4.8 7.2L8 10.4l3.2-3.2M4 13h8" />
                )}
            </svg>
        </div>
    );
}
