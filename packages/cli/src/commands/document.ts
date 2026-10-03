import fs from 'node:fs';
import { CSV_LIMITS, PLUGIN_MAX_JSON_BYTES, decodeCsvEditOps, pluginObject, type JsonObject, type JsonValue } from '@kelpi/protocol';
import { parseFlag, popSwitch } from '../args.js';
import { printLine, errLine, exit } from '../io.js';
import { decodeReply, parseReplyOrExit } from '../reply.js';
import { streamJSON, printTransportFailure } from '../transport.js';

export const documentUsage = `Usage: kelpi document <action> <pane-id>
  get|watch <pane-id>
  edit <pane-id> --revision <token> (--text <text> | --file <path>)
  save|refresh <pane-id> --revision <token>
  mode <pane-id> edit|view --revision <token>

CSV panes (docs/csv-pane.md):
  csv-state <pane-id>
  rows <pane-id> --start N --count M [--column-start N] [--column-count M]
  csv-edit <pane-id> --generation <token> (--ops '<json>' | --ops-file <path>)
  sort <pane-id> (--column <id> [--direction asc|desc] | --clear)
  find <pane-id> --query <text>
  header-row <pane-id> on|off

Results are JSON. Mutations require the revision returned by get or watch.
Conflicts reject without replacing newer text; writes are never retried.
CSV rows come back in the pane's view order; csv-edit addresses logical rows
and stable column ids, guarded by the generation from csv-state or rows.
A csv-edit batch travels as plugin JSON, at most 256 KiB: split a larger one.
sort and find answer only when the whole file is sorted or searched, so they
wait up to 10 minutes for the reply; other actions wait 35 seconds.
Find a csv pane's ID with: kelpi pane list --json
`;

/** Seconds of silence before an action gives up. */
export const DOCUMENT_TIMEOUT_SECONDS = 35;
/**
 * `sort` and `find` are answered only when the whole file has been sorted or searched (the
 * daemon's `csv-sort` / `csv-find`), which on a 1 GB file takes minutes; the grid gives the same
 * verbs 10 minutes (`CSV_SLOW_COMMAND_TIMEOUT_MS` in the client).
 */
export const DOCUMENT_SLOW_TIMEOUT_SECONDS = 10 * 60;
const SLOW_ACTIONS = new Set(['sort', 'find']);
/**
 * A csv-edit batch rides the plugin request, whose JSON is capped (256 KiB) well below the
 * daemon's own batch limit, so that cap is the one a batch can actually hit.
 */
const BATCH_TOO_BIG = `Edit batch is over the ${PLUGIN_MAX_JSON_BYTES / 1024} KiB a request carries; split it into several csv-edit calls.`;

/** `kelpi document <action>` → the plugin documents method it calls. */
const METHODS: Readonly<Record<string, string>> = {
    get: 'get', watch: 'watch', edit: 'edit', save: 'save', refresh: 'refresh', mode: 'mode',
    'csv-state': 'csv-state', rows: 'csv-rows', 'csv-edit': 'csv-edit', sort: 'csv-sort', find: 'csv-find', 'header-row': 'csv-header-row'
};
const CSV_ACTIONS = new Set(['csv-state', 'rows', 'csv-edit', 'sort', 'find', 'header-row']);

function index(flag: string, value: string | null, required: boolean): number | undefined {
    if (value === null) {
        if (required) throw new Error(`${flag} is required.`);
        return undefined;
    }
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${flag} must be a non-negative integer.`);
    return Number(value);
}

/** The csv actions' flags (consumed from `args`), validated before anything is sent. */
function csvInput(action: string, args: string[], input: Record<string, JsonValue>): void {
    if (action === 'rows') {
        const start = index('--start', parseFlag('--start', args), true)!;
        const count = index('--count', parseFlag('--count', args), true)!;
        const columnStart = index('--column-start', parseFlag('--column-start', args), false);
        const columnCount = index('--column-count', parseFlag('--column-count', args), false);
        if (count > CSV_LIMITS.maxRowsPerRequest) throw new Error(`--count is at most ${CSV_LIMITS.maxRowsPerRequest}.`);
        if (columnCount !== undefined && columnCount > CSV_LIMITS.maxColumnsPerRequest) throw new Error(`--column-count is at most ${CSV_LIMITS.maxColumnsPerRequest}.`);
        Object.assign(input, { start, count }, columnStart === undefined ? {} : { columnStart }, columnCount === undefined ? {} : { columnCount });
    } else if (action === 'csv-edit') {
        const generation = parseFlag('--generation', args), text = parseFlag('--ops', args), file = parseFlag('--ops-file', args);
        if (!generation) throw new Error('--generation is required; read it from csv-state or rows first.');
        if ((text === null) === (file === null)) throw new Error('Provide exactly one of --ops or --ops-file.');
        let source: string;
        if (file !== null) {
            let size: number;
            try {
                size = fs.statSync(file).size;
                source = size > PLUGIN_MAX_JSON_BYTES ? '' : fs.readFileSync(file, 'utf8');
            } catch (error) {
                throw new Error(`Could not read --ops-file ${file}: ${error instanceof Error ? error.message : String(error)}`);
            }
            if (size > PLUGIN_MAX_JSON_BYTES) throw new Error(BATCH_TOO_BIG);
        } else source = text!;
        if (Buffer.byteLength(source, 'utf8') > PLUGIN_MAX_JSON_BYTES) throw new Error(BATCH_TOO_BIG);
        let raw: unknown;
        try { raw = JSON.parse(source); }
        catch { throw new Error(`${file === null ? '--ops' : '--ops-file'} must be a JSON array of csv edit ops.`); }
        const ops = decodeCsvEditOps(raw);
        if (!ops.ok) throw new Error(ops.error);
        Object.assign(input, { generation, ops: ops.value as unknown as JsonValue });
    } else if (action === 'sort') {
        const column = parseFlag('--column', args), direction = parseFlag('--direction', args), clear = popSwitch('--clear', args);
        if (clear === (column !== null)) throw new Error('Provide exactly one of --column or --clear.');
        if (clear && direction !== null) throw new Error('--direction is only valid with --column.');
        if (direction !== null && direction !== 'asc' && direction !== 'desc') throw new Error('--direction must be asc or desc.');
        Object.assign(input, { column: clear ? null : index('--column', column, true)! }, direction === null ? {} : { direction });
    } else if (action === 'find') {
        const query = parseFlag('--query', args);
        if (query === null) throw new Error('--query is required.');
        if (Buffer.byteLength(query, 'utf8') > CSV_LIMITS.maxFindQueryBytes) throw new Error('--query is over 1 KiB.');
        input['query'] = query;
    }
}

export async function handleDocument(args: string[]): Promise<void> {
    const action = args.shift() ?? 'help';
    if (['help', '--help', '-h'].includes(action)) { printLine(documentUsage); return; }
    try {
        popSwitch('--json', args);
        const method = METHODS[action];
        if (method === undefined) throw new Error(`Unknown document action: ${action}`);
        const csv = CSV_ACTIONS.has(action);
        const revision = csv ? null : parseFlag('--revision', args), text = csv ? null : parseFlag('--text', args), file = csv ? null : parseFlag('--file', args);
        // Flags are taken before the pane ID, so `--start 0` can never be mistaken for it.
        const input: Record<string, JsonValue> = {};
        if (csv) {
            // After the csv flags (and their values) are consumed, so `find P --query --file`
            // searches for the text "--file" rather than tripping over it.
            csvInput(action, args, input);
            if (['--revision', '--text', '--file'].some(flag => args.includes(flag))) throw new Error('CSV actions take no --revision, --text or --file; csv-edit is guarded by --generation.');
        }
        const paneID = args.shift();
        if (!paneID || paneID.startsWith('-')) throw new Error('A pane ID is required.');
        input['paneID'] = paneID;
        if (csv) {
            if (action === 'header-row') {
                const value = args.shift();
                if (value !== 'on' && value !== 'off') throw new Error('Header row must be on or off.');
                input['on'] = value === 'on';
            }
        } else {
            if (action !== 'get' && action !== 'watch') {
                if (!revision) throw new Error('--revision is required; read the document first.');
                input['revision'] = revision;
            } else if (revision !== null) throw new Error('--revision is only valid for mutations.');
            if (action === 'edit') {
                if ((text === null) === (file === null)) throw new Error('Provide exactly one of --text or --file.');
                if (file !== null && fs.statSync(file).size > 192 * 1024) throw new Error('Document edit exceeds 192 KiB.');
                input['text'] = text ?? fs.readFileSync(file!, 'utf8');
            } else if (text !== null || file !== null) throw new Error('--text and --file are only valid for edit.');
            if (action === 'mode') { const mode = args.shift(); if (mode !== 'edit' && mode !== 'view') throw new Error('Mode must be edit or view.'); input['mode'] = mode; }
        }
        if (args.length) throw new Error(`Unexpected arguments: ${args.join(' ')}`);
        let request: JsonObject;
        try { request = pluginObject(action === 'watch' ? input : { method, args: input }); }
        catch (error) {
            // Ops under the cap can still push the whole request over it.
            if (action === 'csv-edit' && error instanceof Error && error.message.includes('exceeds')) throw new Error(BATCH_TOO_BIG);
            throw error;
        }
        const payload = { command: 'plugin', action: action === 'watch' ? 'document-watch' : 'document', text: JSON.stringify(request) };
        if (action === 'watch') {
            const outcome = await streamJSON(payload, line => { parseReplyOrExit(line, 'kelpi document watch'); printLine(line); });
            if (outcome === 'failed') { printTransportFailure('kelpi document watch'); exit(1); }
            if (outcome === 'interrupted') exit(130);
        } else {
            const timeoutSeconds = SLOW_ACTIONS.has(action) ? DOCUMENT_SLOW_TIMEOUT_SECONDS : DOCUMENT_TIMEOUT_SECONDS;
            const reply = await decodeReply(payload, `kelpi document ${action}`, { timeoutSeconds });
            printLine(JSON.stringify(reply['result'] ?? null, null, 2));
        }
    } catch (error) {
        if (error instanceof Error && error.name === 'ExitError') throw error;
        errLine(`kelpi document: ${error instanceof Error ? error.message : String(error)}`); exit(1);
    }
}
