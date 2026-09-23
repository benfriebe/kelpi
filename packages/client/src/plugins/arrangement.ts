/**
 * The root arrangement: which of the window's five bands are showing, and Zen Mode.
 *
 * The root is one column of slots around the pane grid (`App.tsx`): the toolbar, the Workspaces
 * and Inspector hosts either side of the grid, the bottom panel and the status bar. The grid is
 * the one thing that never hides. Everything else can, and this is the whole of that state:
 *
 *   - `visible` - the five bands. The toolbar, status bar and bottom panel are new here; the two
 *     sidebar hosts are the Workspaces and Inspector visibility `App.tsx` has always had, now
 *     persisted with the rest. A hidden band keeps its selected view, so showing it again brings
 *     back the same one: hiding is a layout flag, never a selection (`registry.ts` still refuses an
 *     empty selection for a band with a bundled default).
 *   - `zenSnapshot` - Zen Mode, as VS Code's is: entering records the five and hides them all, the
 *     individual toggles keep working inside it, and leaving restores exactly what was recorded.
 *     `null` is "not in Zen Mode".
 *
 * Persisted per client origin and daemon identity beside the view selections
 * (`kelpi.workbench.layout.v1:<id>` next to `kelpi.workbench.v1:<id>`), but deliberately NOT
 * live-synced between open windows as the selections are: Zen Mode in one window must not strip the
 * chrome from the window beside it. Each window reads it when it mounts and writes it when it
 * changes, so the last writer is what the next window or launch opens with. Desktop only; the phone
 * shell never reads it.
 */

export const ARRANGEMENT_BANDS = ['topbar', 'statusbar', 'panel.bottom', 'sidebar', 'inspector'] as const;
export type ArrangementBand = (typeof ARRANGEMENT_BANDS)[number];
/** The three root slots whose hidden state is new; the two sidebar hosts are `sidebar` and `inspector`. */
export type ArrangementSlotBand = Extract<ArrangementBand, 'topbar' | 'statusbar' | 'panel.bottom'>;
export type BandVisibility = Readonly<Record<ArrangementBand, boolean>>;

export interface RootArrangement {
    readonly visible: BandVisibility;
    readonly zenSnapshot: BandVisibility | null;
}

/** Today's launch state: every band showing except the Inspector, which opens on demand. */
export const DEFAULT_VISIBILITY: BandVisibility = { topbar: true, statusbar: true, 'panel.bottom': true, sidebar: true, inspector: false };
export const DEFAULT_ARRANGEMENT: RootArrangement = { visible: DEFAULT_VISIBILITY, zenSnapshot: null };
const ALL_HIDDEN: BandVisibility = { topbar: false, statusbar: false, 'panel.bottom': false, sidebar: false, inspector: false };

export const ARRANGEMENT_STORAGE_PREFIX = 'kelpi.workbench.layout.v1:';
export function arrangementStorageKey(identity: string): string {
    return `${ARRANGEMENT_STORAGE_PREFIX}${identity}`;
}

export function isArrangementSlotBand(value: unknown): value is ArrangementSlotBand {
    return value === 'topbar' || value === 'statusbar' || value === 'panel.bottom';
}

export function zenModeActive(arrangement: RootArrangement): boolean {
    return arrangement.zenSnapshot !== null;
}

function readVisibility(value: unknown): BandVisibility | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (!ARRANGEMENT_BANDS.every(band => typeof record[band] === 'boolean')) return null;
    return Object.fromEntries(ARRANGEMENT_BANDS.map(band => [band, record[band]])) as unknown as BandVisibility;
}

/** A saved value, or the defaults when it is missing, corrupt or a shape this build does not know. */
export function readArrangement(value: unknown): RootArrangement {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return DEFAULT_ARRANGEMENT;
    const record = value as Record<string, unknown>;
    const visible = readVisibility(record['visible']);
    if (visible === null) return DEFAULT_ARRANGEMENT;
    // A corrupt snapshot drops Zen Mode rather than the whole arrangement: the bands the user can
    // see are right, and there is simply nothing to restore to.
    return { visible, zenSnapshot: record['zenSnapshot'] === null ? null : readVisibility(record['zenSnapshot']) };
}

/** One band shown or hidden, in React's `SetStateAction` shape so `setSidebarVisible` callers are unchanged. */
export function setBandVisible(arrangement: RootArrangement, band: ArrangementBand, next: boolean | ((visible: boolean) => boolean)): RootArrangement {
    const current = arrangement.visible[band];
    const value = typeof next === 'function' ? next(current) : next;
    if (value === current) return arrangement;
    return { ...arrangement, visible: { ...arrangement.visible, [band]: value } };
}

/** Enter Zen Mode (record the five, hide them all) or leave it (restore exactly what was recorded). */
export function toggleZenMode(arrangement: RootArrangement): RootArrangement {
    if (arrangement.zenSnapshot !== null) return { visible: arrangement.zenSnapshot, zenSnapshot: null };
    return { visible: ALL_HIDDEN, zenSnapshot: arrangement.visible };
}

export function sameArrangement(a: RootArrangement, b: RootArrangement): boolean {
    const same = (x: BandVisibility | null, y: BandVisibility | null): boolean =>
        x === y || (x !== null && y !== null && ARRANGEMENT_BANDS.every(band => x[band] === y[band]));
    return same(a.visible, b.visible) && same(a.zenSnapshot, b.zenSnapshot);
}
