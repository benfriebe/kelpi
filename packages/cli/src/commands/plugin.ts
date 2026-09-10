import path from 'node:path';
import { packPlugin, pluginPackageReport, readPluginPackage } from '@kelpi/core/plugin-package';
import { pluginObject, pluginRecord, type JsonObject, type JsonValue } from '@kelpi/protocol';
import { parseFlag, popSwitch } from '../args.js';
import { printLine, errLine, exit } from '../io.js';
import { decodeReply, parseReplyOrExit } from '../reply.js';
import { sendJSONAndReadReply, streamJSON, printTransportFailure } from '../transport.js';
import { scaffoldPlugin, pluginScaffoldTemplates, type PluginScaffoldTemplate } from './plugin-scaffold.js';
import { startPluginDev } from './plugin-dev.js';

export const pluginUsage = `Usage: kelpi plugin <action>
  init <directory> --id <namespaced-id> [--name <title>] [--template pane|sidebar|document|browser]
  validate <directory|file.kelpi-plugin> [--json]
  pack <directory> --out <file.kelpi-plugin> [--json]
  dev <directory> --trust
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
Results are JSON; watch and dev emit JSON lines. See docs/plugin-development.md.
`;

export async function handlePlugin(args: string[]): Promise<void> {
    const action = args.shift() ?? 'list';
    if (['help', '-h', '--help'].includes(action)) { printLine(pluginUsage); return; }
    try {
        popSwitch('--json', args);
        if (action === 'init') {
            const id = parseFlag('--id', args); const name = parseFlag('--name', args);
            const template = parseFlag('--template', args) ?? 'pane';
            if (!pluginScaffoldTemplates.includes(template as PluginScaffoldTemplate)) throw new Error('unknown plugin template: ' + template + '; choose ' + pluginScaffoldTemplates.join(', '));
            const directory = args.shift();
            if (!directory || directory.startsWith('-') || !id) throw new Error('init requires a directory and --id <namespaced-id>');
            if (args.length) throw new Error(`unexpected arguments: ${args.join(' ')}`);
            printLine(JSON.stringify(scaffoldPlugin(directory, id, name ?? id, template as PluginScaffoldTemplate), null, 2)); return;
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
        if (action === 'dev') {
            const trusted = popSwitch('--trust', args), directory = args.shift();
            if (!directory || directory.startsWith('-')) throw new Error('dev requires a plugin directory');
            if (!trusted) throw new Error('dev requires --trust because every valid edit can execute code');
            if (args.length) throw new Error('unexpected arguments: ' + args.join(' '));
            // A failed edit must reject the apply callback, not exit the watcher via decodeReply.
            const request = async (action: string, input: JsonObject): Promise<unknown> => {
                // Install can wait behind other mutations/dependencies. Keep its captured
                // files until the daemon replies, including when Ctrl-C stops new polls.
                const data = await sendJSONAndReadReply({ command: 'plugin', action, text: JSON.stringify(input) }, { timeoutSeconds: action === 'dev-install' ? 0 : 35 });
                if (!data) throw new Error('No reply from the selected daemon; check its socket and connection.');
                const reply: unknown = JSON.parse(data);
                if (!pluginRecord(reply) || reply['ok'] !== true) throw new Error(pluginRecord(reply) && typeof reply['error'] === 'string' ? reply['error'] : 'Invalid plugin reply from the selected daemon.');
                return reply['result'];
            };
            const identity = await request('identity', {});
            if (!pluginRecord(identity) || typeof identity['daemonID'] !== 'string' || !identity['daemonID'] || !Array.isArray(identity['capabilities']) || !identity['capabilities'].includes('plugin-dev')) throw new Error('plugin dev requires a daemon with plugin revision recovery; update the daemon and CLI together.');
            const daemonID = identity['daemonID'];
            const controller = await startPluginDev(directory, {
                trust: trusted,
                onEvent: event => printLine(JSON.stringify(event)),
                apply: async snapshot => {
                    const result = await request('dev-install', { path: snapshot.path, trust: true, daemonID });
                    if (!Array.isArray(result) || !result.some(item => pluginRecord(item) && pluginRecord(item['manifest']) && item['manifest']['id'] === snapshot.pluginID && item['revision'] === snapshot.revision && item['enabled'] === true && item['status'] !== 'failed')) throw new Error('The daemon did not confirm the requested plugin revision.');
                },
            });
            const { signal } = await controller.done;
            if (signal) exit(signal === 'SIGINT' ? 130 : 143);
            return;
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
