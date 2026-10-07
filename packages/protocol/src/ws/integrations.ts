/**
 * Integrations over the client socket: linking a GitHub account to the daemon, and finding and
 * resolving the tickets (issues and pull requests) a workspace can start from
 * (docs/integrations.md; the create half is `workspace-create`'s `ticket`, wire-protocol.md §6.3).
 *
 * The daemon owns the credential. It lives in daemon memory and in `integrations.json` (0600)
 * beside the database, and NOTHING in this module carries it: not the status, not a frame, not a
 * reply. The one secret-adjacent value that does travel is the device flow's `user_code` (with its
 * `verification_uri`), and only in the `integration-link-start` reply, to the session that asked
 * for it; GitHub's `device_code` never leaves daemon memory at all.
 *
 * Seven WS-only verbs, matched before the wire decode like the remote and repo families
 * (`daemon/src/ws/remote.ts`, `daemon/src/ws/repos.ts`): a CLI verb would be a compatibility
 * surface owed forever, and the CLI reaches tickets through ONE field instead (`workspace-create
 * --from`, which sends `ticket`). They live in the protocol package, not the daemon, because the
 * client builds the requests and reads the replies, and the frame rides `welcome`.
 *
 *   integrations-status       -                         → every provider's status, and whether
 *                                                         this session may manage them
 *   integration-link-start    `provider`                → start GitHub's device flow; the reply
 *                                                         carries the code to type at GitHub
 *   integration-link-cancel   `provider`, `flow_id?`    → abandon the pending flow (only that
 *                                                         flow, when `flow_id` names one)
 *   integration-link-token    `provider`, `token`       → link with a personal access token
 *   integration-unlink        `provider`                → forget the credential
 *   ticket-search             `provider`, `query`       → the picker's lists: three `@me` lists
 *                                                         for an empty query, else one result list
 *   ticket-resolve            `ref`                     → one ticket, the defaults a create from
 *                                                         it would use, and where it is already open
 *
 * The four management verbs (`INTEGRATION_MANAGEMENT_COMMANDS`) are OWNER-ONLY: a session that
 * authenticated with a paired-device token (`kd_…`) is refused, and so is a command a plugin view
 * sends through `executeCommand` (plugin backends run credential-less and would otherwise count as
 * the owner). Search and resolve are open to every session, plugins included: a paired device can
 * already create workspaces, and a ticket is read with the owner's credential either way, which
 * Settings ▸ Integrations says in words. `daemon/src/ws/sync.ts` enforces both at routing time.
 *
 * Casing: verb requests and replies are snake_case like the repo verbs; the status objects
 * (`WsIntegrationStatus`) are camelCase like every frame, and are the SAME shape wherever they
 * appear (welcome, `integrations-changed`, and the replies that echo the new state), so a client
 * has one reader for them.
 *
 * Every failure is `{ok:false, error, code}` with a `code` from `INTEGRATION_ERROR_CODES`. A client
 * must treat a code it does not know as the generic case (`parseIntegrationFailure` reads it as
 * null), so codes can be added without a protocol bump.
 *
 * Additive throughout: a daemon that predates this omits `welcome.integrations` and answers the
 * verbs as unknown commands; a client that predates it ignores the field and the frame.
 */

// ── vocabularies ────────────────────────────────────────────────────────────────────

/** The providers this daemon can link and search. Linear is reserved (`TICKET_PROVIDERS`). */
export const INTEGRATION_PROVIDERS = ['github'] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export function isIntegrationProvider(value: unknown): value is IntegrationProvider {
    return (INTEGRATION_PROVIDERS as readonly unknown[]).includes(value);
}

/**
 * Where a ticket a workspace remembers came from. Wider than `INTEGRATION_PROVIDERS` on purpose:
 * a stored ticket (`WorkspaceState.ticket`, persisted as JSON) names its provider in the record,
 * so Linear's spelling is reserved now and a database written by a later daemon still reads back.
 */
export const TICKET_PROVIDERS = ['github', 'linear'] as const;
export type TicketProvider = (typeof TICKET_PROVIDERS)[number];

/** A pull request or an issue. GitHub numbers both from one sequence per repository. */
export const TICKET_KINDS = ['pr', 'issue'] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];

/** `merged` only ever describes a pull request. */
export const TICKET_STATES = ['open', 'closed', 'merged'] as const;
export type TicketState = (typeof TICKET_STATES)[number];

/**
 * What a create from a ticket did with git, echoed as `checkout` (wire-protocol.md §6.3) and
 * proposed as `defaults.checkout` by `ticket-resolve`:
 *
 *   new-branch         a new worktree on a new branch (`-b`), off the fetched default branch when
 *                      update main is on: an issue's usual create
 *   pr-head            a new worktree on the pull request's head: a local branch that tracks it,
 *                      created from the fetched head or an existing one fast-forwarded to it
 *   attach-branch      a new worktree on a local branch that already existed and is not a pull
 *                      request's head (an issue created again after its branch was made)
 *   existing-checkout  no worktree: the workspace opens at a checkout that already exists (the
 *                      repository itself, or wherever the branch is already checked out)
 */
export const WORKSPACE_CHECKOUT_MODES = ['new-branch', 'pr-head', 'attach-branch', 'existing-checkout'] as const;
export type WorkspaceCheckoutMode = (typeof WORKSPACE_CHECKOUT_MODES)[number];

/**
 * Which default prompt a create rendered (`@kelpi/core/tickets`): `ticket-file` names the file
 * Kelpi writes into the checkout (`Read @.kelpi/ticket-418.md first, …`); `url-only` names only the
 * ticket's URL, and is what the daemon uses whenever it did not write that file. An agent is never
 * pointed at a file Kelpi did not write.
 */
export const TICKET_PROMPT_VARIANTS = ['ticket-file', 'url-only'] as const;
export type TicketPromptVariant = (typeof TICKET_PROMPT_VARIANTS)[number];

/** How a provider was linked: GitHub's device flow, or a pasted personal access token. */
export const INTEGRATION_AUTH_METHODS = ['oauth', 'token'] as const;
export type IntegrationAuthMethod = (typeof INTEGRATION_AUTH_METHODS)[number];

/**
 * A linked provider that cannot be used: `revoked` (GitHub answered 401 for the stored token, so
 * the user revoked it or it expired) or `unreadable` (the daemon could not read or parse
 * `integrations.json`, and refuses to guess: it fails closed until the next link replaces it).
 */
export const INTEGRATION_PROBLEMS = ['revoked', 'unreadable'] as const;
export type IntegrationProblem = (typeof INTEGRATION_PROBLEMS)[number];

/**
 * Why a device flow ended without a link: the code `expired`, the user `denied` it at GitHub,
 * device flow is `disabled` for the OAuth App, or any other `error` (the `message` says which).
 */
export const INTEGRATION_LINK_FAILURE_REASONS = ['expired', 'denied', 'disabled', 'error'] as const;
export type IntegrationLinkFailureReason = (typeof INTEGRATION_LINK_FAILURE_REASONS)[number];

/**
 * Every `code` an integration verb (or a `workspace-create` that named a `ticket`, as
 * `ticket_error`) fails with:
 *
 *   not-connected   no credential for the provider (or one with a `problem`)
 *   unauthorized    GitHub refused the credential (401); the status turns `revoked`; a pasted
 *                   token that does not authenticate
 *   rate-limited    the API's rate limit; `retry_after_s` says when to try again, when known
 *   sso-required    the organization enforces SAML SSO and this credential is not authorized for
 *                   it; `sso_url` (https://github.com/…) is where the user authorizes it
 *   org-restricted  the organization restricts OAuth App access and has not approved Kelpi;
 *                   `settings_url` (https://github.com/settings/connections/applications/…) is
 *                   where to request it, and a personal access token is the other way in
 *   not-found       no such issue or pull request, or one the credential cannot see
 *   unreachable     the network failed before GitHub answered
 *   timeout         GitHub did not answer in time
 *   github-error    GitHub answered with something else (5xx, an unexpected body)
 *   bad-ref         the ticket reference is not a GitHub issue or pull request URL or `owner/name#n`
 *   bad-request     the verb's request is malformed (a missing or unknown `provider`, …)
 *   forbidden       a management verb from a paired device or a plugin view
 *   unavailable     device flow is not offered (this build has no OAuth client ID, or GitHub says
 *                   device flow is disabled for it): link with a token instead
 *   missing-scope   a classic token without the `repo` scope
 */
export const INTEGRATION_ERROR_CODES = [
    'not-connected',
    'unauthorized',
    'rate-limited',
    'sso-required',
    'org-restricted',
    'not-found',
    'unreachable',
    'timeout',
    'github-error',
    'bad-ref',
    'bad-request',
    'forbidden',
    'unavailable',
    'missing-scope'
] as const;
export type IntegrationErrorCode = (typeof INTEGRATION_ERROR_CODES)[number];

export function isIntegrationErrorCode(value: unknown): value is IntegrationErrorCode {
    return (INTEGRATION_ERROR_CODES as readonly unknown[]).includes(value);
}

/**
 * The picker's sections: the three default `@me` lists an empty query returns, in this order,
 * and the one list a typed query returns.
 */
export const TICKET_SEARCH_SECTION_IDS = ['authored', 'review-requested', 'assigned', 'results'] as const;
export type TicketSearchSectionID = (typeof TICKET_SEARCH_SECTION_IDS)[number];

/** Why a workspace is listed as already open for a ticket: it was created from it, or it is on its branch. */
export const TICKET_EXISTING_REASONS = ['ticket', 'branch'] as const;
export type TicketExistingReason = (typeof TICKET_EXISTING_REASONS)[number];

// ── limits ──────────────────────────────────────────────────────────────────────────

/**
 * A `ticket-search` query longer than this is refused (`bad-request`). GitHub caps a whole search
 * at 256 characters, and the daemon adds its own qualifiers (`in:title is:open …` and the
 * `user:`/`org:` scope, `@kelpi/core/tickets`' `buildTicketSearchQueries`), so the text gets half.
 */
export const TICKET_SEARCH_QUERY_MAX_LENGTH = 128;
/** A ticket reference (`ticket-resolve`'s `ref`, `workspace-create`'s `ticket`) longer than this is a `bad-ref`. */
export const TICKET_REF_MAX_LENGTH = 2048;
/** A pasted token longer than this is not one (`bad-request`). */
export const INTEGRATION_TOKEN_MAX_LENGTH = 1024;

// ── verbs ───────────────────────────────────────────────────────────────────────────

export const INTEGRATIONS_STATUS_COMMAND = 'integrations-status';
export const INTEGRATION_LINK_START_COMMAND = 'integration-link-start';
export const INTEGRATION_LINK_CANCEL_COMMAND = 'integration-link-cancel';
export const INTEGRATION_LINK_TOKEN_COMMAND = 'integration-link-token';
export const INTEGRATION_UNLINK_COMMAND = 'integration-unlink';
export const TICKET_SEARCH_COMMAND = 'ticket-search';
export const TICKET_RESOLVE_COMMAND = 'ticket-resolve';

/** The whole family, matched before the wire decode (module note). */
export const INTEGRATION_COMMANDS = [
    INTEGRATIONS_STATUS_COMMAND,
    INTEGRATION_LINK_START_COMMAND,
    INTEGRATION_LINK_CANCEL_COMMAND,
    INTEGRATION_LINK_TOKEN_COMMAND,
    INTEGRATION_UNLINK_COMMAND,
    TICKET_SEARCH_COMMAND,
    TICKET_RESOLVE_COMMAND
] as const;
export type IntegrationCommand = (typeof INTEGRATION_COMMANDS)[number];

export function isIntegrationCommand(command: string): command is IntegrationCommand {
    return (INTEGRATION_COMMANDS as readonly string[]).includes(command);
}

/**
 * The verbs that change or reveal the credential: owner sessions only, never a paired device and
 * never a plugin-originated command. Never plugin-hookable either: a wildcard operation hook must
 * not see a token go past.
 */
export const INTEGRATION_MANAGEMENT_COMMANDS = [
    INTEGRATION_LINK_START_COMMAND,
    INTEGRATION_LINK_CANCEL_COMMAND,
    INTEGRATION_LINK_TOKEN_COMMAND,
    INTEGRATION_UNLINK_COMMAND
] as const;
export type IntegrationManagementCommand = (typeof INTEGRATION_MANAGEMENT_COMMANDS)[number];

export function isIntegrationManagementCommand(command: string): command is IntegrationManagementCommand {
    return (INTEGRATION_MANAGEMENT_COMMANDS as readonly string[]).includes(command);
}

export interface IntegrationsStatusRequest {
    readonly command: typeof INTEGRATIONS_STATUS_COMMAND;
}

export interface IntegrationLinkStartRequest {
    readonly command: typeof INTEGRATION_LINK_START_COMMAND;
    readonly provider: IntegrationProvider;
}

export interface IntegrationLinkCancelRequest {
    readonly command: typeof INTEGRATION_LINK_CANCEL_COMMAND;
    readonly provider: IntegrationProvider;
    /**
     * Cancel only this flow. A window that started a flow another window has since replaced
     * sends its own id, and its Cancel then leaves the newer flow alone (`cancelled: false`).
     */
    readonly flow_id?: string | undefined;
}

export interface IntegrationLinkTokenRequest {
    readonly command: typeof INTEGRATION_LINK_TOKEN_COMMAND;
    readonly provider: IntegrationProvider;
    /** Surrounding whitespace is trimmed by the decoder (a paste often brings a newline). */
    readonly token: string;
}

export interface IntegrationUnlinkRequest {
    readonly command: typeof INTEGRATION_UNLINK_COMMAND;
    readonly provider: IntegrationProvider;
}

export interface TicketSearchRequest {
    readonly command: typeof TICKET_SEARCH_COMMAND;
    readonly provider: IntegrationProvider;
    /** Trimmed; empty = the three default `@me` lists. */
    readonly query: string;
}

export interface TicketResolveRequest {
    readonly command: typeof TICKET_RESOLVE_COMMAND;
    /** A GitHub issue or pull request URL, or `owner/name#n` (`parseTicketRef`), trimmed. */
    readonly ref: string;
}

export type IntegrationRequest =
    | IntegrationsStatusRequest
    | IntegrationLinkStartRequest
    | IntegrationLinkCancelRequest
    | IntegrationLinkTokenRequest
    | IntegrationUnlinkRequest
    | TicketSearchRequest
    | TicketResolveRequest;

// ── status (welcome, frame, replies) ────────────────────────────────────────────────

/** A device flow the daemon is polling, or the way the last one ended. */
export type WsIntegrationLinking =
    | {
          readonly state: 'pending';
          /** The flow's id, as `integration-link-start` answered it. */
          readonly flowID: string;
          /** Epoch milliseconds, by the DAEMON's clock, when GitHub's code expires. */
          readonly expiresAt: number;
      }
    | {
          readonly state: 'failed';
          readonly flowID: string;
          readonly reason: IntegrationLinkFailureReason;
          /** Ready to show a user. */
          readonly message: string;
      };

/**
 * One provider's status. Never carries the credential, the device code or the user code.
 *
 * `available` is about the device flow only: false when this build has no OAuth client ID (or the
 * override is empty), so Settings offers only the token path. `connected` is true when a credential
 * is stored and has no `problem`. `login`, `how` and `scopes` describe the stored credential
 * (`scopes` is absent for a fine-grained token, which GitHub reports none for).
 */
export interface WsIntegrationStatus {
    readonly provider: IntegrationProvider;
    readonly available: boolean;
    readonly connected: boolean;
    readonly login?: string;
    readonly how?: IntegrationAuthMethod;
    readonly scopes?: readonly string[];
    readonly problem?: IntegrationProblem;
    readonly linking?: WsIntegrationLinking;
}

export const WS_INTEGRATIONS_CHANGED_MESSAGE = 'integrations-changed';

/**
 * Broadcast to every session whenever any provider's status changes: a link, an unlink, a flow
 * starting, failing or being replaced, a 401 turning a credential `revoked`. The whole list every
 * time, so the latest frame alone is the truth. `welcome.integrationsManageable` is per session and
 * does not ride here: it cannot change while a session is open.
 */
export interface WsIntegrationsChangedMessage {
    readonly type: typeof WS_INTEGRATIONS_CHANGED_MESSAGE;
    readonly integrations: readonly WsIntegrationStatus[];
}

// ── tickets ─────────────────────────────────────────────────────────────────────────

/**
 * One issue or pull request as the picker and the sheet show it. Every string is the daemon's
 * cleaned copy of untrusted text (control, bidi and zero-width characters stripped, one line).
 */
export interface TicketSummary {
    readonly provider: TicketProvider;
    readonly kind: TicketKind;
    /** `owner/name`, as GitHub spells it (compare case-insensitively). */
    readonly repo: string;
    readonly number: number;
    /** `#418`: what a workspace name and a prompt call it. */
    readonly key: string;
    readonly title: string;
    /** The ticket's page; always `https://github.com/…` for GitHub. */
    readonly url: string;
    readonly state: TicketState;
    /** A draft pull request. Absent = not a draft. */
    readonly draft?: true;
    /** The author's login; null for a deleted account. */
    readonly author: string | null;
    readonly labels: readonly string[];
    /** ISO 8601 UTC. */
    readonly updated_at: string;
    /**
     * The registered repository whose remotes point at `repo` (origin or upstream), or null when
     * none does: the picker dims such a row and says "Add owner/name in Settings ▸ Repositories".
     */
    readonly repo_id: string | null;
}

export interface TicketSearchSection {
    readonly id: TicketSearchSectionID;
    readonly items: readonly TicketSummary[];
}

/**
 * What a create from this ticket would do with every field it is not told (`ticket_defaults`),
 * computed by `@kelpi/core/tickets`' `ticketCreateDefaults` so the sheet's prefill and a CLI
 * create cannot disagree.
 */
export interface TicketResolveDefaults {
    /** `#418 Retry login on 401`. */
    readonly name: string;
    readonly repo_id: string | null;
    /** The worktree folder name; null when `checkout` is `existing-checkout`. */
    readonly worktree: string | null;
    /** The local branch; null when none can be used (a `warnings` entry says why). */
    readonly branch: string | null;
    readonly checkout: WorkspaceCheckoutMode;
    /** Issues on a new branch only; always false for a pull request or an attach. */
    readonly update_main: boolean;
    /** The rendered default prompt: one line, for the agent the sheet picks. */
    readonly prompt: string;
    readonly prompt_variant: TicketPromptVariant;
}

/** A workspace that already shows this ticket (`ticket`) or works on its branch (`branch`). */
export interface TicketExistingWorkspace {
    readonly workspace_id: string;
    readonly reason: TicketExistingReason;
}

// ── replies ─────────────────────────────────────────────────────────────────────────

export interface IntegrationsStatusReply {
    readonly ok: true;
    readonly integrations: readonly WsIntegrationStatus[];
    /** Whether THIS session may run the management verbs (an owner session). */
    readonly manageable: boolean;
}

/**
 * The only place the user code travels: to the session that started the flow. The daemon polls
 * GitHub itself, so the flow survives this window closing; its progress arrives as `linking` in
 * `integrations-changed`.
 */
export interface IntegrationLinkStartReply {
    readonly ok: true;
    readonly flow_id: string;
    /** What the user types at GitHub (`ABCD-1234`). */
    readonly user_code: string;
    /** Always `https://github.com/…` (`isGitHubWebURL`); a client opens nothing else. */
    readonly verification_uri: string;
    /** Seconds until the code expires. */
    readonly expires_in: number;
    /** Seconds between the daemon's polls. */
    readonly interval: number;
}

export interface IntegrationLinkCancelReply {
    readonly ok: true;
    /** False when there was no pending flow (or `flow_id` named one that was already replaced). */
    readonly cancelled: boolean;
}

export interface IntegrationLinkTokenReply {
    readonly ok: true;
    readonly integrations: readonly WsIntegrationStatus[];
    /** E.g. a fine-grained token, whose repository access GitHub does not report. */
    readonly warnings?: readonly string[];
}

export interface IntegrationUnlinkReply {
    readonly ok: true;
    readonly integrations: readonly WsIntegrationStatus[];
}

export interface TicketSearchReply {
    readonly ok: true;
    /** Empty query: `authored`, `review-requested`, `assigned`, in that order. Else one `results`. */
    readonly sections: readonly TicketSearchSection[];
    /** E.g. SAML SSO hid some organizations' results (`X-GitHub-SSO: partial-results`). */
    readonly warnings?: readonly string[];
}

export interface TicketResolveReply {
    readonly ok: true;
    readonly ticket: TicketSummary;
    readonly defaults: TicketResolveDefaults;
    /** Workspaces already open for it; the sheet offers to switch, and Create stays enabled. */
    readonly existing: readonly TicketExistingWorkspace[];
    /**
     * The checkout where the branch the defaults name is already checked out (so a new worktree
     * of it cannot be made); the defaults then propose `existing-checkout` at this path.
     */
    readonly checked_out_at?: string;
    /** E.g. a force-pushed head, a deleted fork, a head branch name git cannot use. */
    readonly warnings?: readonly string[];
}

export interface IntegrationFailure {
    readonly ok: false;
    readonly error: string;
    readonly code: IntegrationErrorCode;
    /** `rate-limited`: seconds until the limit resets, when GitHub said. */
    readonly retry_after_s?: number;
    /** `sso-required`: where to authorize the credential for the organization. */
    readonly sso_url?: string;
    /** `org-restricted`: where to request the organization's approval. */
    readonly settings_url?: string;
}

// ── readers ─────────────────────────────────────────────────────────────────────────

/** `decodeIntegrationRequest`'s answer: the request, or the `bad-request` failure to reply with. */
export type DecodedIntegrationRequest =
    | { readonly ok: true; readonly request: IntegrationRequest }
    | { readonly ok: false; readonly failure: IntegrationFailure };

const badRequest = (error: string): DecodedIntegrationRequest => ({ ok: false, failure: { ok: false, error, code: 'bad-request' } });

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Any C0 control, DEL or whitespace inside a token: not a token. */
const TOKEN_REJECT_PATTERN = /[\s\u0000-\u001f\u007f]/;

/**
 * A `command` payload of this family → the typed request, or the `bad-request` failure to answer
 * with. Shape only: whether a `ref` is a ticket reference is `parseTicketRef`'s call (`bad-ref`),
 * and whether a token authenticates is GitHub's. Unknown keys are ignored, as on the control socket.
 */
export function decodeIntegrationRequest(payload: Readonly<Record<string, unknown>>): DecodedIntegrationRequest {
    const command = payload['command'];
    if (typeof command !== 'string' || !isIntegrationCommand(command)) return badRequest(`unknown command: ${String(command)}`);
    if (command === INTEGRATIONS_STATUS_COMMAND) return { ok: true, request: { command } };
    if (command === TICKET_RESOLVE_COMMAND) {
        const ref = payload['ref'];
        if (typeof ref !== 'string' || ref.trim() === '') return badRequest(`${command} requires ref`);
        const trimmed = ref.trim();
        if (trimmed.length > TICKET_REF_MAX_LENGTH) return badRequest(`${command}: ref is too long`);
        return { ok: true, request: { command, ref: trimmed } };
    }
    const provider = payload['provider'];
    if (typeof provider !== 'string' || provider === '') return badRequest(`${command} requires provider`);
    if (!isIntegrationProvider(provider)) return badRequest(`unknown provider: ${provider}`);
    switch (command) {
        case INTEGRATION_LINK_START_COMMAND:
        case INTEGRATION_UNLINK_COMMAND:
            return { ok: true, request: { command, provider } };
        case INTEGRATION_LINK_CANCEL_COMMAND: {
            const flowID = payload['flow_id'];
            if (flowID !== undefined && flowID !== null && typeof flowID !== 'string') {
                return badRequest(`${command}: flow_id must be a string`);
            }
            return {
                ok: true,
                request: { command, provider, ...(typeof flowID === 'string' && flowID !== '' ? { flow_id: flowID } : {}) }
            };
        }
        case INTEGRATION_LINK_TOKEN_COMMAND: {
            const token = payload['token'];
            if (typeof token !== 'string' || token.trim() === '') return badRequest(`${command} requires token`);
            const trimmed = token.trim();
            if (trimmed.length > INTEGRATION_TOKEN_MAX_LENGTH || TOKEN_REJECT_PATTERN.test(trimmed)) {
                return badRequest('that does not look like a GitHub token');
            }
            return { ok: true, request: { command, provider, token: trimmed } };
        }
        case TICKET_SEARCH_COMMAND: {
            const query = payload['query'];
            if (query !== undefined && query !== null && typeof query !== 'string') {
                return badRequest(`${command}: query must be a string`);
            }
            const trimmed = typeof query === 'string' ? query.trim() : '';
            if (trimmed.length > TICKET_SEARCH_QUERY_MAX_LENGTH) {
                return badRequest(`${command}: query is too long (the limit is ${TICKET_SEARCH_QUERY_MAX_LENGTH} characters)`);
            }
            return { ok: true, request: { command, provider, query: trimmed } };
        }
    }
}

/**
 * `https://github.com/…` and nothing else: no other scheme, host, port or credentials. Every URL a
 * client opens on the daemon's word (the device flow's verification page, an SSO or settings link,
 * a ticket's page) passes this first, so a compromised or confused relay cannot send a window to
 * an arbitrary site.
 */
export function isGitHubWebURL(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > TICKET_REF_MAX_LENGTH) return false;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return false;
    }
    return (
        url.protocol === 'https:' &&
        url.hostname === 'github.com' &&
        url.port === '' &&
        url.username === '' &&
        url.password === '' &&
        // `new URL` lowercases the host, so the raw text has to agree that it was GitHub's.
        /^https:\/\/github\.com(?:[/?#]|$)/i.test(value)
    );
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
    return (values as readonly unknown[]).includes(value) ? (value as T) : undefined;
}

function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value !== '' ? value : undefined;
}

function normalizeLinking(raw: unknown): WsIntegrationLinking | undefined {
    if (!isRecord(raw)) return undefined;
    const flowID = nonEmptyString(raw['flowID']);
    if (flowID === undefined) return undefined;
    if (raw['state'] === 'pending') {
        const expiresAt = raw['expiresAt'];
        if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return undefined;
        return { state: 'pending', flowID, expiresAt };
    }
    if (raw['state'] === 'failed') {
        const reason = oneOf(INTEGRATION_LINK_FAILURE_REASONS, raw['reason']) ?? 'error';
        const message = typeof raw['message'] === 'string' ? raw['message'] : '';
        return { state: 'failed', flowID, reason, message };
    }
    return undefined;
}

/**
 * One status object, validated, or null when it is not one (no provider this client knows, or
 * the two booleans missing). Unknown fields are dropped, so nothing a later daemon adds rides
 * through unread; a `linking` that does not parse is dropped on its own.
 */
export function normalizeIntegrationStatus(raw: unknown): WsIntegrationStatus | null {
    if (!isRecord(raw)) return null;
    const provider = oneOf(INTEGRATION_PROVIDERS, raw['provider']);
    if (provider === undefined) return null;
    if (typeof raw['available'] !== 'boolean' || typeof raw['connected'] !== 'boolean') return null;
    const login = nonEmptyString(raw['login']);
    const how = oneOf(INTEGRATION_AUTH_METHODS, raw['how']);
    const problem = oneOf(INTEGRATION_PROBLEMS, raw['problem']);
    const linking = normalizeLinking(raw['linking']);
    return {
        provider,
        available: raw['available'],
        connected: raw['connected'],
        ...(login === undefined ? {} : { login }),
        ...(how === undefined ? {} : { how }),
        ...(Array.isArray(raw['scopes']) ? { scopes: stringList(raw['scopes']) } : {}),
        ...(problem === undefined ? {} : { problem }),
        ...(linking === undefined ? {} : { linking })
    };
}

/** A status list (welcome, frame, reply): entries that do not parse are dropped; not a list → `[]`. */
export function normalizeIntegrationStatuses(raw: unknown): WsIntegrationStatus[] {
    if (!Array.isArray(raw)) return [];
    const statuses: WsIntegrationStatus[] = [];
    for (const entry of raw) {
        const status = normalizeIntegrationStatus(entry);
        if (status !== null) statuses.push(status);
    }
    return statuses;
}

/** An `integrations-changed` frame's list, or null when the message is not one. */
export function parseIntegrationsChanged(message: Readonly<Record<string, unknown>>): WsIntegrationStatus[] | null {
    if (message['type'] !== WS_INTEGRATIONS_CHANGED_MESSAGE || !Array.isArray(message['integrations'])) return null;
    return normalizeIntegrationStatuses(message['integrations']);
}

/**
 * One ticket row, validated, or null. A GitHub row whose `url` is not `https://github.com/…` is
 * refused whole: the picker opens that link.
 */
export function normalizeTicketSummary(raw: unknown): TicketSummary | null {
    if (!isRecord(raw)) return null;
    const provider = oneOf(TICKET_PROVIDERS, raw['provider']);
    const kind = oneOf(TICKET_KINDS, raw['kind']);
    const state = oneOf(TICKET_STATES, raw['state']);
    const repo = nonEmptyString(raw['repo']);
    const key = nonEmptyString(raw['key']);
    const number = raw['number'];
    const url = raw['url'];
    const author = raw['author'];
    const repoID = raw['repo_id'];
    if (provider === undefined || kind === undefined || state === undefined || repo === undefined || key === undefined) return null;
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) return null;
    if (typeof url !== 'string' || (provider === 'github' && !isGitHubWebURL(url))) return null;
    return {
        provider,
        kind,
        repo,
        number,
        key,
        title: typeof raw['title'] === 'string' ? raw['title'] : '',
        url,
        state,
        ...(raw['draft'] === true ? { draft: true as const } : {}),
        author: typeof author === 'string' && author !== '' ? author : null,
        labels: stringList(raw['labels']),
        updated_at: typeof raw['updated_at'] === 'string' ? raw['updated_at'] : '',
        repo_id: typeof repoID === 'string' && repoID !== '' ? repoID : null
    };
}

function warningsOf(raw: Readonly<Record<string, unknown>>): { readonly warnings?: readonly string[] } {
    const warnings = stringList(raw['warnings']).filter((warning) => warning !== '');
    return warnings.length === 0 ? {} : { warnings };
}

/** An `integrations-status` success, validated, or null. */
export function parseIntegrationsStatusReply(raw: unknown): IntegrationsStatusReply | null {
    if (!isRecord(raw) || raw['ok'] !== true || !Array.isArray(raw['integrations'])) return null;
    return { ok: true, integrations: normalizeIntegrationStatuses(raw['integrations']), manageable: raw['manageable'] === true };
}

/** An `integration-link-start` success, validated (the verification page must be GitHub's), or null. */
export function parseIntegrationLinkStartReply(raw: unknown): IntegrationLinkStartReply | null {
    if (!isRecord(raw) || raw['ok'] !== true) return null;
    const flowID = nonEmptyString(raw['flow_id']);
    const userCode = nonEmptyString(raw['user_code']);
    const expiresIn = raw['expires_in'];
    const interval = raw['interval'];
    if (flowID === undefined || userCode === undefined || !isGitHubWebURL(raw['verification_uri'])) return null;
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) return null;
    if (typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0) return null;
    return { ok: true, flow_id: flowID, user_code: userCode, verification_uri: raw['verification_uri'], expires_in: expiresIn, interval };
}

/** A `ticket-search` success, validated, or null. Unknown sections and unparseable rows are dropped. */
export function parseTicketSearchReply(raw: unknown): TicketSearchReply | null {
    if (!isRecord(raw) || raw['ok'] !== true || !Array.isArray(raw['sections'])) return null;
    const sections: TicketSearchSection[] = [];
    for (const entry of raw['sections'] as unknown[]) {
        if (!isRecord(entry)) continue;
        const id = oneOf(TICKET_SEARCH_SECTION_IDS, entry['id']);
        if (id === undefined) continue;
        const items: TicketSummary[] = [];
        for (const item of Array.isArray(entry['items']) ? (entry['items'] as unknown[]) : []) {
            const summary = normalizeTicketSummary(item);
            if (summary !== null) items.push(summary);
        }
        sections.push({ id, items });
    }
    return { ok: true, sections, ...warningsOf(raw) };
}

function normalizeDefaults(raw: unknown): TicketResolveDefaults | null {
    if (!isRecord(raw)) return null;
    const name = nonEmptyString(raw['name']);
    const checkout = oneOf(WORKSPACE_CHECKOUT_MODES, raw['checkout']);
    const promptVariant = oneOf(TICKET_PROMPT_VARIANTS, raw['prompt_variant']);
    if (name === undefined || checkout === undefined || promptVariant === undefined) return null;
    const text = (key: string): string | null => {
        const value = raw[key];
        return typeof value === 'string' && value !== '' ? value : null;
    };
    return {
        name,
        repo_id: text('repo_id'),
        worktree: text('worktree'),
        branch: text('branch'),
        checkout,
        update_main: raw['update_main'] === true,
        prompt: typeof raw['prompt'] === 'string' ? raw['prompt'] : '',
        prompt_variant: promptVariant
    };
}

/** A `ticket-resolve` success, validated, or null when the ticket or its defaults do not parse. */
export function parseTicketResolveReply(raw: unknown): TicketResolveReply | null {
    if (!isRecord(raw) || raw['ok'] !== true) return null;
    const ticket = normalizeTicketSummary(raw['ticket']);
    const defaults = normalizeDefaults(raw['defaults']);
    if (ticket === null || defaults === null) return null;
    const existing: TicketExistingWorkspace[] = [];
    for (const entry of Array.isArray(raw['existing']) ? (raw['existing'] as unknown[]) : []) {
        if (!isRecord(entry)) continue;
        const workspaceID = nonEmptyString(entry['workspace_id']);
        const reason = oneOf(TICKET_EXISTING_REASONS, entry['reason']);
        if (workspaceID !== undefined && reason !== undefined) existing.push({ workspace_id: workspaceID, reason });
    }
    const checkedOutAt = nonEmptyString(raw['checked_out_at']);
    return {
        ok: true,
        ticket,
        defaults,
        existing,
        ...(checkedOutAt === undefined ? {} : { checked_out_at: checkedOutAt }),
        ...warningsOf(raw)
    };
}

/** A failure as a client reads it: `code` null for one this client does not know. */
export interface IntegrationFailureInfo {
    readonly error: string;
    readonly code: IntegrationErrorCode | null;
    readonly retry_after_s?: number;
    /** Present only when it is a `https://github.com/…` URL. */
    readonly sso_url?: string;
    /** Present only when it is a `https://github.com/…` URL. */
    readonly settings_url?: string;
}

/**
 * Any `{ok:false}` reply of this family (or a `workspace-create` failure, whose `ticket_error`
 * names the same codes), or null for a success. The two links are dropped unless they are
 * GitHub's own pages.
 */
export function parseIntegrationFailure(raw: unknown): IntegrationFailureInfo | null {
    if (!isRecord(raw) || raw['ok'] !== false) return null;
    const code = raw['code'] ?? raw['ticket_error'];
    const retryAfter = raw['retry_after_s'];
    return {
        error: typeof raw['error'] === 'string' && raw['error'] !== '' ? raw['error'] : 'request failed',
        code: isIntegrationErrorCode(code) ? code : null,
        ...(typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0 ? { retry_after_s: retryAfter } : {}),
        ...(isGitHubWebURL(raw['sso_url']) ? { sso_url: raw['sso_url'] } : {}),
        ...(isGitHubWebURL(raw['settings_url']) ? { settings_url: raw['settings_url'] } : {})
    };
}
