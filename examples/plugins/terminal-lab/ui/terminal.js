import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import { mountTerminalLab } from './renderer.js';

const terminal = new Terminal({ cols: 80, rows: 24, fontFamily: 'ui-monospace, monospace', fontSize: 13, scrollback: 10000, cursorBlink: true, macOptionIsMeta: true, allowTransparency: true, disableStdin: true });
await mountTerminalLab(terminal, globalThis.kelpi, document.getElementById('terminal'));
