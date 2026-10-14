/** Plugin CLI verbs (#391): an installed plugin's `kelpi hello` runs with its argv, prints, exits, lists, and refuses clashes. */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const covers = ['examples/plugins/cli-lab/', 'packages/cli/src/commands/plugin-cli.ts', 'packages/cli/src/cli.ts', 'packages/protocol/src/cli-verbs.ts'];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const example = path.join(repoRoot, 'examples/plugins/cli-lab');
const entry = path.join(repoRoot, 'packages/cli/dist/kelpi.js');
const pluginID = 'example.cli-lab';

/** A fixture plugin whose only verb maps onto its only command. */
const fixture = (dir, id, verb) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'kelpi.plugin.json'), JSON.stringify({
        id, name: id, version: '1.0.0', apiVersion: 1, trust: 'full', backend: 'backend.mjs', activation: 'on-demand',
        contributes: { views: [], commands: [{ id: id + '.run', title: 'Run' }], cli: [{ name: verb, command: id + '.run', summary: 'Fixture verb' }] },
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'backend.mjs'), `export function activate(api) { return api.commands.register(${JSON.stringify(id + '.run')}, () => ({ text: ${JSON.stringify(id)} })); }\n`);
    return dir;
};

/** A stand-in daemon that records every request a CLI call sends and answers each one. */
const probeDaemon = async () => {
    const requests = [];
    const server = net.createServer(socket => {
        let buffered = '';
        socket.setEncoding('utf8');
        socket.on('data', chunk => {
            buffered += chunk;
            if (!buffered.includes('\n')) return;
            const request = JSON.parse(buffered.slice(0, buffered.indexOf('\n')));
            requests.push(request);
            socket.end(JSON.stringify(request.command === 'plugin' ? { ok: true, result: { text: 'probe' } } : { ok: true, result: [] }) + '\n');
        });
        socket.on('error', () => {});
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { requests, port: server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
};

export default async function ({ cli, sandbox, rec }) {
    const cwd = path.join(sandbox.root, 'cli-verb-caller');
    fs.mkdirSync(cwd, { recursive: true });
    const run = (args, opts = {}) => cli.run(args, { cwd, ...opts });
    // `cli.run` throws on `Unknown command:` as a misspelled harness call. Here it is the answer
    // under test, so this one call goes through the same entry and route without that guard.
    const unguarded = args => new Promise(resolve => execFile(process.execPath, [entry, ...args], {
        cwd, timeout: 45_000,
        env: { PATH: sandbox.env.PATH, HOME: sandbox.home, KELPI_SOCKET: 'tcp:127.0.0.1:' + sandbox.controlPort, KELPI_REQUIRE_SOCKET: '1' },
    }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout, stderr })));
    const summary = result => JSON.stringify({ code: result.code, stdout: result.stdout, stderr: result.stderr.slice(0, 600) });
    const probe = await probeDaemon();
    const removals = [];
    try {
        rec.note('Install the CLI Lab example and run its verb');
        await cli.ok(['plugin', 'install', example, '--trust']);
        removals.push(pluginID);
        const hello = await run(['hello', 'a', 'b']);
        rec.check('kelpi hello a b prints hello a b and exits 0', hello.code === 0 && hello.stdout === 'hello a b\n' && hello.stderr === '', summary(hello));
        const usage = await run(['hello', '--help']);
        rec.check('kelpi hello --help reaches the plugin as argv', usage.code === 0 && usage.stdout.startsWith('Usage: kelpi hello'), summary(usage));

        const exited = await run(['hello', '--exit', '3', 'x']);
        rec.check('kelpi hello --exit 3 x exits 3 with hello x on stdout', exited.code === 3 && exited.stdout === 'hello x\n', summary(exited));

        const json = await run(['hello', '--json', 'a']);
        let received = null;
        try { received = JSON.parse(json.stdout); } catch {}
        rec.check('kelpi hello --json a prints the argv and caller cwd the plugin received',
            json.code === 0 && JSON.stringify(received?.argv) === '["a"]' && received?.cwd === fs.realpathSync(cwd) && received?.isTTY === false,
            summary(json));

        const loud = await run(['hello', '--loud']);
        rec.check('kelpi hello --loud writes cli-lab: loud to stderr', loud.code === 0 && loud.stderr === 'cli-lab: loud\n' && loud.stdout === 'hello\n', summary(loud));

        const help = await run(['--help']);
        rec.check('kelpi --help lists kelpi hello under CLI Lab',
            /Plugin commands:\n(?:.*\n)*?\s+# CLI Lab\n\s+kelpi hello\s+Print hello and the words you pass\n/.test(help.stderr), help.stderr.slice(-400));

        rec.note('Disable the plugin, then enable it again');
        await cli.ok(['plugin', 'disable', pluginID]);
        const disabled = await run(['hello']);
        const disabledHelp = await run(['--help']);
        await cli.ok(['plugin', 'enable', pluginID]);
        const enabled = await run(['hello', 'again']);
        rec.check('a disabled plugin\'s verb says so, --help marks it, and enabling restores it',
            disabled.code === 1 && disabled.stderr.includes('disabled') && disabled.stdout === '' &&
            /kelpi hello \(disabled\)/.test(disabledHelp.stderr) &&
            enabled.code === 0 && enabled.stdout === 'hello again\n',
            JSON.stringify({ disabled: summary(disabled), enabled: summary(enabled) }));

        const unknown = await unguarded(['nope']);
        rec.check('kelpi nope still fails with Unknown command: nope', unknown.code === 1 && unknown.stderr.startsWith('Unknown command: nope\n') && unknown.stdout === '', summary(unknown));

        const clash = await run(['plugin', 'install', fixture(path.join(sandbox.root, 'cli-clash'), 'example.cli-clash', 'hello'), '--trust']);
        if (clash.code === 0) removals.push('example.cli-clash');
        rec.check('a second plugin declaring hello is refused at install, naming the verb and its owner',
            clash.code !== 0 && /"hello"/.test(clash.stderr) && clash.stderr.includes(pluginID), summary(clash));

        // Validation is offline: a route to nothing proves the daemon is not consulted.
        const builtin = await run(['plugin', 'validate', fixture(path.join(sandbox.root, 'cli-builtin'), 'example.cli-builtin', 'pane')], { env: { KELPI_SOCKET: 'tcp:127.0.0.1:1' } });
        rec.check('a plugin verb named pane fails offline validation as a built-in',
            builtin.code !== 0 && /"pane"/.test(builtin.stderr) && builtin.stderr.includes('built-in'), summary(builtin));

        rec.note('Count the requests built-in verbs and a plugin verb send to a recording stand-in daemon');
        const route = { env: { KELPI_SOCKET: 'tcp:127.0.0.1:' + probe.port } };
        await run(['workspace', 'list', '--json'], route);
        await run(['pane', 'list', '--json'], route);
        const builtins = probe.requests.splice(0);
        const verb = await run(['hello', 'a'], route);
        rec.check('built-in verbs send no plugin request, and a plugin verb sends exactly one',
            builtins.length > 0 && builtins.every(request => request.command !== 'plugin') &&
            probe.requests.length === 1 && probe.requests[0].action === 'cli' && verb.stdout === 'probe\n',
            JSON.stringify({ builtins: builtins.map(request => request.command), verb: probe.requests.map(request => request.command + ':' + request.action) }));
    } finally {
        await probe.close();
        for (const id of removals.reverse()) await cli.run(['plugin', 'remove', id]);
    }
}
