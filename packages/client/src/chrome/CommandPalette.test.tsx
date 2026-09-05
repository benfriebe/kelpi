import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommandPalette, FOCUS_HANDOFF_MS, type PaletteItem } from './index';

afterEach(cleanup);

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const P1 = 'dddddddd-0000-4000-8000-000000000001';
const P2 = 'dddddddd-0000-4000-8000-000000000002';

const ITEMS: readonly PaletteItem[] = [
    {
        id: `ws:${W1}`,
        kind: 'workspace',
        icon: 'rectangle.stack',
        title: 'kelpi-client',
        subtitle: '2 panes',
        workspaceID: W1,
        workspaceName: 'kelpi-client',
        paneID: null,
        workspaceColor: 'blue'
    },
    {
        id: `pane:${P1}`,
        kind: 'pane',
        icon: 'terminal',
        title: '~/code/kelpi',
        subtitle: '',
        workspaceID: W1,
        workspaceName: 'kelpi-client',
        paneID: P1,
        workspaceColor: 'blue'
    },
    {
        id: `pane:${P2}`,
        kind: 'pane',
        icon: 'doc.text',
        title: 'notes',
        subtitle: 'README.md',
        workspaceID: W1,
        workspaceName: 'kelpi-client',
        paneID: P2,
        workspaceColor: 'blue'
    }
];

const W2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const P3 = 'dddddddd-0000-4000-8000-000000000003';

/**
 * The universe `buildPaletteItems` emits for two workspaces: a workspace, ITS panes, the next
 * workspace, its panes. UI-FIDELITY M54's whole subject is whether the list keeps that order.
 */
const TWO_WORKSPACES: readonly PaletteItem[] = [
    ...ITEMS,
    {
        id: `ws:${W2}`,
        kind: 'workspace',
        icon: 'rectangle.stack',
        title: 'daemon',
        subtitle: '1 pane',
        workspaceID: W2,
        workspaceName: 'daemon',
        paneID: null,
        workspaceColor: 'red'
    },
    {
        id: `pane:${P3}`,
        kind: 'pane',
        icon: 'terminal',
        title: '~/code/kelpid',
        subtitle: '',
        workspaceID: W2,
        workspaceName: 'daemon',
        paneID: P3,
        workspaceColor: 'red'
    }
];

function baseProps() {
    return {
        open: true,
        query: '',
        onQueryChange: vi.fn(),
        items: ITEMS,
        onConfirm: vi.fn(),
        onDismiss: vi.fn()
    };
}

function selectedID(): string | null {
    return screen.getByTestId('command-palette').querySelector('[data-selected="true"]')?.getAttribute('data-item-id') ?? null;
}

describe('rendering', () => {
    it('renders nothing while closed', () => {
        render(<CommandPalette {...baseProps()} open={false} />);
        expect(screen.queryByTestId('command-palette')).toBeNull();
    });

    /**
     * UI-FIDELITY M54 — one flat interleaved list, no section headers. The two assertions that
     * demanded "Workspaces" / "Panes" headings were rewritten rather than kept: they pinned the
     * divergence itself. `CommandPaletteView.swift:41-75` is a single `ForEach` over the
     * universe, so a workspace is followed by ITS panes and there is no heading anywhere.
     */
    it('renders one flat list — each workspace followed by its own panes, no headers', () => {
        render(<CommandPalette {...baseProps()} items={TWO_WORKSPACES} />);
        expect(screen.queryByText('Workspaces')).toBeNull();
        expect(screen.queryByText('Panes')).toBeNull();
        expect(screen.getAllByTestId('palette-row').map((row) => row.dataset['itemId'])).toEqual([
            `ws:${W1}`,
            `pane:${P1}`,
            `pane:${P2}`,
            `ws:${W2}`,
            `pane:${P3}`
        ]);
        expect(selectedID()).toBe(`ws:${W1}`);
    });

    it('the kind is still legible per row, which is what the headers were doing', () => {
        render(<CommandPalette {...baseProps()} items={TWO_WORKSPACES} />);
        const rows = screen.getAllByTestId('palette-row');
        expect(rows.map((row) => row.dataset['itemKind'])).toEqual([
            'workspace',
            'pane',
            'pane',
            'workspace',
            'pane'
        ]);
        // The trailing chip: "workspace", or the owning workspace's name on a pane row.
        expect(rows[0]?.textContent).toContain('workspace');
        expect(rows[1]?.textContent).toContain('kelpi-client');
        expect(rows[4]?.textContent).toContain('daemon');
    });

    it('↑/↓ walk that interleaved order, so a pane sits under the workspace it belongs to', () => {
        render(<CommandPalette {...baseProps()} items={TWO_WORKSPACES} />);
        const input = screen.getByLabelText('Jump to workspace or pane');
        fireEvent.keyDown(input, { key: 'ArrowDown' });
        expect(selectedID()).toBe(`pane:${P1}`);
        fireEvent.keyDown(input, { key: 'ArrowDown' });
        fireEvent.keyDown(input, { key: 'ArrowDown' });
        expect(selectedID()).toBe(`ws:${W2}`);
    });

    it('applies the substring rule, including the p: scope', () => {
        render(<CommandPalette {...baseProps()} query="p:notes" />);
        expect(screen.getAllByTestId('palette-row').map((row) => row.dataset['itemId'])).toEqual([
            `pane:${P2}`
        ]);
        expect(screen.queryByText('Workspaces')).toBeNull();
    });

    /** UI-FIDELITY M56 — `ContentView.swift:264` is `Color.black.opacity(0.001)`: a hit target. */
    it('the backdrop is invisible, not an 8% scrim — and still takes the dismiss click', () => {
        const props = baseProps();
        render(<CommandPalette {...props} />);
        const backdrop = screen.getByTestId('palette-backdrop');
        expect(backdrop.style.background).toBe('transparent');
        fireEvent.mouseDown(backdrop);
        expect(props.onDismiss).toHaveBeenCalledOnce();
    });

    /**
     * shell-ui.md §7: "Selected row = accent @ 0.2 background" and a NEUTRAL `workspace` chip.
     * Both were literal dark-preset hexes (issue #57 shellui-28), so a light chrome or an
     * `accent` override reached every other surface but not the palette. The token reads
     * `var(--kelpi-…)`, which `withAlpha` turns into a `color-mix` rather than an rgba.
     */
    it('paints the selected row and the workspace chip from theme tokens, not fixed hexes', () => {
        render(<CommandPalette {...baseProps()} />);
        const selected = screen
            .getAllByTestId('palette-row')
            .find((row) => row.dataset['selected'] === 'true') as HTMLElement;
        expect(selected.style.background).toMatch(/^color-mix\(in srgb, var\(--kelpi-accent,[^)]*\) 20%/);
        expect(selected.style.background).not.toContain('111, 155, 216');
        const chip = Array.from(selected.querySelectorAll('span')).find(
            (span) => span.textContent === 'workspace'
        ) as HTMLElement;
        expect(chip.style.background).toMatch(/^color-mix\(in srgb, var\(--kelpi-fg,[^)]*\) 8%/);
    });

    it('shows "No results" for a query that matches nothing', () => {
        render(<CommandPalette {...baseProps()} query="zzz" />);
        expect(screen.getByTestId('palette-no-results')).toBeDefined();
        expect(screen.queryAllByTestId('palette-row')).toHaveLength(0);
    });
});

describe('keyboard navigation', () => {
    it('↑/↓ move the selection, clamped at both ends', () => {
        render(<CommandPalette {...baseProps()} />);
        const input = screen.getByLabelText('Jump to workspace or pane');

        fireEvent.keyDown(input, { key: 'ArrowUp' });
        expect(selectedID()).toBe(`ws:${W1}`); // already at the top: no wrap

        fireEvent.keyDown(input, { key: 'ArrowDown' });
        expect(selectedID()).toBe(`pane:${P1}`);
        fireEvent.keyDown(input, { key: 'ArrowDown' });
        fireEvent.keyDown(input, { key: 'ArrowDown' });
        expect(selectedID()).toBe(`pane:${P2}`); // already at the bottom: no wrap
    });

    it('hovering a row selects it', () => {
        render(<CommandPalette {...baseProps()} />);
        fireEvent.mouseEnter(screen.getAllByTestId('palette-row')[2] as HTMLElement);
        expect(selectedID()).toBe(`pane:${P2}`);
    });

    /**
     * UI-FIDELITY M55 — the keys are the PANEL's, not the text field's.
     *
     * `CommandPaletteView.swift:92-105` hangs `.onKeyPress` on the view body. The port bound
     * ↑/↓/Escape to the `<input>` alone, and `keys.ts:230-232` has the global dispatcher stand
     * down while the palette is open — so a keystroke that did not originate in the field
     * reached nothing at all, and only a backdrop click could close the palette.
     */
    describe('the keys belong to the panel (M55)', () => {
        it('↑/↓ answer a keystroke aimed at the card itself, not only at the field', () => {
            render(<CommandPalette {...baseProps()} />);
            const panel = screen.getByTestId('command-palette');

            fireEvent.keyDown(panel, { key: 'ArrowDown' });
            expect(selectedID()).toBe(`pane:${P1}`);
            fireEvent.keyDown(panel, { key: 'ArrowUp' });
            expect(selectedID()).toBe(`ws:${W1}`);
        });

        it('…and a keystroke aimed at a ROW, which is where focus lands on a Tab walk', () => {
            const props = baseProps();
            render(<CommandPalette {...props} />);
            const row = screen.getAllByTestId('palette-row')[1] as HTMLElement;

            fireEvent.keyDown(row, { key: 'ArrowDown' });
            expect(selectedID()).toBe(`pane:${P1}`);
            fireEvent.keyDown(row, { key: 'Enter' });
            expect(props.onConfirm).toHaveBeenCalledWith(expect.objectContaining({ id: `pane:${P1}` }));
        });

        it('Escape from the panel dismisses — the one gesture that had no keyboard route', () => {
            const props = baseProps();
            render(<CommandPalette {...props} />);
            fireEvent.keyDown(screen.getByTestId('command-palette'), { key: 'Escape' });
            expect(props.onDismiss).toHaveBeenCalledOnce();
        });

        it('a mousedown on the card chrome keeps the field focused rather than baring it', () => {
            render(<CommandPalette {...baseProps()} />);
            const input = screen.getByLabelText('Jump to workspace or pane');
            expect(document.activeElement).toBe(input);

            const panel = screen.getByTestId('command-palette');
            const event = fireEvent.mouseDown(panel);
            // Default-prevented, so the browser never moves focus off the field in the first place.
            expect(event).toBe(false);
            expect(document.activeElement).toBe(input);
        });

        it('and takes the keyboard back when focus has already left the palette', () => {
            render(<CommandPalette {...baseProps()} />);
            const input = screen.getByLabelText('Jump to workspace or pane') as HTMLInputElement;
            input.blur();
            expect(document.activeElement).toBe(document.body);

            fireEvent.mouseDown(screen.getByTestId('command-palette'));
            expect(document.activeElement).toBe(input);
        });

        it('leaves every other key to the field — typing is not the palette’s business', () => {
            const props = baseProps();
            render(<CommandPalette {...props} />);
            const input = screen.getByLabelText('Jump to workspace or pane');
            fireEvent.change(input, { target: { value: 'no' } });
            expect(props.onQueryChange).toHaveBeenCalledWith('no');
            expect(props.onDismiss).not.toHaveBeenCalled();
        });
    });

    /**
     * UI-FIDELITY M59 — `CommandPaletteView.swift:67-74` scrolls only when the `scrollToSelection`
     * flag an arrow key raised is set, `anchor: .center`, under `withAnimation(.easeOut(0.1))`.
     */
    describe('scroll-to-selection follows the keyboard (M59)', () => {
        function recordScrolls(): { calls: unknown[]; restore: () => void } {
            const original = Element.prototype.scrollIntoView;
            const calls: unknown[] = [];
            Element.prototype.scrollIntoView = function stub(this: Element, options?: unknown): void {
                calls.push(options);
            };
            return {
                calls,
                restore: () => {
                    Element.prototype.scrollIntoView = original;
                }
            };
        }

        it('an arrow move scrolls, centred and animated', () => {
            const scrolls = recordScrolls();
            try {
                render(<CommandPalette {...baseProps()} />);
                scrolls.calls.length = 0;
                fireEvent.keyDown(screen.getByLabelText('Jump to workspace or pane'), { key: 'ArrowDown' });
                expect(scrolls.calls).toEqual([{ block: 'center', behavior: 'smooth' }]);
            } finally {
                scrolls.restore();
            }
        });

        it('a HOVER does not: the row is already under the pointer, and chasing it is the defect', () => {
            const scrolls = recordScrolls();
            try {
                render(<CommandPalette {...baseProps()} />);
                scrolls.calls.length = 0;
                fireEvent.mouseEnter(screen.getAllByTestId('palette-row')[2] as HTMLElement);
                expect(selectedID()).toBe(`pane:${P2}`);
                expect(scrolls.calls).toEqual([]);
            } finally {
                scrolls.restore();
            }
        });

        it('nor does opening the palette', () => {
            const scrolls = recordScrolls();
            try {
                const view = render(<CommandPalette {...baseProps()} open={false} />);
                scrolls.calls.length = 0;
                view.rerender(<CommandPalette {...baseProps()} />);
                expect(scrolls.calls).toEqual([]);
            } finally {
                scrolls.restore();
            }
        });
    });

    it('resets the selection when the query changes', () => {
        const view = render(<CommandPalette {...baseProps()} />);
        fireEvent.keyDown(screen.getByLabelText('Jump to workspace or pane'), { key: 'ArrowDown' });
        expect(selectedID()).toBe(`pane:${P1}`);
        view.rerender(<CommandPalette {...baseProps()} query="n" />);
        expect(selectedID()).toBe(`ws:${W1}`);
    });
});

describe('confirm and dismiss', () => {
    it('Enter confirms the selected item', () => {
        const props = baseProps();
        render(<CommandPalette {...props} />);
        fireEvent.keyDown(screen.getByLabelText('Jump to workspace or pane'), { key: 'ArrowDown' });
        fireEvent.keyDown(screen.getByLabelText('Jump to workspace or pane'), { key: 'Enter' });
        expect(props.onConfirm).toHaveBeenCalledWith(expect.objectContaining({ id: `pane:${P1}` }));
    });

    it('clicking a row confirms it and runs a command item', () => {
        const props = baseProps();
        const run = vi.fn();
        const command: PaletteItem = {
            id: 'cmd:split',
            kind: 'command',
            icon: 'bolt',
            title: 'Split Right',
            subtitle: '⌘D',
            workspaceID: null,
            workspaceName: '',
            paneID: null,
            workspaceColor: null,
            run
        };
        render(<CommandPalette {...props} items={[...ITEMS, command]} query="split" />);
        fireEvent.click(screen.getByTestId('palette-row'));
        expect(run).toHaveBeenCalledOnce();
        expect(props.onConfirm).toHaveBeenCalledWith(expect.objectContaining({ id: 'cmd:split' }));
    });

    it('Escape and a backdrop click dismiss', () => {
        const props = baseProps();
        const view = render(<CommandPalette {...props} />);
        fireEvent.keyDown(screen.getByLabelText('Jump to workspace or pane'), { key: 'Escape' });
        expect(props.onDismiss).toHaveBeenCalledOnce();

        view.rerender(<CommandPalette {...props} />);
        fireEvent.mouseDown(screen.getByTestId('palette-backdrop'));
        expect(props.onDismiss).toHaveBeenCalledTimes(2);
    });

    it('confirming with zero matches still closes and hands focus back (§10.3)', () => {
        const props = baseProps();
        const onFocusHandoff = vi.fn();
        vi.useFakeTimers();
        try {
            render(<CommandPalette {...props} query="zzz" onFocusHandoff={onFocusHandoff} fallbackPaneID={P1} />);
            fireEvent.keyDown(screen.getByLabelText('Jump to workspace or pane'), { key: 'Enter' });
            expect(props.onConfirm).not.toHaveBeenCalled();
            expect(props.onDismiss).toHaveBeenCalledOnce();
            act(() => {
                vi.advanceTimersByTime(FOCUS_HANDOFF_MS);
            });
            expect(onFocusHandoff).toHaveBeenCalledWith(P1);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('the 200ms focus handoff (§10.4)', () => {
    it('fires only after the fade-out window, with the confirmed pane', () => {
        vi.useFakeTimers();
        try {
            const props = baseProps();
            const onFocusHandoff = vi.fn();
            render(<CommandPalette {...props} onFocusHandoff={onFocusHandoff} fallbackPaneID={P1} />);

            fireEvent.mouseEnter(screen.getAllByTestId('palette-row')[2] as HTMLElement);
            fireEvent.keyDown(screen.getByLabelText('Jump to workspace or pane'), { key: 'Enter' });

            act(() => {
                vi.advanceTimersByTime(FOCUS_HANDOFF_MS - 1);
            });
            expect(onFocusHandoff).not.toHaveBeenCalled();

            act(() => {
                vi.advanceTimersByTime(1);
            });
            expect(onFocusHandoff).toHaveBeenCalledWith(P2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('a workspace item hands off to the destination workspace’s focused pane', () => {
        vi.useFakeTimers();
        try {
            const onFocusHandoff = vi.fn();
            render(<CommandPalette {...baseProps()} onFocusHandoff={onFocusHandoff} fallbackPaneID={P1} />);
            fireEvent.keyDown(screen.getByLabelText('Jump to workspace or pane'), { key: 'Enter' });
            act(() => {
                vi.advanceTimersByTime(FOCUS_HANDOFF_MS);
            });
            expect(onFocusHandoff).toHaveBeenCalledWith(P1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('re-opening the palette cancels a pending handoff outright', () => {
        vi.useFakeTimers();
        try {
            const props = baseProps();
            const onFocusHandoff = vi.fn();
            const view = render(
                <CommandPalette {...props} onFocusHandoff={onFocusHandoff} fallbackPaneID={P1} />
            );
            fireEvent.keyDown(screen.getByLabelText('Jump to workspace or pane'), { key: 'Escape' });

            // Closed, then re-opened within the 200ms window.
            view.rerender(<CommandPalette {...props} open={false} onFocusHandoff={onFocusHandoff} />);
            act(() => {
                vi.advanceTimersByTime(50);
            });
            view.rerender(<CommandPalette {...props} open onFocusHandoff={onFocusHandoff} />);
            act(() => {
                vi.advanceTimersByTime(FOCUS_HANDOFF_MS * 2);
            });
            expect(onFocusHandoff).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('only one handoff can be pending: a newer interaction supersedes it', () => {
        vi.useFakeTimers();
        try {
            const props = baseProps();
            const onFocusHandoff = vi.fn();
            render(<CommandPalette {...props} onFocusHandoff={onFocusHandoff} fallbackPaneID={P1} />);
            const input = screen.getByLabelText('Jump to workspace or pane');

            fireEvent.keyDown(input, { key: 'Escape' });
            act(() => {
                vi.advanceTimersByTime(100);
            });
            fireEvent.mouseEnter(screen.getAllByTestId('palette-row')[2] as HTMLElement);
            fireEvent.keyDown(input, { key: 'Enter' });
            act(() => {
                vi.advanceTimersByTime(FOCUS_HANDOFF_MS);
            });

            expect(onFocusHandoff).toHaveBeenCalledOnce();
            expect(onFocusHandoff).toHaveBeenCalledWith(P2);
        } finally {
            vi.useRealTimers();
        }
    });
});
