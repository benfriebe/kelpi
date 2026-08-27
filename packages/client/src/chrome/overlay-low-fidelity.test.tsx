/**
 * The LOW-POLISH overlay / global-chrome items — `docs/UI-FIDELITY.md` L94…L105.
 *
 * The command palette's card and rows, graft's banner / dot / toggle, the sidebar handle, and the
 * one stylesheet rule that was leaking a focus ring onto every text field in the app. Each block
 * names the Swift line it is holding the port to.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GraftOrphanBanner, GraftToggleButton } from './GraftControls';
import { CommandPalette, SidebarResizer, type PaletteItem } from './index';
import { tokens } from './tokens';
import type { GraftSessionView } from '../state/graft';

afterEach(cleanup);

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const P1 = 'dddddddd-0000-4000-8000-000000000001';

const ITEMS: readonly PaletteItem[] = [
    {
        id: `ws:${W1}`,
        kind: 'workspace',
        icon: 'rectangle.stack',
        title: 'nex-client',
        subtitle: '2 panes',
        workspaceID: W1,
        workspaceName: 'nex-client',
        paneID: null,
        workspaceColor: 'blue'
    },
    {
        id: `pane:${P1}`,
        kind: 'pane',
        icon: 'terminal',
        title: '~/code/nex',
        subtitle: 'zsh',
        workspaceID: W1,
        workspaceName: 'nex-client',
        paneID: P1,
        workspaceColor: 'blue'
    }
];

function paletteProps() {
    return {
        open: true,
        query: '',
        onQueryChange: vi.fn(),
        items: ITEMS,
        onConfirm: vi.fn(),
        onDismiss: vi.fn()
    };
}

function session(status: GraftSessionView['status']): GraftSessionView {
    return {
        associationID: W1,
        worktreePath: '/work/wt',
        parentRepoRoot: '/work/repo',
        branch: 'feature',
        status,
        error: null,
        lastSyncAt: null
    };
}

function rowFor(kind: 'workspace' | 'pane'): HTMLElement {
    return screen.getAllByTestId('palette-row').find(
        (row) => row.getAttribute('data-item-kind') === kind
    ) as HTMLElement;
}

describe('the command palette card (L94, L95, L97, L98, L101)', () => {
    it('L94/L95: a soft 12 px lift at 25 %, and NO border', () => {
        render(<CommandPalette {...paletteProps()} />);
        const card = screen.getByTestId('command-palette');
        // `.shadow(color: .black.opacity(0.25), radius: 12, y: 4)` — not 20/60/0.45.
        expect(card.style.boxShadow).toBe('0 4px 12px rgba(0,0,0,0.25)');
        // `.background(...).clipShape(...)` and nothing else: the shipped card has no stroke.
        expect(card.style.border).toBe('');
    });

    it('L97: the search row is 10 px tall each side, with a 14 px magnifier in the secondary tone', () => {
        render(<CommandPalette {...paletteProps()} />);
        const glyph = screen.getByTestId('palette-search-glyph');
        // The app's own drawn magnifier at 14 px, not the small `⌕` text glyph.
        expect(glyph.querySelector('svg')?.getAttribute('width')).toBe('14');
        expect(glyph.querySelector('svg')?.getAttribute('data-icon')).toBe('search');
        expect(glyph.style.color).toBe(tokens.textSecondary);
        const row = glyph.parentElement as HTMLElement;
        expect(row.className).toContain('py-[10px]');
        expect(row.className).not.toContain('py-2 ');
    });

    it('L98: the list insets vertically only, and a selected row is a full-bleed band', () => {
        render(<CommandPalette {...paletteProps()} />);
        const row = rowFor('workspace');
        const list = row.parentElement as HTMLElement;
        expect(list.className).toContain('py-1');
        expect(list.className).not.toContain('p-1 ');
        // `.padding(.horizontal, 12)` on the ROW is what indents the content…
        expect(row.className).toContain('px-3');
        // …and the selection background has no radius at all.
        expect(row.className).not.toContain('rounded');
    });

    it('L101: "No results" is 13 px secondary, and the divider only exists when something follows', () => {
        const view = render(<CommandPalette {...paletteProps()} items={[]} query="zzz" />);
        const empty = screen.getByTestId('palette-no-results');
        expect(empty.className).toContain('text-[13px]');
        expect(empty.style.color).toBe(tokens.textSecondary);
        expect(
            (screen.getByTestId('palette-search-glyph').parentElement as HTMLElement).className
        ).toContain('border-b');

        // Nothing to list AND nothing typed: a bare field, exactly as the `if/else if` renders.
        view.rerender(<CommandPalette {...paletteProps()} items={[]} query="" />);
        expect(screen.queryByTestId('palette-no-results')).toBeNull();
        expect(
            (screen.getByTestId('palette-search-glyph').parentElement as HTMLElement).className
        ).not.toContain('border-b');
    });
});

describe('the command palette rows (L99, L100)', () => {
    it('L99: 10 px item gap, a 16 px icon column at 12 px, 1 px under the title', () => {
        render(<CommandPalette {...paletteProps()} />);
        const row = rowFor('pane');
        expect(row.className).toContain('gap-2.5');
        const icon = [...row.querySelectorAll('span')].find((node) => node.className.includes('text-center'));
        expect(icon?.className).toContain('w-4');
        expect(icon?.className).toContain('text-[12px]');
        const stack = within(row).getByText('~/code/nex').parentElement as HTMLElement;
        expect(stack.className).toContain('gap-px');
    });

    it('L100: the neutral pill is tertiary, and the workspace pill’s name is white at 90 %', () => {
        render(<CommandPalette {...paletteProps()} />);
        const neutral = within(rowFor('workspace')).getByText('workspace');
        expect(neutral.style.color).toBe(tokens.textTertiary);
        const named = within(rowFor('pane')).getByText('nex-client');
        expect(named.style.color).toBe('rgba(255, 255, 255, 0.9)');
        expect(named.className).not.toContain('text-white');
    });
});

describe('graft chrome (L102, L103, L104)', () => {
    const orphan = {
        associationID: W1,
        parentRepoRoot: '/work/repo',
        worktreePath: '/work/wt',
        branch: 'feature'
    };

    it('L102: Restore and Dismiss are the SAME small button, 6 px apart', () => {
        render(<GraftOrphanBanner orphan={orphan} onRestore={vi.fn()} onDismiss={vi.fn()} />);
        const restore = screen.getByTestId(`graft-orphan-restore-${W1}`);
        const dismiss = screen.getByTestId(`graft-orphan-dismiss-${W1}`);
        expect(restore.className).toBe(dismiss.className);
        expect(restore.className).not.toContain('font-medium');
        expect(restore.style.borderColor).toBe(dismiss.style.borderColor);
        expect(restore.style.color).toBe(dismiss.style.color);
        expect(restore.style.background).toBe(dismiss.style.background);
        expect((restore.parentElement as HTMLElement).className).toContain('gap-1.5');
    });

    it('L103: the syncing pulse fades the dot without resizing it', () => {
        render(
            <GraftToggleButton
                associationID={W1}
                session={session('syncing')}
                tooltip="Syncing feature..."
                onToggle={vi.fn()}
            />
        );
        const style = document.getElementById('nex-graft-pulse-style');
        expect(style?.textContent).toContain('opacity');
        // `.symbolEffect(.pulse)` is opacity only — a status marker never changes size (§H24).
        expect(style?.textContent).not.toContain('scale');
        expect(style?.textContent).not.toContain('transform');
    });

    it('L104: the toggle brightens on HOVER, not because a session exists', () => {
        render(
            <GraftToggleButton
                associationID={W1}
                session={session('watching')}
                tooltip="Mirroring feature"
                onToggle={vi.fn()}
            />
        );
        const button = screen.getByTestId(`graft-toggle-${W1}`);
        expect(button.style.color).toBe(tokens.textSecondary);
        fireEvent.mouseEnter(button);
        expect(button.style.color).toBe(tokens.textPrimary);
        fireEvent.mouseLeave(button);
        expect(button.style.color).toBe(tokens.textSecondary);
    });
});

describe('the sidebar handle (L105)', () => {
    it('has no double-click reset — the shipped handle hovers and drags, nothing else', () => {
        const onResize = vi.fn();
        const onCommit = vi.fn();
        render(<SidebarResizer width={260} onResize={onResize} onCommit={onCommit} />);
        fireEvent.doubleClick(screen.getByTestId('sidebar-resizer'));
        expect(onResize).not.toHaveBeenCalled();
        expect(onCommit).not.toHaveBeenCalled();
    });
});

describe('the global focus ring (L96)', () => {
    const stylesheet = readFileSync(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'),
        'utf8'
    );

    it('is layered, so a control that declares `outline-none` finally wins', () => {
        // Unlayered CSS outranks every Tailwind utility; in `@layer base` the utility wins.
        expect(stylesheet).toMatch(/@layer base \{\s*\n\s*:focus-visible \{/);
        expect(stylesheet).not.toMatch(/\n:focus-visible \{/);
    });

    it('still paints a ring — this removes the leak, not the affordance', () => {
        // Anchored on the ring's OWN layer block. There are two `@layer base` blocks in the file
        // since S1/S17 layered the control reset, and `indexOf('@layer base {')` now finds that
        // one first — the slice below has to start at the ring or it is asserting on a span that
        // happens to contain it.
        const start = stylesheet.indexOf('@layer base {\n  :focus-visible {');
        expect(start).toBeGreaterThan(-1);
        const block = stylesheet.slice(start, stylesheet.indexOf('}', start));
        expect(block).toContain('outline: 1px solid var(--nex-accent)');
        expect(block).toContain('outline-offset: 1px');
    });

    it('and the palette field is one of the controls that declines it', () => {
        render(<CommandPalette {...paletteProps()} />);
        expect(screen.getByLabelText('Jump to workspace or pane').className).toContain('outline-none');
    });
});

/**
 * SPACING-REVIEW S1 / S17 — the control reset's BOX half is layered too.
 *
 * The same mechanism L96 fixed above, one rule further up the file and twenty-five register rows
 * wide: `button { padding: 0; border: none; font: inherit }` and `input { font: inherit }` were
 * emitted UNLAYERED, so every `px-*`, every `border` and every `text-[Npx]` written as a class on
 * a control in this client painted nothing. The shipped bundle put the reset at brace depth 0
 * while `.px-3` sat inside `theme`→`base`→`utilities`; a live probe read `padding: 0px,
 * border-width: 0px, font-size: 13px` off a `<button>` carrying `px-2.5 py-1 rounded border
 * text-[11px]` and `4px 10px / 1px / 11px` off a `<div>` carrying the identical list.
 *
 * This is the guard against a silent revert, and it is deliberately three claims rather than one:
 * the box half must be layered; the reset must still HAPPEN (a bare `<button>` still gets no
 * padding, no border and the inherited face, because base still outranks the user agent and
 * Tailwind's own preflight); and `cursor` / `background` must stay UNLAYERED, because layering
 * those would hand `cursor-pointer` and `bg-*` classes an override no register row asked for.
 */
describe('the global control reset (SPACING-REVIEW S1/S17)', () => {
    const stylesheet = readFileSync(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'),
        'utf8'
    );

    /** The `@layer base { … }` block that carries the control reset, brace-matched. */
    const resetLayer = (): string => {
        const marker = stylesheet.indexOf('@layer base {\n  button {');
        expect(marker).toBeGreaterThan(-1);
        let depth = 0;
        for (let i = stylesheet.indexOf('{', marker); i < stylesheet.length; i++) {
            if (stylesheet[i] === '{') depth++;
            else if (stylesheet[i] === '}' && --depth === 0) return stylesheet.slice(marker, i + 1);
        }
        throw new Error('unterminated @layer base block');
    };

    /** The top-level (unlayered) `button { … }` rule. */
    const unlayeredButton = (): string => {
        const marker = stylesheet.indexOf('\nbutton {');
        expect(marker).toBeGreaterThan(-1);
        return stylesheet.slice(marker, stylesheet.indexOf('}', marker) + 1);
    };

    it('puts padding, border and font in @layer base, so a utility can win', () => {
        const layer = resetLayer();
        expect(layer).toMatch(/button \{[^}]*padding: 0/);
        expect(layer).toMatch(/button \{[^}]*border: none/);
        expect(layer).toMatch(/button \{[^}]*font: inherit/);
        expect(layer).toMatch(/input \{[^}]*font: inherit/);
    });

    it('leaves nothing box-shaped in the unlayered rule, where it would outrank every utility', () => {
        const bare = unlayeredButton();
        expect(bare).not.toContain('padding');
        expect(bare).not.toContain('border');
        expect(bare).not.toContain('font:');
    });

    it('keeps cursor and background unlayered — those overrides were never asked for', () => {
        const bare = unlayeredButton();
        expect(bare).toContain('cursor: default');
        expect(bare).toContain('background: none');
    });
});
