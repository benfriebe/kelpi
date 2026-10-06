/**
 * A workspace switch shows every terminal pane painted from its first frame: no pane flashes its
 * bare fill while the new engines come up (`client/src/terminal/poster.ts`).
 *
 * The defect, measured on the tree before the poster: two workspaces of four filled shell panes,
 * and every switch had seven or eight frames (at 120 Hz) with a blank pane in them, two to five
 * with all four blank, and the panes popping in one after another ~70-120 ms after the click. A
 * background workspace has no engines (`terminal/mount-policy.ts`), so every switch builds them
 * again; the poster puts the picture each pane left with over it until its new engine has drawn
 * the replay.
 *
 * Why a scenario: the flash is a few frames of a composited canvas, which jsdom has neither of.
 * The instrument is an in-page `requestAnimationFrame` sampler that reads, per frame and per
 * pane, the canvas the user is LOOKING AT (the poster while it stands, the engine's canvas
 * otherwise), downscales it and counts lit pixels: a blank pane is a canvas with nothing on it,
 * or no canvas at all. Canvas readback is unaffected by the lane window's zero opacity, so this
 * holds at `--window hidden`.
 *
 * Switched both ways a person does it, a sidebar click and ⌘<digit>, and checked on every
 * switch: no frame with a blank incoming pane (including at the hand-over from poster to live
 * engine), the poster actually engaged (a fast machine alone must not pass this), and by the end
 * every pane is live with the poster gone.
 */

/**
 * The sources this exercises, so `verify.mjs` re-runs it when they move (ui-audit/README.md ▸
 * The rule): the poster cache, the pane that shows and captures it, and the renderer's
 * replay-applied signal that decides when it comes down.
 */
export const covers = [
    'packages/client/src/terminal/poster.ts',
    'packages/client/src/terminal/TerminalPane.tsx',
    'packages/client/src/terminal/renderer.ts'
];

const WORKSPACES = ['Painted-A', 'Painted-B'];
const PANES_PER_WORKSPACE = 4;
const LINES = 3000;
const SWITCHES = 6;
/** How long each switch is watched: the poster's own ceiling is 3 s, a healthy hand-over ~0.1 s. */
const WATCH_MS = 1_500;
/** Lit pixels (of 48x32 samples) below which a pane counts as blank. A filled pane has hundreds. */
const BLANK_INK = 20;

const SAMPLER = `(() => {
    if (window.__paintedProbe) return;
    const scratch = document.createElement('canvas');
    scratch.width = 48;
    scratch.height = 32;
    const context = scratch.getContext('2d', { willReadFrequently: true });
    const ink = (canvas) => {
        if (canvas.width === 0 || canvas.height === 0) return 0;
        context.clearRect(0, 0, 48, 32);
        context.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, 48, 32);
        const data = context.getImageData(0, 0, 48, 32).data;
        let lit = 0;
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] > 0 && Math.max(data[i], data[i + 1], data[i + 2]) > 40) lit += 1;
        }
        return lit;
    };
    const probe = { frames: [], running: false, t0: 0 };
    const tick = () => {
        if (!probe.running) return;
        const panes = [];
        for (const root of document.querySelectorAll('[data-testid="pane-grid"] [data-pane-id][data-terminal-status]')) {
            const host = root.querySelector('[data-terminal-host]');
            const engine = host === null ? null : host.querySelector('canvas');
            const poster = Array.from(root.querySelectorAll('canvas')).find((c) => host === null || !host.contains(c)) ?? null;
            const shown = poster ?? (host !== null && host.style.opacity === '0' ? null : engine);
            panes.push({
                id: root.getAttribute('data-pane-id'),
                status: root.getAttribute('data-terminal-status'),
                poster: poster !== null,
                ink: shown === null ? 0 : ink(shown)
            });
        }
        probe.frames.push({ t: performance.now() - probe.t0, panes });
        requestAnimationFrame(tick);
    };
    probe.start = () => {
        probe.frames = [];
        probe.t0 = performance.now();
        probe.running = true;
        requestAnimationFrame(tick);
    };
    probe.stop = () => {
        probe.running = false;
        return JSON.stringify(probe.frames);
    };
    window.__paintedProbe = probe;
})()`;

export default async function ({ page, cli, rec, d, sleep }) {
    // The workspaces this scenario opens go when it does (#205 ▸ cleanup discipline).
    const startingWorkspaces = JSON.parse(await cli.ok(['workspace', 'list', '--json']));
    const startingWorkspace = startingWorkspaces.find((workspace) => workspace.is_active === true)?.id ?? null;
    const initialWorkspaceIDs = new Set(startingWorkspaces.map((workspace) => workspace.id));
    try {
        const json = async (args) => JSON.parse(await cli.ok(args));
        const panesOf = {};
        const workspaceIDOf = {};
        for (const name of WORKSPACES) {
            await cli.ok(['workspace', 'create', '--name', name]);
            for (let index = 1; index < PANES_PER_WORKSPACE; index += 1) {
                const ids = (await json(['pane', 'list', '--workspace', name, '--json'])).map((pane) => pane.id);
                await json(['pane', 'split', '--target', ids[ids.length - 1], '--direction', index % 2 ? 'right' : 'down', '--json']);
            }
            panesOf[name] = (await json(['pane', 'list', '--workspace', name, '--json'])).map((pane) => pane.id);
            workspaceIDOf[name] = (await json(['workspace', 'list', '--json'])).find((workspace) => workspace.name === name).id;
        }

        // Fill every pane with a screen of coloured text and some scrollback, so a blank canvas
        // and a painted one cannot be confused.
        let ordinal = 0;
        for (const name of WORKSPACES) {
            for (const paneID of panesOf[name]) {
                ordinal += 1;
                await cli.ok([
                    'pane', 'send', '--target', paneID,
                    `clear; for i in $(seq 1 ${LINES}); do printf '\\033[3%dm%s pane-${ordinal} line %05d the quick brown fox jumps over the lazy dog\\033[0m\\n' $((i % 7 + 1)) ${name} $i; done; echo filled-${ordinal}`
                ]);
            }
        }
        ordinal = 0;
        for (const name of WORKSPACES) {
            for (const paneID of panesOf[name]) {
                ordinal += 1;
                const marker = `filled-${ordinal}`;
                const filled = await d.settle(
                    async () => (await cli.ok(['pane', 'capture', '--target', paneID])).split('\n').some((line) => line.trim() === marker),
                    { ceilingMs: 30_000, intervalMs: 250 }
                );
                if (!filled) throw new Error(`pane ${paneID} never finished filling`);
            }
        }
        rec.note(`${WORKSPACES.length} workspaces × ${PANES_PER_WORKSPACE} panes, ${LINES} lines each`);

        const livePanes = async () => Number(await page.eval(`document.querySelectorAll('[data-terminal-status="live"]').length`));
        const ordinalOf = async (name) =>
            Number(
                await page.eval(
                    `Array.from(document.querySelectorAll('${d.PAGE.workspaceRows}')).findIndex(el => el.getAttribute('data-workspace-id') === '${workspaceIDOf[name]}') + 1`
                )
            );
        const activate = async (name, method) => {
            if (method === 'click') {
                await page.click(`${d.PAGE.workspaceRows}[data-workspace-id="${workspaceIDOf[name]}"]`);
                return;
            }
            const digit = await ordinalOf(name);
            await page.key(`Digit${String(digit)}`, { modifiers: d.MOD.meta, key: String(digit), keyCode: 48 + digit });
        };

        // Visit each once, so each pane has been seen with a whole screen and has left a poster.
        for (const name of WORKSPACES) {
            await activate(name, 'click');
            const up = await d.settle(async () => (await livePanes()) === PANES_PER_WORKSPACE, { ceilingMs: 20_000 });
            rec.check(`${name} comes up with every pane live`, up);
            await sleep(500);
        }

        await page.eval(SAMPLER);
        for (let index = 0; index < SWITCHES; index += 1) {
            const name = WORKSPACES[index % 2];
            const method = index < SWITCHES / 2 ? 'click' : 'key';
            const label = `switch ${String(index + 1)} to ${name} (${method})`;
            const incoming = new Set(panesOf[name]);

            await page.eval('window.__paintedProbe.start()');
            await activate(name, method);
            await sleep(WATCH_MS);
            const frames = JSON.parse(String(await page.eval('window.__paintedProbe.stop()')));

            // From the first frame the grid shows the incoming workspace.
            const first = frames.findIndex((frame) => frame.panes.some((pane) => incoming.has(pane.id)));
            const watched = first < 0 ? [] : frames.slice(first);
            let blankFrames = 0;
            let posterFrames = 0;
            for (const frame of watched) {
                const shown = frame.panes.filter((pane) => incoming.has(pane.id));
                if (shown.length < incoming.size || shown.some((pane) => pane.ink <= BLANK_INK)) blankFrames += 1;
                if (shown.some((pane) => pane.poster)) posterFrames += 1;
            }
            const last = watched.at(-1);
            const settled =
                last !== undefined &&
                last.panes.filter((pane) => incoming.has(pane.id) && pane.status === 'live' && !pane.poster).length === incoming.size;
            rec.note(`${label}: ${String(watched.length)} frames watched, ${String(posterFrames)} with a poster, ${String(blankFrames)} with a blank pane`);
            rec.check(`${label}: the incoming workspace is on screen`, watched.length > 0);
            rec.check(`${label}: no frame shows a blank pane`, blankFrames === 0, `${String(blankFrames)} frame(s) had a blank or missing pane`);
            rec.check(`${label}: the poster stood in while the engines came up`, posterFrames > 0);
            rec.check(`${label}: every pane ends live, with its poster gone`, settled);
        }
        await rec.shot(page, 'after-the-switches');
    } finally {
        for (const workspace of JSON.parse(await cli.ok(['workspace', 'list', '--json']))) {
            if (!initialWorkspaceIDs.has(workspace.id)) await cli.run(['workspace', 'delete', workspace.id, '--force']);
        }
        if (startingWorkspace !== null) {
            const row = `[data-testid="workspace-row"][data-workspace-id="${startingWorkspace}"]`;
            if (await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 8_000 })) await page.click(row);
        }
    }
}
