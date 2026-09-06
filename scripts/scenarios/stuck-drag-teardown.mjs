/**
 * Issue #79: a sidebar drag whose `pointerup` never arrives has to end anyway.
 *
 * shell-ui.md ▸ "Recovering a stuck window". The unit tests pin the sequencing in jsdom, which
 * has no compositor and no native views; this presses the real handle in a real window with real
 * CDP input, and it needs no pixels at all - every assertion is a DOM reading (`body.style.cursor`
 * and the sidebar slot's width), so it is honest in the hidden lane.
 *
 * Three ways the release goes missing, all three of which used to leave `drag.current` live for
 * the rest of the session:
 *
 *   1. the handle is unmounted mid-drag (⇧⌘S closes the sidebar while the button is down);
 *   2. the browser takes the pointer away instead of releasing it (`pointercancel`);
 *   3. the window loses the pointer to something outside this document (a release over a web
 *      pane's native view, a Space switch).
 *
 * (3) needs the shell's harness `blur`, which `scripts/ui-audit/resize-lockout.mjs` drives with
 * a retry because `BrowserWindow.blur()` on a window that is not the key window is a silent
 * no-op. That one lives there, with the eight-pane load and the latency numbers; this scenario
 * is the cheap always-run half: (1) and (2), which need nothing but the page.
 */

/**
 * The source this presses, so `verify.mjs` re-runs it when that source moves (the scenario rule;
 * ui-audit/README.md ▸ The rule). `SidebarResizer.tsx` owns the gesture and its teardown,
 * `gesture-reset.ts` the registry both drags end through, and `PaneGrid.tsx` the divider drag
 * that registers with it.
 */
export const covers = [
    'packages/client/src/chrome/SidebarResizer.tsx',
    'packages/client/src/chrome/gesture-reset.ts',
    'packages/client/src/grid/PaneGrid.tsx'
];

export default async function ({ page, harness, rec, d, sleep }) {
    const RESIZER = '[data-testid="sidebar-resizer"]';

    const widthOf = () =>
        page.eval(
            `(() => { const el = document.querySelector('${RESIZER}');
              return el === null ? null : Math.round(el.parentElement.getBoundingClientRect().width); })()`
        );
    const cursor = () => page.eval(`document.body.style.cursor`);
    const open = () => page.eval(`document.querySelector('${RESIZER}') !== null`);

    /** Press the handle and sweep right without releasing. Returns where the pointer ended. */
    const sweepHeld = async (dx) => {
        const handle = await page.box(RESIZER);
        if (handle === null) throw new Error('the sidebar resize handle is not on screen');
        await page.mouse('mouseMoved', handle.cx, handle.cy, { button: 'none', buttons: 0 });
        await page.mouse('mousePressed', handle.cx, handle.cy, { button: 'left', clickCount: 1 });
        for (let step = 1; step <= 10; step += 1) {
            await page.mouse('mouseMoved', handle.cx + (dx * step) / 10, handle.cy, { button: 'left', buttons: 1 });
            await sleep(16);
        }
        return { x: handle.cx + dx, y: handle.cy };
    };

    /** A move with NO button held: what a stuck drag keeps following. */
    const bareMove = async (x, y) => {
        await page.mouse('mouseMoved', x, y, { button: 'none', buttons: 0 });
        await sleep(250);
    };

    /*
     * Self-provisioning, because this file runs in a suite: an earlier scenario can leave the
     * window blurred (`dock-bounce-stop-only` does) or the sidebar closed, and a chord that
     * lands nowhere would look exactly like the bug this asserts. So the window is focused and
     * the sidebar is opened first, through the harness, before anything is measured.
     */
    await harness.focus();
    await sleep(600);
    if ((await open()) === false) {
        await harness.menuClick({ path: ['View', 'Toggle Sidebar'] });
        await d.settle(async () => (await open()) === true, { ceilingMs: 8_000 });
    }

    /*
     * ⇧⌘S, delivered as View ▸ Toggle Sidebar rather than as a key event.
     *
     * The two are the same thing: the row IS ⇧⌘S (`shell/src/menu.ts` ▸ `viewMenuTemplate`) and
     * both reach the client as one `menu-command: toggle-sidebar`. The row is used because a
     * CDP key event is ambiguous here - the renderer's own binding and the native menu
     * accelerator can each answer the same synthesized keystroke, and a double toggle closes
     * and re-opens the sidebar, which is indistinguishable from "the close did not happen".
     * Measured: standalone the chord settles closed, in a suite run it came back open. What
     * this scenario is about is the UNMOUNT, so it asks for the unmount unambiguously; the
     * chord's own routing is `menu-accelerators-follow-rebinding`'s subject, not this file's.
     */
    const toggleSidebar = async (want) => {
        await harness.menuClick({ path: ['View', 'Toggle Sidebar'] });
        await d.settle(async () => (await open()) === want, { ceilingMs: 8_000 });
        // Stable, not merely reached: a double toggle passes an instantaneous read.
        await sleep(500);
        return (await open()) === want;
    };

    const start = await widthOf();
    rec.check('the sidebar is on screen with a measurable width', typeof start === 'number' && start > 0, `${String(start)} px`);
    rec.note(`starting width ${String(start)} px`);

    // ── 1. the handle is unmounted mid-drag ─────────────────────────────────────────

    let held = await sweepHeld(60);
    const widened = await widthOf();
    rec.check('dragging right widens the sidebar', widened > start, `${String(start)} → ${String(widened)} px`);
    rec.check('the body carries the drag cursor while the gesture runs', (await cursor()) === 'col-resize', String(await cursor()));

    // ⇧⌘S while the button is still down: App.tsx stops rendering the handle.
    rec.check('the sidebar closes mid-drag (View ▸ Toggle Sidebar, i.e. ⇧⌘S)', await toggleSidebar(false));

    const cursorAfterUnmount = String(await cursor());
    rec.check(
        'the unmount clears the body cursor',
        cursorAfterUnmount === '',
        cursorAfterUnmount === '' ? 'empty' : `ISSUE #79: still "${cursorAfterUnmount}"`
    );

    // The orphaned listener's signature: it keeps writing the width while the sidebar is not
    // even on screen. One move, well clear of where the drag left it, so a stuck drag cannot
    // pass by wandering back.
    await bareMove(held.x + 400, held.y);
    rec.check('and it re-opens', await toggleSidebar(true));
    await sleep(700);
    const afterReopen = await widthOf();
    rec.check(
        'a bare mousemove while it was closed did not resize it',
        afterReopen === widened,
        `${String(widened)} → ${String(afterReopen)} px`
    );

    // ── 2. the browser cancels the pointer ──────────────────────────────────────────

    held = await sweepHeld(-40);
    const narrowed = await widthOf();
    rec.check('a second drag still tracks: the teardown is not sticky', narrowed < widened, `${String(widened)} → ${String(narrowed)} px`);

    /*
     * `Input.dispatchMouseEvent` has no cancel, and there is no gesture a harness can perform
     * that makes Chromium raise one on demand - so this one event is dispatched on the window
     * rather than driven. Everything around it is real: a real drag is running, the assertion
     * afterwards is the real DOM, and what is being asserted is that the app HANDLES the event,
     * which is precisely the line that was missing.
     */
    await page.eval(`(() => { window.dispatchEvent(new MouseEvent('pointercancel', { clientX: 0 })); return true; })()`);
    await sleep(300);

    const cursorAfterCancel = String(await cursor());
    rec.check(
        'pointercancel clears the body cursor',
        cursorAfterCancel === '',
        cursorAfterCancel === '' ? 'empty' : `ISSUE #79: still "${cursorAfterCancel}"`
    );
    await bareMove(held.x + 400, held.y);
    const afterCancel = await widthOf();
    rec.check(
        'and a bare mousemove afterwards does not resize it',
        afterCancel === narrowed,
        `${String(narrowed)} → ${String(afterCancel)} px`
    );

    // ── 3. …and an ordinary release still works ─────────────────────────────────────

    const handle = await page.box(RESIZER);
    await page.drag(handle.cx, handle.cy, handle.cx + 50, handle.cy, { steps: 8 });
    await sleep(400);
    const afterNormal = await widthOf();
    rec.check(
        'an ordinary press-drag-release still resizes, so none of the above is "the handle is dead"',
        afterNormal > afterCancel,
        `${String(afterCancel)} → ${String(afterNormal)} px`
    );
    rec.check('and it leaves no cursor behind either', (await cursor()) === '', String(await cursor()));
}
