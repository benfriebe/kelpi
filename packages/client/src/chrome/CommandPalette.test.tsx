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
        subtitle: '',
        workspaceID: W1,
        workspaceName: 'nex-client',
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
        workspaceName: 'nex-client',
        paneID: P2,
        workspaceColor: 'blue'
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

    it('sections the matches and selects the first row', () => {
        render(<CommandPalette {...baseProps()} />);
        expect(screen.getByText('Workspaces')).toBeDefined();
        expect(screen.getByText('Panes')).toBeDefined();
        expect(screen.getAllByTestId('palette-row')).toHaveLength(3);
        expect(selectedID()).toBe(`ws:${W1}`);
    });

    it('applies the substring rule, including the p: scope', () => {
        render(<CommandPalette {...baseProps()} query="p:notes" />);
        expect(screen.getAllByTestId('palette-row').map((row) => row.dataset['itemId'])).toEqual([
            `pane:${P2}`
        ]);
        expect(screen.queryByText('Workspaces')).toBeNull();
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
