/**
 * #245: a chord on a punctuation key follows the character it types, so ⌘+ and ⌘- work on a
 * German keyboard, and the pane-focus brackets keep their physical keys.
 *
 * The keyboard is simulated the honest way: CDP's `Input.dispatchKeyEvent` is told the physical
 * `code` AND the `key` a German layout produces on it, which is exactly the pair the renderer's
 * `KeyboardEvent` then carries. On a German Mac `+` is the key a US board calls `]`
 * (`BracketRight`), `-` is the `/` key (`Slash`), `ü` is the `[` key and `?` is ⇧ on the `-` key
 * (`Minus`). Before #245 those presses were matched on `code` alone: ⌘+ focused the next pane and
 * ⌘- opened Help.
 *
 * The instruments, none of which a chord being merely consumed can satisfy:
 *
 *   1. **the measured cell** (`data-terminal-cell`), which the pane publishes from what the
 *      ENGINE measured after the font changed;
 *   2. **the focus ring**: the pane header's `data-focused`, which ⌘+ must not move and ⌘ü must;
 *   3. **the Help overlay**: German ⌘- must not open it, German ⌘? must.
 */

export const covers = [
    'packages/core/src/config/layout.ts',
    'packages/client/src/chrome/keys.ts',
    'packages/client/src/content/bridge.ts',
    'packages/client/src/App.tsx'
];

const TAG = Math.random().toString(36).slice(2, 7).toUpperCase();

export default async function ({ page, cli, rec, d, sleep }) {
    const startingWorkspaces = JSON.parse(await cli.ok(['workspace', 'list', '--json']));
    const startingWorkspace = startingWorkspaces.find((workspace) => workspace.is_active === true)?.id ?? null;
    const initialWorkspaceIDs = new Set(startingWorkspaces.map((workspace) => workspace.id));

    const readCell = async (paneID) =>
        await page.eval(
            `(() => {
                const root = document.querySelector('[data-pane-id="${paneID}"][data-terminal-status]');
                if (root === null) return null;
                const cell = (root.getAttribute('data-terminal-cell') ?? '').split('x');
                return { width: Number(cell[0] ?? 0), height: Number(cell[1] ?? 0) };
            })()`
        );
    const cellSettles = async (paneID, test, ceilingMs = 8_000) =>
        await d.settle(async () => {
            const cell = await readCell(paneID);
            return cell !== null && cell.height > 0 && test(cell);
        }, { ceilingMs, intervalMs: 80 });
    const focused = async (paneID) =>
        await page.eval(`document.querySelector('[data-testid="pane-header-${paneID}"]')?.getAttribute('data-focused') === 'true'`);
    const helpOpen = async () => await page.eval(`document.querySelector('[data-testid="help-overlay"]') !== null`);

    /** One press as a German Mac keyboard reports it: the physical `code`, the produced `key`. */
    const german = async (code, key, modifiers = d.MOD.meta) => {
        await page.key(code, { modifiers, key });
        await sleep(150);
    };

    try {
        const created = JSON.parse(await cli.ok(['workspace', 'create', '--name', `Layouts-${TAG}`, '--json']));
        const workspaceID = created.workspace_id ?? created.id;
        rec.check('a workspace of its own to press in', typeof workspaceID === 'string', JSON.stringify(created));
        if (typeof workspaceID !== 'string') return;
        await d.settleDom(page, `document.querySelector('[data-workspace-id="${workspaceID}"]')`, { ceilingMs: 10_000 });
        await d.settle(async () => (await d.domPaneIDs(page)).length === 1, { ceilingMs: 15_000, intervalMs: 200 });
        const first = (await d.domPaneIDs(page))[0];
        rec.check('a terminal pane to press over', first !== undefined);
        if (first === undefined) return;

        await d.focusPaneBody(page, first);
        const before = await d.domPaneIDs(page);
        await page.key('KeyD', { modifiers: d.MOD.meta, key: 'd' });
        await d.settle(async () => (await d.domPaneIDs(page)).length > before.length, { ceilingMs: 8_000 });
        const other = (await d.domPaneIDs(page)).find((paneID) => paneID !== first);
        rec.check('⌘D gave a second pane, the one a wrong ⌘] would move focus to', other !== undefined);
        if (other === undefined) return;

        await d.focusPaneBody(page, first);
        await d.settle(() => focused(first), { ceilingMs: 5_000 });
        await sleep(300);
        const baseline = await readCell(first);
        rec.check('the focused pane publishes a measured cell', (baseline?.height ?? 0) > 0, JSON.stringify(baseline));
        if (!((baseline?.height ?? 0) > 0)) return;

        // ── German ⌘+: the `+` key is BracketRight ──────────────────────────────────
        await german('BracketRight', '+');
        rec.check(
            'German ⌘+ (the BracketRight key typing +) grew the focused terminal’s cell',
            await cellSettles(first, (cell) => cell.height > baseline.height),
            `${String(baseline.height)}px → ${String((await readCell(first))?.height ?? 0)}px`
        );
        rec.check('…and did not focus the next pane, which is what ⌘] means', (await focused(first)) && !(await focused(other)));
        const grown = await readCell(first);
        await rec.shot(page, 'layouts-german-plus');
        rec.note(`EYES - the screenshot above: workspace Layouts-${TAG}, the left terminal one point bigger than the right, and still the focused one.`);

        // ── German ⌘-: the `-` key is Slash ──────────────────────────────────────────
        await german('Slash', '-');
        rec.check(
            'German ⌘- (the Slash key typing -) shrank it back',
            await cellSettles(first, (cell) => cell.height < (grown?.height ?? 0)),
            `${String(grown?.height ?? 0)}px → ${String((await readCell(first))?.height ?? 0)}px`
        );
        await sleep(400);
        rec.check('…and did not open Help, which is what ⌘/ means', !(await helpOpen()));

        // ── German ⌘?: ⇧ on the Minus key ────────────────────────────────────────────
        await german('Minus', '?', d.MOD.meta | d.MOD.shift);
        rec.check('German ⌘? (⇧ on the Minus key) opens Help', await d.settleDom(page, `document.querySelector('[data-testid="help-overlay"]') !== null`, { ceilingMs: 5_000 }));
        if (await helpOpen()) {
            await page.click('[data-testid="help-close"]').catch(() => {});
            await d.settleDom(page, `document.querySelector('[data-testid="help-overlay"]') === null`, { ceilingMs: 5_000 });
        }

        // ── German ⌘ü: the brackets stay physical ────────────────────────────────────
        await d.focusPaneBody(page, first);
        await d.settle(() => focused(first), { ceilingMs: 5_000 });
        await german('BracketLeft', 'ü');
        rec.check('German ⌘ü (the BracketLeft key) still focuses the previous pane', await d.settle(() => focused(other), { ceilingMs: 5_000 }));

        // ── a US keyboard is unchanged ───────────────────────────────────────────────
        await d.focusPaneBody(page, first);
        await d.settle(() => focused(first), { ceilingMs: 5_000 });
        const usBefore = await readCell(first);
        await page.key('Equal', { modifiers: d.MOD.meta, key: '=' });
        rec.check(
            'a US ⌘= still grows it',
            await cellSettles(first, (cell) => cell.height > (usBefore?.height ?? 0)),
            `${String(usBefore?.height ?? 0)}px → ${String((await readCell(first))?.height ?? 0)}px`
        );
        await page.key('BracketRight', { modifiers: d.MOD.meta, key: ']' });
        rec.check('a US ⌘] still focuses the next pane', await d.settle(() => focused(other), { ceilingMs: 5_000 }));
    } catch (error) {
        await rec.shot(page, 'layouts-failure').catch(() => {});
        throw error;
    } finally {
        if (await helpOpen().catch(() => false)) await page.click('[data-testid="help-close"]').catch(() => {});
        for (const workspace of JSON.parse(await cli.ok(['workspace', 'list', '--json']))) {
            if (!initialWorkspaceIDs.has(workspace.id)) await cli.run(['workspace', 'delete', workspace.id, '--force']);
        }
        if (startingWorkspace !== null) {
            const row = `[data-testid="workspace-row"][data-workspace-id="${startingWorkspace}"]`;
            if (await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 8_000 })) {
                await page.click(row).catch(() => {});
            }
        }
    }
}
