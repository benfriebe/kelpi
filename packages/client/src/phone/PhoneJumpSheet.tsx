/**
 * Jump to…: one field that finds a workspace or a pane on ANY host by name.
 *
 * The picker walks the tree one level at a time from where the person is; this is the other way
 * in, for when they know what they want and not where it lives. Matches are by name, a workspace's
 * or a pane's display title, case-insensitive, the matched part in bold. Picking a workspace opens
 * it; picking a pane opens its workspace and focuses it, on whichever host it is on.
 */

import { useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';

import type { ChromeBucket } from '../chrome/theme';
import { tokens } from '../chrome/tokens';
import { homeAbbreviated } from '../grid';
import type { PhoneHostReading } from './fleet';
import { PhoneGlyph } from './glyphs';
import { GlyphTile, HostDot, WaitingBadge, WorkspaceAvatar, paneTypeGlyph, phonePaneTitle } from './parts';
import { phoneStyle } from './style';
import { PhoneSheet } from './ui';

export interface PhoneJumpSheetProps {
    readonly open: boolean;
    readonly fleet: readonly PhoneHostReading[];
    readonly bucket: ChromeBucket;
    readonly onWorkspace: (hostKey: string, workspaceID: string) => void;
    readonly onPane: (hostKey: string, workspaceID: string, paneID: string) => void;
    readonly onClose: () => void;
}

const MAX_RESULTS = 20;

function Highlight(props: { readonly text: string; readonly query: string }): ReactElement {
    const at = props.text.toLowerCase().indexOf(props.query.toLowerCase());
    if (props.query.length === 0 || at < 0) return <>{props.text}</>;
    return (
        <>
            {props.text.slice(0, at)}
            <strong className="font-bold" style={{ color: tokens.textPrimary }}>
                {props.text.slice(at, at + props.query.length)}
            </strong>
            {props.text.slice(at + props.query.length)}
        </>
    );
}

function ResultRow(props: { readonly testID: string; readonly lead: ReactNode; readonly title: ReactNode; readonly sub: string; readonly host: PhoneHostReading; readonly badge?: string | undefined; readonly onClick: () => void }): ReactElement {
    return (
        <button
            type="button"
            data-testid={props.testID}
            className="flex min-h-[56px] w-full min-w-0 items-center gap-3 rounded-[12px] px-[10px] text-left"
            style={{ color: tokens.textPrimary }}
            onClick={props.onClick}
        >
            {props.lead}
            <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                <span className="truncate text-[15px]" style={{ color: tokens.textSecondary }}>
                    {props.title}
                </span>
                <span className="truncate text-[12px]" style={{ color: tokens.textSecondary }}>
                    {props.sub}
                </span>
            </span>
            {props.badge === undefined ? null : <WaitingBadge>{props.badge}</WaitingBadge>}
            <span className="flex shrink-0 items-center gap-[5px] text-[12px]" style={{ color: tokens.textSecondary }}>
                <HostDot status={props.host.connection} size={6} />
                {props.host.host.name}
            </span>
        </button>
    );
}

export function PhoneJumpSheet(props: PhoneJumpSheetProps): ReactElement | null {
    const [query, setQuery] = useState('');
    const field = useRef<HTMLInputElement | null>(null);

    // Focused in the commit the tap made, not a frame later: iOS raises the keyboard only for a
    // focus that happens inside the gesture's own task.
    useLayoutEffect(() => {
        if (!props.open) return;
        setQuery('');
        field.current?.focus();
    }, [props.open]);

    const results = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const workspaces: ReactElement[] = [];
        const panes: ReactElement[] = [];
        if (needle.length === 0) return { workspaces, panes };
        for (const reading of props.fleet) {
            const homeDirectory = reading.host.runtime.store.getState().daemon.state.homeDirectory;
            for (const workspace of reading.workspaces) {
                if (workspaces.length < MAX_RESULTS && workspace.name.toLowerCase().includes(needle)) {
                    const waiting = workspace.muted ? 0 : workspace.panes.filter((pane) => pane.status === 'waitingForInput').length;
                    workspaces.push(
                        <ResultRow
                            key={`${reading.host.key}/${workspace.id}`}
                            testID={`phone-jump-workspace-${workspace.id}`}
                            lead={<WorkspaceAvatar workspace={workspace} bucket={props.bucket} />}
                            title={<Highlight text={workspace.name} query={query.trim()} />}
                            sub={`${String(workspace.panes.length)} pane${workspace.panes.length === 1 ? '' : 's'}`}
                            host={reading}
                            badge={waiting > 0 ? `${String(waiting)} waiting` : undefined}
                            onClick={() => props.onWorkspace(reading.host.key, workspace.id)}
                        />
                    );
                }
                for (const pane of workspace.panes) {
                    const title = phonePaneTitle(pane, homeDirectory);
                    if (panes.length >= MAX_RESULTS || !title.toLowerCase().includes(needle)) continue;
                    const where = pane.workingDirectory === null ? '' : ` · ${homeAbbreviated(pane.workingDirectory, homeDirectory)}`;
                    panes.push(
                        <ResultRow
                            key={`${reading.host.key}/${pane.id}`}
                            testID={`phone-jump-pane-${pane.id}`}
                            lead={<GlyphTile name={paneTypeGlyph(pane)} waiting={pane.status === 'waitingForInput' && !workspace.muted} />}
                            title={<Highlight text={title} query={query.trim()} />}
                            sub={`in ${workspace.name}${where}`}
                            host={reading}
                            badge={pane.status === 'waitingForInput' && !workspace.muted ? 'waiting' : undefined}
                            onClick={() => props.onPane(reading.host.key, workspace.id, pane.id)}
                        />
                    );
                }
            }
        }
        return { workspaces, panes };
    }, [query, props]);

    return (
        <PhoneSheet open={props.open} side="bottom" tall label="Jump to" testID="phone-jump-sheet" onClose={props.onClose}>
            <div className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-2">
                <label className="flex h-[44px] min-w-0 flex-1 items-center gap-2 rounded-[12px] border px-3" style={{ background: phoneStyle.sunken, borderColor: phoneStyle.cardBorder, color: tokens.textSecondary }}>
                    <PhoneGlyph name="search" size={18} />
                    <input
                        ref={field}
                        data-testid="phone-jump-field"
                        aria-label="Jump to a host, workspace or pane"
                        placeholder="Workspace or pane"
                        className="min-w-0 flex-1 bg-transparent text-[16px] outline-none"
                        style={{ color: tokens.textPrimary }}
                        value={query}
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        onChange={(event) => setQuery(event.target.value)}
                    />
                </label>
                <button type="button" data-testid="phone-jump-cancel" className="h-[44px] px-2 text-[15px]" style={{ color: tokens.accent }} onClick={props.onClose}>
                    Cancel
                </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-4" data-testid="phone-jump-results">
                {query.trim().length > 0 && results.workspaces.length === 0 && results.panes.length === 0 ? (
                    <span className="px-3 py-6 text-center text-[14px]" style={{ color: tokens.textSecondary }}>
                        {`Nothing called “${query.trim()}” on any host.`}
                    </span>
                ) : null}
                {results.workspaces.length > 0 ? (
                    <h3 className="m-0 px-3 pt-3 pb-1 text-[12px] font-semibold tracking-[0.6px] uppercase" style={{ color: tokens.textSecondary }}>
                        Workspaces
                    </h3>
                ) : null}
                {results.workspaces}
                {results.panes.length > 0 ? (
                    <h3 className="m-0 px-3 pt-3 pb-1 text-[12px] font-semibold tracking-[0.6px] uppercase" style={{ color: tokens.textSecondary }}>
                        Panes
                    </h3>
                ) : null}
                {results.panes}
            </div>
        </PhoneSheet>
    );
}
