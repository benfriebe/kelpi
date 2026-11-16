/**
 * The Inspector's Services section (docs/running-services.md §7): the dev servers, listening
 * processes and compose projects this workspace started, one row per stack. A row is its name and
 * memory, then who started it, how long ago and its ports; a port opens in a web pane, and the
 * row expands to the stack's members and folder.
 *
 * Stop (§6, phase 3) sits on the row's first line, shown on hover or focus, and asks in the
 * stop dialog (`StopServicesDialog`), as every other surface does; the dialog says how it went
 * and offers Force stop. An expanded row's members each have their own Stop.
 */

import { useState, type ReactElement } from 'react';

import type { RunningServiceEntry, RunningServicePort } from '@kelpi/protocol';

import { ChromeIcon } from './icons';
import {
    memoryText,
    pathTail,
    portURL,
    runsElsewhere,
    starterText,
    cpuText,
    stopLabel,
    uptimeText,
    type LiveNumbers,
    type WorkspaceRunning
} from './running';
import { withAlpha, workspaceColorHex, type ChromeBucket } from './theme';
import { tokens } from './tokens';

/** Ports a collapsed row shows before `+N`; expanding shows them all. */
const PORTS_SHOWN = 3;

export interface InspectorServicesProps {
    readonly running: WorkspaceRunning | undefined;
    readonly scannedAt: string | null;
    readonly homeDirectory: string;
    readonly bucket: ChromeBucket;
    /** The workspace has a repository, so a service outside its folders ran elsewhere. */
    readonly ownsFolders?: boolean | undefined;
    /** Open a port's URL in a web pane beside the pane that started the service. */
    readonly onOpenPort?: ((service: RunningServiceEntry, port: RunningServicePort) => void) | undefined;
    /** Focus the pane that started the service. */
    readonly onShowPane?: ((paneID: string) => void) | undefined;
    /** docs/running-services.md §6: ask to stop it, or one member (a process id or container id). */
    readonly onStop?: StopService | undefined;
    /** Phase 4: a service's memory and CPU now (`liveNumbers`); absent reads the list's own. */
    readonly numbers?: ((service: RunningServiceEntry) => LiveNumbers) | undefined;
    /** D7: whole days it has sat idle, or null (`idleDays`); absent marks none. */
    readonly idle?: ((service: RunningServiceEntry) => number | null) | undefined;
}

export type StopService = (service: RunningServiceEntry, member?: { readonly id: string; readonly name: string }) => void;

function StopButton(props: {
    readonly label: string;
    readonly onClick: () => void;
    readonly testID: string;
    readonly bucket: ChromeBucket;
}): ReactElement {
    const [hovered, setHovered] = useState(false);
    return (
        <button
            type="button"
            data-testid={props.testID}
            aria-label={props.label}
            title={props.label}
            // Shown on the row's hover or keyboard focus only, so a list of services stays calm.
            className="shrink-0 rounded-[3px] p-0.5 opacity-0 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
            style={{ color: hovered ? workspaceColorHex('red', props.bucket) : tokens.textTertiary }}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onClick={(event) => {
                event.stopPropagation();
                props.onClick();
            }}
        >
            <ChromeIcon name="stop" />
        </button>
    );
}

function PortLink(props: { readonly port: RunningServicePort; readonly onOpen?: (() => void) | undefined }): ReactElement {
    const url = portURL(props.port);
    return (
        <button
            type="button"
            data-testid="inspector-service-port"
            title={`Open ${url} in a web pane${props.port.exposed ? ' (reachable from other machines)' : ''}`}
            className="shrink-0 font-mono text-[10.5px] hover:underline"
            style={{ color: tokens.statusRunning }}
            onClick={props.onOpen}
        >
            :{props.port.port}
        </button>
    );
}

function ServiceRow(props: {
    readonly service: RunningServiceEntry;
    readonly scannedAt: string | null;
    readonly homeDirectory: string;
    readonly bucket: ChromeBucket;
    readonly ownsFolders: boolean;
    readonly onOpenPort?: InspectorServicesProps['onOpenPort'];
    readonly onShowPane?: InspectorServicesProps['onShowPane'];
    readonly onStop?: StopService | undefined;
    readonly numbers?: InspectorServicesProps['numbers'];
    readonly idle?: InspectorServicesProps['idle'];
}): ReactElement {
    const { service } = props;
    const [open, setOpen] = useState(false);
    const unit = service.kind === 'process' ? (service.process_count === 1 ? 'process' : 'processes') : service.process_count === 1 ? 'container' : 'containers';
    const folder = service.directory === null ? null : pathTail(service.directory, props.homeDirectory);
    const numbers = props.numbers?.(service) ?? { rss: service.rss_bytes, cpu: service.cpu_percent ?? null };
    const cpu = cpuText(numbers.cpu);
    const idle = props.idle?.(service) ?? null;
    const elsewhere = runsElsewhere(service, props.ownsFolders);
    const warning = service.directory_missing
        ? `folder deleted: ${folder ?? ''}`
        : idle !== null
          ? `idle for ${String(idle)} day${idle === 1 ? '' : 's'}${elsewhere ? ` · runs in ${folder ?? ''}` : ''}`
          : elsewhere
            ? `runs in ${folder ?? ''}`
            : null;
    const shown = open ? service.ports : service.ports.slice(0, PORTS_SHOWN);
    const hidden = service.ports.length - shown.length;
    return (
        <div
            data-testid={`inspector-service-${service.id}`}
            data-open={open ? 'true' : 'false'}
            className="group -mx-1.5 flex flex-col rounded-[6px] px-1.5 py-1"
            style={open ? { background: withAlpha(tokens.textPrimary, 0.04) } : undefined}
        >
            <div className="flex min-w-0 items-center gap-1.5">
                <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    aria-expanded={open}
                    title={service.command}
                    onClick={() => setOpen((value) => !value)}
                >
                    <span className="shrink-0" style={{ color: tokens.textTertiary }}>
                        <ChromeIcon name={service.kind === 'process' ? 'terminal' : 'stack'} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{service.name}</span>
                    {cpu === null ? null : (
                        <span className="shrink-0 font-mono text-[10px]" style={{ color: tokens.textTertiary }} title="CPU over the last scan, percent of one core">
                            {cpu}
                        </span>
                    )}
                    <span className="shrink-0 font-mono text-[10px]" style={{ color: tokens.textSecondary }}>
                        {numbers.rss === null ? '' : memoryText(numbers.rss)}
                    </span>
                </button>
                {props.onStop === undefined ? null : (
                    <StopButton
                        label={`${stopLabel(service)} ${service.name}`}
                        testID="inspector-service-stop"
                        bucket={props.bucket}
                        onClick={() => props.onStop?.(service)}
                    />
                )}
            </div>
            <div className="flex min-w-0 items-baseline gap-2 pl-[18px] text-[10.5px]" style={{ color: tokens.textTertiary }}>
                <span className="min-w-0 truncate">
                    {starterText(service)} · up {uptimeText(service.started_at, props.scannedAt)}
                </span>
                {shown.map((port) => (
                    <PortLink key={`${String(port.port)}:${port.address}`} port={port} onOpen={() => props.onOpenPort?.(service, port)} />
                ))}
                {hidden > 0 ? (
                    <button type="button" className="shrink-0 font-mono hover:underline" onClick={() => setOpen(true)}>
                        +{hidden}
                    </button>
                ) : null}
            </div>
            {warning === null ? null : (
                <div
                    className="truncate pl-[18px] text-[10.5px]"
                    style={{ color: workspaceColorHex(service.directory_missing ? 'red' : 'orange', props.bucket) }}
                    title={service.directory ?? undefined}
                >
                    {warning}
                </div>
            )}
            {!open ? null : (
                <div className="flex flex-col gap-0.5 pl-[18px] pt-1 text-[11px]" data-testid="inspector-service-members">
                    {service.members.map((member) => (
                        <div key={`${member.name}:${String(member.pid ?? member.container_id)}`} className="flex items-center gap-1.5">
                            <span className="min-w-0 flex-1 truncate" style={{ color: tokens.textSecondary }}>
                                {member.name}
                            </span>
                            {member.ports.some((port) => port.exposed) ? (
                                <span
                                    className="shrink-0 font-mono text-[9.5px]"
                                    style={{ color: workspaceColorHex('orange', props.bucket) }}
                                    title="Listens on every network interface: other machines can reach it"
                                >
                                    network
                                </span>
                            ) : null}
                            <span className="w-[42px] shrink-0 text-right font-mono text-[10px]" style={{ color: tokens.textTertiary }}>
                                {member.rss_bytes === null ? '' : memoryText(member.rss_bytes)}
                            </span>
                            {props.onStop === undefined || service.members.length < 2 ? null : (
                                <StopButton
                                    label={`Stop ${member.name}`}
                                    testID="inspector-member-stop"
                                    bucket={props.bucket}
                                    onClick={() => {
                                        const id = member.container_id ?? (member.pid === null ? null : String(member.pid));
                                        if (id !== null) props.onStop?.(service, { id, name: member.name });
                                    }}
                                />
                            )}
                        </div>
                    ))}
                    <div className="truncate pt-0.5 text-[10px]" style={{ color: tokens.textTertiary }} title={service.directory ?? service.command}>
                        {String(service.process_count)} {unit} · {folder ?? service.command}
                    </div>
                    {service.pane_id === null || props.onShowPane === undefined ? null : (
                        <button
                            type="button"
                            className="self-start text-[11px] hover:underline"
                            style={{ color: tokens.accent }}
                            onClick={() => props.onShowPane?.(service.pane_id as string)}
                        >
                            Show the pane that started it
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

/** The section body; the Inspector draws the label and dividers around it. */
export function InspectorServices(props: InspectorServicesProps): ReactElement {
    const services = props.running?.services ?? [];
    if (services.length === 0) {
        return (
            <div className="text-[11px]" style={{ color: tokens.textTertiary }} data-testid="inspector-services-empty">
                Nothing running from this workspace.
            </div>
        );
    }
    const ports = props.running?.portCount ?? 0;
    // Live where `running-stats` has the numbers, so containers count too.
    const memory = services.reduce((sum, service) => sum + ((props.numbers?.(service) ?? { rss: service.rss_bytes }).rss ?? 0), 0);
    return (
        <>
            {/* One service says all of this on its own row. */}
            {services.length < 2 ? null : (
                <div className="text-[10.5px]" style={{ color: tokens.textTertiary }} data-testid="inspector-services-summary">
                    {services.length} running · {ports} port{ports === 1 ? '' : 's'}
                    {memory > 0 ? ` · ${memoryText(memory)}` : ''}
                </div>
            )}
            {services.map((service) => (
                <ServiceRow
                    key={service.id}
                    service={service}
                    scannedAt={props.scannedAt}
                    homeDirectory={props.homeDirectory}
                    bucket={props.bucket}
                    ownsFolders={props.ownsFolders ?? true}
                    onOpenPort={props.onOpenPort}
                    onShowPane={props.onShowPane}
                    onStop={props.onStop}
                    numbers={props.numbers}
                    idle={props.idle}
                />
            ))}
        </>
    );
}
