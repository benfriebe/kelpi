#!/usr/bin/env node
/**
 * §N31's frame-level harness: what COLOUR is in the strip a side panel's slide sweeps?
 *
 * The owner's report is "opening/closing the side panels flashes WHITE mid-animation in a dark
 * app". A white flash in a dark window is the signature of Chromium painting the WINDOW's own
 * background — the base colour the compositor uses for any pixel no layer has painted — and the
 * only way to tell that from "the panel is simply drawn wrong" is to photograph the animation
 * frame by frame and classify the pixels.
 *
 * The instrument is the audit stack (`lib/stack.mjs` sandbox + `lib/cdp.mjs` session, ephemeral
 * ports, `mkdtemp` HOME, never the developer's dotfiles) plus three things:
 *
 *   1. **CDP screencast at the compositor's own rate.** `Page.startScreencast` emits one PNG per
 *      composited frame, so a 250 ms slide arrives as ~15 photographs of the real window rather
 *      than one settled screenshot. PNGs are decoded here (`decodePng`, zlib + the five PNG
 *      filters) so nothing outside node is needed.
 *   2. **An in-page rAF sampler**, the `sidebar-spring` step's precedent, recording the slot
 *      width, the panel's opacity and its transform per frame — so a photographed frame can be
 *      placed on the animation's own clock and "mid-slide" is a measurement, not a guess.
 *   3. **A base-background PROBE.** `Emulation.setDefaultBackgroundColorOverride` repaints the
 *      renderer's base — the exact layer a `BrowserWindow`'s `backgroundColor` feeds — in
 *      saturated magenta. Any magenta pixel in the strip is then proof that the PAGE painted
 *      nothing there and the window's background is what the user sees. Magenta because no
 *      colour in either theme is within 200 units of it, so the classifier cannot be fooled by
 *      text anti-aliasing or by an opacity blend, which a "is it light?" test would be.
 *
 * Every frame is classified in two independent ways:
 *
 *   - `probe`   — pixels matching the base-background override (run with `--probe`). These are
 *                 window-default pixels by construction: the region is unpainted.
 *   - `foreign` — pixels matching NEITHER theme ground: not within tolerance of any colour the
 *                 page's own resolved palette contains, and not on the segment between any two
 *                 of them (an opacity cross-fade is exactly such a blend). Classifying against
 *                 the resolved palette rather than against literal white is what makes the run
 *                 meaningful in a LIGHT appearance, where a white flash hides.
 *
 * **And two more, added when §N31 was REOPENED** — because the first pass answered its question
 * correctly and the owner still saw white. All three of its framings (the panel's own 280 px
 * column; a region inset from the moving edge; the MODAL colour of a 40-row grid) were blind to
 * a residual that was outside the clip altogether, in the pane grid the panel pushes:
 *
 *   - `grid`  — the union of the pane wrappers against the container they are inside, read in a
 *               `ResizeObserver` created after the grid's own, i.e. at the moment the frame is
 *               about to paint. The panes are absolutely positioned from a measurement; while it
 *               trails the container, the difference is unpainted window.
 *   - `alpha` — real screenshots with the renderer's base at alpha 0, so an unpainted pixel is
 *               alpha 0 in the file. No colour reasoning, no tolerance, nothing to argue with.
 *
 * Usage:
 *
 *     node scripts/ui-audit/panel-slide-flash.mjs [--cycles N] [--opacity 1|0.85]
 *          [--appearance dark|light|system] [--probe] [--panels sidebar,inspector]
 *          [--split N] [--no-alpha] [--placement default|hidden|offscreen|onscreen]
 *          [--out DIR] [--keep] [--verbose] [--build]
 *
 * Exit code 0 = no probe pixel, no foreign pixel, no uncovered grid observation and no
 * unpainted (alpha 0) pixel in any frame of any slide.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const { makeSandbox, startDaemon, waitForHealthz, startShell, makeCli, sleep, buildAll } = await import(
    path.join(here, 'lib', 'stack.mjs')
);
const { waitForPageTarget, connect } = await import(path.join(here, 'lib', 'cdp.mjs'));

// ── options ─────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1];
};
const options = {
    cycles: Number(flag('--cycles', '3')),
    opacity: flag('--opacity', '1'),
    appearance: flag('--appearance', 'dark'),
    probe: argv.includes('--probe'),
    panels: String(flag('--panels', 'sidebar,inspector'))
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
    out: flag('--out', null),
    /** `strip` (the region the panel sweeps) or `full` (the whole window — where else is it?). */
    region: flag('--region', 'strip'),
    /** Extra panes to create before the cycles, so the slides run against a SPLIT grid. */
    split: Number(flag('--split', '0')),
    /** Photograph the WINDOW (`fromSurface: false`) rather than the renderer's own surface. */
    window: argv.includes('--window'),
    /**
     * Where the shell window is placed: `default` (visible, unchanged), `hidden`, `offscreen` or
     * `onscreen` — `packages/shell/src/audit-window.ts` decides what each means. Read from
     * `KELPI_AUDIT_WINDOW` when the flag is absent so a caller can set it once for a comparison.
     *
     * This instrument is one of the two places a placement can be judged rather than guessed: it
     * counts real composited frames, so a compositor skipping them shows up as a smaller
     * `totals.inFlight` than the same run visible. (It is also, notably, blind to the failure that
     * disqualified `hidden` — a zero-opacity window photographs as blank, which shows up in the
     * PNG bytes rather than in any of these counters.)
     */
    placement: flag('--placement', process.env['KELPI_AUDIT_WINDOW'] ?? 'default'),
    /** Multiply every slide transition by this, so a slow instrument still resolves the motion. */
    slow: Number(flag('--slow', '1')),
    dump: argv.includes('--dump'),
    /** Skip the alpha sweep (the unpainted-pixel pass) — it adds a cycle per panel. */
    noAlpha: argv.includes('--no-alpha'),
    keep: argv.includes('--keep'),
    verbose: argv.includes('--verbose'),
    build: argv.includes('--build')
};

const log = (line) => process.stdout.write(`${line}\n`);

// ── PNG ─────────────────────────────────────────────────────────────────────────────

/**
 * A minimal PNG reader: 8-bit, non-interlaced, gray/RGB/palette/gray+A/RGBA — which is every
 * shape Chromium's screencast emits. Returns `{ width, height, channels, data }` with `data`
 * the unfiltered scanlines back to back.
 */
function decodePng(buffer) {
    if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
    let pos = 8;
    let header = null;
    let palette = null;
    const chunks = [];
    while (pos + 8 <= buffer.length) {
        const length = buffer.readUInt32BE(pos);
        const type = buffer.toString('ascii', pos + 4, pos + 8);
        const data = buffer.subarray(pos + 8, pos + 8 + length);
        if (type === 'IHDR') {
            header = {
                width: data.readUInt32BE(0),
                height: data.readUInt32BE(4),
                depth: data[8],
                color: data[9],
                interlace: data[12]
            };
        } else if (type === 'IDAT') chunks.push(Buffer.from(data));
        else if (type === 'PLTE') palette = Buffer.from(data);
        else if (type === 'IEND') break;
        pos += 12 + length;
    }
    if (header === null) throw new Error('PNG without an IHDR');
    if (header.depth !== 8) throw new Error(`unsupported PNG bit depth ${String(header.depth)}`);
    if (header.interlace !== 0) throw new Error('interlaced PNGs are not supported');
    const channelsFor = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
    const channels = channelsFor[header.color];
    if (channels === undefined) throw new Error(`unsupported PNG colour type ${String(header.color)}`);

    const raw = zlib.inflateSync(Buffer.concat(chunks));
    const stride = header.width * channels;
    const out = Buffer.alloc(stride * header.height);
    let source = 0;
    for (let y = 0; y < header.height; y++) {
        const filter = raw[source];
        source += 1;
        const line = raw.subarray(source, source + stride);
        source += stride;
        const row = out.subarray(y * stride, (y + 1) * stride);
        const prior = y === 0 ? null : out.subarray((y - 1) * stride, y * stride);
        for (let x = 0; x < stride; x++) {
            const left = x >= channels ? row[x - channels] : 0;
            const up = prior === null ? 0 : prior[x];
            const upLeft = prior === null || x < channels ? 0 : prior[x - channels];
            const value = line[x];
            switch (filter) {
                case 0:
                    row[x] = value;
                    break;
                case 1:
                    row[x] = (value + left) & 0xff;
                    break;
                case 2:
                    row[x] = (value + up) & 0xff;
                    break;
                case 3:
                    row[x] = (value + ((left + up) >> 1)) & 0xff;
                    break;
                case 4: {
                    const p = left + up - upLeft;
                    const pa = Math.abs(p - left);
                    const pb = Math.abs(p - up);
                    const pc = Math.abs(p - upLeft);
                    const pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
                    row[x] = (value + pred) & 0xff;
                    break;
                }
                default:
                    throw new Error(`unknown PNG filter ${String(filter)}`);
            }
        }
    }

    if (header.color === 3) {
        if (palette === null) throw new Error('palette PNG without a PLTE');
        const expanded = Buffer.alloc(header.width * header.height * 3);
        for (let index = 0; index < header.width * header.height; index++) {
            const entry = out[index] * 3;
            expanded[index * 3] = palette[entry];
            expanded[index * 3 + 1] = palette[entry + 1];
            expanded[index * 3 + 2] = palette[entry + 2];
        }
        return { width: header.width, height: header.height, channels: 3, data: expanded };
    }
    return { width: header.width, height: header.height, channels, data: out };
}

const pixelAt = (image, x, y) => {
    const offset = (y * image.width + x) * image.channels;
    if (image.channels >= 3) return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
    const value = image.data[offset];
    return [value, value, value];
};

// ── colour classification ───────────────────────────────────────────────────────────

const hexToRgb = (value) => {
    const text = String(value).trim();
    const match = /^#?([0-9a-f]{6})$/i.exec(text);
    if (match !== null) {
        const n = Number.parseInt(match[1], 16);
        return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
    }
    const rgba = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(text);
    if (rgba !== null) return [Math.round(Number(rgba[1])), Math.round(Number(rgba[2])), Math.round(Number(rgba[3]))];
    return null;
};

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Is `pixel` explicable by the page's own palette?
 *
 * True when it is within `tolerance` of a palette colour, OR within `tolerance` of the segment
 * between two of them — which is what every alpha composite in the app is, the panel's own
 * opacity cross-fade included. Anything else is a colour the page cannot have produced from the
 * theme it is running, and in a shell window that means the window's background.
 */
function explicable(pixel, palette, tolerance) {
    for (const colour of palette) if (distance(pixel, colour) <= tolerance) return true;
    for (let i = 0; i < palette.length; i++) {
        for (let j = i + 1; j < palette.length; j++) {
            const a = palette[i];
            const b = palette[j];
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const dz = b[2] - a[2];
            const len2 = dx * dx + dy * dy + dz * dz;
            if (len2 === 0) continue;
            let t = ((pixel[0] - a[0]) * dx + (pixel[1] - a[1]) * dy + (pixel[2] - a[2]) * dz) / len2;
            t = Math.max(0, Math.min(1, t));
            const projected = [a[0] + dx * t, a[1] + dy * t, a[2] + dz * t];
            if (distance(pixel, projected) <= tolerance) return true;
        }
    }
    return false;
}

const PROBE_RGB = [255, 0, 255];

// ── run ─────────────────────────────────────────────────────────────────────────────

const outDir =
    options.out === null
        ? path.join(repoRoot, 'docs', 'audit', 'n31-panel-slide', `${options.appearance}-op${options.opacity}${options.probe ? '-probe' : ''}`)
        : path.resolve(options.out);

async function main() {
    if (options.build) await buildAll(repoRoot, { log });

    // `makeSandbox` reads this when it writes the sandbox ghostty config: `background-opacity`
    // is fixed at window construction (APP-012 / SET-049), so it cannot be set from inside a run.
    if (options.opacity !== '1') process.env.KELPI_AUDIT_GHOSTTY_EXTRA = `background-opacity = ${options.opacity}`;
    else delete process.env.KELPI_AUDIT_GHOSTTY_EXTRA;

    const clientDir = process.env['KELPI_AUDIT_CLIENT_DIR'] ?? path.join(repoRoot, 'packages', 'client', 'dist');
    if (!fs.existsSync(path.join(clientDir, 'index.html'))) {
        throw new Error(`the web client is not built: ${clientDir}`);
    }
    const sandbox = await makeSandbox(repoRoot, { label: 'n31', clientDir });
    if (options.appearance !== 'system') {
        fs.writeFileSync(sandbox.configPath, `chrome-appearance = ${options.appearance}\n`);
    }
    fs.mkdirSync(outDir, { recursive: true });

    const daemon = startDaemon(sandbox, { repoRoot, verbose: options.verbose });
    const cli = makeCli(sandbox, { repoRoot });
    let shell = null;
    let page = null;
    const report = {
        appearance: options.appearance,
        opacity: options.opacity,
        probe: options.probe,
        cycles: options.cycles,
        slides: []
    };

    try {
        await waitForHealthz(sandbox.base);
        shell = startShell(sandbox, {
            repoRoot,
            verbose: options.verbose,
            // Unset, this is `default` and the instrument behaves exactly as it did. Pass
            // `--placement X` to measure a placement: run it twice and compare `report.json`'s
            // `totals`, which is how `offscreen` was measured and rejected.
            extraEnv: { KELPI_AUDIT: '1', KELPI_AUDIT_WINDOW: options.placement }
        });
        const target = await waitForPageTarget(sandbox.debugPort, {
            timeoutMs: 90_000,
            match: (candidate) => String(candidate?.url ?? '').includes('shellWindow=')
        });
        page = await connect(target.webSocketDebuggerUrl, { repoRoot });
        await page.send('Page.enable');
        await page.send('Runtime.enable');
        await page.send('DOM.enable');
        // rAF is throttled to ~0 Hz for an occluded window, and the slide advances on a double
        // rAF — an audit window behind another sticks at phase `opening` forever.
        await page.send('Page.bringToFront').catch(() => {});
        try {
            await page.waitFor(`document.querySelector('[data-testid="kelpi-app"]') !== null`, {
                timeoutMs: 60_000,
                label: 'the app to mount'
            });
        } catch (error) {
            const dump = await page
                .eval(
                    `JSON.stringify({ ready: document.readyState, title: document.title, url: location.href, html: (document.body?.innerHTML ?? '').slice(0, 1500) })`
                )
                .catch((inner) => `eval failed: ${String(inner)}`);
            log(`app never mounted; page says ${String(dump)}`);
            throw error;
        }
        await sleep(2500);

        // The window's own line, for the record: which path this run took.
        const windowLine = shell.lines.find((line) => line.includes('window:')) ?? '(none)';
        const groundLine = shell.lines.find((line) => line.includes('ground')) ?? '(none)';
        report.shellWindowLine = windowLine;
        report.shellGroundLine = groundLine;
        log(`shell: ${windowLine}`);
        if (groundLine !== '(none)') log(`shell: ${groundLine}`);

        /*
         * ── the geometry variant: more than one pane ────────────────────────────────
         *
         * §N31's reopened half is about the pane GRID keeping up with the container, and the
         * grid's arithmetic is a tree: one pane is a single rect pinned to the bounds, several
         * are ratios of ratios with a divider gutter between them. A one-pane workspace can
         * therefore be right for reasons that say nothing about a split one, so the cycle can be
         * driven with a split layout (`--split N` adds N panes before the slides start).
         */
        if (options.split > 0) {
            // The daemon's own list, not the sidebar's text: a row renders a colour chip and a
            // shortcut badge around the name, and `innerText` picks up whichever comes first.
            const workspaces = await cli.json(['workspace', 'list', '--json']);
            const active = workspaces.find((workspace) => workspace.is_active === true) ?? workspaces[0];
            if (active === undefined) throw new Error('no workspace to split');
            for (let extra = 0; extra < options.split; extra++) {
                const result = await cli.run(['pane', 'create', '--workspace', String(active.id)]);
                log(`split ${String(extra + 1)}/${String(options.split)} in "${String(active.name)}": exit ${String(result.code)} ${String(result.stdout ?? '').trim()}${String(result.stderr ?? '').trim()}`);
                await sleep(2000);
            }
        }
        if (options.split > 0) {
            const paneCount = Number(
                await page.eval(
                    `document.querySelectorAll('[data-testid="pane-grid"] [data-testid^="pane-header-"]').length`
                )
            );
            report.paneCount = paneCount;
            log(`grid now has ${String(paneCount)} panes`);
            if (paneCount < options.split + 1) throw new Error(`the split variant did not take: ${String(paneCount)} panes`);
        }

        // ── the page's own palette, read from the live document ─────────────────────
        const palette = JSON.parse(
            String(
                await page.eval(
                    `(() => {
                        const style = getComputedStyle(document.documentElement);
                        const names = ['--kelpi-bg','--kelpi-window-fill','--kelpi-sidebar-bg','--kelpi-surface','--kelpi-header-bg',
                                       '--kelpi-footer-bg','--kelpi-fg','--kelpi-fg-secondary','--kelpi-fg-tertiary','--kelpi-border',
                                       '--kelpi-accent','--kelpi-term-bg','--kelpi-term-fg','--kelpi-active-agent','--kelpi-status-running',
                                       '--kelpi-status-waiting','--kelpi-status-inactive','--kelpi-orange','--kelpi-selection-stroke'];
                        const out = {};
                        for (const name of names) out[name] = style.getPropertyValue(name).trim();
                        out['body'] = getComputedStyle(document.body).backgroundColor;
                        out['theme'] = document.documentElement.getAttribute('data-kelpi-theme') ?? '(unset)';
                        return JSON.stringify(out);
                    })()`
                )
            )
        );
        report.palette = palette;
        log(`palette (${palette.theme}): bg ${palette['--kelpi-bg']} · fill ${palette['--kelpi-window-fill']} · sidebar ${palette['--kelpi-sidebar-bg']}`);

        const paletteRgb = [];
        for (const [name, value] of Object.entries(palette)) {
            if (name === 'theme') continue;
            const rgb = hexToRgb(value);
            if (rgb !== null) paletteRgb.push(rgb);
        }
        // Black is always explicable: it is what a transparent window composites to in a
        // screencast, and it is `--kelpi-term-*`'s neighbourhood anyway.
        paletteRgb.push([0, 0, 0]);
        /** The window GROUND — what `<body>` paints (`--kelpi-window-fill`), or nothing at all. */
        const groundRgb = hexToRgb(palette['--kelpi-window-fill']);

        if (options.slow > 1) {
            /*
             * A slow instrument (`--window`) cannot resolve a 250 ms slide, so the transition is
             * stretched. Only the OPEN direction stays honest under this: the phase machine
             * unmounts a closing panel after `SIDEBAR_SLIDE_MS`, which a stretched transition
             * outlives, so a slowed close photographs a panel that has already left the tree.
             */
            await page.eval(
                `(() => {
                    const style = document.createElement('style');
                    style.id = 'kelpi-n31-slow';
                    style.textContent = '[data-testid="sidebar-slot"],[data-testid="sidebar-panel"],[data-testid="inspector-slot"],[data-testid="inspector-panel"]{transition-duration:${String(Math.round(250 * options.slow))}ms !important;}';
                    document.head.appendChild(style);
                    return true;
                })()`
            );
        }

        if (options.probe) {
            await page.send('Emulation.setDefaultBackgroundColorOverride', {
                color: { r: PROBE_RGB[0], g: PROBE_RGB[1], b: PROBE_RGB[2], a: 1 }
            });
        }

        // ── geometry ────────────────────────────────────────────────────────────────
        const geometry = JSON.parse(
            String(
                await page.eval(
                    `(() => {
                        const rect = (selector) => {
                            const el = document.querySelector(selector);
                            if (el === null) return null;
                            const r = el.getBoundingClientRect();
                            return { x: r.x, y: r.y, width: r.width, height: r.height };
                        };
                        return JSON.stringify({
                            dpr: window.devicePixelRatio,
                            innerWidth: window.innerWidth,
                            innerHeight: window.innerHeight,
                            topBar: rect('[data-testid="top-bar"]'),
                            footer: rect('[data-testid="status-footer"]'),
                            sidebarSlot: rect('[data-testid="sidebar-slot"]'),
                            grid: rect('[data-testid="pane-grid"]')
                        });
                    })()`
                )
            )
        );
        report.geometry = geometry;
        log(`geometry: ${geometry.innerWidth}×${geometry.innerHeight} @${geometry.dpr}x · sidebar slot ${JSON.stringify(geometry.sidebarSlot)}`);

        const rowTop = (geometry.topBar?.y ?? 0) + (geometry.topBar?.height ?? 0);
        const rowBottom = geometry.footer === null ? geometry.innerHeight : geometry.footer.y;
        const sidebarWidth = geometry.sidebarSlot === null ? 220 : Math.round(geometry.sidebarSlot.width);
        const INSPECTOR_WIDTH = 280;

        /*
         * ── §N31's REOPENED half: the strip is not always the clip ──────────────────
         *
         * The first pass of this instrument asked one question — "is the reveal the panel's
         * colour?" — and answered it over the panel's own 280 px column, inside a region inset
         * from the moving edge by a frame's travel, judging by the MODAL colour of a 40-row
         * grid. All three of those framings are why it stayed green while the owner kept seeing
         * white on the inspector: the residual was **outside the clip entirely**, in the pane
         * grid the panel pushes.
         *
         * The grid paints every pane as an absolutely-positioned pixel rect derived from a
         * `ResizeObserver` measurement, and the grid itself paints nothing (§N17: the window
         * fill is `transparent` below `background-opacity` 1). So for as long as that
         * measurement trails the container — one frame, ~18 px at a slide's speed — the
         * difference is a strip of window that NOTHING painted: the desktop, i.e. white on a
         * light wallpaper. Measured at 21.2 px on the inspector's close, 16.7 px on the
         * sidebar's, and photographed at alpha 0.
         *
         * Two nets, because they fail independently:
         *
         *   1. `coverage` — the union of the pane wrappers against the container, read inside a
         *      `ResizeObserver` created HERE. Observers are delivered in creation order, so this
         *      one runs after the grid's own and sees whether the panes have been re-laid-out
         *      for the size the container has THIS frame, before the frame paints. A rAF cannot
         *      answer this: it runs before the observer step, so it sees a gap every frame
         *      whether or not one paints.
         *   2. `alpha` — `Emulation.setDefaultBackgroundColorOverride` at alpha 0 plus real
         *      screenshots, so an unpainted pixel comes back with alpha 0 and no colour
         *      classifier can explain it away.
         */
        const startCoverage = async () =>
            await page.eval(
                `(() => {
                    const grid = document.querySelector('[data-testid="pane-grid"]');
                    if (grid === null || typeof ResizeObserver === 'undefined') return false;
                    const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; };
                    const observations = [];
                    let running = true;
                    const observer = new ResizeObserver(() => {
                        if (!running) return;
                        const g = box(grid);
                        const wrappers = [...grid.querySelectorAll('[data-testid]')].filter((el) =>
                            /^pane-[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(el.getAttribute('data-testid') ?? '') &&
                            getComputedStyle(el).visibility !== 'hidden'
                        );
                        let u = null;
                        for (const w of wrappers) {
                            const b = box(w);
                            u = u === null ? { ...b } : { l: Math.min(u.l, b.l), r: Math.max(u.r, b.r), t: Math.min(u.t, b.t), b: Math.max(u.b, b.b) };
                        }
                        const r2 = (value) => Math.round(value * 100) / 100;
                        observations.push(
                            u === null
                                ? { wrappers: 0, uncovered: 0 }
                                : {
                                      wrappers: wrappers.length,
                                      width: r2(g.r - g.l),
                                      uncovered: r2(Math.max(g.r - u.r, u.l - g.l, u.t - g.t, g.b - u.b))
                                  }
                        );
                    });
                    observer.observe(grid);
                    window.__kelpiGridCoverage = { observations, stop: () => { running = false; observer.disconnect(); } };
                    return true;
                })()`
            );
        const readCoverage = async () => {
            await page.eval(`(() => { window.__kelpiGridCoverage?.stop?.(); return true; })()`);
            return JSON.parse(String(await page.eval(`JSON.stringify(window.__kelpiGridCoverage?.observations ?? [])`)));
        };

        // ── screencast plumbing ─────────────────────────────────────────────────────
        let frames = [];
        let collecting = false;
        page.on('Page.screencastFrame', (params) => {
            void page.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
            if (!collecting) return;
            /*
             * The frame's OWN clock, not the moment its base64 reached this process. A screencast
             * frame arrives one websocket round trip late, and matching arrival time to the rAF
             * sampler puts every photograph a frame or two ahead of the geometry it is compared
             * against — which reads as a reveal wider than the panel that was actually in it.
             * `metadata.timestamp` is seconds since the epoch, from the compositor.
             */
            const stamped = params.metadata?.timestamp;
            const at = typeof stamped === 'number' && Number.isFinite(stamped) ? stamped * 1000 : Date.now();
            frames.push({ at, arrived: Date.now(), data: params.data, metadata: params.metadata });
        });

        const startSampler = async () =>
            await page.eval(
                `(() => {
                    const samples = [];
                    let running = true;
                    const r3 = (value) => Math.round(value * 1000) / 1000;
                    /*
                     * The geometric question, per frame: does the PANEL cover the SLOT?
                     *
                     * The slot's animated width is the strip the slide reveals; the panel is the
                     * only thing inside it that paints. Their overlap over the slot's width is
                     * therefore "how much of the reveal shows the panel", and it is a number a
                     * screenshot cannot argue with. Opacity is read COMPUTED — the inline style
                     * carries the transition's target, not the value on this frame.
                     */
                    const read = (slotID, panelID) => {
                        const slot = document.querySelector('[data-testid="' + slotID + '"]');
                        const panel = document.querySelector('[data-testid="' + panelID + '"]');
                        if (slot === null || panel === null) return null;
                        const s = slot.getBoundingClientRect();
                        const p = panel.getBoundingClientRect();
                        const overlap = Math.max(0, Math.min(s.right, p.right) - Math.max(s.left, p.left));
                        return {
                            width: r3(s.width),
                            left: r3(s.left),
                            right: r3(s.right),
                            panelLeft: r3(p.left),
                            panelRight: r3(p.right),
                            opacity: Number(getComputedStyle(panel).opacity),
                            slotBackground: getComputedStyle(slot).backgroundColor,
                            coverage: s.width <= 0.5 ? 1 : r3(overlap / s.width)
                        };
                    };
                    const tick = (time) => {
                        if (!running) return;
                        samples.push({
                            t: Math.round(time * 100) / 100,
                            at: Date.now(),
                            sidebar: read('sidebar-slot', 'sidebar-panel'),
                            inspector: read('inspector-slot', 'inspector-panel'),
                            sidebarPhase: document.querySelector('[data-testid="sidebar-slot"]')?.getAttribute('data-sidebar-phase') ?? null,
                            inspectorPhase: document.querySelector('[data-testid="inspector-slot"]')?.getAttribute('data-inspector-phase') ?? null
                        });
                        requestAnimationFrame(tick);
                    };
                    requestAnimationFrame(tick);
                    window.__kelpiSlide = { samples, stop: () => { running = false; } };
                    return true;
                })()`
            );
        const stopSampler = async () => {
            await page.eval(`(() => { window.__kelpiSlide?.stop?.(); return true; })()`);
            return JSON.parse(String(await page.eval(`JSON.stringify(window.__kelpiSlide?.samples ?? [])`)));
        };

        /**
         * One slide: photograph it, then classify every frame's pixels inside the strip the
         * panel sweeps. `strip` is in CSS pixels; frames arrive in the screencast's own scale.
         *
         * `panel` names the moving panel: `{ edge, colour, slot }` — which window edge it comes
         * from, the background its own root paints (read live off the DOM), and the testid of
         * the slot whose animated WIDTH is the revealed region. The revealed region per frame is
         * taken from the rAF sampler by wall clock, so "mid-slide" is the animation's own state
         * rather than a frame index.
         */
        const captureSlide = async (label, strip, panel, act) => {
            frames = [];
            const samplerStarted = await startSampler();
            if (samplerStarted !== true) throw new Error('the rAF sampler did not start');
            const coverageStarted = await startCoverage();
            if (coverageStarted !== true) throw new Error('the grid-coverage observer did not start');
            let t0 = Date.now();
            let samples = [];
            if (options.window) {
                /*
                 * The WINDOW's layer tree, not the renderer's surface (`fromSurface: false` —
                 * see `lib/cdp.mjs` ▸ `screenshot`). Slower than a screencast, so it is a
                 * separate mode rather than the default: it is the only instrument that can see
                 * a pixel the renderer never produced — the window's own background, and every
                 * native `WebContentsView` layered over the page.
                 */
                let grabbing = true;
                t0 = Date.now();
                const loop = (async () => {
                    while (grabbing) {
                        try {
                            const shot = await page.send('Page.captureScreenshot', {
                                format: 'png',
                                captureBeyondViewport: false,
                                fromSurface: false
                            });
                            frames.push({ at: Date.now(), arrived: Date.now(), data: shot.data, metadata: {} });
                        } catch {
                            break;
                        }
                    }
                })();
                await act();
                await sleep(700 * Math.max(1, options.slow));
                grabbing = false;
                await loop;
                samples = await stopSampler();
            } else {
                await page.send('Page.startScreencast', {
                    format: 'png',
                    everyNthFrame: 1,
                    maxWidth: 4096,
                    maxHeight: 4096
                });
                await sleep(120);
                collecting = true;
                t0 = Date.now();
                await act();
                await sleep(700 * Math.max(1, options.slow));
                collecting = false;
                await page.send('Page.stopScreencast').catch(() => {});
                samples = await stopSampler();
            }
            const coverage = await readCoverage();

            const slotKey = panel.slot === 'sidebar-slot' ? 'sidebar' : 'inspector';
            /** The rAF sample nearest a photographed frame's clock, and its index. */
            const sampleAt = (at) => {
                let best = -1;
                let bestGap = Infinity;
                for (let index = 0; index < samples.length; index++) {
                    const gap = Math.abs(samples[index].at - at);
                    if (gap < bestGap) {
                        bestGap = gap;
                        best = index;
                    }
                }
                return bestGap <= 60 ? best : -1;
            };
            /**
             * How far the slot's edge travelled in the frame BEFORE this one.
             *
             * The photograph and the rAF sample are two clocks, and they agree to about a frame.
             * At the start of a slide the reveal is a dozen pixels wide and moves fifteen per
             * frame, so a one-frame disagreement puts the sampling window entirely outside the
             * strip it is meant to be reading. Insetting the moving edge by exactly that travel
             * makes the window provably inside the reveal at either clock — conservative in the
             * only direction that matters: it can never manufacture a failure.
             */
            const travelAt = (index) => {
                if (index <= 0) return 0;
                const now = samples[index]?.[slotKey]?.width;
                const before = samples[index - 1]?.[slotKey]?.width;
                if (typeof now !== 'number' || typeof before !== 'number') return 0;
                return Math.abs(now - before);
            };

            const classified = [];
            let index = 0;
            for (const frame of frames) {
                const image = decodePng(Buffer.from(frame.data, 'base64'));
                const scale = image.width / geometry.innerWidth;
                const x0 = Math.max(0, Math.round(strip.x * scale) + 1);
                const x1 = Math.min(image.width - 1, Math.round((strip.x + strip.width) * scale) - 1);
                const y0 = Math.max(0, Math.round(strip.y * scale) + 2);
                const y1 = Math.min(image.height - 1, Math.round((strip.y + strip.height) * scale) - 2);

                /*
                 * The REVEALED region: the part of the strip the slot has already opened. That is
                 * the region the owner's sentence is about — "the reveal should show the panel's
                 * own colour throughout" — and it is the only region where an answer exists at
                 * all (outside it there is deliberately no panel).
                 */
                const sampleIndex = sampleAt(frame.at);
                const state = sampleIndex < 0 ? null : (samples[sampleIndex][slotKey] ?? null);
                const slotWidth = state === null ? null : state.width;
                const panelOpacity = state === null ? null : state.opacity;
                const coverage = state === null ? null : state.coverage;
                const inset = travelAt(sampleIndex) + 2;
                let rx0 = x0;
                let rx1 = x1;
                let revealedWidth = null;
                if (slotWidth !== null) {
                    revealedWidth = slotWidth - inset;
                    const revealed = Math.round(revealedWidth * scale);
                    if (panel.edge === 'leading') rx1 = Math.min(x1, x0 + revealed);
                    else rx0 = Math.max(x0, x1 - revealed);
                }

                let probe = 0;
                let foreign = 0;
                let sampled = 0;
                let panelPixels = 0;
                let groundPixels = 0;
                let clearPixels = 0;
                let revealedSampled = 0;
                let minX = null;
                let maxX = null;
                const histogram = new Map();
                const revealedHistogram = new Map();
                const foreignHistogram = new Map();
                const rows = 40;
                for (let r = 0; r < rows; r++) {
                    const y = y0 + Math.round(((y1 - y0) * r) / Math.max(1, rows - 1));
                    if (y < 0 || y >= image.height) continue;
                    for (let x = x0; x <= x1; x++) {
                        const pixel = pixelAt(image, x, y);
                        sampled += 1;
                        const key = `${pixel[0]},${pixel[1]},${pixel[2]}`;
                        histogram.set(key, (histogram.get(key) ?? 0) + 1);
                        const isProbe = distance(pixel, PROBE_RGB) <= 40;
                        if (isProbe) probe += 1;
                        const isForeign = !isProbe && !explicable(pixel, paletteRgb, 26);
                        if (isForeign) {
                            foreign += 1;
                            foreignHistogram.set(key, (foreignHistogram.get(key) ?? 0) + 1);
                        }
                        if (isProbe || isForeign) {
                            minX = minX === null ? x : Math.min(minX, x);
                            maxX = maxX === null ? x : Math.max(maxX, x);
                        }
                        if (x >= rx0 && x <= rx1) {
                            revealedSampled += 1;
                            revealedHistogram.set(key, (revealedHistogram.get(key) ?? 0) + 1);
                            // Tolerance 3: in the dark theme the panel (#0C0C10) and the ground
                            // (#0A0A0C) are 4.9 units apart, so anything looser cannot tell the
                            // reveal from the hole it is supposed to have filled.
                            if (panel.colour !== null && distance(pixel, panel.colour) <= 3) panelPixels += 1;
                            if (groundRgb !== null && distance(pixel, groundRgb) <= 3) groundPixels += 1;
                            // A screencast composites an unpainted (transparent) pixel to black.
                            // Under a TRANSPARENT window that is the desktop on the real screen.
                            if (pixel[0] === 0 && pixel[1] === 0 && pixel[2] === 0) clearPixels += 1;
                        }
                    }
                }
                const top = [...histogram.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
                const revealedTop = [...revealedHistogram.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
                const modal = revealedTop[0] === undefined ? null : revealedTop[0][0].split(',').map(Number);
                classified.push({
                    index,
                    ms: frame.at - t0,
                    sampled,
                    slotWidth: slotWidth === null ? null : Math.round(slotWidth * 10) / 10,
                    revealedWidth: revealedWidth === null ? null : Math.round(revealedWidth * 10) / 10,
                    panelOpacity: panelOpacity === null ? null : Math.round(panelOpacity * 1000) / 1000,
                    coverage,
                    revealedSampled,
                    modal: modal === null ? null : modal.join(','),
                    modalIsPanel: modal !== null && panel.colour !== null && distance(modal, panel.colour) <= 3,
                    panelPct: revealedSampled === 0 ? null : Math.round((panelPixels / revealedSampled) * 1000) / 10,
                    groundPct: revealedSampled === 0 ? null : Math.round((groundPixels / revealedSampled) * 1000) / 10,
                    clearPct: revealedSampled === 0 ? null : Math.round((clearPixels / revealedSampled) * 1000) / 10,
                    probe,
                    foreign,
                    xRange: minX === null ? null : [Math.round(minX / scale), Math.round(maxX / scale)],
                    top: top.map(([key, count]) => `${key}×${String(count)}`),
                    revealedTop: revealedTop.map(([key, count]) => `${key}×${String(count)}`),
                    foreignColours: [...foreignHistogram.entries()]
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 6)
                        .map(([key, count]) => `${key}×${String(count)}`)
                });
                if (options.dump) {
                    fs.writeFileSync(
                        path.join(outDir, `${label}-frame-${String(index).padStart(3, '0')}.png`),
                        Buffer.from(frame.data, 'base64')
                    );
                }
                index += 1;
            }

            /*
             * The frames the assertion is about: the panel is genuinely mid-flight (the slot has
             * opened at least 8 CSS px and is not yet at rest), so a reveal exists to look at.
             */
            const restWidth = panel.restWidth;
            const inFlight = classified.filter(
                (frame) =>
                    frame.slotWidth !== null &&
                    frame.slotWidth <= restWidth - 8 &&
                    (frame.revealedWidth ?? 0) >= 8
            );
            const wrong = inFlight.filter((frame) => frame.modalIsPanel !== true);
            const uncovered = inFlight.filter((frame) => (frame.coverage ?? 1) < 0.999);
            const minCoverage = inFlight.reduce((low, frame) => Math.min(low, frame.coverage ?? 1), 1);
            /*
             * §N31's reopened half — the GRID, not the clip. `uncovered` above is the panel
             * against its own reveal; this is the panes against the container the slide is
             * resizing, at the moment the frame is about to paint. Anything above zero is a
             * strip of unpainted window travelling with the panel.
             */
            const gridObservations = coverage.filter((entry) => entry.wrappers > 0);
            const gridUncovered = gridObservations.filter((entry) => entry.uncovered > 0.51);
            const worstGridUncovered = gridObservations.reduce((high, entry) => Math.max(high, entry.uncovered), 0);
            const slide = {
                label,
                strip,
                panelColour: panel.colour === null ? null : panel.colour.join(','),
                frames: classified.length,
                spanMs: classified.length === 0 ? 0 : (classified.at(-1)?.ms ?? 0) - (classified[0]?.ms ?? 0),
                rafSamples: samples.length,
                gridObservations: gridObservations.length,
                gridUncoveredFrames: gridUncovered.length,
                worstGridUncoveredPx: Math.round(worstGridUncovered * 100) / 100,
                inFlightFrames: inFlight.length,
                wrongColourFrames: wrong.length,
                uncoveredFrames: uncovered.length,
                minCoverage,
                clearFrames: inFlight.filter((frame) => (frame.clearPct ?? 0) > 1).length,
                probeFrames: classified.filter((frame) => frame.probe > 0).length,
                foreignFrames: classified.filter((frame) => frame.foreign > 0).length,
                worst: wrong.slice(0, 8),
                trace: classified,
                raf: samples
            };
            report.slides.push(slide);
            /*
             * Evidence, not a contact sheet: at most three photographs per slide, and only of
             * frames that actually failed — the flash itself, so a reader can see what the
             * numbers describe. A run that is green writes no images at all.
             */
            const guilty = [...new Set([...wrong, ...uncovered].map((frame) => frame.index))].slice(0, 3);
            for (const guiltyIndex of guilty) {
                const frame = frames[guiltyIndex];
                if (frame === undefined) continue;
                fs.writeFileSync(
                    path.join(outDir, `${label}-flash-${String(guiltyIndex).padStart(3, '0')}.png`),
                    Buffer.from(frame.data, 'base64')
                );
            }
            log(
                `  ${label}: ${String(classified.length)} frames over ${String(slide.spanMs)}ms ` +
                    `(${String(samples.length)} rAF) — ${String(inFlight.length)} mid-slide, ` +
                    `WRONG COLOUR ${String(wrong.length)}, uncovered ${String(uncovered.length)} ` +
                    `(min coverage ${String(Math.round(minCoverage * 1000) / 10)}%), clear ${String(slide.clearFrames)}, ` +
                    `probe ${String(slide.probeFrames)}, foreign ${String(slide.foreignFrames)} · ` +
                    `GRID uncovered ${String(slide.gridUncoveredFrames)}/${String(slide.gridObservations)} ` +
                    `(worst ${String(slide.worstGridUncoveredPx)}px)`
            );
            for (const frame of inFlight.slice(0, 8)) {
                log(
                    `      w=${String(frame.slotWidth)} α=${String(frame.panelOpacity)} cover=${String(frame.coverage)} ` +
                        `modal ${String(frame.modal)} ${frame.modalIsPanel ? '= panel' : '≠ PANEL'} · ` +
                        `panel ${String(frame.panelPct)}% ground ${String(frame.groundPct)}% clear ${String(frame.clearPct)}%`
                );
            }
            return slide;
        };

        const settle = async () => {
            await sleep(650);
        };

        const whole = { x: 0, y: 0, width: geometry.innerWidth, height: geometry.innerHeight };

        // ── window resize (§N31's side effect) ──────────────────────────────────────
        //
        // The classic Electron artifact: a window grown faster than the renderer can paint
        // shows its own `backgroundColor` along the new edge. This does not measure the colour
        // (after the fix it IS the ground, and a ground pixel is indistinguishable from a
        // painted one) — it measures whether the base is EXPOSED at all, with the base
        // overridden to magenta. If it is, the colour it is painted in is the fix's business,
        // and the shell's `ground` log line says what that colour now is.
        if (options.panels.includes('resize')) {
            /*
             * The viewport, not the OS window: `Browser.getWindowForTarget` is not implemented
             * in Electron, and the artifact belongs to the renderer either way — a compositor
             * handed a bigger viewport than it has painted fills the difference with its base.
             */
            const base = { width: geometry.innerWidth, height: geometry.innerHeight };
            let exposedFrames = 0;
            let worst = 0;
            let total = 0;
            for (let cycle = 0; cycle < Math.max(3, options.cycles); cycle++) {
                for (const delta of [220, -220]) {
                    frames = [];
                    await page.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: 4096, maxHeight: 4096 });
                    await sleep(120);
                    collecting = true;
                    await page.send('Emulation.setDeviceMetricsOverride', {
                        width: base.width + delta,
                        height: base.height + delta,
                        deviceScaleFactor: 0,
                        mobile: false
                    });
                    await sleep(900);
                    collecting = false;
                    await page.send('Page.stopScreencast').catch(() => {});
                    for (const frame of frames) {
                        const image = decodePng(Buffer.from(frame.data, 'base64'));
                        let exposed = 0;
                        for (let y = 2; y < image.height - 2; y += 7) {
                            for (let x = 2; x < image.width - 2; x += 7) {
                                if (distance(pixelAt(image, x, y), PROBE_RGB) <= 40) exposed += 1;
                            }
                        }
                        total += 1;
                        if (exposed > 0) exposedFrames += 1;
                        worst = Math.max(worst, exposed);
                    }
                }
            }
            await page.send('Emulation.clearDeviceMetricsOverride', {});
            report.resize = { frames: total, exposedFrames, worstExposedSamples: worst };
            log(
                `resize: ${String(total)} frames, ${String(exposedFrames)} showing the window's own base ` +
                    `(worst ${String(worst)} sampled pixels) — the base is now the theme ground, not #16161a`
            );
        }

        // ── sidebar ─────────────────────────────────────────────────────────────────
        if (options.panels.includes('sidebar')) {
            const strip =
                options.region === 'full'
                    ? whole
                    : { x: 0, y: rowTop, width: sidebarWidth, height: rowBottom - rowTop };
            const panel = {
                edge: 'leading',
                slot: 'sidebar-slot',
                restWidth: sidebarWidth,
                colour: hexToRgb(palette['--kelpi-sidebar-bg'])
            };
            log(`sidebar panel colour ${String(panel.colour)}`);
            for (let cycle = 0; cycle < options.cycles; cycle++) {
                log(`sidebar cycle ${String(cycle + 1)}/${String(options.cycles)}`);
                await captureSlide(`sidebar-close-${String(cycle)}`, strip, panel, async () => {
                    await page.click('button[aria-label="Toggle sidebar"]');
                });
                await settle();
                await captureSlide(`sidebar-open-${String(cycle)}`, strip, panel, async () => {
                    await page.click('button[aria-label="Toggle sidebar"]');
                });
                await settle();
            }
        }

        // ── inspector ───────────────────────────────────────────────────────────────
        if (options.panels.includes('inspector')) {
            const strip =
                options.region === 'full'
                    ? whole
                    : {
                          x: geometry.innerWidth - INSPECTOR_WIDTH,
                          y: rowTop,
                          width: INSPECTOR_WIDTH,
                          height: rowBottom - rowTop
                      };
            // `Inspector.tsx` paints `tokens.sidebarBackground` — the same ground as the sidebar.
            const panel = {
                edge: 'trailing',
                slot: 'inspector-slot',
                restWidth: INSPECTOR_WIDTH,
                colour: hexToRgb(palette['--kelpi-sidebar-bg'])
            };
            for (let cycle = 0; cycle < options.cycles; cycle++) {
                log(`inspector cycle ${String(cycle + 1)}/${String(options.cycles)}`);
                await captureSlide(`inspector-open-${String(cycle)}`, strip, panel, async () => {
                    await page.click('[data-testid="toggle-inspector"]');
                });
                await settle();
                await captureSlide(`inspector-close-${String(cycle)}`, strip, panel, async () => {
                    await page.click('[data-testid="toggle-inspector"]');
                });
                await settle();
            }
        }

        // ── the alpha sweep: is any pixel of the row UNPAINTED mid-slide? ───────────
        //
        // The screencast cannot answer this. It composites a transparent pixel to black, and the
        // dark theme's own ground is 4 units from black — so the classifier above has to reason
        // about colour, and a colour argument is exactly what a 20 px strip of wallpaper slipped
        // through. `setDefaultBackgroundColorOverride` at alpha 0 plus real screenshots puts the
        // question in the alpha channel instead: alpha 0 means no layer painted here, full stop.
        //
        // It is a separate pass because a screenshot loop and a screencast perturb each other's
        // timing, and because it runs at whatever rate the capture can manage (~8-14 frames per
        // slide) rather than the compositor's.
        if (!options.noAlpha) {
            const alphaOut = { slides: [] };
            await page.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
            const alphaSlide = async (label, act) => {
                const shots = [];
                const grabbing = (async () => {
                    for (let i = 0; i < 14; i++) {
                        try {
                            const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
                            shots.push(shot.data);
                        } catch {
                            break;
                        }
                    }
                })();
                await sleep(40);
                await act();
                await grabbing;
                await settle();
                let worstRun = 0;
                let framesWithHole = 0;
                let worstAt = null;
                for (const data of shots) {
                    const image = decodePng(Buffer.from(data, 'base64'));
                    if (image.channels !== 4) continue;
                    const scale = image.width / geometry.innerWidth;
                    let holeInFrame = 0;
                    for (let r = 0; r < 24; r++) {
                        const y = Math.round((rowTop + 4) * scale) + Math.round(((rowBottom - rowTop - 8) * scale * r) / 23);
                        if (y < 0 || y >= image.height) continue;
                        let run = 0;
                        for (let x = 0; x < image.width; x++) {
                            const alpha = image.data[(y * image.width + x) * 4 + 3];
                            if (alpha === 0) {
                                run += 1;
                                if (run > holeInFrame) holeInFrame = run;
                            } else run = 0;
                        }
                    }
                    if (holeInFrame > 0) framesWithHole += 1;
                    if (holeInFrame > worstRun) {
                        worstRun = holeInFrame;
                        worstAt = Math.round((holeInFrame / scale) * 10) / 10;
                    }
                }
                const entry = { label, shots: shots.length, framesWithHole, worstHolePx: worstAt ?? 0 };
                alphaOut.slides.push(entry);
                log(`  alpha ${label}: ${String(shots.length)} captures · ${String(framesWithHole)} with an UNPAINTED run (worst ${String(entry.worstHolePx)} CSS px)`);
                return entry;
            };
            if (options.panels.includes('inspector')) {
                await page.click('[data-testid="toggle-inspector"]');
                await settle();
                await alphaSlide('inspector-close', async () => { await page.click('[data-testid="toggle-inspector"]'); });
                await alphaSlide('inspector-open', async () => { await page.click('[data-testid="toggle-inspector"]'); });
                await page.click('[data-testid="toggle-inspector"]');
                await settle();
            }
            if (options.panels.includes('sidebar')) {
                await alphaSlide('sidebar-close', async () => { await page.click('button[aria-label="Toggle sidebar"]'); });
                await alphaSlide('sidebar-open', async () => { await page.click('button[aria-label="Toggle sidebar"]'); });
            }
            // Back to whatever the run asked for: magenta under `--probe`, and otherwise CLEARED
            // (an omitted `color` removes the override) rather than left transparent, so the
            // sweep cannot change what a later pass photographs.
            await page.send(
                'Emulation.setDefaultBackgroundColorOverride',
                options.probe ? { color: { r: PROBE_RGB[0], g: PROBE_RGB[1], b: PROBE_RGB[2], a: 1 } } : {}
            );
            report.alpha = alphaOut;
        }

        const wrongTotal = report.slides.reduce((total, slide) => total + slide.wrongColourFrames, 0);
        const inFlightTotal = report.slides.reduce((total, slide) => total + slide.inFlightFrames, 0);
        const clearTotal = report.slides.reduce((total, slide) => total + slide.clearFrames, 0);
        const uncoveredTotal = report.slides.reduce((total, slide) => total + slide.uncoveredFrames, 0);
        const worstCoverage = report.slides.reduce((low, slide) => Math.min(low, slide.minCoverage), 1);
        const gridUncoveredTotal = report.slides.reduce((total, slide) => total + slide.gridUncoveredFrames, 0);
        const worstGridPx = report.slides.reduce((high, slide) => Math.max(high, slide.worstGridUncoveredPx), 0);
        const alphaHoleFrames = (report.alpha?.slides ?? []).reduce((total, slide) => total + slide.framesWithHole, 0);
        const worstAlphaPx = (report.alpha?.slides ?? []).reduce((high, slide) => Math.max(high, slide.worstHolePx), 0);
        report.totals = {
            inFlight: inFlightTotal,
            wrongColour: wrongTotal,
            clear: clearTotal,
            uncovered: uncoveredTotal,
            worstCoverage,
            gridUncovered: gridUncoveredTotal,
            worstGridUncoveredPx: Math.round(worstGridPx * 100) / 100,
            alphaHoleFrames,
            worstAlphaHolePx: worstAlphaPx
        };
        report.shellLog = shell.lines.slice(-60);
        // The per-rAF geometry is the instrument, not the finding: it is a few hundred samples
        // per slide and it dwarfs everything a reader wants. The per-FRAME classification (the
        // evidence) stays.
        for (const slide of report.slides) delete slide.raf;
        fs.writeFileSync(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
        log('');
        log(
            `TOTAL over ${String(report.slides.length)} slides: ${String(inFlightTotal)} mid-slide frames, ` +
                `${String(wrongTotal)} showing a colour that is NOT the panel's, ` +
                `${String(uncoveredTotal)} with the panel not covering the reveal ` +
                `(worst ${String(Math.round(worstCoverage * 1000) / 10)}%), ${String(clearTotal)} with cleared pixels`
        );
        log(
            `GRID over the same slides: ${String(gridUncoveredTotal)} observations where the panes did not cover the ` +
                `container they are inside (worst ${String(report.totals.worstGridUncoveredPx)} CSS px) · ` +
                `alpha sweep: ${String(alphaHoleFrames)} captures with an unpainted run (worst ${String(worstAlphaPx)} CSS px)`
        );
        log(`report: ${path.join(outDir, 'report.json')}`);
        /*
         * Three independent verdicts, because §N31 had three independent faults: the reveal's
         * colour (the clip), the panes' coverage of the grid (the lag), and whether ANY pixel of
         * the row went unpainted (the alpha sweep, which needs no colour argument at all).
         */
        return wrongTotal === 0 && gridUncoveredTotal === 0 && alphaHoleFrames === 0 ? 0 : 1;
    } finally {
        try {
            page?.close();
        } catch {
            // already gone
        }
        await shell?.quit();
        daemon.child.kill('SIGTERM');
        await sleep(400);
        try {
            daemon.child.kill('SIGKILL');
        } catch {
            // already gone
        }
        if (!options.keep) sandbox.cleanup();
        else log(`sandbox kept at ${sandbox.root}`);
    }
}

process.exitCode = await main().catch((error) => {
    process.stderr.write(`${String(error?.stack ?? error)}\n`);
    return 2;
});
