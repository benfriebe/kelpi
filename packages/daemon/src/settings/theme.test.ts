/**
 * §APP-014 — `theme = <name>` resolved to a real palette, and the note when it cannot be.
 *
 * The fixtures below are the shipped app's own file format, not an invention: `kelpi 0.32.0`
 * carries the ten built-in themes as ghostty theme FILES inside its bundle
 * (`Kelpi.app/Contents/Resources/ghostty/themes/<id>`, pointed at by `GHOSTTY_RESOURCES_DIR`),
 * each written as `palette = N=#hex` lines plus `background` / `foreground` / `cursor-color` /
 * `cursor-text` / `selection-background` / `selection-foreground`. That is exactly what
 * libghostty resolved for the Swift app and exactly what this module has to read.
 *
 * **Every path in this file is inside a `mkdtemp`.** `themeSearchDirs` takes `home` and `env`,
 * the tests pass a fake home, and the "nothing outside the sandbox" test asserts it by
 * recording every path the resolver asks for — so a machine with Ghostty (or Kelpi) installed
 * cannot make these tests pass for the wrong reason, and the developer's real
 * `~/.config/ghostty` is never read.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_WS_TERMINAL_THEME } from '@kelpi/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { buildSettingsSnapshot, createSettingsService, type SettingsService } from './service.js';
import {
    GHOSTTY_THEME_DIRS_ENV,
    parseGhosttyThemePalette,
    parsePaletteEntry,
    resolveGhosttyTheme,
    selectThemeName,
    themeSearchDirs
} from './theme.js';

// ── fixtures ────────────────────────────────────────────────────────────────────────

/** `Kelpi.app/Contents/Resources/ghostty/themes/Nord`, transcribed. */
const NORD = `palette = 0=#3b4252
palette = 1=#bf616a
palette = 2=#a3be8c
palette = 3=#ebcb8b
palette = 4=#81a1c1
palette = 5=#b48ead
palette = 6=#88c0d0
palette = 7=#e5e9f0
palette = 8=#596377
palette = 9=#bf616a
palette = 10=#a3be8c
palette = 11=#ebcb8b
palette = 12=#81a1c1
palette = 13=#b48ead
palette = 14=#8fbcbb
palette = 15=#eceff4
background = #2e3440
foreground = #d8dee9
cursor-color = #eceff4
cursor-text = #282828
selection-background = #eceff4
selection-foreground = #4c566a
`;

/** A light theme, so the background actually flips the daemon's luminance verdict. */
const LATTE = `background = #eff1f5
foreground = #4c4f69
palette = 1=#d20f39
`;

/** Not a theme: a real file that carries nothing this reader understands. */
const MALFORMED = `# a half-finished theme
palette = seventeen
background =
window-padding-x = 8
this line has no equals sign
`;

const roots: string[] = [];
const services: SettingsService[] = [];

function tmpRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-theme-'));
    roots.push(root);
    return root;
}

/** A fake HOME with a `.config/ghostty/themes` inside it, plus whatever themes are named. */
function themeHome(themes: Readonly<Record<string, string>> = {}): { home: string; dir: string } {
    const home = tmpRoot();
    const dir = path.join(home, '.config', 'ghostty', 'themes');
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, contents] of Object.entries(themes)) {
        fs.writeFileSync(path.join(dir, name), contents, 'utf8');
    }
    return { home, dir };
}

afterEach(() => {
    for (const service of services.splice(0)) service.dispose();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// ── the file format ─────────────────────────────────────────────────────────────────

describe('parsePaletteEntry', () => {
    it('reads the `palette = N=#hex` form ghostty writes', () => {
        expect(parsePaletteEntry('0=#3b4252')).toEqual({ index: 0, color: '#3b4252' });
        expect(parsePaletteEntry(' 15 = eceff4 ')).toEqual({ index: 15, color: '#eceff4' });
        expect(parsePaletteEntry('3=#abc')).toEqual({ index: 3, color: '#aabbcc' });
    });

    it('refuses an index outside 0..15 and anything that is not a colour', () => {
        expect(parsePaletteEntry('16=#000000')).toBeNull();
        expect(parsePaletteEntry('-1=#000000')).toBeNull();
        expect(parsePaletteEntry('0=mauve')).toBeNull();
        expect(parsePaletteEntry('nonsense')).toBeNull();
        expect(parsePaletteEntry('')).toBeNull();
    });
});

describe('parseGhosttyThemePalette', () => {
    it('maps a real theme file onto the client’s palette keys', () => {
        const palette = parseGhosttyThemePalette(NORD);
        expect(palette.background).toBe('#2e3440');
        expect(palette.foreground).toBe('#d8dee9');
        expect(palette.cursor).toBe('#eceff4');
        expect(palette.cursorAccent).toBe('#282828');
        expect(palette.selectionBackground).toBe('#eceff4');
        expect(palette.selectionForeground).toBe('#4c566a');
        // `palette = 0..7` are the ANSI eight, `8..15` the bright eight, in that order.
        expect(palette.black).toBe('#3b4252');
        expect(palette.red).toBe('#bf616a');
        expect(palette.white).toBe('#e5e9f0');
        expect(palette.brightBlack).toBe('#596377');
        expect(palette.brightWhite).toBe('#eceff4');
        expect(Object.keys(palette)).toHaveLength(22);
    });

    it('returns ONLY the keys the file defines, so a partial theme stays partial', () => {
        // Three keys, three entries: the client merges these over its own preset rather than
        // treating the absence of `cursor-color` as "no cursor colour".
        expect(parseGhosttyThemePalette(LATTE)).toEqual({
            background: '#eff1f5',
            foreground: '#4c4f69',
            red: '#d20f39'
        });
    });

    it('is empty for a file with nothing colour-shaped in it', () => {
        expect(parseGhosttyThemePalette(MALFORMED)).toEqual({});
        expect(parseGhosttyThemePalette('')).toEqual({});
    });

    it('ignores keys that are not palette keys, and lets a later line win', () => {
        const palette = parseGhosttyThemePalette(
            'font-size = 22\nbackground = #111111\nbackground = #222222\nkeybind = cmd+t=new_tab\n'
        );
        expect(palette).toEqual({ background: '#222222' });
    });
});

describe('selectThemeName', () => {
    it('passes a plain name through untouched', () => {
        expect(selectThemeName('Catppuccin Mocha', true)).toBe('Catppuccin Mocha');
        expect(selectThemeName('  Nord  ', false)).toBe('Nord');
        expect(selectThemeName('', true)).toBeNull();
        expect(selectThemeName(null, true)).toBeNull();
    });

    it('splits ghostty’s `dark:X,light:Y` on the daemon’s own luminance verdict', () => {
        expect(selectThemeName('dark:Nord,light:Catppuccin Latte', true)).toBe('Nord');
        expect(selectThemeName('dark:Nord,light:Catppuccin Latte', false)).toBe('Catppuccin Latte');
        expect(selectThemeName('light:Gruvbox Light , dark:Gruvbox Dark', true)).toBe('Gruvbox Dark');
    });

    it('falls back to the half that IS named when only one is', () => {
        expect(selectThemeName('dark:Nord', false)).toBe('Nord');
    });
});

// ── where a theme can live ──────────────────────────────────────────────────────────

describe('themeSearchDirs', () => {
    it('looks beside the config file the daemon actually read, first', () => {
        const dirs = themeSearchDirs({
            env: {},
            home: '/Users/x',
            ghosttyPath: '/Users/x/.config/ghostty/config'
        });
        expect(dirs[0]).toBe('/Users/x/.config/ghostty/themes');
        expect(dirs).toContain('/Users/x/Library/Application Support/com.mitchellh.ghostty/themes');
        expect(dirs).toContain('/Applications/Ghostty.app/Contents/Resources/ghostty/themes');
        // The config dir and ~/.config/ghostty/themes are the same path here: named once.
        expect(new Set(dirs).size).toBe(dirs.length);
    });

    it('honours XDG_CONFIG_HOME and GHOSTTY_RESOURCES_DIR', () => {
        const dirs = themeSearchDirs({
            env: { XDG_CONFIG_HOME: '~/xdg', GHOSTTY_RESOURCES_DIR: '/opt/ghostty/share' },
            home: '/Users/x',
            ghosttyPath: '/Users/x/xdg/ghostty/config'
        });
        expect(dirs).toContain('/Users/x/xdg/ghostty/themes');
        // The shipped app's own mechanism: `kelpi 0.32.0` exports GHOSTTY_RESOURCES_DIR at
        // `Kelpi.app/Contents/Resources/ghostty`, whose `themes/` holds the ten built-ins.
        expect(dirs).toContain('/opt/ghostty/share/themes');
    });

    it('is replaced entirely by KELPID_GHOSTTY_THEME_DIRS — the test/sandbox seam', () => {
        const dirs = themeSearchDirs({
            env: { [GHOSTTY_THEME_DIRS_ENV]: '~/a: /b/c :' },
            home: '/Users/x',
            ghosttyPath: '/Users/x/.config/ghostty/config'
        });
        expect(dirs).toEqual(['/Users/x/a', '/b/c']);
    });
});

// ── resolution, against real files ──────────────────────────────────────────────────

describe('resolveGhosttyTheme', () => {
    it('finds a theme in the user’s ghostty themes directory and returns its palette', () => {
        const { home, dir } = themeHome({ Nord: NORD });
        const resolved = resolveGhosttyTheme('Nord', {
            env: {},
            home,
            ghosttyPath: path.join(home, '.config', 'ghostty', 'config')
        });
        expect(resolved.error).toBeNull();
        expect(resolved.name).toBe('Nord');
        expect(resolved.path).toBe(path.join(dir, 'Nord'));
        expect(resolved.palette.background).toBe('#2e3440');
        expect(resolved.palette.brightWhite).toBe('#eceff4');
    });

    /**
     * The ids really are filenames with spaces in them (`Catppuccin Latte`, `iTerm2 Solarized
     * Dark`), and the name is used VERBATIM — no slugging, no case folding of our own.
     *
     * Whether `catppuccin latte` also opens that file is the filesystem's business, not this
     * module's: APFS is case-insensitive by default and ext4 is not, and libghostty had exactly
     * the same property. §SET-216's case-sensitive gate is the KELPI config key's (an exact match
     * against the ten built-ins, covered in `service.test.ts`), which is a different question
     * from what `open(2)` does.
     */
    it('uses the name verbatim as a filename, spaces and all', () => {
        const { home, dir } = themeHome({ 'Catppuccin Latte': LATTE });
        const options = { env: {}, home, ghosttyPath: path.join(home, '.config', 'ghostty', 'config') };
        const resolved = resolveGhosttyTheme('Catppuccin Latte', options);
        expect(resolved.palette.background).toBe('#eff1f5');
        expect(resolved.path).toBe(path.join(dir, 'Catppuccin Latte'));
        // A name nothing on disk answers to is a NOTE, never a nearest-match guess.
        const missing = resolveGhosttyTheme('Catppuccin Latte 2', options);
        expect(missing.palette).toEqual({});
        expect(missing.error).toContain('Catppuccin Latte 2');
    });

    it('says so when the file exists but is not a theme (the malformed case)', () => {
        const { home, dir } = themeHome({ Broken: MALFORMED });
        const resolved = resolveGhosttyTheme('Broken', {
            env: {},
            home,
            ghosttyPath: path.join(home, '.config', 'ghostty', 'config')
        });
        expect(resolved.palette).toEqual({});
        expect(resolved.path).toBe(path.join(dir, 'Broken'));
        expect(resolved.error).toContain('defines no colours');
        // The note names the file, because "your theme is broken" without a path is unusable.
        expect(resolved.error).toContain(path.join(dir, 'Broken'));
    });

    it('says so when nothing named that exists anywhere on the search path', () => {
        const { home } = themeHome();
        const resolved = resolveGhosttyTheme('Definitely Not Installed', {
            env: { [GHOSTTY_THEME_DIRS_ENV]: path.join(home, '.config', 'ghostty', 'themes') },
            home
        });
        expect(resolved.name).toBe('Definitely Not Installed');
        expect(resolved.path).toBeNull();
        expect(resolved.palette).toEqual({});
        expect(resolved.error).toContain('Definitely Not Installed');
        expect(resolved.error).toContain('themes');
    });

    it('is the neutral answer when no theme is configured at all', () => {
        expect(resolveGhosttyTheme(null, { env: {}, home: '/nope' })).toEqual(DEFAULT_WS_TERMINAL_THEME);
        expect(resolveGhosttyTheme('   ', { env: {}, home: '/nope' })).toEqual(DEFAULT_WS_TERMINAL_THEME);
    });

    it('refuses a name that is a path, so `theme = …` can never read an arbitrary file', () => {
        const { home } = themeHome();
        const resolved = resolveGhosttyTheme('../../.ssh/id_rsa', {
            env: {},
            home,
            ghosttyPath: path.join(home, '.config', 'ghostty', 'config')
        });
        expect(resolved.path).toBeNull();
        expect(resolved.error).toContain('not a valid theme name');
    });

    it('picks the dark/light half against real files', () => {
        const { home } = themeHome({ Nord: NORD, 'Catppuccin Latte': LATTE });
        const options = { env: {}, home, ghosttyPath: path.join(home, '.config', 'ghostty', 'config') };
        expect(
            resolveGhosttyTheme('dark:Nord,light:Catppuccin Latte', { ...options, isDark: true }).palette
                .background
        ).toBe('#2e3440');
        expect(
            resolveGhosttyTheme('dark:Nord,light:Catppuccin Latte', { ...options, isDark: false }).palette
                .background
        ).toBe('#eff1f5');
    });

    /**
     * The sandbox rule, asserted rather than assumed: with a fake home, NOTHING the resolver
     * touches may live under the real one — not the miss path (which walks the whole search
     * list) and not the hit path.
     */
    it('reads nothing outside the fake home it was given', () => {
        const { home } = themeHome({ Nord: NORD });
        const asked: string[] = [];
        const record = (file: string): string | null => {
            asked.push(file);
            try {
                return fs.readFileSync(file, 'utf8');
            } catch {
                return null;
            }
        };
        const options = {
            env: {},
            home,
            ghosttyPath: path.join(home, '.config', 'ghostty', 'config'),
            readFile: record
        };
        expect(resolveGhosttyTheme('Nord', options).palette.background).toBe('#2e3440');
        expect(resolveGhosttyTheme('Nothing Here', options).error).not.toBeNull();
        expect(asked.length).toBeGreaterThan(1);
        const realHome = os.homedir();
        expect(asked.filter((file) => file.startsWith(`${realHome}/`))).toEqual([]);
        // And the fake home is genuinely a mkdtemp one, not the real home by another name.
        expect(home.startsWith(os.tmpdir())).toBe(true);
        expect(fs.existsSync(path.join(realHome, '.config', 'ghostty', 'themes', 'Nord'))).toBe(false);
    });
});

// ── the snapshot, and the live service ──────────────────────────────────────────────

describe('buildSettingsSnapshot with a theme resolver', () => {
    const resolver = (palette: Record<string, string>, error: string | null = null) =>
        (name: string | null) => ({ name, path: name === null ? null : `/themes/${name}`, palette, error });

    it('takes the theme’s background when the ghostty config names none', () => {
        const snapshot = buildSettingsSnapshot('', 'theme = Nord\n', {
            resolveTheme: resolver({ background: '#2e3440', foreground: '#d8dee9' })
        });
        expect(snapshot.appearance.backgroundColor).toBe('#2e3440');
        expect(snapshot.appearance.terminalTheme.palette.foreground).toBe('#d8dee9');
        expect(snapshot.appearance.isDark).toBe(true);
    });

    it('lets an explicit `background` line outrank the theme (§SET-217/§SET-218)', () => {
        const snapshot = buildSettingsSnapshot('', 'theme = Nord\nbackground = #ffffff\n', {
            resolveTheme: resolver({ background: '#2e3440' })
        });
        expect(snapshot.appearance.backgroundColor).toBe('#ffffff');
        // The palette still rides the snapshot — only the BACKGROUND was outranked.
        expect(snapshot.appearance.terminalTheme.palette.background).toBe('#2e3440');
        expect(snapshot.appearance.isDark).toBe(false);
    });

    it('flips the light/dark verdict when a LIGHT theme supplies the background', () => {
        const snapshot = buildSettingsSnapshot('', 'theme = Catppuccin Latte\n', {
            resolveTheme: resolver({ background: '#eff1f5' })
        });
        expect(snapshot.appearance.isDark).toBe(false);
    });

    it('keeps today’s behaviour, plus a note, when the name does not resolve', () => {
        const snapshot = buildSettingsSnapshot('', 'theme = Made Up\n', {
            resolveTheme: (name) => ({ name, path: null, palette: {}, error: 'no such theme' })
        });
        expect(snapshot.appearance.backgroundColor).toBe('#0a0a0c');
        expect(snapshot.appearance.terminalTheme.error).toBe('no such theme');
        expect(snapshot.appearance.theme).toBe('Made Up');
    });

    it('resolves nothing at all without a resolver — the function stays pure', () => {
        expect(buildSettingsSnapshot('', 'theme = Nord\n').appearance.terminalTheme).toEqual(
            DEFAULT_WS_TERMINAL_THEME
        );
    });

    /** §SET-216: a kelpi `theme` key that is not one of the ten never reaches the lookup. */
    it('does not look up a non-built-in name from the KELPI config', () => {
        const asked: (string | null)[] = [];
        buildSettingsSnapshot('theme = My Custom Theme\n', '', {
            resolveTheme: (name) => {
                asked.push(name);
                return { name, path: null, palette: {}, error: null };
            }
        });
        expect(asked).toEqual([null]);
    });
});

describe('createSettingsService (theme files on disk)', () => {
    function service(options: { config?: string; ghostty?: string } = {}): {
        service: SettingsService;
        home: string;
        themes: string;
        writeGhostty(contents: string): void;
    } {
        const home = tmpRoot();
        const themes = path.join(home, '.config', 'ghostty', 'themes');
        fs.mkdirSync(themes, { recursive: true });
        const configPath = path.join(home, 'kelpi-config');
        const ghosttyPath = path.join(home, '.config', 'ghostty', 'config');
        fs.writeFileSync(configPath, options.config ?? '', 'utf8');
        fs.writeFileSync(ghosttyPath, options.ghostty ?? '', 'utf8');
        const created = createSettingsService({
            configPath,
            ghosttyPath,
            watch: false,
            env: { [GHOSTTY_THEME_DIRS_ENV]: themes },
            home
        });
        services.push(created);
        return {
            service: created,
            home,
            themes,
            writeGhostty: (contents) => fs.writeFileSync(ghosttyPath, contents, 'utf8')
        };
    }

    it('serves the resolved palette on the snapshot every client reads', () => {
        const f = service({ ghostty: 'theme = Nord\n' });
        fs.writeFileSync(path.join(f.themes, 'Nord'), NORD, 'utf8');
        const snapshot = f.service.reload();
        expect(snapshot.appearance.theme).toBe('Nord');
        expect(snapshot.appearance.terminalTheme.palette.foreground).toBe('#d8dee9');
        expect(snapshot.appearance.backgroundColor).toBe('#2e3440');
        expect(snapshot.appearance.terminalTheme.error).toBeNull();
    });

    /** §SET-105: the KELPI config's key is the fallback, and it resolves the same way. */
    it('resolves the kelpi config’s `theme` key when ghostty names none', () => {
        const f = service({ config: 'theme = Nord\n' });
        fs.writeFileSync(path.join(f.themes, 'Nord'), NORD, 'utf8');
        expect(f.service.reload().appearance.terminalTheme.palette.background).toBe('#2e3440');
    });

    it('re-resolves when the theme NAME changes, without a restart', () => {
        const f = service({ ghostty: 'theme = Nord\n' });
        fs.writeFileSync(path.join(f.themes, 'Nord'), NORD, 'utf8');
        fs.writeFileSync(path.join(f.themes, 'Catppuccin Latte'), LATTE, 'utf8');
        expect(f.service.reload().appearance.backgroundColor).toBe('#2e3440');
        f.writeGhostty('theme = Catppuccin Latte\n');
        const next = f.service.reload();
        expect(next.appearance.backgroundColor).toBe('#eff1f5');
        expect(next.appearance.isDark).toBe(false);
    });

    it('falls back visibly when the configured theme is not installed', () => {
        const f = service({ ghostty: 'theme = Nord\n' });
        const snapshot = f.service.reload();
        expect(snapshot.appearance.backgroundColor).toBe('#0a0a0c');
        expect(snapshot.appearance.terminalTheme.palette).toEqual({});
        expect(snapshot.appearance.terminalTheme.error).toContain('Nord');
    });
});
