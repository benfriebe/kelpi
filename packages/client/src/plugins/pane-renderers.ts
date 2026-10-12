/**
 * A document pane's own renderer, chosen from its header, over the choice for its type.
 *
 * Settings → Plugins → Workbench views (and the in-pane picker) choose a renderer for every
 * document of a type. A scratchpad's header toggle swaps just that pane between the native editor
 * and a plugin renderer, so the choice lives here, keyed by pane ID. Like the per-type choices it
 * is this client's own preference, kept in local storage and shared by its windows; the daemon's
 * pane record is never rewritten. Pane IDs are never reused, so closed panes' entries are simply
 * aged out past a limit rather than tracked.
 *
 * The header and the pane body are separate trees, so the body also publishes what the toggle
 * would do (`RendererToggleFacts`) for the header to draw, and the header's press comes back
 * through `toggleDocumentRenderer`.
 */

import { useSyncExternalStore } from 'react';

const KEY = 'kelpi.pane-renderers.v1';
const CHANGED = 'kelpi-pane-renderers';
/** How many panes keep a choice; the oldest choice goes first. */
export const PANE_RENDERER_LIMIT = 200;

function read(): Record<string, string> {
    try {
        const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
        if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
        return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[0].length <= 160 && entry[1].length <= 160));
    } catch { return {}; }
}

/** The view a pane was switched to, or null when it follows its type's choice. */
export function paneRenderer(paneID: string): string | null {
    return read()[paneID] ?? null;
}

/** Pin a pane to a view, or pass null to have it follow its type's choice again. */
export function setPaneRenderer(paneID: string, viewID: string | null): void {
    const current = read();
    if ((current[paneID] ?? null) === viewID) return;
    const rest = Object.entries(current).filter(([id]) => id !== paneID);
    // Re-inserted last, so the entries run oldest first and the limit drops the oldest.
    const next = (viewID === null ? rest : [...rest, [paneID, viewID]]).slice(-PANE_RENDERER_LIMIT);
    try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(next))); } catch { return; }
    window.dispatchEvent(new CustomEvent(CHANGED));
}

function subscribeChoices(listener: () => void): () => void {
    const storage = (event: StorageEvent): void => { if (event.key === KEY) listener(); };
    window.addEventListener(CHANGED, listener); window.addEventListener('storage', storage);
    return () => { window.removeEventListener(CHANGED, listener); window.removeEventListener('storage', storage); };
}

/** `paneRenderer`, following changes from this window and the others. */
export function usePaneRenderer(paneID: string): string | null {
    return useSyncExternalStore(subscribeChoices, () => paneRenderer(paneID), () => null);
}

/** What a pane's renderer toggle would do: leave a plugin renderer, or switch to `title`. */
export interface RendererToggleFacts {
    /** True while a plugin renderer is on screen, so a press goes back to the native editor. */
    readonly plugin: boolean;
    /** The plugin renderer's title: the one on screen, or the one a press switches to. */
    readonly title: string;
}

const facts = new Map<string, RendererToggleFacts>();
const toggles = new Map<string, () => void>();
const listeners = new Set<() => void>();
const emit = (): void => { for (const listener of [...listeners]) listener(); };

/** A pane body offers its toggle; the returned function withdraws it. */
export function publishRendererToggle(paneID: string, next: RendererToggleFacts, toggle: () => void): () => void {
    facts.set(paneID, next); toggles.set(paneID, toggle); emit();
    return () => {
        if (toggles.get(paneID) !== toggle) return;
        facts.delete(paneID); toggles.delete(paneID); emit();
    };
}

/** The header's press: false when no body on screen offers a toggle for the pane. */
export function toggleDocumentRenderer(paneID: string): boolean {
    const toggle = toggles.get(paneID);
    if (!toggle) return false;
    toggle();
    return true;
}

function subscribeFacts(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** The facts for a pane's header, or null (pass null for a pane that can have none). */
export function useRendererToggle(paneID: string | null): RendererToggleFacts | null {
    return useSyncExternalStore(subscribeFacts, () => (paneID === null ? null : facts.get(paneID) ?? null), () => null);
}
