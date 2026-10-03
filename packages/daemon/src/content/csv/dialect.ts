/**
 * Csv dialect detection (#324, docs/csv-pane.md): delimiter, line ending, BOM, quote-all.
 *
 *   - delimiter: `.tsv` is tab; anything else sniffs `, ; \t |` over the first 64 KiB and takes
 *     the candidate whose records most consistently have the same (more than one) field count,
 *     defaulting to comma. Sniffing uses the scanner itself, so quoting is honoured exactly the
 *     way the index will honour it;
 *   - line ending: the first record terminator's;
 *   - BOM: a UTF-8 BOM is skipped for parsing and written back on save. UTF-16/32 BOMs make the
 *     document read-only (only UTF-8 is supported);
 *   - quote-all: every field of every complete sample record was quoted, so edited rows quote
 *     every field too and the file keeps its look.
 */

import type { CsvDelimiter, CsvDialect, CsvLineEnding } from '@kelpi/protocol';

import { CsvScanner } from './scan.js';
import { parseRecord, stripTerminator } from './record.js';

export const SNIFF_BYTES = 64 * 1024;
const SNIFF_RECORDS = 200;
const CANDIDATES: readonly CsvDelimiter[] = [',', ';', '\t', '|'];

export type BomKind = 'utf8' | 'utf16le' | 'utf16be' | 'utf32le' | 'utf32be';

export function detectBom(head: Uint8Array): { readonly kind: BomKind | null; readonly length: number } {
    const b0 = head[0];
    const b1 = head[1];
    const b2 = head[2];
    const b3 = head[3];
    if (b0 === 0xef && b1 === 0xbb && b2 === 0xbf) return { kind: 'utf8', length: 3 };
    if (b0 === 0xff && b1 === 0xfe && b2 === 0x00 && b3 === 0x00) return { kind: 'utf32le', length: 4 };
    if (b0 === 0x00 && b1 === 0x00 && b2 === 0xfe && b3 === 0xff) return { kind: 'utf32be', length: 4 };
    if (b0 === 0xff && b1 === 0xfe) return { kind: 'utf16le', length: 2 };
    if (b0 === 0xfe && b1 === 0xff) return { kind: 'utf16be', length: 2 };
    return { kind: null, length: 0 };
}

export function extensionOf(filePath: string): string {
    const base = filePath.slice(filePath.lastIndexOf('/') + 1);
    const dot = base.lastIndexOf('.');
    return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

interface SampleRecord {
    readonly start: number;
    readonly end: number;
    readonly fields: number;
}

function sampleRecords(sample: Buffer, delimiter: string, whole: boolean): SampleRecord[] {
    const records: SampleRecord[] = [];
    const scanner = new CsvScanner(delimiter.charCodeAt(0), 0, null, Number.MAX_SAFE_INTEGER, (start, end, fields) => {
        if (records.length < SNIFF_RECORDS) records.push({ start, end, fields });
    });
    scanner.feed(sample, 0);
    // The last record of a truncated sample is cut off; only a whole file's last record counts.
    if (whole) scanner.finish(sample.length);
    return records;
}

function score(records: readonly SampleRecord[]): { consistent: number; fields: number } {
    const counts = new Map<number, number>();
    for (const record of records) {
        if (record.fields === 0) continue; // blank lines say nothing
        counts.set(record.fields, (counts.get(record.fields) ?? 0) + 1);
    }
    let best = { consistent: 0, fields: 0 };
    for (const [fields, consistent] of counts) {
        if (fields < 2) continue;
        if (consistent > best.consistent || (consistent === best.consistent && fields > best.fields)) {
            best = { consistent, fields };
        }
    }
    return best;
}

/**
 * `sample` starts AFTER any BOM. `whole` says the sample is the entire file (so its last record
 * is complete even without a terminator).
 */
export function sniffDialect(
    sample: Buffer,
    options: { readonly extension: string; readonly bom: boolean; readonly whole: boolean }
): CsvDialect {
    let delimiter: CsvDelimiter = ',';
    if (options.extension === 'tsv') delimiter = '\t';
    else {
        let best = { consistent: 0, fields: 0 };
        for (const candidate of CANDIDATES) {
            const result = score(sampleRecords(sample, candidate, options.whole));
            if (result.consistent > best.consistent) {
                best = result;
                delimiter = candidate;
            }
        }
    }
    const records = sampleRecords(sample, delimiter, options.whole);
    let lineEnding: CsvLineEnding = '\n';
    const first = records[0];
    if (first !== undefined && first.end <= sample.length && sample[first.end - 1] === 0x0a) {
        lineEnding = first.end >= 2 && sample[first.end - 2] === 0x0d ? '\r\n' : '\n';
    }
    let quoted = 0;
    let fields = 0;
    for (const record of records) {
        const parsed = parseRecord(stripTerminator(sample.toString('utf8', record.start, record.end)), delimiter);
        fields += parsed.fields.length;
        for (const flag of parsed.quoted) if (flag) quoted += 1;
    }
    return { delimiter, lineEnding, bom: options.bom, quoteAll: fields > 0 && quoted === fields };
}
