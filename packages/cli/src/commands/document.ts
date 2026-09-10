import fs from 'node:fs';
import { pluginObject, type JsonValue } from '@kelpi/protocol';
import { parseFlag, popSwitch } from '../args.js';
import { printLine, errLine, exit } from '../io.js';
import { decodeReply, parseReplyOrExit } from '../reply.js';
import { streamJSON, printTransportFailure } from '../transport.js';

export const documentUsage = `Usage: kelpi document <action> <pane-id>
  get|watch <pane-id>
  edit <pane-id> --revision <token> (--text <text> | --file <path>)
  save|refresh <pane-id> --revision <token>
  mode <pane-id> edit|view --revision <token>

Results are JSON. Mutations require the revision returned by get or watch.
Conflicts reject without replacing newer text; writes are never retried.
`;

export async function handleDocument(args: string[]): Promise<void> {
    const method = args.shift() ?? 'help';
    if (['help', '--help', '-h'].includes(method)) { printLine(documentUsage); return; }
    try {
        popSwitch('--json', args);
        const revision = parseFlag('--revision', args), text = parseFlag('--text', args), file = parseFlag('--file', args);
        const paneID = args.shift();
        if (!paneID || paneID.startsWith('-')) throw new Error('A pane ID is required.');
        if (!['get', 'watch', 'edit', 'save', 'refresh', 'mode'].includes(method)) throw new Error(`Unknown document action: ${method}`);
        const input: Record<string, JsonValue> = { paneID };
        if (method !== 'get' && method !== 'watch') {
            if (!revision) throw new Error('--revision is required; read the document first.');
            input['revision'] = revision;
        } else if (revision !== null) throw new Error('--revision is only valid for mutations.');
        if (method === 'edit') {
            if ((text === null) === (file === null)) throw new Error('Provide exactly one of --text or --file.');
            if (file !== null && fs.statSync(file).size > 192 * 1024) throw new Error('Document edit exceeds 192 KiB.');
            input['text'] = text ?? fs.readFileSync(file!, 'utf8');
        } else if (text !== null || file !== null) throw new Error('--text and --file are only valid for edit.');
        if (method === 'mode') { const mode = args.shift(); if (mode !== 'edit' && mode !== 'view') throw new Error('Mode must be edit or view.'); input['mode'] = mode; }
        if (args.length) throw new Error(`Unexpected arguments: ${args.join(' ')}`);
        const payload = { command: 'plugin', action: method === 'watch' ? 'document-watch' : 'document', text: JSON.stringify(pluginObject(method === 'watch' ? input : { method, args: input })) };
        if (method === 'watch') {
            const outcome = await streamJSON(payload, line => { parseReplyOrExit(line, 'kelpi document watch'); printLine(line); });
            if (outcome === 'failed') { printTransportFailure('kelpi document watch'); exit(1); }
            if (outcome === 'interrupted') exit(130);
        } else {
            const reply = await decodeReply(payload, `kelpi document ${method}`, { timeoutSeconds: 35 });
            printLine(JSON.stringify(reply['result'] ?? null, null, 2));
        }
    } catch (error) {
        if (error instanceof Error && error.name === 'ExitError') throw error;
        errLine(`kelpi document: ${error instanceof Error ? error.message : String(error)}`); exit(1);
    }
}
