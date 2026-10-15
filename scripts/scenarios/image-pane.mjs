/**
 * Images open in an image pane (docs/content-panes.md §12).
 *
 * What this presses, in a real window against a real daemon: `kelpi open` on a large PNG (fitted,
 * with its size and scale in the caption), a click to actual size and a second to fit, the file
 * rewritten on disk the way a screenshot tool replaces it (the pane redraws without a reopen),
 * ⌘-click on an image path a shell printed, a click on a markdown link to an image and on an
 * inline image in the preview, an SVG, and the same pane on the phone layout.
 *
 * Needs the sandbox CLI, so an `--attach` run only notes that it was skipped.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { phoneToLanding } from '../ui-audit/lib/workbench.mjs';

/** The source this presses (ui-audit/README.md ▸ The rule). */
export const covers = [
    'packages/client/src/content/ImagePane.tsx',
    'packages/client/src/content/asset-credential.ts',
    'packages/client/src/content/bridge.ts',
    'packages/client/src/content/ContentFrame.tsx',
    'packages/daemon/src/content/image.ts',
    'packages/daemon/src/ws/desktop.ts',
    'packages/daemon/src/handlers/app/files.ts'
];

/** A solid-ish RGB PNG of the given size, written without a dependency. */
function png(width, height, color) {
    const row = Buffer.alloc(1 + width * 3);
    const rows = [];
    for (let y = 0; y < height; y += 1) {
        const line = Buffer.from(row);
        for (let x = 0; x < width; x += 1) {
            const [r, g, b] = color(x, y);
            line[1 + x * 3] = r;
            line[2 + x * 3] = g;
            line[3 + x * 3] = b;
        }
        rows.push(line);
    }
    const crcTable = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc = (buffer) => {
        let c = 0xffffffff;
        for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type, data) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const sum = Buffer.alloc(4);
        sum.writeUInt32BE(crc(body));
        return Buffer.concat([length, body, sum]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 2;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

/** What one image pane shows, in one round trip. */
const imageState = (paneID) => `(() => {
    const root = document.querySelector('[data-testid="image-pane-${paneID}"]');
    const img = document.querySelector('[data-testid="image-pane-img-${paneID}"]');
    const viewport = root?.querySelector('[role="img"]') ?? null;
    return JSON.stringify({
        present: root !== null,
        zoom: root?.getAttribute('data-zoom') ?? null,
        natural: img === null ? null : [img.naturalWidth, img.naturalHeight],
        drawn: img === null ? null : [Math.round(img.getBoundingClientRect().width), Math.round(img.getBoundingClientRect().height)],
        viewport: viewport === null ? null : [viewport.clientWidth, viewport.clientHeight, viewport.scrollWidth, viewport.scrollHeight],
        cursor: viewport?.style.cursor ?? null,
        caption: (document.querySelector('[data-testid="image-pane-caption-${paneID}"]')?.textContent ?? '').trim(),
        src: img?.getAttribute('src') ?? null,
        error: (document.querySelector('[data-testid="content-status-${paneID}"]')?.textContent ?? '').trim()
    });
})()`;

export default async function ({ page, cli, sandbox, rec, d, sleep }) {
    if (!cli || !sandbox) {
        rec.note('attached: no sandbox CLI, so the image scenario was skipped');
        return;
    }
    await page.watchFrames();

    const workspaces = JSON.parse(await cli.ok(['workspace', 'list', '--json']));
    const homeID = workspaces.find((workspace) => workspace.is_active === true)?.id ?? null;
    const created = JSON.parse(await cli.ok(['workspace', 'create', '--name', 'Image Pane', '--json']));
    const ownID = created.workspace_id ?? created.id;
    rec.check('a workspace of its own was created', typeof ownID === 'string', JSON.stringify(created));
    if (typeof ownID !== 'string') return;
    const row = `[data-testid="workspace-row"][data-workspace-id="${String(ownID)}"]`;
    if (await d.settleDom(page, `document.querySelector(${JSON.stringify(row)})`, { ceilingMs: 8_000 })) await page.click(row);

    const dir = path.join(sandbox.root, 'pics');
    fs.mkdirSync(dir, { recursive: true });
    const big = path.join(dir, 'big shot.png');
    const icon = path.join(dir, 'icon.png');
    const svg = path.join(dir, 'diagram.svg');
    fs.writeFileSync(big, png(2400, 1600, (x, y) => [Math.floor((x * 255) / 2400), Math.floor((y * 255) / 1600), 160]));
    fs.writeFileSync(icon, png(48, 48, (x, y) => ((Math.floor(x / 8) + Math.floor(y / 8)) % 2 ? [230, 80, 60] : [40, 40, 40])));
    fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200" fill="#1e6"/><circle cx="160" cy="100" r="70" fill="#fff"/></svg>');
    const readme = path.join(dir, 'README.md');
    fs.writeFileSync(readme, '# Pics\n\nThe [big shot](big%20shot.png) and an inline icon:\n\n![icon](icon.png)\n');

    const panes = async () => JSON.parse(await cli.ok(['pane', 'list', '--workspace', String(ownID), '--json']));
    const imagePanes = async () => (await panes()).filter((pane) => pane.type === 'image');
    const imagePaneFor = async (file) => (await imagePanes()).find((pane) => pane.file_path === file || pane.title === path.basename(file)) ?? null;
    const read = async (paneID) => JSON.parse(String(await page.eval(imageState(paneID))));

    try {
        await d.settle(async () => (await d.domPaneIDs(page)).length > 0, { ceilingMs: 15_000, intervalMs: 200 });
        const shell = (await panes()).find((pane) => pane.type === 'shell')?.id ?? null;
        rec.check('the workspace has a shell pane', shell !== null);
        if (shell === null) return;

        // ── kelpi open ─────────────────────────────────────────────────────────────────
        await cli.ok(['open', '--focus', big], { paneID: shell });
        const opened = await d.settle(async () => (await imagePaneFor(big)) !== null, { ceilingMs: 10_000, intervalMs: 200 });
        const bigPane = (await imagePaneFor(big))?.id ?? '';
        rec.check('kelpi open "big shot.png" opened an image pane', opened && bigPane !== '', JSON.stringify(await panes()));
        if (bigPane === '') return;
        const drawn = await d.settleDom(page, `document.querySelector('[data-testid="image-pane-img-${bigPane}"]')?.naturalWidth === 2400`, { ceilingMs: 10_000 });
        let state = await read(bigPane);
        rec.check('the pane draws the file from the daemon (2400 × 1600)', drawn, JSON.stringify(state));
        rec.check('it is fitted: drawn no larger than the pane, and the caption gives size and scale', state.zoom === 'fit' && state.drawn !== null && state.viewport !== null && state.drawn[0] <= state.viewport[0] && state.drawn[1] <= state.viewport[1] && /^2400 × 1600 · \d+%$/.test(state.caption), JSON.stringify(state));
        rec.check('the image is served from the credentialed pane-assets route', /\/pane-assets\/c\/[^/]+\/[^/]+\/big%20shot\.png/.test(state.src ?? ''), String(state.src));
        await rec.shot(page, 'image-fitted');

        // ── zoom ───────────────────────────────────────────────────────────────────────
        const viewport = `[data-testid="image-pane-${bigPane}"] [role="img"]`;
        await page.click(viewport);
        await d.settleDom(page, `document.querySelector('[data-testid="image-pane-${bigPane}"]')?.getAttribute('data-zoom') === 'actual'`, { ceilingMs: 3_000 });
        state = await read(bigPane);
        rec.check('a click shows actual size, scrollable', state.zoom === 'actual' && state.drawn?.[0] === 2400 && state.viewport !== null && state.viewport[2] > state.viewport[0], JSON.stringify(state));
        await rec.shot(page, 'image-actual-size');
        await page.click(viewport);
        await d.settleDom(page, `document.querySelector('[data-testid="image-pane-${bigPane}"]')?.getAttribute('data-zoom') === 'fit'`, { ceilingMs: 3_000 });
        rec.check('a second click fits it again', (await read(bigPane)).zoom === 'fit');

        // ── live reload: replaced the way a screenshot tool writes ──────────────────────
        const temp = path.join(dir, '.big shot.png.tmp');
        fs.writeFileSync(temp, png(1200, 800, () => [20, 120, 220]));
        fs.renameSync(temp, big);
        const reloaded = await d.settleDom(page, `document.querySelector('[data-testid="image-pane-img-${bigPane}"]')?.naturalWidth === 1200`, { ceilingMs: 8_000 });
        state = await read(bigPane);
        rec.check('a file replaced on disk redraws in place (1200 × 800)', reloaded && state.caption.startsWith('1200 × 800'), JSON.stringify(state));
        await rec.shot(page, 'image-reloaded');

        // ── ⌘-click an image path a shell printed ────────────────────────────────────────
        await d.focusPaneBody(page, shell);
        await d.runInTerminal(page, `clear; printf '%s\\n' '${icon}'`, { settleMs: 1_200 });
        const metrics = await page.eval(
            `(() => {
                const root = document.querySelector('[data-pane-id="${shell}"][data-terminal-cell]');
                const host = root?.querySelector('[data-terminal-host]') ?? null;
                const cell = (root?.getAttribute('data-terminal-cell') ?? '').split('x');
                const rect = host?.getBoundingClientRect?.() ?? null;
                return {
                    cellW: Number(cell[0] ?? 0), cellH: Number(cell[1] ?? 0),
                    clientW: host?.clientWidth ?? 0, clientH: host?.clientHeight ?? 0,
                    left: rect?.left ?? 0, top: rect?.top ?? 0,
                    width: rect?.width ?? 0, height: rect?.height ?? 0
                };
            })()`
        );
        const cols = Math.floor((metrics?.clientW ?? 0) / (metrics?.cellW || 1));
        const rows = Math.floor((metrics?.clientH ?? 0) / (metrics?.cellH || 1));
        rec.note(`grid ${String(cols)} x ${String(rows)}`);
        if (cols > 0 && rows > 2) {
            // Row 0 is the prompt and the command; the printed path starts row 1 at column 0.
            const x = metrics.left + 2.5 * (metrics.width / cols);
            const y = metrics.top + 1.5 * (metrics.height / rows);
            await page.clickAt(x, y, { modifiers: d.MOD.meta });
            const iconOpened = await d.settle(async () => (await imagePaneFor(icon)) !== null, { ceilingMs: 6_000, intervalMs: 200 });
            rec.check('a ⌘-click on an image path in a terminal opens an image pane', iconOpened, JSON.stringify((await panes()).map((pane) => [pane.type, pane.file_path])));
            const iconPane = (await imagePaneFor(icon))?.id ?? '';
            if (iconPane !== '') {
                await d.settleDom(page, `document.querySelector('[data-testid="image-pane-img-${iconPane}"]')?.naturalWidth === 48`, { ceilingMs: 6_000 });
                state = await read(iconPane);
                rec.check('a small image is never scaled up, and has no zoom', state.caption === '48 × 48' && state.cursor === 'default' && state.drawn?.[0] === 48, JSON.stringify(state));
                await rec.shot(page, 'image-from-terminal');
                await cli.ok(['pane', 'close', '--target', iconPane]);
            }
        } else rec.check('the shell pane has a grid to click', false, JSON.stringify(metrics));

        // ── a markdown preview's link and inline image ────────────────────────────────────
        await cli.ok(['pane', 'close', '--target', bigPane]);
        await cli.ok(['open', '--focus', readme], { paneID: shell });
        await d.settle(async () => (await panes()).some((pane) => pane.type === 'markdown'), { ceilingMs: 8_000, intervalMs: 200 });
        const markdown = (await panes()).find((pane) => pane.type === 'markdown')?.id ?? '';
        const frame = `[data-testid="content-iframe-${markdown}"]`;
        const inFrame = async (expression) => {
            try {
                return await page.evalInFrame(frame, expression);
            } catch {
                return null;
            }
        };
        const linkReady = await d.settle(async () => (await inFrame(`document.querySelector('a[href]') !== null && document.querySelector('img')?.complete === true`)) === true, { ceilingMs: 10_000, intervalMs: 200 });
        rec.check('the markdown preview shows its link and its inline image', linkReady);
        // A sibling image loads at all only through this client's credentialed base: the daemon's
        // own base is 404 on a daemon with a token.
        const inlineLoaded = await d.settle(async () => (await inFrame(`document.querySelector('img')?.naturalWidth === 48`)) === true, { ceilingMs: 6_000, intervalMs: 200 });
        rec.check('the preview\'s inline image loads (its sibling file, through the credentialed base)', inlineLoaded, String(await inFrame(`document.querySelector('img')?.src + ' base ' + document.baseURI`)));
        /** Click an element inside the preview, at its centre, in page coordinates. */
        const clickInFrame = async (selector) => {
            const outer = await page.box(frame);
            const inner = await inFrame(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
            if (outer === null || inner === null) return false;
            await page.clickAt(outer.x + inner.x, outer.y + inner.y);
            return true;
        };
        const cursor = await inFrame(`getComputedStyle(document.querySelector('img')).cursor`);
        rec.check('a local inline image shows a zoom-in cursor', cursor === 'zoom-in', String(cursor));
        if (linkReady) {
            await clickInFrame('a[href]');
            const fromLink = await d.settle(async () => (await imagePaneFor(big)) !== null, { ceilingMs: 6_000, intervalMs: 200 });
            rec.check('a click on a markdown link to an image opens an image pane', fromLink, JSON.stringify((await panes()).map((pane) => [pane.type, pane.file_path])));
            await clickInFrame('img');
            const fromImage = await d.settle(async () => (await imagePaneFor(icon)) !== null, { ceilingMs: 6_000, intervalMs: 200 });
            rec.check('a click on a local inline image opens it in an image pane', fromImage, JSON.stringify((await panes()).map((pane) => [pane.type, pane.file_path])));
            await rec.shot(page, 'image-from-markdown');
            for (const pane of await imagePanes()) await cli.ok(['pane', 'close', '--target', pane.id]);
        }

        // ── SVG ─────────────────────────────────────────────────────────────────────────
        await cli.ok(['open', '--focus', svg], { paneID: shell });
        await d.settle(async () => (await imagePaneFor(svg)) !== null, { ceilingMs: 8_000, intervalMs: 200 });
        const svgPane = (await imagePaneFor(svg))?.id ?? '';
        const svgDrawn = svgPane !== '' && await d.settleDom(page, `document.querySelector('[data-testid="image-pane-img-${svgPane}"]')?.naturalWidth === 320`, { ceilingMs: 6_000 });
        rec.check('an SVG opens and draws in an image pane', svgDrawn, svgPane === '' ? 'no pane' : JSON.stringify(await read(svgPane)));

        // ── phone ───────────────────────────────────────────────────────────────────────
        if (svgPane !== '') {
            await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
            await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
            try {
                await d.settleDom(page, `document.querySelector('[data-testid="phone-shell"]') !== null`, { ceilingMs: 8_000 });
                const phoneRow = `[data-testid="phone-shell"] [data-workspace-id="${String(ownID)}"]`;
                if (await d.settleDom(page, `document.querySelector(${JSON.stringify(phoneRow)}) !== null`, { ceilingMs: 6_000 })) await page.click(phoneRow);
                if (await d.settleDom(page, `document.querySelector('[data-testid="phone-title"]') !== null`, { ceilingMs: 6_000 })) await page.click('[data-testid="phone-title"]');
                const show = `[data-testid="phone-pane-show-${svgPane}"]`;
                if (await d.settleDom(page, `document.querySelector(${JSON.stringify(show)}) !== null`, { ceilingMs: 6_000 })) await page.click(show);
                const phoneImage = await d.settleDom(page, `document.querySelector('[data-testid="phone-shell"] [data-testid="image-pane-img-${svgPane}"]')?.naturalWidth === 320`, { ceilingMs: 8_000 });
                rec.check('the phone shows the image pane', phoneImage);
                await rec.shot(page, 'image-phone');
            } finally {
                if (!await phoneToLanding(page, d, { note: rec.note })) rec.note('the phone shell did not return to its landing page');
                await page.send('Emulation.clearDeviceMetricsOverride');
                await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
            }
        }
        await sleep(100);
    } finally {
        await cli.run(['workspace', 'delete', String(ownID), '--force']);
        const home = `[data-testid="workspace-row"][data-workspace-id="${String(homeID)}"]`;
        if (homeID !== null && (await d.settleDom(page, `document.querySelector(${JSON.stringify(home)})`, { ceilingMs: 8_000 }))) await page.click(home);
    }
}
