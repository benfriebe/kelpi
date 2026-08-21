/**
 * Settings ▸ Web — the favourites manager (WEB-046, SET-097…SET-100).
 *
 * The three contracts the Swift list has, driven through the real component:
 *
 *   - **rename commits on Return or focus loss**, trimmed, and only when the value actually
 *     changed (a re-render per keystroke must not fire a verb per keystroke);
 *   - **reorder is a move, not a swap** — and the Swift gesture is a DRAG, which is why the
 *     rows are `draggable` and carry the `dragstart`/`dragover`/`drop` handlers this file
 *     exercises directly. The audit cannot start a native drag session (`Input.dispatchMouseEvent`
 *     has no HTML5 DnD), so the drop path is pinned here and the ↑/↓ buttons — the keyboard
 *     equivalent the Swift list does not have — carry the live evidence;
 *   - the **empty state points at the URL-bar star**, because a favourite cannot be created here.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { WebFavourite } from '../webpane';
import { WebTab, type WebTabActions } from './WebTab';

interface Recorded {
    readonly renamed: { id: string; title: string }[];
    readonly removed: string[];
    readonly moved: { from: number; to: number }[];
}

function favourite(id: string, title: string, url: string): WebFavourite {
    return { id, url, title, created_at: '2026-08-21T00:00:00Z', label: title === '' ? url : title };
}

const LIST: readonly WebFavourite[] = [
    favourite('f1', 'Alpha', 'https://alpha.test/'),
    favourite('f2', 'Beta', 'https://beta.test/'),
    favourite('f3', 'Gamma', 'https://gamma.test/')
];

function setup(favourites: readonly WebFavourite[] = LIST): Recorded {
    const log: Recorded = { renamed: [], removed: [], moved: [] };
    const actions: WebTabActions = {
        renameFavourite: (id, title) => log.renamed.push({ id, title }),
        removeFavourite: (id) => log.removed.push(id),
        moveFavourite: (from, to) => log.moved.push({ from, to })
    };
    render(<WebTab favourites={favourites} actions={actions} />);
    return log;
}

/**
 * One HTML5 drag, as the DOM sees it.
 *
 * React listens for the real `dragstart` / `dragover` / `drop` events, so dispatching them is
 * the same code path a mouse-driven drag takes — the part a synthetic pointer stream cannot
 * reach, because Chromium starts a native DnD session that CDP input does not drive.
 */
function drag(fromID: string, toID: string): void {
    const from = screen.getByTestId(`settings-favourite-${fromID}`);
    const to = screen.getByTestId(`settings-favourite-${toID}`);
    fireEvent.dragStart(from);
    fireEvent.dragOver(to);
    fireEvent.drop(to);
}

afterEach(cleanup);

describe('favourites reorder (WEB-046)', () => {
    it('every row is draggable, which is the Swift gesture', () => {
        setup();
        for (const entry of LIST) {
            expect(screen.getByTestId(`settings-favourite-${entry.id}`).getAttribute('draggable')).toBe(
                'true'
            );
        }
    });

    it('dragging a row onto another MOVES it there — not a swap', () => {
        const log = setup();
        drag('f1', 'f3');
        expect(log.moved).toEqual([{ from: 0, to: 2 }]);
    });

    it('dragging a row onto itself is not a reorder', () => {
        const log = setup();
        drag('f2', 'f2');
        expect(log.moved).toEqual([]);
    });

    it('a drop with no drag in flight does nothing', () => {
        const log = setup();
        fireEvent.drop(screen.getByTestId('settings-favourite-f2'));
        expect(log.moved).toEqual([]);
    });

    it('the ↑/↓ buttons are the keyboard equivalent, and clamp at the ends', () => {
        const log = setup();
        expect(screen.getByTestId('settings-favourite-up-f1').hasAttribute('disabled')).toBe(true);
        expect(screen.getByTestId('settings-favourite-down-f3').hasAttribute('disabled')).toBe(true);
        fireEvent.click(screen.getByTestId('settings-favourite-down-f1'));
        fireEvent.click(screen.getByTestId('settings-favourite-up-f3'));
        expect(log.moved).toEqual([
            { from: 0, to: 1 },
            { from: 2, to: 1 }
        ]);
    });
});

describe('favourites rename (SET-099)', () => {
    it('commits a changed title on Return, trimmed', () => {
        const log = setup();
        const field = screen.getByTestId('settings-favourite-title-f1');
        fireEvent.focus(field);
        fireEvent.change(field, { target: { value: '  Alpha renamed  ' } });
        fireEvent.keyDown(field, { key: 'Enter' });
        expect(log.renamed).toEqual([{ id: 'f1', title: 'Alpha renamed' }]);
    });

    it('commits on focus loss too', () => {
        const log = setup();
        const field = screen.getByTestId('settings-favourite-title-f2');
        fireEvent.focus(field);
        fireEvent.change(field, { target: { value: 'Beta II' } });
        fireEvent.blur(field);
        expect(log.renamed).toEqual([{ id: 'f2', title: 'Beta II' }]);
    });

    it('does not fire when the value never changed', () => {
        const log = setup();
        const field = screen.getByTestId('settings-favourite-title-f3');
        fireEvent.focus(field);
        fireEvent.change(field, { target: { value: 'Gamma' } });
        fireEvent.keyDown(field, { key: 'Enter' });
        fireEvent.blur(field);
        expect(log.renamed).toEqual([]);
    });

    it('Escape abandons the draft without committing', () => {
        const log = setup();
        const field = screen.getByTestId('settings-favourite-title-f1');
        fireEvent.focus(field);
        fireEvent.change(field, { target: { value: 'discard me' } });
        fireEvent.keyDown(field, { key: 'Escape' });
        expect(log.renamed).toEqual([]);
        expect((field as HTMLInputElement).value).toBe('Alpha');
    });
});

describe('the empty state', () => {
    it('points at the URL-bar star, because nothing here can create a favourite', () => {
        setup([]);
        const empty = screen.getByTestId('settings-favourites-empty');
        expect(empty.textContent).toContain('star');
        expect(screen.queryByTestId('settings-favourites-list')).toBeNull();
    });
});
