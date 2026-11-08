/**
 * Reading a `WorkspaceTicket` back from anywhere it was stored or sent: the `workspace.ticketJSON`
 * column (`db/codec.ts`) and a client's mirror of an older or newer daemon
 * (`client/src/state/store.ts`).
 *
 * Lenient the way the codec is (docs/persistence.md §9): a record that is not a ticket this daemon
 * can trust whole reads as null, "no ticket", and never fails the workspace it belongs to. Whole,
 * because a half-read ticket (a key with no URL) would link somewhere it should not. Unknown keys
 * are dropped, so nothing rides through unvalidated.
 */

import { TICKET_KINDS, TICKET_PROVIDERS, type TicketKind, type TicketProvider, type TicketSummary } from '@kelpi/protocol';

import type { WorkspaceTicket } from './types.js';

/** Longer strings than these are not a ticket Kelpi stored. */
const MAX_REPO_LENGTH = 300;
const MAX_KEY_LENGTH = 100;
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 1000;

function text(value: unknown, maxLength: number): string | null {
    return typeof value === 'string' && value !== '' && value.length <= maxLength ? value : null;
}

/** A stored or mirrored ticket, validated, or null (module note). */
export function parseWorkspaceTicket(value: unknown): WorkspaceTicket | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const provider = record['provider'];
    const kind = record['kind'];
    if (!(TICKET_PROVIDERS as readonly unknown[]).includes(provider)) return null;
    if (!(TICKET_KINDS as readonly unknown[]).includes(kind)) return null;
    const repo = text(record['repo'], MAX_REPO_LENGTH);
    const key = text(record['key'], MAX_KEY_LENGTH);
    const url = text(record['url'], MAX_URL_LENGTH);
    const number = record['number'];
    const title = record['title'];
    if (repo === null || key === null || url === null || !/^https:\/\/\S+$/.test(url)) return null;
    if (number !== null && (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0)) return null;
    if (typeof title !== 'string' || title.length > MAX_TITLE_LENGTH) return null;
    return { provider: provider as TicketProvider, kind: kind as TicketKind, repo, number, key, url, title };
}

/** `workspace.ticketJSON` → a ticket, or null for NULL, undecodable JSON, or a record that does not parse. */
export function decodeWorkspaceTicketJSON(text: string | null): WorkspaceTicket | null {
    if (text === null || text === '') return null;
    try {
        return parseWorkspaceTicket(JSON.parse(text));
    } catch {
        return null;
    }
}

/** A ticket → `workspace.ticketJSON`, keys in a fixed order; null → NULL. */
export function encodeWorkspaceTicketJSON(ticket: WorkspaceTicket | null | undefined): string | null {
    if (ticket === null || ticket === undefined) return null;
    return JSON.stringify({
        provider: ticket.provider,
        kind: ticket.kind,
        repo: ticket.repo,
        number: ticket.number,
        key: ticket.key,
        url: ticket.url,
        title: ticket.title
    });
}

/** What a workspace created from a resolved ticket keeps: the seven fields, nothing else. */
export function workspaceTicketOf(summary: TicketSummary): WorkspaceTicket {
    return {
        provider: summary.provider,
        kind: summary.kind,
        repo: summary.repo,
        number: summary.number,
        key: summary.key,
        url: summary.url,
        title: summary.title
    };
}
