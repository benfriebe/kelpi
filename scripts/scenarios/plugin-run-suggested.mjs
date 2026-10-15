/** Run Suggested (#384): a Stop hook's reply text reaches the example plugin, and `kelpi run-suggested` prints it or runs it in a new split. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const covers = ['examples/plugins/run-suggested/', 'packages/plugin-sdk/tests/run-suggested.test.ts', 'packages/plugin-sdk/tests/run-suggested-backend.test.ts'];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const example = path.join(repoRoot, 'examples/plugins/run-suggested');
const pluginID = 'example.run-suggested';
const sessionID = 'scenario-session';

export default async function ({ cli, rec, d }) {
    const json = async args => JSON.parse(await cli.ok(args));
    const summary = result => JSON.stringify({ code: result.code, stdout: result.stdout, stderr: result.stderr.slice(0, 600) });
    const parse = text => { try { return JSON.parse(text); } catch { return null; } };
    const panes = () => json(['pane', 'list', '--workspace', 'Default', '--json']);
    /** The verb's last answer, polled until `done` holds: the Stop reaches the backend after the CLI returns. */
    const settled = async (args, done) => {
        let result = null;
        await d.settle(async () => done(result = await cli.run(['run-suggested', ...args])), { ceilingMs: 6_000, intervalMs: 150 });
        return result;
    };
    const opened = [];
    const close = async id => { opened.splice(opened.indexOf(id), 1); await cli.run(['pane', 'close', '--target', id]); };
    let installed = false;
    try {
        rec.note('Install the Run Suggested example; it is a startup backend');
        await cli.ok(['plugin', 'install', example, '--trust']);
        installed = true;
        const running = await d.settle(async () => (await json(['plugin', 'list', '--json'])).some(plugin => plugin.manifest.id === pluginID && plugin.status === 'running'), { ceilingMs: 10_000 });
        rec.check('plugin list shows example.run-suggested running', running, JSON.stringify((await json(['plugin', 'list', '--json'])).filter(plugin => plugin.manifest.id === pluginID).map(plugin => ({ status: plugin.status, enabled: plugin.enabled }))));

        const created = await json(['pane', 'create', '--workspace', 'Default', '--json']);
        const paneID = created.pane_id;
        rec.check('created a shell pane to play the Claude session in', typeof paneID === 'string' && paneID.length > 0, JSON.stringify(created));
        opened.push(paneID);
        const target = ['--target', paneID];
        const stop = async message => {
            const stopped = await cli.run(['event', 'stop'], { paneID, stdin: JSON.stringify({ session_id: sessionID, hook_event_name: 'Stop', last_assistant_message: message }) });
            if (stopped.code !== 0) throw new Error(`kelpi event stop exited ${String(stopped.code)}: ${stopped.stderr}`);
        };
        const started = await cli.run(['event', 'session-start'], { paneID, stdin: JSON.stringify({ session_id: sessionID, hook_event_name: 'SessionStart' }) });
        rec.check('event session-start binds the fake session to the pane', started.code === 0, summary(started));

        rec.note('A Stop whose reply ends with a `! command` line');
        await stop('Run this:\n\n! echo run-suggested-scenario-ok\n');
        const printed = await settled(['--print', ...target], result => result.code === 0);
        rec.check('run-suggested --print prints the suggested command and exits 0',
            printed.code === 0 && printed.stdout === 'echo run-suggested-scenario-ok\n' && printed.stderr === '', summary(printed));
        const printedJSON = await cli.run(['run-suggested', '--json', '--print', ...target]);
        const shown = parse(printedJSON.stdout);
        rec.check('run-suggested --json --print gives the command and kind bang',
            printedJSON.code === 0 && shown?.command === 'echo run-suggested-scenario-ok' && shown?.kind === 'bang', summary(printedJSON));
        const bare = await cli.run(['run-suggested', ...target]);
        rec.check('run-suggested with no flags shows the command on stdout and the --yes hint on stderr, running nothing',
            bare.code === 0 && bare.stdout === 'echo run-suggested-scenario-ok\n' && bare.stderr.includes('--yes'), summary(bare));

        rec.note('A Stop whose only `!` sits inside a sentence replaces the suggestion with nothing');
        await stop('Run ! echo nope inside a sentence.');
        const nothing = await settled(['--print', ...target], result => result.code !== 0);
        rec.check('run-suggested --print exits 1 saying Claude has not suggested a command',
            nothing.code === 1 && nothing.stdout === '' && nothing.stderr.includes('has not suggested'), summary(nothing));

        /** Runs the suggestion with --yes and returns the split it ran in, once its capture holds every line in `want`. */
        const runInSplit = async want => {
            const before = await panes();
            const ran = await cli.run(['run-suggested', '--yes', '--json', ...target]);
            const result = parse(ran.stdout);
            if (typeof result?.paneID === 'string' && result.paneID !== paneID) opened.push(result.paneID);
            const after = await panes();
            let capture = '';
            const shown = typeof result?.paneID === 'string' && await d.settle(async () => {
                capture = (await cli.run(['pane', 'capture', '--target', result.paneID])).stdout;
                const lines = capture.split('\n').map(line => line.trim());
                return want.every(text => lines.includes(text));
            }, { ceilingMs: 10_000, intervalMs: 250 });
            return { ran, result, added: after.length - before.length, isNew: after.some(pane => pane.id === result?.paneID) && !before.some(pane => pane.id === result?.paneID), shown, capture };
        };

        rec.note('The same suggestion again, run with --yes: a plain shell is no empty Claude box, so it runs in a split');
        await stop('Run this:\n\n! echo run-suggested-scenario-ok\n');
        await settled(['--print', ...target], result => result.code === 0);
        const status = (await panes()).find(pane => pane.id === paneID);
        rec.note(`the agent pane before --yes: ${JSON.stringify({ status: status?.status, agent: status?.agent })}`);
        const bang = await runInSplit(['run-suggested-scenario-ok']);
        // The session facts all pass (a Claude session, waiting after its Stop), so only the screen check sends it to a split.
        rec.check("run-suggested --yes --json runs the bang in a new split because Claude's input box is not on screen",
            bang.ran.code === 0 && bang.result?.ran === 'split' && bang.result?.command === 'echo run-suggested-scenario-ok' &&
            bang.result?.reason === "Claude's input box is not empty" && bang.result.paneID !== paneID,
            summary(bang.ran));
        rec.check('the split is one new pane in the workspace', bang.added === 1 && bang.isNew, JSON.stringify({ added: bang.added, isNew: bang.isNew }));
        rec.check('the split shows run-suggested-scenario-ok as command output', bang.shown, bang.capture.slice(-600));
        if (opened.includes(bang.result?.paneID)) await close(bang.result.paneID);

        rec.note('A bash code block of two lines');
        await stop('Run these:\n\n```bash\necho first-line\necho second-line\n```\n');
        const fence = await settled(['--print', ...target], result => result.code === 0 && result.stdout.includes('first-line'));
        rec.check('run-suggested --print prints both lines of the code block',
            fence.code === 0 && fence.stdout === 'echo first-line\necho second-line\n', summary(fence));
        const block = await runInSplit(['first-line', 'second-line']);
        rec.check('run-suggested --yes runs the code block in a new split, because a code block always does',
            block.ran.code === 0 && block.result?.ran === 'split' && block.result?.reason === 'a code block runs in a new split' && block.added === 1 && block.isNew,
            JSON.stringify({ ran: summary(block.ran), added: block.added, isNew: block.isNew }));
        rec.check('the split shows first-line and second-line as command output', block.shown, block.capture.slice(-600));
    } finally {
        for (const id of [...opened].reverse()) await close(id);
        if (installed) await cli.run(['plugin', 'remove', pluginID]);
    }
}
