import { describe, expect, it } from 'vitest';

import { aimExpression, describeAim, landingExpression, openSidebarMenu, pointInBox, rowClickPoint } from './aim.mjs';

/**
 * Where a sidebar right-click goes, decided without a window (#204).
 *
 * The numbers below are the ones the failing runs recorded: a 1280x820 audit window, a sidebar
 * scroller that ends where the footer begins, and "Remain A" at y = 736.5 after the step's own
 * group headers pushed it down. The old helper measured that rect, pressed its midpoint, and hit
 * the footer, which has no context-menu handler, so the sidebar's menu state stayed null and the
 * harness could only say `(no-menu)`.
 */

const scroller = { left: 0, top: 96, right: 240, bottom: 720, scrollTop: 412 };

describe('rowClickPoint', () => {
    it('presses 60px in from the row\'s leading edge, vertically centred', () => {
        expect(rowClickPoint({ x: 8, y: 300, w: 216, h: 26 })).toEqual({ x: 68, y: 313 });
    });

    it('halves a row too narrow for that inset rather than pressing past it', () => {
        expect(rowClickPoint({ x: 8, y: 300, w: 40, h: 26 })).toEqual({ x: 28, y: 313 });
    });
});

describe('pointInBox', () => {
    it('refuses the press that #204 was: a row measured below the scroller it scrolled out of', () => {
        const row = { x: 8, y: 724, w: 216, h: 25 };
        expect(pointInBox(rowClickPoint(row), scroller)).toBe(false);
    });

    it('allows a row inside the list, including one flush against its bottom edge', () => {
        expect(pointInBox(rowClickPoint({ x: 8, y: 300, w: 216, h: 26 }), scroller)).toBe(true);
        expect(pointInBox(rowClickPoint({ x: 8, y: 690, w: 216, h: 26 }), scroller)).toBe(true);
    });

    it('refuses a row scrolled off the TOP as well, under the sidebar header', () => {
        expect(pointInBox(rowClickPoint({ x: 8, y: 60, w: 216, h: 26 }), scroller)).toBe(false);
    });

    it('constrains nothing when the element has no scroller ancestor', () => {
        expect(pointInBox({ x: 68, y: 9999 }, null)).toBe(true);
    });
});

describe('describeAim', () => {
    it('names the point, the row, the scroller and what was actually under the pointer', () => {
        const line = describeAim({
            point: { x: 68, y: 736.5 },
            row: { x: 8, y: 724, w: 216, h: 25 },
            list: scroller,
            menuBefore: false,
            landed: { hit: '<div class="flex shrink-0 flex-col gap-1 border-t">', inRow: null, inScroller: false }
        });
        expect(line).toContain('point=(68,737)');
        expect(line).toContain('row=(8,724 216x25)');
        expect(line).toContain('scroller=(0,96..240,720 scrollTop=412)');
        expect(line).toContain('border-t');
        expect(line).toContain('inScroller=false');
        expect(line).toContain('menuWasOpen=false');
    });

    it('survives a measurement that never happened', () => {
        expect(describeAim(null)).toBe('(no measurement)');
    });
});

describe('the page-side expressions', () => {
    it('scrolls the row into view before measuring, and measures its scroller too', () => {
        const expression = aimExpression('[data-testid="workspace-row"]', 'Remain A');
        expect(expression).toContain('scrollIntoView');
        // `nearest`, not `center`: a row that is already fully visible must not move, or the
        // eleven call sites that never had a problem would start scrolling under themselves.
        expect(expression).toContain("block: 'nearest'");
        expect(expression).toContain('[role=\\"listbox\\"]');
        expect(expression).toContain('getBoundingClientRect');
        expect(expression).toContain('scrollTop');
        // The selector and the needle are embedded as JSON, so a row label with a quote in it
        // cannot break out of the expression.
        expect(expression).toContain('"[data-testid=\\"workspace-row\\"]"');
        expect(aimExpression('[data-testid="workspace-row"]', 'it\'s "mine"')).toContain('"it\'s \\"mine\\""');
    });

    it('asks what is under the point it pressed', () => {
        const expression = landingExpression(68, 736.5);
        expect(expression).toContain('document.elementFromPoint(68, 736.5)');
        expect(expression).toContain('outerHTML');
        expect(expression).toContain('inScroller');
    });

    it('is valid JavaScript, quotes and apostrophes in a workspace name included', () => {
        // Parsed here rather than in a window: a broken expression is a step error 40 minutes into
        // a full audit, and `page.eval` reports it as "page eval failed", not as a typo.
        const compiles = (source) => () => new Function(`return (${source});`);
        expect(compiles(aimExpression('[data-testid="workspace-row"]', 'Remain A'))).not.toThrow();
        expect(compiles(aimExpression('[data-testid="group-header"]', 'it\'s "Edge B"\\'))).not.toThrow();
        expect(compiles(landingExpression(68, 736.5))).not.toThrow();
    });
});

/**
 * A page whose sidebar is whatever the test says it is. `opensOn` is the press that mounts the
 * menu: `1` for a list that answers at once, `Infinity` for the one #204 reported. `menuUp` starts
 * it with a stale menu on screen, and `escapeCloses` says whether Escape takes that one down.
 */
const fakePage = ({ row, list, opensOn = 1, found = true, menuUp = false, escapeCloses = true }) => {
    const clicks = [];
    const evals = [];
    const keys = [];
    let menuOpen = menuUp;
    return {
        clicks,
        evals,
        keys,
        async eval(expression) {
            evals.push(expression);
            if (expression.includes('scrollIntoView')) {
                return found ? JSON.stringify({ found: true, row, list, menuOpen }) : JSON.stringify({ found: false });
            }
            if (expression.includes('elementFromPoint')) {
                return JSON.stringify({
                    hit: '<div class="flex shrink-0 flex-col gap-1 border-t">',
                    inRow: null,
                    inScroller: false
                });
            }
            return menuOpen;
        },
        async key(code) {
            keys.push(code);
            if (code === 'Escape' && escapeCloses) menuOpen = false;
        },
        async clickAt(x, y, options) {
            clicks.push({ x, y, ...options });
            if (clicks.length >= opensOn) menuOpen = true;
        }
    };
};

const fast = { ceilingMs: 40, settleMs: 0 };

describe('openSidebarMenu', () => {
    it('right-clicks the row and returns once the menu is mounted', async () => {
        const page = fakePage({ row: { x: 8, y: 300, w: 216, h: 26 }, list: scroller });
        const opened = await openSidebarMenu(page, '[data-testid="workspace-row"]', 'Remain A', fast);
        expect(opened).toEqual({ point: { x: 68, y: 313 }, row: { x: 8, y: 300, w: 216, h: 26 }, attempt: 1 });
        expect(page.clicks).toEqual([{ x: 68, y: 313, button: 'right' }]);
        // Everything it asked the page has to parse as JavaScript, the menu probe included.
        for (const expression of page.evals) expect(() => new Function(`return (${expression});`)).not.toThrow();
    });

    it('refuses to press a row that is still outside its scroller, and names both rects', async () => {
        const page = fakePage({ row: { x: 8, y: 724, w: 216, h: 25 }, list: scroller });
        await expect(openSidebarMenu(page, '[data-testid="workspace-row"]', 'Remain A', fast)).rejects.toThrow(
            /outside its scroller.*point=\(68,737\).*scroller=\(0,96\.\.240,720 scrollTop=412\)/s
        );
        // Nothing was pressed: a press there would have landed on the sidebar footer and the run
        // would have carried on as though a menu might still appear.
        expect(page.clicks).toEqual([]);
    });

    it('retries once, because a press that opened nothing is worth a second try', async () => {
        const page = fakePage({ row: { x: 8, y: 300, w: 216, h: 26 }, list: scroller, opensOn: 2 });
        const opened = await openSidebarMenu(page, '[data-testid="workspace-row"]', 'Remain A', fast);
        expect(opened.attempt).toBe(2);
        expect(page.clicks).toHaveLength(2);
    });

    it('and when two presses open nothing, says where the pointer actually was', async () => {
        const page = fakePage({ row: { x: 8, y: 300, w: 216, h: 26 }, list: scroller, opensOn: Infinity });
        await expect(openSidebarMenu(page, '[data-testid="workspace-row"]', 'Remain A', fast)).rejects.toThrow(
            /no context menu \(no-menu\) in 2 attempts.*border-t.*inScroller=false/s
        );
        expect(page.clicks).toHaveLength(2);
    });

    it('still says plainly when there is no such row', async () => {
        const page = fakePage({ row: null, list: scroller, found: false });
        await expect(openSidebarMenu(page, '[data-testid="workspace-row"]', 'Gone', fast)).rejects.toThrow(
            'no [data-testid="workspace-row"] matching "Gone"'
        );
    });

    it('takes down a menu that was already up, so a stale one cannot pass for proof', async () => {
        // Without the Escape the first poll is satisfied by the OLD menu and the caller reads it.
        const page = fakePage({ row: { x: 8, y: 300, w: 216, h: 26 }, list: scroller, menuUp: true });
        const opened = await openSidebarMenu(page, '[data-testid="workspace-row"]', 'Remain A', fast);
        expect(page.keys).toEqual(['Escape']);
        expect(opened.attempt).toBe(1);
        expect(page.clicks).toEqual([{ x: 68, y: 313, button: 'right' }]);
    });

    it('and refuses to press at all when that menu will not go', async () => {
        const page = fakePage({
            row: { x: 8, y: 300, w: 216, h: 26 },
            list: scroller,
            menuUp: true,
            escapeCloses: false
        });
        await expect(openSidebarMenu(page, '[data-testid="workspace-row"]', 'Remain A', fast)).rejects.toThrow(
            /already open.*Escape did not dismiss it/s
        );
        expect(page.clicks).toEqual([]);
    });
});
