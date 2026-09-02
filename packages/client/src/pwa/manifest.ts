/**
 * The web app manifest: what a phone reads when someone adds Kelpi to the Home Screen.
 *
 * A pure builder, not a checked-in `.webmanifest`, for the same reason there is no checked-in
 * icon anywhere in this repo (`vite.config.ts`, `core/src/icon/png.ts`): a second copy of the
 * app's identity is a copy free to drift from the one everything else draws. The colours come
 * from the chrome token table and the icons are printed from the kelpie mark at build time, so
 * the tile on a Home Screen, the Dock tile and the browser tab cannot disagree.
 *
 * **Every phone rule in this package is an owner-directed divergence from the shipped Swift
 * app.** There is no Swift phone UI to port: the Mac app has no manifest, no Home Screen and no
 * install, so nothing here has a counterpart to be faithful to. That is stated once, here, and
 * the modules under `pwa/` inherit it.
 *
 * `vite.config.ts` emits `buildWebManifest()` as `/manifest.webmanifest` and the two PNGs it
 * names, and answers all three from the dev server; `daemon/src/ws/http.ts` gives the file its
 * `application/manifest+json` MIME. Nothing else imports this module today. The service worker
 * (A2) will, for its precache list: it should read `MANIFEST_FILE_NAME` and `MANIFEST_ICONS`
 * rather than retype the names, because these files are NOT under `/assets/` and so carry no
 * content hash - they are stable paths whose bytes change with the build.
 */

import { CHROME_TOKEN_FALLBACKS } from '../chrome/tokens';

/** The file the manifest is served as, and the href `index.html` asks for. */
export const MANIFEST_FILE_NAME = 'manifest.webmanifest';

/**
 * The MIME the daemon must answer `MANIFEST_FILE_NAME` with (`daemon/src/ws/http.ts`).
 *
 * Not cosmetic: a manifest served as `application/octet-stream` is fetched and then discarded,
 * and the page installs with whatever the browser can infer from the document instead - which
 * on iOS is the apple metas alone, so the failure looks like "the icon is right but the app
 * opens in a tab" rather than like an error.
 */
export const MANIFEST_MIME = 'application/manifest+json';

export interface ManifestIconSpec {
    /** Emitted at the site root, beside `favicon.png`; the manifest's `src` is `/` + this. */
    readonly fileName: string;
    /** Square, in CSS px; the `sizes` string is derived from it, never written by hand. */
    readonly size: number;
}

/**
 * The two raster sizes the install prompts want.
 *
 * 192 is the Home Screen / launcher tile and 512 is what a splash screen and an app listing
 * scale from; those are the two Chrome's install criteria name, and Safari takes the largest it
 * finds. The 180 px `apple-touch-icon.png` `index.html` already links is a third thing and stays
 * where it is: iOS reads the link, not the manifest, for the tile it draws.
 */
export const MANIFEST_ICONS: readonly ManifestIconSpec[] = [
    { fileName: 'icon-192.png', size: 192 },
    { fileName: 'icon-512.png', size: 512 }
];

export interface WebManifestIcon {
    readonly src: string;
    readonly sizes: string;
    readonly type: string;
    readonly purpose: string;
}

export interface WebAppManifest {
    readonly name: string;
    readonly short_name: string;
    readonly start_url: string;
    readonly scope: string;
    readonly display: string;
    readonly background_color: string;
    readonly theme_color: string;
    readonly icons: readonly WebManifestIcon[];
}

/**
 * The ground the app paints, `--kelpi-bg` of the default (dark) preset.
 *
 * Read off `CHROME_TOKEN_FALLBACKS` rather than retyped, so this cannot drift: `theme.test.ts`
 * pins that table to `chromeThemeCssVars(DARK_CHROME_THEME)`, which makes it the same `#0A0A0C`
 * that `styles.css`'s `:root` block gives `<body>` before hydration and that
 * `ThemeProvider` stamps after it. Dark is the DEFAULT rather than a choice: `:root` in
 * `styles.css` is the dark column, and the light column only applies under
 * `(prefers-color-scheme: light)`. A manifest carries one value and cannot ask; `index.html`'s
 * two `theme-color` metas are where the light answer lives.
 *
 * It is also, exactly, `KELPIE_MARK_BACKGROUND` in `core/src/icon/svg.ts` - the opaque tile the
 * icons below are drawn on. So the splash screen a browser paints from `background_color` is
 * the icon's own tile colour extended to the whole screen, and the icon has no box around it.
 */
const GROUND = CHROME_TOKEN_FALLBACKS['--kelpi-bg'];

/**
 * The manifest object. Pure and argument-free: everything in it is either a constant of the
 * product or a read of the token table.
 *
 * `theme_color` is the same `GROUND` as `background_color`, not the title bar's
 * `--kelpi-footer-bg`. Two reasons. The bar is not yet what sits under the status bar (A3 paints
 * the safe areas), so pinning the OS chrome to it would colour a strip the app does not draw
 * there; and the two hexes differ by 2, 2 and 4 of 255, which is below anything a phone screen
 * shows - picking the ground costs nothing and is the colour the page actually starts as.
 */
export function buildWebManifest(): WebAppManifest {
    return {
        name: 'Kelpi',
        short_name: 'Kelpi',
        // Guardrail 3 of the phone program: THE TOKEN STAYS OUT OF URLS AND CACHES. `start_url`
        // is bare `/` with no token and no query string, ever. A Home Screen app shares the
        // origin's `localStorage`, where `app/config.ts` already put the token on first sight,
        // so it reconnects without one in the URL; a `?token=` here would instead write the
        // secret into the installed app's own metadata, the browser's manifest cache and every
        // screenshot of the Home Screen. `scope` is `/` for the same shape: the whole origin,
        // no query.
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: GROUND,
        theme_color: GROUND,
        // `purpose: "any"` only. A `maskable` variant would need the mark padded into the
        // central 80% safe zone, and `kelpieMarkPng` stamps at `span: 1` (full bleed) with no
        // way to ask for less - `stampKelpie` takes a `span`, but the PNG wrapper does not
        // forward it. Adding that option is a `packages/core` change, which is outside this
        // task's lane; until then a padded tile would mean a second drawing, which is the one
        // thing this repo keeps refusing to have. The cost is that Android's adaptive-icon mask
        // shrinks the "any" icon into its circle instead of cropping a padded one; iOS, which
        // is the device this was built for, ignores `maskable` entirely and draws the
        // `apple-touch-icon` link.
        icons: MANIFEST_ICONS.map((icon) => ({
            src: `/${icon.fileName}`,
            sizes: `${String(icon.size)}x${String(icon.size)}`,
            type: 'image/png',
            purpose: 'any'
        }))
    };
}

/** The bytes served at `/manifest.webmanifest`. Two-space JSON, so a curl of it is readable. */
export function webManifestJson(): string {
    return `${JSON.stringify(buildWebManifest(), null, 2)}\n`;
}
