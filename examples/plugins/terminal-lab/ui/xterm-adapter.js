// These fields belong to the pinned xterm 6 adapter, never to Kelpi internals.
// Assign modes out of band: writing synthetic escapes between split output frames
// would corrupt an unfinished CSI/OSC/DCS in the emulator's parser.
const protocols = { none: 'NONE', x10: 'X10', vt200: 'VT200', drag: 'DRAG', any: 'ANY' };
const encodings = { x10: 'DEFAULT', sgr: 'SGR', 'sgr-pixels': 'SGR_PIXELS' };

export function bindXtermMouse(terminal, router) {
    const mouse = terminal._core?.coreMouseService, original = mouse?.triggerMouseEvent;
    if (typeof original !== 'function') throw new Error('Terminal Lab requires its pinned xterm 6 mouse adapter.');
    // Native DOM dispatch can run a microtask between capture and target listeners.
    // Scope the actual synchronous report, including SGR's onUserInput + onData,
    // instead of inferring its origin from a marker left by an earlier listener.
    function report(...args) { return router.run('mouse', () => original.apply(this, args)); }
    mouse.triggerMouseEvent = report;
    return { dispose() { if (mouse.triggerMouseEvent === report) mouse.triggerMouseEvent = original; } };
}

export function applyXtermModes(terminal, modes) {
    const core = terminal._core;
    if (!core?.coreService?.decPrivateModes || !core?.coreMouseService) throw new Error('Terminal Lab requires its pinned xterm 6 mode adapter.');
    if (typeof modes.applicationCursorKeys === 'boolean') core.coreService.decPrivateModes.applicationCursorKeys = modes.applicationCursorKeys;
    if (typeof modes.bracketedPaste === 'boolean') core.coreService.decPrivateModes.bracketedPasteMode = modes.bracketedPaste;
    if (typeof modes.mouseTracking !== 'string' || typeof modes.mouseFormat !== 'string') return;
    const protocol = protocols[modes.mouseTracking], encoding = encodings[modes.mouseFormat];
    // xterm 6 removed UTF-8 and urxvt encodings. Do not emit the wrong wire format.
    const supportedProtocol = encoding && protocol ? protocol : 'NONE';
    if (encoding && core.coreMouseService.activeEncoding !== encoding) core.coreMouseService.activeEncoding = encoding;
    if (core.coreMouseService.activeProtocol !== supportedProtocol) core.coreMouseService.activeProtocol = supportedProtocol;
}
