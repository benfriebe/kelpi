/**
 * Home: where the phone starts, and the screen the old landing page became.
 *
 * Three things, top to bottom, in the order a person reaches for them with a phone in one hand:
 *
 *   1. **Needs you**: every agent waiting for the person, on EVERY host, as a row of cards, each
 *      with the host it is on and an Open button that goes straight to that pane. When nothing
 *      waits the row is one line saying so ("All clear"), with how much is running.
 *   2. **The host pager**: one card per host, swiped sideways. A card carries the host's name, its
 *      reachability, how much runs there and a badge counting what waits there; the dots under it
 *      show which hosts are waiting even while their cards are off screen, and end in Add a host.
 *   3. **Workspaces on that host**: a two-column grid of the host the pager is on. A tile carries
 *      the workspace's colour and letter, the kinds of pane in it, and what its agents are doing;
 *      a waiting workspace is outlined in the waiting colour.
 *
 * It is the shell's `landing` screen (`phone/view.ts`), not a sheet, for the reason the landing
 * page was: this is where the phone starts, there is nothing behind it to dismiss back to, and
 * nothing of any host's panes is on screen while it is up, so nothing streams.
 *
 * Which host the pager is on is the shell's (`homeHostKey`), because the location bar under Home
 * names it too and the picker can move it. The page writes nothing to any daemon: opening a
 * workspace or a waiting pane is the shell's `onSelect`, the same verb the picker uses.
 */

import { useEffect, useMemo, useRef, type ReactElement } from 'react';
import { useStore } from 'zustand';

import type { WorkspaceState } from '@kelpi/daemon/store';

import type { ChromeBucket } from '../chrome/theme';
import { tokens } from '../chrome/tokens';
import { homeAbbreviated } from '../grid';
import { selectSidebarEntries, type KelpiRuntime } from '../state';
import { workspaceKey, type PhoneAttention, type PhoneAttentionItem } from './attention';
import type { PhoneHostReading } from './fleet';
import { PhoneGlyph } from './glyphs';
import {
    GlyphTile,
    HostDot,
    WaitingDot,
    WorkspaceAvatar,
    hostKindLabel,
    hostReachability,
    paneTypeGlyph
} from './parts';
import { PromptText, ReplyRow, WaitedFor, useWaitingPrompt } from './PhoneReplies';
import { phoneStyle } from './style';
import { PHONE_SAFE_AREA } from './ui';

export interface PhoneHomeProps {
    readonly fleet: readonly PhoneHostReading[];
    readonly attention: PhoneAttention;
    readonly bucket: ChromeBucket;
    /** The host the pager is on; its workspaces fill the grid. */
    readonly homeHostKey: string;
    readonly onHomeHost: (hostKey: string) => void;
    readonly onOpenWaiting: (item: PhoneAttentionItem) => void;
    readonly onSeeAll: () => void;
    readonly onWorkspace: (hostKey: string, workspaceID: string) => void;
    /** A group tile opens the picker on the host's workspaces, where groups fold. */
    readonly onGroup: () => void;
    readonly onNewWorkspace: () => void;
    readonly onAddHost: () => void;
    readonly onRetryHost: (hostKey: string) => void;
    readonly onMenu: () => void;
}

// ── needs you ───────────────────────────────────────────────────────────────────────────

function WaitingCard(props: { readonly item: PhoneAttentionItem; readonly homeDirectory: string; readonly runtime: KelpiRuntime; readonly onOpen: () => void }): ReactElement {
    const { item } = props;
    const target = useMemo(() => ({ key: item.key, runtime: props.runtime, paneID: item.paneID }), [item.key, props.runtime, item.paneID]);
    const entry = useWaitingPrompt(target);
    const where = item.workingDirectory === null ? 'waiting for input' : homeAbbreviated(item.workingDirectory, props.homeDirectory);
    return (
        <div
            data-testid={`phone-needs-card-${item.paneID}`}
            data-host={item.hostKey}
            className="flex w-[290px] shrink-0 snap-start flex-col gap-[10px] rounded-[18px] border p-3"
            style={{ background: phoneStyle.waitingCard, borderColor: phoneStyle.waitingBorder, color: tokens.textPrimary }}
        >
            <span className="flex min-w-0 items-center gap-2">
                <span
                    className="flex h-[24px] max-w-[120px] shrink-0 items-center gap-[5px] rounded-full px-2 text-[12px]"
                    style={{ background: phoneStyle.sunken, color: tokens.textSecondary }}
                >
                    <PhoneGlyph name="server" size={12} weight={2} />
                    <span className="truncate">{item.hostName}</span>
                </span>
                <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{`${item.paneTitle} · ${item.workspaceName}`}</span>
                <span className="shrink-0 text-[12px]" style={{ color: phoneStyle.waitingText }}>
                    <WaitedFor itemKey={item.key} />
                </span>
            </span>
            {/* Three lines, so a Yes on Home sits under what it approves and not just "proceed?". */}
            <PromptText entry={entry} fallback={where} lines={3} />
            <ReplyRow target={target} entry={entry} max={2} onOpen={props.onOpen} />
        </div>
    );
}

/**
 * Every host out of reach: nothing on this page can be trusted to be current, so it says so first,
 * says what usually causes it, and offers to dial them all again. Kelpi retries on its own anyway
 * (`connection/socket.ts` backs off between attempts); the button is for a person who has just
 * fixed their network and does not want to wait out the backoff.
 */
function Unreachable(props: PhoneHomeProps): ReactElement {
    const amber = tokens.activeAgent;
    return (
        <div
            role="status"
            data-testid="phone-home-unreachable"
            className="mx-4 mt-[6px] flex flex-col gap-3 rounded-[18px] border p-4"
            style={{ background: `color-mix(in srgb, ${amber} 8%, ${tokens.windowBackground})`, borderColor: `color-mix(in srgb, ${amber} 30%, ${tokens.windowBackground})` }}
        >
            <span className="flex flex-col gap-1">
                <span className="text-[16px] font-bold">{props.fleet.length === 1 ? `Can't reach ${props.fleet[0]?.host.name ?? 'the host'}` : "Can't reach any host"}</span>
                <span className="text-[14px] leading-5" style={{ color: tokens.textSecondary }}>
                    Check this phone is on your tailnet or the same network as your hosts. Kelpi keeps retrying.
                </span>
            </span>
            <button
                type="button"
                data-testid="phone-home-retry-all"
                className="flex h-[44px] items-center gap-2 self-start rounded-[12px] px-[18px] text-[15px] font-semibold"
                style={{ background: amber, color: '#0A0A0C' }}
                onClick={() => {
                    for (const reading of props.fleet) props.onRetryHost(reading.host.key);
                }}
            >
                <PhoneGlyph name="retry" size={16} weight={2.2} />
                Retry all
            </button>
        </div>
    );
}

function NeedsYou(props: PhoneHomeProps): ReactElement {
    const { waiting, running } = props.attention;
    if (waiting.length === 0) {
        return (
            <div
                data-testid="phone-home-all-clear"
                className="mx-4 mt-[6px] flex min-h-[44px] items-center gap-[10px] rounded-[14px] border px-[14px]"
                style={{ background: `color-mix(in srgb, ${tokens.statusRunning} 7%, ${tokens.windowBackground})`, borderColor: `color-mix(in srgb, ${tokens.statusRunning} 22%, ${tokens.windowBackground})` }}
            >
                <span style={{ color: tokens.statusRunning }} className="flex">
                    <PhoneGlyph name="check" size={18} weight={2.2} />
                </span>
                <span className="flex-1 text-[15px] font-semibold">All clear</span>
                <span className="text-[13px]" style={{ color: tokens.textSecondary }}>
                    {running.length === 0 ? 'nothing waiting' : `nothing waiting · ${String(running.length)} running`}
                </span>
            </div>
        );
    }
    return (
        <section aria-label="Needs you" data-testid="phone-home-needs-you" data-waiting={waiting.length}>
            <div className="flex items-center gap-2 pt-[6px] pr-3 pb-[10px] pl-5">
                <WaitingDot />
                <h2 className="m-0 flex-1 text-[17px] font-bold">{`Needs you · ${String(waiting.length)}`}</h2>
                <button
                    type="button"
                    data-testid="phone-home-see-all"
                    className="flex h-[44px] items-center px-2 text-[15px]"
                    style={{ color: tokens.accent }}
                    onClick={props.onSeeAll}
                >
                    See all
                </button>
            </div>
            <div className="flex snap-x scroll-px-4 gap-[10px] overflow-x-auto px-4 pb-1" style={{ scrollbarWidth: 'none' }}>
                {waiting.map((item) => {
                    const reading = props.fleet.find((entry) => entry.host.key === item.hostKey);
                    const homeDirectory = reading?.host.runtime.store.getState().daemon.state.homeDirectory ?? '';
                    if (reading === undefined) return null;
                    return <WaitingCard key={item.key} item={item} homeDirectory={homeDirectory} runtime={reading.host.runtime} onOpen={() => props.onOpenWaiting(item)} />;
                })}
            </div>
        </section>
    );
}

// ── the host pager ──────────────────────────────────────────────────────────────────────

function HostCard(props: { readonly reading: PhoneHostReading; readonly waiting: number; readonly alone: boolean; readonly onClick: () => void; readonly onRetry: () => void }): ReactElement {
    const { host, connection, known, workspaces } = props.reading;
    const reachable = connection === 'connected';
    const running = workspaces.reduce((count, workspace) => count + workspace.panes.filter((pane) => pane.status === 'running').length, 0);
    return (
        <div
            data-testid={`phone-landing-host-${host.key}`}
            data-host-kind={host.kind}
            data-status={connection}
            className={`flex shrink-0 snap-center items-center gap-3 rounded-[20px] border px-4 py-[14px] ${props.alone ? 'basis-full' : 'basis-[calc(100%-32px)]'}`}
            style={{ background: phoneStyle.card, borderColor: phoneStyle.cardBorder, opacity: reachable ? 1 : 0.6 }}
        >
            <button type="button" data-testid={`phone-home-host-${host.key}`} data-host-card={host.key} className="flex min-w-0 flex-1 items-center gap-3 text-left" style={{ color: tokens.textPrimary }} onClick={props.onClick}>
                <span className="relative flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[12px]" style={{ background: phoneStyle.well, color: tokens.textSecondary }}>
                    <PhoneGlyph name="server" size={21} weight={1.75} />
                    {props.waiting > 0 ? (
                        <span
                            data-testid={`phone-home-host-waiting-${host.key}`}
                            className="absolute -top-[5px] -right-[5px] flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 px-1 text-[11px] font-bold"
                            style={{ background: tokens.statusWaiting, color: phoneStyle.onAccent, borderColor: phoneStyle.card }}
                        >
                            {String(props.waiting)}
                        </span>
                    ) : null}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                    <span className="truncate text-[20px] font-bold tracking-[-0.3px]">{host.name}</span>
                    <span className="flex items-center gap-[6px] truncate text-[12px]" style={{ color: tokens.textSecondary }} data-testid={`phone-landing-summary-${host.key}`}>
                        <HostDot status={connection} />
                        {`${hostKindLabel(host.kind)} · ${hostReachability(connection)}`}
                    </span>
                </span>
            </button>
            {reachable ? (
                <span className="flex shrink-0 flex-col items-end gap-[2px] text-[12px]">
                    {running > 0 ? <span style={{ color: tokens.statusRunning }}>{`${String(running)} running`}</span> : null}
                    <span style={{ color: tokens.textSecondary }}>
                        {known ? `${String(workspaces.length)} ${workspaces.length === 1 ? 'workspace' : 'workspaces'}` : '…'}
                    </span>
                </span>
            ) : (
                <button
                    type="button"
                    data-testid={`phone-home-retry-${host.key}`}
                    className="h-[44px] shrink-0 rounded-[12px] border px-3 text-[14px]"
                    style={{ borderColor: phoneStyle.raisedBorder, color: tokens.textPrimary }}
                    onClick={props.onRetry}
                >
                    Retry
                </button>
            )}
        </div>
    );
}

/**
 * The pager follows the host the shell names, and tells the shell when a swipe settles on another.
 * The two directions are kept apart by remembering which host the last programmatic scroll was for,
 * so the scroll that answers a picker's choice does not come back as a "swipe" to some host passed
 * on the way.
 */
function HostPager(props: PhoneHomeProps): ReactElement {
    const scroller = useRef<HTMLDivElement | null>(null);
    const index = Math.max(0, props.fleet.findIndex((reading) => reading.host.key === props.homeHostKey));
    /** The host a scroll of OURS is heading for, so its settle is not read as a swipe elsewhere. */
    const steering = useRef<{ readonly key: string; readonly until: number } | null>(null);
    const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
    const placed = useRef(false);

    useEffect(() => {
        const node = scroller.current;
        const card = node?.children[index] as HTMLElement | undefined;
        if (node === null || card === undefined || typeof node.scrollTo !== 'function') return;
        // Where snap-center rests this card: its centre on the scroller's, clamped to the range.
        const max = Math.max(0, node.scrollWidth - node.clientWidth);
        const left = Math.min(max, Math.max(0, card.offsetLeft + card.offsetWidth / 2 - node.clientWidth / 2));
        const first = !placed.current;
        placed.current = true;
        if (Math.abs(node.scrollLeft - left) < 2) return;
        steering.current = { key: props.homeHostKey, until: Date.now() + 800 };
        // The first placement is where Home opens, not a move: no animation for it.
        node.scrollTo({ left, behavior: first ? 'auto' : 'smooth' });
    }, [index, props.homeHostKey]);

    useEffect(
        () => () => {
            if (settle.current !== null) clearTimeout(settle.current);
        },
        []
    );

    const onScroll = (): void => {
        if (settle.current !== null) clearTimeout(settle.current);
        settle.current = setTimeout(() => {
            const node = scroller.current;
            if (node === null) return;
            const cards = Array.from(node.children) as HTMLElement[];
            const centre = node.scrollLeft + node.clientWidth / 2;
            let nearest = 0;
            let best = Number.POSITIVE_INFINITY;
            cards.forEach((card, at) => {
                const distance = Math.abs(card.offsetLeft + card.offsetWidth / 2 - centre);
                if (distance < best) {
                    best = distance;
                    nearest = at;
                }
            });
            const key = props.fleet[nearest]?.host.key;
            const steered = steering.current !== null && steering.current.until > Date.now() ? steering.current.key : null;
            steering.current = null;
            if (key === undefined || key === props.homeHostKey) return;
            // Our own scroll passing over other cards on its way: not a choice.
            if (steered !== null && steered !== key) return;
            props.onHomeHost(key);
        }, 120);
    };

    return (
        <>
            <div
                ref={scroller}
                data-testid="phone-landing-hosts"
                className="relative flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pt-[18px]"
                style={{ scrollbarWidth: 'none' }}
                onScroll={onScroll}
            >
                {props.fleet.map((reading) => (
                    <HostCard
                        key={reading.host.key}
                        reading={reading}
                        alone={props.fleet.length === 1}
                        waiting={props.attention.waitingByHost.get(reading.host.key) ?? 0}
                        onClick={() => props.onHomeHost(reading.host.key)}
                        onRetry={() => props.onRetryHost(reading.host.key)}
                    />
                ))}
            </div>
            <div
                className="flex h-[44px] items-center justify-center gap-[7px]"
                data-testid="phone-home-dots"
                role="img"
                aria-label={`Host ${String(index + 1)} of ${String(props.fleet.length)}${props.attention.waitingByHost.size > 0 ? `, ${String(props.attention.waitingByHost.size)} with something waiting` : ''}`}
            >
                {props.fleet.map((reading, at) => {
                    const current = at === index;
                    const waiting = (props.attention.waitingByHost.get(reading.host.key) ?? 0) > 0;
                    return (
                        <span
                            key={reading.host.key}
                            aria-hidden
                            data-testid={`phone-home-dot-${reading.host.key}`}
                            data-current={current ? 'true' : 'false'}
                            data-waiting={waiting ? 'true' : 'false'}
                            className="h-[6px] rounded-[3px]"
                            style={{
                                width: current ? 18 : 6,
                                background: current ? tokens.textPrimary : waiting ? tokens.statusWaiting : 'transparent',
                                border: current || waiting ? 'none' : `1px solid ${tokens.textTertiary}`,
                                boxShadow: !current && waiting ? `0 0 0 3px ${phoneStyle.waitingHalo}` : 'none',
                                boxSizing: 'border-box'
                            }}
                        />
                    );
                })}
                <button
                    type="button"
                    data-testid="phone-landing-add-host"
                    aria-label="Add a host"
                    className="-mr-[19px] -ml-[12px] flex h-[44px] w-[44px] items-center justify-center"
                    style={{ color: tokens.textSecondary }}
                    onClick={props.onAddHost}
                >
                    <PhoneGlyph name="plus" size={10} weight={3.5} />
                </button>
            </div>
        </>
    );
}

// ── workspaces on that host ─────────────────────────────────────────────────────────────

function workspaceState(workspace: WorkspaceState, waiting: number): { text: string; color: string; dot: string } {
    if (waiting > 0) {
        const agent = workspace.panes.find((pane) => pane.status === 'waitingForInput')?.agentKind;
        const running = workspace.panes.filter((pane) => pane.status === 'running').length;
        const text = waiting === 1 && running === 0 && agent !== null && agent !== undefined ? `${agent} waiting` : `${String(waiting)} waiting${running > 0 ? ` · ${String(running)} running` : ''}`;
        return { text, color: phoneStyle.waitingText, dot: tokens.statusWaiting };
    }
    if (workspace.panes.some((pane) => pane.status === 'running')) return { text: 'running', color: tokens.statusRunning, dot: tokens.statusRunning };
    return { text: workspace.muted ? 'idle · muted' : 'idle', color: tokens.textSecondary, dot: tokens.statusInactive };
}

function WorkspaceTile(props: { readonly hostKey: string; readonly workspace: WorkspaceState; readonly waiting: number; readonly bucket: ChromeBucket; readonly onOpen: () => void }): ReactElement {
    const { workspace } = props;
    const state = workspaceState(workspace, props.waiting);
    const glyphs = workspace.panes.slice(0, 6).map((pane) => paneTypeGlyph(pane));
    return (
        <button
            type="button"
            data-testid={`phone-home-workspace-${workspace.id}`}
            data-workspace-id={workspace.id}
            data-host-key={props.hostKey}
            data-waiting={props.waiting > 0 ? 'true' : 'false'}
            className="flex min-w-0 flex-col gap-2 rounded-[16px] border p-3 text-left"
            style={{ background: phoneStyle.card, borderColor: props.waiting > 0 ? phoneStyle.waitingBorder : phoneStyle.cardBorder, color: tokens.textPrimary }}
            onClick={props.onOpen}
        >
            <span className="flex items-center gap-[6px]">
                <WorkspaceAvatar workspace={workspace} bucket={props.bucket} />
                <span className="flex-1" />
                {workspace.muted ? (
                    <span className="flex" style={{ color: tokens.textSecondary }}>
                        <PhoneGlyph name="bell-off" size={14} label="Muted" />
                    </span>
                ) : null}
                <span aria-hidden className="h-[8px] w-[8px] rounded-full" style={{ background: state.dot }} />
            </span>
            <span className="truncate text-[15px] font-semibold">{workspace.name}</span>
            <span className="flex gap-[7px]" style={{ color: tokens.textSecondary }}>
                {glyphs.map((glyph, at) => (
                    <PhoneGlyph key={at} name={glyph} size={13} weight={2} />
                ))}
            </span>
            <span className="truncate text-[12px]" style={{ color: state.color }}>
                {state.text}
            </span>
        </button>
    );
}

function HostWorkspaces(props: PhoneHomeProps & { readonly reading: PhoneHostReading }): ReactElement {
    const { host, connection, known } = props.reading;
    const entries = useStore(host.runtime.store, selectSidebarEntries);
    const tile = (workspace: WorkspaceState): ReactElement => (
        <WorkspaceTile
            key={workspace.id}
            hostKey={host.key}
            workspace={workspace}
            waiting={props.attention.waitingByWorkspace.get(workspaceKey(host.key, workspace.id)) ?? 0}
            bucket={props.bucket}
            onOpen={() => props.onWorkspace(host.key, workspace.id)}
        />
    );

    if (!known) {
        return (
            <div className="mx-4 rounded-[18px] border px-4 py-5 text-[14px]" data-testid="phone-home-host-pending" style={{ borderColor: phoneStyle.cardBorder, color: tokens.textSecondary }}>
                {connection === 'connected' || connection === 'connecting' ? `Connecting to ${host.name}…` : `Can't reach ${host.name}. Kelpi keeps retrying.`}
            </div>
        );
    }

    if (entries.length === 0) {
        return (
            <div
                data-testid="phone-home-no-workspaces"
                className="mx-4 flex flex-col items-center gap-[14px] rounded-[20px] border border-dashed px-5 pt-7 pb-5 text-center"
                style={{ borderColor: phoneStyle.raisedBorder }}
            >
                <GlyphTile name="layout" size={52} />
                <span className="flex flex-col gap-[6px]">
                    <span className="text-[18px] font-bold">{`No workspaces on ${host.name} yet`}</span>
                    <span className="text-[14px] leading-5" style={{ color: tokens.textSecondary }}>
                        Start one with its first pane. It also shows in Kelpi on that machine.
                    </span>
                </span>
                <button
                    type="button"
                    data-testid="phone-home-new-workspace"
                    className="h-[48px] w-full rounded-[14px] text-[16px] font-semibold"
                    style={{ background: phoneStyle.accentFill, color: phoneStyle.onAccent }}
                    onClick={props.onNewWorkspace}
                >
                    New workspace…
                </button>
            </div>
        );
    }

    return (
        <div className="grid grid-cols-2 gap-[10px] px-4" data-testid={`phone-home-workspaces-${host.key}`}>
            {entries.flatMap((entry) => {
                if (entry.kind === 'workspace') return [entry.workspace, ...(entry.nested?.get(entry.workspace.id) ?? [])].map(tile);
                const running = entry.workspaces.filter((workspace) => workspace.panes.some((pane) => pane.status === 'running')).length;
                const waiting = entry.workspaces.reduce((count, workspace) => count + (props.attention.waitingByWorkspace.get(workspaceKey(host.key, workspace.id)) ?? 0), 0);
                return [
                    <button
                        key={entry.group.id}
                        type="button"
                        data-testid={`phone-home-group-${entry.group.id}`}
                        className="flex min-w-0 flex-col items-start gap-2 rounded-[16px] border p-3 text-left"
                        style={{ background: phoneStyle.card, borderColor: waiting > 0 ? phoneStyle.waitingBorder : phoneStyle.cardBorder, color: tokens.textPrimary }}
                        onClick={props.onGroup}
                    >
                        <span className="flex w-full items-center gap-2">
                            <span className="flex" style={{ color: tokens.textSecondary }}>
                                <PhoneGlyph name="folder" size={20} weight={1.8} />
                            </span>
                            <span className="flex-1" />
                            <span className="text-[12px]" style={{ color: tokens.textSecondary }}>
                                {String(entry.workspaces.length)}
                            </span>
                        </span>
                        <span className="w-full truncate text-[15px] font-semibold">{entry.group.name}</span>
                        <span className="text-[12px]" style={{ color: waiting > 0 ? phoneStyle.waitingText : tokens.textSecondary }}>
                            {waiting > 0 ? `group · ${String(waiting)} waiting` : running > 0 ? `group · ${String(running)} running` : 'group'}
                        </span>
                    </button>
                ];
            })}
            <button
                type="button"
                data-testid="phone-home-new-workspace"
                className="flex min-h-[110px] flex-col items-center justify-center gap-[6px] rounded-[16px] border border-dashed p-3 text-[14px]"
                style={{ borderColor: phoneStyle.raisedBorder, color: tokens.textSecondary }}
                onClick={props.onNewWorkspace}
            >
                <PhoneGlyph name="plus" size={20} weight={1.8} />
                New workspace
            </button>
        </div>
    );
}

export function PhoneHome(props: PhoneHomeProps): ReactElement {
    const reading = props.fleet.find((entry) => entry.host.key === props.homeHostKey) ?? props.fleet[0];
    return (
        <div data-testid="phone-landing" className="h-full min-h-0 overflow-y-auto pb-4" style={{ background: tokens.windowBackground, color: tokens.textPrimary }}>
            {/* A plain block scroller: as a flex column its sections would shrink to fit. */}
            <div className="flex flex-col">
            <div className="flex h-[44px] shrink-0 items-center gap-[10px] pr-2 pl-3" style={{ marginTop: PHONE_SAFE_AREA.top }}>
                <button type="button" data-testid="phone-home-menu" aria-label="Kelpi menu" className="flex h-[44px] w-[44px] items-center justify-center" onClick={props.onMenu}>
                    <img src="/apple-touch-icon.png" alt="" className="h-[28px] w-[28px] rounded-[7px]" />
                </button>
                <span className="flex-1" />
                <button
                    type="button"
                    data-testid="phone-home-new-workspace-header"
                    aria-label="New workspace"
                    className="flex h-[44px] w-[44px] items-center justify-center"
                    style={{ color: tokens.textPrimary }}
                    onClick={props.onNewWorkspace}
                >
                    <PhoneGlyph name="plus" size={22} weight={1.75} />
                </button>
            </div>
            {props.fleet.length > 0 && props.fleet.every((reading) => reading.connection === 'closed' || reading.connection === 'reconnecting' || reading.connection === 'rejected') ? (
                <Unreachable {...props} />
            ) : (
                <NeedsYou {...props} />
            )}
            <HostPager {...props} />
            {reading === undefined ? null : (
                <>
                    <div className="flex items-baseline justify-between px-5 pt-[6px] pb-[10px]">
                        <h2 className="m-0 text-[20px] font-bold">Workspaces</h2>
                        <span className="text-[13px]" style={{ color: tokens.textSecondary }}>{`on ${reading.host.name}`}</span>
                    </div>
                    <HostWorkspaces key={reading.host.key} {...props} reading={reading} />
                </>
            )}
            </div>
        </div>
    );
}
