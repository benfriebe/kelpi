const usage = [
    'Usage: kelpi hello [--exit <n>] [--loud] [--json] [words...]',
    '',
    'Prints hello and the words you pass.',
    '  --exit <n>  exit with status n',
    '  --loud      also write a line to standard error',
    '  --json      print what the plugin received as JSON',
].join('\n');

/** @param {import('../../../packages/plugin-sdk/index.js').BackendAPI} api */
export function activate(api) {
    const hello = ({ argv, cwd, isTTY, json }, context) => {
        if (argv.includes('--help')) return { text: usage };
        const rest = [];
        let exitCode, loud = false;
        for (let index = 0; index < argv.length; index++) {
            if (argv[index] === '--loud') loud = true;
            else if (argv[index] !== '--exit') rest.push(argv[index]);
            else {
                exitCode = Number(argv[++index]);
                if (!Number.isInteger(exitCode)) return { stderr: 'cli-lab: --exit needs a whole number\n\n' + usage, exitCode: 2 };
            }
        }
        return {
            text: rest.length ? 'hello ' + rest.join(' ') : 'hello',
            // The pane and workspace are the caller's when it runs inside a Kelpi pane.
            ...(json ? { json: { argv: rest, cwd, isTTY, paneID: context.paneID ?? null, workspaceID: context.workspaceID ?? null } } : {}),
            ...(exitCode === undefined ? {} : { exitCode }),
            ...(loud ? { stderr: 'cli-lab: loud' } : {}),
        };
    };
    return api.commands.register('example.cli-lab.hello', hello);
}
