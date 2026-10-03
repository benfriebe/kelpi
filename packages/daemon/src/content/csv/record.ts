/**
 * One csv record: parse and serialise (#324, docs/csv-pane.md).
 *
 * RFC 4180 with the scanner's quote rule (`./scan.ts`): a quote opens a quoted field ONLY at the
 * start of a field. Inside a quoted field `""` is a literal quote and any other quote closes it;
 * whatever follows a closing quote up to the next delimiter is kept literally (lenient, so a
 * stray `"abc"def` reads as `abcdef` instead of failing the whole file).
 *
 * Records reach here WITHOUT their line terminator (`stripTerminator`), decoded to a string.
 * An empty record (a blank line) has no fields at all, which is how it round-trips.
 */

import type { CsvDialect } from '@kelpi/protocol';

export interface ParsedRecord {
    readonly fields: string[];
    /** Per field: it was written quoted (kept quoted when the row is re-serialised). */
    readonly quoted: boolean[];
}

const QUOTE = 0x22;

/** Drop one trailing `\n` and the `\r` before it, if present. */
export function stripTerminator(text: string): string {
    let end = text.length;
    if (end > 0 && text.charCodeAt(end - 1) === 0x0a) {
        end -= 1;
        if (end > 0 && text.charCodeAt(end - 1) === 0x0d) end -= 1;
    }
    return end === text.length ? text : text.slice(0, end);
}

export function parseRecord(text: string, delimiter: string): ParsedRecord {
    const fields: string[] = [];
    const quoted: boolean[] = [];
    const n = text.length;
    if (n === 0) return { fields, quoted };
    let i = 0;
    for (;;) {
        if (i < n && text.charCodeAt(i) === QUOTE) {
            // Quoted field.
            i += 1;
            let value = '';
            let from = i;
            let closed = false;
            while (i < n) {
                const c = text.charCodeAt(i);
                if (c === QUOTE) {
                    if (i + 1 < n && text.charCodeAt(i + 1) === QUOTE) {
                        value += text.slice(from, i + 1);
                        i += 2;
                        from = i;
                        continue;
                    }
                    value += text.slice(from, i);
                    i += 1;
                    closed = true;
                    break;
                }
                i += 1;
            }
            if (!closed) {
                value += text.slice(from, n);
                i = n;
            } else {
                // Lenient: anything between the closing quote and the delimiter is literal.
                const next = text.indexOf(delimiter, i);
                const end = next < 0 ? n : next;
                if (end > i) value += text.slice(i, end);
                i = end;
            }
            fields.push(value);
            quoted.push(true);
        } else {
            const next = text.indexOf(delimiter, i);
            const end = next < 0 ? n : next;
            fields.push(text.slice(i, end));
            quoted.push(false);
            i = end;
        }
        if (i >= n) break;
        // `text[i]` is the delimiter. A delimiter at the very end leaves one empty field.
        i += 1;
        if (i === n) {
            fields.push('');
            quoted.push(false);
            break;
        }
    }
    return { fields, quoted };
}

/**
 * Only field `index` of a record (sort keys, find): stops parsing as soon as it has it.
 * Returns '' for a field the record does not have.
 */
export function extractField(text: string, delimiter: string, index: number): string {
    if (text.length === 0) return '';
    // Fast path: no quotes anywhere means plain splitting.
    if (text.indexOf('"') < 0) {
        let start = 0;
        for (let field = 0; field < index; field += 1) {
            const next = text.indexOf(delimiter, start);
            if (next < 0) return '';
            start = next + 1;
        }
        const end = text.indexOf(delimiter, start);
        return text.slice(start, end < 0 ? text.length : end);
    }
    return parseRecord(text, delimiter).fields[index] ?? '';
}

/** A value that must be quoted to survive a round trip. */
export function needsQuote(value: string, delimiter: string): boolean {
    if (value.length === 0) return false;
    if (value.charCodeAt(0) === QUOTE) return true;
    return (
        value.includes(delimiter) ||
        value.includes('"') ||
        value.includes('\n') ||
        value.includes('\r')
    );
}

export function quoteField(value: string): string {
    return `"${value.replaceAll('"', '""')}"`;
}

/**
 * One record in the file's dialect, without a terminator. A field is quoted when it has to be,
 * when it was quoted originally (`quoted[i]`), or always in a quote-all file.
 */
export function serialiseRecord(
    fields: readonly string[],
    quoted: readonly boolean[] | null,
    dialect: Pick<CsvDialect, 'delimiter' | 'quoteAll'>
): string {
    let out = '';
    for (let i = 0; i < fields.length; i += 1) {
        const value = fields[i] ?? '';
        if (i > 0) out += dialect.delimiter;
        if (dialect.quoteAll || quoted?.[i] === true || needsQuote(value, dialect.delimiter)) {
            out += quoteField(value);
        } else out += value;
    }
    // A single empty field would otherwise vanish into a blank line; a blank line has no fields.
    if (fields.length === 1 && out === '') return dialect.quoteAll ? '""' : '';
    return out;
}
