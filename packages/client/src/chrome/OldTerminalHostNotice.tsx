/**
 * The notice for terminals still running on an older terminal host (#372,
 * `docs/terminal-host.md` §11).
 *
 * The daemon drains such a host by itself: it gets no new terminals and exits once its last one
 * ends. Until then it holds whatever its generation is being retired for, so the card offers the
 * other way out, restarting those terminals on the current host now, and says what that costs:
 * each shell starts again in its folder and its Claude or Codex session resumes, but anything
 * else running in it stops, and an agent mid-turn is interrupted. "Later" hides the card for that
 * host in this window; the drain carries on, and the palette brings the card back.
 */

import type { ReactElement } from 'react';
import type { WsOldTerminalHost } from '@kelpi/protocol';

import { tokens } from './tokens';

export interface OldTerminalHostNoticeProps {
    readonly hosts: readonly WsOldTerminalHost[];
    /** A restart is in flight: the button says so and does nothing. */
    readonly restarting: boolean;
    readonly onRestart: () => void;
    readonly onLater: () => void;
}

const count = (n: number, noun: string): string => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;

/** The card's words, apart from the markup so they can be checked without rendering. */
export function oldTerminalHostCopy(hosts: readonly WsOldTerminalHost[]): {
    readonly title: string;
    readonly body: string;
    readonly cost: string;
} {
    const terminals = hosts.reduce((total, host) => total + host.paneIDs.length, 0);
    const agents = hosts.reduce((total, host) => total + host.agents, 0);
    const busy = hosts.reduce((total, host) => total + host.busyAgents, 0);
    const reasons = [...new Set(hosts.map((host) => host.reason).filter((reason) => reason !== ''))].join('; ');
    const sessions = agents > 0 ? ` (${count(agents, 'agent session')})` : '';
    return {
        // Not the old host's version: one from before #372 reports a `-dev` version, not its release.
        title: 'Terminals on an older terminal host',
        body:
            `${count(terminals, 'terminal')}${sessions} ${terminals === 1 ? 'is' : 'are'} still running on a terminal host ` +
            `an earlier version of Kelpi started${reasons === '' ? '' : `, which ${reasons}`}. It closes by itself when they do.`,
        cost:
            'Restart them now to free what it holds: each shell starts again in its folder' +
            (agents > 0 ? ' and Claude and Codex sessions resume' : '') +
            '. Anything else running in them stops' +
            (busy > 0 ? `, and ${count(busy, 'agent')} working right now ${busy === 1 ? 'is' : 'are'} interrupted` : '') +
            '.'
    };
}

export function OldTerminalHostNotice(props: OldTerminalHostNoticeProps): ReactElement {
    const copy = oldTerminalHostCopy(props.hosts);
    return (
        <div
            data-testid="old-terminal-host-notice"
            role="status"
            className="flex max-w-[320px] items-start gap-2 rounded-md px-3 py-2"
            style={{
                background: tokens.surfaceBackground,
                border: '1px solid rgba(211, 163, 41, 0.45)',
                boxShadow: '0 8px 24px rgba(0,0,0,0.35)'
            }}
        >
            <svg viewBox="0 0 12 12" width={11} height={11} className="mt-[3px] shrink-0" aria-hidden>
                <path d="M6 1.4 11.2 10.6H0.8Z" fill="#D3A329" />
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
                <span className="break-words text-[11px]" style={{ color: tokens.textSecondary }}>
                    {copy.cost}
                </span>
                {/* The graft banner's pair (`GraftControls.tsx`): one recipe, the words carry the choice. */}
                <div className="flex justify-end gap-1.5 pt-1">
                    <button
                        type="button"
                        data-testid="old-terminal-host-later"
                        className="cursor-pointer rounded border px-2 py-0.5 text-[11px] disabled:cursor-default disabled:opacity-60"
                        style={{ borderColor: tokens.divider, color: tokens.textSecondary }}
                        disabled={props.restarting}
                        onClick={props.onLater}
                    >
                        Later
                    </button>
                    <button
                        type="button"
                        data-testid="old-terminal-host-restart"
                        className="cursor-pointer rounded border px-2 py-0.5 text-[11px] disabled:cursor-default disabled:opacity-60"
                        style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                        disabled={props.restarting}
                        onClick={props.onRestart}
                    >
                        {props.restarting ? 'Restarting…' : 'Restart terminals'}
                    </button>
                </div>
            </div>
        </div>
    );
}

const DISMISSED_KEY = 'kelpi.old-terminal-hosts.later';
/** Enough for every old host anyone will say "Later" to; the oldest answers go first. */
const MAX_REMEMBERED = 20;

/** A host by pid AND start: a pid alone may name a different host one day. */
export function oldHostKey(host: Pick<WsOldTerminalHost, 'pid' | 'startedAt'>): string {
    return `${String(host.pid)}@${host.startedAt ?? ''}`;
}

/**
 * The hosts this viewer said "Later" to (`oldHostKey`). Per viewer and best effort: storage can be
 * missing or refuse, and then the card simply shows again.
 */
export function readLaterOldHosts(): readonly string[] {
    try {
        const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(DISMISSED_KEY) ?? '[]');
        return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : [];
    } catch {
        return [];
    }
}

export function writeLaterOldHosts(keys: readonly string[]): void {
    try {
        globalThis.localStorage?.setItem(DISMISSED_KEY, JSON.stringify(keys.slice(-MAX_REMEMBERED)));
    } catch {
        // Not remembered: the card comes back next time, which is the safe side.
    }
}
