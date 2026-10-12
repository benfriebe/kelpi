# Native service providers

Kelpi's daemon provides `kelpi.git`, `kelpi.content.render`, `kelpi.process`, and `kelpi.files`,
all at version 1. A selected provider replaces the listed native adapter on that daemon.
The high-level CLI/UI commands continue to enforce their own workspace, pane, and state rules.
Service calls return direct values; they do not use the command API's `{ok, ...}` reply envelope.

The [plugin roadmap](plugin-roadmap.md) places these adapters within the overall extension
scope. Use the [development guide](plugin-development.md) for private instances, SDK artifacts,
dev watching and package installation.

The [public service map](../packages/plugin-sdk/services.d.ts) describes every method's input
and result. `api.services.call(service, 1, method, args)` infers those types. All arguments are
JSON; cancellation travels through the host invocation rather than an `AbortSignal` field.
Providers receive invocation context as their handler's second argument. A native operation
can supply workspace/pane context; background Git discovery may have only `daemonID` and the
explicit path arguments. An active pane or client is not promised for native Git calls.

Declare each provider in the manifest and register every declared method during activation.
A provider must implement the service's complete method list. Service selection belongs to
the daemon and survives provider disable/removal; Settings → Plugins shows the preferred and
active providers. Calls can select a particular provider or delegate to the bundled one with
`{provider: 'bundled'}`. Calling the selected service from its own provider without this override
is recursive and fails.
The runnable [Service Lab](../examples/plugins/service-lab) delegates all Git primitives and
managed processes to bundled implementations, records call history, and marks native previews.

Use `kelpi_test` from the development guide to keep these commands on your private daemon.
The provider in this example must already be installed:

```sh
kelpi_test plugin services
kelpi_test plugin service-call kelpi.git getCurrentBranch --args '{"repoPath":"/code/project"}'
kelpi_test plugin service-select kelpi.content.render example.presentation.renderer
kelpi_test plugin service-select kelpi.content.render default
```

The CLI defaults to version 1; use `--version` for a different custom contract. Selecting
`default` clears the saved preference. Installation alone does not select a provider.
`services.invalidated` events carry changed service keys, such as `['kelpi.git@1']`, so a
consumer can refresh cached data when selection, reload, failure, or dependencies change the
effective implementation. `services.changed` retains the full discovery array.

## Git primitives

`kelpi.git@1` exposes the daemon's 25 asynchronous Git primitives. Repository discovery,
status polling, CLI/UI worktree operations, graft, and native diff generation use this adapter.
The existing high-level `api.git.status(workspaceID)`, repository/association helpers, and graft
commands remain available and retain their existing semantics.

Low-level service calls take explicit paths and operate on Git itself; creating a worktree
through this interface does not also create a Kelpi workspace or repository association.
The force checkout/reset methods have the same working-tree effects as their native Git
counterparts. Use the high-level helpers when the intended action also changes Kelpi state.

Git providers operate on Git-compatible checkouts visible to the daemon. Returned checkout
paths, object/stash SHAs, and HEAD paths must remain usable by bundled Git: persisted graft
recovery and fallback depend on those native repository formats. During clean shutdown,
Kelpi keeps the selected provider running until its bounded graft restoration finishes.

| Method | Arguments | Result |
| --- | --- | --- |
| `getCurrentBranch` | `{repoPath}` | `string \| null`; `"HEAD"` means detached HEAD |
| `getDiff` | `{repoPath, targetPath?: string \| null}` | Diff text; an empty or absent target means the whole diff |
| `getRemoteURL` | `{repoPath}` | `string \| null` |
| `defaultBranch` | `{repoPath}` | Branch name |
| `fetch` | `{repoPath, remote?}` | `null`; remote defaults to `origin` |
| `createWorktree` | `{repoPath, worktreePath, branchName}` | `null` |
| `createWorktreeFromBase` | `{repoPath, worktreePath, branchName, baseRef}` | `null` |
| `worktreeAdd` | `{repoPath, worktreePath, branchName, updateMain: boolean, remote?}` | `null` |
| `toplevel` | `{directory}` | Worktree root or `null` |
| `resolveRepoRoot` | `{directory}` | `{worktreeRoot, parentRepoRoot}` or `null` |
| `getStatus` | `{repoPath}` | `{kind:'unknown' \| 'clean'}` or `{kind:'dirty', changedFiles, additions, deletions}` |
| `repoState` | `{repoPath}` | `clean`, `merge`, `rebase`, `cherryPick`, `revert`, or `bisect` |
| `getHeadSha` | `{repoPath}` | HEAD SHA |
| `resolveHeadPath` | `{worktreePath}` | Resolved HEAD file path |
| `stashPushIncludeUntracked` | `{repoPath, message}` | Stash SHA or `null` when nothing was stashed |
| `stashPopRef` | `{repoPath, stashRef}` | `null`; a stash no longer present is a successful no-op |
| `writeTreeForWorktree` | `{worktreePath}` | Tree SHA; the bundled implementation uses a temporary index |
| `readTreeInto` | `{repoPath, treeSha}` | `null` |
| `checkoutBranchForce` | `{repoPath, branchOrSha}` | `null` |
| `checkoutHeadForce` | `{repoPath}` | `null` |
| `resetHard` / `resetMixed` | `{repoPath, sha}` | `null` |
| `listWorktrees` | `{repoPath}` | `{path, branch: string \| null, isMain: boolean}[]` |
| `removeWorktree` | `{repoPath, worktreePath}` | `null`; bundled removal refuses dirty/locked worktrees |
| `pruneWorktrees` | `{repoPath}` | `null` |

Path/ref arguments are nonempty strings; optional `getDiff.targetPath` also permits an empty
string. Status counts are nonnegative integers. Inputs with unknown fields and malformed
provider results reject. Mutation handlers can return `void`; the backend bridge converts it
to the required `null` result. Native operations retain their own Git fallback behavior, such
as unavailable branch/remote reads, independently of service-call error handling.

## Native preview rendering

`kelpi.content.render@1` has one method:

```ts
render({
    kind: 'markdown' | 'diff',
    source: string,
    backgroundColor: string,
    fontSize: number,
    assetBase: string | null,
}): Promise<{html: string}>
```

All six fields are required. Empty source is valid; font size is finite and between 8 and 32.
Native Markdown requests supply `/pane-assets/<paneID>/` as the asset base; diff requests use
`null`. The daemon supplies the source pane/workspace context. Provider HTML is displayed in
the existing native content frame with its script sandbox and host search/copy/scroll/shortcut
bridge. This is a content document, so it does not receive the PluginView `window.kelpi` SDK.

This provider changes presentation. Source buffers, dirty state, editing controls, file watches,
asset routing, save/flush behavior, and frame ownership remain native. Open previews rerender
when selection or provider availability changes, and when source/theme/font size changes.
Invalid, failed, or oversized provider output recovers to the complete bundled document with
a diagnostic. Oversized native input also uses the bundled renderer without truncation.
The selected provider preference remains saved. Direct `services.call` requests still reject
errors rather than silently substituting a different provider.

For example, declare this provider under `contributes.providers`:

```json
{
  "id": "example.presentation.renderer",
  "title": "Spacious previews",
  "service": "kelpi.content.render",
  "version": 1,
  "methods": ["render"]
}
```

Then register it in a TypeScript backend, bundling the compiled JavaScript before installation:

```ts
import type { BackendAPI, BuiltinProviderMethods } from '@kelpi/plugin-sdk';

export function activate(api: BackendAPI) {
    const methods: BuiltinProviderMethods<'kelpi.content.render'> = {
        async render(args) {
            const result = await api.services.call('kelpi.content.render', 1, 'render', args, { provider: 'bundled' });
            return { html: result.html.replace('</head>', '<style>body { line-height: 1.7; }</style></head>') };
        },
    };
    return api.providers.register<'kelpi.content.render'>('example.presentation.renderer', methods);
}
```

## Managed processes and files

`kelpi.process@1` has `exec({file, args?: string[], cwd?: string})` returning
`{stdout: string, stderr: string}`. It backs `api.process.exec` and explicit service calls.
The bundled implementation passes argv directly without a shell, defaults args to `[]` and
cwd to the daemon account's home, and carries that daemon's CLI routing environment.
Bundled execution has a 25-second timeout and a 256 KiB buffer limit for each output stream;
the combined JSON result must also fit the 256 KiB envelope. Oversized output rejects without
truncation. Execution is tied to the calling plugin/view's cancellation. Use a provider
`timeoutMs` of 30000 when delegating managed processes or longer Git operations; the default
provider deadline is 5 seconds. This does not replace
PTY creation, native Git subprocesses, external-editor ownership, or arbitrary Node calls in
a trusted backend.

`kelpi.files@1` retains its original methods: `read({path}) -> string` and
`write({path,text}) -> null`. Both `api.files` helpers honor provider selection. Reads remain
limited to regular files and 256 KiB for the bundled implementation. This service does not
replace the native editor's atomic saves or every internal filesystem access.

Provider calls share the plugin JSON envelope limit of 256 KiB. A failed invocation returns
an error; it is not automatically repeated with the bundled provider after potentially applying
a mutation. An ordinary operational error leaves the provider available; a malformed result
fails that backend, so future calls use bundled fallback. Later calls also use fallback if
the selected provider is otherwise unavailable. Declared
timeouts, activation failures, recursion guards, and recovery behavior are described in the
[authoring guide](plugins.md#service-providers). Terminal subscriptions, state replication,
authentication, workbench ownership, and editor save lifecycle require their existing native
protocols and are outside these four service contracts.

## Agent permission decisions

`kelpi.agent.permissions@1` decides an agent's permission requests (#388). Claude Code's
`PermissionRequest` hook runs `kelpi event permission-request`, which sends the wire verb of the
same name ([wire-protocol.md §6.1.1](wire-protocol.md)); the daemon asks the active provider and
the CLI prints Claude's decision JSON. The service has one method:

```ts
decide({
    paneID: string,
    workspaceID: string,
    agent: 'claude' | 'codex',
    sessionID?: string,
    toolName: string,
    toolInput: object,
    mcpServer?: string,
    cwd?: string,
    permissionMode?: string,
}): Promise<{behavior: 'allow' | 'deny' | 'abstain', message?: string}>
```

`toolName` and `toolInput` are Claude's `tool_name` and `tool_input` as sent (for Bash,
`toolInput.command` is the real command string, not what the terminal drew). `toolName` is
nonempty and `toolInput` is an object; other arguments are optional. `agent` and `sessionID`
come from the pane. A result other than those three behaviors, or a `message` that is not a
string, is malformed. `message` is used only on `deny`: Claude passes it to the model as the
tool's error, and its own UI shows a fixed "Denied by PermissionRequest hook" line.

- **Abstain by default.** The bundled implementation always returns `{behavior: 'abstain'}`,
  which prints nothing and leaves Claude's normal prompt in place.
- **Explicit selection.** As for every service, installing or enabling a provider does not
  select it. Nothing is ever approved until the user picks the provider with
  `kelpi plugin service-select kelpi.agent.permissions <provider>` or Settings → Plugins →
  Service providers; `default` goes back to the bundled abstain.
- **2 second deadline.** The daemon waits at most 2 seconds for `decide`, whatever the
  provider's `timeoutMs` says, then aborts the call. Claude draws its prompt while the hook
  runs, so a late `allow` would dismiss a prompt the user may already be reading; the deadline
  keeps that window short. Decide from the arguments alone, without slow I/O. An `on-demand`
  plugin activates on its first call, and a request that waits longer than the deadline for
  that abstains; use `startup` activation for a provider that must answer the first request.
- **Fail open means abstain.** A timeout, a thrown error, a malformed result or an
  unavailable provider is answered as `abstain`, with one warning in the daemon log naming the
  provider. A malformed result also fails the backend, so later calls use the bundled abstain
  until it reloads. Nothing but the provider's own `allow` is ever answered as allow.
- **Visibility.** The daemon logs every decision (pane, tool, behavior, provider). The
  reply's `provider` field names the provider that was asked.

In sessions that cannot show a prompt (background subagents, non-interactive runs), Claude
denies a call that no hook decided, so `abstain` there means deny, as it does without Kelpi.

Declare the provider under `contributes.providers`:

```json
{
  "id": "example.policy.permissions",
  "title": "Allow plain moves",
  "service": "kelpi.agent.permissions",
  "version": 1,
  "methods": ["decide"]
}
```

Then register it in the backend. This one allows a plain `mv`, denies a force push, and
abstains on everything else:

```ts
import type { BackendAPI, BuiltinProviderMethods } from '@kelpi/plugin-sdk';

export function activate(api: BackendAPI) {
    const methods: BuiltinProviderMethods<'kelpi.agent.permissions'> = {
        decide({ toolName, toolInput }) {
            const command = toolName === 'Bash' && typeof toolInput['command'] === 'string' ? toolInput['command'] : null;
            if (command === null) return { behavior: 'abstain' };
            if (/^git push (-f|--force)\b/.test(command)) return { behavior: 'deny', message: 'Force pushes need a person.' };
            if (/^mv [^;&|`$<>]+$/.test(command)) return { behavior: 'allow' };
            return { behavior: 'abstain' };
        },
    };
    return api.providers.register<'kelpi.agent.permissions'>('example.policy.permissions', methods);
}
```

## Updates and validation

`plugin dev` can apply provider changes while preserving the daemon's selected provider IDs.
Revision switches restart plugin backends and reset their in-memory data. The daemon rejects
changes that break enabled required dependencies and restores the previous selection when
candidate activation fails. Successful revisions do not rewind saved data, and trusted code's
external effects cannot be undone by code rollback. See [updates and recovery](plugins.md#updates-and-recovery).

Run `node scripts/scenario.mjs plugin-native-services --window hidden` for Service Lab's
native adapter flows. Use `--window onscreen` for visual inspection. The
[validation record](plugin-validation.md) identifies the source revisions and results of past runs.
