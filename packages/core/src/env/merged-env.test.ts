import { describe, expect, it } from 'vitest';
import {
    buildPanePath,
    effectiveProfileName,
    isDefinedProfile,
    mergedEnvVars,
    normalizedAssignment,
    paneSpawnEnvVars,
    resolveProfileEnv
} from './merged-env.js';
import { parseProfiles } from '../config/profiles.js';

const PANE_ID = 'AAAAAAAA-0000-4000-8000-00000000000A';

describe('normalizedAssignment', () => {
    it('maps default, empty and whitespace to null', () => {
        expect(normalizedAssignment('default')).toBeNull();
        expect(normalizedAssignment('  default  ')).toBeNull();
        expect(normalizedAssignment('')).toBeNull();
        expect(normalizedAssignment('   ')).toBeNull();
        expect(normalizedAssignment(null)).toBeNull();
        expect(normalizedAssignment(undefined)).toBeNull();
    });

    it('trims a real assignment and stays case-sensitive', () => {
        expect(normalizedAssignment('  work ')).toBe('work');
        expect(normalizedAssignment('Default')).toBe('Default');
    });

    it('round-trips: assigning "default" shows no assignment', () => {
        expect(effectiveProfileName(normalizedAssignment('default'))).toBe('default');
        expect(effectiveProfileName(null)).toBe('default');
        expect(effectiveProfileName('work')).toBe('work');
    });
});

describe('resolveProfileEnv', () => {
    const profiles = parseProfiles(
        [
            'profile = work:CLAUDE_CONFIG_DIR=/home/me/.claude-work',
            'profile = work:NEX_PROFILE=spoofed',
            'profile = work:FOO=bar'
        ].join('\n')
    );

    it('merges the canonical NEX_PROFILE marker last, beating a spoofing config line', () => {
        expect(resolveProfileEnv(profiles, 'work')).toEqual({
            CLAUDE_CONFIG_DIR: '/home/me/.claude-work',
            FOO: 'bar',
            NEX_PROFILE: 'work'
        });
    });

    it('resolves an undefined profile to just the marker', () => {
        expect(resolveProfileEnv(profiles, 'default')).toEqual({ NEX_PROFILE: 'default' });
        expect(isDefinedProfile(profiles, 'work')).toBe(true);
        expect(isDefinedProfile(profiles, 'default')).toBe(false);
    });
});

describe('mergedEnvVars', () => {
    it('emits NEX_PANE_ID, PATH, then profile vars sorted by key', () => {
        const merged = mergedEnvVars({
            paneID: PANE_ID,
            path: '/Apps/Nex.app/Contents/Helpers:/usr/bin',
            profileEnv: { ZED: '1', ALPHA: '2', NEX_PROFILE: 'work' }
        });
        expect(merged).toEqual([
            { key: 'NEX_PANE_ID', value: PANE_ID },
            { key: 'PATH', value: '/Apps/Nex.app/Contents/Helpers:/usr/bin' },
            { key: 'ALPHA', value: '2' },
            { key: 'NEX_PROFILE', value: 'work' },
            { key: 'ZED', value: '1' }
        ]);
    });

    it('silently drops profile vars that shadow the reserved built-ins', () => {
        const merged = mergedEnvVars({
            paneID: PANE_ID,
            path: '/helpers:/usr/bin',
            profileEnv: { NEX_PANE_ID: 'hijacked', PATH: '/evil', NEX_SOCKET: '/evil.sock', OK: 'yes' }
        });
        expect(merged).toEqual([
            { key: 'NEX_PANE_ID', value: PANE_ID },
            { key: 'PATH', value: '/helpers:/usr/bin' },
            { key: 'OK', value: 'yes' }
        ]);
    });

    it('injects NEX_SOCKET between PATH and the profile vars when a route is given', () => {
        const merged = mergedEnvVars({
            paneID: PANE_ID,
            path: '/helpers:/usr/bin',
            socketRoute: 'tcp:127.0.0.1:49213',
            profileEnv: { ALPHA: '2' }
        });
        expect(merged).toEqual([
            { key: 'NEX_PANE_ID', value: PANE_ID },
            { key: 'PATH', value: '/helpers:/usr/bin' },
            { key: 'NEX_SOCKET', value: 'tcp:127.0.0.1:49213' },
            { key: 'ALPHA', value: '2' }
        ]);
    });

    it('injects nothing for a null, absent or empty route (byte-identical to the old env)', () => {
        const expected = [
            { key: 'NEX_PANE_ID', value: PANE_ID },
            { key: 'PATH', value: '/helpers:/usr/bin' }
        ];
        expect(mergedEnvVars({ paneID: PANE_ID, path: '/helpers:/usr/bin', profileEnv: {} })).toEqual(expected);
        expect(
            mergedEnvVars({ paneID: PANE_ID, path: '/helpers:/usr/bin', socketRoute: null, profileEnv: {} })
        ).toEqual(expected);
        expect(
            mergedEnvVars({ paneID: PANE_ID, path: '/helpers:/usr/bin', socketRoute: '', profileEnv: {} })
        ).toEqual(expected);
    });

    it('a profile line cannot spoof NEX_SOCKET even when no route is injected', () => {
        const merged = mergedEnvVars({
            paneID: PANE_ID,
            path: '/helpers:/usr/bin',
            profileEnv: { NEX_SOCKET: 'tcp:evil.example:1' }
        });
        expect(merged).toEqual([
            { key: 'NEX_PANE_ID', value: PANE_ID },
            { key: 'PATH', value: '/helpers:/usr/bin' }
        ]);
    });
});

describe('buildPanePath', () => {
    it('prepends the helpers dir so the bundled nex CLI wins', () => {
        expect(buildPanePath('/Apps/Nex.app/Contents/Helpers', '/usr/local/bin:/usr/bin')).toBe(
            '/Apps/Nex.app/Contents/Helpers:/usr/local/bin:/usr/bin'
        );
    });

    it('falls back when no PATH was inherited', () => {
        expect(buildPanePath('/helpers')).toBe('/helpers:/usr/local/bin:/usr/bin:/bin');
        expect(buildPanePath('/helpers', '')).toBe('/helpers:/usr/local/bin:/usr/bin:/bin');
        expect(buildPanePath('/helpers', null)).toBe('/helpers:/usr/local/bin:/usr/bin:/bin');
    });
});

describe('paneSpawnEnvVars', () => {
    const profiles = parseProfiles('profile = work:CLAUDE_CONFIG_DIR=/w\nprofile = default:EDITOR=vim');

    it('gives an unassigned workspace the default baseline plus its vars', () => {
        expect(
            paneSpawnEnvVars({
                paneID: PANE_ID,
                helpersDir: '/helpers',
                inheritedPath: '/usr/bin',
                profileName: null,
                profiles
            })
        ).toEqual([
            { key: 'NEX_PANE_ID', value: PANE_ID },
            { key: 'PATH', value: '/helpers:/usr/bin' },
            { key: 'EDITOR', value: 'vim' },
            { key: 'NEX_PROFILE', value: 'default' }
        ]);
    });

    it('treats an explicit "default" assignment as unassigned', () => {
        const assigned = paneSpawnEnvVars({
            paneID: PANE_ID,
            helpersDir: '/helpers',
            inheritedPath: '/usr/bin',
            profileName: 'default',
            profiles
        });
        const unassigned = paneSpawnEnvVars({
            paneID: PANE_ID,
            helpersDir: '/helpers',
            inheritedPath: '/usr/bin',
            profileName: null,
            profiles
        });
        expect(assigned).toEqual(unassigned);
    });

    it('injects a named profile', () => {
        expect(
            paneSpawnEnvVars({
                paneID: PANE_ID,
                helpersDir: '/helpers',
                inheritedPath: '/usr/bin',
                profileName: 'work',
                profiles
            })
        ).toEqual([
            { key: 'NEX_PANE_ID', value: PANE_ID },
            { key: 'PATH', value: '/helpers:/usr/bin' },
            { key: 'CLAUDE_CONFIG_DIR', value: '/w' },
            { key: 'NEX_PROFILE', value: 'work' }
        ]);
    });
});
