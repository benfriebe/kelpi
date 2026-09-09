import fs from 'node:fs';
import path from 'node:path';

export const covers = [
    'packages/client/src/terminal/renderer.ts',
    'packages/client/src/terminal/ingest.ts',
    'packages/client/src/connection/pty.ts'
];

/** Old service-selection output must not reappear when a pane changes its column count. */
export default async function ({ page, cli, sandbox, rec, d }) {
    const fixture = path.join(sandbox.root, 'scrollback-fixture.mjs');
    fs.writeFileSync(fixture, `
process.stdin.setRawMode(true);
process.stdout.write('\\x1bc' + Array.from({ length: 300 }, (_, i) =>
    i + ': provider is available "selectedProviderID": "example.service-lab.git"'
).join('\\r\\n') + '\\r\\nREADY-END\\r\\n$ ');
let enters = 0;
process.stdin.on('data', bytes => {
    for (const byte of bytes) {
        if (byte === 13) process.stdout.write('\\r\\n$ ' + (++enters) + ' ');
        if (byte === 3) process.exit(0);
    }
});
`);
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const squash = text => text.replace(/\s+/gu, '');
    const bounds = await page.eval('({ width: window.outerWidth, height: window.outerHeight })');
    const selectionKey = `__kelpiScrollbackResize_${process.pid}_${Date.now()}`;
    const selectionRef = `window[${JSON.stringify(selectionKey)}]`;
    const cleanup = async (label, action) => {
        try { await action(); }
        catch (error) { rec.check(label, false, error instanceof Error ? error.message : String(error)); }
    };
    let workspaceID;
    try {
        // Selection text comes from the real engine's copy-on-select path. Capture its sink in
        // this private page: the shell harness clipboard is the owner's actual OS pasteboard.
        await page.eval(`(() => {
            const clipboard = navigator.clipboard;
            if (!clipboard) throw new Error('selection clipboard API unavailable');
            const state = {
                clipboard, descriptor: Object.getOwnPropertyDescriptor(clipboard, 'writeText'),
                installed: false, writes: 0, text: null
            };
            ${selectionRef} = state;
            Object.defineProperty(clipboard, 'writeText', {
                configurable: true, enumerable: state.descriptor?.enumerable ?? false, writable: true,
                value: async text => { state.text = String(text); state.writes += 1; }
            });
            state.installed = true;
        })()`);
        workspaceID = JSON.parse(await cli.ok(['workspace', 'create', '--name', 'Scrollback resize', '--path', sandbox.root, '--json'])).workspace_id;
        const paneID = JSON.parse(await cli.ok(['pane', 'list', '--workspace', workspaceID, '--json']))[0].id;
        const root = `[data-pane-id="${paneID}"][data-terminal-status]`;
        if (!await d.settleDom(page, `document.querySelector('${root}')?.getAttribute('data-terminal-status') === 'live'`)) {
            throw new Error('fixture terminal did not start');
        }

        let previousCanvasWidth;
        const settleGrid = async (width, height) => {
            await page.eval(`window.resizeTo(${width}, ${height})`);
            let previous;
            let stableSince = Date.now();
            const settled = await d.settle(async () => {
                const grid = await page.eval(`(() => { const r = document.querySelector('${root}'); const c = r?.querySelector('canvas'); return { w: window.outerWidth, h: window.outerHeight, held: r?.getAttribute('data-terminal-paint-held'), width: c?.width, height: c?.height }; })()`);
                const sample = JSON.stringify([grid, await cli.ok(['pane', 'capture', '--target', paneID])]);
                if (sample !== previous) { previous = sample; stableSince = Date.now(); }
                return grid.w === width && grid.h === height && grid.held !== 'true' && Date.now() - stableSince >= 400;
            }, { ceilingMs: 4000, intervalMs: 120 });
            if (!settled) throw new Error(`terminal did not settle after resize to ${width}x${height}`);
            const canvasWidth = await page.eval(`document.querySelector('${root} canvas')?.width`);
            if (previousCanvasWidth !== undefined) {
                rec.check(`${width}x${height}: the terminal grid changes width`, canvasWidth > 0 && canvasWidth !== previousCanvasWidth);
            }
            previousCanvasWidth = canvasWidth;
        };
        await settleGrid(680, 500);
        await cli.ok(['pane', 'send', '--target', paneID, `exec ${quote(process.execPath)} ${quote(fixture)}`]);
        rec.check('long service-selection output reaches the terminal', await d.settle(async () =>
            (await cli.ok(['pane', 'capture', '--target', paneID])).includes('READY-END')));

        const readClient = async label => {
            const grid = await page.eval(`(() => {
                const r = document.querySelector('${root}'); const c = r?.querySelector('canvas');
                if (!r || !c) return null;
                const b = c.getBoundingClientRect(); const cell = r.getAttribute('data-terminal-cell').split('x').map(Number);
                return { x: b.x, y: b.y, w: b.width, h: b.height, cw: cell[0], ch: cell[1] };
            })()`);
            if (!grid || !grid.cw || !grid.ch) throw new Error('terminal canvas metrics unavailable');
            const before = await page.eval(`(() => {
                const state = ${selectionRef}; state.text = null; return state.writes;
            })()`);
            const from = { x: grid.x + grid.cw * 0.2, y: grid.y + grid.ch * 0.5 };
            const to = { x: grid.x + grid.w - grid.cw * 0.2, y: grid.y + grid.h - grid.ch * 0.5 };
            await page.mouse('mouseMoved', from.x, from.y, { button: 'none', buttons: 0 });
            try {
                await page.mouse('mousePressed', from.x, from.y);
                await pause(80);
                await page.mouse('mouseMoved', (from.x + to.x) / 2, (from.y + to.y) / 2, { buttons: 1 });
                await pause(60);
                await page.mouse('mouseMoved', to.x, to.y, { buttons: 1 });
                await pause(80);
            } finally {
                await page.mouse('mouseReleased', to.x, to.y);
            }
            let selection;
            const copied = await d.settle(async () => {
                const state = await page.eval(`(() => {
                    const state = ${selectionRef}; return { writes: state.writes, text: state.text };
                })()`);
                if (state.writes <= before || typeof state.text !== 'string' || state.text.length === 0) return false;
                selection = state.text;
                return true;
            });
            if (!copied) throw new Error(`${label}: engine selection did not reach the page-local capture`);
            return selection;
        };
        const compare = async label => {
            const client = await readClient(label);
            const server = await cli.ok(['pane', 'capture', '--target', paneID]);
            fs.writeFileSync(path.join(rec.outDir, `${rec.name}-${label}-client.txt`), client);
            fs.writeFileSync(path.join(rec.outDir, `${rec.name}-${label}-daemon.txt`), server);
            rec.check(`${label}: client viewport matches the daemon`, squash(client) === squash(server),
                `client=${client.length} chars, daemon=${server.length} chars`);
        };
        await compare('initial');
        for (const [index, [width, height]] of [[1260, 900], [720, 520], [1320, 820], [680, 500], [1260, 900]].entries()) {
            await settleGrid(width, height);
            await compare(`resize-${index + 1}`);
            await d.focusPaneBody(page, paneID);
            await page.key('Enter', { key: 'Enter' });
            rec.check(`enter-${index + 1}: input reaches the PTY after replay`, await d.settle(async () =>
                (await cli.ok(['pane', 'capture', '--target', paneID])).trimEnd().endsWith(`$ ${index + 1}`)));
            await compare(`enter-${index + 1}`);
        }
    } finally {
        await cleanup('fixture workspace is deleted', async () => {
            if (workspaceID) await cli.ok(['workspace', 'delete', workspaceID, '--force']);
        });
        await cleanup('selection clipboard hook is restored', () => page.eval(`(() => {
            const state = ${selectionRef};
            if (!state) return;
            if (state.installed) {
                if (state.descriptor) Object.defineProperty(state.clipboard, 'writeText', state.descriptor);
                else delete state.clipboard.writeText;
            }
            delete ${selectionRef};
        })()`));
        await cleanup('original window size is restored', () => page.eval(`window.resizeTo(${bounds.width}, ${bounds.height})`));
    }
}
