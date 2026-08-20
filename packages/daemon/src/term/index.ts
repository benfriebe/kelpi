export { DEFAULT_RING_CAPACITY_BYTES, RawRingBuffer } from './ring.js';
export {
    createTerminalStateService,
    DEFAULT_COLS,
    DEFAULT_ROWS,
    DEFAULT_SCROLLBACK_LINES,
    TerminalStateServiceImpl,
    parseOsc7,
    type GridSize,
    type TerminalSnapshot,
    type TerminalStateOptions
} from './service.js';
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
