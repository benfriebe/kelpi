/**
 * The SPACING-REVIEW content-pane rows — `docs/SPACING-REVIEW.md` S9, S21, S54, S63 (and a
 * pointer to S42, whose stylesheet is the daemon's).
 *
 * The register is a DENSITY one, so every row here is something that measured correctly against
 * `docs/UI-FIDELITY.md` and still read wrong on screen: a bar anchored to the wrong box, two
 * menu rows whose hover fills touched, a scroller that took layout width the shipped app spends
 * none on, a document inset sized for a full-width window in an app that lives in splits.
 *
 * Each block names the Swift line the port is held to and asserts the declared value that
 * produces the measured number — never "something changed". Nothing here re-tests the plumbing
 * `frame-polish.test` and `MarkdownPane.test` already own (the bridge messages, the counter
 * rule, the copy commands); only the geometry those suites never looked at.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { CONTENT_BRIDGE_SOURCE } from './bridge';
import { ContentFrame } from './ContentFrame';
import { PANE_HEADER_HEIGHT } from '../grid/PaneHeader';

const PANE = 'DDDDDDDD-0000-4000-8000-0000000000F1';
const DOCUMENT = '<!DOCTYPE html>\n<html>\n<body>\n<h1>Doc</h1>\n</body>\n</html>\n';

afterEach(cleanup);

/** What the sandboxed frame would post; jsdom cannot run its script for us. */
function fromFrame(message: Record<string, unknown>): void {
    act(() => {
        window.dispatchEvent(
            new MessageEvent('message', { data: { source: CONTENT_BRIDGE_SOURCE, paneID: PANE, ...message } })
        );
    });
}

async function openFind(props: Record<string, unknown> = {}) {
    render(<ContentFrame paneID={PANE} title="markdown preview" html={DOCUMENT} {...props} />);
    fromFrame({ kind: 'find-open' });
    return await screen.findByTestId(`content-find-${PANE}`);
}

// ── S9 / S63: where the find bar floats ─────────────────────────────────────────────

/**
 * S9 — `PaneGridView.swift:356, 367-368` mounts **one** `PaneSearchOverlay` as
 * `.overlay(alignment: .topTrailing)` on the whole pane cell, so the bar floats over the 24 pt
 * header and never over the document. The port mounted it inside `content-frame-…`, which is
 * the pane BODY: measured at a 529 px markdown pane the bar ran y 64 → 98.8 while the
 * document's first block sat at y 76, so **22.8 px of the reader's own text was under an opaque
 * bar** — and the same component over a terminal in the same build sat at y 40. Two anchors for
 * one bar in one app.
 *
 * S63 — and in that same corner the Copy menu already used `OVERLAY_INSET` (14 px, chosen to
 * clear the document's 8 px scroller) while the bar used `right-2` (8 px), so the bar's right
 * edge sat ON the scroller the menu 6 px away was written to avoid.
 */
describe('S9/S63 — the content find bar is anchored to the pane, not to the document', () => {
    it('hangs outside the frame, so it can reach back over the header', async () => {
        const bar = await openFind();
        const frame = screen.getByTestId(`content-frame-${PANE}`);
        // The frame is `overflow-hidden`, so a bar inside it can never escape upward.
        expect(frame.className).toContain('overflow-hidden');
        expect(frame.contains(bar)).toBe(false);
        expect(bar.parentElement).toBe(frame.parentElement);
    });

    it('sits 8 px below the PANE’s top — the same anchor the grid gives a terminal', async () => {
        const bar = await openFind();
        // The mount point is the pane BODY, which starts one header down, so the offset is
        // negative by exactly the header's height less the 8 px inset.
        expect(bar.style.top).toBe(`${String(-(PANE_HEADER_HEIGHT - 8))}px`);
        expect(PANE_HEADER_HEIGHT).toBe(24);
    });

    it('uses the Copy menu’s own 14 px inset, so the two overlays line up', async () => {
        const bar = await openFind();
        fireEvent.contextMenu(screen.getByTestId(`content-frame-${PANE}`));
        expect(bar.style.right).toBe('14px');
        // The class stays as the default the terminal's mount still uses; the override wins.
        expect(bar.className).toContain('right-2');
    });

    it('does not paint over a parked pane, which the frame’s own visibility used to handle', () => {
        render(<ContentFrame paneID={PANE} title="markdown preview" html={DOCUMENT} visible={false} />);
        fromFrame({ kind: 'find-open' });
        expect(screen.queryByTestId(`content-find-${PANE}`)).toBeNull();
        // …and it comes back the moment the pane is on screen again.
        cleanup();
        render(<ContentFrame paneID={PANE} title="markdown preview" html={DOCUMENT} />);
        fromFrame({ kind: 'find-open' });
        expect(screen.queryByTestId(`content-find-${PANE}`)).not.toBeNull();
    });
});

// ── S54: the Copy document menu ─────────────────────────────────────────────────────

/**
 * S54 — `MarkdownPaneView.swift:468-484` splices its two commands into WebKit's own `NSMenu`
 * at indices 0–2, where AppKit gives each item a ~22 pt row and a ~20 pt leading inset and puts
 * space between adjacent items. The port's rows measured 150 × 24.8 with `itemGaps: [0]`: the
 * two hover rectangles touched, so a pointer crossing the boundary saw one continuous fill.
 */
describe('S54 — the copy menu’s rows are separate objects', () => {
    /** §TERM-103's route: the pane header's copy button, which BUMPS the token. */
    async function openMenu() {
        const frame = (copyToken: number) => (
            <ContentFrame
                paneID={PANE}
                title="markdown preview"
                html={DOCUMENT}
                copySource="# Doc"
                copyToken={copyToken}
            />
        );
        const view = render(frame(0));
        view.rerender(frame(1));
        return await screen.findByTestId(`content-copy-menu-${PANE}`);
    }

    it('puts 2 px between adjacent rows — the gap `FavouritesMenu` already uses', async () => {
        const menu = await openMenu();
        expect(menu.className).toContain('flex');
        expect(menu.className).toContain('flex-col');
        expect(menu.className).toContain('gap-0.5');
        // The panel's own 4 px inset is unchanged.
        expect(menu.className).toContain('p-1');
    });

    it('insets the labels 10 px, so they clear the panel wall', async () => {
        await openMenu();
        for (const id of [`content-copy-markdown-${PANE}`, `content-copy-rich-${PANE}`]) {
            expect(screen.getByTestId(id).className).toContain('px-2.5');
            expect(screen.getByTestId(id).className).toContain('py-1');
        }
    });
});

// ── S21: the editors reserve no scrollbar width ─────────────────────────────────────

/**
 * S21 — `MarkdownEditorView.swift:44-48` and `ScratchpadEditorView.swift:52-56` set
 * `scrollView.scrollerStyle = .overlay` ("Thin overlay scroller, matching the sidebar") and
 * leave the horizontal scroller off: 0 px of layout width in both axes. The global
 * `*::-webkit-scrollbar { width: 9px }` turns Chromium's overlay scroller into a classic
 * space-taking one, and the markdown editor measured `offsetWidth 493 / clientWidth 482` —
 * 11 px reserved on the right only, which with the field's own 8 px `p-2` made the right gutter
 * 19 px against 8 px on the left.
 */
describe('S21 — the editor textarea is scoped off the global scrollbar rules', () => {
    const stylesheet = readFileSync(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'),
        'utf8'
    );

    it('takes the tab strip’s own escape, scoped to the editor’s test id', () => {
        expect(stylesheet).toContain("[data-testid^='content-textarea-'] {\n  scrollbar-width: none;\n}");
        expect(stylesheet).toContain(
            "[data-testid^='content-textarea-']::-webkit-scrollbar {\n  width: 0;\n  height: 0;\n}"
        );
    });

    it('leaves the global thin scrollbar alone — every other scroller still wants it', () => {
        expect(stylesheet).toContain('*::-webkit-scrollbar {\n  width: 9px;\n  height: 9px;\n}');
    });
});

/*
 * S42 and S51 — two OWNER-DIRECTED markdown-preview rows that live one package over.
 *
 * The preview's stylesheet is the DAEMON's (`daemon/src/content/markdown.ts`), outside this
 * client's cascade entirely, so their assertions are in `daemon/src/content/markdown.test.ts`
 * beside the rules they hold:
 *
 *   - S42, `padding: 20px clamp(12px, 6%, 28px)` on `body`, against the Swift's flat
 *     `20px 28px` (`MarkdownHTMLRenderer.swift:300`);
 *   - S51, `padding: 0` on `pre.frontmatter-nested`, against the Swift's `8px 10px`
 *     (`:444-452`), so a nested front-matter value shares the cell's own 6/12 box and the
 *     column has one left edge. The raw block keeps the Swift's 8/10.
 *
 * Named here so a reader of this pack knows the rows are covered and where.
 */
