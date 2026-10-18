/**
 * `workspace-create` with `ticket` (wire-protocol.md §6.3, socket-handlers.md §6.2 "Starting from a
 * ticket", graft-git.md §8.5.3/§8.5.4) against a FAKE `TicketService` that answers crafted
 * `ResolvedTicket`s, and real repositories (`git/pr-testing.ts`): no network, no GitHub.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
    NO_LOCAL_BRANCHES,
    renderTicketPrompt,
    ticketCreateDefaults,
    ticketPromptVars,
    type GitHubTicketRef,
    type LocalBranchLookup
} from '@kelpi/core/tickets';
import { decodeWireObject, type TicketSummary, type WireMessage } from '@kelpi/protocol';

import type { AgentLaunchStart, AgentLauncher } from '../../agent-launch/index.js';
import {
    createGitRunner,
    createGitService,
    performWorktreeAdd,
    worktreeGitOps,
    type GitService
} from '../../git/index.js';
import { commit, forkPullRequest, git, HAS_GIT, mapGitHubURL, pullRequestFixture, removeTmpDirs, sameRepoPullRequest, tryGit, type PullRequestFixture } from '../../git/pr-testing.js';
import { readBranchFacts, readRemoteFacts } from '../../git/repo-facts.js';
import { localBranchLookup } from '../../integrations/matching.js';
import { stubGitService } from '../../git/testing.js';
import type { ReplyHandle } from '../../seams.js';
import { TicketServiceError, type ResolvedTicket, type TicketService, type WorktreeCreator } from './context.js';
import { harness, NOW, type Harness, type HarnessOptions } from './testing.js';
import { PR_NEEDS_BUNDLED_GIT_ERROR, PR_UPDATE_MAIN_ERROR, TICKET_NOT_CONNECTED_ERROR } from './workspaces.js';

afterAll(removeTmpDirs);

const REPO_ID = '0000000A-0000-4000-8000-000000000001';
const TITLE = 'Retry login on 401';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeTickets extends TicketService {
    readonly calls: GitHubTicketRef[];
}

function fakeTickets(answer: (ref: GitHubTicketRef, signal: AbortSignal) => ResolvedTicket | Promise<ResolvedTicket>, connected = true): FakeTickets {
    const calls: GitHubTicketRef[] = [];
    return {
        calls,
        connected: () => connected,
        resolve: async (ref, signal) => {
            calls.push(ref);
            return answer(ref, signal);
        }
    };
}

interface RecordingLauncher extends AgentLauncher {
    readonly written: string[];
    readonly discarded: string[];
    readonly starts: (AgentLaunchStart & { readonly ticketFileExisted: boolean })[];
}

function recordingLauncher(ticketFile: () => string | null = () => null, options: { failWrite?: number } = {}): RecordingLauncher {
    const written: string[] = [];
    const discarded: string[] = [];
    const starts: (AgentLaunchStart & { readonly ticketFileExisted: boolean })[] = [];
    return {
        written,
        discarded,
        starts,
        preparePromptFile(prompt) {
            if (options.failWrite === written.length + 1) throw new Error('disk full');
            written.push(prompt);
            return `/data/prompts/${String(written.length).padStart(8, '0')}-0000-4000-8000-000000000000.txt`;
        },
        discardPromptFile(file) {
            discarded.push(file);
        },
        start(launch) {
            const file = ticketFile();
            starts.push({ ...launch, ticketFileExisted: file !== null && fs.existsSync(file) });
        },
        modesChanged() {},
        shellReported() {},
        inputWritten() {},
        abandonAll() {},
        pending: 0
    };
}

const promptFile = (n: number): string => `/data/prompts/${String(n).padStart(8, '0')}-0000-4000-8000-000000000000.txt`;

function summary(kind: 'issue' | 'pr', number: number, repoID: string | null): TicketSummary {
    return {
        provider: 'github',
        kind,
        repo: 'acme/api',
        number,
        key: `#${number}`,
        title: TITLE,
        url: `https://github.com/acme/api/${kind === 'pr' ? 'pull' : 'issues'}/${number}`,
        state: 'open',
        author: 'octocat',
        labels: ['bug'],
        updated_at: '2026-10-07T00:00:00Z',
        repo_id: repoID
    };
}

function issueTicket(options: { repoID?: string | null; number?: number; localBranch?: LocalBranchLookup } = {}): ResolvedTicket {
    const repoID = options.repoID === undefined ? REPO_ID : options.repoID;
    const number = options.number ?? 418;
    const row = summary('issue', number, repoID);
    const defaults = ticketCreateDefaults({ ...row, repoID, pullRequest: null, localBranch: options.localBranch ?? NO_LOCAL_BRANCHES });
    return {
        summary: row,
        pullRequest: null,
        repoID,
        baseRemote: repoID === null ? null : 'origin',
        defaults,
        existing: [],
        checkedOutAt: defaults.checkedOutAt,
        warnings: defaults.warnings,
        file: { provider: 'github', kind: 'issue', key: row.key, title: TITLE, url: row.url, repo: row.repo, state: 'open', author: 'octocat', labels: ['bug'], body: 'Login fails after 401.', comments: [] },
        resolvedAt: NOW
    };
}

function prTicket(headSha: string, options: { number?: number; headRef?: string; localBranch?: LocalBranchLookup; fork?: boolean } = {}): ResolvedTicket {
    const number = options.number ?? 7;
    const headRef = options.headRef ?? 'feat/login';
    const row = summary('pr', number, REPO_ID);
    const fork = options.fork === true;
    const pullRequest = {
        headRef,
        headSha,
        crossRepository: fork,
        maintainerCanModify: true,
        headOwner: fork ? 'octo' : 'acme',
        headRepo: fork ? 'octo/api' : 'acme/api',
        baseRef: 'main',
        baseDefaultBranch: 'main',
        headRemote: null,
        headPushURL: null
    };
    const defaults = ticketCreateDefaults({ ...row, repoID: REPO_ID, pullRequest, localBranch: options.localBranch ?? NO_LOCAL_BRANCHES });
    return {
        summary: row,
        pullRequest,
        repoID: REPO_ID,
        baseRemote: 'origin',
        defaults,
        existing: [],
        checkedOutAt: defaults.checkedOutAt,
        warnings: defaults.warnings,
        file: {
            provider: 'github',
            kind: 'pr',
            key: row.key,
            title: TITLE,
            url: row.url,
            repo: row.repo,
            state: 'open',
            author: 'octocat',
            labels: [],
            baseRef: 'main',
            headRef,
            headRepo: pullRequest.headRepo,
            body: 'Retries once.',
            comments: []
        },
        resolvedAt: NOW
    };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const realOps = worktreeGitOps(createGitRunner());
const detailed: WorktreeCreator = { begin: () => ({ detailed: true, run: (request, hooks) => performWorktreeAdd(realOps, request, hooks) }) };

function ticketHarness(fx: PullRequestFixture | null, options: HarnessOptions & { registered?: boolean } = {}): Harness {
    const h = harness({
        git: createGitService(),
        worktrees: detailed,
        ticketGit: realOps,
        ...(fx !== null ? { worktreeBasePath: path.join(fx.root, 'wt') } : {}),
        ...options
    });
    if (fx !== null && options.registered !== false) {
        h.dispatch({
            type: 'add-repo',
            repo: { id: REPO_ID, path: fx.work, name: 'work', remoteURL: 'https://github.com/acme/api.git', lastAccessedAt: 1, isAutoDiscovered: false }
        });
    }
    return h;
}

async function settle(h: Harness, index = 0): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 20_000;
    while ((h.replies[index]?.payloads.length ?? 0) === 0) {
        if (Date.now() > deadline) throw new Error('no reply');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return h.replies[index]?.payloads[0] as Record<string, unknown>;
}

interface ProgressReply extends ReplyHandle {
    readonly events: { kind: 'progress' | 'send' | 'uncancellable'; payload: Record<string, unknown> }[];
    readonly controller: AbortController;
}

function progressReply(): ProgressReply {
    const events: ProgressReply['events'] = [];
    const controller = new AbortController();
    let closed = false;
    return {
        events,
        controller,
        send: (payload) => events.push({ kind: 'send', payload }),
        progress: (payload) => events.push({ kind: 'progress', payload }),
        uncancellable: () => events.push({ kind: 'uncancellable', payload: {} }),
        close: () => {
            closed = true;
        },
        get closed() {
            return closed;
        },
        onDisconnect: () => {},
        signal: controller.signal
    };
}

function decoded(object: Record<string, unknown>): WireMessage {
    const result = decodeWireObject({ command: 'workspace-create', ...object });
    if (!result.ok) throw new Error(result.detail);
    return result.message as WireMessage;
}

async function sendDecoded(h: Harness, reply: ProgressReply, object: Record<string, unknown>): Promise<Record<string, unknown>> {
    h.table.get('workspace-create')?.(decoded(object), h.ctx, reply);
    const deadline = Date.now() + 20_000;
    while (!reply.events.some((event) => event.kind === 'send')) {
        if (Date.now() > deadline) throw new Error('no reply');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return reply.events.find((event) => event.kind === 'send')?.payload as Record<string, unknown>;
}

/** A ticket test's git with the alias remote `upstream` sent to `bare`, and nothing else that could reach the network. */
function offlineArgs(args: readonly string[], bare: string): readonly string[] {
    const command = args[0];
    if (command === 'push' || command === 'pull' || command === 'clone' || command === 'submodule' || (command === 'remote' && args[1] === 'update')) {
        throw new Error(`a ticket test ran git ${command}, which could reach the network`);
    }
    if (command !== 'fetch' && command !== 'ls-remote') return args;
    const mapped = args.map((arg) => (arg === 'upstream' ? bare : arg));
    if (!mapped.includes(bare)) throw new Error(`a ticket test fetched from something other than the local base: ${args.join(' ')}`);
    return mapped;
}

const ISSUE = 'https://github.com/acme/api/issues/418';
const PR = 'https://github.com/acme/api/pull/7';
const issueFile = (dir: string): string => path.join(dir, '.kelpi', 'ticket-418.md');

// ---------------------------------------------------------------------------
// Validation before any effect
// ---------------------------------------------------------------------------

describe('workspace-create with a ticket: refusals before any effect', () => {
    it('checks the agent fields first, then the reference, then the credential, then the group', () => {
        const tickets = fakeTickets(() => issueTicket());
        const launcher = recordingLauncher();
        const h = harness({ tickets, agentLauncher: launcher, git: stubGitService() });
        h.dispatch({ type: 'create-group', id: '0000000C-0000-4000-8000-000000000001', name: 'team', now: NOW });
        h.dispatch({ type: 'create-group', id: '0000000C-0000-4000-8000-000000000002', name: 'team', now: NOW });

        expect(h.reply({ command: 'workspace-create', ticket: 'not a ticket', start_agent: 'gemini' })).toEqual({
            ok: false,
            error: "unknown agent 'gemini' (expected claude or codex)"
        });
        expect(h.reply({ command: 'workspace-create', ticket: 'not a ticket', agent_prompt: 'x' })).toMatchObject({ ok: false, error: 'agent_prompt and send_prompt need start_agent' });
        expect(h.reply({ command: 'workspace-create', ticket: 'https://gitlab.com/acme/api/issues/1', start_agent: 'claude', agent_prompt: 'Go' })).toEqual({
            ok: false,
            error: "'https://gitlab.com/acme/api/issues/1' is not a GitHub issue or pull request: paste its URL, or owner/name#number",
            ticket_error: 'bad-ref'
        });
        expect(h.reply({ command: 'workspace-create', ticket: ISSUE, group: 'team' })).toEqual({
            ok: false,
            error: 'group name is ambiguous: team (use the id or rename an existing group)'
        });
        expect(tickets.calls).toEqual([]);
        expect(launcher.written).toEqual([]);
        expect(h.state().workspaces).toEqual([]);
        expect(h.state().repos).toEqual([]);
    });

    it('a provider with no credential is not-connected, and so is a table built without a service', () => {
        const disconnected = fakeTickets(() => issueTicket(), false);
        for (const h of [harness({ tickets: disconnected }), harness()]) {
            expect(h.reply({ command: 'workspace-create', ticket: 'acme/api#418' })).toEqual({
                ok: false,
                error: TICKET_NOT_CONNECTED_ERROR,
                ticket_error: 'not-connected'
            });
            expect(h.state().workspaces).toEqual([]);
        }
        expect(disconnected.calls).toEqual([]);
    });

    it("a resolve that fails is the create's refusal, with its code and extras, and writes no prompt file", async () => {
        const launcher = recordingLauncher();
        const tickets = fakeTickets(() => {
            throw new TicketServiceError('sso-required', 'Authorize Kelpi for acme', { ssoURL: 'https://github.com/orgs/acme/sso' });
        });
        const h = harness({ tickets, agentLauncher: launcher });
        h.send({ command: 'workspace-create', ticket: 'acme/api#418', start_agent: 'claude' });
        expect(await settle(h)).toEqual({ ok: false, error: 'Authorize Kelpi for acme', ticket_error: 'sso-required', sso_url: 'https://github.com/orgs/acme/sso' });
        expect(tickets.calls).toEqual([{ provider: 'github', owner: 'acme', name: 'api', repo: 'acme/api', number: 418, kind: null }]);
        expect(launcher.written).toEqual([]);
        expect(h.state().workspaces).toEqual([]);
    });

    it('a service that is stopping answers unavailable, which the create passes on', async () => {
        const h = harness({ tickets: fakeTickets(() => Promise.reject(new TicketServiceError('unavailable', 'Kelpi is stopping'))) });
        h.send({ command: 'workspace-create', ticket: ISSUE });
        expect(await settle(h)).toEqual({ ok: false, error: 'Kelpi is stopping', ticket_error: 'unavailable' });
        expect(h.state().workspaces).toEqual([]);
    });

    it('a ticket with neither a repository nor a worktree is refused', async () => {
        const h = harness({ tickets: fakeTickets(() => issueTicket({ repoID: null })) });
        h.send({ command: 'workspace-create', ticket: ISSUE });
        expect(await settle(h)).toEqual({
            ok: false,
            error: 'no registered repository has a remote for acme/api: add its clone in Settings ▸ Repositories, or name one (--repo)'
        });
        expect(h.state().workspaces).toEqual([]);
        const sheet = harness({ tickets: fakeTickets(() => issueTicket()) });
        sheet.send({ command: 'workspace-create', ticket: ISSUE, ticket_defaults: false, name: 'x' });
        expect(await settle(sheet)).toMatchObject({ ok: false });
    });
});

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_GIT)('workspace-create from an issue', { timeout: 30_000 }, () => {
    it('with the defaults: a worktree on 418-<slug> off the latest main, the ticket stored, the file written before the agent starts', async () => {
        const fx = pullRequestFixture();
        const wt = path.join(fx.root, 'wt', '418-retry-login-on-401');
        const launcher = recordingLauncher(() => issueFile(wt));
        const h = ticketHarness(fx, { tickets: fakeTickets(() => issueTicket()), agentLauncher: launcher, originClientID: 'client-1' });
        h.send({ command: 'workspace-create', ticket: ISSUE, start_agent: 'claude' });
        const reply = await settle(h);
        const workspace = h.state().workspaces[0];
        expect(reply).toEqual({
            ok: true,
            workspace_id: workspace?.id,
            workspace_name: '#418 Retry login on 401',
            worktree_path: wt,
            branch: '418-retry-login-on-401',
            update_main: true,
            repo_path: fx.work,
            muted: false,
            ticket: { provider: 'github', kind: 'issue', repo: 'acme/api', number: 418, key: '#418', url: ISSUE, title: TITLE },
            checkout: 'new-branch',
            ticket_file: issueFile(wt),
            start_agent: 'claude',
            prompt_file: promptFile(1)
        });
        expect(workspace?.ticket).toEqual({ provider: 'github', kind: 'issue', repo: 'acme/api', number: 418, key: '#418', url: ISSUE, title: TITLE });
        expect(workspace?.repoAssociations).toEqual([expect.objectContaining({ repoID: REPO_ID, worktreePath: wt, branchName: '418-retry-login-on-401' })]);
        expect(git(wt, 'rev-parse', 'HEAD')).toBe(fx.main);
        expect(fs.readFileSync(issueFile(wt), 'utf8')).toContain('Login fails after 401.');
        expect(launcher.written).toEqual([
            'Work on issue #418: Retry login on 401 (https://github.com/acme/api/issues/418). Read @.kelpi/ticket-418.md first, it has the full issue.'
        ]);
        expect(launcher.starts).toEqual([
            expect.objectContaining({ workspaceID: workspace?.id, originClientID: 'client-1', ticketFileExisted: true })
        ]);
    });

    it('re-creating an issue whose branch exists attaches it, with update main off', async () => {
        const fx = pullRequestFixture();
        git(fx.work, 'checkout', '-q', '-b', '418-retry-login-on-401');
        const tip = commit(fx.work, 'started.txt', 'x\n', 'started');
        git(fx.work, 'checkout', '-q', 'main');
        const lookup: LocalBranchLookup = (name) => (name === '418-retry-login-on-401' ? { exists: true, tracksPullRequest: false, checkedOutAt: null } : { exists: false });
        const h = ticketHarness(fx, { tickets: fakeTickets(() => issueTicket({ localBranch: lookup })) });
        h.send({ command: 'workspace-create', ticket: ISSUE });
        expect(await settle(h)).toMatchObject({ ok: true, checkout: 'attach-branch', update_main: false, branch: '418-retry-login-on-401' });
        expect(git(path.join(fx.root, 'wt', '418-retry-login-on-401'), 'rev-parse', 'HEAD')).toBe(tip);
    });

    it('the sheet (ticket_defaults false) gets exactly what it sent, and its prompt is never replaced by the default', async () => {
        const fx = pullRequestFixture();
        const launcher = recordingLauncher();
        const h = ticketHarness(fx, { tickets: fakeTickets(() => issueTicket()), agentLauncher: launcher });
        h.send({
            command: 'workspace-create',
            ticket: ISSUE,
            ticket_defaults: false,
            name: 'Login retry',
            repo: fx.work,
            worktree: 'login',
            branch: 'fix/login',
            update_main: false,
            start_agent: 'codex',
            agent_prompt: 'Fix it. See @.kelpi/ticket-418.md for details.'
        });
        expect(await settle(h)).toMatchObject({ ok: true, workspace_name: 'Login retry', branch: 'fix/login', update_main: false, checkout: 'new-branch' });
        expect(launcher.written).toEqual(['Fix it. See @.kelpi/ticket-418.md for details.']);

        // Without agent_prompt, the sheet's create has no prompt (the default is only for the CLI).
        const second = ticketHarness(fx, { tickets: fakeTickets(() => issueTicket()), agentLauncher: recordingLauncher(), registered: false });
        second.send({ command: 'workspace-create', ticket: ISSUE, ticket_defaults: false, repo: fx.work, worktree: 'login-2', start_agent: 'claude' });
        expect(await settle(second)).toMatchObject({ ok: true, start_agent: 'claude' });
        expect(second.replies[0]?.payloads[0]).not.toHaveProperty('prompt_file');
    });

    it('when the ticket file cannot be written, the prompt names only the URL, the first prompt file is replaced, and the create succeeds', async () => {
        const fx = pullRequestFixture();
        commit(fx.seed, '.kelpi/notes.md', 'tracked\n', 'track .kelpi');
        git(fx.seed, 'push', '-q', 'origin', 'main');
        const wt = path.join(fx.root, 'wt', '418-retry-login-on-401');
        const launcher = recordingLauncher();
        const h = ticketHarness(fx, { tickets: fakeTickets(() => issueTicket()), agentLauncher: launcher });
        h.send({ command: 'workspace-create', ticket: ISSUE, start_agent: 'claude', send_prompt: true });
        const reply = await settle(h);
        expect(reply).toMatchObject({ ok: true, ticket_file_error: 'the checkout tracks .kelpi, so Kelpi did not write a ticket file there', prompt_file: promptFile(2) });
        expect(reply).not.toHaveProperty('ticket_file');
        expect(fs.existsSync(issueFile(wt))).toBe(false);
        const vars = ticketPromptVars({ kind: 'issue', number: 418, key: '#418', title: TITLE, url: ISSUE, repo: 'acme/api', branch: '418-retry-login-on-401', base: null, author: 'octocat', labels: ['bug'] });
        expect(launcher.written).toEqual([renderTicketPrompt('issue', vars, 'ticket-file'), renderTicketPrompt('issue', vars, 'url-only')]);
        expect(launcher.discarded).toEqual([promptFile(1)]);
        expect(launcher.starts[0]?.request).toEqual({ kind: 'claude', prompt: renderTicketPrompt('issue', vars, 'url-only'), send: true, promptFile: promptFile(2) });
        expect(launcher.starts[0]?.request.prompt).not.toContain('.kelpi');

        // An edited prompt keeps its words, with the file's mention replaced by the URL.
        const edited = recordingLauncher();
        const sheet = ticketHarness(fx, { tickets: fakeTickets(() => issueTicket()), agentLauncher: edited, registered: false });
        sheet.send({ command: 'workspace-create', ticket: ISSUE, ticket_defaults: false, repo: fx.work, worktree: 'edited', update_main: true, start_agent: 'claude', agent_prompt: 'Start with @.kelpi/ticket-418.md please' });
        expect(await settle(sheet)).toMatchObject({ ok: true, ticket_file_error: expect.any(String) as unknown as string });
        expect(edited.written).toEqual(['Start with @.kelpi/ticket-418.md please', `Start with ${ISSUE} please`]);
    });

    it('registers a repository named by path with its remote URL', async () => {
        const fx = pullRequestFixture();
        // Nothing below fetches (update main is off), so the GitHub URL is never contacted.
        // (scp form: a user's global `url.*.insteadOf` may rewrite an https URL as git reads it back)
        git(fx.work, 'remote', 'set-url', 'origin', 'git@github.com:acme/api.git');
        const h = ticketHarness(fx, { tickets: fakeTickets(() => issueTicket({ repoID: null })), registered: false });
        h.send({ command: 'workspace-create', ticket: ISSUE, repo: fx.work, update_main: false });
        expect(await settle(h)).toMatchObject({ ok: true, repo_path: fx.work, checkout: 'new-branch' });
        expect(h.state().repos).toEqual([expect.objectContaining({ path: fx.work, remoteURL: 'git@github.com:acme/api.git', isAutoDiscovered: false })]);
    });

    it('a worktree-off create gets the ticket step and create-workspace, and the file goes into the checkout', async () => {
        const fx = pullRequestFixture();
        const h = ticketHarness(fx, { tickets: fakeTickets(() => issueTicket()) });
        const reply = progressReply();
        const answer = await sendDecoded(h, reply, { ticket: ISSUE, ticket_defaults: false, name: 'here', repo: fx.work });
        expect(answer).toMatchObject({ ok: true, repo_path: fx.work, checkout: 'existing-checkout', ticket_file: issueFile(fx.work) });
        const frames = reply.events.filter((event) => event.kind === 'progress').map((event) => event.payload);
        expect((frames[0] as { steps: unknown[] }).steps[0]).toEqual({ id: 'ticket', status: 'running', detail: 'acme/api#418' });
        expect(frames.at(-1)).toEqual({
            kind: 'worktree-create',
            steps: [
                { id: 'ticket', status: 'done', detail: '#418 Retry login on 401' },
                { id: 'create-workspace', status: 'done', detail: 'here' }
            ],
            checkout: 'existing-checkout'
        });
        expect(git(fx.work, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    });
});

describe('workspace-create with a ticket: cancel during the lookup', () => {
    it('stops at the ticket step, replies cancelled, and leaves nothing', async () => {
        const launcher = recordingLauncher();
        const tickets = fakeTickets(
            (_ref, signal) =>
                new Promise<ResolvedTicket>((_resolve, reject) => {
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                })
        );
        const h = harness({ tickets, agentLauncher: launcher });
        const reply = progressReply();
        h.table.get('workspace-create')?.(decoded({ ticket: ISSUE, start_agent: 'claude' }), h.ctx, reply);
        await new Promise((resolve) => setTimeout(resolve, 20));
        reply.controller.abort();
        const deadline = Date.now() + 5_000;
        while (!reply.events.some((event) => event.kind === 'send') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
        expect(reply.events.at(-1)).toEqual({ kind: 'send', payload: { ok: false, error: 'worktree create cancelled' } });
        const last = reply.events.filter((event) => event.kind === 'progress').at(-1)?.payload;
        expect(last).toMatchObject({ cancelled: true });
        expect((last as { steps: unknown[] }).steps[0]).toEqual({ id: 'ticket', status: 'failed', error: 'cancelled', detail: 'acme/api#418' });
        expect(h.state().workspaces).toEqual([]);
        expect(launcher.written).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_GIT)('workspace-create from a pull request', { timeout: 30_000 }, () => {
    it("checks out the head on its own branch, reports the pull request's steps, and writes the file", async () => {
        const fx = pullRequestFixture();
        const head = sameRepoPullRequest(fx, 7, 'feat/login');
        const h = ticketHarness(fx, { tickets: fakeTickets(() => prTicket(head)) });
        const reply = progressReply();
        const wt = path.join(fx.root, 'wt', 'feat-login');
        const answer = await sendDecoded(h, reply, { ticket: PR });
        expect(answer).toMatchObject({
            ok: true,
            workspace_name: '#7 Retry login on 401',
            worktree_path: wt,
            branch: 'feat/login',
            update_main: false,
            checkout: 'pr-head',
            ticket: { kind: 'pr', number: 7, key: '#7' },
            ticket_file: path.join(wt, '.kelpi', 'ticket-7.md')
        });
        expect(git(wt, 'rev-parse', 'HEAD')).toBe(head);
        expect(tryGit(fx.work, 'config', '--get', 'branch.feat/login.merge')).toBe('refs/heads/feat/login');
        const frames = reply.events.filter((event) => event.kind === 'progress').map((event) => event.payload as { steps: { id: string; status: string }[]; checkout?: string });
        expect(frames.at(-1)?.checkout).toBe('pr-head');
        expect(frames.at(-1)?.steps.map((step) => [step.id, step.status])).toEqual([
            ['ticket', 'done'],
            ['fetch', 'done'],
            ['worktree-add', 'done'],
            ['create-workspace', 'done']
        ]);
    });

    it('allows renaming the local branch, and refuses update main', async () => {
        const fx = pullRequestFixture();
        const head = sameRepoPullRequest(fx, 7, 'feat/login');
        const h = ticketHarness(fx, { tickets: fakeTickets(() => prTicket(head)) });
        h.send({ command: 'workspace-create', ticket: PR, ticket_defaults: false, repo: fx.work, worktree: 'review', branch: 'review/login' });
        expect(await settle(h)).toMatchObject({ ok: true, branch: 'review/login', checkout: 'pr-head' });
        expect(git(fx.work, 'rev-parse', 'review/login')).toBe(head);

        const launcher = recordingLauncher();
        const refused = ticketHarness(fx, { tickets: fakeTickets(() => prTicket(head)), agentLauncher: launcher, registered: false });
        refused.send({ command: 'workspace-create', ticket: PR, ticket_defaults: false, repo: fx.work, worktree: 'again', update_main: true, start_agent: 'claude', agent_prompt: 'go' });
        expect(await settle(refused)).toEqual({ ok: false, error: PR_UPDATE_MAIN_ERROR });
        expect(launcher.written).toEqual([]);
        expect(refused.state().workspaces).toEqual([]);
    });

    it('is refused while a plugin provides kelpi.git', async () => {
        const fx = pullRequestFixture();
        const head = sameRepoPullRequest(fx, 7, 'feat/login');
        const plugin: WorktreeCreator = { begin: () => ({ detailed: false, run: async () => {} }) };
        const h = ticketHarness(fx, { tickets: fakeTickets(() => prTicket(head)), worktrees: plugin });
        h.send({ command: 'workspace-create', ticket: PR });
        expect(await settle(h)).toEqual({ ok: false, error: PR_NEEDS_BUNDLED_GIT_ERROR });
    });

    it('is refused in a repository with no remote for the ticket, and works in another clone that has one', async () => {
        const fx = pullRequestFixture();
        const head = sameRepoPullRequest(fx, 7, 'feat/login');
        const h = ticketHarness(fx, { tickets: fakeTickets(() => prTicket(head)) });
        // The fixture's own clone points at a local path: not acme/api.
        const other = path.join(fx.root, 'other');
        git(fx.root, 'clone', '-q', fx.origin, other);
        h.send({ command: 'workspace-create', ticket: PR, repo: other });
        expect(await settle(h)).toEqual({ ok: false, error: `${other} has no remote for acme/api: a pull request is checked out only in a clone of its own repository` });

        git(other, 'remote', 'rename', 'origin', 'upstream');
        git(other, 'remote', 'set-url', 'upstream', 'https://github.com/acme/api.git');
        mapGitHubURL('acme/api', other, fx.origin);
        h.send({ command: 'workspace-create', ticket: PR, repo: other, worktree: 'from-other' });
        expect(await settle(h, 1)).toMatchObject({ ok: true, repo_path: other, checkout: 'pr-head' });
        expect(tryGit(other, 'config', '--get', 'branch.feat/login.remote')).toBe('upstream');
    });

    it("a fork checked out in another clone pushes to the fork through the base remote's push URL", async () => {
        const fx = pullRequestFixture();
        const head = forkPullRequest(fx, 8, 'fix');
        const other = path.join(fx.root, 'other');
        git(fx.root, 'clone', '-q', fx.origin, other);
        git(other, 'remote', 'set-url', 'origin', 'https://github.com/acme/api.git');
        git(other, 'remote', 'set-url', '--push', 'origin', 'git@github.com-work:acme/api.git');
        mapGitHubURL('acme/api', other, fx.origin);
        const h = ticketHarness(fx, { tickets: fakeTickets(() => prTicket(head, { number: 8, headRef: 'fix', fork: true })) });
        h.send({ command: 'workspace-create', ticket: 'https://github.com/acme/api/pull/8', repo: other });
        expect(await settle(h)).toMatchObject({ ok: true, repo_path: other, branch: 'fix', checkout: 'pr-head' });
        expect(git(other, 'rev-parse', 'fix')).toBe(head);
        expect(tryGit(other, 'config', '--get', 'branch.fix.remote')).toBe('git@github.com-work:octo/api.git');
        expect(tryGit(other, 'config', '--get', 'branch.fix.pushRemote')).toBe('git@github.com-work:octo/api.git');
        expect(tryGit(other, 'config', '--get', 'branch.fix.merge')).toBe('refs/heads/fix');
    });

    it("is planned on a remote spelled with an insteadOf alias, in a clone the resolve did not match (no network)", async () => {
        const fx = pullRequestFixture();
        const head = sameRepoPullRequest(fx, 7, 'feat/login');
        const other = path.join(fx.root, 'other');
        git(fx.root, 'clone', '-q', fx.origin, other);
        git(other, 'remote', 'rename', 'origin', 'upstream');
        // `gh:acme/api` names GitHub only once git rewrites it (`git remote -v`).
        git(other, 'remote', 'set-url', 'upstream', 'gh:acme/api');
        git(other, 'config', 'url.git@github.com:.insteadOf', 'gh:');
        // Every fetch through the alias remote is sent to the local base instead, so nothing here
        // can reach GitHub: the remote's name becomes the base's path, and anything else that
        // could touch the network is refused.
        const offline: typeof realOps = {
            read: (args, cwd, options) => realOps.read(offlineArgs(args, fx.origin), cwd, options),
            long: (args, cwd, options) => realOps.long(offlineArgs(args, fx.origin), cwd, options)
        };
        const h = ticketHarness(fx, { tickets: fakeTickets(() => prTicket(head)), ticketGit: offline });
        h.send({ command: 'workspace-create', ticket: PR, repo: other, worktree: 'via-alias' });
        expect(await settle(h)).toMatchObject({ ok: true, repo_path: other, branch: 'feat/login', checkout: 'pr-head' });
        expect(git(path.join(fx.root, 'wt', 'via-alias'), 'rev-parse', 'HEAD')).toBe(head);
        expect(tryGit(other, 'config', '--get', 'branch.feat/login.remote')).toBe('upstream');
    });

    it("a branch tracking another remote of the base repository is the one the resolve proposes AND the one the create checks out", async () => {
        const fx = pullRequestFixture();
        sameRepoPullRequest(fx, 7, 'feat/login');
        git(fx.work, 'remote', 'add', 'upstream', 'https://github.com/acme/api.git');
        mapGitHubURL('acme/api', fx.work, fx.origin);
        git(fx.work, 'fetch', '-q', 'upstream');
        git(fx.work, 'branch', '--track', 'feat/login', 'upstream/feat/login');
        git(fx.seed, 'checkout', '-q', 'feat/login');
        const head = commit(fx.seed, 'more.txt', 'more\n', 'more');
        git(fx.seed, 'push', '-q', 'origin', 'feat/login');
        git(fx.seed, 'checkout', '-q', 'main');
        // What the resolve proposes, decided exactly as it decides: the one reader, the one rule.
        const read = (args: readonly string[]): Promise<string> => realOps.read(args, fx.work);
        const localBranch = localBranchLookup(await readBranchFacts(read), await readRemoteFacts(read), {
            kind: 'pr',
            number: 7,
            repo: 'acme/api',
            headRef: 'feat/login',
            headRepo: 'acme/api',
            crossRepository: false,
            baseRemote: 'origin',
            headRemote: null,
            headPushURL: null
        });
        const proposed = prTicket(head, { localBranch });
        expect(proposed.defaults).toMatchObject({ branch: 'feat/login', checkout: 'pr-head' });
        const h = ticketHarness(fx, { tickets: fakeTickets(() => proposed) });
        h.send({ command: 'workspace-create', ticket: PR });
        expect(await settle(h)).toMatchObject({ ok: true, branch: 'feat/login', checkout: 'pr-head' });
        expect(git(fx.work, 'rev-parse', 'feat/login')).toBe(head);
    });

    it("is refused through a group whose repository has no remote for it, and an unknown group is refused before git", async () => {
        const fx = pullRequestFixture();
        const head = sameRepoPullRequest(fx, 7, 'feat/login');
        const other = path.join(fx.root, 'other');
        git(fx.root, 'clone', '-q', fx.origin, other);
        const h = ticketHarness(fx, { tickets: fakeTickets(() => prTicket(head)) });
        const OTHER_ID = '0000000A-0000-4000-8000-000000000002';
        const GROUP_ID = '0000000D-0000-4000-8000-000000000001';
        h.dispatch(
            { type: 'add-repo', repo: { id: OTHER_ID, path: other, name: 'other', remoteURL: null, lastAccessedAt: 1, isAutoDiscovered: false } },
            { type: 'create-group', id: GROUP_ID, name: 'team', now: NOW },
            { type: 'set-group-repo', id: GROUP_ID, repoID: OTHER_ID }
        );
        h.send({ command: 'workspace-create', ticket: PR, group: 'team' });
        expect(await settle(h)).toEqual({ ok: false, error: `${other} has no remote for acme/api: a pull request is checked out only in a clone of its own repository` });
        h.send({ command: 'workspace-create', ticket: PR, group: 'nobody' });
        expect(await settle(h, 1)).toMatchObject({ ok: false, error: expect.stringContaining('unknown group: nobody') as unknown as string });
        expect(h.state().workspaces).toEqual([]);
        expect(tryGit(fx.work, 'rev-parse', '--verify', '--quiet', 'refs/heads/feat/login')).toBeNull();
    });

    it('opens a workspace where the branch is already checked out (no worktree)', async () => {
        const fx = pullRequestFixture();
        const head = sameRepoPullRequest(fx, 7, 'feat/login');
        git(fx.work, 'fetch', '-q', 'origin');
        git(fx.work, 'checkout', '-q', '--track', 'origin/feat/login');
        const lookup: LocalBranchLookup = (name) => (name === 'feat/login' ? { exists: true, tracksPullRequest: true, checkedOutAt: fx.work } : { exists: false });
        const h = ticketHarness(fx, { tickets: fakeTickets(() => prTicket(head, { localBranch: lookup })) });
        h.send({ command: 'workspace-create', ticket: PR });
        expect(await settle(h)).toMatchObject({ ok: true, repo_path: fx.work, checkout: 'existing-checkout', ticket_file: path.join(fx.work, '.kelpi', 'ticket-7.md') });
        const workspace = h.state().workspaces[0];
        expect(workspace?.panes[0]?.workingDirectory).toBe(fx.work);
        expect(workspace?.repoAssociations).toEqual([expect.objectContaining({ repoID: REPO_ID, worktreePath: fx.work, branchName: 'feat/login' })]);
        expect(git(fx.work, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    });

    it('opens at the existing checkout only when the request asks for nothing else: another branch is a worktree, update main is refused', async () => {
        const fx = pullRequestFixture();
        const head = sameRepoPullRequest(fx, 7, 'feat/login');
        git(fx.work, 'fetch', '-q', 'origin');
        git(fx.work, 'checkout', '-q', '--track', 'origin/feat/login');
        const lookup: LocalBranchLookup = (name) => (name === 'feat/login' ? { exists: true, tracksPullRequest: true, checkedOutAt: fx.work } : { exists: false });
        const launcher = recordingLauncher();
        const h = ticketHarness(fx, { tickets: fakeTickets(() => prTicket(head, { localBranch: lookup })), agentLauncher: launcher });

        // What `--from <pr> --branch review` sends (no worktree, defaults on): the head on `review`.
        h.send({ command: 'workspace-create', ticket: PR, branch: 'review' });
        const wt = path.join(fx.root, 'wt', 'review');
        expect(await settle(h)).toMatchObject({ ok: true, checkout: 'pr-head', branch: 'review', worktree_path: wt });
        expect(git(wt, 'rev-parse', 'HEAD')).toBe(head);
        expect(git(wt, 'symbolic-ref', 'HEAD')).toBe('refs/heads/review');

        // `--update-main` through `owner/name#n`: the pull request's refusal, nothing made.
        h.send({ command: 'workspace-create', ticket: 'acme/api#7', update_main: true, start_agent: 'claude' });
        expect(await settle(h, 1)).toEqual({ ok: false, error: PR_UPDATE_MAIN_ERROR });
        expect(launcher.written).toEqual([]);

        // The defaults' own branch, or update main off, asks for nothing new: the existing checkout.
        h.send({ command: 'workspace-create', ticket: PR, branch: 'feat/login' });
        expect(await settle(h, 2)).toMatchObject({ ok: true, checkout: 'existing-checkout', repo_path: fx.work });
        h.send({ command: 'workspace-create', ticket: PR, update_main: false });
        expect(await settle(h, 3)).toMatchObject({ ok: true, checkout: 'existing-checkout', repo_path: fx.work });
        expect(h.state().workspaces).toHaveLength(3);
        expect(git(fx.work, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(2);
    });
});

describe.skipIf(!HAS_GIT)("workspace-create from an issue whose branch is already checked out", { timeout: 30_000 }, () => {
    it('opens there by default, makes a worktree for another branch, and refuses update main on the existing branch', async () => {
        const fx = pullRequestFixture();
        const branch = '418-retry-login-on-401';
        git(fx.work, 'checkout', '-q', '-b', branch);
        const lookup: LocalBranchLookup = (name) => (name === branch ? { exists: true, tracksPullRequest: false, checkedOutAt: fx.work } : { exists: false });
        const h = ticketHarness(fx, { tickets: fakeTickets(() => issueTicket({ localBranch: lookup })) });

        h.send({ command: 'workspace-create', ticket: ISSUE });
        expect(await settle(h)).toMatchObject({ ok: true, checkout: 'existing-checkout', repo_path: fx.work });
        // The same branch, typed so that it only sanitizes to it, is still the defaults' own.
        h.send({ command: 'workspace-create', ticket: ISSUE, branch: '418 retry login on 401' });
        expect(await settle(h, 1)).toMatchObject({ ok: true, checkout: 'existing-checkout' });

        h.send({ command: 'workspace-create', ticket: ISSUE, branch: 'other' });
        expect(await settle(h, 2)).toMatchObject({ ok: true, checkout: 'new-branch', branch: 'other', update_main: true });
        expect(git(fx.work, 'rev-parse', 'refs/heads/other')).toBe(fx.main);

        h.send({ command: 'workspace-create', ticket: ISSUE, update_main: true });
        const refused = await settle(h, 3);
        expect(refused).toMatchObject({ ok: false, error: expect.stringContaining(`branch '${branch}' already exists, and update main always creates a new branch`) as unknown as string });
        expect(h.state().workspaces).toHaveLength(3);
    });
});

// ---------------------------------------------------------------------------
// Without a ticket: the worktree branch now registers the repo's remote URL
// ---------------------------------------------------------------------------

describe('workspace-create --worktree registers a new repository with its remote URL', () => {
    it('fills remoteURL from origin', async () => {
        const git: GitService = stubGitService({ getRemoteURL: async () => 'git@github.com:acme/api.git' });
        const h = harness({ git });
        h.send({ command: 'workspace-create', name: 'x', worktree: 'x', repo: '/code/api' });
        expect(await settle(h)).toMatchObject({ ok: true });
        expect(h.state().repos).toEqual([expect.objectContaining({ path: '/code/api', remoteURL: 'git@github.com:acme/api.git', isAutoDiscovered: false })]);
    });

    it('never registers a token that rides in the URL: the registry reaches every client', async () => {
        const git: GitService = stubGitService({ getRemoteURL: async () => 'https://x-access-token:ghp_SECRET@github.com/acme/api.git' });
        const h = harness({ git });
        h.send({ command: 'workspace-create', name: 'x', worktree: 'x', repo: '/code/api' });
        expect(await settle(h)).toMatchObject({ ok: true });
        expect(h.state().repos).toEqual([expect.objectContaining({ path: '/code/api', remoteURL: 'https://github.com/acme/api.git' })]);
        expect(JSON.stringify(h.state())).not.toContain('ghp_SECRET');
    });
});

// ---------------------------------------------------------------------------
// Icon, parent and focus: a ticket create is any create (app-state-core.md §2.9, #307)
// ---------------------------------------------------------------------------

const PARENT_ID = '0000000D-0000-4000-8000-000000000001';
const PARENT_PANE_ID = '0000000D-0000-4000-8000-000000000002';
const BUG = 'emoji:🐛';

/** A ticket harness that already holds the active workspace `orchestrator`, the parent below. */
function withParent(fx: PullRequestFixture | null, options: HarnessOptions & { registered?: boolean } = {}): Harness {
    const h = fx === null ? harness(options) : ticketHarness(fx, options);
    h.dispatch({ type: 'create-workspace', id: PARENT_ID, paneID: PARENT_PANE_ID, name: 'orchestrator', now: NOW });
    return h;
}

const childOrderOfParent = (h: Harness): readonly string[] | undefined =>
    h.state().workspaces.find((workspace) => workspace.id === PARENT_ID)?.childOrder;

describe('workspace-create with a ticket: icon, parent and focus, as any create', () => {
    it('refuses a bad icon, then a bad parent, before any ticket check: nothing resolves and no prompt file is written', () => {
        const tickets = fakeTickets(() => issueTicket());
        const launcher = recordingLauncher();
        const h = withParent(null, { tickets, agentLauncher: launcher, git: stubGitService() });
        h.dispatch({ type: 'create-group', id: '0000000C-0000-4000-8000-000000000001', name: 'team', now: NOW });

        // A bad reference too: the icon is checked first, so it is the icon that is refused.
        expect(h.reply({ command: 'workspace-create', ticket: 'not a ticket', icon: 'nope', start_agent: 'claude', agent_prompt: 'Go' })).toEqual({
            ok: false,
            error: "'nope' is not an icon: give emoji:<emoji> or system:<symbol>"
        });
        const unknownParent = h.reply({ command: 'workspace-create', ticket: 'not a ticket', parent: 'nobody', start_agent: 'claude' });
        expect(unknownParent).toMatchObject({ ok: false, error: expect.stringMatching(/^parent /) });
        expect(unknownParent).not.toHaveProperty('ticket_error');
        expect(h.reply({ command: 'workspace-create', ticket: ISSUE, parent: 'orchestrator', group: 'team' })).toEqual({
            ok: false,
            error: "a nested workspace follows its parent's group: pass a parent or a group, not both"
        });
        // Past the two pure checks, the ticket's own refusals follow in their order.
        expect(h.reply({ command: 'workspace-create', ticket: 'not a ticket', parent: 'orchestrator', icon: BUG })).toMatchObject({
            ok: false,
            ticket_error: 'bad-ref'
        });
        expect(tickets.calls).toEqual([]);
        expect(launcher.written).toEqual([]);
        expect(h.state().workspaces.map((workspace) => workspace.id)).toEqual([PARENT_ID]);
    });

    it.skipIf(!HAS_GIT)('without a worktree: nested under the parent with its icon, in the background unless asked', { timeout: 30_000 }, async () => {
        const fx = pullRequestFixture();
        const h = withParent(fx, { tickets: fakeTickets(() => issueTicket()) });
        h.send({ command: 'workspace-create', ticket: ISSUE, ticket_defaults: false, name: 'worker', repo: fx.work, parent: 'orchestrator', icon: BUG });
        const reply = await settle(h);
        const created = h.state().workspaces.find((workspace) => workspace.name === 'worker');
        expect(reply).toMatchObject({
            ok: true,
            workspace_id: created?.id,
            icon: BUG,
            parent_id: PARENT_ID,
            parent_name: 'orchestrator',
            checkout: 'existing-checkout',
            ticket: expect.objectContaining({ key: '#418' })
        });
        expect(created?.icon).toEqual({ kind: 'emoji', grapheme: '🐛' });
        expect(created?.ticket).toMatchObject({ key: '#418' });
        expect(childOrderOfParent(h)).toEqual([created?.id]);
        // #307: no focus, so nothing moved.
        expect(h.state().lastActiveWorkspaceID).toBe(PARENT_ID);
        expect(h.broadcasts.filter((message) => message['type'] === 'reveal-pane')).toEqual([]);

        const focused = withParent(fx, { tickets: fakeTickets(() => issueTicket()), registered: false });
        focused.send({ command: 'workspace-create', ticket: ISSUE, ticket_defaults: false, name: 'front', repo: fx.work, focus: true });
        expect(await settle(focused)).toMatchObject({ ok: true });
        const front = focused.state().workspaces.find((workspace) => workspace.name === 'front');
        expect(focused.state().lastActiveWorkspaceID).toBe(front?.id);
        expect(focused.broadcasts).toContainEqual({ type: 'reveal-pane', workspaceID: front?.id, paneID: front?.panes[0]?.id });
    });

    it.skipIf(!HAS_GIT)("with a worktree: nested, and its source is the parent's group repository", { timeout: 30_000 }, async () => {
        const fx = pullRequestFixture();
        const groupID = '0000000C-0000-4000-8000-000000000003';
        // The ticket matched no repository, so only the parent's group can supply one.
        const h = ticketHarness(fx, { tickets: fakeTickets(() => issueTicket({ repoID: null })) });
        h.dispatch({ type: 'create-group', id: groupID, name: 'team', now: NOW, repoID: REPO_ID });
        h.dispatch({ type: 'create-workspace', id: PARENT_ID, paneID: PARENT_PANE_ID, name: 'orchestrator', now: NOW, groupID });
        h.send({ command: 'workspace-create', ticket: ISSUE, parent: 'orchestrator', icon: BUG, focus: true });
        const reply = await settle(h);
        const wt = path.join(fx.root, 'wt', '418-retry-login-on-401');
        const created = h.state().workspaces.find((workspace) => workspace.name === '#418 Retry login on 401');
        expect(reply).toMatchObject({ ok: true, repo_path: fx.work, worktree_path: wt, checkout: 'new-branch', icon: BUG, parent_id: PARENT_ID, parent_name: 'orchestrator' });
        expect(reply).not.toHaveProperty('group');
        expect(reply).not.toHaveProperty('parent_lost');
        expect(childOrderOfParent(h)).toEqual([created?.id]);
        expect(h.state().lastActiveWorkspaceID).toBe(created?.id);
    });

    it.skipIf(!HAS_GIT)('a parent deleted while the ticket resolves: a worktree create completes at the top level, a checkout create is refused whole', { timeout: 30_000 }, async () => {
        const fx = pullRequestFixture();
        let deleteParent = (): void => {};
        const tickets = fakeTickets(() => {
            deleteParent();
            return issueTicket();
        });

        const launcher = recordingLauncher();
        const plain = withParent(fx, { tickets, agentLauncher: launcher });
        deleteParent = () => plain.dispatch({ type: 'delete-workspace', id: PARENT_ID });
        plain.send({ command: 'workspace-create', ticket: ISSUE, ticket_defaults: false, name: 'here', repo: fx.work, parent: 'orchestrator', start_agent: 'claude', agent_prompt: 'Go' });
        expect(await settle(plain)).toEqual({ ok: false, error: "parent 'orchestrator' was deleted while the workspace was being created" });
        expect(plain.state().workspaces).toEqual([]);
        // Refused after its prompt file was written: the file goes with the refusal.
        expect(launcher.discarded).toEqual([promptFile(1)]);
        expect(fs.existsSync(issueFile(fx.work))).toBe(false);

        const worktree = withParent(fx, { tickets, registered: false });
        deleteParent = () => worktree.dispatch({ type: 'delete-workspace', id: PARENT_ID });
        worktree.send({ command: 'workspace-create', ticket: ISSUE, ticket_defaults: false, repo: fx.work, worktree: 'orphan', parent: 'orchestrator' });
        const reply = await settle(worktree);
        expect(reply).toMatchObject({
            ok: true,
            parent_lost: true,
            parent_lost_reason: "parent 'orchestrator' was deleted while the workspace was being created",
            ticket_file: issueFile(path.join(fx.root, 'wt', 'orphan'))
        });
        expect(reply).not.toHaveProperty('parent_id');
        expect(worktree.state().workspaces.map((workspace) => workspace.name)).toEqual(['Workspace']);
    });
});
