# Integrations: GitHub tickets to workspaces

A workspace can start from a GitHub issue or pull request: its name, its repository, a worktree on
the right branch, a file with the ticket's text for the agent, and the agent's first prompt all
come from the ticket. This document is the contract for that feature: the WS verbs and frames a
client uses, the pure rules in `@kelpi/core/tickets` that decide names, prompts and searches, and
the daemon seam the create flow resolves tickets through. The `workspace-create` half is
[wire-protocol.md §6.3](wire-protocol.md#workspace-create-rr) (`ticket`, `ticket_defaults`).

Where things live:

| what | where |
|---|---|
| verbs, frame, status and reply shapes, readers | `packages/protocol/src/ws/integrations.ts` |
| references, names, untrusted text, prompts, ticket file, search, defaults | `packages/core/src/tickets/` (`@kelpi/core/tickets`, pure, browser-safe) |
| the create flow's seam (`TicketService`, `ResolvedTicket`) | `packages/daemon/src/handlers/app/context.ts` |
| what a workspace remembers (`WorkspaceState.ticket`) | `packages/daemon/src/store/types.ts`, persisted as `workspace.ticketJSON` ([persistence.md](persistence.md) §2.1) |
| the service (credential store, GitHub API, device flow, search, resolve) | `packages/daemon/src/integrations/` (§9) |
| read-only git facts a resolve needs (every remote, branch config, worktrees) | `packages/daemon/src/git/repo-facts.ts` (§9.6) |
| the verbs' routing and who may call them | `packages/daemon/src/ws/integrations.ts`, `packages/daemon/src/ws/sync.ts` (§9.7) |

## 1. Status

The daemon owns the credential. Nothing a client receives carries it: not the status, not a
frame, not a reply, not the snapshot. A client learns each provider's state from `welcome` and
from the `integrations-changed` broadcast, both carrying the whole list of `WsIntegrationStatus`:

```ts
interface WsIntegrationStatus {
  provider: 'github';
  available: boolean;     // the device flow is offered (this build has an OAuth client ID)
  connected: boolean;     // a credential is stored and has no problem
  login?: string;
  how?: 'oauth' | 'token';
  scopes?: string[];      // absent for a fine-grained token
  problem?: 'revoked' | 'unreadable' | 'endpoint-mismatch';
  linking?: { state: 'pending'; flowID: string; expiresAt: number }   // epoch ms, daemon clock
          | { state: 'failed'; flowID: string; reason: 'expired' | 'denied' | 'disabled' | 'error'; message: string };
}
```

`welcome.integrations` rides beside `settings` for the same reason: it is not domain state and a
delta replay must never touch it. `welcome.integrationsManageable` says whether THIS session may
run the management verbs (§2); it is per session, so it never rides the broadcast. A daemon that
predates integrations omits both, and a client reads that as "nothing can be linked here" (no
Integrations tab, no From ticket).

Status objects are camelCase like every frame, and the same shape wherever they appear, replies
included. `normalizeIntegrationStatus` / `normalizeIntegrationStatuses` /
`parseIntegrationsChanged` read them, dropping fields they do not know.

## 2. Verbs

Seven WS-only verbs, matched before the wire decode like the remote and repo families: a CLI verb
would be a compatibility surface owed forever, and the CLI reaches tickets through one
`workspace-create` field instead. Requests and replies are snake_case. `decodeIntegrationRequest`
reads a request and answers `bad-request` for a malformed one.

| verb | who | request | reply |
|---|---|---|---|
| `integrations-status` | any session | (none) | `{ok, integrations, manageable}` |
| `integration-link-start` | owner | `{provider}` | `{ok, flow_id, user_code, verification_uri, expires_in, interval}` |
| `integration-link-cancel` | owner | `{provider, flow_id?}` | `{ok, cancelled}` |
| `integration-link-token` | owner | `{provider, token}` | `{ok, integrations, warnings?}` |
| `integration-unlink` | owner | `{provider}` | `{ok, integrations}` |
| `ticket-search` | any session | `{provider, query}` | `{ok, sections: [{id, items}], warnings?}` |
| `ticket-resolve` | any session | `{ref}` | `{ok, ticket, defaults, existing, checked_out_at?, warnings?}` |

- `integration-link-start` begins GitHub's device flow. Its reply is the ONLY place the user code
  and the verification page travel, to the session that asked; GitHub's `device_code` never
  leaves daemon memory. The daemon polls GitHub itself, so the flow survives the window closing,
  and its progress reaches every session as `linking` in `integrations-changed`. A second start
  replaces the first (the first window sees the new `flowID` and resets); `integration-link-cancel`
  with a `flow_id` cancels only that flow, so a stale window cannot cancel a newer one.
  `verification_uri` is always `https://github.com/…` (`isGitHubWebURL`); a client opens nothing
  else, and opens it from a user gesture.
- `integration-link-token` links a personal access token (surrounding whitespace trimmed). A
  classic token without the `repo` scope is refused (`missing-scope`); a fine-grained token, whose
  repository access GitHub does not report, is accepted with a `warnings` entry.
- `integration-unlink` forgets the credential. It cannot revoke the grant on GitHub (that needs the
  client secret, which a shipped app does not hold), so a client links to
  `https://github.com/settings/applications` for that.
- `ticket-search` answers an empty `query` with three sections, `authored`, `review-requested`,
  `assigned`, in that order, and typed text with one `results` section (§6). `query` is at most
  128 characters (`TICKET_SEARCH_QUERY_MAX_LENGTH`).
- `ticket-resolve` answers one ticket (`TicketSummary`), the defaults a create from it would use
  (`TicketResolveDefaults`, §7), the workspaces already open for it (`existing`: `{workspace_id,
  reason: 'ticket' | 'branch'}`), and `checked_out_at` when the default branch is already checked
  out somewhere. A `ref` that `parseTicketRef` refuses is `bad-ref`.

```ts
interface TicketSummary {
  provider: 'github'; kind: 'pr' | 'issue';
  repo: string;            // owner/name
  number: number; key: string;   // 418, "#418"
  title: string; url: string;    // url is always https://github.com/…
  state: 'open' | 'closed' | 'merged'; draft?: true;
  author: string | null; labels: string[];
  updated_at: string;      // ISO 8601 UTC
  repo_id: string | null;  // the registered repository it belongs to, or null
}

interface TicketResolveDefaults {
  name: string; repo_id: string | null;
  worktree: string | null; branch: string | null;
  checkout: 'new-branch' | 'pr-head' | 'attach-branch' | 'existing-checkout';
  update_main: boolean;
  prompt: string; prompt_variant: 'ticket-file' | 'url-only';
}
```

A row whose `repo_id` is null belongs to no registered repository: the picker shows it dimmed and
not pickable, with "Add owner/name in Settings ▸ Repositories".

### 2.1 Who may call what

The four management verbs (`INTEGRATION_MANAGEMENT_COMMANDS`) are owner-only: a session that
authenticated with a paired-device token (`kd_…`) is refused, and so is a command a plugin view
sends through `executeCommand` (plugin backends run without a credential and would otherwise count
as the owner). Both refusals answer `forbidden`. The management verbs are also never
plugin-hookable: a wildcard operation hook must never see a token go past.

`integrations-status`, `ticket-search` and `ticket-resolve` are open to every session, plugins
included. A paired device can already create workspaces, and it reads the owner's issues and pull
requests through the daemon either way; Settings ▸ Integrations says so in words.

### 2.2 Errors

Every failure is `{ok:false, error, code}`, and a `workspace-create` that failed because of its
ticket carries the same code as `ticket_error` (wire-protocol.md §6.3). `parseIntegrationFailure`
reads either form; a client treats a code it does not know as the generic case.

| code | meaning | extras |
|---|---|---|
| `not-connected` | no usable credential for the provider | |
| `unauthorized` | GitHub refused the credential (401); the status turns `revoked`. Also a pasted token that does not authenticate | |
| `rate-limited` | the API's rate limit | `retry_after_s` when known |
| `sso-required` | the organization enforces SAML SSO and this credential is not authorized for it | `sso_url` (https://github.com/…) |
| `org-restricted` | the organization restricts OAuth Apps and has not approved Kelpi; a personal access token is the other way in | `settings_url` (https://github.com/settings/connections/applications/…) |
| `not-found` | no such ticket, or one the credential cannot see | |
| `unreachable` | the network failed before GitHub answered | |
| `timeout` | GitHub did not answer in time | |
| `github-error` | GitHub answered with something else | |
| `bad-ref` | not a GitHub issue or pull request reference | |
| `bad-request` | a malformed verb request (a missing or unknown `provider`, …) | |
| `forbidden` | a management verb from a paired device or a plugin view | |
| `unavailable` | the device flow is not offered (no OAuth client ID, or GitHub has it disabled for the app); link a token instead. Also: the daemon is stopping, Kelpi could not write its credential file, or the session that asked went away | |
| `missing-scope` | a classic token without the `repo` scope | |

`sso_url` and `settings_url` are dropped by the reader unless they are GitHub's own pages.

## 3. References

`parseTicketRef` (`packages/core/src/tickets/refs.ts`) reads what a user pastes:
`https://github.com/<owner>/<name>/pull/<n>` (optionally `/files`, `/commits`, `/checks`,
`/changes` and anything after them) and `/issues/<n>`, with or without the scheme, `http` or
`https`, `github.com` or `www.github.com`, with a fragment, a query or a trailing slash; and the
short form `<owner>/<name>#<n>`, whose kind only the API can answer (GitHub numbers issues and pull
requests from one sequence). A URL with credentials or a port is refused.

`parseGitHubRemote` reads a registered repository's remote: scp-like `git@github.com:o/r(.git)`,
`ssh://` (port allowed, `ssh.github.com` included), `https://[user[:token]@]github.com/o/r(.git)`,
and SSH host aliases `github.com-<anything>`. `replaceGitHubRemoteRepo` swaps only `owner/name`
inside such a URL, so a fork's push URL authenticates exactly as the base remote does.

Owners and repository names are checked against GitHub's character sets before anything is
returned (`isGitHubOwner`: letters, digits, `-`, `_`, at most 39, not starting with `-`;
`isGitHubRepoName`: letters, digits, `.`, `_`, `-`, at most 100, not `.`, `..` or starting with
`-`): they end up in fetch URLs, refspecs, branch and folder names.

`ticketIdentity` gives one string per ticket (`github:acme/api#418`, the repository lowercased),
for "is this ticket already open" and the resolve cache.

## 4. Names

One function decides each name (`packages/core/src/tickets/names.ts`), and both the resolve and
the create call it:

| what | issue | pull request |
|---|---|---|
| workspace name | `#418 Retry login on 401` (`ticketWorkspaceName`) | the same |
| branch | `418-retry-login-on-401` (`issueBranchName`): the title in ASCII lowercase, at most 40 characters cut at a `-`; `418` alone for a title with nothing ASCII in it | the head branch's own name, unrewritten (`prLocalBranchName`) |
| worktree folder | the branch | the local branch with `/` as `-` (`prWorktreeName`) |

`prLocalBranchName` is the one place a pull request's local branch is chosen. Candidates, in
order: the head's own name; `<head owner>/<head>` (skipped when the fork was deleted); `pr-<n>`. A
candidate is taken when it is the base repository's default branch (a fork's `main` must not check
out as ours) or an existing local branch that does not track this pull request. The head name must
pass `isSafeBranchName` (git's `check-ref-format --branch` rules, judged strictly, plus: never
starting with `-`, never holding an invisible or bidi character); the daemon also runs git's own
check before using it.

## 5. Untrusted text

Anyone who can open an issue writes the title, labels, body and comments, so they are treated like
bytes from a remote host (`packages/core/src/tickets/text.ts`):

- everywhere: C0 controls other than TAB and LF, DEL, the C1 block, soft hyphen, bidi embeddings,
  overrides and isolates, zero-width characters and BOM, variation selectors and the Unicode tag
  block (which can spell ASCII a model reads and a person never sees) are dropped
  (`cleanUntrustedText`);
- a one-line field becomes one line of single spaces, capped with an ellipsis (`untrustedLine`;
  titles at 200 UTF-16 units);
- in a one-line field that reaches a prompt, `@` becomes `＠` (U+FF20, `neutralizeMentions`):
  Claude Code and Codex read `@<path>` as "attach this file", so a title such as
  `Fix @~/.aws/credentials` would otherwise attach the user's credentials.

## 6. Search

`buildTicketSearchQueries` (`packages/core/src/tickets/search.ts`) returns query strings that the
daemon passes as GraphQL VARIABLES (`search(query: $q, …)`), never spliced into the document.

- An empty query: three lists that are personal by construction, so unscoped:
  `is:open is:pr author:@me`, `is:open is:pr review-requested:@me`,
  `is:open is:issue assignee:@me`, each with `archived:false sort:updated-desc`.
- Typed text: `<text> in:title is:open archived:false sort:updated-desc`, scoped by one `user:` or
  `org:` qualifier per distinct owner of a registered repository's GitHub remote
  (`gitHubOwnersFromRemotes`; the service decides which kind each owner is). With no such owner,
  `involves:@me`. Qualifiers are added while the query fits GitHub's 256 characters; any left out
  are reported (`omittedOwners`).

## 7. Defaults, the prompt and the ticket file

`ticketCreateDefaults` (`packages/core/src/tickets/defaults.ts`) is what a create does with every
field it is not told, and what `ticket-resolve` proposes:

| ticket | checkout | worktree | update main |
|---|---|---|---|
| issue, branch new | `new-branch` | `418-<slug>` | on |
| issue, branch already made | `attach-branch` | `418-<slug>` | off |
| pull request | `pr-head` | `prWorktreeName` | off |
| branch already checked out somewhere | `existing-checkout` (opens at `checked_out_at`) | none | off |

A create that names another `branch` or `update_main: true` (the CLI sends both with `--from` even
without `--worktree`) never takes the `existing-checkout` row: it gets a worktree, under that row's
own rules (socket-handlers.md §6.2).

The prompt is rendered by the daemon, never the client (`packages/core/src/tickets/template.ts`):

- issue: `Work on issue {{key}}: {{title}} ({{url}}). Read @{{ticketFile}} first, it has the full issue.`
- pull request: `Pick up pull request {{key}}: {{title}} ({{url}}) on branch {{branch}}. Read @{{ticketFile}} first, it has the description and recent review comments.`

Each has a `url-only` variant that names only the URL, used whenever Kelpi did not write the ticket
file; a prompt the user edited has every mention of the file replaced by the URL instead
(`withoutTicketFileReference`). An agent is never pointed at a file Kelpi did not write. Every
default is one line, under 800 characters at the longest inputs, starts with a word (never `/`),
and has a space after its one mention (Codex opens a picker on a trailing `@path`). There is no
`body` variable: the body goes only into the ticket file. `renderTemplate` fills `{{name}}` in one
pass (a value is never expanded again), renders an unknown name empty and reports it.

The ticket file is `<checkout>/.kelpi/ticket-<number>.md` beside a `.kelpi/.gitignore` of `*`
(`renderTicketFile`, `packages/core/src/tickets/ticket-file.ts`): title, URL, repository, state,
author, labels, a pull request's base and head, the body (at most 64 KB), the 10 most recent
comments and the first 10 unresolved review comments (8 KB each), all cleaned, with a note at the
top and the footer `Written by Kelpi from GitHub; untrusted content.`

## 8. The create flow

`workspace-create` with `ticket` (wire-protocol.md §6.3), once the `icon` and `parent` checks
every create makes have passed, parses the reference, asks the
`TicketService` seam (`packages/daemon/src/handlers/app/context.ts`) whether the provider is
connected, and resolves it (`resolve(ref, signal)` → `ResolvedTicket`: the summary, a pull
request's head facts, the matched repository and remote, the defaults, the existing workspaces,
the ticket file's content and warnings), all before any effect; then it checks out (a pull
request's head with its own request type, never the plugin `git.worktreeAdd` contract), writes the
ticket file, creates the workspace with `ticket` stored (and its icon, its parent and, only with
`focus`, as the active workspace, like any create), and starts the agent. A handler table
built without a service gets `INERT_TICKET_SERVICE`, which is never connected. A
`TicketServiceError` carries the code of §2.2: `integrationFailure` turns it into a verb's
`{ok:false, error, code, …}`, `ticketCreateFailure` into a create's `{ok:false, error,
ticket_error, …}`, and `workspaceTicketOf` (`packages/daemon/src/store/ticket.ts`) picks the seven
fields a workspace keeps out of a `TicketSummary`.

The checkout and ticket-file rules are [graft-git.md](graft-git.md) §8.5's.

## 9. The service

The integrations service (`packages/daemon/src/integrations/`) owns the credential and everything
done with it. `boot/compose.ts` builds ONE instance and hands it to two callers: the create flow
gets it as `tickets` (the `TicketService` seam, §8), and the sync hub gets it as its
`IntegrationsChannel` (§9.7). So a create from the New Workspace sheet reuses the resolve the
sheet just made instead of asking GitHub again.

| file | what it does |
|---|---|
| `config.ts` | where the credential lives and which GitHub to talk to (§9.1) |
| `store.ts` | `integrations.json` (§9.1) |
| `http.ts` | every request: headers, the timeout, the meaning of every failure (§9.2) |
| `device-flow.ts` | GitHub's device flow, polled by the daemon (§9.3) |
| `github.ts` | the GraphQL documents and REST calls, and their parsing (§9.4, §9.5) |
| `matching.ts` | which registered repository a ticket belongs to, and what its branches say (§9.6) |
| `service.ts` | the service: status, linking, search, resolve, caches, the change feed |

### 9.1 Configuration and the credential store

Read once at boot from the daemon's environment:

| variable | meaning | default |
|---|---|---|
| `KELPID_INTEGRATIONS_PATH` | the credential file | `<dirname(dbPath)>/integrations.json`; memory only for a `:memory:` database |
| `KELPI_GITHUB_CLIENT_ID` | the OAuth App's client ID; overrides the build constant; empty turns the device flow off (`available: false`) | the build constant `GITHUB_OAUTH_CLIENT_ID`, empty until the app is registered |
| `KELPI_GITHUB_API_URL` | the REST and GraphQL base | `https://api.github.com` |
| `KELPI_GITHUB_WEB_URL` | the device flow's base (`/login/device/code`, `/login/oauth/access_token`) | `https://github.com` |

The two URL overrides exist for tests and end-to-end scenarios against a fake GitHub. A link
sends the new credential to whatever they name, so an override must be `https://`, or `http://`
to a loopback host (`127.0.0.1`, `localhost`, `::1`); anything else is ignored, and the daemon
logs which overrides are in effect. A STORED credential is bound to the endpoints it was linked
against: `integrations.json` keeps them with the account (`endpoints`), and a daemon whose
endpoints differ (an override inherited from the environment it was started in, or one dropped)
never sends it: the status says `problem: 'endpoint-mismatch'`, `connected` is false, every
search and resolve is `not-connected` (`The saved GitHub credential was linked for <api>, and
this daemon uses <api>, so Kelpi will not send it: …`), no request is made, and the daemon logs
both bases once at boot. A link made under the current endpoints replaces it (and is bound to
them); a daemon started with the original endpoints uses it again. Links a client opens are NOT rebased onto the web override: the
verification page, a ticket's URL and an SSO or settings link must stay `https://github.com/…`
(`isGitHubWebURL`), so a fake GitHub returns GitHub's own spelling for them. A client ID that is
not `[A-Za-z0-9._-]{1,64}` is ignored (the device flow is then off).

`integrations.json` ([persistence.md](persistence.md) §7.4) is modelled on the paired-device
registry (`lifecycle/devices.ts`), with the differences a secret that must be USED forces:

- the daemon is its only writer, and every write is synchronous, so writes are serialised;
- the directory is created 0700 and the file 0600: a write goes to a temp file opened `wx` at
  0600 and `fchmod`ed past the umask, is fsynced, renamed over the file, and the directory is
  fsynced. A file found wider than 0600 is narrowed back when read;
- a file that cannot be read or parsed, that has an account it cannot trust whole, or that a
  newer daemon wrote (`v` above 1) FAILS CLOSED: the status says `problem: 'unreadable'`, nothing
  is connected and nothing is sent anywhere. The file is left alone until the next link (or
  unlink), which renames it `integrations.json.unreadable-<epoch ms>` (still 0600) and writes a
  fresh one;
- a 401 for the stored credential is persisted as `problem: 'revoked'`;
- an account of a provider this daemon does not know (a later daemon's Linear link) is kept
  verbatim across rewrites.

Shape, version 1:

```json
{ "v": 1, "accounts": [ { "provider": "github", "host": "github.com", "login": "octocat",
    "how": "oauth", "scopes": ["repo"], "createdAt": "2026-10-07T00:00:00.000Z",
    "endpoints": { "api": "https://api.github.com", "web": "https://github.com" },
    "credential": { "accessToken": "…", "tokenType": "bearer", "expiresAt": null,
                    "refreshToken": null, "refreshTokenExpiresAt": null } } ] }
```

`scopes` is absent for a fine-grained token; `problem` is absent or `"revoked"`. `endpoints` are
the API and web bases the credential was linked against (above); an account written before the
field existed reads as linked against the defaults, and a value that is not a base an override
could name (`https://`, or `http://` to loopback, no trailing slash) makes the file unreadable. The three
refresh fields are RESERVED: GitHub OAuth App tokens do not expire, so phase 2 has no refresher
and writes them as null. A provider whose tokens expire (Linear) adds a single-flight refresher
that persists the new pair before using it; a file with the fields set already reads back.

### 9.2 HTTP

Every request goes through one client (`http.ts`), with `fetch` injected (Node's global by
default; tests pass a fake that returns `Response`s, so no test reaches the network):

- bounded: `AbortSignal.any([caller, AbortSignal.timeout(10 s)])`. The caller's abort rejects
  with the caller's own reason (a cancelled create); the timeout is `timeout`; anything else
  the network throws is `unreachable` (naming at most the error code, `ENOTFOUND`);
- headers: `User-Agent: Kelpi/<version>`; to the API `Accept: application/vnd.github+json`,
  `X-GitHub-Api-Version: 2022-11-28` and `Authorization: Bearer <token>`; to `github.com/login/*`
  `Accept: application/json` (without it GitHub answers form-encoded) and no credential;
- redirects are refused, so the `Authorization` header never follows one;
- a failure is a `TicketServiceError` whose message is ready to show and never carries a
  header, the token or a URL. Its log line names the method, the path, the status and
  `x-github-request-id`, nothing else.

| GitHub answered | code |
|---|---|
| 401 | `unauthorized`; for the stored credential the service also marks it `revoked`, drops its caches and broadcasts |
| 403 or 429 with `x-ratelimit-remaining: 0`, `retry-after`, or a rate-limit message | `rate-limited`, `retry_after_s` from `retry-after` or `x-ratelimit-reset` |
| any status with `X-GitHub-SSO: required; url=…` | `sso-required`, `sso_url` only when it is an `https://github.com/…` page |
| 403 "OAuth App access restrictions" | `org-restricted`; for an OAuth link `settings_url` is `https://github.com/settings/connections/applications/<client id>` |
| other 403 | `github-error` |
| 404 | `not-found` |
| 422, 5xx, anything else, a body that is not JSON | `github-error` |

GraphQL answers 200 with `errors[]`, often beside partial `data`. The client returns both; the
caller decides what is fatal, and maps the errors: `RATE_LIMITED` is `rate-limited`; a
`FORBIDDEN` naming OAuth App access restrictions is `org-restricted`, one naming SAML is
`sso-required`, any other `FORBIDDEN` and `NOT_FOUND` are `not-found`; anything else is
`github-error`. A 200 with `X-GitHub-SSO: partial-results; organizations=…` (SAML hid some
organizations' results) is not an error: search turns it into a warning.

### 9.3 The device flow

Polled by the DAEMON, so a link survives the Settings window closing and a phone can link the
desktop's daemon:

1. `integration-link-start`: `POST /login/device/code` with `client_id` and `scope=repo`. The
   `device_code` stays in the flow's closure; `user_code` and `verification_uri` (which must
   pass `isGitHubWebURL`) are answered once, to the session that asked, with a new `flow_id`.
   `device_flow_disabled` or an unknown client here is `unavailable`. A start replaces any
   pending flow: the first window sees the new `flowID` in `integrations-changed` and resets.
2. Every `interval` seconds (at least 5), `POST /login/oauth/access_token` with `client_id`,
   `device_code` and `grant_type=urn:ietf:params:oauth:grant-type:device_code`. GitHub answers
   HTTP 200 with `error` until it is done:

   | `error` | then |
   |---|---|
   | `authorization_pending` | poll again after `interval` |
   | `slow_down` | poll less often: the `interval` it returned, else 5 s more |
   | `expired_token` | `failed`, `expired` |
   | `access_denied` | `failed`, `denied` |
   | `device_flow_disabled` | `failed`, `disabled` |
   | `incorrect_client_credentials`, `incorrect_device_code`, `unsupported_grant_type`, anything else | `failed`, `error` |

   A transport failure, a timeout or a 5xx is retried up to 3 times in a row, the wait doubling
   each time, then the flow fails (`error`). The code's own deadline ends the flow as `expired`
   without asking again.
3. A token is verified with `GET /user` (the login and `x-oauth-scopes`; a grant without `repo`
   fails the flow with `missing-scope`'s message), stored as `how: 'oauth'`, and broadcast.

`integration-link-cancel` cancels the pending flow, or only the one its `flow_id` names
(`cancelled: false` for any other); a cancel naming a failed flow clears the failure from the
status. A pasted token or an unlink also ends a pending flow. Daemon stop and handoff DROP the
flow: its device code lives only in that process, and the client resets its code display when it
reconnects to the successor.

A pasted token (`integration-link-token`) is verified the same way: a classic token (GitHub sends
`x-oauth-scopes`) without `repo` is refused with `missing-scope` and nothing is stored; a token
GitHub reports no scopes for (fine-grained) is accepted with a `warnings` entry; a token GitHub
refuses is `unauthorized`, and nothing already stored is touched.

### 9.4 Search

`ticket-search` (§6) asks GitHub ONE GraphQL request:

- an empty query: the three `@me` lists as aliased searches `s0`, `s1`, `s2` (20 rows each);
- typed text: one `results` search (20 rows), scoped by `buildTicketSearchQueries` to the
  distinct owners of every registered repository's GitHub remotes (all remotes, §9.6). Which
  owners are organizations (`org:`) and which are users (`user:`) is asked once per owner with
  a `repositoryOwner` lookup and remembered for the daemon's life; an owner GitHub does not know
  is left out.

The document's shape is constant: only alias and variable names Kelpi numbers itself vary, and
every value (the search text, an owner's login) travels as a GraphQL variable. A list GitHub
answered with an error is left out with a warning (the others still come back); when every list
fails, the mapped error is the reply. SAML-hidden organizations and owners left out of a query
that would pass 256 characters are warnings too.

Each row becomes a `TicketSummary`: every string cleaned (`untrustedLine`; titles at 200, labels
and logins at 60), the URL built by Kelpi (`https://github.com/<repo>/(pull|issues)/<n>`, never
taken from the answer), `repo_id` from §9.6's match.

An answer is reused for 30 s, keyed by login and query. At most 20 searches a minute reach GitHub;
past that, and while a GitHub rate limit has not reset, a search is refused at once with
`rate-limited` and `retry_after_s`, without a request.

### 9.5 Resolve

`ticket-resolve` and a create from a ticket both resolve through `TicketService.resolve(ref,
signal)`, which answers the whole `ResolvedTicket` (`handlers/app/context.ts`):

1. GitHub's half, one GraphQL request (`repository(owner, name) { defaultBranchRef,
   issueOrPullRequest(number) }`, owner, name and number as variables): the row's fields, the
   body, the last 10 comments (with a pull request's review summaries merged in by time), and for
   a pull request `baseRefName`, `headRefName`, `headRefOid` (40 or 64 hex), `isCrossRepository`,
   `maintainerCanModify`, `headRepositoryOwner`, `headRepository` and the comments of its
   unresolved `reviewThreads` (the first 50 threads, 5 comments each). A deleted fork has a null
   head owner and repository. A missing repository or number is `not-found`. This half is reused
   for 5 minutes, keyed by `ticketIdentity`, so the create that follows the sheet's resolve does
   not ask GitHub again (`resolvedAt` says when it was asked).
2. The local half, recomputed every time (it changes as the user works): the matched repository
   and base remote (§9.6), for a fork's pull request the head remote or push URL (§9.6), the
   matched repository's local branches, `ticketCreateDefaults` (§7), and the workspaces already
   open for the ticket: those created from it (`ticketIdentity` of `WorkspaceState.ticket`,
   reason `ticket`), then those with an association to the matched repository on the default
   branch (reason `branch`).
3. Warnings: the defaults' own, a repository that is not registered, a ticket that is not open,
   a deleted fork (checked out, never pushed back), a fork whose maintainers may not push.

The summary's strings are cleaned as in §9.4. The ticket file's content (`file`) is GitHub's raw
text; `renderTicketFile` cleans and caps it. The resolve honours its `signal`: an abort rejects
with the signal's reason, and the git reads stop waiting.

### 9.6 Repository matching

`git/repo-facts.ts` reads, per registered repository and without the network: every remote with
its fetch and push URL as git uses them (`git remote -v`, so `insteadOf` rewrites apply) AND as
written in the config (`remote.<name>.url` / `.pushurl`), every local branch with its
`branch.<b>.remote`, `merge` and `pushRemote`, `git worktree list --porcelain` (where each branch is
checked out; a prunable worktree does not count), and whether the registered path is the
repository's own root. Every call has a 5 s timeout, runs with `GIT_TERMINAL_PROMPT=0` and
`GIT_OPTIONAL_LOCKS=0`, and a repository git cannot read simply has no facts. Remotes and the
root check are cached 30 s, branches 2 s. These are direct git reads, never through the
`kelpi.git` plugin provider (whose contract has no such methods).

It is the ONE reader of remotes, branches and worktrees for a ticket: the create's plan
(`planTicketCreate`) and the pull request checkout (graft-git.md §8.5.3) read the same facts with
its uncached, strict readers (`readRemoteFacts`, `readBranchFacts`: a repository git cannot read
is an error there, not "nothing"), and every rule below lives once, in `@kelpi/core/tickets`
(`tracking.ts`: `bestRemoteFor`, `tracksPullRequest`, `pullRequestUpstreamPointsAt`) and
`integrations/matching.ts` (`localBranchLookup`, `headRemoteFor`), so the resolve (the sheet's
prefill) and the create never disagree about a repository.

A remote FETCHES from a repository when any URL it fetches from names it: as git uses it (so a
`gh:acme/api` alias that `url.git@github.com:.insteadOf` rewrites counts) or as written (so a
GitHub URL that `insteadOf` rewrites onto a mirror counts too). Where it pushes does not count: a
triangular clone's `pushurl` names the user's fork. A registered repository matches a ticket when
ANY of its remotes fetches from the ticket's `owner/name` (compared case-insensitively): `origin`
in a plain clone, `upstream` in a fork clone, any name anyone uses. Ties go to, in order: a match on `origin`, then `upstream`, then any other
remote; a repository added by hand over an auto-discovered one; the repository's root over a
subfolder row or a linked worktree row; the most recently accessed; registry order. The matching
remote is `baseRemote`: base fetches, `refs/pull/<n>/head` and an issue's update main use it, not
a hard-coded `origin`.

For a fork's pull request, `headRemote` is a remote of the matched repository that already
fetches from the head repository (the user's own fork, usually `origin` in a fork clone); the head
is then fetched from it and tracked, as `gh pr checkout` does. Without one, and only when the fork
still exists and its maintainers may push, `headPushURL` is the base remote's URL with
`owner/name` swapped (`forkPushURL`: its push URL as git uses it, then as written, then its fetch
URL the same way; `replaceGitHubRemoteRepo`), so an SSH host alias such as `git@github.com-work:`
carries over.

The local-branch facts `ticketCreateDefaults` decides with, and the checkout refuses by
(`tracksPullRequest`): a branch tracks THIS pull request when its config merges
`refs/pull/<n>/head` from the base repository, or `refs/heads/<head>` from the repository the head
lives in (the base for a same-repository pull request), or, for a same-repository pull request
only, when it has no upstream at all. Its `branch.<b>.remote` points at a repository when it is
the remote matched to it (`baseRemote`, `headRemote`), the fork URL the create configures
(`headPushURL`), ANY remote that fetches from it (a clone with both `origin` and `upstream` on the
base repository), or a URL that names it; a `.` (local) upstream never does. An issue's branches
never track anything.

A registered repository whose `remoteURL` is null gets its `origin` URL filled in
(`set-repo-remote-url`, then a save) the first time a search or resolve reads it, once per daemon
life (auto-detection refreshes only auto-discovered rows). The registry reaches every client, so
the URL is stored without its userinfo's secret (`remoteURLWithoutSecrets`, app-state-core.md
§7.2): `https://user:ghp_…@github.com/o/r` is kept as `https://github.com/o/r`. The token in such a
URL is never sent anywhere by Kelpi either way; this only keeps it out of the registry.

### 9.7 Routing, the status and teardown

`ws/sync.ts` sends every `isIntegrationCommand` payload to `ws/integrations.ts` before the wire
decode, and BEFORE the plugin operation-hook interception: the family is never plugin-hookable,
so not even a wildcard (`'*'`) hook sees a pasted token. Authorization comes first, on the raw
verb name: the four management verbs answer `forbidden` unless the session is an owner session
(no `kd_` device token) running a window's command (not a plugin view's `executeCommand`, whose
internal session would otherwise count as the owner). Search, resolve and status are open to
every session. A request still waiting on GitHub when its session goes away is aborted.

`welcome.integrations` is the service's status list and `welcome.integrationsManageable` is
`true` for an owner session; every change (a link, an unlink, a flow starting, failing, being
replaced or cancelled, a 401 turning a credential revoked) reaches every ready session as one
`integrations-changed` frame with the whole list, sent straight to the sessions rather than
through `broadcast`, so a plugin's `observe` never sees it.

`stop()` and `handoff()` dispose the service first: every request in flight is aborted, the
device flow is dropped, and anything asked afterwards answers `unavailable`.

### 9.8 Owner notes

- The OAuth App must be registered with Device Flow enabled; until then the build constant is
  empty and only personal access tokens link.
- An organization that restricts OAuth App access hides its results silently and answers a
  resolve `FORBIDDEN` (`org-restricted`): its owner must approve Kelpi, or the user links a
  personal access token, which OAuth App restrictions do not apply to.
- Unlinking cannot revoke the grant on GitHub (that needs the client secret); a client links to
  `https://github.com/settings/applications` for that.
- Node's `fetch` ignores `HTTPS_PROXY` unless the daemon runs with `NODE_USE_ENV_PROXY=1`.

## 10. Security

- The token lives only in daemon memory and in `integrations.json`; it is never in a snapshot,
  `welcome`, a frame, a reply, a plugin broadcast, a log line, a thrown error, a git invocation
  (git uses the user's own credentials) or a pane's environment.
- `device_code` never leaves daemon memory; `user_code` and `verification_uri` go only to the
  session that started the flow.
- Every URL a client opens on the daemon's word passes `isGitHubWebURL`.
- Ticket text is untrusted (§5): titles one line and stripped, `@` neutralized in prompts, the
  body only in the ticket file, which says it is untrusted; a pull request's head ref and fork
  owner and name are validated before git sees them.
- Residual: a fork's pull request is someone else's code, which the agent may run; prompt
  injection through a ticket's body is inherent to reading it.
