/**
 * §APP-014 — `theme = <name>` resolved to an actual palette.
 *
 * The Swift app never had to do this: `theme` was handed to libghostty, libghostty found the
 * theme FILE on its own search path, and every surface was rebuilt from the config that came
 * back (config-keybindings.md §11, terminal-surface.md §3.1/§3.2 — "`background` … is the
 * *resolved* value, i.e. after any `theme` is applied"). There is no libghostty in this port,
 * so the daemon performs the same lookup itself and puts the result on the settings snapshot,
 * where the ordinary `settings-changed` broadcast carries it to every attached client live.
 *
 * Three things this module is deliberately NOT:
 *
 *   - **a theme registry.** Nothing here ships a palette. A name resolves to a file the user
 *     (or their ghostty install) already has, or it does not resolve at all — the port never
 *     invents colours for a name it cannot find, because a wrong Dracula is worse than none.
 *   - **a ghostty config implementation.** A theme file is read with the same reader
 *     `./ghostty.ts` uses for the config file (`parseConfigLines` + `parseGhosttyColor`), and
 *     the six document keys plus `palette = N=#hex` are the whole of what is understood.
 *     `config-file` includes inside a theme are not followed.
 *   - **silent.** Every way a name can fail to produce a palette — no file, unreadable file, a
 *     file with nothing colour-shaped in it — returns a sentence, and the snapshot carries it
 *     to Settings ▸ Appearance. §SET-216's *behaviour* is unchanged (an unknown name selects
 *     nothing and the terminal keeps the palette it had); what changes is that the user is
 *     told why instead of watching nothing happen.
 *
 * **Everything that touches `$HOME` is injected.** `themeSearchDirs` takes `env` and `home`
 * exactly as `resolveGhosttyConfigPath` does, and `KELPID_GHOSTTY_THEME_DIRS` replaces the whole
 * search path — so a test (or the audit sandbox) resolves themes inside a `mkdtemp` and the
 * developer's own `~/.config/ghostty` is never read.
 */

import fs from 'node:fs';
import path from 'node:path';

import { parseConfigLines } from '@kelpi/core/config';
import {
    DEFAULT_WS_TERMINAL_THEME,
    TERMINAL_PALETTE_ANSI_KEYS,
    type TerminalPaletteKey,
    type WsTerminalThemeResolution
} from '@kelpi/protocol';

import { expandTilde } from '../lifecycle/rundir.js';
import { parseGhosttyColor } from './ghostty.js';

/**
 * Replaces the entire theme search path with a `:`-separated list of directories.
 *
 * Additive and test-only in spirit — it exists so nothing in this package can be made to read
 * the developer's real `~/.config/ghostty/themes` while a test is running.
 */
export const GHOSTTY_THEME_DIRS_ENV = 'KELPID_GHOSTTY_THEME_DIRS';

/** ghostty's own env var for its resource root; its `themes/` lives inside. */
const GHOSTTY_RESOURCES_ENV = 'GHOSTTY_RESOURCES_DIR';

/** The six non-ANSI keys a ghostty theme file can set, by the file's own spelling. */
const DOCUMENT_KEYS: Readonly<Record<string, TerminalPaletteKey>> = {
    background: 'background',
    foreground: 'foreground',
    'cursor-color': 'cursor',
    'cursor-text': 'cursorAccent',
    'selection-background': 'selectionBackground',
    'selection-foreground': 'selectionForeground'
};

export type TerminalPalette = Partial<Record<TerminalPaletteKey, string>>;

/**
 * `palette = 3=#f1fa8c` → the slot index and the colour, or null.
 *
 * ghostty also accepts `palette = 3 = #f1fa8c` and a bare `f1fa8c`, so the split is on the
 * FIRST `=` with both halves trimmed, and the colour goes through the config reader's own
 * parser (which handles `#abc`, `abc`, `#aabbcc`, `aabbcc` and refuses everything else).
 */
export function parsePaletteEntry(value: string): { index: number; color: string } | null {
    const split = value.indexOf('=');
    if (split < 0) return null;
    const rawIndex = value.slice(0, split).trim();
    if (!/^\d{1,3}$/.test(rawIndex)) return null;
    const index = Number.parseInt(rawIndex, 10);
    if (index < 0 || index >= TERMINAL_PALETTE_ANSI_KEYS.length) return null;
    const color = parseGhosttyColor(value.slice(split + 1));
    return color === null ? null : { index, color };
}

/**
 * A ghostty theme file's colours, keyed by the client's `TerminalTheme` field names.
 *
 * Only what the file actually defines is returned: a theme that sets six colours produces six
 * entries, and the client merges them over its own preset. A file that defines nothing
 * colour-shaped produces `{}` — which is how the caller tells "malformed / not a theme" apart
 * from "resolved".
 */
export function parseGhosttyThemePalette(contents: string): TerminalPalette {
    const palette: TerminalPalette = {};
    for (const { key, value } of parseConfigLines(contents)) {
        if (key === 'palette') {
            const entry = parsePaletteEntry(value);
            // `noUncheckedIndexedAccess`: the index is range-checked above, so this is real.
            const slot = entry === null ? undefined : TERMINAL_PALETTE_ANSI_KEYS[entry.index];
            if (entry !== null && slot !== undefined) palette[slot] = entry.color;
            continue;
        }
        const documentKey = DOCUMENT_KEYS[key];
        if (documentKey === undefined) continue;
        const color = parseGhosttyColor(value);
        if (color !== null) palette[documentKey] = color;
    }
    return palette;
}

/**
 * ghostty's `theme = dark:X,light:Y` form, reduced to the one name that applies.
 *
 * The port picks with the background's own light/dark verdict — the same luminance rule
 * everything else in this daemon uses — rather than the OS appearance, because that verdict is
 * what the client's chrome and the rendered content HTML are already keyed to.
 *
 * A plain `theme = X` is returned unchanged, including a name that happens to contain a colon.
 */
export function selectThemeName(raw: string | null, isDark: boolean): string | null {
    if (raw === null) return null;
    const value = raw.trim();
    if (value === '') return null;
    if (!/(^|,)\s*(dark|light)\s*:/i.test(value)) return value;
    const wanted = isDark ? 'dark' : 'light';
    let fallback: string | null = null;
    for (const part of value.split(',')) {
        const match = /^\s*(dark|light)\s*:\s*(.+?)\s*$/i.exec(part);
        if (match === null) continue;
        const name = match[2] ?? '';
        if (name === '') continue;
        if ((match[1] ?? '').toLowerCase() === wanted) return name;
        fallback ??= name;
    }
    return fallback;
}

export interface ThemeSearchOptions {
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly home?: string | undefined;
    /** The resolved ghostty CONFIG path; its directory is searched first. */
    readonly ghosttyPath?: string | undefined;
}

/**
 * Where a ghostty theme file can live, most specific first.
 *
 * 1. **beside the config file the daemon actually read.** In a normal install that IS
 *    `~/.config/ghostty/themes`, and when `KELPID_GHOSTTY_CONFIG` points somewhere else (tests,
 *    the audit sandbox) the themes follow it — which is what keeps a test off the real home.
 * 2. `$XDG_CONFIG_HOME/ghostty/themes`, then `~/.config/ghostty/themes` — ghostty's own config
 *    locations, in ghostty's order.
 * 3. `~/Library/Application Support/com.mitchellh.ghostty/themes` — the macOS config dir.
 * 4. the install's resources: `$GHOSTTY_RESOURCES_DIR/themes`, the app bundle's
 *    `Contents/Resources/ghostty/themes` (system and per-user Applications), and the two
 *    conventional Unix share paths. This is where the ~250 themes ghostty ships actually are,
 *    so it is the branch that makes `theme = Dracula` work for a user who never wrote one.
 *
 * Duplicates are dropped, order preserved. Nothing here touches the filesystem.
 */
export function themeSearchDirs(options: ThemeSearchOptions = {}): string[] {
    const env = options.env ?? process.env;
    const home = options.home ?? '';
    const override = env[GHOSTTY_THEME_DIRS_ENV]?.trim();
    if (override !== undefined && override !== '') {
        return dedupe(
            override
                .split(':')
                .map((entry) => entry.trim())
                .filter((entry) => entry !== '')
                .map((entry) => path.resolve(expandTilde(entry, home)))
        );
    }

    const dirs: string[] = [];
    if (options.ghosttyPath !== undefined && options.ghosttyPath !== '') {
        dirs.push(path.join(path.dirname(path.resolve(options.ghosttyPath)), 'themes'));
    }
    const xdg = env['XDG_CONFIG_HOME']?.trim();
    if (xdg !== undefined && xdg !== '') {
        dirs.push(path.join(path.resolve(expandTilde(xdg, home)), 'ghostty', 'themes'));
    }
    if (home !== '') {
        dirs.push(path.join(home, '.config', 'ghostty', 'themes'));
        dirs.push(
            path.join(home, 'Library', 'Application Support', 'com.mitchellh.ghostty', 'themes')
        );
    }
    const resources = env[GHOSTTY_RESOURCES_ENV]?.trim();
    if (resources !== undefined && resources !== '') {
        dirs.push(path.join(path.resolve(expandTilde(resources, home)), 'themes'));
    }
    if (home !== '') {
        dirs.push(
            path.join(home, 'Applications', 'Ghostty.app', 'Contents', 'Resources', 'ghostty', 'themes')
        );
    }
    dirs.push('/Applications/Ghostty.app/Contents/Resources/ghostty/themes');
    dirs.push('/usr/local/share/ghostty/themes');
    dirs.push('/usr/share/ghostty/themes');
    return dedupe(dirs);
}

function dedupe(values: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
        if (seen.has(value)) continue;
        seen.add(value);
        out.push(value);
    }
    return out;
}

export interface ResolveThemeOptions extends ThemeSearchOptions {
    /** Which half of a `dark:X,light:Y` value applies. Defaults to dark. */
    readonly isDark?: boolean | undefined;
    /** Injection seam for tests: returns the file's contents, or null when there is none. */
    readonly readFile?: ((file: string) => string | null) | undefined;
}

/** Read a theme file, treating every filesystem failure as "not there". */
function readThemeFile(file: string): string | null {
    try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) return null;
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

/**
 * A theme name → the palette its file defines, or a sentence saying why not.
 *
 * The name is used as a FILENAME verbatim (ghostty theme ids are case-sensitive filenames, and
 * `Catppuccin Mocha` really is a file with a space in it), with one guard: a name carrying a
 * path separator, or `..`, is refused rather than allowed to walk out of the theme
 * directories — `theme = ../../.ssh/id_rsa` must not turn the settings snapshot into a file
 * reader.
 */
export function resolveGhosttyTheme(
    rawName: string | null,
    options: ResolveThemeOptions = {}
): WsTerminalThemeResolution {
    const name = selectThemeName(rawName, options.isDark ?? true);
    if (name === null) return DEFAULT_WS_TERMINAL_THEME;

    if (name.includes('/') || name.includes('\\') || name.split(path.sep).includes('..')) {
        return {
            name,
            path: null,
            palette: {},
            error: `Theme “${name}” is not a valid theme name (a theme is a file name, not a path).`
        };
    }

    const dirs = themeSearchDirs(options);
    const read = options.readFile ?? readThemeFile;
    for (const dir of dirs) {
        const file = path.join(dir, name);
        const contents = read(file);
        if (contents === null) continue;
        const palette = parseGhosttyThemePalette(contents);
        if (Object.keys(palette).length === 0) {
            return {
                name,
                path: file,
                palette: {},
                error: `Theme “${name}” was found at ${file} but defines no colours Kelpi understands, so the terminal palette is unchanged.`
            };
        }
        return { name, path: file, palette, error: null };
    }

    const where = dirs.length === 0 ? 'any theme directory' : dirs.slice(0, 2).join(', ');
    return {
        name,
        path: null,
        palette: {},
        error: `No ghostty theme file named “${name}” was found (looked in ${where}${dirs.length > 2 ? ', …' : ''}), so the terminal palette is unchanged.`
    };
}
