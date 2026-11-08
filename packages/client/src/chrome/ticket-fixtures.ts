/**
 * Synthetic tickets, replies and sources for the ticket picker and the New Workspace sheet's
 * From ticket tests (docs/integrations.md). Test-only: nothing in the app imports it.
 */

import type {
    TicketResolveDefaults,
    TicketResolveReply,
    TicketSearchReply,
    TicketSummary,
    WsIntegrationStatus
} from '@kelpi/protocol';
import { vi } from 'vitest';

import type { TicketResolveOutcome, TicketSearchOutcome, TicketSource } from './TicketPicker';

export const CONNECTED: WsIntegrationStatus = { provider: 'github', available: true, connected: true, login: 'octo', how: 'oauth', scopes: ['repo'] };

export function ticket(number: number, overrides: Partial<TicketSummary> = {}): TicketSummary {
    const kind = overrides.kind ?? 'issue';
    const repo = overrides.repo ?? 'acme/api';
    return {
        provider: 'github',
        kind,
        repo,
        number,
        key: `#${String(number)}`,
        title: `Ticket ${String(number)}`,
        url: `https://github.com/${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${String(number)}`,
        state: 'open',
        author: 'octo',
        labels: [],
        updated_at: '2026-10-01T00:00:00Z',
        repo_id: 'r1',
        ...overrides
    };
}

export function searchReply(sections: TicketSearchReply['sections'], warnings?: readonly string[]): TicketSearchReply {
    return { ok: true, sections, ...(warnings === undefined ? {} : { warnings }) };
}

export function defaultLists(): TicketSearchReply {
    return searchReply([
        { id: 'authored', items: [ticket(418, { kind: 'pr', title: 'Retry login on 401' })] },
        { id: 'review-requested', items: [ticket(77, { kind: 'pr', repo: 'other/lib', repo_id: null, title: 'Bump deps' })] },
        { id: 'assigned', items: [ticket(12, { title: 'Crash on start' })] }
    ]);
}

export function resolveReply(
    summary: TicketSummary,
    defaults: Partial<TicketResolveDefaults> = {},
    extra: Partial<Omit<TicketResolveReply, 'ok' | 'ticket' | 'defaults'>> = {}
): TicketResolveReply {
    const pr = summary.kind === 'pr';
    return {
        ok: true,
        ticket: summary,
        defaults: {
            name: `${summary.key} ${summary.title}`,
            repo_id: summary.repo_id,
            worktree: pr ? 'fix-login' : `${String(summary.number)}-ticket`,
            branch: pr ? 'fix/login' : `${String(summary.number)}-ticket`,
            checkout: pr ? 'pr-head' : 'new-branch',
            update_main: !pr,
            prompt: `Work on ${summary.key}: ${summary.title} (${summary.url}).`,
            prompt_variant: 'ticket-file',
            ...defaults
        },
        existing: [],
        ...extra
    };
}

export interface FakeTicketSource extends TicketSource {
    readonly search: ReturnType<typeof vi.fn> & ((query: string) => Promise<TicketSearchOutcome>);
    readonly resolve: ReturnType<typeof vi.fn> & ((ref: string) => Promise<TicketResolveOutcome>);
    readonly openIntegrationSettings: ReturnType<typeof vi.fn> & (() => void);
    readonly openURL: ReturnType<typeof vi.fn> & ((url: string) => void);
    readonly switchToWorkspace: ReturnType<typeof vi.fn> & ((workspaceID: string) => void);
}

/**
 * A source that answers every search with the default lists and every resolve with `resolved`
 * (an issue #12 by default). Override either with `mockImplementation` for a test of its own.
 */
export function fakeTicketSource(
    options: {
        readonly status?: WsIntegrationStatus | null;
        readonly resolved?: TicketResolveReply;
        readonly names?: Readonly<Record<string, string>>;
    } = {}
): FakeTicketSource {
    const resolved = options.resolved ?? resolveReply(ticket(12, { title: 'Crash on start' }));
    return {
        status: options.status === undefined ? CONNECTED : options.status,
        search: vi.fn(async (): Promise<TicketSearchOutcome> => ({ ok: true, reply: defaultLists() })),
        resolve: vi.fn(async (): Promise<TicketResolveOutcome> => ({ ok: true, reply: resolved })),
        openIntegrationSettings: vi.fn(),
        openURL: vi.fn(),
        workspaceName: (workspaceID: string) => options.names?.[workspaceID] ?? null,
        switchToWorkspace: vi.fn()
    } as unknown as FakeTicketSource;
}
