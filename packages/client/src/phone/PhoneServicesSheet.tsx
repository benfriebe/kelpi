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

import { useEffect, useState, type ReactElement } from 'react';
import type { RunningServiceEntry, RunningStopResult } from '@kelpi/protocol';

import { cpuText, memoryText, starterText, summarizeStop, uptimeText, type LiveNumbers } from '../chrome/running';
import { tokens } from '../chrome/tokens';
import { phoneStyle } from './style';
import { PHONE_ROW_MIN_PX, PhoneSheet, PhoneSheetHeader } from './ui';

const DANGER = '#E5484D';
const AMBER = '#E8994A';

export interface PhoneServicesSheetProps {
    readonly open: boolean;
    readonly workspaceName: string;
    readonly services: readonly RunningServiceEntry[];
    /** The daemon's clock now (`scanClock`), for uptimes. */
    readonly scannedAt: string | null;
    readonly numbers: (service: RunningServiceEntry) => LiveNumbers;
    /** D7: whole days idle, or null. */
    readonly idle: (service: RunningServiceEntry) => number | null;
    /** Null when the request itself failed (the caller has said why). */
    readonly onStop: (service: RunningServiceEntry, force: boolean) => Promise<readonly RunningStopResult[] | null>;
    readonly onClose: () => void;
}

type RowState =
    | { readonly phase: 'idle' }
    | { readonly phase: 'confirm' }
    | { readonly phase: 'stopping' }
    | { readonly phase: 'remaining'; readonly count: number }
    | { readonly phase: 'stopped' }
    | { readonly phase: 'error'; readonly message: string };

function ServiceRow(props: {
    readonly service: RunningServiceEntry;
    readonly scannedAt: string | null;
    readonly numbers: LiveNumbers;
    readonly idle: number | null;
    readonly onStop: PhoneServicesSheetProps['onStop'];
}): ReactElement {
    const { service } = props;
    const [state, setState] = useState<RowState>({ phase: 'idle' });
    const stop = (force: boolean): void => {
        setState({ phase: 'stopping' });
        void props.onStop(service, force).then((results) => {
            if (results === null) {
                setState({ phase: 'idle' });
                return;
            }
            const outcome = summarizeStop(results);
            if (outcome.errors.length > 0) setState({ phase: 'error', message: outcome.errors.join('; ') });
            else if (outcome.remaining > 0) setState({ phase: 'remaining', count: outcome.remaining });
            else setState({ phase: 'stopped' });
        });
    };
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
                {state.phase === 'idle' ? (
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
                        {service.foreground ? 'Stop it? Its pane gets Ctrl-C.' : 'Stop it?'}
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
            ) : state.phase === 'remaining' ? (
                <div className="flex items-center gap-2 pt-1">
                    <span className="min-w-0 flex-1 text-[14px]" style={{ color: tokens.textPrimary }}>
                        {`${String(state.count)} still running`}
                    </span>
                    <button type="button" data-testid="phone-service-force" className={button} style={{ background: DANGER, color: '#FFFFFF' }} onClick={() => stop(true)}>
                        Force stop
                    </button>
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
    // A fresh list each time it opens: last time's "Stopped" rows are gone by now.
    const [generation, setGeneration] = useState(0);
    useEffect(() => {
        if (props.open) setGeneration((value) => value + 1);
    }, [props.open]);
    return (
        <PhoneSheet open={props.open} side="bottom" label="Services" testID="phone-services" onClose={props.onClose}>
            <PhoneSheetHeader title={`Services · ${props.workspaceName}`} testID="phone-services-header" onClose={props.onClose} />
            <div key={generation} className="flex min-h-0 flex-col overflow-y-auto overscroll-contain pb-2">
                {props.services.length === 0 ? (
                    <p data-testid="phone-services-empty" className="px-4 py-3 text-[14px]" style={{ color: tokens.textSecondary }}>
                        Nothing running from this workspace.
                    </p>
                ) : (
                    props.services.map((service) => (
                        <ServiceRow
                            key={service.id}
                            service={service}
                            scannedAt={props.scannedAt}
                            numbers={props.numbers(service)}
                            idle={props.idle(service)}
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
