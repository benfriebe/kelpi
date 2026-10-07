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
  problem?: 'revoked' | 'unreadable';
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
| `unavailable` | the device flow is not offered (no OAuth client ID, or GitHub has it disabled for the app); link a token instead | |
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

`workspace-create` with `ticket` (wire-protocol.md §6.3) parses the reference, asks the
`TicketService` seam (`packages/daemon/src/handlers/app/context.ts`) whether the provider is
connected, and resolves it (`resolve(ref, signal)` → `ResolvedTicket`: the summary, a pull
request's head facts, the matched repository and remote, the defaults, the existing workspaces,
the ticket file's content and warnings), all before any effect; then it checks out (a pull
request's head with its own request type, never the plugin `git.worktreeAdd` contract), writes the
ticket file, creates the workspace with `ticket` stored, and starts the agent. A handler table
built without a service gets `INERT_TICKET_SERVICE`, which is never connected. A
`TicketServiceError` carries the code of §2.2: `integrationFailure` turns it into a verb's
`{ok:false, error, code, …}`, `ticketCreateFailure` into a create's `{ok:false, error,
ticket_error, …}`, and `workspaceTicketOf` (`packages/daemon/src/store/ticket.ts`) picks the seven
fields a workspace keeps out of a `TicketSummary`.

The checkout and ticket-file rules are [graft-git.md](graft-git.md) §8.5's.

## 9. The service

The integrations service (`packages/daemon/src/integrations/`) is specified here as it is built:
the credential store (`integrations.json` beside the database, 0600, written atomically,
[persistence.md](persistence.md) §7.4), the GitHub HTTP client (timeouts, headers, the status and
error mapping of §2.2), the device flow (polled by the daemon; `authorization_pending`,
`slow_down`, `expired_token`, `access_denied`, `device_flow_disabled`), search (§6) and resolve
(GraphQL, repository matching on `origin`, `upstream` and any other remote), and how
`ws/sync.ts` routes the verbs and sends the status.

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
