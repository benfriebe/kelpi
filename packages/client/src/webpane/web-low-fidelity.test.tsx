/**
 * The LOW-POLISH web-pane fidelity items — `docs/UI-FIDELITY.md` L62…L78.
 *
 * The behavioural rows carry their own guards in the suites that own them (`webui.test.tsx` for
 * the storage panel's L58/L59/L60/L61/L73/L74 and the bookmarks menu's L63/L64/L65,
 * `chrome-polish.test.tsx` for L77's *absent* drag gesture). What is left here is the class that
 * has no behaviour to hang off: metrics, tones and glyph weights, each asserted against the
 * number or the string the cited Swift line specifies rather than against "something changed".
 *
 * The two `packages/shell` rows (L62's overlay box-sizing, L76's hide-on-own-overlay) live in an
 * injected page script and are guarded in that package's own suite,
 * `packages/shell/src/webhost/scripts.test.ts` — the client's vitest project does not include
 * `packages/shell`, and the assertion is on the serialized source either way.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { CommandReply } from '../connection';
import { BatchPanel } from './BatchPanel';
import type { WebPaneCommands } from './commands';
import { WebPane, tabLabel, type WebPaneTab } from './WebPane';
import type { WebBatchSession } from './state';

afterEach(cleanup);

const PANE = 'DDDDDDDD-0000-4000-8000-000000000001';
const TAB1 = 'EEEEEEEE-0000-4000-8000-000000000001';
const TAB2 = 'EEEEEEEE-0000-4000-8000-000000000002';

const TABS: readonly WebPaneTab[] = [
    { id: TAB1, url: 'https://example.com/', title: 'Example' },
    { id: TAB2, url: 'https://second.test/deep/path?q=1', title: '' }
];

function commands(): WebPaneCommands {
    return new Proxy(
        {},
        { get: () => () => Promise.resolve({ ok: true } as CommandReply) }
    ) as unknown as WebPaneCommands;
}

function mount(props: Partial<Parameters<typeof WebPane>[0]> = {}): void {
    render(
        <WebPane paneID={PANE} tabs={TABS} activeTabID={TAB1} commands={commands()} {...props} />
    );
}

// ── the chrome row and the tab strip ────────────────────────────────────────────────

describe('web chrome metrics (L67, L68, L69, L70, L75, L78)', () => {
    /**
     * L69 — `navAndURLBar` is `HStack(spacing: 6) { … }.padding(.horizontal, 8)
     * .padding(.vertical, 4)` (`WebPaneChrome.swift:149, 219-220`). The port read 4 px / 6 px.
     */
    it('spaces the nav row at 6 px with 8 px ends', () => {
        mount();
        const row = screen.getByTestId(`web-back-${PANE}`).parentElement;
        expect(row?.className).toContain('gap-1.5'); // 6 px
        expect(row?.className).toContain('px-2'); // 8 px
        expect(row?.className).toContain('py-1'); // 4 px
    });

    /**
     * L75 — reload is never disabled. `WebPaneChrome.swift:172-180` gives it a flat
     * `.opacity(0.8)` and no `.disabled(…)`, unlike back/forward which each carry one.
     */
    it('leaves reload live on a pane with no tabs, while back and forward dim', () => {
        mount({ tabs: [], activeTabID: null });
        expect((screen.getByTestId(`web-reload-${PANE}`) as HTMLButtonElement).disabled).toBe(false);
        expect(screen.getByTestId(`web-reload-${PANE}`).style.opacity).toBe('1');
        expect((screen.getByTestId(`web-back-${PANE}`) as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByTestId(`web-forward-${PANE}`) as HTMLButtonElement).disabled).toBe(true);
    });

    /**
     * L66 — one border in every mode. `WebPaneChrome.swift:426-433` strokes the field with
     * `Color.secondary.opacity(0.35)` unconditionally; private mode is the padlock's job. The
     * port painted a hard-coded `#9B6BD6` purple no theme could reach.
     */
    it('never paints the URL field a private-mode purple', () => {
        mount({ isPrivate: true });
        const field = screen.getByTestId(`web-url-${PANE}`).parentElement;
        expect(field?.style.border.toLowerCase()).not.toContain('9b6bd6');
        expect(field?.style.border).toContain('--nex-border');
    });

    /**
     * L78 — `weight: armed ? .semibold : .medium` (`WebPaneChrome.swift:226, 246`). Only the
     * colour changed in the port; every glyph was pinned at the medium stroke.
     */
    it('thickens a lit chrome button’s glyph, not only its colour', () => {
        mount({ isPrivate: true });
        const lit = screen.getByTestId(`web-storage-toggle-${PANE}`).querySelector('svg');
        const idle = screen.getByTestId(`web-devtools-${PANE}`).querySelector('svg');
        expect(lit?.getAttribute('stroke-width')).toBe('1.4');
        expect(idle?.getAttribute('stroke-width')).toBe('1.1');
    });

    /**
     * L67 — `WebPaneChrome.swift:331-341`: an inactive pill is `Color.secondary.opacity(0.08)`
     * under a `Color.clear` stroke, an active one is `accent.opacity(0.18)` under
     * `accent.opacity(0.4)`. The port gave idle pills the opaque `surfaceBackground` and a full
     * `divider` outline, and the active pill a full-opacity accent border.
     */
    it('draws the tab pills at the Swift’s two fills and two borders', () => {
        mount();
        const active = screen.getByTestId(`web-tab-${TAB1}`);
        const idle = screen.getByTestId(`web-tab-${TAB2}`);
        expect(active.style.background).toContain('18%');
        expect(active.style.background).toContain('--nex-accent');
        expect(active.style.border).toContain('40%');
        expect(idle.style.background).toContain('8%');
        expect(idle.style.background).toContain('--nex-fg-secondary');
        expect(idle.style.border).toContain('transparent');
        expect(idle.style.background).not.toContain('--nex-surface-bg');
    });

    /**
     * L68 — `ScrollView(.horizontal, showsIndicators: false)` over an `HStack(spacing: 4)
     * .padding(.horizontal, 8).padding(.bottom, 4)` (`WebPaneChrome.swift:282-297`). The port
     * inherited the global 9 px scrollbar and padded 6 px / 4 px on BOTH vertical edges.
     */
    it('hides the strip’s scrollbar and pads it 8 px across, 4 px at the bottom only', () => {
        mount();
        const strip = screen.getByTestId(`web-tabs-${PANE}`);
        expect(strip.hasAttribute('data-nex-web-tabstrip')).toBe(true);
        expect(strip.className).toContain('px-2');
        expect(strip.className).toContain('pb-1');
        expect(strip.className).not.toContain('py-1');
        expect(strip.className).toContain('gap-1'); // HStack(spacing: 4)
    });

    /**
     * L70 — `WebPaneState.swift:18-23` is title → **host** → url → "New Tab". The port's pill
     * skipped the host step and lowercased the placeholder, so an untitled tab showed its whole
     * URL in a 180 px pill while the pane header beside it showed the host.
     */
    it('falls back through host, then url, then "New Tab"', () => {
        expect(tabLabel({ id: TAB1, url: 'https://example.com/x', title: 'T' })).toBe('T');
        expect(tabLabel({ id: TAB1, url: 'https://second.test/deep/path?q=1', title: '' })).toBe(
            'second.test'
        );
        // Not a URL the parser can read: the raw string is better than nothing.
        expect(tabLabel({ id: TAB1, url: 'not a url', title: '' })).toBe('not a url');
        expect(tabLabel({ id: TAB1, url: '', title: '' })).toBe('New Tab');

        mount();
        expect(screen.getByTestId(`web-tab-select-${TAB2}`).textContent).toBe('second.test');
    });
});

// ── the pickup panel ────────────────────────────────────────────────────────────────

function session(): WebBatchSession {
    return {
        id: 'batch-1',
        visible: true,
        armed: true,
        sticky: true,
        focused_id: 'i1',
        target_pane_id: null,
        items: [
            { id: 'i1', tag: 'div', selector: '#main > .row', comment: '' },
            { id: 'i2', tag: 'button', selector: '#submit', comment: '' }
        ]
    } as unknown as WebBatchSession;
}

describe('pickup panel typography and structure (L71, L72)', () => {
    function mountPanel(): void {
        render(
            <BatchPanel
                paneID={PANE}
                session={session()}
                activeTabID={TAB1}
                destinations={[]}
                commands={commands()}
                destination={null}
                onDestinationChange={() => {}}
            />
        );
    }

    /**
     * L71 — `WebBatchInspectPanel.swift:157-172`: the tag is **uppercased, semibold monospace and
     * accent-coloured**, the selector is `.primary`, and the chip is 18×18 at 10 pt. The port had
     * the raw lowercase tag in `textSecondary`, the selector a tier quieter again in
     * `textTertiary`, and a 16×16 / 9 px chip that no longer matched the page badge it twins.
     */
    it('accents the uppercased tag, keeps the selector primary, and sizes the chip 18×18', () => {
        mountPanel();
        const tag = screen.getByTestId('web-batch-tag-i1');
        expect(tag.className).toContain('uppercase');
        expect(tag.className).toContain('font-semibold');
        expect(tag.className).toContain('text-[10px]');
        expect(tag.style.color).toContain('--nex-accent');

        const selector = screen.getByTestId('web-batch-selector-i1');
        expect(selector.style.color).toContain('--nex-fg,');

        const chip = screen.getByTestId('web-batch-chip-i1');
        expect(chip.className).toContain('h-[18px]');
        expect(chip.className).toContain('w-[18px]');
        expect(chip.className).toContain('text-[10px]');
    });

    /**
     * L72 — `VStack(spacing: 0) { header; Divider(); list; Divider(); footer }` under a top-edge
     * `Divider` overlay (`:53-66`), rows that carry `Color.secondary.opacity(0.06)` when
     * unfocused, and `.animation(.easeOut(duration: 0.18), value: isFocused)` (`:210-221`).
     */
    it('fences the header and the footer, tints unfocused rows and eases the focus change', () => {
        mountPanel();
        expect(screen.getByTestId(`web-batch-header-rule-${PANE}`).style.borderTop).toContain(
            '--nex-border'
        );
        expect(screen.getByTestId(`web-batch-footer-rule-${PANE}`).style.borderTop).toContain(
            '--nex-border'
        );

        const focused = screen.getByTestId('web-batch-item-i1');
        const idle = screen.getByTestId('web-batch-item-i2');
        expect(focused.style.background).toContain('18%');
        expect(focused.style.border).toContain('50%');
        expect(idle.style.background).toContain('6%');
        expect(idle.style.background).toContain('--nex-fg-secondary');
        expect(idle.style.border).toContain('transparent');
        for (const row of [focused, idle]) {
            expect(row.style.transition).toContain('180ms');
            expect(row.style.transition).toContain('ease-out');
        }
    });

    /** L73's pickup half: `.help("Remove this item")` (`WebBatchInspectPanel.swift:206`). */
    it('gives the pickup remove ✕ its tooltip', () => {
        mountPanel();
        expect(screen.getByTestId('web-batch-remove-i1').getAttribute('title')).toBe(
            'Remove this item'
        );
    });
});
