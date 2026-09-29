/**
 * #279: a workspace colour can be picked with a natural diagonal.
 *
 * The workspace row's Color ▸ submenu hangs from the Color row's top and runs down past Profile,
 * Change Icon and Labels, so the straight line from Color to a lower colour crosses those rows.
 * Entering a row used to switch submenus at once, which took the colours away mid-journey. This
 * drives the REAL pointer (CDP `Input.dispatchMouseEvent`, so the browser does its own hit
 * testing and sends its own enter/leave/move events) along that diagonal, in a real window, and
 * clicks the colour at the end of it. The unit suite has the same route as synthetic events;
 * only this proves the browser sends them the way the unit suite assumes.
 *
 * Three journeys:
 *   1. right-opening submenu: Color ▸ from the left-hand sidebar, diagonal down-right to a colour;
 *   2. deliberate switching: from Color straight down onto the next submenu parent and resting
 *      there switches, and moving up onto Rename closes the submenu at once;
 *   3. left-opening submenu: the Workspaces sidebar moved to the right edge, where the submenu
 *      flips left, diagonal down-LEFT to a colour.
 *
 * The diagonal itself is driven without pausing: a screenshot takes about as long as the grace
 * period (measured 250 to 275 ms offscreen), and a pointer that stops that long on a crossed row
 * is RESTING there, so the row rightly takes over (a first draft photographed exactly that). The
 * mid-crossing picture is therefore its own pass: it creeps along the diagonal inside the first
 * crossed row while the capture runs, which is a pointer still on its way, then stops and checks
 * that resting there does hand the submenu over. CDP screenshots carry no cursor, so the
 * pointer's route is drawn as a trail of dots on a `pointer-events: none` layer, which hit
 * testing (and so the menu) never sees.
 */
export const covers = [
    'packages/client/src/chrome/ContextMenu.tsx',
    'packages/client/src/chrome/safe-triangle.ts',
    'packages/client/src/chrome/Sidebar.tsx'
];

export default async function ({ page, cli, rec, d, sleep }) {
    const name = `Safe triangle ${Date.now().toString(36)}`;
    const created = JSON.parse(await cli.ok(['workspace', 'create', '--name', name, '--json']));
    const workspaceID = created.workspace_id;
    const colorOf = async () =>
        JSON.parse(await cli.ok(['workspace', 'list', '--json'])).find((w) => w.id === workspaceID)?.color ?? null;

    /** The open menu's parent rows and submenu, measured in the window. */
    const geometry = async () =>
        JSON.parse(
            String(
                await page.eval(`JSON.stringify((() => {
                    const menu = document.querySelector('[data-testid="context-menu"]');
                    if (menu === null) return null;
                    const box = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
                    const rows = [...menu.querySelectorAll(':scope > div > [data-menu-item]')].map((el) => ({
                        id: el.getAttribute('data-menu-item'),
                        label: (el.textContent ?? '').replace('▸', '').trim(),
                        parent: el.getAttribute('aria-haspopup') === 'menu',
                        ...box(el)
                    }));
                    const sub = document.querySelector('[data-testid="context-submenu"]');
                    return {
                        rows,
                        submenu: sub === null ? null : {
                            label: sub.getAttribute('aria-label'),
                            side: sub.getAttribute('data-submenu-side'),
                            ...box(sub),
                            items: [...sub.querySelectorAll('[data-menu-item]')].map((el) => ({
                                id: el.getAttribute('data-menu-item'),
                                checked: el.getAttribute('data-checked'),
                                ...box(el)
                            }))
                        }
                    };
                })())`)
            )
        );
    const submenuLabel = async () =>
        await page.eval(`document.querySelector('[data-testid="context-submenu"]')?.getAttribute('aria-label') ?? null`);
    const menuOpen = async () => await page.eval(`document.querySelector('[data-testid="context-menu"]') !== null`);
    const moveTo = async (x, y) => {
        await page.mouse('mouseMoved', x, y, { button: 'none', buttons: 0 });
    };
    /**
     * What is under a point: the parent row (if any), whether it is in the submenu, and which
     * submenu is up. Also drops a dot on the trail layer, which is invisible to hit testing.
     */
    const under = async (x, y) =>
        JSON.parse(
            String(
                await page.eval(`JSON.stringify((() => {
                    let layer = document.getElementById('scenario-pointer-trail');
                    if (layer === null) {
                        layer = document.createElement('div');
                        layer.id = 'scenario-pointer-trail';
                        layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
                        document.body.appendChild(layer);
                    }
                    const dot = document.createElement('div');
                    dot.style.cssText = 'position:absolute;left:${x - 3}px;top:${y - 3}px;width:6px;height:6px;border-radius:50%;background:#ff3b30;box-shadow:0 0 0 1px #ffffff';
                    layer.appendChild(dot);
                    const el = document.elementFromPoint(${x}, ${y});
                    const sub = document.querySelector('[data-testid="context-submenu"]');
                    const row = el?.closest('[data-menu-item]') ?? null;
                    const inSubmenu = sub !== null && el !== null && sub.contains(el);
                    return {
                        row: row !== null && !inSubmenu ? row.getAttribute('data-menu-item') : null,
                        rowHighlighted: row !== null && !inSubmenu ? row.getAttribute('data-highlighted') : null,
                        inSubmenu,
                        submenu: sub?.getAttribute('aria-label') ?? null
                    };
                })())`)
            )
        );

    const clearTrail = async () => {
        await page.eval(`(document.getElementById('scenario-pointer-trail')?.remove(), true)`);
    };

    /** Right-click the workspace and hover Color; returns the measured menu. */
    const openColourSubmenu = async (tag, expectedSide, { shoot }) => {
        await d.openSidebarMenu(page, d.PAGE.workspaceRows, name);
        let g = await geometry();
        const color = g?.rows.find((r) => r.id === 'color');
        if (!color) throw new Error(`${tag}: the workspace menu has no Color row`);
        await moveTo((color.left + color.right) / 2, (color.top + color.bottom) / 2);
        const opened = await d.settle(async () => (await submenuLabel()) === 'Color', { ceilingMs: 2_000 });
        g = await geometry();
        if (shoot) {
            rec.check(`${tag}: hovering Color opens the colour submenu`, opened);
            rec.check(`${tag}: the submenu opened to the ${expectedSide}`, g.submenu?.side === expectedSide, g.submenu?.side);
            await rec.shot(page, `${tag}-color-submenu-open`);
        }
        if (!opened || g.submenu === null) throw new Error(`${tag}: the colour submenu did not open`);
        // A colour in the lower half of the list that is not the current one, so the click is a
        // visible change and the route has rows to cross.
        const candidates = g.submenu.items.filter((item) => item.checked !== 'true' && item.id.startsWith('color:'));
        const target = candidates[Math.min(candidates.length - 1, Math.max(0, candidates.length - 3))];
        const toward = expectedSide === 'right' ? 1 : -1;
        return {
            rows: g.rows,
            color,
            target,
            from: { x: (color.left + color.right) / 2 + 12 * toward, y: color.bottom - 3 },
            to: { x: (target.left + target.right) / 2, y: (target.top + target.bottom) / 2 }
        };
    };
    const STEPS = 24;
    const along = ({ from, to }, step) => ({
        x: from.x + ((to.x - from.x) * step) / STEPS,
        y: from.y + ((to.y - from.y) * step) / STEPS
    });

    /**
     * Right-click the workspace, hover Color, then travel in a straight line from Color's lower
     * edge to a colour well below it, without stopping, and click that colour.
     */
    const colourJourney = async (tag, expectedSide) => {
        const before = await colorOf();
        const route = await openColourSubmenu(tag, expectedSide, { shoot: true });
        const { from, to, target } = route;
        await clearTrail();
        await moveTo(from.x, from.y);
        await under(from.x, from.y);
        await sleep(60);

        const crossed = [];
        let lost = null;
        let litCrossing = null;
        for (let step = 1; step <= STEPS; step++) {
            const { x, y } = along(route, step);
            await moveTo(x, y);
            await sleep(12);
            const seen = await under(x, y);
            if (seen.row !== null && seen.row !== 'color' && !crossed.includes(seen.row)) crossed.push(seen.row);
            if (seen.submenu !== 'Color' && lost === null) lost = { step, x, y, ...seen };
            if (seen.row !== null && seen.row !== 'color' && seen.rowHighlighted !== 'false' && litCrossing === null) {
                litCrossing = { step, ...seen };
            }
        }
        rec.note(`${tag}: route ${JSON.stringify(from)} -> ${JSON.stringify(to)} (${target.id}), crossed ${crossed.join(', ') || 'nothing'}`);
        rec.check(`${tag}: the diagonal really crosses another parent row`, crossed.length > 0, JSON.stringify(crossed));
        rec.check(`${tag}: the colour submenu stays open for the whole diagonal`, lost === null, JSON.stringify(lost));
        rec.check(`${tag}: no row crossed on the way lights up as if it had acted`, litCrossing === null, JSON.stringify(litCrossing));
        const arrived = await under(to.x, to.y);
        rec.check(`${tag}: the pointer ends on the colour, inside the submenu`, arrived.inSubmenu && arrived.submenu === 'Color', JSON.stringify(arrived));
        await rec.shot(page, `${tag}-diagonal-trail-ends-on-${target.id.replace(':', '-')}`);

        await page.mouse('mousePressed', to.x, to.y, { button: 'left', clickCount: 1 });
        await sleep(30);
        await page.mouse('mouseReleased', to.x, to.y, { button: 'left', clickCount: 1 });
        const wanted = target.id.slice('color:'.length);
        rec.check(
            `${tag}: clicking it sets the workspace colour (${String(before)} -> ${wanted})`,
            await d.settle(async () => (await colorOf()) === wanted, { ceilingMs: 5_000 }),
            `color=${String(await colorOf())}`
        );
        rec.check(`${tag}: and the menu closes`, await d.settle(async () => !(await menuOpen()), { ceilingMs: 2_000 }));
        await clearTrail();
        await sleep(200);
        await rec.shot(page, `${tag}-colour-applied`);
    };

    /**
     * The same diagonal, stopped on the first parent row it crosses: the held state is
     * photographed there, and then, because the pointer has rested, the row takes over.
     */
    const crossAndRest = async (tag, expectedSide) => {
        const route = await openColourSubmenu(tag, expectedSide, { shoot: false });
        await clearTrail();
        await moveTo(route.from.x, route.from.y);
        await under(route.from.x, route.from.y);
        await sleep(60);
        let held = null;
        for (let step = 1; step <= STEPS; step++) {
            const { x, y } = along(route, step);
            await moveTo(x, y);
            await sleep(12);
            const seen = await under(x, y);
            // Well inside the row rather than on its edge, so the picture is unambiguous.
            const crossing = seen.row === null || seen.row === 'color' ? null : route.rows.find((r) => r.id === seen.row);
            if (crossing && y >= crossing.top + 8) {
                held = { step, x, y, ...seen };
                break;
            }
        }
        if (held === null) throw new Error(`${tag}: the diagonal crossed no parent row`);
        rec.check(
            `${tag}: on ${held.row}, the colours are held and ${held.row} is not lit`,
            held.submenu === 'Color' && held.rowHighlighted === 'false',
            JSON.stringify(held)
        );
        const row = (await geometry()).rows.find((r) => r.id === held.row);
        // Creep on along the diagonal, inside the row, for as long as the capture takes.
        const length = Math.hypot(route.to.x - route.from.x, route.to.y - route.from.y);
        const unit = { x: (route.to.x - route.from.x) / length, y: (route.to.y - route.from.y) / length };
        let point = { x: held.x, y: held.y };
        let capturing = true;
        const capture = rec.shot(page, `${tag}-pointer-crossing-${held.row}-colours-held`).finally(() => {
            capturing = false;
        });
        while (capturing) {
            const next = { x: point.x + unit.x * 1.5, y: point.y + unit.y * 1.5 };
            if (next.y < row.bottom - 2) {
                point = next;
                await moveTo(point.x, point.y);
                await under(point.x, point.y);
            }
            await sleep(40);
        }
        await capture;
        const during = await under(point.x, point.y);
        rec.check(
            `${tag}: still crossing ${held.row} after the capture, the colours are still held`,
            during.row === held.row && during.submenu === 'Color' && during.rowHighlighted === 'false',
            JSON.stringify({ point, ...during })
        );
        held.at = Date.now();
        const handedOver = await d.settle(async () => (await submenuLabel()) === row.label, { ceilingMs: 2_000 });
        rec.check(
            `${tag}: resting on ${held.row} hands it the submenu after the grace period`,
            handedOver,
            `submenu=${String(await submenuLabel())} ${String(Date.now() - held.at)} ms after stopping`
        );
        rec.note(`${tag}: ${row.label} took over ${String(Date.now() - held.at)} ms after the pointer stopped (upper bound)`);
        await rec.shot(page, `${tag}-rested-on-${held.row}-it-took-over`);
        await clearTrail();
        await page.key('Escape');
        await d.settle(async () => !(await menuOpen()), { ceilingMs: 2_000 });
    };

    const sidebarSide = async () =>
        await page.eval(`document.querySelector('[data-testid="sidebar-slot"]')?.getAttribute('data-sidebar-side') ?? null`);
    /** Settings ▸ Plugins: which view the left (primary) sidebar shows. */
    const choosePrimarySidebar = async (viewID) => {
        await page.key('Comma', { modifiers: d.MOD.meta, key: ',' });
        await d.settleDom(page, `document.querySelector('[data-testid="settings-tab-button-plugins"]')`, { ceilingMs: 5_000 });
        await page.click('[data-testid="settings-tab-button-plugins"]');
        await d.settleDom(page, `document.querySelector('select[aria-label="sidebar.primary"]')`, { ceilingMs: 5_000 });
        await page.eval(`(() => {
            const select = document.querySelector('select[aria-label="sidebar.primary"]');
            select.value = ${JSON.stringify(viewID)};
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        })()`);
        await page.click('[data-testid="settings-close"]');
    };
    const sideAtStart = await sidebarSide();

    try {
        await d.settleDom(page, `document.querySelector('[data-testid="workspace-row"][data-workspace-id="${workspaceID}"]')`, { ceilingMs: 5_000 });

        // ── 1. right-opening: the reported case ─────────────────────────────────────────
        await colourJourney('right', 'right');
        await crossAndRest('right', 'right');

        // ── 2. deliberate switching still works ─────────────────────────────────────────
        await d.openSidebarMenu(page, d.PAGE.workspaceRows, name);
        let g = await geometry();
        const colorRow = g.rows.find((r) => r.id === 'color');
        const colorIndex = g.rows.indexOf(colorRow);
        const nextParent = g.rows.slice(colorIndex + 1).find((r) => r.parent);
        const rename = g.rows.find((r) => r.id === 'rename');
        const cx = (colorRow.left + colorRow.right) / 2;
        await moveTo(cx, (colorRow.top + colorRow.bottom) / 2);
        await d.settle(async () => (await submenuLabel()) === 'Color', { ceilingMs: 2_000 });
        // Straight down onto the next submenu parent, and rest there.
        for (let y = (colorRow.top + colorRow.bottom) / 2; y <= (nextParent.top + nextParent.bottom) / 2; y += 4) {
            await moveTo(cx, y);
            await sleep(8);
        }
        await moveTo(cx, (nextParent.top + nextParent.bottom) / 2);
        const restedAt = Date.now();
        const switched = await d.settle(async () => (await submenuLabel()) === nextParent.label, { ceilingMs: 2_000 });
        rec.check(
            `resting on ${nextParent.label} switches to its submenu promptly`,
            switched && Date.now() - restedAt < 1_000,
            `submenu=${String(await submenuLabel())} after ${String(Date.now() - restedAt)} ms`
        );
        await rec.shot(page, `switch-rested-on-${nextParent.id}`);
        // Back up to Color (reopens its submenu), then up onto Rename: above every submenu, so
        // it acts at once.
        await moveTo(cx, (colorRow.top + colorRow.bottom) / 2);
        await d.settle(async () => (await submenuLabel()) === 'Color', { ceilingMs: 2_000 });
        await moveTo(cx - 20, (rename.top + rename.bottom) / 2);
        await sleep(60);
        rec.check('moving up onto Rename closes the submenu without waiting', (await submenuLabel()) === null, `submenu=${String(await submenuLabel())}`);
        await page.key('Escape');
        rec.check('Escape still dismisses the menu', await d.settle(async () => !(await menuOpen()), { ceilingMs: 2_000 }));

        // An outside click dismisses a menu whose submenu is open.
        await d.openSidebarMenu(page, d.PAGE.workspaceRows, name);
        g = await geometry();
        const again = g.rows.find((r) => r.id === 'color');
        await moveTo((again.left + again.right) / 2, (again.top + again.bottom) / 2);
        await d.settle(async () => (await submenuLabel()) === 'Color', { ceilingMs: 2_000 });
        const grid = await page.box(d.PAGE.grid);
        await page.clickAt(grid.cx, grid.cy);
        rec.check('an outside click still dismisses the menu with its submenu open', await d.settle(async () => !(await menuOpen()), { ceilingMs: 2_000 }));

        // ── 3. left-opening: Workspaces on the right edge ───────────────────────────────
        await choosePrimarySidebar('kelpi.inspector');
        const onRight = await d.settle(async () => (await sidebarSide()) === 'right', { ceilingMs: 5_000 });
        rec.check('the Workspaces sidebar moves to the right edge', onRight, `side=${String(await sidebarSide())}`);
        if (onRight) {
            await d.settleDom(page, `document.querySelector('[data-testid="workspace-row"][data-workspace-id="${workspaceID}"]')`, { ceilingMs: 5_000 });
            await colourJourney('left', 'left');
            await crossAndRest('left', 'left');
        }
    } finally {
        await clearTrail();
        if (await menuOpen()) await page.key('Escape');
        if (sideAtStart !== null && (await sidebarSide()) !== sideAtStart) {
            await choosePrimarySidebar('kelpi.workspaces');
            await d.settle(async () => (await sidebarSide()) === sideAtStart, { ceilingMs: 5_000 });
        }
        await cli.run(['workspace', 'delete', workspaceID, '--force']);
    }
}
