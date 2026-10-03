#!/usr/bin/env node
/**
 * #324 csv engine benchmark (manual; never run in CI).
 *
 *   node scripts/csv-bench.mjs [--size 1g] [--dir <scratch>] [--columns 8] [--regenerate] [--clean]
 *
 * Generates a CSV of the requested size (default 1 GB; reused between runs when the size
 * matches), bundles the daemon's csv engine from source with the daemon's own esbuild, and
 * drives it directly (no daemon, no WS) to measure:
 *
 *   - time to the first 100 readable rows, and the full index scan;
 *   - peak RSS while scanning (sampled) and the row index's size;
 *   - a cell edit plus the save that writes it (byte-copy of every untouched row, then rebase);
 *   - a numeric column sort (external merge above 200k rows) and two finds (no match / common).
 *
 * Numbers are for the PR's testing notes; there are no assertions.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseSize(text) {
    const match = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i.exec(String(text).trim());
    if (!match) throw new Error(`bad --size ${text} (try 1g, 200m, 5000000)`);
    const scale = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2].toLowerCase()];
    return Math.round(Number(match[1]) * scale);
}

function args(argv) {
    const options = { size: 1024 ** 3, dir: path.join(os.tmpdir(), 'kelpi-csv-bench'), columns: 8, regenerate: false, clean: false };
    for (let i = 0; i < argv.length; i += 1) {
        const flag = argv[i];
        if (flag === '--size') options.size = parseSize(argv[++i]);
        else if (flag === '--dir') options.dir = path.resolve(argv[++i]);
        else if (flag === '--columns') options.columns = Math.max(2, Number(argv[++i]) || 8);
        else if (flag === '--regenerate') options.regenerate = true;
        else if (flag === '--clean') options.clean = true;
        else if (flag === '--help' || flag === '-h') {
            process.stdout.write('usage: node scripts/csv-bench.mjs [--size 1g] [--dir <scratch>] [--columns 8] [--regenerate] [--clean]\n');
            process.exit(0);
        } else throw new Error(`unknown argument ${flag}`);
    }
    return options;
}

const fmtBytes = bytes => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`);
const fmtMs = ms => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`);

/** A deterministic mixed csv: ints, quoted text with commas and quotes, floats, dates, blanks. */
function generate(file, size, columns) {
    let seed = 42;
    const random = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
    };
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliett', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa'];
    const header = ['id', 'name', 'amount', 'date', 'category', 'note', ...Array.from({ length: Math.max(0, columns - 6) }, (_, i) => `extra${i + 1}`)].slice(0, columns);
    const fd = fs.openSync(file, 'w');
    try {
        fs.writeSync(fd, `${header.join(',')}\n`);
        let written = Buffer.byteLength(`${header.join(',')}\n`);
        let id = 0;
        while (written < size) {
            const lines = [];
            for (let n = 0; n < 20_000; n += 1) {
                id += 1;
                const w = words[Math.floor(random() * words.length)];
                const fields = [
                    String(id),
                    random() < 0.1 ? `"${w}, ${words[id % words.length]} ""jr"""` : `${w} ${words[(id * 7) % words.length]}`,
                    (random() * 100000).toFixed(2),
                    `2026-${String(1 + (id % 12)).padStart(2, '0')}-${String(1 + (id % 28)).padStart(2, '0')}`,
                    words[id % 5],
                    random() < 0.3 ? '' : `note ${id % 997}`
                ];
                for (let c = 6; c < columns; c += 1) fields.push(String(Math.floor(random() * 1000)));
                lines.push(fields.slice(0, columns).join(','));
            }
            const chunk = `${lines.join('\n')}\n`;
            const bytes = Buffer.from(chunk);
            const take = Math.min(bytes.length, size - written);
            // Never cut a row: stop at the last newline inside the budget.
            const end = take === bytes.length ? take : bytes.lastIndexOf(0x0a, take - 1) + 1;
            if (end <= 0) break;
            fs.writeSync(fd, bytes, 0, end);
            written += end;
            if (end < bytes.length) break;
        }
    } finally {
        fs.closeSync(fd);
    }
}

async function bundleEngine(outDir) {
    const daemonRequire = createRequire(path.join(root, 'packages/daemon/package.json'));
    const { build } = daemonRequire('esbuild');
    const outfile = path.join(outDir, 'csv-engine.mjs');
    const csv = path.join(root, 'packages/daemon/src/content/csv');
    await build({
        stdin: {
            contents: [
                `export { CsvDocument } from ${JSON.stringify(path.join(csv, 'document.ts'))};`,
                `export { openCsvFile } from ${JSON.stringify(path.join(csv, 'open.ts'))};`,
                `export { sortRows } from ${JSON.stringify(path.join(csv, 'sort.ts'))};`
            ].join('\n'),
            resolveDir: root,
            loader: 'ts'
        },
        absWorkingDir: root,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        outfile,
        logLevel: 'warning'
    });
    return import(pathToFileURL(outfile).href);
}

async function main() {
    const options = args(process.argv.slice(2));
    fs.mkdirSync(options.dir, { recursive: true });
    const file = path.join(options.dir, `bench-${options.size}-${options.columns}.csv`);
    if (options.regenerate || !fs.existsSync(file)) {
        process.stdout.write(`generating ${fmtBytes(options.size)} → ${file}\n`);
        const t = performance.now();
        generate(file, options.size, options.columns);
        process.stdout.write(`  generated in ${fmtMs(performance.now() - t)}\n`);
    }
    const work = fs.mkdtempSync(path.join(options.dir, 'run-'));
    const engine = await bundleEngine(work);
    const results = [];
    const record = (metric, value) => results.push([metric, value]);
    let peakRss = process.memoryUsage().rss;
    const sampler = setInterval(() => {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 25);
    const baselineRss = process.memoryUsage().rss;

    try {
        const size = fs.statSync(file).size;
        record('file', `${fmtBytes(size)}, ${options.columns} columns`);

        // Open + scan.
        const tOpen = performance.now();
        let firstRowsAt = null;
        const waiters = [];
        const document = await engine.CsvDocument.create(await engine.openCsvFile(file), {
            watch: false,
            autosaveSmallMs: 3_600_000,
            autosaveLargeMs: 3_600_000,
            autosaveMaxMs: 3_600_000,
            onChange: () => {
                for (const wake of waiters.splice(0)) wake();
            },
            onError: error => process.stderr.write(`engine: ${error.message}\n`)
        });
        while (document.rowCount < 101 && document.scanning !== null) await new Promise(resolve => waiters.push(resolve));
        const firstRows = await document.readView(Array.from({ length: Math.min(100, document.rowCount) }, (_, i) => i), 0, options.columns, 2 * 1024 * 1024);
        firstRowsAt = performance.now() - tOpen;
        record('first 100 rows', `${fmtMs(firstRowsAt)} (${firstRows.length} rows)`);
        await document.scanDone;
        const scanMs = performance.now() - tOpen;
        record('full index scan', `${fmtMs(scanMs)} (${(size / 1024 ** 2 / (scanMs / 1000)).toFixed(0)} MiB/s)`);
        record('rows indexed', document.rowCount.toLocaleString('en-US'));
        record('row index memory', fmtBytes(document.indexBytes));
        record('peak RSS after scan', `${fmtBytes(peakRss)} (baseline ${fmtBytes(baselineRss)})`);
        if (document.fileReadOnly) record('read-only', document.fileReadOnly.message);

        // A random read deep in the file.
        const tDeep = performance.now();
        const middle = Math.floor(document.rowCount / 2);
        await document.readView(Array.from({ length: 100 }, (_, i) => Math.min(document.rowCount - 1, middle + i)), 0, options.columns, 2 * 1024 * 1024);
        record('100 rows mid-file', fmtMs(performance.now() - tDeep));

        // Edit + save (byte-copy of everything untouched, then the rebase).
        const tEdit = performance.now();
        await document.edit(document.generation, [{ op: 'set-cell', row: Math.min(1000, document.rowCount - 1), column: 1, value: 'bench, "edited"' }]);
        const editMs = performance.now() - tEdit;
        const tSave = performance.now();
        await document.startSave();
        await document.whenSaved();
        record('cell edit', fmtMs(editMs));
        record('save after one edit', `${fmtMs(performance.now() - tSave)}${document.error ? ` (error: ${document.error})` : ''}`);

        // Sort by the numeric amount column (pinned header), external merge above 200k rows.
        const tSort = performance.now();
        const total = document.rowCount;
        const order = await engine.sortRows(
            { first: 1, count: total - 1, read: (start, count) => document.columnValues(2, start, count) },
            { direction: 'asc', spillDir: path.join(work, 'sort-spill') }
        );
        record('sort by amount', `${fmtMs(performance.now() - tSort)} (${order.length.toLocaleString('en-US')} rows)`);

        // Find: a needle that never matches (prefilter skips every block) and a common one.
        const tMiss = performance.now();
        const miss = await document.find('zz-no-such-needle-zz');
        record('find (no match)', `${fmtMs(performance.now() - tMiss)} (${miss.total} matches)`);
        const tHit = performance.now();
        const hit = await document.find('note 42');
        record('find "note 42"', `${fmtMs(performance.now() - tHit)} (${hit.total.toLocaleString('en-US')} matches${hit.truncated ? ', capped' : ''})`);
        record('peak RSS overall', fmtBytes(peakRss));
        document.close();
    } finally {
        clearInterval(sampler);
        fs.rmSync(work, { recursive: true, force: true });
        if (options.clean) fs.rmSync(file, { force: true });
    }

    const width = Math.max(...results.map(([metric]) => metric.length));
    process.stdout.write(`\n${'metric'.padEnd(width)}  value\n${'-'.repeat(width)}  ${'-'.repeat(40)}\n`);
    for (const [metric, value] of results) process.stdout.write(`${metric.padEnd(width)}  ${value}\n`);
}

main().catch(error => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exit(1);
});
