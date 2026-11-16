/**
 * The phone's Services sheet (docs/running-services.md §7, phase 5): what the workspace on screen
 * is running, with the desktop's numbers, and Stop.
 *
 * Open is desktop-only (D5): a phone cannot reach the Mac's `localhost`, so ports are text. Stop
 * asks in the row itself (Cancel / Stop, each a thumb's width), then says how it went and offers
 * Force stop when something is still running. A paired phone may stop what belongs to a workspace
 * or a deleted worktree; the daemon refuses it anything started outside Kelpi, which this sheet
 * never lists anyway.
 */

import { useCallback, useState, type ReactElement } from 'react';
import type { RunningServiceEntry, RunningStopResult } from '@kelpi/protocol';

import { cpuText, memoryText, starterText, stopsWithCtrlC, summarizeStop, uptimeText, type LiveNumbers } from '../chrome/running';
import { tokens } from '../chrome/tokens';
import { phoneStyle } from './style';
import { PHONE_ROW_MIN_PX, PhoneSheet, PhoneSheetHeader } from './ui';

const DANGER = '#E5484D';
const AMBER = '#E8994A';

export interface PhoneServicesSheetProps {
    readonly open: boolean;
    readonly workspaceName: string;
    /** Null until the first scan has arrived. */
    readonly services: readonly RunningServiceEntry[] | null;
    /** The daemon's clock now (`scanClock`), for uptimes. */
    readonly scannedAt: string | null;
    readonly numbers: (service: RunningServiceEntry) => LiveNumbers;
    /** D7: whole days idle, or null. */
    readonly idle: (service: RunningServiceEntry) => number | null;
    /** Resolves with the results, a failed request as a result with its error; never rejects. */
    readonly onStop: (service: RunningServiceEntry, force: boolean) => Promise<readonly RunningStopResult[]>;
    readonly onClose: () => void;
}

type RowState =
    | { readonly phase: 'idle' }
    | { readonly phase: 'confirm' }
    | { readonly phase: 'stopping' }
    /** Still running after the wait (Force stop), with whatever else went wrong. */
    | { readonly phase: 'remaining'; readonly count: number; readonly errors: readonly string[] }
    | { readonly phase: 'stopped' }
    /** A supervisor started it again on its port: it is not down. */
    | { readonly phase: 'restarted'; readonly by: string }
    | { readonly phase: 'error'; readonly message: string };

const IDLE: RowState = { phase: 'idle' };

/** What a stop's results leave the row saying. */
function rowAfter(results: readonly RunningStopResult[]): RowState {
    const outcome = summarizeStop(results);
    if (outcome.remaining > 0) return { phase: 'remaining', count: outcome.remaining, errors: outcome.errors };
    if (outcome.errors.length > 0) return { phase: 'error', message: outcome.errors.join('; ') };
    if (outcome.restartedBy !== null) return { phase: 'restarted', by: outcome.restartedBy };
    return { phase: 'stopped' };
}

function ServiceRow(props: {
    readonly service: RunningServiceEntry;
    readonly scannedAt: string | null;
    readonly numbers: LiveNumbers;
    readonly idle: number | null;
    readonly state: RowState;
    readonly setState: (id: string, state: RowState) => void;
    readonly onStop: PhoneServicesSheetProps['onStop'];
}): ReactElement {
    const { service, state } = props;
    const setState = (next: RowState): void => props.setState(service.id, next);
    const stop = (force: boolean): void => {
        setState({ phase: 'stopping' });
        void props.onStop(service, force).then((results) => setState(rowAfter(results)));
    };
    // Stop again after a refusal, or once a supervisor has started it again.
    const canStop = state.phase === 'idle' || state.phase === 'error' || state.phase === 'restarted';
    const cpu = cpuText(props.numbers.cpu);
    const ports = service.ports.slice(0, 3).map((port) => `:${String(port.port)}`);
    const more = service.ports.length - ports.length;
    const detail = [
        starterText(service),
        `up ${uptimeText(service.started_at, props.scannedAt)}`,
        ...(ports.length === 0 ? [] : [`${ports.join(' ')}${more > 0 ? ` +${String(more)}` : ''}`])
    ].join(' · ');
    const button = 'flex h-[40px] min-w-[84px] items-center justify-center rounded-[12px] px-3 text-[15px] font-medium';
    return (
        <div
            data-testid="phone-service"
            data-service-id={service.id}
            data-stop={state.phase}
            className="flex flex-col gap-1 border-b px-4 py-2"
            style={{ borderColor: tokens.divider, minHeight: `${String(PHONE_ROW_MIN_PX)}px`, opacity: state.phase === 'stopped' ? 0.5 : 1 }}
        >
            <div className="flex items-center gap-3">
                <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[15px]" style={{ color: tokens.textPrimary }}>
                        {service.name}
                    </span>
                    <span className="truncate text-[13px]" style={{ color: tokens.textSecondary }}>
                        {detail}
                    </span>
                    {props.idle === null && !service.directory_missing ? null : (
                        <span className="truncate text-[13px]" style={{ color: service.directory_missing ? DANGER : AMBER }}>
                            {service.directory_missing ? 'Its folder was deleted' : `Idle for ${String(props.idle)} day${props.idle === 1 ? '' : 's'}`}
                        </span>
                    )}
                </div>
                <div className="flex shrink-0 flex-col items-end font-mono text-[12px]" style={{ color: tokens.textSecondary }}>
                    <span>{props.numbers.rss === null ? '' : memoryText(props.numbers.rss)}</span>
                    <span style={{ color: tokens.textTertiary }}>{cpu ?? ''}</span>
                </div>
                {canStop ? (
                    <button
                        type="button"
                        data-testid="phone-service-stop"
                        className={button}
                        style={{ background: phoneStyle.card, border: `1px solid ${phoneStyle.raisedBorder}`, color: DANGER }}
                        onClick={() => setState({ phase: 'confirm' })}
                    >
                        Stop
                    </button>
                ) : null}
            </div>
            {state.phase === 'confirm' ? (
                <div className="flex items-center gap-2 pt-1">
                    <span className="min-w-0 flex-1 text-[14px]" style={{ color: tokens.textPrimary }}>
                        {stopsWithCtrlC(service) ? 'Stop it? Its pane gets Ctrl-C.' : 'Stop it?'}
                    </span>
                    <button
                        type="button"
                        data-testid="phone-service-cancel"
                        className={button}
                        style={{ color: tokens.textSecondary }}
                        onClick={() => setState({ phase: 'idle' })}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        data-testid="phone-service-confirm"
                        className={button}
                        style={{ background: DANGER, color: '#FFFFFF' }}
                        onClick={() => stop(false)}
                    >
                        Stop
                    </button>
                </div>
            ) : state.phase === 'stopping' ? (
                <span className="text-[13px]" style={{ color: tokens.textSecondary }}>
                    Stopping…
                </span>
            ) : state.phase === 'stopped' ? (
                <span className="text-[13px]" style={{ color: tokens.textSecondary }}>
                    Stopped
                </span>
            ) : state.phase === 'restarted' ? (
                <span className="text-[13px]" style={{ color: AMBER }}>
                    {`Running again: ${state.by}`}
                </span>
            ) : state.phase === 'remaining' ? (
                <div className="flex flex-col gap-1 pt-1">
                    <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 text-[14px]" style={{ color: tokens.textPrimary }}>
                            {`${String(state.count)} still running`}
                        </span>
                        <button type="button" data-testid="phone-service-force" className={button} style={{ background: DANGER, color: '#FFFFFF' }} onClick={() => stop(true)}>
                            Force stop
                        </button>
                    </div>
                    {state.errors.length === 0 ? null : (
                        <span className="text-[13px]" style={{ color: DANGER }}>
                            {state.errors.join('; ')}
                        </span>
                    )}
                </div>
            ) : state.phase === 'error' ? (
                <span className="text-[13px]" style={{ color: DANGER }}>
                    {state.message}
                </span>
            ) : null}
        </div>
    );
}

export function PhoneServicesSheet(props: PhoneServicesSheetProps): ReactElement | null {
    // The rows' stops live here, not in the rows: the sheet unmounts its rows when it closes, and a
    // stop still under way must still say so when it opens again (a second Stop would race it).
    const [rows, setRows] = useState<ReadonlyMap<string, RowState>>(() => new Map());
    const [wasOpen, setWasOpen] = useState(props.open);
    if (props.open !== wasOpen) {
        setWasOpen(props.open);
        // Each opening starts afresh but for those: last time's "Stopped" rows are gone by now.
        if (props.open) setRows((current) => new Map([...current].filter(([, state]) => state.phase === 'stopping')));
    }
    const setRow = useCallback((id: string, state: RowState) => setRows((current) => new Map(current).set(id, state)), []);
    return (
        <PhoneSheet open={props.open} side="bottom" label="Services" testID="phone-services" onClose={props.onClose}>
            <PhoneSheetHeader title={`Services · ${props.workspaceName}`} testID="phone-services-header" onClose={props.onClose} />
            <div className="flex min-h-0 flex-col overflow-y-auto overscroll-contain pb-2">
                {props.services === null || props.services.length === 0 ? (
                    <p data-testid="phone-services-empty" className="px-4 py-3 text-[14px]" style={{ color: tokens.textSecondary }}>
                        {props.services === null ? 'Checking what runs…' : 'Nothing running from this workspace.'}
                    </p>
                ) : (
                    props.services.map((service) => (
                        <ServiceRow
                            key={service.id}
                            service={service}
                            scannedAt={props.scannedAt}
                            numbers={props.numbers(service)}
                            idle={props.idle(service)}
                            state={rows.get(service.id) ?? IDLE}
                            setState={setRow}
                            onStop={props.onStop}
                        />
                    ))
                )}
                <p className="px-4 pt-3 text-[12px]" style={{ color: tokens.textTertiary }}>
                    Ports open on the Mac; a phone cannot reach its localhost.
                </p>
            </div>
        </PhoneSheet>
    );
}
