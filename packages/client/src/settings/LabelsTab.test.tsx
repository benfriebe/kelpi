import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChromeLabelPreset } from '../chrome';
import { LabelsTab } from './LabelsTab';
import type { LabelledWorkspace } from './model';
import type { SettingsActions } from './types';

interface Recorded {
    readonly added: { name: string; color: string; textColor?: string | null | undefined }[];
    readonly updated: {
        id: string;
        name?: string | undefined;
        color?: string | undefined;
        textColor?: string | null | undefined;
    }[];
    readonly removed: string[];
    readonly moved: { id: string; index: number }[];
}

function actions(): SettingsActions & { readonly log: Recorded } {
    const log: Recorded = { added: [], updated: [], removed: [], moved: [] };
    return {
        log,
        setKeybinding: vi.fn(),
        resetKeybindings: vi.fn(),
        setGeneralSetting: vi.fn(),
        setGhosttySetting: vi.fn(),
        setProfiles: vi.fn(),
        addLabelPreset: (input) => log.added.push(input),
        updateLabelPreset: (input) => log.updated.push(input),
        removeLabelPreset: (id) => log.removed.push(id),
        moveLabelPreset: (input) => log.moved.push(input)
    };
}

const PRESETS: readonly ChromeLabelPreset[] = [
    { name: 'ship', color: { kind: 'named', color: 'gray' }, textColor: null },
    { name: 'wip', color: { kind: 'named', color: 'blue' }, textColor: null }
];

function setup(workspaces: readonly LabelledWorkspace[] = [], presets = PRESETS) {
    const bound = actions();
    render(<LabelsTab presets={presets} workspaces={workspaces} actions={bound} bucket="dark" />);
    return bound;
}

afterEach(cleanup);

describe('the label preset list', () => {
    it('lists presets with their color and how many workspaces wear them', () => {
        setup([{ labels: ['ship'] }, { labels: ['ship'] }]);
        expect(screen.getByTestId('label-chip-ship').dataset['color']).toBe('gray');
        expect(screen.getByTestId('label-preset-ship').textContent).toContain('2 workspaces');
        expect(screen.getByTestId('label-preset-wip').textContent).toContain('unused');
    });

    it('shows an empty state rather than a bare list', () => {
        setup([], []);
        expect(screen.getByTestId('labels-empty')).toBeDefined();
    });

    it('recolors through the palette, and no-ops on the current color', () => {
        const bound = setup();
        fireEvent.click(screen.getByTestId('label-color-ship-purple'));
        expect(bound.log.updated).toEqual([{ id: 'ship', color: 'purple' }]);
        fireEvent.click(screen.getByTestId('label-color-wip-blue'));
        expect(bound.log.updated).toHaveLength(1);
    });

    it('creates a preset in gray, the same default the CLI back-fill uses', () => {
        const bound = setup();
        fireEvent.change(screen.getByTestId('label-new-name'), { target: { value: '  release  ' } });
        fireEvent.click(screen.getByTestId('label-add'));
        expect(bound.log.added).toEqual([{ name: 'release', color: 'gray' }]);
        expect((screen.getByTestId('label-new-name') as HTMLInputElement).value).toBe('');
    });

    it('renames on Enter, and ignores an unchanged or empty name', () => {
        const bound = setup();
        fireEvent.click(screen.getByTestId('label-rename-ship'));
        const field = screen.getByTestId('label-rename-field-ship');
        fireEvent.change(field, { target: { value: 'shipped' } });
        fireEvent.keyDown(field, { key: 'Enter' });
        expect(bound.log.updated).toEqual([{ id: 'ship', name: 'shipped' }]);

        fireEvent.click(screen.getByTestId('label-rename-ship'));
        fireEvent.keyDown(screen.getByTestId('label-rename-field-ship'), { key: 'Enter' });
        expect(bound.log.updated).toHaveLength(1);
    });
});

describe('designing a preset (SET-058, SET-061, SET-062)', () => {
    it('previews the draft chip live, placeholder first, then the typed name', () => {
        setup();
        const preview = screen.getByTestId('label-new-preview');
        expect(preview.textContent).toBe('label');
        expect(preview.dataset['placeholder']).toBe('true');
        fireEvent.change(screen.getByTestId('label-new-name'), { target: { value: 'release' } });
        expect(screen.getByTestId('label-new-preview').textContent).toBe('release');
        expect(screen.getByTestId('label-new-preview').dataset['placeholder']).toBe('false');
    });

    it('carries the chosen background AND text colour into the add', () => {
        const bound = setup();
        fireEvent.click(screen.getByTestId('label-new-color-purple'));
        fireEvent.click(screen.getByTestId('label-new-text-white'));
        fireEvent.change(screen.getByTestId('label-new-name'), { target: { value: 'release' } });
        // The preview is painted with exactly what will be written.
        const preview = screen.getByTestId('label-new-preview');
        expect(preview.style.color).toBe('rgb(255, 255, 255)');
        fireEvent.click(screen.getByTestId('label-add'));
        expect(bound.log.added).toEqual([{ name: 'release', color: 'purple', textColor: '#ffffff' }]);
    });

    it('takes a custom hex from the colour well', () => {
        const bound = setup();
        fireEvent.change(screen.getByTestId('label-color-ship-custom'), { target: { value: '#ff8800' } });
        expect(bound.log.updated).toEqual([{ id: 'ship', color: '#ff8800' }]);
    });

    it('sends null for Auto, so the daemon re-derives black/white by luminance', () => {
        const bound = setup();
        fireEvent.click(screen.getByTestId('label-text-ship-black'));
        fireEvent.click(screen.getByTestId('label-text-ship-auto'));
        expect(bound.log.updated).toEqual([
            { id: 'ship', textColor: '#000000' },
            { id: 'ship', textColor: null }
        ]);
    });

    it('shows the resolved text colour on the Aa sample: white on a dark chip, black on a light one', () => {
        setup([], [
            { name: 'dark', color: { kind: 'custom', hex: '#101014' }, textColor: null },
            { name: 'light', color: { kind: 'custom', hex: '#f4e7a1' }, textColor: null }
        ]);
        expect(screen.getByTestId('label-text-dark-sample').dataset['color']?.toLowerCase()).toBe('#ffffff');
        expect(screen.getByTestId('label-text-light-sample').dataset['color']?.toLowerCase()).toBe('#000000');
    });

    it('reorders with the ↑/↓ buttons, disabled at the ends (SET-065)', () => {
        const bound = setup();
        expect((screen.getByTestId('label-move-up-ship') as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByTestId('label-move-down-wip') as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(screen.getByTestId('label-move-down-ship'));
        expect(bound.log.moved).toEqual([{ id: 'ship', index: 1 }]);
    });
});

describe('renaming a preset (SET-063)', () => {
    it('commits on focus loss, not only on Return', () => {
        const bound = setup();
        fireEvent.click(screen.getByTestId('label-rename-ship'));
        const field = screen.getByTestId('label-rename-field-ship');
        fireEvent.change(field, { target: { value: 'shipped' } });
        fireEvent.blur(field);
        expect(bound.log.updated).toEqual([{ id: 'ship', name: 'shipped' }]);
    });

    it('snaps back and says why when the name collides with another preset', () => {
        const bound = setup();
        fireEvent.click(screen.getByTestId('label-rename-ship'));
        const field = screen.getByTestId('label-rename-field-ship');
        fireEvent.change(field, { target: { value: 'wip' } });
        fireEvent.keyDown(field, { key: 'Enter' });
        expect(bound.log.updated).toEqual([]);
        expect(screen.getByTestId('label-rename-error-ship').textContent).toContain('already a preset');
        // The row still shows the STORED name — nothing was left half-renamed on screen.
        expect(screen.getByTestId('label-chip-ship').textContent).toBe('ship');
    });

    it('cancels on Escape without writing', () => {
        const bound = setup();
        fireEvent.click(screen.getByTestId('label-rename-ship'));
        const field = screen.getByTestId('label-rename-field-ship');
        fireEvent.change(field, { target: { value: 'shipped' } });
        fireEvent.keyDown(field, { key: 'Escape' });
        fireEvent.blur(field);
        expect(bound.log.updated).toEqual([]);
    });
});

describe('deleting a preset (§6.4)', () => {
    it('deletes an unused preset outright', () => {
        const bound = setup();
        fireEvent.click(screen.getByTestId('label-delete-ship'));
        expect(bound.log.removed).toEqual(['ship']);
    });

    // The spec is explicit that removal never touches a workspace's `labels`, so an in-use
    // preset is deletable — it just says what will happen first.
    it('confirms an in-use delete, saying the label survives', () => {
        const bound = setup([{ labels: ['ship'] }]);
        fireEvent.click(screen.getByTestId('label-delete-ship'));
        expect(bound.log.removed).toEqual([]);
        expect(screen.getByTestId('label-delete-confirm-ship').textContent).toContain('renders neutral');
        fireEvent.click(screen.getByTestId('label-delete-confirm-yes-ship'));
        expect(bound.log.removed).toEqual(['ship']);
    });

    it('lets the confirmation be cancelled', () => {
        const bound = setup([{ labels: ['ship'] }]);
        fireEvent.click(screen.getByTestId('label-delete-ship'));
        fireEvent.click(screen.getByTestId('label-delete-cancel-ship'));
        expect(screen.queryByTestId('label-delete-confirm-ship')).toBeNull();
        expect(bound.log.removed).toEqual([]);
    });
});

describe('labels with no preset (§6.5/§6.6)', () => {
    it('offers a one-click gray back-fill, and hides the section when there are none', () => {
        const bound = setup([{ labels: ['ship', 'orphan'] }]);
        fireEvent.click(screen.getByTestId('label-adopt-orphan'));
        expect(bound.log.added).toEqual([{ name: 'orphan', color: 'gray' }]);
        cleanup();

        setup([{ labels: ['ship'] }]);
        expect(screen.queryByTestId('label-orphans')).toBeNull();
    });
});
