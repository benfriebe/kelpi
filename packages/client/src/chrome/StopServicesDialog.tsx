/**
 * Stop one or more services after asking (docs/running-services.md §6): every Stop in the app
 * comes here, the Inspector row's and a member's, the row menu's Services ▸ Stop All, a leftover
 * worktree's stacks and a "Started outside Kelpi" row in the status bar popover, and the palette.
 * The question names what it stops (D2: a service started outside Kelpi is named with its
 * command), and says when the stop is Ctrl-C to a pane. Cancel is the default, for Escape and
 * Return alike (kelpi#53).
 *
 * The dialog stays up while the daemon stops them, then closes on its own when everything exited;
 * if processes are still running after the daemon's wait it offers Force stop, and a refusal is
 * shown in place.
 */

import { useEffect, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';

import type { RunningServiceEntry, RunningStopResult } from '@kelpi/protocol';

import { hoverFill, useHoverKey } from './hover';
import { useModalPresence } from './modal-presence';
import { memoryText, stopsWithCtrlC, summarizeStop } from './running';
import { workspaceColorHex, type ChromeBucket } from './theme';
import { tokens } from './tokens';

export interface StopPrompt {
    readonly services: readonly RunningServiceEntry[];
    /** "Stop 3 services in api?", "Stop Postgres?". */
    readonly title: string;
    /** A line under the title: what was started outside Kelpi, say. */
    readonly detail?: string | undefined;
    /** One member of the one service: a process id or container id, and its name. */
    readonly member?: { readonly id: string; readonly name: string } | undefined;
}

export interface StopServicesDialogProps {
    readonly prompt: StopPrompt;
    readonly bucket: ChromeBucket;
    /** Null when the request itself failed (the caller has said why). */
    readonly onStop: (services: readonly RunningServiceEntry[], force: boolean) => Promise<readonly RunningStopResult[] | null>;
    readonly onClose: () => void;
}

/** The question for a set of services (or one member of one), named as the surfaces name them. */
export function stopPromptFor(
    services: readonly RunningServiceEntry[],
    where?: string,
    member?: { readonly id: string; readonly name: string }
): StopPrompt {
    const memory = services.reduce((sum, service) => sum + (service.rss_bytes ?? 0), 0);
    const outside = services.filter((service) => service.category === 'outside');
    const only = services.length === 1 ? services[0] : undefined;
    if (only !== undefined && member !== undefined) {
        return {
            services,
            member,
            title: `Stop ${member.name}?`,
            detail: `One part of ${only.name}. A supervisor such as turbo may start it again.`
        };
    }
    const title =
        only !== undefined
            ? `Stop ${only.name}?`
            : `Stop ${String(services.length)} services${where === undefined ? '' : ` ${where}`}?`;
    const detail =
        outside.length > 0
            ? `Started outside Kelpi: ${outside.map((service) => service.command).join(', ')}`
            : only !== undefined && stopsWithCtrlC(only)
              ? // A non-breaking hyphen, so the key never wraps as "Ctrl-" and "C".
                'Stop sends Ctrl\u2011C to its pane, where it runs in the foreground.'
              : memory > 0
                ? `${services.length === 1 ? 'It uses' : 'They use'} ${memoryText(memory)}.`
                : undefined;
    return { services, title, ...(detail === undefined ? {} : { detail }) };
}

type Phase =
    | { readonly phase: 'ask' }
    | { readonly phase: 'stopping' }
    /** `services`: the ones still running, which Force Stop goes to (never those that exited). */
    | { readonly phase: 'remaining'; readonly count: number; readonly services: readonly RunningServiceEntry[] }
    | { readonly phase: 'error'; readonly message: string };

const ACTION_CLASS = 'min-w-[68px] rounded px-3 py-1';

export function StopServicesDialog(props: StopServicesDialogProps): ReactElement | null {
    const [phase, setPhase] = useState<Phase>({ phase: 'ask' });
    const [hovered, bindHover] = useHoverKey();
    useModalPresence();
    const { onClose } = props;
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape' && event.key !== 'Enter') return;
            event.preventDefault();
            event.stopPropagation();
            onClose();
        };
        globalThis.window.addEventListener('keydown', onKeyDown, true);
        return () => {
            globalThis.window.removeEventListener('keydown', onKeyDown, true);
        };
    }, [onClose]);

    const run = (services: readonly RunningServiceEntry[], force: boolean): void => {
        setPhase({ phase: 'stopping' });
        void props.onStop(services, force).then((results) => {
            if (results === null) {
                onClose();
                return;
            }
            const outcome = summarizeStop(results);
            const left = new Set(results.filter((result) => (result.remaining?.length ?? 0) > 0).map((result) => result.id));
            if (outcome.errors.length > 0) setPhase({ phase: 'error', message: outcome.errors.join('; ') });
            else if (outcome.remaining > 0) {
                setPhase({ phase: 'remaining', count: outcome.remaining, services: services.filter((service) => left.has(service.id)) });
            } else onClose();
        });
    };

    const container = globalThis.document?.body;
    if (container === undefined || container === null) return null;
    const red = workspaceColorHex('red', props.bucket);
    const line =
        phase.phase === 'stopping'
            ? 'Stopping…'
            : phase.phase === 'remaining'
              ? `${String(phase.count)} still running after the wait.`
              : phase.phase === 'error'
                ? phase.message
                : props.prompt.detail;
    return createPortal(
        <div
            data-testid="stop-services-dialog"
            data-phase={phase.phase}
            role="dialog"
            aria-label={props.prompt.title}
            className="fixed left-1/2 top-1/3 z-50 w-[320px] -translate-x-1/2 rounded-lg p-4 text-[12px]"
            style={{
                background: tokens.surfaceBackground,
                border: `1px solid ${tokens.divider}`,
                color: tokens.textPrimary,
                boxShadow: '0 16px 48px rgba(0,0,0,0.45)'
            }}
        >
            <div className="mb-3">
                {props.prompt.title}
                {line === undefined ? null : (
                    <div
                        data-testid="stop-services-detail"
                        className="mt-1 break-words text-[11px]"
                        style={{ color: phase.phase === 'error' ? red : tokens.textSecondary }}
                    >
                        {line}
                    </div>
                )}
            </div>
            <div className="flex items-center justify-end gap-3">
                <button
                    type="button"
                    data-testid="stop-services-cancel"
                    className={ACTION_CLASS}
                    {...bindHover('cancel')}
                    style={{
                        color: tokens.textSecondary,
                        border: `1px solid ${hovered === 'cancel' ? tokens.selectionStroke : 'transparent'}`,
                        background: hoverFill(hovered === 'cancel')
                    }}
                    onClick={onClose}
                >
                    {phase.phase === 'ask' ? 'Cancel' : 'Close'}
                </button>
                {phase.phase === 'ask' || phase.phase === 'remaining' ? (
                    <button
                        type="button"
                        data-testid={phase.phase === 'ask' ? 'stop-services-confirm' : 'stop-services-force'}
                        className={ACTION_CLASS}
                        {...bindHover('stop')}
                        style={{
                            color: red,
                            border: `1px solid ${hovered === 'stop' ? tokens.selectionStroke : tokens.divider}`,
                            background: hoverFill(hovered === 'stop')
                        }}
                        onClick={() => (phase.phase === 'remaining' ? run(phase.services, true) : run(props.prompt.services, false))}
                    >
                        {phase.phase === 'ask' ? 'Stop' : 'Force Stop'}
                    </button>
                ) : null}
            </div>
        </div>,
        container
    );
}
