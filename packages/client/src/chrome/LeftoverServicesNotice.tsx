/**
 * The corner card for services left running after their worktree was deleted
 * (docs/running-services.md §7, D7: "only for stacks with no workspace at all"). It sits with the
 * toasts, drawn by this page and by the shell's corner layer like `OldTerminalHostNotice`, and
 * offers Later (this viewer, until another worktree's stacks are left behind), Review (the status
 * bar's services popover) and Stop all (the stop dialog, which asks again).
 */

import type { ReactElement } from 'react';
import type { RunningServiceEntry } from '@kelpi/protocol';

import { leftoverGroups, memoryText } from './running';
import { tokens } from './tokens';

/** How long a leftover stack must have been listed before the card counts it (a delete may be stopping it). */
export const LEFTOVER_GRACE_MS = 60_000;

/**
 * What the card shows, or null for no card: the groups of `unattached` services whose worktree
 * folder is gone (a server in a repo's main checkout no workspace owns is `unattached` too, and
 * deliberate), counting only stacks listed for `LEFTOVER_GRACE_MS` (`firstSeen` is updated here,
 * by service id), and never one this viewer said Later to: a new worktree's stacks bring the card
 * back for them alone, so Stop all never reaches what the user chose to keep.
 */
export function leftoverCardGroups(
    services: readonly RunningServiceEntry[],
    firstSeen: Map<string, number>,
    later: readonly string[],
    now: number,
    memory: (services: readonly RunningServiceEntry[]) => number | null
): { readonly groups: readonly LeftoverGroupSummary[]; readonly services: readonly RunningServiceEntry[] } | null {
    const unattached = services.filter((service) => service.category === 'unattached');
    for (const service of unattached) if (!firstSeen.has(service.id)) firstSeen.set(service.id, now);
    for (const id of [...firstSeen.keys()]) if (!unattached.some((service) => service.id === id)) firstSeen.delete(id);
    const groups = leftoverGroups(unattached)
        .filter((group) => group.deleted && group.folder !== null && !later.includes(group.key))
        .filter((group) => group.services.some((service) => now - (firstSeen.get(service.id) ?? now) >= LEFTOVER_GRACE_MS));
    if (groups.length === 0) return null;
    return {
        groups: groups.map((group) => ({
            key: group.key,
            name: (group.folder ?? '').split('/').filter((part) => part !== '').pop() ?? group.key,
            stacks: group.services.length,
            memory: memory(group.services)
        })),
        services: groups.flatMap((group) => group.services)
    };
}

/** One deleted worktree's stacks, as the card counts them. Plain data: it crosses to the layer. */
export interface LeftoverGroupSummary {
    /** The worktree's folder: what Later remembers. */
    readonly key: string;
    readonly name: string;
    readonly stacks: number;
    /** Their memory, when Docker's stats or `ps` had it. */
    readonly memory: number | null;
}

export interface LeftoverServicesNoticeProps {
    readonly groups: readonly LeftoverGroupSummary[];
    /** False where nothing could open the popover (no status bar): no Review button. */
    readonly canReview: boolean;
    readonly onLater: () => void;
    readonly onReview: () => void;
    readonly onStop: () => void;
}

/** The card's words, apart from the markup so they can be checked without rendering. */
export function leftoverCopy(groups: readonly LeftoverGroupSummary[]): { readonly title: string; readonly body: string } {
    const stacks = groups.reduce((sum, group) => sum + group.stacks, 0);
    const memory = groups.reduce((sum, group) => sum + (group.memory ?? 0), 0);
    const from = groups.length === 1 ? (groups[0]?.name ?? 'a deleted worktree') : `${String(groups.length)} deleted worktrees`;
    return {
        title: 'Left running after their worktree was deleted',
        body: `${String(stacks)} ${stacks === 1 ? 'stack' : 'stacks'} from ${from} ${stacks === 1 ? 'is' : 'are'} still running${memory > 0 ? ` (${memoryText(memory)})` : ''}.`
    };
}

const BUTTON = 'cursor-pointer rounded border px-2 py-0.5 text-[11px]';

export function LeftoverServicesNotice(props: LeftoverServicesNoticeProps): ReactElement {
    const copy = leftoverCopy(props.groups);
    return (
        <div
            data-testid="leftover-services-notice"
            role="status"
            className="flex max-w-[320px] items-start gap-2 rounded-md px-3 py-2"
            style={{
                background: tokens.surfaceBackground,
                border: '1px solid rgba(232, 153, 74, 0.45)',
                boxShadow: '0 8px 24px rgba(0,0,0,0.35)'
            }}
        >
            <svg viewBox="0 0 12 12" width={11} height={11} className="mt-[3px] shrink-0" aria-hidden>
                <path d="M6 1.4 11.2 10.6H0.8Z" fill="#E8994A" />
                <path d="M6 4.6v2.6" stroke="#1A1A1E" strokeWidth={1.1} strokeLinecap="round" />
                <circle cx="6" cy="8.9" r="0.6" fill="#1A1A1E" />
            </svg>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-[12px] font-medium" style={{ color: tokens.textPrimary }}>
                    {copy.title}
                </span>
                <span className="break-words text-[11px]" style={{ color: tokens.textSecondary }}>
                    {copy.body}
                </span>
                <div className="flex justify-end gap-1.5 pt-1">
                    <button
                        type="button"
                        data-testid="leftover-services-later"
                        className={BUTTON}
                        style={{ borderColor: tokens.divider, color: tokens.textSecondary }}
                        onClick={props.onLater}
                    >
                        Later
                    </button>
                    {props.canReview ? (
                        <button
                            type="button"
                            data-testid="leftover-services-review"
                            className={BUTTON}
                            style={{ borderColor: tokens.divider, color: tokens.textSecondary }}
                            onClick={props.onReview}
                        >
                            Review
                        </button>
                    ) : null}
                    <button
                        type="button"
                        data-testid="leftover-services-stop"
                        className={BUTTON}
                        style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                        onClick={props.onStop}
                    >
                        Stop all
                    </button>
                </div>
            </div>
        </div>
    );
}

/** When the next stack listed in `firstSeen` comes out of its grace, or null when none is waiting. */
export function nextLeftoverGraceAt(firstSeen: ReadonlyMap<string, number>, now: number): number | null {
    const waiting = [...firstSeen.values()].map((seen) => seen + LEFTOVER_GRACE_MS).filter((at) => at > now);
    return waiting.length === 0 ? null : Math.min(...waiting);
}

const LATER_KEY = 'kelpi.leftover-services.later';
const MAX_REMEMBERED = 20;

/** The worktrees this viewer said Later to. Best effort: storage can refuse, then the card shows. */
export function readLaterLeftovers(): readonly string[] {
    try {
        const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(LATER_KEY) ?? '[]');
        return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : [];
    } catch {
        return [];
    }
}

export function writeLaterLeftovers(keys: readonly string[]): void {
    try {
        globalThis.localStorage?.setItem(LATER_KEY, JSON.stringify(keys.slice(-MAX_REMEMBERED)));
    } catch {
        // Not remembered: the card comes back next time, which is the safe side.
    }
}
