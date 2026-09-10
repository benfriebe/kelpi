import { BUNDLED_FEATURE_DEFINITIONS } from '../features/definitions';
import { isPluginPlacement, type PluginContainerDefinition, type PluginContainerSlot, type PluginInfo, type PluginPlacement } from '@kelpi/protocol';

export type SidebarPlacement = 'sidebar.primary' | 'sidebar.secondary';
export type WorkbenchSelections = Partial<Record<Exclude<PluginPlacement, 'pane'>, string>>;

export interface ViewContribution {
    readonly id: string;
    readonly title: string;
    readonly placements: readonly PluginPlacement[];
    readonly pluginID?: string;
    readonly container?: PluginContainerDefinition;
}
/** Bundled and installed views share identities and placement resolution. React adapters
 * remain bundled; external views use PluginView's isolated host.
 */
export const BUNDLED_VIEWS: readonly ViewContribution[] = BUNDLED_FEATURE_DEFINITIONS;
export const DEFAULT_SLOTS: Readonly<Partial<Record<PluginPlacement, string>>> = Object.fromEntries(BUNDLED_VIEWS.flatMap(view =>
    (view.placements.includes('pane') ? view.placements.filter(place => place.startsWith('document.')) : view.placements.slice(0, 1)).map(place => [place, view.id])));
export function viewRegistry(plugins: readonly PluginInfo[]): readonly ViewContribution[] {
    return [...BUNDLED_VIEWS, ...plugins.filter(plugin => plugin.enabled && plugin.status !== 'failed').flatMap(plugin => [
        ...plugin.manifest.contributes.views.map(view => ({ ...view, pluginID: plugin.manifest.id })),
        ...(plugin.manifest.contributes.containers ?? []).map(container => ({ id: container.id, title: container.title, placements: container.placements, pluginID: plugin.manifest.id, container }))
    ])];
}
export function contributedSlots(views: readonly ViewContribution[]): readonly PluginContainerSlot[] {
    return views.flatMap(view => view.container?.slots ?? []);
}

export function slotDefault(views: readonly ViewContribution[], placement: PluginPlacement): string | undefined {
    return DEFAULT_SLOTS[placement] ?? contributedSlots(views).find(slot => slot.id === placement)?.defaultView;
}

export function slotViews(views: readonly ViewContribution[], placement: PluginPlacement): readonly ViewContribution[] {
    const fallback = slotDefault(views, placement);
    return views.filter(view => view.placements.includes(placement) || (!view.pluginID && view.id === fallback));
}

export function resolveSlot(views: readonly ViewContribution[], placement: PluginPlacement, selected?: string): ViewContribution | undefined {
    const fallback = slotDefault(views, placement);
    // An empty custom slot is an explicit choice, unlike a missing/disabled contribution.
    if (selected === '' && !DEFAULT_SLOTS[placement]) return undefined;
    const candidates = slotViews(views, placement);
    return candidates.find(view => view.id === (selected ?? fallback)) ?? candidates.find(view => view.id === fallback);
}

export const MAX_CONTAINER_DEPTH = 16;
export const MAX_COMPOSED_VIEWS = 128;

/** Saved layouts and cross-plugin changes can introduce cycles after manifest validation. */
export function containerLayoutValid(views: readonly ViewContribution[], selections: WorkbenchSelections, root?: ViewContribution): boolean {
    const depths = new Map<string, number>();
    const visiting = new Set<string>();
    const depth = (view: ViewContribution): number => {
        if (!view.container) return 0;
        if (visiting.has(view.id)) return Infinity;
        const cached = depths.get(view.id);
        if (cached !== undefined) return cached;
        visiting.add(view.id);
        const result = 1 + Math.max(0, ...view.container.slots.map(slot => {
            const child = resolveSlot(views, slot.id, selections[slot.id]);
            return child ? depth(child) : 0;
        }));
        visiting.delete(view.id);
        depths.set(view.id, result);
        return result;
    };
    return (root ? [root] : views).every(view => depth(view) <= MAX_CONTAINER_DEPTH);
}

/** A small DAG can expand into a huge tree; bound actual mounted views as well as nesting. */
export function planComposedViews(views: readonly ViewContribution[], selections: WorkbenchSelections, root: ViewContribution, nativeIDs: ReadonlySet<string>): { paths: ReadonlySet<string>; nativePaths: ReadonlyMap<string, string> } {
    const paths = new Set<string>();
    const nativePaths = new Map<string, string>();
    const visit = (view: ViewContribution, path: string, ancestors: readonly string[]): void => {
        if (paths.size >= MAX_COMPOSED_VIEWS || ancestors.includes(view.id) || ancestors.length > MAX_CONTAINER_DEPTH) return;
        paths.add(path);
        if (!view.pluginID && nativeIDs.has(view.id) && !nativePaths.has(view.id)) nativePaths.set(view.id, path);
        if (!view.container) return;
        for (const slot of view.container.slots) {
            const child = resolveSlot(views, slot.id, selections[slot.id]);
            if (child) visit(child, `${path}/${slot.id}`, [...ancestors, view.id]);
        }
    };
    visit(root, 'root', []);
    return { paths, nativePaths };
}

export function readWorkbenchSelections(value: unknown): WorkbenchSelections {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([slot, id]) => slot !== 'pane' && isPluginPlacement(slot) && typeof id === 'string' && id.length <= 160));
}

function otherBundledSidebar(id: string): string {
    return id === 'kelpi.workspaces' ? 'kelpi.inspector' : 'kelpi.workspaces';
}

/** Native sidebars own selection and command refs, so each has exactly one host. */
export function resolveSidebarViews(views: readonly ViewContribution[], selections: WorkbenchSelections): Record<SidebarPlacement, ViewContribution> {
    const primary = resolveSlot(views, 'sidebar.primary', selections['sidebar.primary'])!;
    const secondary = resolveSlot(views, 'sidebar.secondary', selections['sidebar.secondary'])!;
    if (primary.id !== secondary.id || primary.pluginID) return { 'sidebar.primary': primary, 'sidebar.secondary': secondary };
    const alternate = views.find(view => view.id === otherBundledSidebar(primary.id))!;
    // Keep the explicit choice when a missing plugin on the other side needs a fallback.
    return selections['sidebar.secondary'] === secondary.id && selections['sidebar.primary'] !== primary.id
        ? { 'sidebar.primary': alternate, 'sidebar.secondary': secondary }
        : { 'sidebar.primary': primary, 'sidebar.secondary': alternate };
}

export function selectWorkbenchView(views: readonly ViewContribution[], selections: WorkbenchSelections, placement: Exclude<PluginPlacement, 'pane'>, id: string): WorkbenchSelections {
    const next: WorkbenchSelections = { ...selections, [placement]: id };
    if (id === '' && DEFAULT_SLOTS[placement]) return selections;
    if (id !== '' && !slotViews(views, placement).some(view => view.id === id)) return selections;
    const owner = views.find(view => view.container?.slots.some(slot => slot.id === placement)) ?? views.find(view => view.id === id);
    if (owner && !containerLayoutValid(views, next, owner)) return selections;
    if ((placement !== 'sidebar.primary' && placement !== 'sidebar.secondary') || (id !== 'kelpi.workspaces' && id !== 'kelpi.inspector')) return next;
    const other = placement === 'sidebar.primary' ? 'sidebar.secondary' : 'sidebar.primary';
    const current = resolveSidebarViews(views, selections);
    if (current[other].id === id) {
        const previous = current[placement];
        next[other] = previous.id !== id && previous.placements.includes(other) ? previous.id : otherBundledSidebar(id);
    }
    return next;
}
