/**
 * The plugin-facing face of the window's interaction surface.
 *
 * The authority moved to `interaction/surface.ts` - request validation, the queue, the limits,
 * cancellation and the answer rules all live there now, beside the palette session they were
 * always competing with. What stays here is the vocabulary the plugin host already speaks:
 * `PluginView` creates a scope per view, `host-ui.ts` routes four method names at it, and
 * `Workbench.tsx` passes the model down. None of those three changes.
 *
 * The snapshot shape differs deliberately. `InteractionSnapshot` calls the front request
 * `activeModal` and carries the palette beside it; this adapter keeps publishing the older
 * `{ active, queued, notifications }` and the older `{ id, pluginID, pluginName }` owner, because
 * that is what the plugin-side tests and the chrome-lab harness read. Nothing is re-validated on
 * the way through: the adapter is a projection, not a second model.
 */

import {
    INTERACTION_LIMITS,
    INTERACTION_PROMPT_METHODS,
    type InteractionModalRequest,
    type InteractionNotification as SurfaceNotification,
    type InteractionOwner,
    type InteractionSnapshot
} from '../interaction/contract';
import { createInteractionSurface, type InteractionScope, type InteractionSurface } from '../interaction/surface';
import type {
    UIDialogOptions,
    UIInputOptions,
    UINotificationOptions,
    UIQuickPickOptions
} from '../../../plugin-sdk/ui.js';

export const WINDOW_UI_METHODS = INTERACTION_PROMPT_METHODS;
export const UI_SERVICE_LIMITS = INTERACTION_LIMITS;

export interface UIServiceOwner {
    readonly id: string;
    readonly pluginID: string;
    readonly pluginName: string;
}
interface RequestBase {
    readonly id: string;
    readonly owner: UIServiceOwner;
}
export type UIServiceModal = RequestBase &
    (
        | { readonly kind: 'quickPick'; readonly options: UIQuickPickOptions }
        | { readonly kind: 'input'; readonly options: UIInputOptions }
        | { readonly kind: 'dialog'; readonly options: UIDialogOptions }
    );
export type UIServiceNotification = RequestBase & {
    readonly kind: 'notification';
    readonly options: UINotificationOptions;
};
export interface UIServiceSnapshot {
    readonly active: UIServiceModal | null;
    /** Modal requests waiting behind the active prompt. Notifications have a separate queue. */
    readonly queued: number;
    readonly notifications: readonly UIServiceNotification[];
}
export type UIServiceScope = InteractionScope;
export interface UIServiceModel {
    createScope(owner: UIServiceOwner): UIServiceScope;
    getSnapshot(): UIServiceSnapshot;
    subscribe(listener: () => void): () => void;
    answer(requestID: string, value: string | null): void;
    dispose(): void;
}

/** `displayName` is the surface's name for what a plugin scope supplied as `pluginName`. */
function legacyOwner(owner: InteractionOwner): UIServiceOwner {
    return { id: owner.id, pluginID: owner.pluginID ?? '', pluginName: owner.displayName };
}

function legacyModal(request: InteractionModalRequest): UIServiceModal {
    const base = { id: request.id, owner: legacyOwner(request.owner) };
    if (request.kind === 'quickPick') return { ...base, kind: 'quickPick', options: request.options };
    if (request.kind === 'input') return { ...base, kind: 'input', options: request.options };
    return { ...base, kind: 'dialog', options: request.options };
}

function legacyNotification(request: SurfaceNotification): UIServiceNotification {
    return { id: request.id, owner: legacyOwner(request.owner), kind: 'notification', options: request.options };
}

/**
 * Project an existing surface as the plugin host's model.
 *
 * The projection is cached against the surface's own snapshot identity, so repeated reads inside
 * one commit return the same object - a `useSyncExternalStore` over this would otherwise loop.
 */
export function createUIServiceAdapter(surface: InteractionSurface): UIServiceModel {
    let seen: InteractionSnapshot | null = null;
    let projected: UIServiceSnapshot = Object.freeze({
        active: null,
        queued: 0,
        notifications: Object.freeze([])
    });
    return {
        createScope: (owner) => surface.createScope(owner),
        getSnapshot() {
            const current = surface.getSnapshot();
            if (current !== seen) {
                seen = current;
                projected = Object.freeze({
                    active: current.activeModal === null ? null : legacyModal(current.activeModal),
                    queued: current.queued,
                    notifications: Object.freeze(current.notifications.map(legacyNotification))
                });
            }
            return projected;
        },
        subscribe: (listener) => surface.subscribe(listener),
        answer: (requestID, value) => surface.answer(requestID, value),
        dispose: () => surface.dispose()
    };
}

/** A window owns one model; each attached view receives a separately disposable scope. */
export function createUIServices(): UIServiceModel {
    return createUIServiceAdapter(createInteractionSurface());
}
