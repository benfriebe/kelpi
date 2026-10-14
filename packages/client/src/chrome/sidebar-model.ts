/**
 * The sidebar's pure order model: rendered rows, the visible order ⌘1..9 indexes into, and the
 * drag-and-drop geometry.
 *
 * Two specs meet here.
 *
 *   - **app-state-core.md §2.2/§2.3** define `visibleWorkspaceOrder` and `renderedEntries`.
 *     The daemon exports `visibleWorkspaceOrder(DaemonState)` and the client uses it through
 *     `selectVisibleWorkspaceIDs`; the functions below answer the same question over the
 *     *rendered* entries, which is what the sidebar needs once a group is collapsed
 *     CLIENT-LOCALLY (there is no collapse wire verb yet, so the daemon's answer would lag the
 *     click). `sidebar-model.test.ts` asserts the two agree on the same state, so this is an
 *     equivalent restatement of the daemon's rule, not a second opinion.
 *   - **shell-ui.md §5.5 + §15** define the drag model. The Swift app live-applies real state
 *     mutations during a drag; the port note is explicit that a client must live-apply against
 *     a **client-local shadow** and commit exactly ONE atomic move on release, preserving the
 *     remove-then-insert (post-remove index) semantics of `moveWorkspace(toIndex)` /
 *     `moveWorkspaceToGroup(groupID, index)` / `moveGroup(toIndex)`. That is what
 *     `applyWorkspaceDrop` + `locateWorkspace` produce: the shadow's final index IS the
 *     post-remove index, because the shadow itself was built by removing then inserting.
 */

import type { WorkspaceColor } from '@kelpi/daemon/store';

import {
    WORKSPACE_COLORS,
    type ChromeNestedWorkspaces,
    type ChromeSidebarEntry,
    type ChromeWorkspace
} from './types';

// ── order model ─────────────────────────────────────────────────────────────────────

export type SidebarSlot =
    | { readonly kind: 'workspace'; readonly id: string }
    | { readonly kind: 'group'; readonly id: string };

export interface SidebarOrderModel {
    readonly topLevel: readonly SidebarSlot[];
    /** Group id → member workspace ids, in render order. */
    readonly children: ReadonlyMap<string, readonly string[]>;
    /**
     * app-state-core.md §2.9: parent workspace id → its nested workspace ids, in render order.
     * Absent = nothing nested, which is every model built before nesting existed.
     */
    readonly nested?: ReadonlyMap<string, readonly string[]> | undefined;
}

const NO_NESTED: ReadonlyMap<string, readonly string[]> = new Map();

function nestedOfModel(model: SidebarOrderModel): ReadonlyMap<string, readonly string[]> {
    return model.nested ?? NO_NESTED;
}

export function orderModelFromEntries(entries: readonly ChromeSidebarEntry[]): SidebarOrderModel {
    const topLevel: SidebarSlot[] = [];
    const children = new Map<string, readonly string[]>();
    const nested = new Map<string, readonly string[]>();
    for (const entry of entries) {
        for (const [parentID, kids] of entry.nested ?? []) {
            nested.set(
                parentID,
                kids.map((workspace) => workspace.id)
            );
        }
        if (entry.kind === 'workspace') {
            topLevel.push({ kind: 'workspace', id: entry.workspace.id });
            continue;
        }
        topLevel.push({ kind: 'group', id: entry.group.id });
        children.set(
            entry.group.id,
            entry.workspaces.map((workspace) => workspace.id)
        );
    }
    return nested.size === 0 ? { topLevel, children } : { topLevel, children, nested };
}

/** Re-projects the entry list through a (possibly shadowed) order model. */
export function projectEntries(
    entries: readonly ChromeSidebarEntry[],
    model: SidebarOrderModel
): ChromeSidebarEntry[] {
    const workspaces = new Map<string, ChromeWorkspace>();
    const groups = new Map<string, ChromeSidebarEntry & { kind: 'group' }>();
    for (const entry of entries) {
        for (const kids of entry.nested?.values() ?? []) {
            for (const workspace of kids) workspaces.set(workspace.id, workspace);
        }
        if (entry.kind === 'workspace') {
            workspaces.set(entry.workspace.id, entry.workspace);
            continue;
        }
        groups.set(entry.group.id, entry);
        for (const workspace of entry.workspaces) workspaces.set(workspace.id, workspace);
    }
    const resolve = (ids: readonly string[]): ChromeWorkspace[] =>
        ids
            .map((id) => workspaces.get(id))
            .filter((workspace): workspace is ChromeWorkspace => workspace !== undefined);
    // §2.9: each projected entry carries the nested rows of the parents it holds.
    const nestedFor = (parentIDs: readonly string[]): ChromeNestedWorkspaces | undefined => {
        let nested: Map<string, readonly ChromeWorkspace[]> | undefined;
        for (const parentID of parentIDs) {
            const kids = resolve(nestedOfModel(model).get(parentID) ?? []);
            if (kids.length === 0) continue;
            nested ??= new Map();
            nested.set(parentID, kids);
        }
        return nested;
    };

    const projected: ChromeSidebarEntry[] = [];
    for (const slot of model.topLevel) {
        if (slot.kind === 'workspace') {
            const workspace = workspaces.get(slot.id);
            if (workspace === undefined) continue;
            const nested = nestedFor([slot.id]);
            projected.push(nested === undefined ? { kind: 'workspace', workspace } : { kind: 'workspace', workspace, nested });
            continue;
        }
        const group = groups.get(slot.id);
        if (group === undefined) continue;
        const members = resolve(model.children.get(slot.id) ?? []);
        const nested = nestedFor(members.map((workspace) => workspace.id));
        projected.push(
            nested === undefined
                ? { kind: 'group', group: group.group, workspaces: members }
                : { kind: 'group', group: group.group, workspaces: members, nested }
        );
    }
    return projected;
}

export interface WorkspaceLocation {
    /** null = top level (or nested: see `parentID`). */
    readonly groupID: string | null;
    readonly index: number;
    /**
     * §2.9: present only for a nested workspace, naming its parent; `index` is then its
     * position among the parent's children and `groupID` is null.
     */
    readonly parentID?: string | undefined;
}

export function locateWorkspace(model: SidebarOrderModel, workspaceID: string): WorkspaceLocation | null {
    for (const [parentID, kids] of nestedOfModel(model)) {
        const index = kids.indexOf(workspaceID);
        if (index >= 0) return { groupID: null, index, parentID };
    }
    for (const [groupID, members] of model.children) {
        const index = members.indexOf(workspaceID);
        if (index >= 0) return { groupID, index };
    }
    let index = 0;
    for (const slot of model.topLevel) {
        if (slot.kind === 'workspace' && slot.id === workspaceID) return { groupID: null, index };
        index += 1;
    }
    return null;
}

/**
 * §2.9: the ids that follow a parent which is ALSO in `ids`. A move or a new group carries a
 * parent's nested workspaces with it, so naming them as well would only ask the daemon to pull
 * them out from under it; every bulk command sends `ids` without these.
 */
export function nestedFollowers(model: SidebarOrderModel, ids: readonly string[]): ReadonlySet<string> {
    const moving = new Set(ids);
    const followers = new Set<string>();
    for (const [parentID, kids] of nestedOfModel(model)) {
        if (!moving.has(parentID)) continue;
        for (const id of kids) if (moving.has(id)) followers.add(id);
    }
    return followers;
}

/** `ids` without the followers of a parent that is moving too (see `nestedFollowers`). */
export function withoutNestedFollowers(model: SidebarOrderModel, ids: readonly string[]): string[] {
    const followers = nestedFollowers(model, ids);
    return followers.size === 0 ? [...ids] : ids.filter((id) => !followers.has(id));
}

function withoutWorkspace(model: SidebarOrderModel, workspaceID: string): SidebarOrderModel {
    const topLevel = model.topLevel.filter((slot) => !(slot.kind === 'workspace' && slot.id === workspaceID));
    const children = new Map<string, readonly string[]>();
    for (const [groupID, members] of model.children) {
        children.set(
            groupID,
            members.filter((id) => id !== workspaceID)
        );
    }
    if (model.nested === undefined) return { topLevel, children };
    const nested = new Map<string, readonly string[]>();
    for (const [parentID, kids] of model.nested) {
        nested.set(
            parentID,
            kids.filter((id) => id !== workspaceID)
        );
    }
    return { topLevel, children, nested };
}

function clampIndex(index: number, length: number): number {
    if (index < 0) return 0;
    return index > length ? length : index;
}

// ── drop targets ────────────────────────────────────────────────────────────────────

export type DropTarget =
    | { readonly kind: 'topLevel'; readonly index: number }
    | { readonly kind: 'intoGroup'; readonly groupID: string; readonly index: number }
    /** Append into the group; preview-only while dragging (§5.5). */
    | { readonly kind: 'ontoGroupHeader'; readonly groupID: string }
    /** §2.9: between a parent's nested workspaces, at a post-remove index. */
    | { readonly kind: 'intoParent'; readonly parentID: string; readonly index: number }
    /** §2.9: onto a workspace row's middle band, nesting at the end; preview-only like a header. */
    | { readonly kind: 'ontoWorkspace'; readonly parentID: string };

/** Remove-then-insert, exactly the reducers' semantics — the index is post-remove. */
export function applyWorkspaceDrop(
    model: SidebarOrderModel,
    workspaceID: string,
    target: DropTarget
): SidebarOrderModel {
    const base = withoutWorkspace(model, workspaceID);
    if (target.kind === 'intoParent' || target.kind === 'ontoWorkspace') {
        const kids = [...(nestedOfModel(base).get(target.parentID) ?? [])];
        const index = target.kind === 'intoParent' ? clampIndex(target.index, kids.length) : kids.length;
        kids.splice(index, 0, workspaceID);
        const nested = new Map(nestedOfModel(base));
        nested.set(target.parentID, kids);
        return { topLevel: base.topLevel, children: base.children, nested };
    }
    if (target.kind === 'topLevel') {
        const topLevel = [...base.topLevel];
        topLevel.splice(clampIndex(target.index, topLevel.length), 0, { kind: 'workspace', id: workspaceID });
        return base.nested === undefined
            ? { topLevel, children: base.children }
            : { topLevel, children: base.children, nested: base.nested };
    }
    const groupID = target.groupID;
    const members = [...(base.children.get(groupID) ?? [])];
    const index = target.kind === 'intoGroup' ? clampIndex(target.index, members.length) : members.length;
    members.splice(index, 0, workspaceID);
    const children = new Map(base.children);
    children.set(groupID, members);
    return base.nested === undefined
        ? { topLevel: base.topLevel, children }
        : { topLevel: base.topLevel, children, nested: base.nested };
}

/** `moveGroup(id, toIndex)` — top-level only; groups never nest. */
export function applyGroupDrop(model: SidebarOrderModel, groupID: string, index: number): SidebarOrderModel {
    const from = model.topLevel.findIndex((slot) => slot.kind === 'group' && slot.id === groupID);
    if (from < 0) return model;
    const topLevel = [...model.topLevel];
    const [slot] = topLevel.splice(from, 1);
    if (slot === undefined) return model;
    topLevel.splice(clampIndex(index, topLevel.length), 0, slot);
    return model.nested === undefined
        ? { topLevel, children: model.children }
        : { topLevel, children: model.children, nested: model.nested };
}

/** The single move a finished drag commits, or null when nothing actually changed. */
export function workspaceCommit(
    before: SidebarOrderModel,
    after: SidebarOrderModel,
    workspaceID: string
): WorkspaceLocation | null {
    const from = locateWorkspace(before, workspaceID);
    const to = locateWorkspace(after, workspaceID);
    if (to === null) return null;
    if (
        from !== null &&
        from.groupID === to.groupID &&
        (from.parentID ?? null) === (to.parentID ?? null) &&
        from.index === to.index
    ) {
        return null;
    }
    return to;
}

export function groupCommit(
    before: SidebarOrderModel,
    after: SidebarOrderModel,
    groupID: string
): number | null {
    const index = after.topLevel.findIndex((slot) => slot.kind === 'group' && slot.id === groupID);
    const previous = before.topLevel.findIndex((slot) => slot.kind === 'group' && slot.id === groupID);
    if (index < 0 || index === previous) return null;
    return index;
}

// ── rendered rows ───────────────────────────────────────────────────────────────────

export type RenderedRow =
    | {
          readonly kind: 'workspace';
          readonly key: string;
          readonly workspaceID: string;
          /** The group the row sits in; a nested row carries its parent's group. */
          readonly groupID: string | null;
          /** 0 top level, 1 in a group or nested under a top-level parent, 2 nested in a group. */
          readonly depth: 0 | 1 | 2;
          /** §2.9: present only on a nested row, naming its parent workspace. */
          readonly parentID?: string | undefined;
          /** §2.9: present only on a parent row: how many live nested workspaces it has. */
          readonly childCount?: number | undefined;
          /** §2.9: present only on a parent row: whether its nested rows are hidden. */
          readonly childrenCollapsed?: boolean | undefined;
      }
    | { readonly kind: 'group-header'; readonly key: string; readonly groupID: string }
    | { readonly kind: 'group-empty'; readonly key: string; readonly groupID: string };

export interface CollapseState {
    /**
     * Client-local overrides layered over each group's own `isCollapsed`, and over each parent
     * workspace's `childrenCollapsed` (§2.9), keyed by id: group and workspace ids are distinct
     * UUIDs, so one map serves both.
     */
    readonly overrides?: ReadonlyMap<string, boolean> | undefined;
    /**
     * A group (or a parent workspace, §2.9) spring-loaded open for the duration of a drag
     * (§5.5), collapse untouched.
     */
    readonly springLoadedGroupID?: string | null | undefined;
}

/** §2.9: whether a parent workspace's nested rows are hidden, under the same overrides. */
export function isParentCollapsed(
    workspace: { readonly id: string; readonly childrenCollapsed?: boolean | undefined },
    state: CollapseState = {}
): boolean {
    if (state.springLoadedGroupID === workspace.id) return false;
    const override = state.overrides?.get(workspace.id);
    return override ?? workspace.childrenCollapsed === true;
}

export function isGroupCollapsed(
    group: { readonly id: string; readonly isCollapsed: boolean },
    state: CollapseState = {}
): boolean {
    if (state.springLoadedGroupID === group.id) return false;
    const override = state.overrides?.get(group.id);
    return override ?? group.isCollapsed;
}

/** §2.3 `renderedEntries`, with the row-identity strings the spec names (`ws:`/`header:`/`empty:`). */
export function renderedRows(
    entries: readonly ChromeSidebarEntry[],
    collapse: CollapseState = {}
): RenderedRow[] {
    const rows: RenderedRow[] = [];
    /** A workspace row, then (§2.9) its nested rows unless the parent is collapsed. */
    const pushWorkspace = (
        workspace: ChromeWorkspace,
        groupID: string | null,
        depth: 0 | 1,
        nested: ChromeNestedWorkspaces | undefined
    ): void => {
        const key = `ws:${workspace.id}`;
        const kids = nested?.get(workspace.id) ?? [];
        if (kids.length === 0) {
            rows.push({ kind: 'workspace', key, workspaceID: workspace.id, groupID, depth });
            return;
        }
        const collapsed = isParentCollapsed(workspace, collapse);
        rows.push({
            kind: 'workspace',
            key,
            workspaceID: workspace.id,
            groupID,
            depth,
            childCount: kids.length,
            childrenCollapsed: collapsed
        });
        if (collapsed) return;
        for (const child of kids) {
            rows.push({
                kind: 'workspace',
                key: `ws:${child.id}`,
                workspaceID: child.id,
                groupID,
                depth: depth === 0 ? 1 : 2,
                parentID: workspace.id
            });
        }
    };
    for (const entry of entries) {
        if (entry.kind === 'workspace') {
            pushWorkspace(entry.workspace, null, 0, entry.nested);
            continue;
        }
        rows.push({ kind: 'group-header', key: `header:${entry.group.id}`, groupID: entry.group.id });
        if (isGroupCollapsed(entry.group, collapse)) continue;
        if (entry.workspaces.length === 0) {
            rows.push({ kind: 'group-empty', key: `empty:${entry.group.id}`, groupID: entry.group.id });
            continue;
        }
        for (const workspace of entry.workspaces) pushWorkspace(workspace, entry.group.id, 1, entry.nested);
    }
    return rows;
}

/**
 * §2.2 `visibleWorkspaceOrder` over rendered entries: collapsed groups' members and collapsed
 * parents' nested workspaces excluded (§2.9).
 */
export function visibleOrderFromEntries(
    entries: readonly ChromeSidebarEntry[],
    collapse: CollapseState = {}
): string[] {
    const order: string[] = [];
    for (const row of renderedRows(entries, collapse)) {
        if (row.kind === 'workspace') order.push(row.workspaceID);
    }
    return order;
}

/** §5.1/§2.6: case-insensitive substring over name OR any label; trimmed needle. */
export function workspaceMatchesFilter(workspace: ChromeWorkspace, needle: string): boolean {
    const trimmed = needle.trim().toLowerCase();
    if (trimmed.length === 0) return true;
    if (workspace.name.toLowerCase().includes(trimmed)) return true;
    return workspace.labels.some((label) => label.toLowerCase().includes(trimmed));
}

export interface FilteredRow {
    readonly workspace: ChromeWorkspace;
    /** The "in <name>" caption: the row's group, or (§2.9) its parent workspace when nested. */
    readonly groupName: string | null;
}

/**
 * The flat filtered list: sidebar walk order, descending into collapsed groups too (§5.1), and
 * into collapsed parents' nested workspaces (§2.9), which are captioned with the parent's name.
 */
export function filteredRows(entries: readonly ChromeSidebarEntry[], needle: string): FilteredRow[] {
    const rows: FilteredRow[] = [];
    const push = (workspace: ChromeWorkspace, caption: string | null, nested: ChromeNestedWorkspaces | undefined): void => {
        if (workspaceMatchesFilter(workspace, needle)) rows.push({ workspace, groupName: caption });
        for (const child of nested?.get(workspace.id) ?? []) {
            if (workspaceMatchesFilter(child, needle)) rows.push({ workspace: child, groupName: workspace.name });
        }
    };
    for (const entry of entries) {
        if (entry.kind === 'workspace') {
            push(entry.workspace, null, entry.nested);
            continue;
        }
        for (const workspace of entry.workspaces) push(workspace, entry.group.name, entry.nested);
    }
    return rows;
}

// ── drag geometry ───────────────────────────────────────────────────────────────────

/**
 * §2.9: a row the dragged workspaces may nest onto. Its middle band nests (append); with its
 * children showing, its bottom band lands first among them rather than after the block.
 */
export interface NestTarget {
    readonly parentID: string;
    readonly expanded: boolean;
}

export type DropZoneKind =
    | {
          readonly kind: 'topLevelWorkspace';
          readonly id: string;
          readonly postRemoveTopIndex: number;
          readonly nestInto?: NestTarget | undefined;
      }
    | { readonly kind: 'groupHeader'; readonly groupID: string; readonly postRemoveTopIndex: number }
    | {
          readonly kind: 'groupChild';
          readonly groupID: string;
          readonly childID: string;
          readonly postRemoveChildIndex: number;
          readonly nestInto?: NestTarget | undefined;
      }
    | { readonly kind: 'groupEmpty'; readonly groupID: string }
    /** §2.9: a nested row, while the drag may nest: a slot among the parent's children. */
    | {
          readonly kind: 'nestedChild';
          readonly parentID: string;
          readonly childID: string;
          readonly postRemoveChildIndex: number;
          /**
           * Only on the parent's LAST nested row: where its bottom third lands, which is after
           * the parent's whole block in the parent's own container. Without it the end of a
           * group whose last member is an expanded parent could not be reached at all.
           */
          readonly after?: DropTarget | undefined;
      }
    /**
     * §2.9: a nested row while the drag may NOT nest (a parent with children of its own): the
     * whole row means "after the parent's block", in the parent's own container.
     */
    | { readonly kind: 'fixed'; readonly target: DropTarget };

export interface DropZone {
    readonly kind: DropZoneKind;
    readonly yTop: number;
    readonly yBottom: number;
}

export interface DropZoneLayout {
    readonly zones: readonly DropZone[];
    /** Target for a cursor below every zone: append at top level (§5.5). */
    readonly tailIndex: number;
    readonly contentBottom: number;
}

export interface DropZoneOptions {
    /** Measured row height keyed by row key; missing rows use `rowHeight`. */
    readonly heights?: ReadonlyMap<string, number> | undefined;
    /**
     * Measured content-space TOP of each row, keyed by row key — the same space `contentY`
     * resolves a cursor into (`clientY - scrollerTop + scrollTop`).
     *
     * Why this exists (defect N4b): heights are border-box and every sidebar row carries a 2px
     * outer margin on each edge, so walking the list by `y += height` loses a per-row gap —
     * 4px since §WS-027's clearance fix stopped those margins collapsing, 2px before it. The error is
     * cumulative, so in a three-row sidebar the model is right to within a pixel and in a
     * seven-row one the sixth row's band is ~10px above where the row actually is — enough for
     * a cursor sitting three quarters of the way down a group header to resolve to *no zone at
     * all*, which is a drag that visibly does nothing. Measured tops remove the whole class:
     * whatever the CSS does between rows (margins, collapsing, gaps, a spacer) the zones land
     * exactly on the pixels the user sees. Missing keys fall back to the accumulator, so a
     * layout-free environment (jsdom) behaves as before.
     */
    readonly offsets?: ReadonlyMap<string, number> | undefined;
    readonly rowHeight?: number | undefined;
    /** 4pt content padding (§5.2). */
    readonly contentTop?: number | undefined;
    /** Rows being dragged: omitted as targets, but they still advance the y cursor. */
    readonly dragging?: ReadonlySet<string> | undefined;
    /**
     * §2.9: the dragged workspaces may be nested (none has children of its own and the host
     * can commit a nest). Off by default, so every zone keeps its two-band behaviour.
     */
    readonly nestable?: boolean | undefined;
}

/**
 * Walks the rendered rows top-to-bottom accumulating y, emitting one zone per droppable row.
 * Indices are **post-remove** — computed with the dragged workspaces already detached — so
 * they feed the move reducers directly.
 */
export function buildDropZones(
    model: SidebarOrderModel,
    rows: readonly RenderedRow[],
    options: DropZoneOptions = {}
): DropZoneLayout {
    const rowHeight = options.rowHeight ?? 34;
    const dragging = options.dragging ?? new Set<string>();
    const zones: DropZone[] = [];

    const topAfterRemoval = model.topLevel.filter(
        (slot) => !(slot.kind === 'workspace' && dragging.has(slot.id))
    );
    const topIndexOf = new Map<string, number>();
    topAfterRemoval.forEach((slot, index) => {
        topIndexOf.set(`${slot.kind}:${slot.id}`, index);
    });
    const childIndexOf = new Map<string, number>();
    for (const [groupID, members] of model.children) {
        members
            .filter((id) => !dragging.has(id))
            .forEach((id, index) => {
                childIndexOf.set(`${groupID}/${id}`, index);
            });
    }
    /*
     * Where a slot sits once the dragged rows are gone: the number of undragged slots before
     * it. For an undragged slot that is its own post-remove index; for a dragged PARENT it is
     * where its block closes up, which is what "after the parent" means while it is moving.
     */
    const topInsertAt = new Map<string, number>();
    {
        let kept = 0;
        for (const slot of model.topLevel) {
            topInsertAt.set(`${slot.kind}:${slot.id}`, kept);
            if (!(slot.kind === 'workspace' && dragging.has(slot.id))) kept += 1;
        }
    }
    const childInsertAt = new Map<string, number>();
    for (const [groupID, members] of model.children) {
        let kept = 0;
        for (const id of members) {
            childInsertAt.set(`${groupID}/${id}`, kept);
            if (!dragging.has(id)) kept += 1;
        }
    }
    const nestedIndexOf = new Map<string, number>();
    for (const [parentID, kids] of nestedOfModel(model)) {
        kids
            .filter((id) => !dragging.has(id))
            .forEach((id, index) => {
                nestedIndexOf.set(`${parentID}/${id}`, index);
            });
    }
    /** §2.9: each parent's last undragged nested row, which carries the "after the block" band. */
    const lastNestedRow = new Map<string, string>();
    for (const row of rows) {
        if (row.kind === 'workspace' && row.parentID !== undefined && !dragging.has(row.workspaceID)) {
            lastNestedRow.set(row.parentID, row.workspaceID);
        }
    }
    const nestable = options.nestable === true;
    /** §2.9: where "after this parent's block" lands, keyed by parent id (filled on the walk). */
    const afterParent = new Map<string, DropTarget>();
    /** One past the parent's post-remove slot, or the slot itself when the parent is moving. */
    const afterSlot = (id: string, insertAt: number): number => (dragging.has(id) ? insertAt : insertAt + 1);
    const nestInto = (row: RenderedRow & { kind: 'workspace' }): NestTarget | undefined =>
        nestable && row.parentID === undefined
            ? { parentID: row.workspaceID, expanded: (row.childCount ?? 0) > 0 && row.childrenCollapsed !== true }
            : undefined;

    let y = options.contentTop ?? 4;
    for (let index = 0; index < rows.length; index++) {
        const row = rows[index] as RenderedRow;
        const height = options.heights?.get(row.key) ?? rowHeight;
        const measured = options.offsets?.get(row.key);
        const yTop = measured ?? y;
        // A row owns the gap beneath it, so the zones TILE the list: the margin between two
        // rows is never a dead spot the cursor can fall into (N4b).
        const nextRow = rows[index + 1];
        const nextTop = nextRow === undefined ? undefined : options.offsets?.get(nextRow.key);
        const yBottom = nextTop ?? yTop + height;
        y = yBottom;

        if (row.kind === 'workspace' && row.parentID !== undefined) {
            if (dragging.has(row.workspaceID)) continue;
            const after = afterParent.get(row.parentID);
            if (nestable) {
                const last = lastNestedRow.get(row.parentID) === row.workspaceID;
                zones.push({
                    kind: {
                        kind: 'nestedChild',
                        parentID: row.parentID,
                        childID: row.workspaceID,
                        postRemoveChildIndex: nestedIndexOf.get(`${row.parentID}/${row.workspaceID}`) ?? 0,
                        ...(last && after !== undefined ? { after } : {})
                    },
                    yTop,
                    yBottom
                });
                continue;
            }
            if (after !== undefined) zones.push({ kind: { kind: 'fixed', target: after }, yTop, yBottom });
            continue;
        }
        if (row.kind === 'workspace' && row.groupID === null) {
            const postRemoveTopIndex = topIndexOf.get(`workspace:${row.workspaceID}`) ?? 0;
            const insertAt = topInsertAt.get(`workspace:${row.workspaceID}`) ?? postRemoveTopIndex;
            afterParent.set(row.workspaceID, { kind: 'topLevel', index: afterSlot(row.workspaceID, insertAt) });
            if (dragging.has(row.workspaceID)) continue;
            const nest = nestInto(row);
            zones.push({
                kind: {
                    kind: 'topLevelWorkspace',
                    id: row.workspaceID,
                    postRemoveTopIndex,
                    ...(nest === undefined ? {} : { nestInto: nest })
                },
                yTop,
                yBottom
            });
            continue;
        }
        if (row.kind === 'workspace') {
            const groupID = row.groupID as string;
            const postRemoveChildIndex = childIndexOf.get(`${groupID}/${row.workspaceID}`) ?? 0;
            const insertAt = childInsertAt.get(`${groupID}/${row.workspaceID}`) ?? postRemoveChildIndex;
            afterParent.set(row.workspaceID, {
                kind: 'intoGroup',
                groupID,
                index: afterSlot(row.workspaceID, insertAt)
            });
            if (dragging.has(row.workspaceID)) continue;
            const nest = nestInto(row);
            zones.push({
                kind: {
                    kind: 'groupChild',
                    groupID,
                    childID: row.workspaceID,
                    postRemoveChildIndex,
                    ...(nest === undefined ? {} : { nestInto: nest })
                },
                yTop,
                yBottom
            });
            continue;
        }
        if (row.kind === 'group-header') {
            zones.push({
                kind: {
                    kind: 'groupHeader',
                    groupID: row.groupID,
                    postRemoveTopIndex: topIndexOf.get(`group:${row.groupID}`) ?? 0
                },
                yTop,
                yBottom
            });
            continue;
        }
        zones.push({ kind: { kind: 'groupEmpty', groupID: row.groupID }, yTop, yBottom });
    }

    return { zones, tailIndex: topAfterRemoval.length, contentBottom: y };
}

/** Cursor-y → drop target, per §5.5's half-height rules. */
export function resolveDropTarget(layout: DropZoneLayout, y: number): DropTarget | null {
    for (const zone of layout.zones) {
        if (y < zone.yTop || y >= zone.yBottom) continue;
        const topHalf = y < (zone.yTop + zone.yBottom) / 2;
        const kind = zone.kind;
        if (kind.kind === 'fixed') return kind.target;
        if (kind.kind === 'nestedChild') {
            // The last nested row splits in thirds: before it, after it (still nested), and
            // after the parent's whole block.
            if (kind.after !== undefined && y >= zone.yBottom - (zone.yBottom - zone.yTop) / 3) return kind.after;
            return {
                kind: 'intoParent',
                parentID: kind.parentID,
                index: topHalf ? kind.postRemoveChildIndex : kind.postRemoveChildIndex + 1
            };
        }
        if ((kind.kind === 'topLevelWorkspace' || kind.kind === 'groupChild') && kind.nestInto !== undefined) {
            // §2.9: thirds rather than halves: before / onto (nest) / after (or first child).
            const third = (zone.yBottom - zone.yTop) / 3;
            const nest = kind.nestInto;
            const before: DropTarget =
                kind.kind === 'topLevelWorkspace'
                    ? { kind: 'topLevel', index: kind.postRemoveTopIndex }
                    : { kind: 'intoGroup', groupID: kind.groupID, index: kind.postRemoveChildIndex };
            if (y < zone.yTop + third) return before;
            if (y < zone.yBottom - third) return { kind: 'ontoWorkspace', parentID: nest.parentID };
            if (nest.expanded) return { kind: 'intoParent', parentID: nest.parentID, index: 0 };
            return kind.kind === 'topLevelWorkspace'
                ? { kind: 'topLevel', index: kind.postRemoveTopIndex + 1 }
                : { kind: 'intoGroup', groupID: kind.groupID, index: kind.postRemoveChildIndex + 1 };
        }
        if (kind.kind === 'topLevelWorkspace') {
            return { kind: 'topLevel', index: topHalf ? kind.postRemoveTopIndex : kind.postRemoveTopIndex + 1 };
        }
        if (kind.kind === 'groupHeader') {
            return topHalf
                ? { kind: 'topLevel', index: kind.postRemoveTopIndex }
                : { kind: 'ontoGroupHeader', groupID: kind.groupID };
        }
        if (kind.kind === 'groupChild') {
            return {
                kind: 'intoGroup',
                groupID: kind.groupID,
                index: topHalf ? kind.postRemoveChildIndex : kind.postRemoveChildIndex + 1
            };
        }
        return { kind: 'intoGroup', groupID: kind.groupID, index: 0 };
    }
    if (y >= layout.contentBottom) return { kind: 'topLevel', index: layout.tailIndex };
    return null;
}

// ── group drag (spans) ──────────────────────────────────────────────────────────────

export interface GroupSpan {
    readonly groupID: string | null;
    readonly slotID: string;
    readonly index: number;
    readonly yTop: number;
    readonly yBottom: number;
}

export interface GroupSpanLayout {
    readonly spans: readonly GroupSpan[];
    readonly tailIndex: number;
    readonly contentBottom: number;
}

/** One span per top-level entry, covering its whole block (header + expanded children). */
export function buildGroupSpans(
    model: SidebarOrderModel,
    rows: readonly RenderedRow[],
    options: DropZoneOptions = {}
): GroupSpanLayout {
    const rowHeight = options.rowHeight ?? 34;
    const spans: GroupSpan[] = [];
    let y = options.contentTop ?? 4;
    let current: { slotID: string; groupID: string | null; yTop: number } | null = null;
    const flush = (yBottom: number): void => {
        if (current === null) return;
        const index = model.topLevel.findIndex((slot) => `${slot.kind}:${slot.id}` === current?.slotID);
        spans.push({
            groupID: current.groupID,
            slotID: current.slotID,
            index: index < 0 ? spans.length : index,
            yTop: current.yTop,
            yBottom
        });
        current = null;
    };

    for (let index = 0; index < rows.length; index++) {
        const row = rows[index] as RenderedRow;
        const height = options.heights?.get(row.key) ?? rowHeight;
        // Same measured-top rule as `buildDropZones` — a group's block must start where the
        // header actually is, not where accumulating border-box heights says it is (N4b).
        const yTop = options.offsets?.get(row.key) ?? y;
        if (row.kind === 'group-header') {
            flush(yTop);
            current = { slotID: `group:${row.groupID}`, groupID: row.groupID, yTop };
        } else if (row.kind === 'workspace' && row.groupID === null && row.parentID === undefined) {
            // A nested row (§2.9) belongs to its parent's span, never one of its own.
            flush(yTop);
            current = { slotID: `workspace:${row.workspaceID}`, groupID: null, yTop };
        }
        const nextRow = rows[index + 1];
        const nextTop = nextRow === undefined ? undefined : options.offsets?.get(nextRow.key);
        y = nextTop ?? yTop + height;
    }
    flush(y);
    return { spans, tailIndex: model.topLevel.length, contentBottom: y };
}

/** Cursor-y → the top-level index a dragged group would land at. */
export function resolveGroupDropIndex(layout: GroupSpanLayout, y: number, draggedGroupID: string): number | null {
    const draggedIndex = layout.spans.find((span) => span.groupID === draggedGroupID)?.index ?? -1;
    for (const span of layout.spans) {
        if (y < span.yTop || y >= span.yBottom) continue;
        if (span.groupID === draggedGroupID) return null;
        const topHalf = y < (span.yTop + span.yBottom) / 2;
        const raw = topHalf ? span.index : span.index + 1;
        // The dragged block is removed before insertion; a target below it shifts up by one.
        return draggedIndex >= 0 && span.index > draggedIndex ? raw - 1 : raw;
    }
    if (y >= layout.contentBottom) return Math.max(0, layout.tailIndex - 1);
    return null;
}

// ── create-form defaults (§WS-075, §WS-083) ─────────────────────────────────────────

/**
 * The colour the New Workspace form opens on: a uniformly random one that is NOT the trailing
 * workspace's, so an appended row is visually distinct from the neighbour it lands beside.
 *
 * The exact rule the daemon applies when a create carries no colour (`store/derived.ts`'s
 * `nextRandomColor`), restated client-side because the form now always sends one — if the two
 * disagreed, the form's swatch would not be the colour that appeared.
 */
export function nextCreateColor(
    entries: readonly ChromeSidebarEntry[],
    random: () => number = Math.random
): WorkspaceColor {
    const flattened: ChromeWorkspace[] = [];
    for (const entry of entries) {
        if (entry.kind === 'workspace') flattened.push(entry.workspace);
        else flattened.push(...entry.workspaces);
    }
    const last = flattened[flattened.length - 1]?.color;
    const pool = WORKSPACE_COLORS.filter((color) => color !== last);
    if (pool.length === 0) return 'blue';
    return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))] ?? 'blue';
}

/**
 * §WS-083's default new-group name: "New Group", uniquified as "New Group 2", "New Group 3", …
 * against the names already taken (`NexCommands.swift`'s `defaultGroupName`).
 */
export function defaultGroupName(existing: readonly string[]): string {
    const base = 'New Group';
    const taken = new Set(existing);
    if (!taken.has(base)) return base;
    let suffix = 2;
    while (taken.has(`${base} ${String(suffix)}`)) suffix += 1;
    return `${base} ${String(suffix)}`;
}
