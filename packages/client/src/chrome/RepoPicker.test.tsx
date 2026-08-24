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

/**
 * The MEDIUM fidelity row on this sheet — M48 (row type and marks), M49 (the focused/unfocused
 * selection fill) and M50 (the picker's own headline and its fixed height).
 *
 * All three are claims about `RepoPickerView.swift`'s own metrics, so each case names the lines
 * it is measuring against.
 */
describe('the shipped picker’s presentation', () => {
    /** M50: `Text(mode == .multiple ? "Add Repositories" : "Add Repository").font(.headline)`. */
    it('M50 — owns its headline, in the Swift’s own two words', () => {
        view({ mode: 'single' });
        expect(screen.getByTestId('repo-picker-title').textContent).toBe('Add Repository');
        cleanup();
        view({ mode: 'multiple' });
        expect(screen.getByTestId('repo-picker-title').textContent).toBe('Add Repositories');
    });

    /** …except embedded, where the host sheet's own title is the title. */
    it('M50 — stays headline-less when a host embeds it under its own title', () => {
        view({ mode: 'multiple', hideFooter: true });
        expect(screen.queryByTestId('repo-picker-title')).toBeNull();
    });

    /**
     * M50: `.frame(width: 360, height: 340)` — a FIXED box, so the sheet around it does not
     * resize while the filter narrows. The port's `max-h` list shrank to its content.
     */
    it('M50 — keeps one list height while the filter narrows, and when it matches nothing', () => {
        view({ mode: 'multiple' });
        const list = screen.getByTestId('repo-picker-list');
        expect(list.className).not.toContain('max-h-');
        expect(list.style.height).toBe('220px');

        fireEvent.change(screen.getByTestId('repo-picker-search'), { target: { value: 'app' } });
        expect(screen.getByTestId('repo-picker-list').style.height).toBe('220px');

        fireEvent.change(screen.getByTestId('repo-picker-search'), { target: { value: 'zzz' } });
        expect(screen.getByTestId('repo-picker-empty').style.height).toBe('220px');
    });

    /** M48: `Text(repo.name).font(.system(size: 13, weight: .medium))` over an 11 pt path. */
    it('M48 — sets the row’s two lines at 13 pt medium over 11 pt', () => {
        view({ mode: 'multiple' });
        const name = within(row('r1')).getByText('app');
        expect(name.className).toContain('text-[13px]');
        expect(name.className).toContain('font-medium');
        const path = within(row('r1')).getByText('/src/app');
        expect(path.className).toContain('text-[11px]');
    });

    /** M48: `.truncationMode(.middle)` — the informative TAIL of a long path survives. */
    it('M48 — middle-truncates a long path and keeps the whole one on the row', () => {
        const long = `/Users/ben/code/${'deeply-nested-'.repeat(6)}repo`;
        cleanup();
        render(
            <RepoPicker
                repos={[{ id: 'long', name: 'deep', path: long }]}
                onConfirm={vi.fn()}
                onCancel={vi.fn()}
            />
        );
        const shown = row('long').querySelectorAll('span > span')[1]?.textContent ?? '';
        expect(shown).toContain('…');
        expect(shown.length).toBeLessThan(long.length);
        // The tail is what middle truncation exists to keep.
        expect(shown.endsWith('repo')).toBe(true);
        expect(row('long').getAttribute('title')).toBe(long);
    });

    /**
     * M48: `Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")` — a filled check,
     * not the `◉`/`○` typographic marks the port drew at 11 px.
     */
    it('M48 — marks a multi-select row with a filled check, not a bullet character', () => {
        view({ mode: 'multiple' });
        const mark = screen.getByTestId('repo-check-r1');
        expect(mark.textContent).toBe('');
        expect(mark.dataset['checked']).toBe('false');
        expect(mark.querySelector('svg circle')?.getAttribute('fill')).toBe('none');
        expect(mark.querySelector('svg path')).toBeNull();

        fireEvent.click(row('r1'));
        const checked = screen.getByTestId('repo-check-r1');
        expect(checked.dataset['checked']).toBe('true');
        expect(checked.querySelector('svg circle')?.getAttribute('fill')).toBe('currentColor');
        expect(checked.querySelector('svg path')).not.toBeNull();
    });

    /** M48: the keyboard anchor's ring is `Color.accentColor.opacity(0.5)`, not a divider rule. */
    it('M48 — rings the keyboard anchor in the accent', () => {
        view({ mode: 'multiple' });
        const list = screen.getByTestId('repo-picker-list');
        fireEvent.focus(list);
        fireEvent.keyDown(list, { key: 'ArrowDown' });
        const anchor = [...screen.getAllByRole('option')].find(
            (node) => (node as HTMLElement).dataset['anchor'] === 'true'
        ) as HTMLElement;
        expect(anchor.style.outline).toContain('--nex-accent');
        expect(anchor.style.outline).not.toContain('--nex-border');
    });

    /**
     * M49: `rowBackground` (`RepoPickerView.swift:193-201`) dims a SELECTED row from accent@0.4
     * to accent@0.25 the moment keyboard focus leaves the list — which is what tells you Return
     * will not act on it. The port painted one neutral fill in both states.
     */
    it('M49 — dims the selection when the list loses keyboard focus', () => {
        view({ mode: 'multiple' });
        const list = screen.getByTestId('repo-picker-list');
        fireEvent.focus(list);
        fireEvent.click(row('r1'));
        const focused = row('r1').style.background;
        expect(focused).toContain('--nex-accent');
        expect(focused).toContain('40%');

        fireEvent.blur(list);
        const blurred = row('r1').style.background;
        expect(blurred).toContain('--nex-accent');
        expect(blurred).toContain('25%');
        expect(blurred).not.toBe(focused);
        // Still selected — only its tone moved.
        expect(row('r1').dataset['selected']).toBe('true');
    });

    /**
     * L87: `withAnimation(.linear(duration: 0.1)) { proxy.scrollTo(newID, anchor: .center) }`
     * (`RepoPickerView.swift:323-326`). The port scrolled `{ block: 'nearest' }` — the minimum
     * amount, unanimated — so walking the list with ↓ pinned the cursor to the bottom edge with
     * nothing visible ahead of it. jsdom has no `scrollIntoView`, so the call itself is the
     * assertion; `behavior: 'smooth'` is the ledgered stand-in for the 100 ms linear (M59's, in
     * `CommandPalette.tsx`), since CSS owns the duration.
     */
    it('L87 — centres the anchored row on an arrow move, animated', () => {
        view({ mode: 'multiple' });
        const list = screen.getByTestId('repo-picker-list');
        const calls: unknown[] = [];
        for (const id of ['r1', 'r2', 'r3']) {
            (row(id) as unknown as { scrollIntoView: (options?: unknown) => void }).scrollIntoView = (
                options
            ) => {
                calls.push(options);
            };
        }
        fireEvent.focus(list);
        fireEvent.keyDown(list, { key: 'ArrowDown' });
        expect(calls).toEqual([{ block: 'center', behavior: 'smooth' }]);
    });
});
