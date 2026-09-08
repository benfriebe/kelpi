/**
 * The phone's host tree: ONE hierarchy - hosts, each with its workspaces - drawn in the two places
 * the phone shows it, the drawer and the landing page (B9).
 *
 * **An owner-directed divergence from the shipped Swift app**, like every phone rule in this
 * program (there is no Swift phone UI; `chrome/form-factor.ts` says so once for all of it).
 *
 * Owner, on a real Android phone, 2026-09-08 (device round 11, everything else passed): *"It does
 * look weird with one sidebar showing all hosts, and one showing only workspaces from one host."*
 * B7 had built two side surfaces over two different levels of the same tree - a full-screen page
 * of host CARDS, and a drawer listing ONE host's workspaces with an `All hosts` row back to the
 * page - so the phone had two models of the same thing and a person had to hold both. B9 collapses
 * that into one model shown twice:
 *
 *   - `drawer`   every host as a collapsible section, the host whose workspace is on screen
 *                expanded and the others collapsed to their header. Tapping a workspace under any
 *                host switches host AND workspace in one move, so the drawer IS all hosts and the
 *                `All hosts` row is gone: there is nowhere else to go.
 *   - `landing`  the same hierarchy full-screen, every section expanded, because the landing page
 *                is where a person is CHOOSING and a choice you have to drill into twice is not
 *                one. The card look B7 gave a host stays, as the section header.
 *
 * The two presentations differ in look and in what a section starts expanded as, and in NOTHING
 * else: same sections, same headers, same counts, same rows, same Add host at the end. A row is
 * still the LOCAL sidebar's own `WorkspaceRow`/`GroupHeaderRow` (`chrome/Sidebar.tsx`) fed by
 * `selectSidebarEntries` over that host's store mirror, so a row on the phone is pixel-identical
 * to the same row on the Mac with one implementation to drift from (the choice B3 made and
 * `app/RemoteDaemonSections.tsx` made before it). What a row deliberately does NOT wire is the
 * desktop list's drag/multi-select/rename/context machinery: an unwired gesture is inert, never
 * half-working.
 *
 * Which sections are expanded is CLIENT-LOCAL and remembered on the phone (`phone/view.ts`
 * `usePhoneHostExpansion`, beside the view mode and the host list): expanding a host is a fact
 * about this phone's screen, never about any daemon. The tree itself writes NOTHING anywhere -
 * picking a workspace is the shell's `onSelect`, the same verb both surfaces already used, and the
 * daemon's own group-collapse state is the one thing a row toggle sends (see the group header
 * below, which is the desktop's behaviour unchanged).
 */

import { type ReactElement } from 'react';
import { useStore } from 'zustand';

import { ChromeIcon } from '../chrome/icons';
import { agentCounts, groupGuideColor, GroupHeaderRow, WorkspaceRow } from '../chrome/Sidebar';
import type { ChromeBucket } from '../chrome/theme';
import { tokens } from '../chrome/tokens';
import type { ChromeLabelPreset, ChromeWorkspace } from '../chrome/types';
import type { ConnectionStatus } from '../connection';
import { selectSidebarEntries } from '../state';
import type { PhoneHostModel, PhoneWorkspaceSelection } from './model';
import { PHONE_ROW_MIN_PX, PHONE_SAFE_AREA, PhoneButton } from './ui';
import type { PhoneHostExpansion } from './view';

/** Where the tree is being drawn. The only two things it changes are the look and the default. */
export type PhoneHostTreePresentation = 'drawer' | 'landing';

export interface PhoneHostTreeProps {
    readonly presentation: PhoneHostTreePresentation;
    readonly hosts: readonly PhoneHostModel[];
    readonly selection: PhoneWorkspaceSelection | null;
    readonly bucket: ChromeBucket;
    /**
     * The host whose workspace is on screen. The DRAWER expands it by default (you opened the
     * drawer from inside it, so its workspaces are what you are most likely reaching for); the
     * landing page ignores it, because everything is expanded there.
     */
    readonly currentHostKey?: string | undefined;
    readonly expansion: PhoneHostExpansion;
    readonly onSelect: (selection: PhoneWorkspaceSelection) => void;
    readonly onAddHost: () => void;
    readonly onRemoveHost: (hostKey: string) => void;
}

/**
 * The test ids each presentation keeps.
 *
 * One component, two vocabularies on purpose: the drawer's ids (`phone-host-*`) and the landing
 * page's (`phone-landing-*`) are what the jsdom suite and the audit's `phone-shell` and
 * `phone-landing` steps already name their surfaces by, and a step that says `phone-landing-host-…`
 * is naming the screen it is driving rather than the component underneath. The SHAPE is identical,
 * which is the point being made.
 */
interface TreeIDs {
    readonly root: string;
    readonly section: string;
    readonly toggle: string;
    readonly status: string;
    readonly summary: string;
    readonly body: string;
    readonly remove: string;
    readonly addHost: string;
}

const TREE_IDS: Readonly<Record<PhoneHostTreePresentation, TreeIDs>> = {
    drawer: {
        root: 'phone-host-list',
        section: 'phone-host',
        toggle: 'phone-host-toggle',
        status: 'phone-host-status',
        summary: 'phone-host-summary',
        body: 'phone-host-body',
        remove: 'phone-host-remove',
        addHost: 'phone-add-host'
    },
    landing: {
        root: 'phone-landing-hosts',
        section: 'phone-landing-host',
        toggle: 'phone-landing-toggle',
        status: 'phone-landing-status',
        summary: 'phone-landing-summary',
        body: 'phone-landing-body',
        remove: 'phone-landing-remove',
        addHost: 'phone-landing-add-host'
    }
};

/** The dot beside a host's name: the sidebar's own status colours. */
export function connectionDotColor(status: ConnectionStatus): string {
    if (status === 'connected') return tokens.statusRunning;
    if (status === 'connecting' || status === 'reconnecting') return tokens.activeAgent;
    return tokens.statusInactive;
}

/**
 * The words a host's header puts beside its dot when there are no counts to put there yet.
 *
 * `reconnecting…` is the one a host that cannot be reached actually settles on, not `unreachable`:
 * a socket whose dial fails schedules another with backoff (`connection/socket.ts`
 * `scheduleReconnect`) and sits in `reconnecting` between the attempts, while `closed` is what a
 * socket that was deliberately stopped reports. Both are said plainly rather than collapsed into
 * one word, because "still trying" and "given up" are different news.
 */
export function reachabilityLabel(status: ConnectionStatus): string {
    if (status === 'connected') return 'reachable';
    if (status === 'connecting') return 'connecting…';
    if (status === 'reconnecting') return 'reconnecting…';
    if (status === 'rejected') return 'refused';
    return 'unreachable';
}

const noop = (): void => {};

/**
 * One host's workspaces and groups, as the local sidebar's own rows.
 *
 * B7 had this as an exported `PhoneHostWorkspaceList` so the landing page could reuse the drawer's
 * rows; B9 folds it back in, because both surfaces now go through this file and there is nothing
 * left outside it that draws a host's workspaces.
 */
function HostWorkspaceList(props: {
    readonly host: PhoneHostModel;
    readonly testID: string;
    readonly selection: PhoneWorkspaceSelection | null;
    readonly bucket: ChromeBucket;
    readonly onSelect: (selection: PhoneWorkspaceSelection) => void;
}): ReactElement {
    const { host } = props;
    const entries = useStore(host.runtime.store, selectSidebarEntries);
    const presets = useStore(host.runtime.store, (state) => state.daemon.state.labelPresets);

    const activate = (workspaceID: string): void => {
        // One move: the shell reads the HOST off the selection too, so a tap under a host that is
        // not the one on screen switches host and workspace together (B9's rule).
        props.onSelect({ host: host.key, workspaceID });
    };

    const row = (
        workspace: ChromeWorkspace,
        options: {
            depth: 0 | 1;
            groupID?: string;
            guideColor?: string;
            guideExtendUp?: boolean;
            guideExtendDown?: boolean;
        }
    ): ReactElement => (
        <WorkspaceRow
            key={workspace.id}
            workspace={workspace}
            depth={options.depth}
            {...(options.groupID === undefined ? {} : { groupID: options.groupID })}
            active={
                props.selection !== null &&
                props.selection.host === host.key &&
                props.selection.workspaceID === workspace.id
            }
            selected={false}
            badgeIndex={-1}
            bucket={props.bucket}
            presets={presets as readonly ChromeLabelPreset[]}
            renaming={false}
            dragging={false}
            groupCaption={null}
            {...(options.guideColor === undefined ? {} : { guideColor: options.guideColor })}
            {...(options.guideExtendUp === undefined ? {} : { guideExtendUp: options.guideExtendUp })}
            {...(options.guideExtendDown === undefined ? {} : { guideExtendDown: options.guideExtendDown })}
            onActivate={activate}
            onContextMenu={noop}
            onDragStart={noop}
            onCommitRename={noop}
            onCancelRename={noop}
            registerRow={noop}
        />
    );

    return (
        <div className="flex flex-col pb-1" data-testid={props.testID}>
            {entries.map((entry) => {
                if (entry.kind === 'workspace') return row(entry.workspace as ChromeWorkspace, { depth: 0 });
                const group = entry.group;
                const guide = groupGuideColor(group.color, props.bucket);
                return (
                    <div key={group.id} className="flex flex-col" data-testid={`phone-group-${host.key}-${group.id}`}>
                        <GroupHeaderRow
                            group={group}
                            collapsed={group.isCollapsed}
                            counts={agentCounts(entry.workspaces as readonly ChromeWorkspace[])}
                            bucket={props.bucket}
                            renaming={false}
                            dropPreview={false}
                            onToggle={(groupID) => {
                                // The daemon's own persisted collapse state, over that host's
                                // connection; the mirror echoes it back. A GROUP is the daemon's,
                                // a HOST section is this phone's (`phone/view.ts`) - the two
                                // collapses look alike and belong to different owners.
                                void host.runtime.commands.setGroupCollapsed({ groupID, collapsed: !group.isCollapsed });
                            }}
                            onContextMenu={noop}
                            onDragStart={noop}
                            onCommitRename={noop}
                            onCancelRename={noop}
                            registerRow={noop}
                        />
                        {group.isCollapsed
                            ? null
                            : entry.workspaces.map((workspace, index) =>
                                  row(workspace as ChromeWorkspace, {
                                      depth: 1,
                                      groupID: group.id,
                                      guideColor: guide,
                                      guideExtendUp: index > 0,
                                      guideExtendDown: index < entry.workspaces.length - 1
                                  })
                              )}
                    </div>
                );
            })}
        </div>
    );
}

/**
 * One host: a header that says what a person picks a host BY, and its workspaces under it.
 *
 * The header carries the same three facts in both presentations - name, reachability dot, and how
 * much is running there - because they are what the owner's B7 card carried and what a collapsed
 * section has to answer on its own. Counts come from that host's OWN store mirror, and a host
 * whose snapshot has not landed says where it is up to instead of a confident zero: "0 workspaces"
 * on a host nobody has heard from reads as "nothing is running there".
 */
function HostSection(props: {
    readonly host: PhoneHostModel;
    readonly ids: TreeIDs;
    readonly landing: boolean;
    readonly expanded: boolean;
    readonly selection: PhoneWorkspaceSelection | null;
    readonly bucket: ChromeBucket;
    readonly onToggle: () => void;
    readonly onSelect: (selection: PhoneWorkspaceSelection) => void;
    readonly onRemove: (() => void) | null;
}): ReactElement {
    const { host, ids, landing, expanded } = props;
    const connection = useStore(host.runtime.store, (state) => state.ui.connection);
    const workspaces = useStore(host.runtime.store, (state) => state.daemon.state.workspaces);
    const known = useStore(host.runtime.store, (state) => state.daemon.hasSnapshot);
    const counts = agentCounts(workspaces as unknown as readonly ChromeWorkspace[]);
    const summary = known
        ? [
              `${String(workspaces.length)} ${workspaces.length === 1 ? 'workspace' : 'workspaces'}`,
              counts.running > 0 ? `${String(counts.running)} running` : null,
              counts.waiting > 0 ? `${String(counts.waiting)} waiting` : null
          ]
              .filter((part) => part !== null)
              .join(' · ')
        : reachabilityLabel(connection);

    return (
        <div
            className={landing ? 'flex shrink-0 flex-col overflow-hidden rounded-lg' : 'flex shrink-0 flex-col'}
            data-testid={`${ids.section}-${host.key}`}
            data-host-kind={host.kind}
            data-status={connection}
            data-expanded={expanded ? 'true' : 'false'}
            style={landing ? { background: tokens.surfaceBackground, border: `1px solid ${tokens.divider}` } : undefined}
        >
            <div className="flex items-center" style={{ minHeight: `${String(PHONE_ROW_MIN_PX)}px` }}>
                <button
                    type="button"
                    data-testid={`${ids.toggle}-${host.key}`}
                    aria-expanded={expanded}
                    aria-label={`${host.name} workspaces`}
                    className={`flex min-w-0 flex-1 flex-col justify-center text-left ${landing ? 'gap-1 px-4 py-3' : 'gap-0.5 px-3 py-1'}`}
                    style={{ minHeight: `${String(PHONE_ROW_MIN_PX)}px` }}
                    onClick={props.onToggle}
                >
                    <span className="flex min-w-0 items-center gap-2">
                        <span style={{ color: tokens.textTertiary }} className="flex shrink-0 items-center">
                            <ChromeIcon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
                        </span>
                        <span
                            aria-hidden
                            className="h-[8px] w-[8px] shrink-0 rounded-full"
                            data-testid={`${ids.status}-${host.key}`}
                            data-status={connection}
                            style={{ background: connectionDotColor(connection) }}
                        />
                        {landing ? (
                            <span className="truncate text-[16px] font-semibold" style={{ color: tokens.textPrimary }}>
                                {host.name}
                            </span>
                        ) : (
                            <span
                                className="truncate text-[12px] font-semibold uppercase tracking-wide"
                                style={{ color: tokens.textSecondary }}
                            >
                                {host.name}
                            </span>
                        )}
                    </span>
                    {/* Lined up under the name, past the chevron and the dot (12 + 8 + 8 + 8 px). */}
                    <span
                        className={`truncate pl-9 ${landing ? 'text-[12px]' : 'text-[11px]'}`}
                        data-testid={`${ids.summary}-${host.key}`}
                        style={{ color: landing ? tokens.textSecondary : tokens.textTertiary }}
                    >
                        {summary}
                    </span>
                </button>
                {/* Only the phone's OWN entries can be removed; the origin is the page. */}
                {props.onRemove === null ? null : (
                    <PhoneButton testID={`${ids.remove}-${host.key}`} ariaLabel={`Remove ${host.name}`} onClick={props.onRemove}>
                        <ChromeIcon name="clear" size={12} />
                    </PhoneButton>
                )}
            </div>
            {expanded ? (
                <HostWorkspaceList
                    host={host}
                    testID={`${ids.body}-${host.key}`}
                    selection={props.selection}
                    bucket={props.bucket}
                    onSelect={props.onSelect}
                />
            ) : null}
        </div>
    );
}

/** Hosts, each with its workspaces, and Add host at the end. */
export function PhoneHostTree(props: PhoneHostTreeProps): ReactElement {
    const landing = props.presentation === 'landing';
    const ids = TREE_IDS[props.presentation];

    return (
        <div
            data-testid={ids.root}
            data-phone-tree={props.presentation}
            className={landing ? 'flex flex-col gap-2 p-3' : 'flex min-h-0 flex-1 flex-col overflow-y-auto py-1'}
            style={landing ? { paddingBottom: PHONE_SAFE_AREA.bottom } : undefined}
        >
            {props.hosts.map((host) => {
                // The default, per presentation: everything on the landing page, the host you are
                // in on the drawer. An explicit tap outranks it and is remembered (`phone/view.ts`).
                const byDefault = landing || host.key === props.currentHostKey;
                return (
                    <HostSection
                        key={host.key}
                        host={host}
                        ids={ids}
                        landing={landing}
                        expanded={props.expansion.isExpanded(host.key, byDefault)}
                        selection={props.selection}
                        bucket={props.bucket}
                        onToggle={() => props.expansion.toggle(host.key, byDefault)}
                        onSelect={props.onSelect}
                        onRemove={host.removable ? () => props.onRemoveHost(host.key) : null}
                    />
                );
            })}
            {/* Add host at the END of the hosts, in both places: it is the last row of the list
                it belongs to, not a verb parked in a toolbar. */}
            <div className={landing ? 'flex' : 'flex px-1'}>
                <PhoneButton testID={ids.addHost} onClick={props.onAddHost}>
                    <ChromeIcon name="plus" size={12} />
                    Add host
                </PhoneButton>
            </div>
        </div>
    );
}
