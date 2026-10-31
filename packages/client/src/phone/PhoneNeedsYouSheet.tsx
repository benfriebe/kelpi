/**
 * Needs you, every host: the full list behind Home's row and the pill above the location bar.
 *
 * Grouped by host, because a person deciding what to answer first decides by machine as often as
 * by agent, with a chip per host to narrow it to one. Each card says which agent, in which
 * workspace, how long it has waited (`attention.ts` says by whose clock), where it is working, and
 * opens straight onto that pane. Running sits folded at the foot: it is worth a glance, not a
 * signal.
 *
 * A card shows the agent's question as its screen asks it, and answers it from the card when the
 * prompt is one `prompts.ts` recognises; anything else is answered by opening the pane.
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';

import { tokens } from '../chrome/tokens';
import { homeAbbreviated } from '../grid';
import type { PhoneAttention, PhoneAttentionItem } from './attention';
import type { PhoneHostReading } from './fleet';
import { PhoneGlyph } from './glyphs';
import { GlyphTile, hostKindLabel } from './parts';
import { PromptText, ReplyRow, WaitedFor, useWaitingPrompt } from './PhoneReplies';
import { phoneStyle } from './style';
import type { KelpiRuntime } from '../state';
import { PhoneSheet } from './ui';

export interface PhoneNeedsYouSheetProps {
    readonly open: boolean;
    readonly fleet: readonly PhoneHostReading[];
    readonly attention: PhoneAttention;
    readonly onOpen: (item: PhoneAttentionItem) => void;
    readonly onClose: () => void;
}

function Chip(props: { readonly testID: string; readonly label: string; readonly count: number; readonly on: boolean; readonly onClick: () => void }): ReactElement {
    return (
        <button
            type="button"
            aria-pressed={props.on}
            data-testid={props.testID}
            className="flex h-[44px] shrink-0 items-center gap-[6px] rounded-full border px-[14px] text-[13px] font-semibold"
            style={{
                background: props.on ? phoneStyle.waitingCard : 'transparent',
                borderColor: props.on ? phoneStyle.waitingBorder : phoneStyle.cardBorder,
                color: props.on ? tokens.textPrimary : tokens.textSecondary
            }}
            onClick={props.onClick}
        >
            {props.label}
            <span style={{ color: props.on ? phoneStyle.waitingText : tokens.textSecondary }}>{String(props.count)}</span>
        </button>
    );
}

function Card(props: { readonly item: PhoneAttentionItem; readonly homeDirectory: string; readonly runtime: KelpiRuntime; readonly onOpen: () => void }): ReactElement {
    const { item } = props;
    const target = useMemo(() => ({ key: item.key, runtime: props.runtime, paneID: item.paneID }), [item.key, props.runtime, item.paneID]);
    const entry = useWaitingPrompt(target);
    const meta =
        [
            item.workingDirectory === null ? null : homeAbbreviated(item.workingDirectory, props.homeDirectory),
            item.backgroundTaskCount > 0 ? `${String(item.backgroundTaskCount)} background task${item.backgroundTaskCount === 1 ? '' : 's'}` : null
        ]
            .filter((part) => part !== null)
            .join(' · ') || 'waiting for input';
    return (
        <div
            data-testid={`phone-needs-item-${item.paneID}`}
            className="flex flex-col gap-[10px] rounded-[16px] border p-3"
            style={{ background: phoneStyle.raised, borderColor: phoneStyle.raisedBorder }}
        >
            <div className="flex items-center gap-[10px]">
                <GlyphTile name={item.agentKind === null ? 'terminal' : 'agent'} size={30} waiting />
                <span className="flex min-w-0 flex-1 flex-col gap-[1px]">
                    <span className="truncate text-[15px] font-semibold">
                        {item.paneTitle}
                        <span className="font-normal" style={{ color: tokens.textSecondary }}>
                            {' in '}
                        </span>
                        {item.workspaceName}
                    </span>
                    <span className="truncate text-[12px]" style={{ color: tokens.textSecondary }}>
                        {meta}
                    </span>
                </span>
                <span className="shrink-0 text-[12px]" style={{ color: phoneStyle.waitingText }}>
                    <WaitedFor itemKey={item.key} />
                </span>
            </div>
            <PromptText entry={entry} fallback="Waiting for input" boxed lines={4} />
            <ReplyRow target={target} entry={entry} max={3} layout="stack" idPrefix="phone-needs-reply" onOpen={props.onOpen} openLabel="Open to answer" />
        </div>
    );
}

export function PhoneNeedsYouSheet(props: PhoneNeedsYouSheetProps): ReactElement | null {
    const [chosen, setChosen] = useState<string | null>(null);
    const [runningOpen, setRunningOpen] = useState(false);
    // Each opening starts on every host: a filter is a look at this list, not a setting.
    useEffect(() => {
        if (props.open) setChosen(null);
    }, [props.open]);
    const { waiting, running, waitingByHost } = props.attention;
    const hostsWaiting = props.fleet.filter((reading) => (waitingByHost.get(reading.host.key) ?? 0) > 0);
    // A host whose last wait ended while it was chosen is no longer a filter anybody could pick.
    const filter = chosen !== null && hostsWaiting.some((reading) => reading.host.key === chosen) ? chosen : null;
    const setFilter = setChosen;
    const shownHosts = filter === null ? hostsWaiting : hostsWaiting.filter((reading) => reading.host.key === filter);

    return (
        <PhoneSheet open={props.open} side="bottom" tall label="Needs you" testID="phone-needs-sheet" onClose={props.onClose}>
            <div className="mt-2 h-[5px] w-[38px] shrink-0 self-center rounded-[3px]" style={{ background: phoneStyle.raisedBorder }} />
            <div className="flex shrink-0 items-center pt-2 pr-2 pl-5">
                <h1 className="m-0 flex-1 text-[26px] font-bold tracking-[-0.4px]">Needs you</h1>
                <button
                    type="button"
                    data-testid="phone-needs-sheet-close"
                    aria-label="Close"
                    className="flex h-[44px] w-[44px] items-center justify-center"
                    style={{ color: tokens.textSecondary }}
                    onClick={props.onClose}
                >
                    <PhoneGlyph name="x" size={22} weight={2} />
                </button>
            </div>
            {hostsWaiting.length > 1 ? (
                <div role="group" aria-label="Filter by host" className="flex shrink-0 gap-2 overflow-x-auto px-4 pt-2 pb-1">
                    <Chip testID="phone-needs-filter-all" label="All" count={waiting.length} on={filter === null} onClick={() => setFilter(null)} />
                    {hostsWaiting.map((reading) => (
                        <Chip
                            key={reading.host.key}
                            testID={`phone-needs-filter-${reading.host.key}`}
                            label={reading.host.name}
                            count={waitingByHost.get(reading.host.key) ?? 0}
                            on={filter === reading.host.key}
                            onClick={() => setFilter(reading.host.key)}
                        />
                    ))}
                </div>
            ) : null}
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 pt-1 pb-4" data-testid="phone-needs-list">
                {waiting.length === 0 ? (
                    <span className="py-6 text-center text-[15px]" style={{ color: tokens.textSecondary }} data-testid="phone-needs-empty">
                        Nothing is waiting for you.
                    </span>
                ) : null}
                {shownHosts.map((reading) => {
                    const homeDirectory = reading.host.runtime.store.getState().daemon.state.homeDirectory;
                    return (
                        <div key={reading.host.key} className="flex flex-col gap-2" data-testid={`phone-needs-host-${reading.host.key}`}>
                            <div className="flex items-center gap-2 px-1 pt-[10px] text-[13px] font-semibold" style={{ color: tokens.textSecondary }}>
                                <PhoneGlyph name="server" size={14} weight={2} />
                                <span className="flex-1" style={{ color: tokens.textPrimary }}>
                                    {reading.host.name}
                                </span>
                                <span>{hostKindLabel(reading.host.kind)}</span>
                            </div>
                            {waiting
                                .filter((item) => item.hostKey === reading.host.key)
                                .map((item) => (
                                    <Card key={item.key} item={item} homeDirectory={homeDirectory} runtime={reading.host.runtime} onOpen={() => props.onOpen(item)} />
                                ))}
                        </div>
                    );
                })}
                {running.length > 0 ? (
                    <div className="mt-[6px] flex flex-col">
                        <button
                            type="button"
                            data-testid="phone-needs-running"
                            aria-expanded={runningOpen}
                            className="flex min-h-[52px] items-center gap-[10px] rounded-[14px] border px-[14px] text-left text-[15px]"
                            style={{ borderColor: phoneStyle.cardBorder, color: tokens.textPrimary }}
                            onClick={() => setRunningOpen((open) => !open)}
                        >
                            <span aria-hidden className="h-[8px] w-[8px] rounded-full" style={{ background: tokens.statusRunning }} />
                            <span className="flex-1">{`Running · ${String(running.length)}`}</span>
                            <span className="truncate text-[12px]" style={{ color: tokens.textSecondary }}>
                                {running
                                    .slice(0, 2)
                                    .map((item) => `${item.paneTitle} in ${item.workspaceName}`)
                                    .join(', ')}
                            </span>
                            <span className="flex" style={{ color: tokens.textTertiary }}>
                                <PhoneGlyph name={runningOpen ? 'chevron-up' : 'chevron-down'} size={16} weight={2} />
                            </span>
                        </button>
                        {runningOpen
                            ? running.map((item) => (
                                  <button
                                      key={item.key}
                                      type="button"
                                      data-testid={`phone-needs-running-${item.paneID}`}
                                      className="flex min-h-[48px] items-center gap-3 px-[14px] text-left text-[14px]"
                                      style={{ color: tokens.textPrimary }}
                                      onClick={() => props.onOpen(item)}
                                  >
                                      <span className="flex-1 truncate">{`${item.paneTitle} in ${item.workspaceName}`}</span>
                                      <span className="text-[12px]" style={{ color: tokens.textSecondary }}>
                                          {item.hostName}
                                      </span>
                                  </button>
                              ))
                            : null}
                    </div>
                ) : null}
            </div>
        </PhoneSheet>
    );
}
