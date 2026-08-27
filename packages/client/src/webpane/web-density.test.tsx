/**
 * The web pane's DENSITY pack — `docs/SPACING-REVIEW.md` S12, S28, S29, S34, S35, S36, S37.
 *
 * The register asks a different question from `docs/UI-FIDELITY.md`: not "does it look like the
 * shipped app" but "does it feel cramped". Every case below therefore asserts the *number* the
 * cited Swift line specifies — a padding, a frame, a fill — rather than "something changed", and
 * every one of them is a metric that was measured wrong on a live boot before the fix:
 *
 *   S12  the storage panel's eighth chip (Refresh) was 51.03 × 18.0 at `1px 6px` while its seven
 *        siblings were 23.4 at `3px 8px`;
 *   S28  the four glyph buttons were the character's own ink (8.39 × 15.4 … 10.25 × 15.4);
 *   S29  the pickup row's remove ✕ was 16.39 × 15.4 against the 18 × 18 chip opposite it;
 *   S34  the storage panel was `p-2` (8 px) where the Swift insets 10 horizontally;
 *   S35  one `p-2` + `gap-1.5` on the pickup panel flattened the Swift's per-band 10/5, 8/6,
 *        10/6 step and inset the two dividers by 8 px;
 *   S36  the find field was `surfaceBackground` at radius 4 with 4 px insets — darker than the
 *        bar it sits in, §L22's inverted-contrast defect, on the one bar that never got L22;
 *   S37  the cookie form's 1 px border sat 6 px from each field's own 1 px border, with 2 px
 *        between the caret line and the inner one.
 *
 * jsdom lays nothing out, so these are assertions on the class list and the inline style — the
 * two places the metric is *stated*. The pixel readings above come from the live sandbox boots
 * quoted in each block.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { CommandReply } from '../connection';
import { BatchPanel } from './BatchPanel';
import type { WebPaneCommands } from './commands';
import { StoragePanel } from './StoragePanel';
import { WebFindBar } from './WebFindBar';
import type { WebBatchSession } from './state';

afterEach(cleanup);

const PANE = 'DDDDDDDD-0000-4000-8000-000000000001';
const TAB = 'EEEEEEEE-0000-4000-8000-000000000001';

const COOKIES = [
    { name: 'a', value: '1', domain: 'example.com', path: '/', is_secure: false, is_http_only: false }
];

interface Fake {
    readonly commands: WebPaneCommands;
    answer(verb: string, reply: CommandReply): void;
}

function fakeCommands(): Fake {
    const replies = new Map<string, CommandReply[]>();
    const commands = new Proxy(
        {},
        {
            get:
                (_target, property: string) =>
                (): Promise<CommandReply> =>
                    Promise.resolve(replies.get(property)?.shift() ?? ({ ok: true } as CommandReply))
        }
    ) as unknown as WebPaneCommands;
    return {
        commands,
        answer(verb, reply) {
            const queued = replies.get(verb) ?? [];
            queued.push(reply);
            replies.set(verb, queued);
        }
    };
}

function batchSession(): WebBatchSession {
    return {
        id: 'batch-1',
        visible: true,
        armed: true,
        sticky: true,
        focused_id: 'i1',
        target_pane_id: null,
        items: [{ id: 'i1', tag: 'div', selector: '#main > .row', comment: '' }]
    } as unknown as WebBatchSession;
}

// ── the storage panel ───────────────────────────────────────────────────────────────

describe('storage panel density (S12, S28, S34, S37)', () => {
    async function open(): Promise<void> {
        const fake = fakeCommands();
        fake.answer('cookiesList', { ok: true, cookies: COOKIES } as unknown as CommandReply);
        render(
            <StoragePanel
                paneID={PANE}
                isPrivate={false}
                commands={fake.commands}
                onClose={() => {}}
                now={() => 0}
            />
        );
        await waitFor(() => expect(screen.getByTestId('web-cookie-group-example.com')).not.toBeNull());
    }

    /**
     * S34 — `StoragePanel.swift:52-53`: `.padding(.horizontal, 10).padding(.vertical, 8)`.
     * Measured `padding: 8px` on all four sides, so every row started 8 px from the pane's edge
     * and the trailing ✕ ended 8 px from it.
     */
    it('S34 — insets the panel 10 horizontally and 8 vertically', async () => {
        await open();
        const panel = screen.getByTestId(`web-storage-${PANE}`);
        expect(panel.className).toContain('px-2.5');
        expect(panel.className).toContain('py-2');
        expect(panel.className).not.toMatch(/(^|\s)p-2(\s|$)/);
    });

    /**
     * S12 — the eighth chip. Seven of the eight carry `px-2 py-[3px]` and measured 23.4 px tall
     * once S1 layered the reset; Refresh kept `px-1.5 py-[1px]` and measured 51.03 × 18.0 with a
     * 6 px side inset — still under the 20 px pointer line, and the only chip in the panel with
     * a different box. Same 3/8 padding as its siblings; its declared 10 px type stays.
     */
    it('S12 — Refresh carries the same 3/8 chip box as the other seven', async () => {
        await open();
        const refresh = screen.getByTestId(`web-storage-refresh-${PANE}`);
        expect(refresh.className).toContain('px-2');
        expect(refresh.className).toContain('py-[3px]');
        expect(refresh.className).toContain('border');
        expect(refresh.className).toContain('text-[10px]');
        expect(refresh.className).not.toContain('px-1.5');
        expect(refresh.className).not.toContain('py-[1px]');

        for (const testID of [`web-cookie-add-${PANE}`, `web-clear-site-data-${PANE}`]) {
            const sibling = screen.getByTestId(testID);
            expect(sibling.className).toContain('px-2');
            expect(sibling.className).toContain('py-[3px]');
        }
    });

    /**
     * S28 — the Swift frames each of these glyphs rather than letting the character be the
     * control: 16 × 16 for the panel close (`StoragePanel.swift:96-99`), the domain ＋ (`:232`)
     * and the domain ✕ (`:242`), and 14 × 14 for the per-cookie delete (`:298`). Measured
     * 8.39 × 15.4 / 10.16 × 15.4 / 8.39 × 15.4 / 10.25 × 15.4 with `padding: 0px`.
     */
    it('S28 — every glyph button is an explicit box, 16 px at panel level and 14 in a row', async () => {
        await open();
        for (const testID of [
            `web-storage-close-${PANE}`,
            'web-cookie-add-example.com',
            'web-cookie-clear-example.com'
        ]) {
            const button = screen.getByTestId(testID);
            expect(button.className).toContain('h-4');
            expect(button.className).toContain('w-4');
            expect(button.className).toContain('items-center');
            expect(button.className).toContain('justify-center');
        }

        // The row delete is the smaller of the Swift's two sizes.
        screen.getByTestId('web-cookie-group-example.com').click();
        await waitFor(() => expect(screen.getByTestId('web-cookie-delete-a')).not.toBeNull());
        const rowDelete = screen.getByTestId('web-cookie-delete-a');
        expect(rowDelete.className).toContain('h-[14px]');
        expect(rowDelete.className).toContain('w-[14px]');
    });

    /**
     * S37 — `StoragePanel.swift:610-611` insets the form 8 horizontal / 6 vertical and its
     * `strokeBorder` draws inside its bounds. At `p-1.5` the form's border sat 6 px from each
     * field's border (two nested 1 px rules), and the fields' `py-[2px]` left 2 px between the
     * caret line and the inner one — 3 px is the least that keeps them apart.
     */
    it('S37 — the cookie form is inset 8, and its fields clear their own border by 3', async () => {
        await open();
        screen.getByTestId(`web-cookie-add-${PANE}`).click();
        await waitFor(() => expect(screen.getByTestId(`web-cookie-form-${PANE}`)).not.toBeNull());
        expect(screen.getByTestId(`web-cookie-form-${PANE}`).className).toContain('p-2');
        for (const field of ['name', 'value', 'domain', 'path']) {
            const input = screen.queryByTestId(`web-cookie-form-${field}-${PANE}`);
            if (input === null) continue;
            expect(input.className).toContain('py-[3px]');
            expect(input.className).toContain('px-1.5');
        }
    });
});

// ── the pickup panel ────────────────────────────────────────────────────────────────

describe('pickup panel density (S29, S35)', () => {
    function mount(): void {
        render(
            <BatchPanel
                paneID={PANE}
                session={batchSession()}
                activeTabID={TAB}
                destinations={[]}
                commands={fakeCommands().commands}
                destination={null}
                onDestinationChange={() => {}}
            />
        );
    }

    /**
     * S35 — `WebBatchInspectPanel.swift:53-64` is `VStack(spacing: 0) { header; Divider();
     * items; Divider(); footer }` with NO padding on the stack: each band pads itself, and
     * deliberately unequally (header `:107-108` 10/5, items `:125` 8/6, empty hint `:149-150`
     * 10/8, footer `:236-237` 10/6). One `p-2` + `gap-1.5` on the container flattened all of
     * that to 8/6 and inset both `Divider()`s by 8 px, where the shipped rules span the panel.
     */
    it('S35 — the panel pads nothing, and each band carries the Swift’s own inset', () => {
        mount();
        const panel = screen.getByTestId(`web-batch-panel-${PANE}`);
        expect(panel.className).not.toMatch(/(^|\s)p-2(\s|$)/);
        expect(panel.className).not.toContain('gap-1.5');

        const header = panel.children[0] as HTMLElement;
        expect(header.className).toContain('px-2.5');
        expect(header.className).toContain('py-[5px]');

        const items = screen.getByTestId(`web-batch-items-${PANE}`);
        expect(items.className).toContain('px-2');
        expect(items.className).toContain('py-1.5');

        const footer = screen.getByTestId(`web-batch-cancel-${PANE}`).parentElement as HTMLElement;
        expect(footer.className).toContain('px-2.5');
        expect(footer.className).toContain('py-1.5');

        // …and the two rules are unpadded children of the unpadded panel, so they run edge to
        // edge the way a `Divider()` in that `VStack` does.
        for (const rule of [
            screen.getByTestId(`web-batch-header-rule-${PANE}`),
            screen.getByTestId(`web-batch-footer-rule-${PANE}`)
        ]) {
            expect(rule.parentElement).toBe(panel);
            expect(rule.className).toBe('');
        }
    });

    /** S35's empty state takes the hint's own 10/8 (`WebBatchInspectPanel.swift:149-150`). */
    it('S35 — the empty hint is inset 10 × 8, not 4 × 8', () => {
        render(
            <BatchPanel
                paneID={PANE}
                session={{ ...batchSession(), items: [] } as unknown as WebBatchSession}
                activeTabID={TAB}
                destinations={[]}
                commands={fakeCommands().commands}
                destination={null}
                onDestinationChange={() => {}}
            />
        );
        const hint = screen.getByTestId(`web-batch-empty-${PANE}`);
        expect(hint.className).toContain('px-2.5');
        expect(hint.className).toContain('py-2');
        expect(hint.className).not.toContain('px-1');
    });

    /**
     * S29 — `WebBatchInspectPanel.swift:198-204` frames the remove ✕ at 18 × 18 with a
     * `.contentShape(Rectangle())`: the same box as the numbered chip at the row's other end.
     * Measured 16.39 × 15.4 with `padding: 0px 4px` — one end of the row a control, the other a
     * character.
     */
    it('S29 — the remove ✕ is an 18 × 18 box, matching the numbered chip opposite it', () => {
        mount();
        const remove = screen.getByTestId('web-batch-remove-i1');
        expect(remove.className).toContain('h-[18px]');
        expect(remove.className).toContain('w-[18px]');
        expect(remove.className).toContain('items-center');
        expect(remove.className).not.toContain('px-1');
        // The chip it has to match is already 18 × 18 (§L71), stated the same way.
        const chip = screen.getByTestId('web-batch-chip-i1');
        expect(chip.className).toContain('h-[18px]');
        expect(chip.className).toContain('w-[18px]');
    });
});

// ── the find bar ────────────────────────────────────────────────────────────────────

describe('web find field (S36)', () => {
    /**
     * S36 — the app draws ONE find bar (`PaneSearchOverlay.swift:18-86`), and L22 settled its
     * field on the terminal/content copy: `Color.primary.opacity(0.08)` (`:27`),
     * `.cornerRadius(5)` (`:28`), `.padding(.vertical, 5)` (`:26`). The web bar kept a pre-L22
     * copy — `surfaceBackground` (#101013) at radius 4 with `py-1` — which is *darker* than the
     * #13131A bar around it, so the field read as a hole punched in the bar rather than a well
     * set into it. Measured 160 × 24.8, `padding: 4px 8px`, radius 4, fill rgb(16,16,19).
     */
    it('S36 — the field is the terminal bar’s well: 8 % label tint, radius 5, 5 px insets', () => {
        render(<WebFindBar paneID={PANE} activeTabID={TAB} commands={fakeCommands().commands} onClose={() => {}} />);
        const input = screen.getByTestId(`web-find-input-${PANE}`);
        expect(input.style.background).toContain('color-mix');
        expect(input.style.background).toContain('8%');
        expect(input.style.borderRadius).toBe('5px');
        expect(input.style.paddingTop).toBe('5px');
        expect(input.style.paddingBottom).toBe('5px');
        // The classes that used to state the other values are gone, so nothing states two.
        expect(input.className).not.toContain('py-1');
        expect(input.className).not.toMatch(/(^|\s)rounded(\s|$)/);
        // The 160 px width and the 12 px mono face are §M38's and are untouched.
        expect(input.className).toContain('w-[160px]');
        expect(input.style.fontSize).toBe('12px');
    });
});
