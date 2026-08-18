import { describe, expect, it } from 'vitest';
import { setGeneralSetting, writeProfiles } from './write.js';
import { parseGeneralSettings } from './general.js';
import { parseKeybindOverrides } from './keybinds.js';
import { parseProfiles } from './profiles.js';

const REALISTIC_CONFIG = `# Nex config
focus-follows-mouse = true
focus-follows-mouse-delay = 150

# terminal
theme = Catppuccin Mocha
tcp-port = 19400

keybind = super+shift+d=split_down
keybind = super+e=unbind

profile = work:CLAUDE_CONFIG_DIR=~/.claude-accounts/work
profile = work:FOO=bar
profile = personal:CLAUDE_CONFIG_DIR=~/.claude-accounts/personal
`;

describe('setGeneralSetting', () => {
    it('replaces the matching line and leaves everything else byte-for-byte', () => {
        const updated = setGeneralSetting(REALISTIC_CONFIG, 'tcp-port', '19401');
        expect(updated).toBe(REALISTIC_CONFIG.replace('tcp-port = 19400', 'tcp-port = 19401'));
        expect(parseGeneralSettings(updated).tcpPort).toBe(19401);
        expect(parseKeybindOverrides(updated)).toHaveLength(2);
        expect(parseProfiles(updated, { expandTilde: false })).toHaveLength(2);
    });

    it('rewrites with canonical spacing', () => {
        expect(setGeneralSetting('tcp-port=19400\n', 'tcp-port', '1')).toBe('tcp-port = 1\n');
        expect(setGeneralSetting('   tcp-port   =   19400\n', 'tcp-port', '1')).toBe(
            'tcp-port = 1\n'
        );
    });

    it('replaces EVERY duplicate line with the same value (quirk preserved)', () => {
        const contents = 'focus-follows-mouse = true\ntheme = Nord\nfocus-follows-mouse = false\n';
        expect(setGeneralSetting(contents, 'focus-follows-mouse', 'true')).toBe(
            'focus-follows-mouse = true\ntheme = Nord\nfocus-follows-mouse = true\n'
        );
    });

    it('appends after stripping trailing blank lines when nothing matched', () => {
        expect(setGeneralSetting('theme = Nord\n\n\n', 'tcp-port', '19400')).toBe(
            'theme = Nord\ntcp-port = 19400\n'
        );
    });

    it('creates the file content from nothing', () => {
        expect(setGeneralSetting(null, 'focus-follows-mouse', 'true')).toBe(
            'focus-follows-mouse = true\n'
        );
        expect(setGeneralSetting('', 'tcp-port', '19400')).toBe('tcp-port = 19400\n');
    });

    it('never touches comments that merely mention the key', () => {
        const contents = '# tcp-port = 1\ntcp-port = 2\n';
        expect(setGeneralSetting(contents, 'tcp-port', '3')).toBe('# tcp-port = 1\ntcp-port = 3\n');
    });

    it('round-trips through the parser', () => {
        let contents: string | null = REALISTIC_CONFIG;
        contents = setGeneralSetting(contents, 'focus-follows-mouse', 'false');
        contents = setGeneralSetting(contents, 'focus-follows-mouse-delay', '250');
        contents = setGeneralSetting(contents, 'global-hotkey', 'ctrl+alt+space');
        const settings = parseGeneralSettings(contents);
        expect(settings.focusFollowsMouse).toBe(false);
        expect(settings.focusFollowsMouseDelay).toBe(250);
        expect(settings.globalHotkey).toEqual({ keyCode: 49, modifiers: ['ctrl', 'alt'] });
        expect(settings.theme).toBe('Catppuccin Mocha');
    });
});

describe('writeProfiles', () => {
    it('replaces only the profile lines and preserves the rest', () => {
        const profiles = parseProfiles(REALISTIC_CONFIG, { expandTilde: false });
        const rewritten = writeProfiles(REALISTIC_CONFIG, profiles);
        expect(rewritten).toBe(`# Nex config
focus-follows-mouse = true
focus-follows-mouse-delay = 150

# terminal
theme = Catppuccin Mocha
tcp-port = 19400

keybind = super+shift+d=split_down
keybind = super+e=unbind

profile = work:CLAUDE_CONFIG_DIR=~/.claude-accounts/work
profile = work:FOO=bar
profile = personal:CLAUDE_CONFIG_DIR=~/.claude-accounts/personal
`);
    });

    it('is a fixed point: parse -> write -> parse', () => {
        const first = parseProfiles(REALISTIC_CONFIG, { expandTilde: false });
        const rewritten = writeProfiles(REALISTIC_CONFIG, first);
        expect(parseProfiles(rewritten, { expandTilde: false })).toEqual(first);
        expect(writeProfiles(rewritten, first)).toBe(rewritten);
    });

    it('sorts env keys within a profile and keeps profiles in array order', () => {
        const written = writeProfiles(null, [
            { name: 'work', env: { ZED: '1', ALPHA: '2' } },
            { name: 'personal', env: { B: '2' } }
        ]);
        expect(written).toBe(
            'profile = work:ALPHA=2\nprofile = work:ZED=1\nprofile = personal:B=2\n'
        );
    });

    it('skips blank profile names and blank var keys', () => {
        expect(
            writeProfiles(null, [
                { name: '  ', env: { A: '1' } },
                { name: 'work', env: { '  ': 'x', A: '1' } }
            ])
        ).toBe('profile = work:A=1\n');
    });

    it('drops profile lines when writing an empty profile set', () => {
        expect(writeProfiles(REALISTIC_CONFIG, [])).toBe(`# Nex config
focus-follows-mouse = true
focus-follows-mouse-delay = 150

# terminal
theme = Catppuccin Mocha
tcp-port = 19400

keybind = super+shift+d=split_down
keybind = super+e=unbind
`);
    });

    it('writes an empty file when nothing at all is left', () => {
        expect(writeProfiles('profile = work:A=1\n', [])).toBe('');
        expect(writeProfiles(null, [])).toBe('');
    });

    it('separates the profile block from preserved content with exactly one blank line', () => {
        expect(writeProfiles('theme = Nord\n\n\n', [{ name: 'work', env: { A: '1' } }])).toBe(
            'theme = Nord\n\nprofile = work:A=1\n'
        );
    });

    it('keeps values containing : and = intact through a round-trip', () => {
        const profiles = [{ name: 'work', env: { URL: 'http://x:8080/a=b' } }];
        const written = writeProfiles(null, profiles);
        expect(written).toBe('profile = work:URL=http://x:8080/a=b\n');
        expect(parseProfiles(written)).toEqual(profiles);
    });
});
