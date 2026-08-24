/**
 * H10 — the native menu a right-click inside a content pane's document gets.
 *
 * The defect this covers is an absence: `grep -rn "'context-menu'" packages/shell/src/` returned
 * nothing, so a diff pane's right-click did nothing at all, and a markdown pane's replaced
 * WebKit's whole menu with two items. `MarkdownPaneView.swift:457-494` *inserts* its two commands
 * into WebKit's menu and a diff `WKWebView` shows that menu untouched — Copy, Look Up, Speech,
 * Services — which is the set built here.
 */

import { describe, expect, it, vi } from 'vitest';

import {
    contentContextMenuLogLine,
    contentContextMenuTemplate,
    lookUpLabel,
    type ContentContextMenuDeps,
    type ContentContextMenuParams
} from './context-menu.js';

function deps(overrides: Partial<ContentContextMenuDeps> = {}): ContentContextMenuDeps {
    return {
        platform: 'darwin',
        isPackaged: true,
        lookUp: vi.fn(),
        inspect: vi.fn(),
        ...overrides
    };
}

function params(overrides: Partial<ContentContextMenuParams> = {}): ContentContextMenuParams {
    return {
        frameURL: 'about:srcdoc',
        pageURL: 'http://127.0.0.1:7777/',
        selectionText: '',
        isEditable: false,
        x: 10,
        y: 20,
        ...overrides
    };
}

/** Roles and labels, in order, so "what does the menu contain" is one readable list. */
function rows(template: readonly unknown[]): string[] {
    return template.map((entry) => {
        const item = entry as Record<string, unknown>;
        if (item['type'] === 'separator') return '---';
        return String(item['role'] ?? item['label'] ?? '?');
    });
}

describe('the content-frame context menu', () => {
    it('is built ONLY for a subframe — the chrome owns every other right-click', () => {
        // No `frameURL` = the main frame, where the sidebar/pane-header DOM menus live. They
        // call preventDefault(), so this event should not even arrive; refusing here is the
        // belt to that braces.
        expect(contentContextMenuTemplate(params({ frameURL: '' }), deps())).toEqual([]);
        expect(contentContextMenuTemplate(params({ frameURL: undefined }), deps())).toEqual([]);
        // …and a `frameURL` that merely echoes the page's own URL is the main frame too, so a
        // right-click on a terminal or the sidebar can never raise this menu.
        expect(
            contentContextMenuTemplate(
                params({ frameURL: 'http://127.0.0.1:7777/', pageURL: 'http://127.0.0.1:7777/' }),
                deps()
            )
        ).toEqual([]);
        expect(contentContextMenuTemplate(params(), deps()).length).toBeGreaterThan(0);
    });

    it('gives a selection WebKit’s own set: Copy, Look Up, Speech, Services', () => {
        const template = contentContextMenuTemplate(params({ selectionText: 'the diff hunk' }), deps());
        expect(rows(template)).toEqual(['copy', 'Look Up “the diff hunk”', '---', 'Speech', '---', 'services']);
    });

    it('runs the real look-up when the row is clicked', () => {
        const lookUp = vi.fn();
        const template = contentContextMenuTemplate(params({ selectionText: 'hunk' }), deps({ lookUp }));
        const row = template[1] as { click?: () => void };
        row.click?.();
        expect(lookUp).toHaveBeenCalledTimes(1);
    });

    it('offers Select All when nothing is selected, rather than an empty menu', () => {
        const template = contentContextMenuTemplate(params(), deps());
        expect(rows(template)).toEqual(['selectAll', '---', 'services']);
    });

    it('gives an editable node the edit set, greyed the way the edit flags say', () => {
        const template = contentContextMenuTemplate(
            params({ isEditable: true, editFlags: { canCut: false, canPaste: true } }),
            deps()
        );
        expect(rows(template)).toEqual(['cut', 'copy', 'paste', '---', 'selectAll', '---', 'services']);
        expect((template[0] as { enabled?: boolean }).enabled).toBe(false);
        expect((template[2] as { enabled?: boolean }).enabled).toBe(true);
    });

    it('drops the macOS-only roles off macOS', () => {
        const template = contentContextMenuTemplate(
            params({ selectionText: 'x' }),
            deps({ platform: 'linux' })
        );
        expect(rows(template)).toEqual(['copy', 'Look Up “x”']);
    });

    it('adds Inspect Element in a dev build only, and inspects at the click point', () => {
        const inspect = vi.fn();
        const dev = contentContextMenuTemplate(params(), deps({ isPackaged: false, inspect }));
        expect(rows(dev)).toContain('Inspect Element');
        (dev.at(-1) as { click?: () => void }).click?.();
        expect(inspect).toHaveBeenCalledWith(10, 20);

        expect(rows(contentContextMenuTemplate(params(), deps({ isPackaged: true })))).not.toContain(
            'Inspect Element'
        );
    });

    it('single-lines and truncates the Look Up label the way WebKit’s row does', () => {
        expect(lookUpLabel('  two   words \n more ')).toBe('Look Up “two words more”');
        expect(lookUpLabel('x'.repeat(60))).toBe(`Look Up “${'x'.repeat(23)}…”`);
    });

    it('logs a line, because a native menu is invisible from outside the process', () => {
        expect(contentContextMenuLogLine(6, true)).toBe(
            'context-menu: 6 items for a content frame (selection=yes)'
        );
        expect(contentContextMenuLogLine(3, false)).toContain('selection=no');
    });
});
