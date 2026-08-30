import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_KEYBINDINGS, actionForTrigger, parseKeyTrigger, parseKeybindOverrides, resolveKeyBindings } from '@kelpi/core/config';
import { DEFAULT_WS_SETTINGS } from '@kelpi/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
    GHOSTTY_CONFIG_PATH_ENV,
    SettingsError,
    buildSettingsSnapshot,
    contentAppearanceOf,
    createSettingsService,
    keybindLinesFrom,
    resolveGhosttyConfigPath,
    type SettingsService,
    type SettingsSnapshot
} from './service.js';

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const roots: string[] = [];
const services: SettingsService[] = [];

function tmpRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-settings-'));
    roots.push(root);
    return root;
}

interface Fixture {
    readonly root: string;
    readonly configPath: string;
    readonly ghosttyPath: string;
    readonly service: SettingsService;
    write(contents: string): void;
    writeGhostty(contents: string): void;
    read(): string | null;
}

function fixture(options: { config?: string; ghostty?: string; watch?: boolean } = {}): Fixture {
    const root = tmpRoot();
    const configPath = path.join(root, 'kelpi-config');
    const ghosttyPath = path.join(root, 'ghostty-config');
    if (options.config !== undefined) fs.writeFileSync(configPath, options.config, 'utf8');
    if (options.ghostty !== undefined) fs.writeFileSync(ghosttyPath, options.ghostty, 'utf8');
    const service = createSettingsService({
        configPath,
        ghosttyPath,
        watch: options.watch ?? false,
        debounceMs: 10,
        reattachDelayMs: 20,
        // §APP-014: pin the theme lookup inside this tmp root, so a machine with Ghostty
        // installed cannot resolve `theme = Nord` out of the real app bundle and repaint a
        // fixture's background from a file this test never wrote.
        env: { KELPID_GHOSTTY_THEME_DIRS: path.join(root, 'themes') },
        home: root
    });
    services.push(service);
    return {
        root,
        configPath,
        ghosttyPath,
        service,
        write: (contents) => fs.writeFileSync(configPath, contents, 'utf8'),
        writeGhostty: (contents) => fs.writeFileSync(ghosttyPath, contents, 'utf8'),
        read: () => (fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null)
    };
}

afterEach(() => {
    for (const service of services.splice(0)) service.dispose();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// ── path resolution ─────────────────────────────────────────────────────────────────

describe('resolveGhosttyConfigPath', () => {
    it('defaults to ~/.config/ghostty/config', () => {
        expect(resolveGhosttyConfigPath({ env: {}, home: '/Users/x' })).toBe(
            '/Users/x/.config/ghostty/config'
        );
    });

    it('honours KELPID_GHOSTTY_CONFIG, expanding ~', () => {
        expect(
            resolveGhosttyConfigPath({ env: { [GHOSTTY_CONFIG_PATH_ENV]: '~/alt/ghostty' }, home: '/Users/x' })
        ).toBe('/Users/x/alt/ghostty');
        expect(resolveGhosttyConfigPath({ env: { [GHOSTTY_CONFIG_PATH_ENV]: '/tmp/g' }, home: '/Users/x' })).toBe(
            '/tmp/g'
        );
    });
});

// ── the snapshot ────────────────────────────────────────────────────────────────────

describe('buildSettingsSnapshot', () => {
    it('is the documented defaults when both files are missing', () => {
        expect(buildSettingsSnapshot('', '')).toEqual(DEFAULT_WS_SETTINGS);
    });

    it('joins both files into one snapshot', () => {
        const snapshot = buildSettingsSnapshot(
            'focus-follows-mouse = true\nfocus-follows-mouse-delay = 250\ntheme = Nord\nkeybind = super+d=split_down\n',
            'background = #ffffff\nbackground-opacity = 0.9\nfont-size = 16\n'
        );
        expect(snapshot.general).toEqual({
            // Spread rather than restated: this assertion is about the three keys the fixture
            // sets and about `confirmWorkspaceDeleteWhenActive` defaulting on. Listing every
            // other key would make it a change-detector for the shape instead.
            ...DEFAULT_WS_SETTINGS.general,
            focusFollowsMouse: true,
            focusFollowsMouseDelay: 250,
            theme: 'Nord',
            // Not in the file → the default; only a literal `false` turns it off.
            confirmWorkspaceDeleteWhenActive: true
        });
        expect(snapshot.keybindLines).toEqual(['super+d=split_down']);
        expect(snapshot.appearance.backgroundColor).toBe('#ffffff');
        expect(snapshot.appearance.backgroundOpacity).toBe(0.9);
        expect(snapshot.appearance.fontSize).toBe(16);
        expect(snapshot.appearance.isDark).toBe(false);
    });

    /*
     * §SET-105 / §SET-216: the kelpi config's `theme` key is CONSUMED, not merely displayed.
     *
     * The Swift app resolved it through `KelpiTheme.named(id)` at launch and the resolved theme is
     * what the terminal used. Here the same lookup decides `appearance.theme` — the value the
     * Appearance picker shows, and what tells that tab a theme owns the background — under two
     * rules: ghostty's own file wins, and a name that is not a built-in selects nothing.
     */
    it('falls back to the kelpi config’s theme when ghostty names none (§SET-105)', () => {
        expect(buildSettingsSnapshot('theme = Nord\n', '').appearance.theme).toBe('Nord');
    });

    it('lets ghostty’s own theme line win over the kelpi key', () => {
        expect(buildSettingsSnapshot('theme = Nord\n', 'theme = Dracula\n').appearance.theme).toBe(
            'Dracula'
        );
    });

    it('selects NOTHING for a theme that is not a built-in (§SET-216)', () => {
        // Both are "no theme": the terminal keeps whatever ghostty already resolved rather than
        // being repainted from a value this port cannot look up.
        expect(buildSettingsSnapshot('theme = nord\n', '').appearance.theme).toBeNull();
        expect(buildSettingsSnapshot('theme = My Custom Theme\n', '').appearance.theme).toBeNull();
        // …and the raw value still rides `general` verbatim, so Settings can show what the file
        // actually says (§SET-105's parsing half).
        expect(buildSettingsSnapshot('theme = My Custom Theme\n', '').general.theme).toBe(
            'My Custom Theme'
        );
    });
});

describe('keybindLinesFrom', () => {
    it('emits canonical `<trigger>=<action>` values in file order, skipping junk', () => {
        expect(
            keybindLinesFrom(
                '# a comment\nkeybind = cmd+d=split_down\nkeybindx = super+q=close_pane\nkeybind = nonsense\nkeybind = super+e=unbind\ntheme = Nord\n'
            )
        ).toEqual(['super+d=split_down', 'super+e=unbind']);
    });

    it('feeds the client seam: the lines rebuild the same map the file resolves to', () => {
        const contents = 'keybind = ctrl+alt+t=split_right\nkeybind = super+d=unbind\n';
        const lines = keybindLinesFrom(contents);
        const fromLines = resolveKeyBindings(parseKeybindOverrides(lines.map((line) => `keybind = ${line}`).join('\n')));
        const fromFile = resolveKeyBindings(parseKeybindOverrides(contents));
        const trigger = parseKeyTrigger('ctrl+alt+t');
        expect(trigger).not.toBeNull();
        expect(actionForTrigger(fromLines, trigger!)).toBe('split_right');
        expect(actionForTrigger(fromFile, trigger!)).toBe('split_right');
        expect(actionForTrigger(fromLines, parseKeyTrigger('super+d')!)).toBeNull();
    });
});

describe('contentAppearanceOf', () => {
    it('is exactly what ContentService.setAppearance takes', () => {
        const snapshot = buildSettingsSnapshot('', 'background = #ffffff\nbackground-opacity = 0.5\n');
        expect(contentAppearanceOf(snapshot)).toEqual({
            backgroundColor: '#ffffff',
            backgroundOpacity: 0.5
        });
    });
});

// ── reading ─────────────────────────────────────────────────────────────────────────

describe('createSettingsService (reads)', () => {
    it('reads both files at construction', () => {
        const { service } = fixture({
            config: 'focus-follows-mouse = true\n',
            ghostty: 'background = #ffffff\n'
        });
        expect(service.snapshot.general.focusFollowsMouse).toBe(true);
        expect(service.snapshot.appearance.isDark).toBe(false);
    });

    it('treats missing files as defaults, not as an error', () => {
        const { service } = fixture();
        expect(service.snapshot).toEqual(DEFAULT_WS_SETTINGS);
    });

    it('reload() picks up edits and notifies only on a real change', () => {
        const f = fixture({ config: 'theme = Nord\n' });
        const seen: SettingsSnapshot[] = [];
        f.service.subscribe((snapshot) => seen.push(snapshot));

        f.service.reload();
        expect(seen).toHaveLength(0);

        f.write('theme = Dracula\n');
        f.service.reload();
        expect(seen).toHaveLength(1);
        expect(seen[0]?.general.theme).toBe('Dracula');

        // A byte-identical rewrite (a `touch`, an editor that saves an unchanged buffer).
        f.write('theme = Dracula\n');
        f.service.reload();
        expect(seen).toHaveLength(1);
    });

    it('unsubscribes cleanly', () => {
        const f = fixture({ config: 'theme = Nord\n' });
        let calls = 0;
        const off = f.service.subscribe(() => {
            calls += 1;
        });
        off();
        f.write('theme = Dracula\n');
        f.service.reload();
        expect(calls).toBe(0);
    });
});

// ── watching ────────────────────────────────────────────────────────────────────────

describe('createSettingsService (watching)', () => {
    const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> => {
        const deadline = Date.now() + timeoutMs;
        while (!predicate()) {
            if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
            await tick(25);
        }
    };

    it('pushes a kelpi-config edit without anyone asking', async () => {
        const f = fixture({ config: 'theme = Nord\n', watch: true });
        const seen: SettingsSnapshot[] = [];
        f.service.subscribe((snapshot) => seen.push(snapshot));
        await tick(50);
        f.write('theme = Dracula\nkeybind = ctrl+alt+t=split_right\n');
        await waitFor(() => seen.length > 0, 'the config change');
        expect(f.service.snapshot.general.theme).toBe('Dracula');
        expect(f.service.snapshot.keybindLines).toEqual(['ctrl+alt+t=split_right']);
    });

    it('pushes a ghostty-config edit (the theme-change path)', async () => {
        const f = fixture({ ghostty: 'background = #000000\n', watch: true });
        const seen: SettingsSnapshot[] = [];
        f.service.subscribe((snapshot) => seen.push(snapshot));
        await tick(50);
        f.writeGhostty('background = #ffffff\nbackground-opacity = 0.8\n');
        await waitFor(() => seen.length > 0, 'the ghostty change');
        expect(f.service.snapshot.appearance.isDark).toBe(false);
        expect(f.service.snapshot.appearance.backgroundOpacity).toBe(0.8);
    });

    it('survives an atomic rename over the config (the editor save dance)', async () => {
        const f = fixture({ config: 'theme = Nord\n', watch: true });
        const seen: SettingsSnapshot[] = [];
        f.service.subscribe((snapshot) => seen.push(snapshot));
        await tick(50);
        const temp = path.join(f.root, 'kelpi-config.swap');
        fs.writeFileSync(temp, 'theme = Dracula\n', 'utf8');
        fs.renameSync(temp, f.configPath);
        await waitFor(() => seen.length > 0, 'the renamed config');
        expect(f.service.snapshot.general.theme).toBe('Dracula');

        // …and the re-attached watch still works for the KELPIT edit.
        const before = seen.length;
        f.write('theme = Gruvbox Dark\n');
        await waitFor(() => seen.length > before, 'the post-rename edit');
        expect(f.service.snapshot.general.theme).toBe('Gruvbox Dark');
    });

    it('notices a ghostty config that did not exist at boot', async () => {
        const f = fixture({ config: 'theme = Nord\n', watch: true });
        const seen: SettingsSnapshot[] = [];
        f.service.subscribe((snapshot) => seen.push(snapshot));
        expect(f.service.snapshot.appearance.backgroundColor).toBe(
            DEFAULT_WS_SETTINGS.appearance.backgroundColor
        );
        await tick(50);
        f.writeGhostty('background = #ffffff\n');
        await waitFor(() => seen.length > 0, 'the created ghostty config');
        expect(f.service.snapshot.appearance.backgroundColor).toBe('#ffffff');
    });

    it('stops watching after dispose', async () => {
        const f = fixture({ config: 'theme = Nord\n', watch: true });
        let calls = 0;
        f.service.subscribe(() => {
            calls += 1;
        });
        await tick(50);
        f.service.dispose();
        f.write('theme = Dracula\n');
        await tick(300);
        expect(calls).toBe(0);
    });
});

// ── write-through mutations ─────────────────────────────────────────────────────────

const PRESERVED = `# my kelpi config
focus-follows-mouse = true

# terminal
theme = Nord

keybind = super+d=split_down

profile = work:CLAUDE_CONFIG_DIR=/tmp/work
`;

describe('createSettingsService (write-through)', () => {
    it('setKeybinding writes the file and re-reads it into the snapshot', () => {
        const f = fixture({ config: PRESERVED });
        const next = f.service.setKeybinding('split_right', 'ctrl+alt+t');
        expect(next.keybindLines).toContain('ctrl+alt+t=split_right');
        expect(f.read()).toContain('keybind = ctrl+alt+t=split_right');
        // The change survives a fresh read of the file, which is the whole point.
        expect(f.service.reload().keybindLines).toEqual(next.keybindLines);
    });

    it('preserves comments and unrelated lines byte-for-byte through a keybind write', () => {
        const f = fixture({ config: PRESERVED });
        f.service.setKeybinding('split_right', 'ctrl+alt+t');
        const after = f.read() ?? '';
        expect(after).toContain('# my kelpi config');
        expect(after).toContain('# terminal');
        expect(after).toContain('focus-follows-mouse = true');
        expect(after).toContain('theme = Nord');
        expect(after).toContain('profile = work:CLAUDE_CONFIG_DIR=/tmp/work');
        // The prior override is still in force, so it is still written.
        expect(after).toContain('keybind = super+d=split_down');
    });

    it('setKeybinding(action, null) unbinds every trigger the action holds', () => {
        const f = fixture({ config: 'keybind = ctrl+alt+t=split_right\n' });
        const next = f.service.setKeybinding('split_right', null);
        expect(next.keybindLines).not.toContain('ctrl+alt+t=split_right');
        // `split_right`'s shipped default (super+d) is now bound to nothing → an unbind line.
        expect(f.read()).toContain('keybind = super+d=unbind');
    });

    it('resetKeybindings(null) returns the file to zero keybind lines', () => {
        const f = fixture({ config: PRESERVED });
        f.service.setKeybinding('split_right', 'ctrl+alt+t');
        const next = f.service.resetKeybindings(null);
        expect(next.keybindLines).toEqual([]);
        const after = f.read() ?? '';
        expect(after).not.toContain('keybind');
        expect(after).toContain('theme = Nord');
        expect(after).toContain('profile = work:CLAUDE_CONFIG_DIR=/tmp/work');
    });

    it('resetKeybindings(null) deletes a file that held nothing else (§5.3)', () => {
        const f = fixture({ config: 'keybind = ctrl+alt+t=split_right\n' });
        expect(f.service.resetKeybindings(null).keybindLines).toEqual([]);
        expect(f.read()).toBeNull();
    });

    it('resetKeybindings(action) restores just that action, stealing its default back', () => {
        // super+d is split_right's default; the user gave it to split_down.
        const f = fixture({ config: 'keybind = super+d=split_down\n' });
        const before = resolveKeyBindings(parseKeybindOverrides(f.read() ?? ''));
        expect(actionForTrigger(before, parseKeyTrigger('super+d')!)).toBe('split_down');

        f.service.resetKeybindings('split_right');
        const after = resolveKeyBindings(parseKeybindOverrides(f.read() ?? ''));
        expect(actionForTrigger(after, parseKeyTrigger('super+d')!)).toBe('split_right');
        expect(actionForTrigger(after, parseKeyTrigger('shift+super+d')!)).toBe(
            actionForTrigger(DEFAULT_KEYBINDINGS, parseKeyTrigger('shift+super+d')!)
        );
    });

    it('setGeneralSetting rewrites one line and leaves the rest alone', () => {
        const f = fixture({ config: PRESERVED });
        const next = f.service.setGeneralSetting('focus-follows-mouse-delay', '250');
        expect(next.general.focusFollowsMouseDelay).toBe(250);
        const after = f.read() ?? '';
        expect(after).toContain('focus-follows-mouse = true');
        expect(after).toContain('focus-follows-mouse-delay = 250');
        expect(after).toContain('keybind = super+d=split_down');
        expect(after).toContain('profile = work:CLAUDE_CONFIG_DIR=/tmp/work');
    });

    /**
     * §TERM-046. The gate has to be writable through the same verb the Settings toggle uses —
     * and, because it is a security posture rather than a preference, it has to read OFF on a
     * config file that has never heard of it, and OFF again the moment it is turned back off.
     */
    it('round-trips the OSC 52 clipboard gate, which is off until the file says otherwise', () => {
        const f = fixture({ config: PRESERVED });
        expect(f.service.snapshot.general.clipboardWrite).toBe(false);

        expect(f.service.setGeneralSetting('clipboard-write', 'true').general.clipboardWrite).toBe(true);
        expect(f.read() ?? '').toContain('clipboard-write = true');
        // Every unrelated line survives, as with every other writer here.
        expect(f.read() ?? '').toContain('keybind = super+d=split_down');

        expect(f.service.setGeneralSetting('clipboard-write', 'false').general.clipboardWrite).toBe(false);
        expect(f.read() ?? '').toContain('clipboard-write = false');
    });

    it('creates the config file (and its directory) when there is none', () => {
        const root = tmpRoot();
        const configPath = path.join(root, 'nested', 'deeper', 'config');
        const service = createSettingsService({ configPath, ghosttyPath: path.join(root, 'g'), watch: false });
        services.push(service);
        service.setGeneralSetting('focus-follows-mouse', 'true');
        expect(fs.readFileSync(configPath, 'utf8')).toBe('focus-follows-mouse = true\n');
    });

    it('refuses to write `theme` (§1.3: the app never writes it back)', () => {
        const f = fixture({ config: PRESERVED });
        expect(() => f.service.setGeneralSetting('theme', 'Dracula')).toThrow(SettingsError);
        expect(f.read()).toBe(PRESERVED);
    });

    it('refuses an unknown action and an unparseable trigger without touching the file', () => {
        const f = fixture({ config: PRESERVED });
        expect(() => f.service.setKeybinding('not_an_action', 'ctrl+alt+t')).toThrow(/unknown action/);
        expect(() => f.service.setKeybinding('split_right', 'ctrl+alt+nope')).toThrow(/unparseable trigger/);
        expect(() => f.service.resetKeybindings('not_an_action')).toThrow(/unknown action/);
        expect(f.read()).toBe(PRESERVED);
    });

    it('notifies subscribers with the post-write snapshot', () => {
        const f = fixture({ config: PRESERVED });
        const seen: SettingsSnapshot[] = [];
        f.service.subscribe((snapshot) => seen.push(snapshot));
        const returned = f.service.setGeneralSetting('focus-follows-mouse', 'false');
        expect(seen).toHaveLength(1);
        expect(seen[0]).toBe(returned);
        expect(returned.general.focusFollowsMouse).toBe(false);
    });

    it('a write-through change reaches subscribers exactly once even with the watcher live', async () => {
        const f = fixture({ config: PRESERVED, watch: true });
        const seen: SettingsSnapshot[] = [];
        f.service.subscribe((snapshot) => seen.push(snapshot));
        await tick(50);
        f.service.setKeybinding('split_right', 'ctrl+alt+t');
        // The watcher fires shortly after, finds the same snapshot, and stays quiet.
        await tick(400);
        expect(seen).toHaveLength(1);
    });
});

// ── set-ghostty-setting (SET-039…SET-041) ───────────────────────────────────────────

/**
 * The appearance half of Settings writes a file the daemon does not own. The tests that matter
 * are therefore about the file it did NOT change: a user's ghostty config is large, personal,
 * and mostly keys this codebase deliberately cannot read.
 */
describe('setGhosttySetting', () => {
    const GHOSTTY = [
        '# personal ghostty config',
        'theme = Catppuccin Mocha',
        'font-size = 13',
        'keybind = super+t=new_tab',
        'window-padding-x = 8',
        ''
    ].join('\n');

    const readGhostty = (f: Fixture): string =>
        fs.existsSync(f.ghosttyPath) ? fs.readFileSync(f.ghosttyPath, 'utf8') : '';

    it('writes a key and re-reads it into the snapshot', () => {
        const f = fixture({ ghostty: GHOSTTY });
        const next = f.service.setGhosttySetting('background', '#1a1b26');
        expect(next.appearance.backgroundColor).toBe('#1a1b26');
        // The luminance verdict is recomputed from the value actually on disk.
        expect(next.appearance.isDark).toBe(true);
        expect(f.service.snapshot).toBe(next);
    });

    it('preserves every unrelated line byte-for-byte', () => {
        const f = fixture({ ghostty: GHOSTTY });
        f.service.setGhosttySetting('font-size', '16');
        const contents = readGhostty(f);
        expect(contents).toContain('# personal ghostty config');
        expect(contents).toContain('theme = Catppuccin Mocha');
        expect(contents).toContain('keybind = super+t=new_tab');
        expect(contents).toContain('window-padding-x = 8');
        expect(contents).toContain('font-size = 16');
        expect(contents).not.toContain('font-size = 13');
    });

    it('removes the key when the value is null (SET-040’s “no theme”)', () => {
        const f = fixture({ ghostty: GHOSTTY });
        const next = f.service.setGhosttySetting('theme', null);
        expect(next.appearance.theme).toBeNull();
        expect(readGhostty(f)).not.toContain('theme =');
        expect(readGhostty(f)).toContain('font-size = 13');
    });

    it('creates the ghostty file when there is none', () => {
        const f = fixture();
        const next = f.service.setGhosttySetting('background-opacity', '0.8');
        expect(next.appearance.backgroundOpacity).toBeCloseTo(0.8);
        expect(readGhostty(f)).toBe('background-opacity = 0.8\n');
    });

    it('refuses a key it cannot read back, rather than writing something invisible', () => {
        const f = fixture({ ghostty: GHOSTTY });
        expect(() => f.service.setGhosttySetting('window-padding-x', '16')).toThrow(SettingsError);
        // Nothing was written.
        expect(readGhostty(f)).toBe(GHOSTTY);
    });

    it('collapses accumulating font-family lines to the one that was asked for', () => {
        const f = fixture({ ghostty: 'font-family = JetBrains Mono\nfont-family = Symbols Nerd Font\n' });
        const next = f.service.setGhosttySetting('font-family', 'Menlo');
        // Not "Menlo, Symbols Nerd Font": ghostty ACCUMULATES these lines, so leaving the old
        // one behind would mean "set the font" silently appended one.
        expect(next.appearance.fontFamily).toBe('Menlo');
        expect(readGhostty(f).match(/font-family/g)).toHaveLength(1);
    });

    it('notifies subscribers exactly once per write', () => {
        const f = fixture({ ghostty: GHOSTTY });
        const seen: SettingsSnapshot[] = [];
        f.service.subscribe((snapshot) => seen.push(snapshot));
        const returned = f.service.setGhosttySetting('background', '#ffffff');
        expect(seen).toHaveLength(1);
        expect(seen[0]).toBe(returned);
        // A white background flips the daemon's light/dark verdict, which is what the client
        // chrome and the daemon's own markdown/diff HTML both key off.
        expect(returned.appearance.isDark).toBe(false);
    });
});

// ── the chrome / status-bar settings (SET-023…SET-044) ──────────────────────────────

describe('chrome settings in the snapshot', () => {
    it('are the shipped defaults when the config names none of them', () => {
        const f = fixture({ config: '' });
        expect(f.service.snapshot.chrome).toEqual(DEFAULT_WS_SETTINGS.chrome);
    });

    it('round-trip through set-general-setting', () => {
        const f = fixture({ config: 'focus-follows-mouse = true\n' });
        f.service.setGeneralSetting('chrome-appearance', 'dark');
        f.service.setGeneralSetting('chrome-colors', '{"dark:accent":"BD93F9"}');
        f.service.setGeneralSetting('system-stats', 'cpu,network');
        const next = f.service.setGeneralSetting('sparkline-width', '44');
        expect(next.chrome.appearance).toBe('dark');
        expect(next.chrome.colors).toEqual({ 'dark:accent': 'BD93F9' });
        expect(next.chrome.enabledSystemStats).toEqual(['cpu', 'network']);
        expect(next.chrome.sparklineWidth).toBe(44);
        // The unrelated key the file already had is untouched.
        expect(next.general.focusFollowsMouse).toBe(true);
    });

    it('carry the General tab’s keys too', () => {
        const f = fixture({ config: '' });
        const next = f.service.setGeneralSetting('worktree-base-path', '<repo>/.worktrees');
        expect(next.general.worktreeBasePath).toBe('<repo>/.worktrees');
        expect(f.service.setGeneralSetting('new-workspace-placement', 'near-selection').general
            .newWorkspacePlacement).toBe('near-selection');
        expect(f.service.setGeneralSetting('global-hotkey', 'ctrl+alt+space').general.globalHotkey).toBe(
            'ctrl+alt+space'
        );
    });
});
