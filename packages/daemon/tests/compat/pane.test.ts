/**
 * `nex pane *` against real PTYs: create / split / list / name / send / send-key / capture /
 * resize / close, plus the target-resolution error matrix.
 *
 * The send → capture round-trips go through a real `/bin/sh` (the harness pins the shell so
 * a user's zsh prompt can't make the assertions flaky): the CLI writes bytes into a node-pty,
 * the shell echoes and runs them, the daemon's headless VT records the screen, and a second
 * CLI invocation reads it back. Nothing is stubbed anywhere along that path.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import fs from 'node:fs';
import path from 'node:path';

import {
    eventually,
    startCompatDaemon,
    swiftCLIAvailable,
    type CompatDaemon,
    type PaneListEntryJSON
} from './harness.js';

const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

interface PaneMutationReply {
    readonly pane_id: string;
    readonly workspace_id: string;
    readonly workspace_name: string;
    readonly label?: string;
}

interface ResizeReply extends PaneMutationReply {
    readonly split_path: string;
    readonly ratio: number;
    readonly target_share: number;
}

describe.skipIf(!swiftCLIAvailable())('compat: nex pane', () => {
    let nex: CompatDaemon;

    beforeEach(async () => {
        nex = await startCompatDaemon();
    }, 60_000);

    afterEach(async () => {
        await nex?.stop();
    });

    const listPanes = (workspace: string): Promise<PaneListEntryJSON[]> =>
        nex.json<PaneListEntryJSON[]>(['pane', 'list', '--workspace', workspace, '--json']);

    /** A workspace with one extra, labelled pane. Returns that pane's id. */
    async function seedPane(workspace: string, label: string): Promise<string> {
        await nex.json(['workspace', 'create', '--name', workspace, '--json']);
        const reply = await nex.json<PaneMutationReply>([
            'pane', 'create', '--workspace', workspace, '--name', label, '--json'
        ]);
        return reply.pane_id;
    }

    /** Poll a pane's captured screen until it contains `needle`. */
    async function captureUntil(paneID: string, needle: string): Promise<string> {
        const result = await eventually(
            () => nex.run(['pane', 'capture', '--target', paneID, '--scrollback']),
            (r) => r.code === 0 && r.stdout.includes(needle)
        );
        expect(result.code).toBe(0);
        return result.stdout;
    }

    it('creates a pane in another workspace with a label and a working directory', async () => {
        const dir = path.join(nex.home, 'projects', 'demo');
        fs.mkdirSync(dir, { recursive: true });
        await nex.json(['workspace', 'create', '--name', 'alpha', '--json']);

        const reply = await nex.json<PaneMutationReply>([
            'pane', 'create', '--workspace', 'alpha', '--name', 'worker-1', '--path', dir, '--json'
        ]);
        // The pane-mutation printer strips `ok` and prints the REAL new pane id.
        expect(reply).not.toHaveProperty('ok');
        expect(reply.pane_id).toMatch(UUID);
        expect(reply.workspace_name).toBe('alpha');
        expect(reply.label).toBe('worker-1');

        const panes = await listPanes('alpha');
        const created = panes.find((pane) => pane.id === reply.pane_id);
        expect(created).toBeDefined();
        expect(created?.type).toBe('shell');
        expect(created?.label).toBe('worker-1');
        expect(created?.working_directory).toBe(dir);
        expect(created?.workspace_id).toBe(reply.workspace_id);
        // A real PTY is behind it.
        expect(nex.daemon.pty.has(reply.pane_id)).toBe(true);
    }, 60_000);

    it('lists panes with full UUIDs, types, timestamps and an ABSENT agent_session_id', async () => {
        const paneID = await seedPane('alpha', 'worker-1');
        const panes = await listPanes('alpha');
        expect(panes).toHaveLength(2); // the workspace's first pane + ours

        const worker = panes.find((pane) => pane.id === paneID)!;
        expect(worker.id).toMatch(UUID); // full uuid, copy-pasteable into --target (issue #240)
        expect(worker.type).toBe('shell');
        expect(worker.status).toBe('idle');
        expect(worker.created_at).toMatch(ISO_SECONDS);
        expect(worker.workspace_name).toBe('alpha');
        // No agent has ever run here: the key is OMITTED, not null (the CLI renders `-`).
        expect('agent_session_id' in worker).toBe(false);
        expect('agent' in worker).toBe(false);
        expect('background_tasks' in worker).toBe(false);
        // The unlabelled first pane omits `label` entirely rather than sending "".
        const first = panes.find((pane) => pane.id !== paneID)!;
        expect('label' in first).toBe(false);

        // Once a session binds, the key appears with the full id.
        await nex.run(['event', 'start'], {
            paneID,
            stdin: JSON.stringify({ session_id: 'e1f2a3b4-c5d6-7890-abcd-ef1234567890' })
        });
        const bound = (await listPanes('alpha')).find((pane) => pane.id === paneID);
        expect(bound?.agent_session_id).toBe('e1f2a3b4-c5d6-7890-abcd-ef1234567890');

        // `--current` scopes to the caller's own workspace.
        const current = await nex.json<PaneListEntryJSON[]>(['pane', 'list', '--current', '--json'], { paneID });
        expect(current.map((pane) => pane.workspace_name)).toEqual(['alpha', 'alpha']);
    }, 60_000);

    it('round-trips `pane send` → shell → `pane capture`', async () => {
        const paneID = await seedPane('alpha', 'worker-1');

        const sent = await nex.json<PaneMutationReply & { bare: boolean }>([
            'pane', 'send', '--target', paneID, '--json', 'echo', 'compat-hello'
        ]);
        expect(sent.pane_id).toBe(paneID);
        expect(sent.bare).toBe(false);
        expect(sent.label).toBe('worker-1');

        const screen = await captureUntil(paneID, 'compat-hello');
        // Both the echoed command line AND the shell's output — proof the bytes went through
        // the PTY and the daemon's VT saw the result.
        expect(screen).toContain('echo compat-hello');
        expect(screen).toMatch(/^compat-hello$/m);

        // Viewport-only capture (no --scrollback) still works and is a suffix of the screen.
        const viewport = await nex.run(['pane', 'capture', '--target', paneID]);
        expect(viewport.code).toBe(0);
        expect(viewport.stdout).toContain('compat-hello');

        // `--lines N` tails the capture.
        const tail = await nex.run(['pane', 'capture', '--target', paneID, '--lines', '1']);
        expect(tail.code).toBe(0);
        expect(tail.stdout.split('\n').filter((line) => line.length > 0)).toHaveLength(1);
    }, 60_000);

    it('composes `pane send --bare` with `pane send-key enter`', async () => {
        const paneID = await seedPane('alpha', 'worker-1');

        const bare = await nex.json<{ bare: boolean }>([
            'pane', 'send', '--bare', '--target', paneID, '--json', 'echo bare-mode'
        ]);
        expect(bare.bare).toBe(true);

        // Nothing ran yet — `--bare` deliberately omits the Enter.
        const beforeEnter = await nex.run(['pane', 'capture', '--target', paneID, '--scrollback']);
        expect(beforeEnter.stdout).not.toMatch(/^bare-mode$/m);

        const key = await nex.run(['pane', 'send-key', '--target', paneID, 'enter']);
        expect(key.code).toBe(0);
        expect(key.stdout).toContain(`sent enter to ${paneID}`);

        expect(await captureUntil(paneID, 'bare-mode')).toMatch(/^bare-mode$/m);
    }, 60_000);

    it('delivers ctrl-c as a real SIGINT-raising byte', async () => {
        const paneID = await seedPane('alpha', 'worker-1');
        await captureUntil(paneID, '$'); // wait for the first prompt

        // Type a command that must NEVER run, then interrupt the line.
        await nex.json(['pane', 'send', '--bare', '--target', paneID, '--json', 'nex-compat-should-not-run']);
        expect((await nex.run(['pane', 'send-key', '--target', paneID, 'ctrl-c'])).code).toBe(0);
        await nex.json(['pane', 'send', '--target', paneID, '--json', 'echo', 'after-interrupt']);

        const screen = await captureUntil(paneID, 'after-interrupt');
        // The interrupted line was discarded by the line discipline: the shell never tried it.
        expect(screen).not.toContain('nex-compat-should-not-run: ');
        expect(screen).not.toMatch(/not found/);
    }, 60_000);

    it('renames, splits and resizes panes', async () => {
        const paneID = await seedPane('alpha', 'worker-1');

        const renamed = await nex.json<PaneMutationReply>([
            'pane', 'name', '--target', paneID, '--json', 'coordinator'
        ]);
        expect(renamed).toMatchObject({ pane_id: paneID, label: 'coordinator' });

        const split = await nex.json<PaneMutationReply>([
            'pane', 'split', '--target', paneID, '--direction', 'vertical', '--name', 'worker-2', '--json'
        ]);
        expect(split.pane_id).toMatch(UUID);
        expect(split.pane_id).not.toBe(paneID);
        expect(split.label).toBe('worker-2');
        expect((await listPanes('alpha')).map((pane) => pane.id)).toContain(split.pane_id);

        const resized = await nex.json<ResizeReply>([
            'pane', 'resize', '--target', paneID, '--ratio', '0.7', '--json'
        ]);
        expect(resized.pane_id).toBe(paneID);
        expect(resized.target_share).toBeCloseTo(0.7, 6);
        expect(resized.split_path).toMatch(/^d[LR]*$/);

        // --grow nudges by the default 0.05 step from the current share.
        const grown = await nex.json<ResizeReply>(['pane', 'resize', '--target', paneID, '--grow', '--json']);
        expect(grown.target_share).toBeCloseTo(0.75, 6);

        // Share clamps to [0.1, 0.9] server-side.
        const clamped = await nex.json<ResizeReply>(['pane', 'resize', '--target', paneID, '--ratio', '0.99', '--json']);
        expect(clamped.target_share).toBeCloseTo(0.9, 6);
    }, 60_000);

    it('docks one pane against another with the adjacent `pane move` form', async () => {
        const paneID = await seedPane('alpha', 'worker-1');
        const split = await nex.json<PaneMutationReply>([
            'pane', 'split', '--target', paneID, '--name', 'worker-2', '--json'
        ]);

        const moved = await nex.json<PaneMutationReply & { anchor_id: string; zone: string }>([
            'pane', 'move', '--target', split.pane_id, '--below', paneID, '--json'
        ]);
        expect(moved).toMatchObject({
            pane_id: split.pane_id,
            anchor_id: paneID,
            zone: 'below',
            workspace_name: 'alpha',
            label: 'worker-2'
        });

        // The anchor must live in the moved pane's workspace — a cross-workspace or missing
        // anchor is one error, not a guess.
        const stray = await nex.run(['pane', 'move', '--target', split.pane_id, '--below', 'nowhere', '--json']);
        expect(stray.code).toBe(1);
        expect(stray.stderr).toContain("no pane matching 'nowhere' in workspace 'alpha'");
    }, 60_000);

    it('refuses to resize the only pane in a workspace', async () => {
        await nex.json(['workspace', 'create', '--name', 'solo', '--json']);
        const [only] = await listPanes('solo');
        expect(only).toBeDefined();

        const result = await nex.run(['pane', 'resize', '--target', only!.id, '--ratio', '0.5', '--json']);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('has no sibling to resize against');
    }, 60_000);

    it('closes a pane by target from outside any pane', async () => {
        const paneID = await seedPane('alpha', 'worker-1');

        const closed = await nex.run(['pane', 'close', '--target', paneID]);
        expect(closed.code).toBe(0);
        expect(closed.stdout).toContain(`pane deleted: ${paneID}`);
        expect((await listPanes('alpha')).map((pane) => pane.id)).not.toContain(paneID);
        // The PTY is gone with it.
        expect(nex.daemon.pty.has(paneID)).toBe(false);

        // A label target needs a workspace scope; with one it resolves.
        await nex.json(['pane', 'create', '--workspace', 'alpha', '--name', 'worker-2', '--json']);
        const byLabel = await nex.run(['pane', 'close', '--target', 'worker-2', '--workspace', 'alpha']);
        expect(byLabel.code).toBe(0);
        expect(byLabel.stdout).toContain('(worker-2)');
    }, 60_000);

    it('refuses to capture a non-terminal pane', async () => {
        const file = path.join(nex.home, 'notes.md');
        fs.writeFileSync(file, '# hello\n');
        // `nex md` is fire-and-forget: it opens the pane in the active workspace.
        expect((await nex.run(['md', file])).code).toBe(0);

        const markdown = await eventually(
            () => nex.json<PaneListEntryJSON[]>(['pane', 'list', '--json']),
            (panes) => panes.some((pane) => pane.type === 'markdown')
        );
        const pane = markdown.find((entry) => entry.type === 'markdown');
        expect(pane?.file_path).toBe(file);

        const result = await nex.run(['pane', 'capture', '--target', pane?.id ?? '']);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('pane is not a terminal (type: markdown)');
    }, 60_000);

    it.each([
        [
            'unknown label in a scoped workspace',
            ['pane', 'send', '--target', 'nope', '--workspace', 'alpha', 'hi'],
            "no pane with label 'nope' in workspace 'alpha'"
        ],
        [
            'unknown uuid',
            ['pane', 'capture', '--target', '11111111-1111-1111-1111-111111111111'],
            "no pane with UUID '11111111-1111-1111-1111-111111111111'"
        ],
        [
            'bare label with no scope at all',
            ['pane', 'send', '--target', 'worker-1', 'hi'],
            "label 'worker-1' requires --workspace <name-or-id> when called from outside a Nex pane"
        ],
        [
            'unknown workspace',
            ['pane', 'list', '--workspace', 'ghost', '--json'],
            'workspace not found: ghost'
        ],
        [
            'unknown key name',
            ['pane', 'send-key', '--target', 'worker-1', '--workspace', 'alpha', 'frobnicate'],
            "unknown key 'frobnicate' (valid: enter, return, tab, escape, esc, space, backspace, up, down, left, right, ctrl-c)"
        ]
    ])('rejects %s with exit 1 and a one-line reason', async (_label, args, expected) => {
        await seedPane('alpha', 'worker-1');
        const result = await nex.run(args);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain(expected);
    }, 60_000);

    it('rejects an ambiguous label rather than guessing', async () => {
        await seedPane('alpha', 'twin');
        await nex.json(['pane', 'create', '--workspace', 'alpha', '--name', 'twin', '--json']);

        const result = await nex.run(['pane', 'send', '--target', 'twin', '--workspace', 'alpha', 'hi']);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("label 'twin' is ambiguous (2 matches); pass --workspace <name-or-id> to disambiguate");
    }, 60_000);
});
