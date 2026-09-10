import path from 'node:path';
import { packPlugin, pluginPackageReport, readPluginPackage } from '@kelpi/core/plugin-package';
import { pluginObject, type JsonObject, type JsonValue } from '@kelpi/protocol';
import { parseFlag, popSwitch } from '../args.js';
import { printLine, errLine, exit } from '../io.js';
import { decodeReply, parseReplyOrExit } from '../reply.js';
import { streamJSON, printTransportFailure } from '../transport.js';
import { scaffoldPlugin } from './plugin-scaffold.js';

export const pluginUsage = `Usage: kelpi plugin <action>
  init <directory> --id <namespaced-id> [--name <title>]
  validate <directory|file.kelpi-plugin> [--json]
  pack <directory> --out <file.kelpi-plugin> [--json]
  list [--json]
  contributions [--json]
  install <directory|file.kelpi-plugin> --trust
  history <plugin-id> [--json]
  rollback <plugin-id> [--revision <sha256>]
  enable|disable|reload|remove|logs <plugin-id>
  open <plugin-id> <view-id> [--workspace <id>] [--state <json>]
  run <command-id> [--args <json>] [--workspace <id>] [--pane <id>]
  settings <plugin-id> [--key <key> --value <json>]
  services [--json]
  service-call <service-id> <method> [--version <n>] [--provider <id>] [--args <json>]
  service-select <service-id> <provider-id|default> [--version <n>]
  watch

Install trusted local code only. Backends run with your account's access.
Results are JSON; watch emits JSON lines. See docs/plugins.md.
`;

export async function handlePlugin(args: string[]): Promise<void> {
    const action = args.shift() ?? 'list';
    if (['help', '-h', '--help'].includes(action)) { printLine(pluginUsage); return; }
    try {
        popSwitch('--json', args);
        if (action === 'init') {
            const id = parseFlag('--id', args); const name = parseFlag('--name', args);
            const directory = args.shift();
            if (!directory || directory.startsWith('-') || !id) throw new Error('init requires a directory and --id <namespaced-id>');
            if (args.length) throw new Error(`unexpected arguments: ${args.join(' ')}`);
            printLine(JSON.stringify(scaffoldPlugin(directory, id, name ?? id), null, 2)); return;
        }
        if (action === 'validate' || action === 'pack') {
            const output = action === 'pack' ? parseFlag('--out', args) : null;
            const source = args.shift();
            if (!source || source.startsWith('-')) throw new Error(`${action} requires a plugin ${action === 'pack' ? 'directory' : 'directory or package file'}`);
            if (action === 'pack' && !output) throw new Error('pack requires --out <file.kelpi-plugin>');
            if (args.length) throw new Error(`unexpected arguments: ${args.join(' ')}`);
            const result = action === 'pack' ? await packPlugin(source, output!) : { path: path.resolve(source), ...pluginPackageReport(await readPluginPackage(source)) };
            printLine(JSON.stringify(result, null, 2)); return;
        }
        const input: Record<string, JsonValue> = {};
        const workspace = parseFlag('--workspace', args); if (workspace) input['workspaceID'] = workspace;
        const pane = parseFlag('--pane', args); if (pane) input['paneID'] = pane;
        const json = (flag: string): JsonObject => pluginObject(JSON.parse(parseFlag(flag, args) ?? '{}'));
        if (action === 'install') {
            input['trust'] = popSwitch('--trust', args);
            const source = args.shift(); if (!source || source.startsWith('-')) throw new Error('install requires a directory or package file');
            input['path'] = path.resolve(source);
        }
        else if (action === 'history' || action === 'rollback') {
            const revision = action === 'rollback' ? parseFlag('--revision', args) : null;
            const id = args.shift();
            if (!id || id.startsWith('-')) throw new Error(`${action} requires a plugin id`);
            input['pluginID'] = id;
            if (revision !== null) {
                if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error('--revision requires a full SHA-256 revision from plugin history');
                input['revision'] = revision;
            }
        }
        else if (action === 'service-call' || action === 'service-select') {
            const version = parseFlag('--version', args) ?? '1';
            if (!/^\d+$/.test(version) || !Number.isSafeInteger(Number(version)) || Number(version) < 1) throw new Error('--version must be a positive integer');
            input['version'] = Number(version);
            if (action === 'service-call') {
                input['args'] = json('--args');
                const provider = parseFlag('--provider', args); if (provider) input['provider'] = provider;
                input['service'] = args.shift() ?? ''; input['method'] = args.shift() ?? '';
                if (!input['service'] || !input['method']) throw new Error('service-call requires a service id and method');
            } else {
                input['service'] = args.shift() ?? ''; const provider = args.shift();
                if (!input['service'] || !provider) throw new Error('service-select requires a service id and provider id (or default)');
                input['provider'] = provider === 'default' ? null : provider;
            }
        }
        else if (action === 'run') { input['args'] = json('--args'); input['command'] = args.shift() ?? ''; }
        else if (action === 'open') { input['state'] = json('--state'); input['pluginID'] = args.shift() ?? ''; input['viewID'] = args.shift() ?? ''; }
        else if (action === 'settings') {
            const key = parseFlag('--key', args); const value = parseFlag('--value', args);
            if ((key === null) !== (value === null)) throw new Error('--key and --value must be provided together');
            if (key !== null) { input['key'] = key; input['value'] = JSON.parse(value!) as JsonObject; }
            input['pluginID'] = args.shift() ?? '';
        } else if (['enable', 'disable', 'reload', 'remove', 'logs'].includes(action)) input['pluginID'] = args.shift() ?? '';
        else if (action !== 'list' && action !== 'watch' && action !== 'services' && action !== 'contributions') throw new Error(`unknown plugin action: ${action}`);
        if (args.length) throw new Error(`unexpected arguments: ${args.join(' ')}`);
        const payload = { command: 'plugin', action, text: JSON.stringify(pluginObject(input)) };
        if (action === 'watch') {
            const outcome = await streamJSON(payload, line => { parseReplyOrExit(line, 'kelpi plugin watch'); printLine(line); });
            if (outcome === 'failed') { printTransportFailure('kelpi plugin watch'); exit(1); }
            if (outcome === 'interrupted') exit(130);
            return;
        }
        const reply = await decodeReply(payload, `kelpi plugin ${action}`, { timeoutSeconds: 35 });
        printLine(JSON.stringify(reply['result'] ?? null, null, 2));
    } catch (error) {
        // The CLI's test exit adapter throws a sentinel; preserve it.
        if (error instanceof Error && error.name === 'ExitError') throw error;
        errLine(`kelpi plugin: ${error instanceof Error ? error.message : String(error)}`); exit(1);
    }
}
