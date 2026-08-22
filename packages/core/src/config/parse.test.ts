import { describe, expect, it } from 'vitest';
import { DEFAULT_GENERAL_SETTINGS, parseGeneralSettings } from './general.js';
import { BUILT_IN_TERMINAL_THEMES, namedTerminalTheme } from './themes.js';
import { parseKeybindOverrides } from './keybinds.js';
import { parseProfiles } from './profiles.js';
import { parseConfigLine } from './lines.js';
import { keyTriggerConfigString } from './keys.js';

const REALISTIC_CONFIG = `# Nex config
focus-follows-mouse = true
focus-follows-mouse-delay = 150
theme = Catppuccin Mocha
tcp-port = 19400
global-hotkey = ctrl+alt+space
global-hotkey-hide-on-repress = true

keybind = super+shift+d=split_down
keybind = super+e=unbind

profile = work:CLAUDE_CONFIG_DIR=~/.claude-accounts/work
profile = work:FOO=bar
profile = personal:CLAUDE_CONFIG_DIR=~/.claude-accounts/personal
`;

describe('line syntax', () => {
    it('trims, skips blanks and whole-line comments, splits at the first =', () => {
        expect(parseConfigLine('   theme = Nord  ')).toEqual({ key: 'theme', value: 'Nord' });
        expect(parseConfigLine('# theme = Nord')).toBeNull();
        expect(parseConfigLine('')).toBeNull();
        expect(parseConfigLine('   ')).toBeNull();
        expect(parseConfigLine('no-equals-here')).toBeNull();
        expect(parseConfigLine('keybind = super+==increase_markdown_font_size')).toEqual({
            key: 'keybind',
            value: 'super+==increase_markdown_font_size'
        });
    });

    it('has no inline-comment support (the comment becomes part of the value)', () => {
        expect(parseGeneralSettings('focus-follows-mouse = true # hi').focusFollowsMouse).toBe(false);
    });
});

describe('parseGeneralSettings', () => {
    it('returns defaults for an empty file', () => {
        expect(parseGeneralSettings('')).toEqual(DEFAULT_GENERAL_SETTINGS);
    });

    it('parses the realistic config', () => {
        const settings = parseGeneralSettings(REALISTIC_CONFIG);
        expect(settings.focusFollowsMouse).toBe(true);
        expect(settings.focusFollowsMouseDelay).toBe(150);
        expect(settings.theme).toBe('Catppuccin Mocha');
        expect(settings.tcpPort).toBe(19400);
        expect(settings.globalHotkey).toEqual({ keyCode: 49, modifiers: ['ctrl', 'alt'] });
        expect(settings.globalHotkeyHideOnRepress).toBe(true);
    });

    it('treats only the literal "true" as enabling focus-follows-mouse', () => {
        expect(parseGeneralSettings('focus-follows-mouse = TRUE').focusFollowsMouse).toBe(true);
        expect(parseGeneralSettings('focus-follows-mouse = yes').focusFollowsMouse).toBe(false);
        expect(parseGeneralSettings('focus-follows-mouse = 1').focusFollowsMouse).toBe(false);
    });

    /**
     * §TERM-046. `clipboard-write` is a GATE, so it parses the way a gate should: absent means
     * off, and only the literal `true` opens it — a `yes`, a `1`, a typo all fail closed. (The
     * default-true flags beside it use the mirror-image rule, which is why this is asserted
     * rather than assumed.)
     */
    it('ships clipboard-write OFF and opens it only for the literal "true"', () => {
        expect(parseGeneralSettings('').clipboardWrite).toBe(false);
        expect(parseGeneralSettings('clipboard-write = true').clipboardWrite).toBe(true);
        expect(parseGeneralSettings('clipboard-write = TRUE').clipboardWrite).toBe(true);
        expect(parseGeneralSettings('clipboard-write = yes').clipboardWrite).toBe(false);
        expect(parseGeneralSettings('clipboard-write = 1').clipboardWrite).toBe(false);
        expect(parseGeneralSettings('clipboard-write =').clipboardWrite).toBe(false);
        // Later lines win, in both directions.
        expect(parseGeneralSettings('clipboard-write = true\nclipboard-write = false').clipboardWrite).toBe(
            false
        );
    });

    it('clamps the delay at 0 and ignores non-integers', () => {
        expect(parseGeneralSettings('focus-follows-mouse-delay = -20').focusFollowsMouseDelay).toBe(0);
        expect(parseGeneralSettings('focus-follows-mouse-delay = abc').focusFollowsMouseDelay).toBe(
            100
        );
        expect(
            parseGeneralSettings(
                'focus-follows-mouse-delay = 200\nfocus-follows-mouse-delay = 12x'
            ).focusFollowsMouseDelay
        ).toBe(200);
    });

    it('ignores out-of-range tcp ports and keeps the prior value', () => {
        expect(parseGeneralSettings('tcp-port = 0').tcpPort).toBe(0);
        expect(parseGeneralSettings('tcp-port = 70000').tcpPort).toBe(0);
        expect(parseGeneralSettings('tcp-port = 19400\ntcp-port = 99999').tcpPort).toBe(19400);
        expect(parseGeneralSettings('tcp-port = 65535').tcpPort).toBe(65535);
    });

    it('preserves theme case and lets later lines win', () => {
        expect(parseGeneralSettings('theme = Gruvbox Dark\ntheme = Nord').theme).toBe('Nord');
    });

    it('clears the global hotkey for none/unbind/empty and ignores garbage', () => {
        expect(parseGeneralSettings('global-hotkey = none').globalHotkey).toBeNull();
        expect(parseGeneralSettings('global-hotkey = UNBIND').globalHotkey).toBeNull();
        expect(parseGeneralSettings('global-hotkey =').globalHotkey).toBeNull();
        expect(parseGeneralSettings('global-hotkey = ctrl+alt+space\nglobal-hotkey = zzz')
            .globalHotkey).toEqual({ keyCode: 49, modifiers: ['ctrl', 'alt'] });
    });

    it('defaults hide-on-repress to true for anything but the literal false', () => {
        expect(parseGeneralSettings('').globalHotkeyHideOnRepress).toBe(true);
        expect(
            parseGeneralSettings('global-hotkey-hide-on-repress = FALSE').globalHotkeyHideOnRepress
        ).toBe(false);
        expect(
            parseGeneralSettings('global-hotkey-hide-on-repress = garbage').globalHotkeyHideOnRepress
        ).toBe(true);
    });

    // Not a Swift config key (it lives in UserDefaults there); shell-ui.md's port note moves
    // the suppression settings into the daemon's settings store, which is this file.
    it('defaults the workspace-delete confirmation to true, off only for the literal false', () => {
        expect(parseGeneralSettings('').confirmWorkspaceDeleteWhenActive).toBe(true);
        expect(parseGeneralSettings('confirm-workspace-delete = FALSE').confirmWorkspaceDeleteWhenActive).toBe(
            false
        );
        expect(parseGeneralSettings('confirm-workspace-delete = garbage').confirmWorkspaceDeleteWhenActive).toBe(
            true
        );
    });

    // SET-011, same UserDefaults→config-key move and the same lenient rule.
    it('defaults group inheritance to on, off only for the literal false', () => {
        expect(parseGeneralSettings('').inheritGroupOnNewWorkspace).toBe(true);
        expect(parseGeneralSettings('inherit-group-on-new-workspace = FALSE').inheritGroupOnNewWorkspace).toBe(
            false
        );
        expect(parseGeneralSettings('inherit-group-on-new-workspace = garbage').inheritGroupOnNewWorkspace).toBe(
            true
        );
        expect(parseGeneralSettings('inherit-group-on-new-workspace = true').inheritGroupOnNewWorkspace).toBe(true);
    });

    // SET-012, the sixth and last of §13's behaviour keys to move out of UserDefaults.
    it('defaults expand-group-on-workspace-drop to on, off only for the literal false', () => {
        expect(parseGeneralSettings('').expandGroupOnWorkspaceDrop).toBe(true);
        expect(
            parseGeneralSettings('expand-group-on-workspace-drop = FALSE').expandGroupOnWorkspaceDrop
        ).toBe(false);
        expect(
            parseGeneralSettings('expand-group-on-workspace-drop = garbage').expandGroupOnWorkspaceDrop
        ).toBe(true);
        expect(
            parseGeneralSettings('expand-group-on-workspace-drop = true').expandGroupOnWorkspaceDrop
        ).toBe(true);
    });

    it('ignores unknown keys', () => {
        expect(parseGeneralSettings('who-knows = 5\ntheme = Nord').theme).toBe('Nord');
    });
});

describe('parseKeybindOverrides', () => {
    it('reads the overrides in file order', () => {
        const overrides = parseKeybindOverrides(REALISTIC_CONFIG);
        expect(overrides).toHaveLength(2);
        expect(keyTriggerConfigString(overrides[0]!.trigger)).toBe('shift+super+d');
        expect(overrides[0]!.action).toBe('split_down');
        expect(overrides[1]!.action).toBe('unbind');
    });

    it('splits at the LAST = so the = key itself is bindable', () => {
        const [override] = parseKeybindOverrides('keybind = super+==increase_markdown_font_size');
        expect(keyTriggerConfigString(override!.trigger)).toBe('super+=');
        expect(override!.action).toBe('increase_markdown_font_size');
    });

    it('skips lines whose key is not exactly "keybind"', () => {
        expect(parseKeybindOverrides('keybindx = super+d=split_right')).toEqual([]);
    });

    it('skips values with no =, unknown triggers and unknown actions', () => {
        expect(parseKeybindOverrides('keybind = super+d')).toEqual([]);
        expect(parseKeybindOverrides('keybind = hyper+d=split_right')).toEqual([]);
        expect(parseKeybindOverrides('keybind = super+d=teleport')).toEqual([]);
    });
});

describe('parseProfiles', () => {
    it('merges repeated lines by name, keeping first-appearance order', () => {
        const profiles = parseProfiles(REALISTIC_CONFIG, { expandTilde: false });
        expect(profiles.map((profile) => profile.name)).toEqual(['work', 'personal']);
        expect(profiles[0]!.env).toEqual({
            CLAUDE_CONFIG_DIR: '~/.claude-accounts/work',
            FOO: 'bar'
        });
    });

    it('lets a later line win on an env-key collision', () => {
        const profiles = parseProfiles('profile = work:FOO=one\nprofile = work:FOO=two');
        expect(profiles[0]!.env).toEqual({ FOO: 'two' });
    });

    it('splits the name at the first : and the assignment at the first =', () => {
        const profiles = parseProfiles('profile = work:URL=http://x:8080/a=b');
        expect(profiles[0]!.env).toEqual({ URL: 'http://x:8080/a=b' });
    });

    it('keeps quotes literal', () => {
        const profiles = parseProfiles('profile = work:Q="quoted value"');
        expect(profiles[0]!.env).toEqual({ Q: '"quoted value"' });
    });

    it('skips lines with no :, no =, an empty name or an empty key', () => {
        expect(parseProfiles('profile = workFOO=bar')).toEqual([]);
        expect(parseProfiles('profile = work:FOO')).toEqual([]);
        expect(parseProfiles('profile = :FOO=bar')).toEqual([]);
        expect(parseProfiles('profile = work:=bar')).toEqual([]);
    });

    it('expands a leading ~ only when asked and only with a home directory', () => {
        const line = 'profile = work:DIR=~/.claude';
        expect(parseProfiles(line, { expandTilde: true, home: '/Users/me' })[0]!.env).toEqual({
            DIR: '/Users/me/.claude'
        });
        expect(parseProfiles(line, { expandTilde: false, home: '/Users/me' })[0]!.env).toEqual({
            DIR: '~/.claude'
        });
        expect(parseProfiles(line)[0]!.env).toEqual({ DIR: '~/.claude' });
        expect(
            parseProfiles('profile = work:DIR=~', { home: '/Users/me' })[0]!.env
        ).toEqual({ DIR: '/Users/me' });
        expect(
            parseProfiles('profile = work:DIR=~other/x', { home: '/Users/me' })[0]!.env
        ).toEqual({ DIR: '~other/x' });
    });
});

/**
 * §SET-215 / §SET-216: the built-in terminal themes and `NexTheme.named(id)`.
 *
 * The lookup is the whole of §SET-216 — a `theme = <anything else>` line has to select NOTHING,
 * so the terminal keeps whatever the user's own ghostty config resolved. That means the match
 * is exact, case included: these ids are case-sensitive theme FILENAMES.
 */
describe('built-in terminal themes', () => {
    it('ships the ten NexTheme built-ins, ids spelled as ghostty filenames', () => {
        expect(BUILT_IN_TERMINAL_THEMES.map((theme) => theme.id)).toEqual([
            'Dracula',
            'Catppuccin Mocha',
            'Catppuccin Latte',
            'Catppuccin Macchiato',
            'Catppuccin Frappe',
            'Nord',
            'Gruvbox Dark',
            'Gruvbox Light',
            'iTerm2 Solarized Dark',
            'iTerm2 Solarized Light'
        ]);
        // Three display names differ from the filename: the two Solarized entries (whose
        // ghostty files are prefixed `iTerm2 `) and Frappé, whose file has no accent.
        expect(BUILT_IN_TERMINAL_THEMES.filter((theme) => theme.id !== theme.name)).toEqual([
            { id: 'Catppuccin Frappe', name: 'Catppuccin Frappé' },
            { id: 'iTerm2 Solarized Dark', name: 'Solarized Dark' },
            { id: 'iTerm2 Solarized Light', name: 'Solarized Light' }
        ]);
    });

    it('matches a built-in exactly and selects nothing for anything else (§SET-216)', () => {
        expect(namedTerminalTheme('Nord')?.name).toBe('Nord');
        expect(namedTerminalTheme('  Nord  ')?.id).toBe('Nord');
        // Case matters — the id is a filename, and a near miss must not repaint the terminal.
        expect(namedTerminalTheme('nord')).toBeNull();
        expect(namedTerminalTheme('Dracula Pro')).toBeNull();
        expect(namedTerminalTheme('')).toBeNull();
        expect(namedTerminalTheme(null)).toBeNull();
    });

    it('is what a `theme` line parses to, case preserved (§SET-105)', () => {
        // The parser keeps the value verbatim; the LOOKUP is what decides whether it selects.
        expect(parseGeneralSettings('theme = Catppuccin Mocha').theme).toBe('Catppuccin Mocha');
        expect(namedTerminalTheme(parseGeneralSettings('theme = Catppuccin Mocha').theme)?.id).toBe(
            'Catppuccin Mocha'
        );
        expect(namedTerminalTheme(parseGeneralSettings('theme = catppuccin mocha').theme)).toBeNull();
    });
});
