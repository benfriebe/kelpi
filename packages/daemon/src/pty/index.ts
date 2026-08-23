/** Public surface of the PTY layer (WP2.2): node-pty manager + programmatic input encoding. */

export {
    DEFAULT_COLS,
    DEFAULT_KILL_ALL_TIMEOUT_MS,
    DEFAULT_KILL_GRACE_MS,
    DEFAULT_ROWS,
    DEFAULT_TERM,
    FALLBACK_SHELL,
    createPtyManager,
    resolveShell,
    resolveSpawnCwd
} from './manager.js';
export type { NexPtyManager, PtyManagerOptions } from './manager.js';

export {
    BRACKETED_PASTE_END,
    BRACKETED_PASTE_START,
    DEFAULT_VT_MODES,
    ENTER_BYTES,
    UnknownNamedKeyError,
    createTerminalInput,
    encodeNamedKey,
    encodePasteText,
    filterPasteText,
    isUnknownNamedKeyError
} from './input.js';
export type { TerminalInputOptions, VtModesLookup } from './input.js';

export {
    DEFAULT_GEOMETRY_LIMIT,
    DEFAULT_GEOMETRY_WRITE_DELAY_MS,
    GEOMETRY_FILE_NAME,
    createPaneGeometryStore
} from './geometry.js';
export type { GridSize, PaneGeometryStore, PaneGeometryStoreOptions } from './geometry.js';

export {
    DEFAULT_SPAWN_DEFER_TIMEOUT_MS,
    createPaneSpawnGate,
    withSpawnGate
} from './spawn-gate.js';
export type {
    DeferredSpawn,
    DeferredSpawnReason,
    PaneSpawnGate,
    PaneSpawnGateOptions
} from './spawn-gate.js';

export { loadNodePty, nodePtySpawner } from './spawner.js';
export type { PtyProcessHandle, PtySpawnRequest, PtySpawner } from './types.js';
