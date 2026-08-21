export { DEFAULT_RING_CAPACITY_BYTES, RawRingBuffer } from './ring.js';
export {
    createTerminalStateService,
    DEFAULT_COLS,
    DEFAULT_ROWS,
    DEFAULT_SCROLLBACK_LINES,
    TerminalStateServiceImpl,
    parseOsc7,
    sameModes,
    type GridSize,
    type TerminalSnapshot,
    type TerminalStateOptions
} from './service.js';
export {
    DEFAULT_MOUSE_FORMAT,
    MOUSE_FORMAT_MODES,
    applyFormatModes,
    trackMouseFormat,
    type MouseFormat,
    type MouseFormatTracker,
    type MouseTrackingMode
} from './mouse-modes.js';
export {
    MAX_TERMINAL_MATCHES,
    bufferLength,
    collectLogicalLines,
    findMatches,
    searchTerminal,
    type LogicalLine,
    type SearchOptions,
    type TerminalMatch
} from './search.js';
