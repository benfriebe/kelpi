import { describe, expect, it } from 'vitest';
import { setGeneralSetting, writeKeybindings, writeProfiles } from './write.js';
import {
    DEFAULT_KEYBINDINGS,
    actionForTrigger,
    parseKeybindValue,
    removeBinding,
    resolveKeyBindings,
    setBinding,
    type KeyBindingMap
} from './bindings.js';
import { parseGeneralSettings } from './general.js';
import { parseKeybindOverrides } from './keybinds.js';
import { parseKeyTrigger } from './keys.js';
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

describe('writeKeybindings', () => {
    const map = (...lines: readonly string[]) =>
        resolveKeyBindings(
            lines.map((line) => {
                const override = parseKeybindValue(line);
                if (override === null) throw new Error(`unparseable test line: ${line}`);
                return override;
            })
        );
    const emitted = (contents: string | null, bindings: KeyBindingMap) =>
        (writeKeybindings(contents, bindings) ?? '')
            .split('\n')
            .filter((line) => line.startsWith('keybind = '));

    it('writes nothing for the untouched defaults, and deletes an otherwise-empty file', () => {
        expect(writeKeybindings(null, DEFAULT_KEYBINDINGS)).toBeNull();
        expect(writeKeybindings('', DEFAULT_KEYBINDINGS)).toBeNull();
        expect(writeKeybindings('keybind = super+d=split_down\n', DEFAULT_KEYBINDINGS)).toBeNull();
    });

    it('keeps every non-keybind line when the diff is empty', () => {
        expect(writeKeybindings(REALISTIC_CONFIG, DEFAULT_KEYBINDINGS)).toBe(`# Nex config
focus-follows-mouse = true
focus-follows-mouse-delay = 150

# terminal
theme = Catppuccin Mocha
tcp-port = 19400


profile = work:CLAUDE_CONFIG_DIR=~/.claude-accounts/work
profile = work:FOO=bar
profile = personal:CLAUDE_CONFIG_DIR=~/.claude-accounts/personal
`);
    });

    it('writes only the non-default bindings (§5.3 pass 1a)', () => {
        const bindings = setBinding(DEFAULT_KEYBINDINGS, parseKeyTrigger('ctrl+alt+t')!, 'split_right');
        expect(emitted(null, bindings)).toEqual(['keybind = ctrl+alt+t=split_right']);
    });

    it('writes an unbind line for a default trigger that is now bound to nothing (pass 1b)', () => {
        const bindings = removeBinding(DEFAULT_KEYBINDINGS, parseKeyTrigger('super+d')!);
        expect(emitted(null, bindings)).toEqual(['keybind = super+d=unbind']);
    });

    it('writes a rebound default trigger once, with no companion unbind line (pass 2)', () => {
        const bindings = setBinding(DEFAULT_KEYBINDINGS, parseKeyTrigger('super+d')!, 'split_down');
        expect(emitted(null, bindings)).toEqual(['keybind = super+d=split_down']);
    });

    it('round-trips through the parser back to the same map', () => {
        const bindings = map(
            'ctrl+alt+t=split_right',
            'super+d=split_down',
            'super+w=unbind',
            'super+==increase_markdown_font_size'
        );
        const written = writeKeybindings(null, bindings);
        expect(written).not.toBeNull();
        const reparsed = resolveKeyBindings(parseKeybindOverrides(written as string));
        for (const trigger of ['ctrl+alt+t', 'super+d', 'super+w', 'super+e']) {
            const parsed = parseKeyTrigger(trigger);
            expect(parsed).not.toBeNull();
            expect(actionForTrigger(reparsed, parsed!)).toBe(actionForTrigger(bindings, parsed!));
        }
    });

    it('emits in a deterministic action / configString order', () => {
        const bindings = map('ctrl+alt+y=close_pane', 'ctrl+alt+t=split_right', 'ctrl+alt+a=split_right');
        expect(emitted(null, bindings)).toEqual([
            'keybind = ctrl+alt+a=split_right',
            'keybind = ctrl+alt+t=split_right',
            'keybind = ctrl+alt+y=close_pane'
        ]);
    });

    it('preserves comments, blanks and profile lines while replacing the keybind block', () => {
        const bindings = map('ctrl+alt+t=split_right');
        expect(writeKeybindings(REALISTIC_CONFIG, bindings)).toBe(`# Nex config
focus-follows-mouse = true
focus-follows-mouse-delay = 150

# terminal
theme = Catppuccin Mocha
tcp-port = 19400


profile = work:CLAUDE_CONFIG_DIR=~/.claude-accounts/work
profile = work:FOO=bar
profile = personal:CLAUDE_CONFIG_DIR=~/.claude-accounts/personal

keybind = ctrl+alt+t=split_right
`);
        expect(parseGeneralSettings(writeKeybindings(REALISTIC_CONFIG, bindings) as string).tcpPort).toBe(19400);
        expect(
            parseProfiles(writeKeybindings(REALISTIC_CONFIG, bindings) as string, { expandTilde: false })
        ).toHaveLength(2);
    });

    it('separates the keybind block from preserved content with exactly one blank line', () => {
        const bindings = map('ctrl+alt+t=split_right');
        expect(writeKeybindings('theme = Nord\n\n\n', bindings)).toBe(
            'theme = Nord\n\nkeybind = ctrl+alt+t=split_right\n'
        );
    });

    it('drops a `keybindx` line too (the writer filters by prefix, the parser by key)', () => {
        expect(writeKeybindings('keybindx = super+d=split_down\ntheme = Nord\n', DEFAULT_KEYBINDINGS)).toBe(
            'theme = Nord\n'
        );
        // A commented-out keybind is not a keybind line.
        expect(writeKeybindings('# keybind = super+d=split_down\n', DEFAULT_KEYBINDINGS)).toBe(
            '# keybind = super+d=split_down\n'
        );
    });

    it('rewrites hand-written alias spellings in canonical form', () => {
        const bindings = resolveKeyBindings(parseKeybindOverrides('keybind = cmd+ctrl+t=split_right\n'));
        expect(emitted('keybind = cmd+ctrl+t=split_right\n', bindings)).toEqual([
            'keybind = ctrl+super+t=split_right'
        ]);
    });
});
