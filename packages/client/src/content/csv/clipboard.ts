/**
 * The csv grid's clipboard text (#324): a pasted block is TSV, the way every spreadsheet puts a
 * range on the pasteboard - tab between cells, a line break between rows, and a cell that holds
 * a tab, a line break or a quote wrapped in double quotes with `""` for a quote inside.
 */

/**
 * Parse pasted text into rows of cells. A single trailing line break (which spreadsheets add) is
 * not an extra empty row. Plain text with no tab and no line break is one cell.
 */
export function parseClipboardTable(text: string): string[][] {
    if (text.length === 0) return [['']];
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let index = 0;
    let atFieldStart = true;
    const length = text.length;
    while (index < length) {
        const char = text[index]!;
        if (atFieldStart && char === '"') {
            // A quoted field: read to the closing quote, `""` being a literal quote.
            let closed = false;
            let quoted = '';
            let cursor = index + 1;
            while (cursor < length) {
                const next = text[cursor]!;
                if (next === '"') {
                    if (text[cursor + 1] === '"') {
                        quoted += '"';
                        cursor += 2;
                        continue;
                    }
                    closed = true;
                    cursor++;
                    break;
                }
                quoted += next;
                cursor++;
            }
            const after = text[cursor];
            if (closed && (after === undefined || after === '\t' || after === '\n' || after === '\r')) {
                field = quoted;
                index = cursor;
                atFieldStart = false;
                continue;
            }
            // Not a well-formed quoted field: the quote is just a character.
        }
        if (char === '\t') {
            row.push(field);
            field = '';
            atFieldStart = true;
            index++;
            continue;
        }
        if (char === '\r' || char === '\n') {
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
            atFieldStart = true;
            index += char === '\r' && text[index + 1] === '\n' ? 2 : 1;
            continue;
        }
        field += char;
        atFieldStart = false;
        index++;
    }
    if (!atFieldStart || field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows.length === 0 ? [['']] : rows;
}

/**
 * One cell for the pasteboard, as a TSV field: ⌘V reads the pasteboard as TSV, so a value with a
 * tab or a line break (which would split into several cells) or a leading quote (which would be
 * read as quoting) is wrapped in double quotes with `""` for a quote inside. Anything else goes
 * as it is, which is also what a spreadsheet puts there.
 */
export function clipboardCellText(value: string): string {
    if (!/[\t\r\n]/.test(value) && !value.startsWith('"')) return value;
    return `"${value.replace(/"/g, '""')}"`;
}
