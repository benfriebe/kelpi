# Native service providers

Kelpi's daemon provides `kelpi.git`, `kelpi.content.render`, `kelpi.process`, and `kelpi.files`,
all at version 1. A selected provider replaces the listed native adapter on that daemon.
The high-level CLI/UI commands continue to enforce their own workspace, pane, and state rules.
Service calls return direct values; they do not use the command API's `{ok, ...}` reply envelope.

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

```sh
kelpi plugin services
kelpi plugin service-call kelpi.git getCurrentBranch --args '{"repoPath":"/code/project"}'
kelpi plugin service-select kelpi.content.render example.presentation.renderer
kelpi plugin service-select kelpi.content.render default
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
