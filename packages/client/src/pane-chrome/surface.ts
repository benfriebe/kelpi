/**
 * One window, one pane chrome surface: the single authority over every action a pane header
 * performs.
 *
 * Before this module those authorities were the header's own props, read straight out of the JSX:
 * eleven callbacks, each invoked from the control that happened to be drawing it, three of them
 * twice (a button and its `•••` menu row), and one - the globe - with two different arguments
 * depending on which of the two fired. That shape cannot be replaced: a presenter would have to be
 * handed the callbacks, or the pane, or both, and a stale row would still run whatever closure it
 * was rendered with.
 *
 * So the shape is `settings/surface.ts`'s shape:
 *
 *   - the vocabulary is `contract.ts` and the per-pane data is `model.ts`; this is behaviour;
 *   - the caller (the bundled header, or a presenter in phase B) sends an ID, never a closure;
 *   - every call re-resolves that id against a FRESH read of the model, so a control that
 *     vanished, went disabled or never existed refuses to run instead of running;
 *   - the verbs are an INDIRECTION over the latest render's actions, so the surface is created
 *     once and never rebuilt when a callback changes identity.
 *
 * What does NOT live here: any JSX, any `data-testid`, any socket. Three host-owned surfaces are
 * deliberately absent, and each is absent for the reason `docs/plugin-ui.md` gives for the Settings
 * dialog's native sections:
 *
 *   - **the inline rename field.** `renamePane(paneID, name)` COMMITS a name; it does not draw a
 *     text input. The field is the host's, because the caret is (`app/pane-focus.ts` tells a pane
 *     surface from a chrome text field by attribute, and `chrome/keys.ts` refuses actions while a
 *     field holds it), and ratified decision 6 keeps it there.
 *   - **the destructive confirmation.** `closePane` routes to whatever the host has bound, which is
 *     the assembly's existing confirmation. A presenter never draws one.
 *   - **the pane context menu and the pane-move drag.** `openPaneMenu` asks the host to open its
 *     own menu at a point; the drag is the grid's gesture, raised from the header and owned by
 *     `PaneGrid`. Neither is a pane action a projection could describe.
 *
 * The two React event types below are erased at compile time and pull nothing in at runtime: they
 * are the host's own events, on their way back to the host handlers that already expect them.
 */

import type { SplitDirection } from '@kelpi/core/layout';
import type { MouseEvent } from 'react';

import { PANE_CHROME_SPLITS, type PaneChromeModel } from './model';
import { isPaneChromeActionID, type PaneChromeControlDescriptor } from './contract';

/**
 * The host verbs, as the grid already binds them.
 *
 * Every one is optional for the same reason `grid/types.ts`'s `PaneActions` are: an unwired control
 * is inert, not absent - it stays in the row, dimmed or not, because a control that vanishes
 * reflows the header.
 */
export interface PaneChromeActions {
    readonly onFocusPane?: ((paneID: string) => void) | undefined;
    readonly onClosePane?: ((paneID: string) => void) | undefined;
    readonly onRenamePane?: ((paneID: string, name: string) => void) | undefined;
    readonly onSplitPane?: ((paneID: string, direction: SplitDirection) => void) | undefined;
    readonly onToggleZoom?: ((paneID: string) => void) | undefined;
    readonly onToggleMarkdownEdit?: ((paneID: string) => void) | undefined;
    readonly onRefreshDiff?: ((paneID: string) => void) | undefined;
    readonly onCopyDocument?: ((paneID: string) => void) | undefined;
    readonly onNewWebPane?: ((paneID: string, direction: SplitDirection) => void) | undefined;
    /** Another plugin's `pane.header` item, activated by id (ratified decision 7). */
    readonly onRunHeaderItem?: ((paneID: string, itemID: string) => void) | undefined;
    readonly onPaneContextMenu?: ((paneID: string, event: MouseEvent<HTMLElement>) => void) | undefined;
}

export interface PaneChromeSurfaceConfig {
    /** The latest render's verb table. Identity may change every render; content is what counts. */
    actions(): PaneChromeActions;
    /** The latest render's model for a pane, or null for a pane this surface does not serve. */
    model(paneID: string): PaneChromeModel | null;
}

/**
 * A control's alternate gesture.
 *
 * Exactly one control has one - the globe, where ⇧-click splits down instead of right - and the
 * flag is here rather than in the descriptor because it is a property of the GESTURE, not of the
 * control: the same entry in the `•••` menu has no modifier to read, and the menu row and the
 * button now reach the same verb through the same call.
 */
export interface PaneChromeControlOptions {
    readonly alternate?: boolean | undefined;
}

export interface PaneChromeSurface {
    focusPane(paneID: string): void;
    splitPane(paneID: string, direction: SplitDirection): void;
    toggleZoom(paneID: string): void;
    /** Commits a name. Empty clears the label; the field that produced it is the host's. */
    renamePane(paneID: string, name: string): void;
    closePane(paneID: string): void;
    /** Run one of the trailing controls by key - a host action or another plugin's command. */
    runControl(paneID: string, key: string, options?: PaneChromeControlOptions): void;
    /** Run one of another plugin's `pane.header` items by its opaque ref. */
    runItem(paneID: string, itemID: string): void;
    openPaneMenu(paneID: string, event: MouseEvent<HTMLElement>): void;
}

export function createPaneChromeSurface(config: PaneChromeSurfaceConfig): PaneChromeSurface {
    /**
     * Every mutating call starts here.
     *
     * A pane the surface does not serve, or one that has gone since the control was drawn, refuses
     * rather than guessing - which is what `settings/surface.ts` does with a field id and for the
     * same reason: the list a caller is looking at is always at least one render old.
     */
    const resolve = (paneID: string): PaneChromeModel | null => config.model(paneID);

    const resolveControl = (paneID: string, key: string): PaneChromeControlDescriptor | null => {
        const model = resolve(paneID);
        if (model === null) return null;
        const control = model.descriptor.controls.find((entry) => entry.key === key);
        // A disabled control REFUSES to run; it does not queue.
        if (control === undefined || !control.enabled) return null;
        return control;
    };

    const surface: PaneChromeSurface = {
        focusPane(paneID) {
            if (resolve(paneID) === null) return;
            config.actions().onFocusPane?.(paneID);
        },
        splitPane(paneID, direction) {
            if (resolve(paneID) === null) return;
            config.actions().onSplitPane?.(paneID, direction);
        },
        toggleZoom(paneID) {
            if (resolve(paneID) === null) return;
            config.actions().onToggleZoom?.(paneID);
        },
        renamePane(paneID, name) {
            if (resolve(paneID) === null) return;
            // The trim lives with the write, not with the field: one write path, one normalisation.
            config.actions().onRenamePane?.(paneID, name.trim());
        },
        closePane(paneID) {
            if (resolve(paneID) === null) return;
            config.actions().onClosePane?.(paneID);
        },
        runControl(paneID, key, options) {
            const control = resolveControl(paneID, key);
            if (control === null) return;
            if (control.kind === 'item') {
                // Re-resolved against a fresh model, so a command whose plugin was disabled or
                // whose enablement went false between the render and the click does not run the
                // closure the row was drawn with.
                resolve(paneID)?.targets.commands.get(key)?.(paneID);
                return;
            }
            if (!isPaneChromeActionID(key)) return;
            const actions = config.actions();
            switch (key) {
                case 'copy':
                    actions.onCopyDocument?.(paneID);
                    return;
                case 'edit':
                    actions.onToggleMarkdownEdit?.(paneID);
                    return;
                case 'refresh':
                    actions.onRefreshDiff?.(paneID);
                    return;
                case 'split-right':
                case 'split-down':
                    surface.splitPane(paneID, PANE_CHROME_SPLITS[key]);
                    return;
                case 'new-web':
                    actions.onNewWebPane?.(
                        paneID,
                        options?.alternate === true ? 'vertical' : 'horizontal'
                    );
                    return;
                case 'close':
                    surface.closePane(paneID);
                    return;
            }
        },
        runItem(paneID, itemID) {
            const model = resolve(paneID);
            if (model === null) return;
            const item = model.descriptor.items.find((entry) => entry.id === itemID);
            if (item === undefined || !item.enabled) return;
            config.actions().onRunHeaderItem?.(paneID, itemID);
        },
        openPaneMenu(paneID, event) {
            if (resolve(paneID) === null) return;
            config.actions().onPaneContextMenu?.(paneID, event);
        }
    };

    return surface;
}
