import { DEFAULT_KEYBINDINGS } from '@nex/core/config';
import type { WsProfile } from '@nex/protocol';
import { describe, expect, it } from 'vitest';

import { clientKeyBindings } from '../chrome';
import {
    DEFAULT_PROFILE_NAME,
    PROFILE_MARKER_VAR,
    hasCustomBindings,
    isDefaultBinding,
    keybindingSections,
    labelUsage,
    nextProfileName,
    orphanLabels,
    profileDrafts,
    profileNameError,
    profilesForWrite,
    sanitizeProfileName,
    sanitizeVarKey
} from './model';

describe('the keybinding table', () => {
    it('renders §13.1’s six sections in order, every row labelled', () => {
        const sections = keybindingSections(DEFAULT_KEYBINDINGS);
        expect(sections.map((section) => section.category)).toEqual([
            'Pane Management',
            'Navigation',
            'Workspaces',
            'View',
            'Files',
            'Search'
        ]);
        const rows = sections.flatMap((section) => section.rows);
        expect(rows).toHaveLength(40);
        expect(rows.every((row) => row.label.length > 0)).toBe(true);
    });

    it('shows ALL of an action’s triggers, configString-sorted', () => {
        const row = keybindingSections(DEFAULT_KEYBINDINGS)
            .flatMap((section) => section.rows)
            .find((candidate) => candidate.action === 'focus_next_pane');
        expect(row?.triggers.map((chip) => chip.config)).toEqual(['alt+super+right', 'super+]']);
        expect(row?.triggers.map((chip) => chip.display)).toEqual(['⌥⌘→', '⌘]']);
    });

    it('shows an unbound action as having no triggers', () => {
        const row = keybindingSections(DEFAULT_KEYBINDINGS)
            .flatMap((section) => section.rows)
            .find((candidate) => candidate.action === 'open_diff');
        expect(row?.triggers).toEqual([]);
        expect(row?.isDefault).toBe(true);
    });

    it('marks a row non-default exactly when its trigger list differs from the shipped one', () => {
        const rebound = clientKeyBindings(['ctrl+alt+t=split_right']);
        expect(isDefaultBinding(rebound, 'split_right')).toBe(false);
        expect(isDefaultBinding(rebound, 'split_down')).toBe(true);
        // An `unbind` line is a difference too — the action has fewer triggers than shipped.
        expect(isDefaultBinding(clientKeyBindings(['super+d=unbind']), 'split_right')).toBe(false);
    });

    it('reports whether anything at all is customised (the Reset All predicate)', () => {
        expect(hasCustomBindings(DEFAULT_KEYBINDINGS)).toBe(false);
        expect(hasCustomBindings(clientKeyBindings(['ctrl+alt+t=split_right']))).toBe(true);
    });
});

describe('the profile editor’s load transform (§9.5)', () => {
    const profiles: readonly WsProfile[] = [
        { name: 'work', env: { NEX_PROFILE: 'work', CLAUDE_CONFIG_DIR: '~/.claude-accounts/work', AAA: '1' } },
        { name: 'default', env: { EDITOR: 'vim' } }
    ];

    it('pins `default` first even when the file lists it last', () => {
        expect(profileDrafts(profiles).map((draft) => draft.name)).toEqual(['default', 'work']);
    });

    it('synthesizes an empty `default` when the file has none', () => {
        const drafts = profileDrafts([{ name: 'work', env: { A: '1' } }]);
        expect(drafts[0]).toEqual({ name: DEFAULT_PROFILE_NAME, vars: [] });
    });

    it('strips the derived NEX_PROFILE marker and sorts vars by key', () => {
        const work = profileDrafts(profiles)[1];
        expect(work?.vars.map((entry) => entry.key)).toEqual(['AAA', 'CLAUDE_CONFIG_DIR']);
    });

    it('leaves `~` values verbatim — the editor round-trips what the file says', () => {
        const work = profileDrafts(profiles)[1];
        expect(work?.vars.find((entry) => entry.key === 'CLAUDE_CONFIG_DIR')?.value).toBe(
            '~/.claude-accounts/work'
        );
    });
});

describe('the profile editor’s write transform (§9.5)', () => {
    it('adds the NEX_PROFILE marker to every non-default profile', () => {
        const written = profilesForWrite([
            { name: DEFAULT_PROFILE_NAME, vars: [] },
            { name: 'work', vars: [{ key: 'A', value: '1' }] }
        ]);
        expect(written).toEqual([{ name: 'work', env: { A: '1', [PROFILE_MARKER_VAR]: 'work' } }]);
    });

    it('omits `default` while it has no vars, and includes it once it does', () => {
        expect(profilesForWrite([{ name: DEFAULT_PROFILE_NAME, vars: [] }])).toEqual([]);
        expect(profilesForWrite([{ name: DEFAULT_PROFILE_NAME, vars: [{ key: 'EDITOR', value: 'vim' }] }])).toEqual([
            // No marker on `default`: `resolveEnv` injects it at spawn either way.
            { name: DEFAULT_PROFILE_NAME, env: { EDITOR: 'vim' } }
        ]);
    });

    it('drops blank keys and blank profile names, trims keys, last duplicate wins', () => {
        expect(
            profilesForWrite([
                { name: DEFAULT_PROFILE_NAME, vars: [] },
                { name: '   ', vars: [{ key: 'A', value: '1' }] },
                {
                    name: 'work',
                    vars: [
                        { key: '  ', value: 'ignored' },
                        { key: ' A ', value: '1' },
                        { key: 'A', value: '2' }
                    ]
                }
            ])
        ).toEqual([{ name: 'work', env: { A: '2', [PROFILE_MARKER_VAR]: 'work' } }]);
    });

    it('never writes a user-supplied NEX_PROFILE — the marker is always derived', () => {
        const written = profilesForWrite([
            { name: DEFAULT_PROFILE_NAME, vars: [] },
            { name: 'work', vars: [{ key: PROFILE_MARKER_VAR, value: 'spoofed' }] }
        ]);
        expect(written[0]?.env[PROFILE_MARKER_VAR]).toBe('work');
    });

    it('round-trips a loaded set unchanged', () => {
        const profiles: readonly WsProfile[] = [{ name: 'work', env: { A: '1', NEX_PROFILE: 'work' } }];
        expect(profilesForWrite(profileDrafts(profiles))).toEqual(profiles);
    });
});

describe('profile naming rules', () => {
    it('strips the two characters that would break the line format', () => {
        expect(sanitizeProfileName('wo:rk=1')).toBe('work1');
        expect(sanitizeVarKey('FO=O')).toBe('FOO');
    });

    it('generates a unique placeholder past collisions', () => {
        expect(nextProfileName([{ name: 'default', vars: [] }])).toBe('profile-2');
        expect(
            nextProfileName([
                { name: 'default', vars: [] },
                { name: 'profile-2', vars: [] }
            ])
        ).toBe('profile-3');
    });

    it('refuses renaming to `default` or onto another profile, and never blocks the baseline', () => {
        const drafts = [
            { name: 'default', vars: [] },
            { name: 'work', vars: [] },
            { name: 'personal', vars: [] }
        ];
        expect(profileNameError(drafts, 0, 'default')).toBeNull();
        expect(profileNameError(drafts, 1, 'default')).toContain('built-in baseline');
        expect(profileNameError(drafts, 1, 'personal')).toContain('already exists');
        expect(profileNameError(drafts, 1, '')).toBe('A profile needs a name');
        expect(profileNameError(drafts, 1, 'work')).toBeNull();
    });
});

describe('label reads', () => {
    const workspaces = [{ labels: ['ship', 'wip'] }, { labels: ['ship'] }, { labels: [] }];

    it('counts how many workspaces wear each label', () => {
        expect([...labelUsage(workspaces)]).toEqual([
            ['ship', 2],
            ['wip', 1]
        ]);
    });

    it('lists applied labels that have no preset, first-seen order, deduped', () => {
        expect(orphanLabels(workspaces, [{ name: 'ship' }])).toEqual(['wip']);
        expect(orphanLabels(workspaces, [{ name: 'ship' }, { name: 'wip' }])).toEqual([]);
    });
});
