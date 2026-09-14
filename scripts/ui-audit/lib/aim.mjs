/**
 * Aiming a right-click at a sidebar row, and saying where it landed when nothing opened (#204).
 *
 * WHY THIS EXISTS
 * ---------------
 * `openSidebarMenu` used to find a row by its text, measure it ONCE, right-click the midpoint of
 * that rect and sleep 450 ms. In a full audit run (twelve to fourteen workspaces and four
 * groups in one 1280x820 window) `sidebar-remaining` and `workspace-edges` both ended in
 * `context menu item "…" not found (no-menu)`.
 *
 * `no-menu` is the tell. The sidebar mounts its menu iff its `menu` state is non-null, and EVERY
 * element of the list opens one: a workspace row, a group header, the scroll container itself and
 * the flexible spacer under the last row (`Sidebar.tsx`, `onBackgroundContextMenu` on the
 * `role="listbox"` scroller). A click that landed anywhere inside the list (on a row mid
 * re-render, on its neighbour, on empty space) would have opened SOME menu and the harness would
 * have said `no-row:<labels>`. So the click was not landing in the list at all.
 *
 * It was landing under it. The scroller is `overflow-y-auto`, and `getBoundingClientRect()` on a
 * row that has been pushed past the scroller's visible bottom still returns a rect: a rect whose
 * midpoint lies over the sidebar FOOTER, which is a sibling of the scroller with no
 * `onContextMenu` at all. Both failing steps had just pushed their target row down, one by
 * inserting group headers above it, the other by moving it to the end of a group with
 * `--index 99`, and both had already right-clicked the same row successfully earlier in the same
 * step. That also explains why extra dwell never helped: `workspace-edges` already sleeps 1800 ms
 * before its right-click and still failed.
 *
 * So: scroll the row into view, measure it immediately before pressing, refuse to press a point
 * that is outside the scroller, wait for the menu instead of sleeping, retry once, and when it
 * still does not open, record what `document.elementFromPoint` says was actually under the
 * pointer. The next failure names its own cause.
 *
 * The geometry is pure and lives here so it can be unit-tested without a window: see
 * `aim.test.mjs`. This module imports nothing.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const CONTEXT_MENU = '[data-testid="context-menu"]';

/** The scroll container that owns the sidebar's rows and answers right-clicks on its own slack. */
export const SIDEBAR_SCROLLER = '[role="listbox"]';

/**
 * The point the harness right-clicks for a row rect: 60 px in from its leading edge (or the row's
 * middle, whichever is nearer), vertically centred. 60 px keeps the press off the row's trailing
 * controls without depending on how wide the sidebar happens to be.
 */
export function rowClickPoint(row) {
    return { x: row.x + Math.min(60, row.w / 2), y: row.y + row.h / 2 };
}

/**
 * Is the point inside the box, by at least `inset` px on every side?
 *
 * A null box means "nothing constrains this press" (the element has no scroller ancestor), which
 * is the pre-#204 behaviour and the right answer for a row that is not in a scrolling list.
 */
export function pointInBox(point, box, inset = 1) {
    if (box === null || box === undefined) return true;
    return (
        point.x >= box.left + inset &&
        point.x <= box.right - inset &&
        point.y >= box.top + inset &&
        point.y <= box.bottom - inset
    );
}

const round = (value) => (typeof value === 'number' ? Math.round(value) : value);

/** One line naming where the press went and what was under it. This is the whole point of #204. */
export function describeAim(aim) {
    if (aim === null || aim === undefined) return '(no measurement)';
    const parts = [];
    if (aim.point !== undefined) parts.push(`point=(${String(round(aim.point.x))},${String(round(aim.point.y))})`);
    if (aim.row !== undefined && aim.row !== null) {
        parts.push(
            `row=(${String(round(aim.row.x))},${String(round(aim.row.y))} ${String(round(aim.row.w))}x${String(round(aim.row.h))})`
        );
    }
    parts.push(
        aim.list === undefined || aim.list === null
            ? 'scroller=(none)'
            : `scroller=(${String(round(aim.list.left))},${String(round(aim.list.top))}..${String(round(aim.list.right))},${String(round(aim.list.bottom))} scrollTop=${String(round(aim.list.scrollTop))})`
    );
    if (aim.landed !== undefined && aim.landed !== null) {
        parts.push(`hit=${aim.landed.hit === null ? '(nothing)' : String(aim.landed.hit)}`);
        if (aim.landed.inRow !== undefined && aim.landed.inRow !== null) parts.push(`inRow="${String(aim.landed.inRow)}"`);
        parts.push(`inScroller=${String(aim.landed.inScroller)}`);
    }
    if (aim.menuBefore !== undefined) parts.push(`menuWasOpen=${String(aim.menuBefore)}`);
    return parts.join(' ');
}

/**
 * The page-side expression: find the row, scroll it into view, measure it AND its scroller.
 *
 * `block: 'nearest'` is deliberately not `'center'`: it is a no-op for a row that is already
 * fully visible, so the eleven call sites that never had a problem do not start scrolling the
 * list under themselves, and it is the minimum correction for the one that does.
 */
export function aimExpression(selector, needle) {
    return `(() => {
        const el = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
            .find((node) => (node.innerText ?? '').includes(${JSON.stringify(needle)}));
        if (el === undefined) return JSON.stringify({ found: false });
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const r = el.getBoundingClientRect();
        const list = el.closest(${JSON.stringify(SIDEBAR_SCROLLER)});
        const b = list === null ? null : list.getBoundingClientRect();
        return JSON.stringify({
            found: true,
            row: { x: r.x, y: r.y, w: r.width, h: r.height },
            list: b === null
                ? null
                : { left: b.left, top: b.top, right: b.right, bottom: b.bottom, scrollTop: list.scrollTop },
            menuOpen: document.querySelector(${JSON.stringify(CONTEXT_MENU)}) !== null
        });
    })()`;
}

/** The page-side expression: what is under the point the press went to? */
export function landingExpression(x, y) {
    return `(() => {
        const el = document.elementFromPoint(${String(x)}, ${String(y)});
        if (el === null) return JSON.stringify({ hit: null, inScroller: false });
        const row = el.closest('[data-testid="workspace-row"], [data-testid="group-header"]');
        return JSON.stringify({
            hit: (el.outerHTML ?? '').replace(/\\s+/g, ' ').slice(0, 120),
            inRow: row === null ? null : (row.innerText ?? '').trim().split('\\n')[0].slice(0, 40),
            inScroller: el.closest(${JSON.stringify(SIDEBAR_SCROLLER)}) !== null
        });
    })()`;
}

const read = async (page, expression) => JSON.parse(String(await page.eval(expression)));

/**
 * Right-click a sidebar row (or a group header) whose text contains `needle`, and return with its
 * context menu on screen.
 *
 * Throws when the row is not there, when the row cannot be brought inside its scroller, or when
 * two presses opened no menu. Every one of those errors names the measurement it acted on.
 */
export async function openSidebarMenu(page, selector, needle, { ceilingMs = 1500, settleMs = 150, attempts = 2 } = {}) {
    let last = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        const aim = await read(page, aimExpression(selector, needle));
        if (aim.found !== true) throw new Error(`no ${selector} matching "${needle}"`);
        const point = rowClickPoint(aim.row);
        if (!pointInBox(point, aim.list)) {
            throw new Error(
                `${selector} "${needle}" sits outside its scroller even after scrolling it into view, ` +
                    `so a right-click would land on whatever is below the list: ${describeAim({ point, ...aim })}`
            );
        }
        await page.clickAt(point.x, point.y, { button: 'right' });
        const deadline = Date.now() + ceilingMs;
        let opened = false;
        for (;;) {
            opened = (await page.eval(`document.querySelector(${JSON.stringify(CONTEXT_MENU)}) !== null`)) === true;
            if (opened || Date.now() > deadline) break;
            await sleep(40);
        }
        if (opened) {
            // The menu is mounted; give it the frame it needs to lay its rows out before a caller
            // measures one.
            await sleep(settleMs);
            return { point, row: aim.row, attempt };
        }
        last = { point, row: aim.row, list: aim.list, menuBefore: aim.menuOpen };
        last.landed = await read(page, landingExpression(point.x, point.y));
        await sleep(250);
    }
    throw new Error(
        `right-click on ${selector} "${needle}" opened no context menu (no-menu) in ${String(attempts)} attempts: ${describeAim(last)}`
    );
}
