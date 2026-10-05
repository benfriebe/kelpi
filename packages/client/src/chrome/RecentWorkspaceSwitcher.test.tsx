import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { modalPresenceCount } from './modal-presence';
import { RecentWorkspaceSwitcher } from './RecentWorkspaceSwitcher';

afterEach(cleanup);

const rows = [
    { id: 'a', name: 'kelpi', color: null },
    { id: 'b', name: 'OrderingPlatform', color: 'blue' as const },
    { id: 'c', name: 'scratch', color: null }
];

describe('RecentWorkspaceSwitcher', () => {
    it('lists every row in order and marks the highlighted one', () => {
        render(<RecentWorkspaceSwitcher rows={rows} index={1} onPick={() => {}} />);
        const rendered = screen.getAllByTestId('recent-switcher-row');
        expect(rendered.map((row) => row.textContent)).toEqual(['kelpi', 'OrderingPlatform', 'scratch']);
        expect(rendered.map((row) => row.getAttribute('data-selected'))).toEqual(['false', 'true', 'false']);
    });

    it('picks a clicked row', () => {
        const onPick = vi.fn();
        render(<RecentWorkspaceSwitcher rows={rows} index={1} onPick={onPick} />);
        fireEvent.click(screen.getAllByTestId('recent-switcher-row')[2]!);
        expect(onPick).toHaveBeenCalledWith('c');
    });

    it('counts as a modal while mounted, so a live web page is parked', () => {
        const before = modalPresenceCount();
        const { unmount } = render(<RecentWorkspaceSwitcher rows={rows} index={1} onPick={() => {}} />);
        expect(modalPresenceCount()).toBe(before + 1);
        unmount();
        expect(modalPresenceCount()).toBe(before);
    });

    it('takes keyboard focus so the release reaches the window', () => {
        render(<RecentWorkspaceSwitcher rows={rows} index={1} onPick={() => {}} />);
        expect(document.activeElement).toBe(screen.getByTestId('recent-switcher'));
    });
});
