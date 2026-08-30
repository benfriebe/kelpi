import type { WsProfile } from '@kelpi/protocol';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProfilesTab } from './ProfilesTab';
import { DEFAULT_SETTINGS_PATHS, type SettingsActions } from './types';

function actions(): SettingsActions & { readonly writes: (readonly WsProfile[])[] } {
    const writes: (readonly WsProfile[])[] = [];
    return {
        writes,
        setKeybinding: vi.fn(),
        resetKeybindings: vi.fn(),
        setGeneralSetting: vi.fn(),
        setGhosttySetting: vi.fn(),
        setProfiles: (profiles) => writes.push(profiles),
        addLabelPreset: vi.fn(),
        updateLabelPreset: vi.fn(),
        removeLabelPreset: vi.fn()
    };
}

function setup(profiles: readonly WsProfile[] = []) {
    const bound = actions();
    render(<ProfilesTab profiles={profiles} actions={bound} paths={DEFAULT_SETTINGS_PATHS} />);
    return bound;
}

const WORK: readonly WsProfile[] = [
    { name: 'work', env: { NEX_PROFILE: 'work', CLAUDE_CONFIG_DIR: '~/.claude-accounts/work' } }
];

afterEach(cleanup);

describe('the empty state (SET-080)', () => {
    it('explains what a profile is and offers an inline Add while only `default` exists', () => {
        const bound = setup();
        const block = screen.getByTestId('profiles-none-yet');
        expect(block.textContent).toContain('No workspace profiles yet.');
        expect(block.textContent).toContain('environment variables');
        fireEvent.click(screen.getByTestId('profile-add-inline'));
        expect(bound.writes).toHaveLength(1);
        // …and it is gone once a real profile exists.
        cleanup();
        setup(WORK);
        expect(screen.queryByTestId('profiles-none-yet')).toBeNull();
    });
});

/**
 * The other half of SET-080: the "No profile selected" placeholder, and the gestures that make
 * it reachable. The Swift gets deselection free from `List(selection:)`; this rail is buttons,
 * so the port chose the two gestures the module note argues for.
 */
describe('deselection (SET-080)', () => {
    it('clears the selection when the rail’s empty space is clicked, and shows the placeholder', () => {
        setup(WORK);
        expect(screen.getByTestId('profile-detail')).toBeDefined();
        expect(screen.queryByTestId('profile-detail-placeholder')).toBeNull();

        // The rail itself, not a row: the guard is `target === currentTarget`.
        fireEvent.click(screen.getByTestId('profiles-list'));

        const placeholder = screen.getByTestId('profile-detail-placeholder');
        expect(placeholder.textContent).toContain('No profile selected');
        expect(placeholder.textContent).toContain('named set of environment variables');
        expect(screen.queryByTestId('profile-detail')).toBeNull();
        // Nothing reads as selected any more, for a screen reader as well as for the eye.
        expect(screen.getAllByRole('option').every((row) => row.getAttribute('aria-selected') === 'false')).toBe(
            true
        );
    });

    it('does NOT clear when the click lands on a row (that selects it)', () => {
        setup(WORK);
        fireEvent.click(screen.getByTestId('profile-row-work'));
        expect(screen.getByTestId('profile-detail')).toBeDefined();
        expect(screen.getByTestId('profile-row-work').getAttribute('aria-selected')).toBe('true');
    });

    it('clears on Escape in the rail, and consumes the key only while something is selected', () => {
        setup(WORK);
        const rail = screen.getByTestId('profiles-list');

        const first = fireEvent.keyDown(rail, { key: 'Escape' });
        expect(screen.getByTestId('profile-detail-placeholder')).toBeDefined();
        // `fireEvent` returns false when the handler called preventDefault: the rail took it.
        expect(first).toBe(false);

        // With nothing selected the key is left alone, so the overlay's own Escape still closes
        // Settings rather than being swallowed by a rail that has nothing to clear.
        const second = fireEvent.keyDown(rail, { key: 'Escape' });
        expect(second).toBe(true);
        expect(screen.getByTestId('profile-detail-placeholder')).toBeDefined();
    });

    it('selects again from the placeholder — the state is a detour, not a dead end', () => {
        setup(WORK);
        fireEvent.click(screen.getByTestId('profiles-list'));
        expect(screen.getByTestId('profile-detail-placeholder')).toBeDefined();
        fireEvent.click(screen.getByTestId('profile-row-work'));
        expect(screen.getByTestId('profile-detail')).toBeDefined();
        expect((screen.getByTestId('profile-name') as HTMLInputElement).value).toBe('work');
    });

    it('the placeholder’s inline Add creates a profile and selects it', () => {
        const bound = setup(WORK);
        fireEvent.click(screen.getByTestId('profiles-list'));
        fireEvent.click(screen.getByTestId('profile-add-empty'));
        expect(bound.writes.at(-1)?.map((profile) => profile.name)).toEqual(['work', 'profile-3']);
        expect((screen.getByTestId('profile-name') as HTMLInputElement).value).toBe('profile-3');
    });
});

describe('the profile list', () => {
    it('pins `default` first even for an empty config, and locks its name', () => {
        setup();
        const rows = screen.getAllByRole('option').map((node) => node.textContent);
        expect(rows[0]).toBe('default');
        expect((screen.getByTestId('profile-name') as HTMLInputElement).disabled).toBe(true);
        expect((screen.getByTestId('profile-remove') as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId('profile-detail').textContent).toContain('Built-in baseline');
    });

    /**
     * M47: `ProfilesSettingsView.swift:208-228` models the marker as a FAKE VAR ROW — two
     * disabled `roundedBorder` fields with a `Text("=")` between them — so it lines up column for
     * column with the editable rows beneath it. Asserted as structure (two disabled inputs
     * carrying the two halves) rather than as one string, because the alignment is the point.
     */
    it('shows the derived NEX_PROFILE marker as a locked var row, not an editable var', () => {
        setup(WORK);
        fireEvent.click(screen.getByTestId('profile-row-work'));
        const key = screen.getByTestId('profile-marker-key') as HTMLInputElement;
        const value = screen.getByTestId('profile-marker-value') as HTMLInputElement;
        expect(key.value).toBe('NEX_PROFILE');
        expect(value.value).toBe('work');
        expect(key.disabled).toBe(true);
        expect(value.disabled).toBe(true);
        // The alignment claim: the marker's key field is the same width as a variable row's.
        expect(key.className).toContain('w-40');
        expect((screen.getByTestId('profile-var-key-0') as HTMLInputElement).className).toContain('w-40');
        expect((screen.getByTestId('profile-var-key-0') as HTMLInputElement).value).toBe('CLAUDE_CONFIG_DIR');
        expect(screen.queryByTestId('profile-var-key-1')).toBeNull();
    });

    /** M47: the vars have a heading naming them, as `ProfilesSettingsView.swift:178-180` does. */
    it('names the variable list', () => {
        setup(WORK);
        fireEvent.click(screen.getByTestId('profile-row-work'));
        expect(screen.getByTestId('profile-vars-heading').textContent).toBe('Environment Variables');
    });

    /** M47: `Label(name, systemImage: "person.badge.key")` — the rail rows carry the glyph. */
    it('draws the profile glyph on every rail row', () => {
        setup(WORK);
        for (const row of screen.getAllByRole('option')) {
            expect(row.querySelector('svg')).not.toBeNull();
        }
    });

    it('keeps a `~` value verbatim so a round-trip cannot rewrite the user’s path', () => {
        setup(WORK);
        fireEvent.click(screen.getByTestId('profile-row-work'));
        expect((screen.getByTestId('profile-var-value-0') as HTMLInputElement).value).toBe(
            '~/.claude-accounts/work'
        );
    });
});

describe('editing', () => {
    it('adds a profile with its marker var, so it survives the write', () => {
        const bound = setup();
        fireEvent.click(screen.getByTestId('profile-add'));
        expect(bound.writes).toEqual([[{ name: 'profile-2', env: { NEX_PROFILE: 'profile-2' } }]]);
    });

    it('writes the WHOLE set on every commit (§1.6 is a full replacement)', () => {
        const bound = setup(WORK);
        fireEvent.click(screen.getByTestId('profile-row-work'));
        fireEvent.click(screen.getByTestId('profile-var-add'));
        // An empty row alone writes nothing — the writer drops blank keys.
        expect(bound.writes).toEqual([]);

        fireEvent.change(screen.getByTestId('profile-var-key-1'), { target: { value: 'FOO' } });
        fireEvent.change(screen.getByTestId('profile-var-value-1'), { target: { value: 'bar' } });
        fireEvent.blur(screen.getByTestId('profile-var-value-1'));
        expect(bound.writes.at(-1)).toEqual([
            { name: 'work', env: { CLAUDE_CONFIG_DIR: '~/.claude-accounts/work', FOO: 'bar', NEX_PROFILE: 'work' } }
        ]);
    });

    it('strips `=` from a var key as it is typed', () => {
        setup(WORK);
        fireEvent.click(screen.getByTestId('profile-row-work'));
        fireEvent.change(screen.getByTestId('profile-var-key-0'), { target: { value: 'FO=O' } });
        expect((screen.getByTestId('profile-var-key-0') as HTMLInputElement).value).toBe('FOO');
    });

    it('removes a var', () => {
        const bound = setup(WORK);
        fireEvent.click(screen.getByTestId('profile-row-work'));
        fireEvent.click(screen.getByTestId('profile-var-remove-0'));
        expect(bound.writes.at(-1)).toEqual([{ name: 'work', env: { NEX_PROFILE: 'work' } }]);
    });

    it('renames on blur, stripping the characters that would break the line format', () => {
        const bound = setup(WORK);
        fireEvent.click(screen.getByTestId('profile-row-work'));
        const field = screen.getByTestId('profile-name');
        fireEvent.change(field, { target: { value: 'wo:rk=2' } });
        expect((field as HTMLInputElement).value).toBe('work2');
        fireEvent.blur(field);
        expect(bound.writes.at(-1)).toEqual([
            { name: 'work2', env: { CLAUDE_CONFIG_DIR: '~/.claude-accounts/work', NEX_PROFILE: 'work2' } }
        ]);
    });

    it('refuses a rename to `default` and reverts the field on blur', () => {
        const bound = setup(WORK);
        fireEvent.click(screen.getByTestId('profile-row-work'));
        const field = screen.getByTestId('profile-name');
        fireEvent.change(field, { target: { value: 'default' } });
        expect(screen.getByTestId('profile-name-error').textContent).toContain('built-in baseline');
        fireEvent.blur(field);
        expect(bound.writes).toEqual([]);
        expect((screen.getByTestId('profile-name') as HTMLInputElement).value).toBe('work');
    });

    it('removes a profile, writing the set without it', () => {
        const bound = setup(WORK);
        fireEvent.click(screen.getByTestId('profile-row-work'));
        fireEvent.click(screen.getByTestId('profile-remove'));
        expect(bound.writes.at(-1)).toEqual([]);
    });

    it('re-seeds from the daemon when the file changes underneath it', () => {
        const bound = actions();
        const view = render(
            <ProfilesTab profiles={WORK} actions={bound} paths={DEFAULT_SETTINGS_PATHS} />
        );
        view.rerender(
            <ProfilesTab
                profiles={[{ name: 'personal', env: { NEX_PROFILE: 'personal' } }]}
                actions={bound}
                paths={DEFAULT_SETTINGS_PATHS}
            />
        );
        expect(screen.queryByTestId('profile-row-work')).toBeNull();
        expect(screen.getByTestId('profile-row-personal')).toBeDefined();
    });
});
