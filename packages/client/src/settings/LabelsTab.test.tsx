import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChromeLabelPreset } from '../chrome';
import { LabelsTab } from './LabelsTab';
import type { LabelledWorkspace } from './model';
import type { SettingsActions } from './types';

interface Recorded {
    readonly added: { name: string; color: string }[];
    readonly updated: { id: string; name?: string | undefined; color?: string | undefined }[];
    readonly removed: string[];
}

function actions(): SettingsActions & { readonly log: Recorded } {
    const log: Recorded = { added: [], updated: [], removed: [] };
    return {
        log,
        setKeybinding: vi.fn(),
        resetKeybindings: vi.fn(),
        setGeneralSetting: vi.fn(),
        setProfiles: vi.fn(),
        addLabelPreset: (input) => log.added.push(input),
        updateLabelPreset: (input) => log.updated.push(input),
        removeLabelPreset: (id) => log.removed.push(id)
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
