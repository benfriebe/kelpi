import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { BUILTIN_CLI_VERBS } from '@kelpi/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every request sent to the daemon, whichever send shape a command uses. */
const sent = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('./transport.js', async (original) => ({
    ...(await original<object>()),
    sendJSON: (payload: Record<string, unknown>) => {
        sent.push(payload);
        return Promise.resolve();
    },
    sendJSONAndReadReply: (payload: Record<string, unknown>) => {
        sent.push(payload);
        return Promise.resolve(JSON.stringify({ ok: true, panes: [] }));
    }
}));

import { run } from './cli.js';
import { resetIO, setIO } from './io.js';

beforeEach(() => {
    setIO({ out: () => undefined, err: () => undefined });
});
afterEach(() => {
    sent.length = 0;
    resetIO();
});

describe('built-in verbs', () => {
    it('should dispatch exactly the verbs in BUILTIN_CLI_VERBS, version and help being handled before the switch', () => {
        const source = fs.readFileSync(fileURLToPath(new URL('./cli.ts', import.meta.url)), 'utf8');
        const body = source.slice(source.indexOf('switch (subcommand) {'), source.indexOf('default:'));
        const cases = [...body.matchAll(/case '([^']+)':/g)].map((match) => match[1]);
        expect(cases.length).toBeGreaterThan(0);
        expect([...cases].sort()).toEqual(BUILTIN_CLI_VERBS.filter((verb) => verb !== 'version' && verb !== 'help').sort());
    });

    it('should make no plugin round trip for version or plugin help', async () => {
        await expect(run(['version'], {})).rejects.toMatchObject({ code: 0 });
        await run(['plugin', 'help'], {});
        expect(sent).toEqual([]);
    });

    it('should send only the built-in request for a daemon command', async () => {
        await run(['pane', 'list', '--json'], {});
        expect(sent).toEqual([{ command: 'pane-list' }]);
    });
});
