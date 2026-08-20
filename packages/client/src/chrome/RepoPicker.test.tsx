/**
 * The repo picker (§GIT-073), against `RepoPickerView.swift`'s rules.
 *
 * The whole point of the sheet is that selection is decoupled from confirmation, so every case
 * here is "build a selection, then confirm it": click semantics per mode, shift-click ranges,
 * the roving keyboard anchor, the search filter's clamping, and the "Added" rows that are
 * listed but cannot be chosen.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RepoPicker, type RepoPickerEntry } from './index';

afterEach(cleanup);

const REPOS: RepoPickerEntry[] = [
    { id: 'r1', name: 'app', path: '/src/app' },
    { id: 'r2', name: 'infra', path: '/src/infra' },
    { id: 'r3', name: 'docs', path: '/src/docs' },
    { id: 'r4', name: 'tools', path: '/other/tools' }
];

function view(props: Partial<React.ComponentProps<typeof RepoPicker>> = {}) {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<RepoPicker repos={REPOS} onConfirm={onConfirm} onCancel={onCancel} {...props} />);
    return { onConfirm, onCancel };
}

function row(id: string): HTMLElement {
    return screen.getByTestId(`repo-choice-${id}`);
}

function chosenIDs(mock: ReturnType<typeof vi.fn>): string[] {
    const first = mock.mock.calls[0]?.[0] as readonly RepoPickerEntry[] | undefined;
    return (first ?? []).map((repo) => repo.id);
}

describe('single mode', () => {
    it('replaces the selection on each click and confirms the one row', () => {
        const { onConfirm } = view({ mode: 'single' });
        fireEvent.click(row('r2'));
        fireEvent.click(row('r3'));
        expect(row('r2').dataset['selected']).toBe('false');
        fireEvent.click(screen.getByTestId('repo-picker-choose'));
        expect(chosenIDs(onConfirm)).toEqual(['r3']);
    });

    it('keeps Choose out of reach until something is selected', () => {
        view({ mode: 'single' });
        expect((screen.getByTestId('repo-picker-choose') as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(row('r1'));
        expect((screen.getByTestId('repo-picker-choose') as HTMLButtonElement).disabled).toBe(false);
    });

    it('lets the selection follow the keyboard anchor, and Return confirms it', () => {
        const { onConfirm } = view({ mode: 'single' });
        const list = screen.getByTestId('repo-picker-list');
        fireEvent.focus(list);
        fireEvent.keyDown(list, { key: 'ArrowDown' });
        fireEvent.keyDown(list, { key: 'ArrowDown' });
        fireEvent.keyDown(list, { key: 'Enter' });
        expect(chosenIDs(onConfirm)).toEqual(['r3']);
    });
});

describe('multiple mode', () => {
    it('toggles rows independently and reports the count', () => {
        const { onConfirm } = view({ mode: 'multiple' });
        fireEvent.click(row('r1'));
        fireEvent.click(row('r3'));
        expect(screen.getByTestId('repo-picker-count').textContent).toBe('2 selected');
        // A second click on the same row takes it back out (checkbox semantics).
        fireEvent.click(row('r1'));
        expect(screen.getByTestId('repo-picker-count').textContent).toBe('1 selected');
        fireEvent.click(screen.getByTestId('repo-picker-choose'));
        expect(chosenIDs(onConfirm)).toEqual(['r3']);
    });

    it('shift-click adds the anchor→row range WITHOUT dropping the earlier selection', () => {
        const { onConfirm } = view({ mode: 'multiple' });
        fireEvent.click(row('r4'));
        fireEvent.click(row('r1'));
        fireEvent.click(row('r3'), { shiftKey: true });
        fireEvent.click(screen.getByTestId('repo-picker-choose'));
        // r4 survived the range; r1…r3 came in as a block, in list order.
        expect(chosenIDs(onConfirm)).toEqual(['r1', 'r2', 'r3', 'r4']);
    });

    it('moves the anchor with the arrows, toggles with Space and extends with shift-arrows', () => {
        const { onConfirm } = view({ mode: 'multiple' });
        const list = screen.getByTestId('repo-picker-list');
        fireEvent.focus(list);
        // A plain arrow moves the cursor only — nothing is selected yet.
        fireEvent.keyDown(list, { key: 'ArrowDown' });
        expect(screen.getByTestId('repo-picker-count').textContent).toBe('');
        fireEvent.keyDown(list, { key: ' ' });
        expect(row('r2').dataset['selected']).toBe('true');
        fireEvent.keyDown(list, { key: 'ArrowDown', shiftKey: true });
        fireEvent.keyDown(list, { key: 'Enter' });
        expect(chosenIDs(onConfirm)).toEqual(['r2', 'r3']);
    });

    it('double-click selects only that row and confirms immediately', () => {
        const { onConfirm } = view({ mode: 'multiple' });
        fireEvent.click(row('r1'));
        fireEvent.doubleClick(row('r4'));
        expect(chosenIDs(onConfirm)).toEqual(['r4']);
    });
});

describe('already-associated rows', () => {
    it('lists them dimmed as "Added" and refuses to select them', () => {
        const { onConfirm } = view({ mode: 'multiple', disabledRepoIDs: new Set(['r2']) });
        const added = row('r2');
        expect(added.dataset['added']).toBe('true');
        expect(within(added).getByText('Added')).toBeTruthy();
        fireEvent.click(added);
        expect(added.dataset['selected']).toBe('false');
        expect((screen.getByTestId('repo-picker-choose') as HTMLButtonElement).disabled).toBe(true);

        // A range that crosses an Added row skips it rather than smuggling it in.
        fireEvent.click(row('r1'));
        fireEvent.click(row('r3'), { shiftKey: true });
        fireEvent.click(screen.getByTestId('repo-picker-choose'));
        expect(chosenIDs(onConfirm)).toEqual(['r1', 'r3']);
    });
});

describe('the search filter', () => {
    it('narrows the list and clamps a selection that scrolled out of it', () => {
        const { onConfirm } = view({ mode: 'multiple' });
        fireEvent.click(row('r4'));
        fireEvent.change(screen.getByTestId('repo-picker-search'), { target: { value: 'src' } });
        // /other/tools is gone, and so is its selection.
        expect(screen.queryByTestId('repo-choice-r4')).toBeNull();
        expect(screen.getByTestId('repo-picker-count').textContent).toBe('');

        fireEvent.change(screen.getByTestId('repo-picker-search'), { target: { value: 'inf' } });
        expect(screen.getAllByRole('option')).toHaveLength(1);
        fireEvent.click(row('r2'));
        fireEvent.click(screen.getByTestId('repo-picker-choose'));
        expect(chosenIDs(onConfirm)).toEqual(['r2']);
    });

    it('says so plainly when nothing matches', () => {
        view();
        fireEvent.change(screen.getByTestId('repo-picker-search'), { target: { value: 'zzz' } });
        expect(screen.getByTestId('repo-picker-empty').textContent).toContain('No matching repositories');
    });
});

describe('the Tab loop (§GIT-073)', () => {
    it('cycles search → list → Cancel → Confirm, skipping a disabled Confirm', () => {
        view({ mode: 'multiple' });
        const search = screen.getByTestId('repo-picker-search');
        const list = screen.getByTestId('repo-picker-list');
        const cancel = screen.getByTestId('repo-picker-cancel');

        search.focus();
        fireEvent.keyDown(search, { key: 'Tab' });
        expect(document.activeElement).toBe(list);
        fireEvent.keyDown(list, { key: 'Tab' });
        expect(document.activeElement).toBe(cancel);
        // Confirm is disabled with nothing selected, so the loop wraps past it.
        fireEvent.keyDown(cancel, { key: 'Tab' });
        expect(document.activeElement).toBe(search);

        // Select something and Confirm joins the loop.
        fireEvent.click(row('r1'));
        cancel.focus();
        fireEvent.keyDown(cancel, { key: 'Tab' });
        expect(document.activeElement).toBe(screen.getByTestId('repo-picker-choose'));
    });
});

describe('the scan row (§GIT-066)', () => {
    it('is absent unless a scan is wired, and hands the daemon the typed folder', () => {
        const onScan = vi.fn();
        view({});
        expect(screen.queryByTestId('repo-picker-scan')).toBeNull();
        cleanup();

        view({ onScan });
        fireEvent.change(screen.getByTestId('repo-picker-scan-path'), { target: { value: '/src ' } });
        fireEvent.click(screen.getByTestId('repo-picker-scan'));
        expect(onScan).toHaveBeenCalledWith('/src');
    });
});
