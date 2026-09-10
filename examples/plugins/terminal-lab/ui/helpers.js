// Emulator-independent decisions, kept separate so input and replay rules can be tested.
const namedCodes = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, ' ': 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46 };
const punctuationCodes = { Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190, Slash: 191, Backquote: 192, BracketLeft: 219, Backslash: 220, BracketRight: 221, Quote: 222 };
export function keyEventInit(key) {
    const code = key.code ?? '';
    const fkey = /^F([1-9]|1\d|2[0-4])$/.exec(key.key);
    const keyCode = namedCodes[key.key] ?? punctuationCodes[code] ??
        (/^Key[A-Z]$/.test(code) ? code.charCodeAt(3) : /^Digit[0-9]$/.test(code) ? code.charCodeAt(5) :
            fkey ? 111 + Number(fkey[1]) : /^[a-z0-9]$/i.test(key.key) ? key.key.toUpperCase().charCodeAt(0) : 0);
    return { ...key, code, keyCode, which: keyCode, bubbles: true, cancelable: true };
}
export function stickyKey(key, modifiers, composing = false) {
    if ((!modifiers.ctrl && !modifiers.alt) || composing || key.isComposing || key.keyCode === 229 || ['Process', 'Unidentified', 'Dead', 'AltGraph', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(key.key)) return null;
    return { key: key.key, code: key.code, location: key.location, shiftKey: key.shiftKey, ctrlKey: key.ctrlKey || modifiers.ctrl, altKey: key.altKey || modifiers.alt, metaKey: key.metaKey, repeat: key.repeat, type: 'keydown' };
}
export function stickyText(event, modifiers, composing = false) {
    if (composing || event.isComposing || event.inputType !== 'insertText' || !event.cancelable || typeof event.data !== 'string' || [...event.data].length !== 1) return null;
    return stickyKey({ key: event.data }, modifiers);
}
export function gridFromMetrics(width, height, cell, paddingX = 0, paddingY = 0, gutter = 14) {
    if (![width, height, cell?.width, cell?.height].every(value => Number.isFinite(value) && value > 0)) return null;
    const cols = Math.floor((width - paddingX * 2 - gutter) / cell.width), rows = Math.floor((height - paddingY * 2) / cell.height);
    if (cols < 1 || rows < 1) return null;
    return { cols: Math.min(65535, cols), rows: Math.min(65535, rows), cellHeight: cell.height };
}
export function revealLocation(bufferLength, rows, reveal) {
    const line = bufferLength - reveal.linesFromBottom;
    if (!Number.isInteger(line) || line < 0 || line >= bufferLength) return null;
    return { line, top: Math.max(0, Math.min(bufferLength - rows, line - Math.floor(rows / 2))), col: reveal.col, length: reveal.length };
}
export function createInputRouter(emit) {
    let origin = null, generation = 0, userInput = false;
    return {
        // Keyboard event markers supplement xterm's synchronous user-input flag.
        // Mouse reports use run() at the actual pinned emulator emission boundary.
        mark(next) {
            origin = next; const current = ++generation;
            queueMicrotask(() => { if (generation === current) origin = null; });
        },
        run(next, callback) {
            const previous = origin; origin = next;
            try { return callback(); } finally { origin = previous; }
        },
        // xterm's user-input notification is synchronous with the following onData.
        // It also identifies IME commits emitted after the compositionend DOM event.
        userInput() { userInput = true; },
        data(data) {
            const direct = origin === 'mouse' || origin === 'release' || (!userInput && origin !== 'keyboard');
            const response = !userInput && origin === null;
            userInput = false; emit(data, direct, response);
        },
        binary(data) { userInput = false; emit(Uint8Array.from(data, character => character.charCodeAt(0)), true, false); }
    };
}
export async function consumeTerminalFrame(terminal, frame, write, restoreModes = () => {}) {
    if (frame.type === 'replay') {
        // CAN ends a split CSI/OSC/DCS before RIS clears both parser and screen state.
        // Never concatenate a replacement snapshot into the old parser's partial escape.
        // xterm.reset() alone does not reset its parser; RIS is deliberately in-band.
        await write(new Uint8Array([0x18, 0x1b, 0x63]));
        terminal.reset();
        // User input can arrive while a long replay is being parsed.
        restoreModes();
        await write(frame.data);
        // A snapshot can omit input modes or contain its own reset sequence.
        restoreModes();
    } else if (frame.type === 'output') await write(frame.data);
}
