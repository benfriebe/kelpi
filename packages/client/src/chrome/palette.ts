/**
 * Command-palette items and the matching rule.
 *
 * app-state-core.md §10.1/§10.2 and shell-ui.md §7 specify this exactly, and the rule is
 * **substring, not fuzzy** — deliberately so, because a fuzzy matcher makes `p:cl` match
 * things a user reading the list would not expect. Port it verbatim:
 *
 *   1. lowercase the query and drop LEADING whitespace;
 *   2. a `w:` prefix restricts to workspace items, `p:` to pane items (the prefix is consumed);
 *   3. split the remainder on spaces into terms, dropping empties;
 *   4. no terms → every item in scope;
 *   5. an item matches when EVERY term is a substring of
 *      `(title + " " + subtitle + " " + workspaceName).toLowerCase()`.
 *
 * The item universe is rebuilt from state on every read: one item per workspace, then one per
 * pane IN LAYOUT ORDER — walked with the daemon's own `layoutPaneOrder`, so a pane that is in
 * the tree but has no record (or a parked pane, which is not in the tree) is handled the same
 * way the daemon handles it rather than by a second implementation here.
 */

import { layoutPaneOrder, visiblePane, type WorkspaceColor, type WorkspaceState } from '@nex/daemon/store';

import { homeAbbreviated } from './theme';
import type { ChromePane } from './types';

export type PaletteItemKind = 'workspace' | 'pane' | 'command';

export interface PaletteItem {
    /** `ws:<uuid>` | `pane:<uuid>` | a command's own id. */
    readonly id: string;
    readonly kind: PaletteItemKind;
    /** An SF-symbol token; `icons.tsx` maps it to a glyph. */
    readonly icon: string;
    readonly title: string;
    readonly subtitle: string;
    readonly workspaceID: string | null;
    readonly workspaceName: string;
    readonly paneID: string | null;
    readonly workspaceColor: WorkspaceColor | null;
    /** Command items only. */
    readonly run?: (() => void) | undefined;
    /**
     * A `keyTriggerDisplayString` hint (`⌘P`). Command items whose action the binding map
     * covers carry one; workspace/pane rows never do — there is no key for "this workspace".
     */
    readonly shortcut?: string | undefined;
}

/** §10.1 icon per pane type. */
export const PANE_TYPE_ICONS: Readonly<Record<ChromePane['type'], string>> = {
    shell: 'terminal',
    markdown: 'doc.text',
    scratchpad: 'note.text',
    diff: 'plusminus',
    web: 'globe'
};

export interface BuildPaletteOptions {
    /** For `homeAbbreviated`; the wire strips the daemon's home dir, so '' is the honest default. */
    readonly homeDirectory?: string | undefined;
    /** Appended after the state-derived items (the client's own verbs). */
    readonly commands?: readonly PaletteItem[] | undefined;
}

/** §10.1: workspace item then its panes, in flat `workspaces`-array order. */
export function buildPaletteItems(
    workspaces: readonly WorkspaceState[],
    options: BuildPaletteOptions = {}
): PaletteItem[] {
    const home = options.homeDirectory ?? '';
    const items: PaletteItem[] = [];
    for (const workspace of workspaces) {
        const paneCount = workspace.panes.length;
        items.push({
            id: `ws:${workspace.id}`,
            kind: 'workspace',
            icon: 'rectangle.stack',
            title: workspace.name,
            subtitle: `${paneCount} ${paneCount === 1 ? 'pane' : 'panes'}`,
            workspaceID: workspace.id,
            workspaceName: workspace.name,
            paneID: null,
            workspaceColor: workspace.color
        });
        for (const paneID of layoutPaneOrder(workspace)) {
            const pane = visiblePane(workspace, paneID);
            if (pane === null) continue;
            items.push({
                id: `pane:${pane.id}`,
                kind: 'pane',
                icon: PANE_TYPE_ICONS[pane.type],
                title: pane.label ?? pane.title ?? homeAbbreviated(pane.workingDirectory, home),
                subtitle: paneSubtitle(pane, home),
                workspaceID: workspace.id,
                workspaceName: workspace.name,
                paneID: pane.id,
                workspaceColor: workspace.color
            });
        }
    }
    if (options.commands !== undefined) items.push(...options.commands);
    return items;
}

/**
 * §10.1: a distinct label AND title → the title; a label alone → the cwd; otherwise empty.
 * (`label != title` is checked because a label copied from the title adds nothing.)
 */
function paneSubtitle(pane: ChromePane, home: string): string {
    if (pane.label !== null && pane.title !== null && pane.label !== pane.title) return pane.title;
    if (pane.label !== null) return homeAbbreviated(pane.workingDirectory, home);
    return '';
}

export type PaletteScope = 'all' | 'workspace' | 'pane';

export interface ParsedPaletteQuery {
    readonly scope: PaletteScope;
    readonly terms: readonly string[];
}

/** Steps 1–3 of the rule, exposed so the UI can show what a `w:`/`p:` prefix did. */
export function parsePaletteQuery(query: string): ParsedPaletteQuery {
    const lowered = query.toLowerCase().replace(/^\s+/, '');
    let scope: PaletteScope = 'all';
    let rest = lowered;
    if (rest.startsWith('w:')) {
        scope = 'workspace';
        rest = rest.slice(2);
    } else if (rest.startsWith('p:')) {
        scope = 'pane';
        rest = rest.slice(2);
    }
    return { scope, terms: rest.split(' ').filter((term) => term.length > 0) };
}

function haystack(item: PaletteItem): string {
    return `${item.title} ${item.subtitle} ${item.workspaceName}`.toLowerCase();
}

function inScope(item: PaletteItem, scope: PaletteScope): boolean {
    if (scope === 'all') return true;
    return item.kind === scope;
}

/** The whole rule: scope, then AND-of-substring-terms. Never fuzzy. */
export function matchPaletteQuery(items: readonly PaletteItem[], query: string): PaletteItem[] {
    const { scope, terms } = parsePaletteQuery(query);
    const scoped = items.filter((item) => inScope(item, scope));
    if (terms.length === 0) return scoped;
    return scoped.filter((item) => {
        const text = haystack(item);
        return terms.every((term) => text.includes(term));
    });
}

export interface PaletteSection {
    readonly kind: PaletteItemKind;
    readonly title: string;
    readonly items: readonly PaletteItem[];
}

const SECTION_TITLES: Readonly<Record<PaletteItemKind, string>> = {
    workspace: 'Workspaces',
    pane: 'Panes',
    command: 'Commands'
};

/**
 * Sectioned view of a match. The Swift palette renders one flat interleaved list (workspace,
 * its panes, next workspace…); the web client groups by kind so the three scopes are visually
 * separable — the matching rule and the within-kind order are untouched, and the keyboard
 * navigation order is exactly this concatenation.
 */
export function paletteSections(items: readonly PaletteItem[]): PaletteSection[] {
    const sections: PaletteSection[] = [];
    for (const kind of ['workspace', 'pane', 'command'] as const) {
        const matching = items.filter((item) => item.kind === kind);
        if (matching.length > 0) sections.push({ kind, title: SECTION_TITLES[kind], items: matching });
    }
    return sections;
}

/** The flat order arrow keys walk (§7 "↑/↓ move the selection (clamped)"). */
export function paletteNavigationOrder(items: readonly PaletteItem[]): PaletteItem[] {
    return paletteSections(items).flatMap((section) => [...section.items]);
}

/** §10.3 selection movement: clamped, never wrapping, no-op on an empty list. */
export function clampSelection(index: number, count: number): number {
    if (count <= 0) return 0;
    if (index < 0) return 0;
    return index > count - 1 ? count - 1 : index;
}
