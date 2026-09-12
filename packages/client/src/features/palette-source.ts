/**
 * The palette's item universe and its dispatch, lifted out of assembly.
 *
 * `App.tsx` used to build the palette's command rows as `PaletteItem`s that CARRIED THEIR OWN
 * `run` closure, and `CommandPalette` invoked it. That made the presenter the executor: the
 * component that renders a row decided what happens when the row is picked, so no caller could
 * be re-validated at activation time, and no presenter other than the bundled one could ever be
 * handed the list (a closure does not cross a plugin boundary).
 *
 * This source is the `features/chrome-source.ts` shape applied to the palette:
 *
 *   - `snapshot()` emits **descriptors only**: strings, booleans and nulls. Every `run` closure
 *     stays private to this module, keyed by the descriptor's id.
 *   - `execute(itemID, target)` re-resolves that id against a FRESH read (the daemon mirror for
 *     workspace/pane rows, the live contribution registry for plugin rows) and refuses anything
 *     that has since gone away, turned disabled, or no longer matches the caller's target. It is
 *     the only place a palette row runs, and it runs it at most once.
 *
 * The verbs themselves are unchanged (same ids, same titles, same subtitles, same shortcut hints,
 * same order: plugin `palette` menus first, then the native verbs), because the palette's own tests
 * and the audit's steps read them by title.
 */

import type { KelpiAction } from '@kelpi/core/config';
import type { JsonObject } from '@kelpi/protocol';

import { buildPaletteItems, type PaletteItem } from '../chrome/palette';
import type { InteractionPaletteSource, InteractionPaletteSourceSnapshot } from '../interaction/contract';
import type { usePluginCommands } from '../plugins/commands';
import type { KelpiRuntime } from '../state';

/**
 * The native verbs the palette dispatches. Structurally a subset of assembly's `act`, so App
 * passes `act` itself. Each returns `false` when it could not act (no focused pane, no active
 * workspace); that is not an error, and `execute` stays silent about it, exactly as the palette
 * has always been.
 */
export interface PaletteFeatureActions {
    splitFocused(direction: 'horizontal' | 'vertical'): boolean;
    closeFocused(): boolean;
    reopenClosedPane(): boolean;
    createScratchpad(): boolean;
    toggleSearch(): boolean;
    toggleZoomFocused(): boolean;
    cycleLayout(): boolean;
    toggleSyncInput(): boolean;
    newWorkspace(): boolean;
}

export interface PaletteFeatureHost {
    readonly runtime: KelpiRuntime;
    /** The live contribution registry; `menu('palette')` is re-read on every snapshot and dispatch. */
    readonly plugins: ReturnType<typeof usePluginCommands>;
    /**
     * Change notification for the half of the universe that is NOT in the daemon mirror.
     *
     * Plugin contributions live in `plugins/contributions.ts`'s own store, so a `when`/`enablement`
     * flip, a disable, a reload or a newly contributed `palette` menu moves the list without
     * touching `runtime.store` at all. At 44292eb the palette was live across those because the
     * item array was a `useMemo` over `pluginCommands.commands` and assembly re-rendered; a source
     * that watched only the mirror would leave an open palette showing stale rows.
     */
    readonly subscribeContributions: (listener: () => void) => () => void;
    readonly actions: PaletteFeatureActions;
    /** The binding map's hint for an action (`⌘P`), so a rebound chord shows the chord it is now. */
    readonly shortcut: (action: KelpiAction) => string | undefined;
    readonly openSettings: (tab?: 'plugins') => void;
    /** §8.5: activation comes first, and it is the call that also leaves remote mode. */
    readonly activateWorkspace: (workspaceID: string) => void;
    readonly focusPane: (workspaceID: string, paneID: string | null) => void;
    /** For `homeAbbreviated`; the wire strips the daemon's home dir, so '' is the honest default. */
    readonly homeDirectory?: string | undefined;
}

/**
 * Aliased to the contract rather than redeclared, so a drift between `PaletteItem` and
 * `InteractionPaletteItem` is a compile error here and not a runtime surprise in the surface.
 * (`chrome/palette.ts`'s `PaletteItem` IS the serializable projection now, so the two coincide.)
 */
export type PaletteSourceSnapshot = InteractionPaletteSourceSnapshot;
/** What the window interaction surface holds: a feed, a read model, and one dispatch door. */
export type PaletteFeatureSource = InteractionPaletteSource;

/**
 * The host, or a getter for it.
 *
 * `App` creates the source at the TOP of its render body, because the surface it is handed to is
 * created there and `InteractionSurfaceConfig.palette` must be identity-stable, while half of what
 * the host reads (the contribution registry, the action table, the binding hints) is only built
 * further down. The getter form is what lets one stable source read the latest render's host, the
 * same indirection `useInteractionSurface` uses for its own config; it may answer `null` until
 * assembly has filled it in.
 */
export type PaletteFeatureHostRef = PaletteFeatureHost | (() => PaletteFeatureHost | null);

/** A descriptor and the closure that stays behind. Only the descriptor ever leaves this module. */
interface PaletteEntry {
    readonly item: PaletteItem;
    /** `false` means "could not run"; `void` is a verb with nothing to report. */
    readonly run: () => boolean | void;
    /**
     * Whether a `false` from `run` is worth reporting.
     *
     * A CONTRIBUTION answering false has vanished between the read and the dispatch (its plugin was
     * disabled, failed or reloaded, or its `enablement` turned false), which is the same refusal
     * `chrome-source` reports for a stale plugin menu. A NATIVE verb answering false simply had
     * nothing to act on, which is the ordinary case of picking "Find in Pane…" with no focused
     * pane: the palette was silent there before this module existed and stays silent now.
     */
    readonly reportsRefusal?: boolean | undefined;
}

function commandEntry(
    id: string,
    icon: string,
    title: string,
    subtitle: string,
    shortcut: string | undefined,
    run: () => boolean | void
): PaletteEntry {
    return {
        item: {
            id,
            kind: 'command',
            icon,
            title,
            subtitle,
            workspaceID: null,
            workspaceName: '',
            paneID: null,
            workspaceColor: null,
            ...(shortcut === undefined ? {} : { shortcut })
        },
        run
    };
}

export function createPaletteFeatureSource(ref: PaletteFeatureHostRef): PaletteFeatureSource {
    const read = (): PaletteFeatureHost | null => (typeof ref === 'function' ? ref() : ref);
    /** Every dispatch path re-reads the host, so a stale render's registry cannot be called. */
    const liveHost = (): PaletteFeatureHost => {
        const host = read();
        if (host === null) throw new Error('The command palette is not ready in this window.');
        return host;
    };
    const home = (): string => read()?.homeDirectory ?? '';

    /**
     * Rebuilt on every read, exactly as `chrome-source`'s `commands()` is: a descriptor whose
     * `disabled` flag was computed one render ago is a lie the moment a contribution's `when`
     * changes, and `execute` is only honest if it re-runs this.
     */
    const entries = (host: PaletteFeatureHost): PaletteEntry[] => {
        const act = host.actions;
        const hint = (action: KelpiAction): string | undefined => host.shortcut(action);
        return [
            ...host.plugins.menu('palette').map((menu): PaletteEntry => ({
                item: {
                    id: menu.id,
                    kind: 'command',
                    icon: 'rectangle.stack',
                    title: menu.title,
                    subtitle: menu.pluginName,
                    workspaceID: null,
                    workspaceName: '',
                    paneID: null,
                    workspaceColor: null,
                    disabled: !menu.enabled,
                    ...(menu.shortcut === undefined ? {} : { shortcut: menu.shortcut })
                },
                // `runMenu` re-resolves the contribution against the CURRENT plugin set and returns
                // false for a plugin that was disabled, failed, reloaded or lost its `enablement`.
                run: () => menu.run(),
                reportsRefusal: true
            })),
            commandEntry('cmd:plugins', 'gearshape', 'Plugins…', 'Install plugins and choose workbench views', undefined,
                () => { host.openSettings('plugins'); }),
            commandEntry('cmd:new-pane', 'terminal', 'New Pane', 'split the focused pane right', hint('split_right'),
                () => act.splitFocused('horizontal')),
            commandEntry('cmd:split-down', 'terminal', 'Split Down', 'split the focused pane down', hint('split_down'),
                () => act.splitFocused('vertical')),
            commandEntry('cmd:close-pane', 'terminal', 'Close Pane', 'close the focused pane', hint('close_pane'),
                () => act.closeFocused()),
            commandEntry('cmd:reopen-closed-pane', 'terminal', 'Reopen Closed Pane', 'restore the last pane closed in this workspace',
                hint('reopen_closed_pane'), () => act.reopenClosedPane()),
            commandEntry('cmd:new-scratchpad', 'note', 'New Scratchpad', 'an unsaved note pane, split off the focused one',
                hint('create_scratchpad'), () => act.createScratchpad()),
            commandEntry('cmd:search-pane', 'terminal', 'Find in Pane…', 'search the focused pane’s scrollback',
                hint('toggle_search'), () => act.toggleSearch()),
            commandEntry('cmd:toggle-zoom', 'rectangle.stack', 'Toggle Zoom', 'zoom the focused pane', hint('toggle_zoom'),
                () => act.toggleZoomFocused()),
            commandEntry('cmd:cycle-layout', 'rectangle.stack', 'Cycle Layout', 'next predefined layout', hint('cycle_layout'),
                () => act.cycleLayout()),
            commandEntry('cmd:sync-input', 'terminal', 'Toggle Synchronise Input', 'mirror typing across panes',
                hint('toggle_sync_input'), () => act.toggleSyncInput()),
            commandEntry('cmd:new-workspace', 'rectangle.stack', 'New Workspace', 'create an empty workspace',
                hint('new_workspace'), () => act.newWorkspace()),
            // ⌘, is not a bindable action (assembly dispatches it from its own listener), so the hint
            // is literal rather than a lookup that would answer `undefined` forever.
            commandEntry('cmd:settings', 'gearshape', 'Settings…', 'keybindings, appearance, labels, profiles', '⌘,',
                () => { host.openSettings(); })
        ];
    };

    const universe = (host: PaletteFeatureHost, commands: readonly PaletteEntry[]): PaletteItem[] =>
        buildPaletteItems(host.runtime.store.getState().daemon.state.workspaces, {
            homeDirectory: home(),
            commands: commands.map((entry) => entry.item)
        });

    return {
        /**
         * Two feeds, because the universe has two halves. The daemon mirror moves constantly (every
         * daemon snapshot reaches the store), so its half is compared by slice identity rather than
         * by rebuilding the list on every tick; the contribution store moves rarely but invisibly to
         * the mirror, so its half is forwarded as it arrives.
         */
        subscribe(listener: () => void): () => void {
            const host = read();
            if (host === null) return () => {};
            const key = (): readonly unknown[] => {
                const state = host.runtime.store.getState();
                return [state.daemon.state.workspaces, state.daemon.hasSnapshot, state.ui.activeWorkspaceID, state.ui.connection];
            };
            let last = key();
            const offMirror = host.runtime.store.subscribe(() => {
                const next = key();
                if (next.every((value, index) => value === last[index])) return;
                last = next;
                listener();
            });
            const offContributions = host.subscribeContributions(listener);
            return () => {
                offMirror();
                offContributions();
            };
        },

        snapshot(): PaletteSourceSnapshot {
            const host = read();
            if (host === null) return { items: [] };
            return { items: universe(host, entries(host)) };
        },

        async execute(itemID: string, target: JsonObject): Promise<void> {
            const host = liveHost();
            const commands = entries(host);
            /*
             * Routed by the DESCRIPTOR's kind, never by the shape of the id. A contribution names
             * its own menu ids, so one that happened to start with `ws:` or `pane:` would be
             * permanently unrunnable under a prefix test. Where a contribution id really does
             * collide with a workspace row, the row wins here because it wins in the rendered list:
             * `buildPaletteItems` puts the mirror's half first and the presenter picks by index.
             */
            const item = universe(host, commands).find((candidate) => candidate.id === itemID);
            if (item === undefined) {
                // Nothing with that id in either half. The message follows the id's shape, because a
                // missing descriptor has no kind left to report.
                throw new Error(
                    itemID.startsWith('ws:') || itemID.startsWith('pane:')
                        ? 'Palette target is no longer available.'
                        : 'Palette command is unavailable.'
                );
            }
            if (item.kind !== 'command') {
                if (item.workspaceID === null) throw new Error('Palette target is no longer available.');
                const workspaceID = target['workspaceID'], paneID = target['paneID'];
                if (typeof workspaceID === 'string' && workspaceID !== item.workspaceID) throw new Error('Palette target is no longer available.');
                if (typeof paneID === 'string' && paneID !== item.paneID) throw new Error('Palette target is no longer available.');
                // §8.5 ordering, and §APP-037/§WS-100's reveal: activate the workspace (which also
                // leaves remote mode and queues the sidebar's scroll target), then focus the pane.
                host.activateWorkspace(item.workspaceID);
                if (item.paneID !== null) host.focusPane(item.workspaceID, item.paneID);
                return;
            }
            const entry = commands.find((candidate) => candidate.item.id === itemID);
            if (entry === undefined) throw new Error('Palette command is unavailable.');
            if (entry.item.disabled === true) throw new Error('Palette command is unavailable or disabled.');
            // A native verb that could not act says so by returning false and is NOT reported; only
            // a contribution's refusal means something went away. See `PaletteEntry.reportsRefusal`.
            if (entry.run() === false && entry.reportsRefusal === true) throw new Error('Palette command is no longer available.');
        }
    };
}
