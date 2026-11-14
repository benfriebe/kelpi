import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TabCloseGate, tabCloseWarning } from './TabCloseGate';

afterEach(() => {
    cleanup();
});

const agents = { running: 2, waiting: 0, inactive: 0, total: 2 };

describe('the close-tab gate', () => {
    it('names the tab and what closing it ends', () => {
        render(<TabCloseGate subject="“build”" tabCount={1} agents={agents} onCancel={vi.fn()} onConfirm={vi.fn()} onSuppress={vi.fn()} />);
        expect(screen.getByTestId('tab-close-gate').textContent).toContain('Close “build”?');
        expect(tabCloseWarning(agents, 1)).toBe('This tab has 2 running agents. Closing it will close all 2.');
        expect(tabCloseWarning({ running: 0, waiting: 1, inactive: 0, total: 1 }, 3)).toBe(
            'These tabs have 1 agent waiting for input. Closing them will close it.'
        );
    });

    it('takes Cancel on Return and Escape, so a stray key never closes agents', () => {
        const onCancel = vi.fn();
        const onConfirm = vi.fn();
        render(<TabCloseGate subject="“build”" tabCount={1} agents={agents} onCancel={onCancel} onConfirm={onConfirm} onSuppress={vi.fn()} />);
        fireEvent.keyDown(window, { key: 'Enter' });
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onCancel).toHaveBeenCalledTimes(2);
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it('closes on Close, and keeps "Don\'t ask again" whichever button is clicked', () => {
        const onSuppress = vi.fn();
        const onConfirm = vi.fn();
        const onCancel = vi.fn();
        const view = render(
            <TabCloseGate subject="“build”" tabCount={1} agents={agents} onCancel={onCancel} onConfirm={onConfirm} onSuppress={onSuppress} />
        );
        fireEvent.click(screen.getByTestId('tab-close-suppress'));
        fireEvent.click(screen.getByTestId('tab-close-cancel'));
        expect(onSuppress).toHaveBeenCalledTimes(1);
        expect(onCancel).toHaveBeenCalledTimes(1);
        view.unmount();
        render(<TabCloseGate subject="“build”" tabCount={1} agents={agents} onCancel={vi.fn()} onConfirm={onConfirm} onSuppress={onSuppress} />);
        fireEvent.click(screen.getByTestId('tab-close-confirm'));
        expect(onConfirm).toHaveBeenCalledTimes(1);
        expect(onSuppress).toHaveBeenCalledTimes(1);
    });
});
