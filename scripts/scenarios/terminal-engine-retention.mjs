/**
 * A disposed terminal is garbage: the live WebAssembly memories in the renderer track the
 * MOUNTED panes, not every pane ever shown.
 *
 * Why it is a scenario and not a unit test: the retainer that broke this (ghostty-web
 * `0.4.0-nex.12`, PROVENANCE.md) was a `document` listener nobody's unit test could see, and
 * the ceiling it hit is V8's — on the order of a hundred WASM memories per process, after
 * which `new WebAssembly.Instance` throws `Cannot allocate Wasm memory for new instance` and
 * every pane in the window lands on the placeholder at once (2026-09-10). Only the real engine
 * in the real renderer, counted after a real GC, says whether that can happen again.
 *
 * The instrument is CDP: `HeapProfiler.collectGarbage` then `Runtime.queryObjects` on
 * `WebAssembly.Memory.prototype`, which counts what is REACHABLE — exactly the number V8 is
 * counting against its cap. Three workspaces of six panes, swapped in rounds: the mount policy
 * keeps at most one workspace's engines alive, so the count must sit near the mounted pane
 * count and must not climb with the number of swaps. Before the fix it grew by one per remount
 * (18 per round here) and this scenario failed on round four.
 */

/**
 * The sources this exercises, so `verify.mjs` re-runs it when they move (ui-audit/README.md ▸
 * The rule). The vendored engine's selection manager and terminal own the listeners and the
 * `dispose()` that must remove them; `ghostty.ts` is where an instance is made per terminal;
 * `renderer.ts` decides when a replay reset builds another; `mount-policy.ts` is the bound the
 * count is measured against; `TerminalPane.tsx` is the mount/unmount that disposes engines and
 * the placeholder that must not appear.
 */
export const covers = [
    'vendor/ghostty-web-patched/source/lib/selection-manager.ts',
    'vendor/ghostty-web-patched/source/lib/terminal.ts',
    'vendor/ghostty-web-patched/source/lib/ghostty.ts',
    'packages/client/src/terminal/renderer.ts',
    'packages/client/src/terminal/mount-policy.ts',
    'packages/client/src/terminal/TerminalPane.tsx'
];

const WORKSPACES = ['Retain-A', 'Retain-B', 'Retain-C'];
const PANES_PER_WORKSPACE = 6;
const ROUNDS = 4;
/**
 * Memories a healthy renderer may hold beyond its live panes: the shared `init()` instance the
 * key encoder lives on, plus a little room for an engine mid-teardown when the count is taken.
 */
const SLACK = 4;

export default async function ({ page, cli, rec, d }) {
    /*
     * The workspace this scenario opens for itself goes when this scenario does. In a battery every
     * scenario shares one sandbox, and a workspace left behind is not inert: it changes what
     * `Default` holds, it moves every later workspace's ⌘-digit ordinal, and it leaves the window
     * looking somewhere its successor did not choose (#205 ▸ cleanup discipline).
     */
    const startingWorkspaces = JSON.parse(await cli.ok(['workspace', 'list', '--json']));
    const startingWorkspace = startingWorkspaces.find((workspace) => workspace.is_active === true)?.id ?? null;
    const initialWorkspaceIDs = new Set(startingWorkspaces.map((workspace) => workspace.id));
    try {
        const json = async (args) => JSON.parse(await cli.ok(args));

        /** Reachable objects with this prototype, after a full GC — what V8 counts against its cap. */
        const countLive = async (ctor) => {
            await page.send('HeapProfiler.collectGarbage', {}, 60_000);
            await page.send('HeapProfiler.collectGarbage', {}, 60_000);
            const proto = await page.send('Runtime.evaluate', { expression: `${ctor}.prototype` });
            const objects = await page.send('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId });
            const length = await page.send('Runtime.callFunctionOn', {
                objectId: objects.objects.objectId,
                functionDeclaration: 'function () { return this.length; }',
                returnByValue: true
            });
            await page.send('Runtime.releaseObject', { objectId: objects.objects.objectId });
            await page.send('Runtime.releaseObject', { objectId: proto.result.objectId });
            return Number(length.result.value);
        };
        const livePanes = async () => Number(await page.eval(`document.querySelectorAll('[data-terminal-status="live"]').length`));
        const failedPanes = async () =>
            Number(await page.eval(`document.querySelectorAll('[data-terminal-status="error"], [data-terminal-failure]').length`));

        const activate = async (name) => {
            const target = await page.eval(
                `(() => {
                    const row = Array.from(document.querySelectorAll('${d.PAGE.workspaceRows}'))
                        .find((el) => (el.textContent ?? '').includes(${JSON.stringify(name)}));
                    if (row === undefined) return null;
                    const r = row.getBoundingClientRect();
                    return JSON.stringify({ x: r.x + Math.min(60, r.width / 2), y: r.y + r.height / 2 });
                })()`
            );
            if (target === null) throw new Error(`no sidebar row for ${name}`);
            const point = JSON.parse(String(target));
            await page.clickAt(point.x, point.y);
            await d.settleDom(
                page,
                `(document.querySelector('${d.PAGE.workspaceRows}[data-active="true"]')?.textContent ?? '').includes(${JSON.stringify(name)})`,
                { ceilingMs: 10_000 }
            );
            // Every pane of the incoming workspace up, and nothing still between engines.
            return await d.settle(
                async () =>
                    (await page.eval(`document.querySelectorAll('[data-terminal-status="loading"]').length`)) === 0 &&
                    (await livePanes()) === PANES_PER_WORKSPACE,
                { ceilingMs: 30_000 }
            );
        };

        await page.send('HeapProfiler.enable');

        for (const name of WORKSPACES) {
            await cli.ok(['workspace', 'create', '--name', name]);
            for (let index = 1; index < PANES_PER_WORKSPACE; index += 1) {
                const ids = (await json(['pane', 'list', '--workspace', name, '--json'])).map((pane) => pane.id);
                await json(['pane', 'split', '--target', ids[ids.length - 1], '--direction', index % 2 ? 'right' : 'down', '--json']);
            }
        }
        rec.note(`${WORKSPACES.length} workspaces × ${PANES_PER_WORKSPACE} panes`);

        for (const name of WORKSPACES) rec.check(`${name} comes up with every pane live`, await activate(name));
        const first = await countLive('WebAssembly.Memory');
        rec.note(`after the first visit of each workspace: ${first} live WebAssembly.Memory, ${await livePanes()} live panes`);
        rec.check(
            'live WASM memories track the mounted panes after the first visit',
            first <= PANES_PER_WORKSPACE + SLACK,
            `${first} memories for ${PANES_PER_WORKSPACE} mounted panes (allowed ≤ ${PANES_PER_WORKSPACE + SLACK})`
        );

        let last = first;
        for (let round = 1; round <= ROUNDS; round += 1) {
            for (const name of WORKSPACES) {
                rec.check(`round ${round}: ${name} comes up with every pane live`, await activate(name));
            }
            const memories = await countLive('WebAssembly.Memory');
            const instances = await countLive('WebAssembly.Instance');
            rec.note(`round ${round} (${round * WORKSPACES.length} swaps): Memory=${memories} Instance=${instances} live panes=${await livePanes()}`);
            rec.check(
                `round ${round}: live WASM memories still track the mounted panes`,
                memories <= PANES_PER_WORKSPACE + SLACK,
                `${memories} memories for ${PANES_PER_WORKSPACE} mounted panes (allowed ≤ ${PANES_PER_WORKSPACE + SLACK})`
            );
            rec.check(`round ${round}: the count did not climb with the swaps`, memories <= last + 1, `${last} → ${memories}`);
            last = memories;
        }

        const failed = await failedPanes();
        rec.check('no pane is on the placeholder', failed === 0, `${failed} pane(s) failed`);
        await rec.shot(page, 'after-the-swaps');
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
