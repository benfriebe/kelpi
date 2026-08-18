/**
 * WP2.1 — the daemon's domain store.
 *
 * `createStore(fromSnapshot(persisted, { homeDirectory }))` gives the boot module an
 * authoritative state machine; `applyLoadReset` performs the capture-resume-tuples step before
 * any PTY is spawned. Everything else (handlers, WS sync, persistence) talks to this module
 * through `DomainAction` in and `DomainEvent` out.
 */

// `./types.js` re-exports the snapshot API (PersistedSnapshot, toSnapshot, fromSnapshot,
// applyLoadReset), so it is not starred in again here.
export * from './types.js';
export * from './derived.js';
export { applyDomainEvent, applyDomainEvents, deriveEvents } from './events.js';
export { createStore, type NexStore } from './store.js';
export {
    closePaneInWorkspace,
    normalizeURLInput,
    previewAgentEvent,
    reduce,
    resolvedActiveTab,
    tabDisplayLabel
} from './reducers/index.js';
export { isLocalOrInternalHost } from './reducers/url.js';
