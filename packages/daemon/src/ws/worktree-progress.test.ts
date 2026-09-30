/**
 * #294 through the real `SyncHub`: a worktree create's `command-progress` frames go to the
 * connection that asked and nobody else, `workspace-create-cancel` reaches only that connection's
 * own create, and `repo-prefetch` is owner-only and registry-only.
 */

import { WS_COMMAND_PROGRESS_MESSAGE, WS_PROTOCOL_VERSION, type WireMessage } from '@kelpi/protocol';
import { describe, expect, it } from 'vitest';

import { stubGitService } from '../git/testing.js';
import { DEVICE_TOKEN_PREFIX } from '../lifecycle/devices.js';
import type { ControlDispatcher, ReplyHandle } from '../seams.js';
import { harness as storeHarness, seededState, W1 } from '../store/testing.js';
import type { RepoChannel } from './repos.js';
import { createSyncHub, WORKSPACE_CREATE_CANCEL_COMMAND, type SyncSession } from './sync.js';
import { PANE_A, recordingTransport, type RecordedTransport } from './testing.js';

const DAEMON = { version: '0.1.0', build: '42', pid: 4242 };
const DEVICE_TOKEN = `${DEVICE_TOKEN_PREFIX}paired-phone`;
const REPO_ID = 'ABCDEF01-0000-4000-8000-000000000001';

interface Peer {
    readonly session: SyncSession;
    readonly transport: RecordedTransport;
}

interface Held {
    readonly message: WireMessage;
    readonly reply: ReplyHandle;
}

function fixture() {
    const store = storeHarness(seededState(W1, PANE_A));
    store.store.dispatch({
        type: 'add-repo',
        repo: { id: REPO_ID, path: '/code/app', name: 'app', remoteURL: null, lastAccessedAt: 0, isAutoDiscovered: false }
    });
    /** Replies are held, so a test decides when (and whether) a create finishes. */
    const held: Held[] = [];
    const dispatcher: ControlDispatcher = (message, reply) => {
        if (reply !== null) held.push({ message, reply });
    };
    const prefetches: string[] = [];
    const repos: RepoChannel = {
        store: store.store,
        git: stubGitService(),
        worktreeBasePath: '~/kelpi/worktrees/<repo>',
        uuid: () => 'X',
        now: () => 0,
        prefetch: {
            prefetch: (repoPath) => {
                prefetches.push(repoPath);
                return prefetches.length === 1 ? 'started' : 'in-flight';
            }
        }
    };
    const hub = createSyncHub({ store: store.store, dispatcher, daemon: DAEMON, validateToken: () => true, repos });
    const connect = (token = 'owner-token'): Peer => {
        const transport = recordingTransport();
        const session = hub.createSession(transport);
        session.handleMessage(
            JSON.stringify({ type: 'hello', protocolVersion: WS_PROTOCOL_VERSION, token, client: { kind: 'browser', name: 'kelpi-web' } })
        );
        return { session, transport };
    };
    return { held, prefetches, connect };
}

let counter = 0;
function command(peer: Peer, payload: Record<string, unknown>): string {
    counter += 1;
    const id = `c${String(counter)}`;
    peer.session.handleMessage(JSON.stringify({ type: 'command', id, payload }));
    return id;
}

const replyTo = (peer: Peer, id: string): Record<string, unknown> | undefined =>
    peer.transport.ofType('command-reply').find((message) => message['id'] === id)?.['reply'] as Record<string, unknown> | undefined;

async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

const CREATE = { command: 'workspace-create', name: 'x', worktree: 'x', repo: '/code/app', update_main: true };

describe('command-progress', () => {
    it('reaches only the connection that sent the command, keyed by its command id, and stops at the reply', () => {
        const f = fixture();
        const asker = f.connect();
        const bystander = f.connect();
        const id = command(asker, { ...CREATE, request_id: 'req-1' });
        const create = f.held[0];
        expect(create?.message.command).toBe('workspace-create');
        // The WS id rode in a field the wire decoder drops: the handler never saw it.
        expect(create?.message).not.toHaveProperty('request_id');

        create?.reply.progress?.({ kind: 'worktree-create', steps: [{ id: 'fetch', status: 'running', percent: 45 }] });
        expect(asker.transport.ofType(WS_COMMAND_PROGRESS_MESSAGE)).toEqual([
            { type: WS_COMMAND_PROGRESS_MESSAGE, id, progress: { kind: 'worktree-create', steps: [{ id: 'fetch', status: 'running', percent: 45 }] } }
        ]);
        expect(bystander.transport.ofType(WS_COMMAND_PROGRESS_MESSAGE)).toEqual([]);

        create?.reply.send({ ok: true, workspace_id: 'W' });
        create?.reply.close();
        create?.reply.progress?.({ kind: 'worktree-create', steps: [] });
        expect(asker.transport.ofType(WS_COMMAND_PROGRESS_MESSAGE)).toHaveLength(1);
        // Progress first, then the one reply.
        const types = asker.transport.json.map((message) => message['type']).filter((type) => type === WS_COMMAND_PROGRESS_MESSAGE || type === 'command-reply');
        expect(types).toEqual([WS_COMMAND_PROGRESS_MESSAGE, 'command-reply']);
        expect(replyTo(asker, id)).toEqual({ ok: true, workspace_id: 'W' });
    });

    it('is offered even without a request id (the create just cannot be cancelled)', () => {
        const f = fixture();
        const asker = f.connect();
        command(asker, CREATE);
        expect(typeof f.held[0]?.reply.progress).toBe('function');
        expect(f.held[0]?.reply.signal?.aborted).toBe(false);
    });
});

describe('workspace-create-cancel', () => {
    it("aborts the asking connection's own create, and says so", () => {
        const f = fixture();
        const asker = f.connect();
        command(asker, { ...CREATE, request_id: 'req-1' });
        const signal = f.held[0]?.reply.signal;
        const cancel = command(asker, { command: WORKSPACE_CREATE_CANCEL_COMMAND, request_id: 'req-1' });
        expect(signal?.aborted).toBe(true);
        expect(replyTo(asker, cancel)).toEqual({ ok: true, cancelled: true });
        // A second cancel of the same create changes nothing.
        const again = command(asker, { command: WORKSPACE_CREATE_CANCEL_COMMAND, request_id: 'req-1' });
        expect(replyTo(asker, again)).toEqual({ ok: true, cancelled: false });
    });

    it("can never reach another connection's create, even with its request id", () => {
        const f = fixture();
        const asker = f.connect();
        const stranger = f.connect();
        command(asker, { ...CREATE, request_id: 'req-1' });
        const cancel = command(stranger, { command: WORKSPACE_CREATE_CANCEL_COMMAND, request_id: 'req-1' });
        expect(replyTo(stranger, cancel)).toEqual({ ok: true, cancelled: false });
        expect(f.held[0]?.reply.signal?.aborted).toBe(false);
    });

    it('answers cancelled:false once the create has replied, and frees its id', () => {
        const f = fixture();
        const asker = f.connect();
        command(asker, { ...CREATE, request_id: 'req-1' });
        f.held[0]?.reply.send({ ok: true });
        f.held[0]?.reply.close();
        const cancel = command(asker, { command: WORKSPACE_CREATE_CANCEL_COMMAND, request_id: 'req-1' });
        expect(replyTo(asker, cancel)).toEqual({ ok: true, cancelled: false });
        expect(f.held[0]?.reply.signal?.aborted).toBe(false);
        // The id is free for the next create.
        const next = command(asker, { ...CREATE, request_id: 'req-1' });
        expect(replyTo(asker, next)).toBeUndefined();
        expect(f.held).toHaveLength(2);
    });

    it('refuses a missing request id, and a create whose id is malformed or already running', () => {
        const f = fixture();
        const asker = f.connect();
        const bare = command(asker, { command: WORKSPACE_CREATE_CANCEL_COMMAND });
        expect(replyTo(asker, bare)).toEqual({ ok: false, error: 'workspace-create-cancel requires request_id' });
        const long = command(asker, { ...CREATE, request_id: 'x'.repeat(129) });
        expect(replyTo(asker, long)).toEqual({ ok: false, error: 'request_id must be a short non-empty string' });
        const wrongType = command(asker, { ...CREATE, request_id: 7 });
        expect(replyTo(asker, wrongType)).toEqual({ ok: false, error: 'request_id must be a short non-empty string' });
        command(asker, { ...CREATE, request_id: 'req-1' });
        const duplicate = command(asker, { ...CREATE, request_id: 'req-1' });
        expect(replyTo(asker, duplicate)).toEqual({ ok: false, error: 'request id req-1 is already in use' });
        // Only the first create reached the handlers.
        expect(f.held).toHaveLength(1);
    });

    it('answers cancelled:false for a create the handler made uncancellable (a plugin git provider)', () => {
        const f = fixture();
        const asker = f.connect();
        command(asker, { ...CREATE, request_id: 'req-1' });
        f.held[0]?.reply.uncancellable?.();
        const cancel = command(asker, { command: WORKSPACE_CREATE_CANCEL_COMMAND, request_id: 'req-1' });
        expect(replyTo(asker, cancel)).toEqual({ ok: true, cancelled: false });
        expect(f.held[0]?.reply.signal?.aborted).toBe(false);
    });

    it('a connection that drops does not cancel its create (it finishes, as it always did)', () => {
        const f = fixture();
        const asker = f.connect();
        command(asker, { ...CREATE, request_id: 'req-1' });
        asker.session.close();
        expect(f.held[0]?.reply.signal?.aborted).toBe(false);
    });
});

describe('repo-prefetch', () => {
    it('starts a prefetch of a registered repo, by id in either case, for the owner', async () => {
        const f = fixture();
        const owner = f.connect();
        const first = command(owner, { command: 'repo-prefetch', repo_id: REPO_ID.toLowerCase() });
        await settle();
        expect(replyTo(owner, first)).toEqual({ ok: true, repo_id: REPO_ID, status: 'started' });
        expect(f.prefetches).toEqual(['/code/app']);
        const second = command(owner, { command: 'repo-prefetch', repo_id: REPO_ID });
        await settle();
        expect(replyTo(owner, second)).toEqual({ ok: true, repo_id: REPO_ID, status: 'in-flight' });
    });

    it('is refused to a paired device, and never reaches the fetch', async () => {
        const f = fixture();
        const phone = f.connect(DEVICE_TOKEN);
        const id = command(phone, { command: 'repo-prefetch', repo_id: REPO_ID });
        await settle();
        expect(replyTo(phone, id)).toEqual({ ok: false, error: 'repo-prefetch is owner-only' });
        expect(f.prefetches).toEqual([]);
    });

    it('takes a registered repo id only: never a path, never an unknown id', async () => {
        const f = fixture();
        const owner = f.connect();
        const missing = command(owner, { command: 'repo-prefetch' });
        const byPath = command(owner, { command: 'repo-prefetch', repo_id: '/code/app' });
        const unknown = command(owner, { command: 'repo-prefetch', repo_id: 'ABCDEF01-0000-4000-8000-000000000099' });
        await settle();
        expect(replyTo(owner, missing)).toEqual({ ok: false, error: 'repo-prefetch requires repo_id' });
        expect(replyTo(owner, byPath)).toEqual({ ok: false, error: "no repo matches '/code/app'" });
        expect(replyTo(owner, unknown)).toEqual({ ok: false, error: "no repo matches 'ABCDEF01-0000-4000-8000-000000000099'" });
        expect(f.prefetches).toEqual([]);
    });
});
