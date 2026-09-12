/**
 * The adapter between the window's palette SESSION and today's presenter.
 *
 * It maps `surface.palette.getSnapshot()` onto `CommandPaletteProps`
 * (`chrome/CommandPalette.tsx:68-89`) so the bundled component and its tests are untouched apart
 * from the one `item.run?.()` removal, and it routes the component's three callbacks back through
 * the session. Nothing else passes between them: what goes out is descriptors (no `run` closure
 * can reach this module by construction) and what comes back is an id.
 *
 * ── Two things the surface owns, so this adapter does not ───────────────────────────
 *
 *   - **Execution.** `onConfirm(item)` REPORTS a confirmed row. It reaches
 *     `surface.palette.activate(sessionID, item.id)`, which re-resolves the id against a fresh
 *     source read, refuses an unknown / disabled / stale / vanished target, and runs it at most
 *     once. A refusal is already reported by the surface (`reportFailure`), so the `.catch` here
 *     exists to keep an expected rejection from going unhandled, not to swallow anything.
 *   - **The focus handoff.** §10.4's 200 ms pane handoff is scheduled by the surface on every
 *     dismiss and every activation, and cancelled when a queued prompt becomes visible, which is
 *     the defect the contract closes (the handoff used to fire into a pane behind an open
 *     prompt). So `onFocusHandoff` is deliberately NOT passed: `CommandPalette`'s own
 *     `scheduleHandoff` is inert without a handler, and `fallbackPaneID` is left to do the one
 *     job it still has here, which is telling a confirm with no match which pane the window
 *     falls back to.
 *
 * ── Why it always renders the component ─────────────────────────────────────────────
 *
 * `CommandPalette` stays MOUNTED while closed: it renders null itself, and it has to be there to
 * play §H19's 150 ms exit animation and to honour a pending timer. Returning null from here when
 * the session is closed would unmount it and POP the palette off the screen instead of playing it
 * out, the regression H19 fixed. So it is rendered unconditionally, with `open` false.
 */

import { useRef, useSyncExternalStore, type ReactElement } from 'react';

import { CommandPalette } from '../chrome/CommandPalette';
import type { FormFactorWindow } from '../chrome/form-factor';
import type { PaletteItem } from '../chrome/palette';
import type { ChromeBucket } from '../chrome/theme';
import type { InteractionPaletteItem } from './contract';
import type { InteractionSurface } from './surface';

export interface PaletteHostProps {
    readonly surface: InteractionSurface;
    /** The active workspace's colour bucket, straight through to `CommandPalette`. */
    readonly bucket?: ChromeBucket | undefined;
    /** B5: the window the form factor and the software-keyboard inset are read from. */
    readonly formFactorWindow?: FormFactorWindow | undefined;
}

const EMPTY: readonly InteractionPaletteItem[] = [];

export function PaletteHost(props: PaletteHostProps): ReactElement | null {
    const session = props.surface.palette;
    const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);

    /*
     * The universe the session publishes is EMPTY while the palette is closed: the surface holds
     * no live projection of the mirror for a palette nobody is looking at. The component, though,
     * keeps painting for 150 ms after `open` goes false, and a list that emptied on that tick
     * would fade out as a bare field rather than fading out as itself. So the last list published
     * while open is held for exactly that window.
     */
    const lastItems = useRef<readonly InteractionPaletteItem[]>(EMPTY);
    if (snapshot.open) lastItems.current = snapshot.items;
    const items: readonly PaletteItem[] = snapshot.open ? snapshot.items : lastItems.current;

    const sessionID = snapshot.sessionID;

    return (
        <CommandPalette
            open={snapshot.open}
            query={snapshot.query}
            onQueryChange={(query) => {
                if (sessionID !== null) session.setQuery(sessionID, query);
            }}
            items={items}
            onConfirm={(item) => {
                if (sessionID === null) return;
                void session.activate(sessionID, item.id).catch(() => {
                    /* Reported by the surface; caught here so a refusal is never unhandled. */
                });
            }}
            onDismiss={() => {
                if (sessionID !== null) session.dismiss(sessionID, 'user');
            }}
            fallbackPaneID={props.surface.fallbackPaneID()}
            bucket={props.bucket}
            formFactorWindow={props.formFactorWindow}
        />
    );
}
