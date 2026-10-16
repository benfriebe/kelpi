/**
 * #329: the width table the daemon's emulator loads must not depend on what Node allocated first.
 *
 * `@xterm/addon-unicode-graphemes` decodes its 3 KB width trie with `Buffer.from(base64)`, which
 * Node serves from its shared 8 KB pool at whatever offset the pool has reached, and then reads the
 * trie's header through `new DataView(data.buffer)`: offset 0 of the POOL, not of the trie. In a
 * fresh process the two coincide and every width is right; in the daemon, which has allocated
 * plenty by the time the addon loads, the header was other bytes, `highStart` came out below the
 * emoji block and every astral emoji (`🚀`, `🔥`, `📁`) read as one cell while `✅` read as two.
 * The patch (`patches/@xterm__addon-unicode-graphemes@0.4.0.patch`) reads the header at the
 * trie's own offset, in both builds: the CommonJS one (`main`) that Node and the daemon's esbuild
 * bundle load, and the ES module one (`module`) a bundler or an inlining test runner may pick.
 * This loads each fresh with a pool whose first bytes are a hostile header, which is the daemon's
 * situation made deterministic.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import headless from '@xterm/headless';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { Terminal } = headless;

interface AddonModule {
    UnicodeGraphemesAddon: new () => { activate(terminal: unknown): void; dispose(): void };
}

/**
 * Start a new Buffer pool and put a header at its offset 0 that names a trie whose supplementary
 * planes start at U+10000 and end straight away (`highStart`), so a reader that takes the pool's
 * offset 0 for the trie's answers every astral codepoint with the default (one cell).
 */
function poisonPool(): void {
    for (let attempt = 0; attempt < 4096; attempt++) {
        const slot = Buffer.allocUnsafe(16);
        if (slot.byteOffset !== 0) continue;
        slot.writeUInt32LE(0x10000, 0);
        slot.writeUInt32LE(0, 4);
        slot.writeUInt32LE(0x20000, 8);
        slot.writeUInt32LE(0, 12);
        return;
    }
    throw new Error('never saw a fresh Buffer pool');
}

function rocketWidth(addon: AddonModule): number {
    const term = new Terminal({ allowProposedApi: true });
    term.loadAddon(new addon.UnicodeGraphemesAddon());
    const service = (term as unknown as { _core: { unicodeService: { getStringCellWidth(text: string): number } } })._core
        .unicodeService;
    const width = service.getStringCellWidth('🚀');
    term.dispose();
    return width;
}

describe('the graphemes width table (#329)', () => {
    // The CommonJS build: what Node and the daemon's esbuild bundle load (`main`).
    it('reads its trie at the trie, whatever the Buffer pool held', () => {
        const main = require.resolve('@xterm/addon-unicode-graphemes');
        delete require.cache[main];
        poisonPool();
        const addon = require(main) as AddonModule;
        expect(rocketWidth(addon)).toBe(2);
    });

    it('and in the ES module build', async () => {
        const esm = path.join(path.dirname(require.resolve('@xterm/addon-unicode-graphemes')), 'addon-unicode-graphemes.mjs');
        poisonPool();
        const addon = (await import(`${pathToFileURL(esm).href}?fresh=${String(Date.now())}`)) as AddonModule;
        expect(rocketWidth(addon)).toBe(2);
    });
});
