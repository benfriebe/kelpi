import fs from 'node:fs';
import path from 'node:path';
import { Ghostty } from '../../vendor/ghostty-web-patched/dist/ghostty-web.js';

export const covers = [
    'vendor/ghostty-web-patched',
    'packages/client/src/terminal/selection-scrollback.wasm.test.ts'
];

// A real mouse selection and Cmd-C in a real pane, across a measured native history trim.
// The clipboard sink is page-local, so copy-on-select cannot accidentally satisfy Cmd-C
// and this regression does not overwrite the user's pasteboard.
export default async function ({ page, cli, sandbox, rec, d, sleep }) {
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    const key = `__kelpiSelectionTrim_${Date.now()}`;
    const ref = `window[${JSON.stringify(key)}]`;
    const line = n => `conversation-${String(n).padStart(5, '0')}`;
    const prologue = '\x1bc\x1b[3J\x1b[?1000h\x1b[?1006h';
    const start = JSON.parse(await cli.ok(['workspace', 'list', '--json'])).find(w => w.is_active)?.id;
    let workspaceID;
    try {
        await page.eval(`(() => {
            const clipboard = navigator.clipboard;
            const state = { clipboard, descriptor: Object.getOwnPropertyDescriptor(clipboard, 'writeText'), text: null, writes: 0 };
            ${ref} = state;
            Object.defineProperty(clipboard, 'writeText', { configurable: true, value: async text => {
                state.text = String(text); state.writes++;
            } });
        })()`);
        workspaceID = JSON.parse(await cli.ok(['workspace', 'create', '--name', 'Selection trim', '--path', sandbox.root, '--json'])).workspace_id;
        const paneID = JSON.parse(await cli.ok(['pane', 'list', '--workspace', workspaceID, '--json']))[0].id;
        const root = `[data-pane-id="${paneID}"][data-terminal-status]`;
        if (!await d.settleDom(page, `document.querySelector('${root}')?.getAttribute('data-terminal-status') === 'live'`)) throw new Error('terminal did not start');
        await d.focusPaneBody(page, paneID);
        await sleep(500); // allow the initial geometry/replay to settle before the fixture
        const grid = await page.eval(`(() => {
            const r = document.querySelector('${root}'), c = r.querySelector('canvas');
            const b = c.getBoundingClientRect(), cell = r.getAttribute('data-terminal-cell').split('x').map(Number);
            return { x: b.x, y: b.y, cw: cell[0], ch: cell[1], cols: Math.round(b.width / cell[0]), rows: Math.round(b.height / cell[1]) };
        })()`);
        if (!(grid.cols > 20 && grid.rows > 6)) throw new Error(`invalid grid ${JSON.stringify(grid)}`);

        // Page sizes vary with the grid. Measure this build's first trim rather than hard-code
        // a row count or assume that scrollback is trimmed one line at a time.
        const module = await WebAssembly.compile(fs.readFileSync(new URL('../../vendor/ghostty-web-patched/ghostty-vt.wasm', import.meta.url)));
        const engine = new Ghostty(await WebAssembly.instantiate(module, { env: { log() {} } }), module);
        const vt = engine.createTerminal(grid.cols, grid.rows, { scrollbackLimit: 10000 });
        let trimAt;
        let previous = 0;
        try {
            vt.write(prologue);
            for (let i = 0; i < 20000; i++) {
                vt.write(`${line(i)}\r\n`);
                const size = vt.getScrollbackLength();
                if (size < previous) { trimAt = i + 1; break; }
                previous = size;
            }
        } finally { vt.free(); }
        if (!trimAt) throw new Error('could not locate the history trim boundary');
        const initial = trimAt - 10;
        const signal = path.join(sandbox.root, 'selection-trim-go');
        const fixture = path.join(sandbox.root, 'selection-trim.mjs');
        fs.writeFileSync(fixture, `
import fs from 'node:fs';
process.stdin.setRawMode(true);
const line = n => 'conversation-' + String(n).padStart(5, '0');
let next = 0;
const emit = count => { for (let i = 0; i < count; i++) process.stdout.write(line(next++) + '\\r\\n'); };
process.stdout.write(${JSON.stringify(prologue)});
emit(${initial});
const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(signal)})) { clearInterval(timer); emit(20); } }, 25);
process.stdin.on('data', data => { if (data.includes(3)) process.exit(0); });
`);
        await cli.ok(['pane', 'send', '--target', paneID, `exec ${quote(process.execPath)} ${quote(fixture)}`]);
        if (!await d.settle(async () => (await cli.ok(['pane', 'capture', '--target', paneID])).includes(line(initial - 1)))) throw new Error('fixture output did not arrive');
        if (!await d.settleDom(page, `document.querySelector('${root}').getAttribute('data-terminal-mouse') !== 'none'`)) throw new Error('fixture did not enable mouse reporting');
        await sleep(200);
        const from = { x: grid.x + grid.cw * .5, y: grid.y + grid.ch * 3.5 };
        const to = { x: grid.x + grid.cw * 17.5, y: from.y };
        const modifiers = d.MOD.shift;
        await page.mouse('mousePressed', from.x, from.y, { button: 'left', modifiers });
        try {
            await sleep(80);
            await page.mouse('mouseMoved', to.x, to.y, { buttons: 1, modifiers });
            await sleep(80);
        } finally { await page.mouse('mouseReleased', to.x, to.y, { button: 'left', modifiers }); }
        const expected = line(initial - grid.rows + 4);
        rec.check('Shift-drag selects the visible conversation row before the trim', await d.settle(async () => await page.eval(`${ref}.text`) === expected), expected);
        await page.eval(`${ref}.text = 'POISON'; ${ref}.writes = 0`);
        fs.writeFileSync(signal, 'go');
        if (!await d.settle(async () => (await cli.ok(['pane', 'capture', '--target', paneID])).includes(line(initial + 19)))) throw new Error('trim output did not arrive');
        await sleep(250);
        await page.key('KeyC', { key: 'c', modifiers: d.MOD.meta });
        rec.check('Cmd-C reads the same retained conversation after history trims', await d.settle(async () => await page.eval(`${ref}.text`) === expected),
            `grid ${grid.cols}x${grid.rows}; native trim at ${trimAt}; selected ${expected}; copied ${JSON.stringify(await page.eval(`${ref}.text`))}`);
        rec.check('the explicit copy wrote after the poisoned copy-on-select result', await page.eval(`${ref}.writes > 0`));
    } finally {
        try { if (workspaceID) await cli.ok(['workspace', 'delete', workspaceID, '--force']); }
        finally {
            await page.eval(`(() => { const state = ${ref}; if (!state) return;
                if (state.descriptor) Object.defineProperty(state.clipboard, 'writeText', state.descriptor);
                else delete state.clipboard.writeText;
                delete ${ref};
            })()`);
            if (start) {
                const row = `[data-testid="workspace-row"][data-workspace-id="${start}"]`;
                if (await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`)) await page.click(row);
            }
        }
    }
}
