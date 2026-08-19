import type { WsProfile } from '@nex/protocol';
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

describe('the profile list', () => {
    it('pins `default` first even for an empty config, and locks its name', () => {
        setup();
        const rows = screen.getAllByRole('option').map((node) => node.textContent);
        expect(rows[0]).toBe('default');
        expect((screen.getByTestId('profile-name') as HTMLInputElement).disabled).toBe(true);
        expect((screen.getByTestId('profile-remove') as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId('profile-detail').textContent).toContain('Built-in baseline');
    });

    it('shows the derived NEX_PROFILE marker as a locked row, not an editable var', () => {
        setup(WORK);
        fireEvent.click(screen.getByTestId('profile-row-work'));
        expect(screen.getByTestId('profile-marker-row').textContent).toContain('NEX_PROFILE = work');
        expect((screen.getByTestId('profile-var-key-0') as HTMLInputElement).value).toBe('CLAUDE_CONFIG_DIR');
        expect(screen.queryByTestId('profile-var-key-1')).toBeNull();
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
