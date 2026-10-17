/**
 * The integrations verbs over the client socket (docs/integrations.md §2, §9.7): the routing half.
 * The verbs, requests, replies and readers are the protocol's (`@kelpi/protocol`'s
 * `ws/integrations.ts`); the work is the integrations service's (`../integrations/service.ts`).
 *
 * Seven WS-only verbs, matched before the wire decode like the remote and repo families
 * (`./remote.ts`, `./repos.ts`): `ws/sync.ts` sends any `isIntegrationCommand` payload here and
 * nowhere else. Who may call what is decided HERE, from what only the session knows:
 *
 *   - the four management verbs (`INTEGRATION_MANAGEMENT_COMMANDS`: link-start, link-cancel,
 *     link-token, unlink) need an OWNER session. A session that authenticated with a paired-device
 *     token (`kd_…`) is refused, and so is a command a plugin view sends through `executeCommand`
 *     (`commandSource === 'plugin'`): plugin backends run without a credential, so the internal
 *     session they use would otherwise count as the owner. Both answer `{ok:false, code:'forbidden'}`;
 *   - `integrations-status`, `ticket-search` and `ticket-resolve` are open to every session,
 *     plugins included (plugins are trusted by design, ARCHITECTURE.md "Plugin architecture"; a
 *     paired device can already create workspaces).
 *
 * The family is never plugin-hookable: `ws/sync.ts` sends it past the operation-hook interception
 * before anything else, so a wildcard (`'*'`) hook never sees a pasted token go by.
 */

import {
    decodeIntegrationRequest,
    isIntegrationManagementCommand,
    type IntegrationFailure,
    type IntegrationLinkCancelReply,
    type IntegrationLinkStartReply,
    type IntegrationLinkTokenReply,
    type IntegrationProvider,
    type IntegrationsStatusReply,
    type IntegrationUnlinkReply,
    type JsonObject,
    type TicketResolveReply,
    type TicketSearchReply,
    type WsIntegrationStatus
} from '@kelpi/protocol';

/** What the sync hub needs of the integrations service. */
export interface IntegrationsChannel {
    /** Every provider's status, as `welcome` and `integrations-changed` carry it. */
    statuses(): readonly WsIntegrationStatus[];
    /** Called with the new statuses whenever any changes; returns the unsubscribe. */
    onChange(listener: (statuses: readonly WsIntegrationStatus[]) => void): () => void;
    linkStart(provider: IntegrationProvider, signal: AbortSignal): Promise<IntegrationLinkStartReply | IntegrationFailure>;
    linkCancel(provider: IntegrationProvider, flowID: string | undefined): IntegrationLinkCancelReply;
    linkToken(provider: IntegrationProvider, token: string, signal: AbortSignal): Promise<IntegrationLinkTokenReply | IntegrationFailure>;
    unlink(provider: IntegrationProvider): IntegrationUnlinkReply | IntegrationFailure;
    ticketSearch(provider: IntegrationProvider, query: string, signal: AbortSignal): Promise<TicketSearchReply | IntegrationFailure>;
    /** `ref` as the client sent it (trimmed): a reference `parseTicketRef` refuses answers `bad-ref`. */
    ticketResolve(ref: string, signal: AbortSignal): Promise<TicketResolveReply | IntegrationFailure>;
}

export interface IntegrationSession {
    /** An owner session that is not running a plugin view's command (module note). */
    readonly manageable: boolean;
}

/** The refusal a management verb gets from a paired device or a plugin view. */
export function forbiddenFailure(command: string): IntegrationFailure {
    return {
        ok: false,
        error: `${command} is owner-only: a paired device or a plugin cannot link or unlink accounts`,
        code: 'forbidden'
    };
}

/** One integrations verb, decoded, authorized and answered. The channel answers failures as replies; a rejection is a bug. */
export async function handleIntegrationCommand(
    channel: IntegrationsChannel,
    payload: Readonly<Record<string, unknown>>,
    session: IntegrationSession,
    signal: AbortSignal
): Promise<JsonObject> {
    // Authorization first, on the raw verb name: a refused session learns nothing about the
    // request it sent, not even whether it was well formed.
    const command = payload['command'];
    if (typeof command === 'string' && isIntegrationManagementCommand(command) && !session.manageable) {
        return forbiddenFailure(command) as unknown as JsonObject;
    }
    const decoded = decodeIntegrationRequest(payload);
    if (!decoded.ok) return decoded.failure as unknown as JsonObject;
    const request = decoded.request;
    let reply: object;
    switch (request.command) {
        case 'integrations-status': {
            const status: IntegrationsStatusReply = { ok: true, integrations: channel.statuses(), manageable: session.manageable };
            reply = status;
            break;
        }
        case 'integration-link-start':
            reply = await channel.linkStart(request.provider, signal);
            break;
        case 'integration-link-cancel':
            reply = channel.linkCancel(request.provider, request.flow_id);
            break;
        case 'integration-link-token':
            reply = await channel.linkToken(request.provider, request.token, signal);
            break;
        case 'integration-unlink':
            reply = channel.unlink(request.provider);
            break;
        case 'ticket-search':
            reply = await channel.ticketSearch(request.provider, request.query, signal);
            break;
        case 'ticket-resolve':
            reply = await channel.ticketResolve(request.ref, signal);
            break;
    }
    return reply as JsonObject;
}
