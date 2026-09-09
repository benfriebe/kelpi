# Service Lab

A build-free backend demonstrating native Git, content-rendering, and managed-process
providers. It has no views or dependencies. Git and process methods delegate to Kelpi's
bundled implementation; rendered Markdown/diff previews add a visible **Service Lab** banner
with element ID `service-lab-banner`. The last 100 calls are retained in memory until reload.

Run these commands through the CLI/socket of your isolated development instance:

```sh
kelpi plugin install ./examples/plugins/service-lab --trust
kelpi plugin service-select kelpi.git example.service-lab.git
kelpi plugin service-select kelpi.content.render example.service-lab.renderer
kelpi plugin service-select kelpi.process example.service-lab.process
kelpi plugin service-call kelpi.git getCurrentBranch --args '{"repoPath":"/path/to/repository"}'
kelpi plugin run example.service-lab.exec --args '{"file":"git","args":["--version"]}'
kelpi plugin run example.service-lab.history
```

Open a native Markdown or diff pane to see the banner. Repository discovery/status,
worktree commands, graft, and diff generation also pass through the selected Git adapter.
Background callers may provide only daemon context; all primitives carry explicit paths.
Use the history command to see service/method/path entries. Git/process providers have a
30-second deadline; the renderer has 5 seconds. No Git responses are fabricated.

Restore bundled defaults:

```sh
kelpi plugin service-select kelpi.git default
kelpi plugin service-select kelpi.content.render default
kelpi plugin service-select kelpi.process default
```

Disabling this plugin also restores bundled fallback while retaining the saved preferences.
Editing requires installing the directory again; reload restarts the installed copy and clears
history. See the [service guide](../../../docs/plugin-services.md) for contracts and the native
lifecycle boundaries, including editor saves and terminal process ownership.
