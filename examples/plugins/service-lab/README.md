# Service Lab

A build-free backend demonstrating native Git, content-rendering, and managed-process
providers. It has no views or dependencies. Git and process methods delegate to Kelpi's
bundled implementation; rendered Markdown/diff previews add a visible **Service Lab** banner
with element ID `service-lab-banner`. The last 100 calls are retained in memory until the
backend restarts, including on reload or revision switching.

Follow the [private development setup](../../../docs/plugin-development.md#start-a-private-instance).
Run these commands from the checkout root using its `kelpi_test` helper:

```sh
kelpi_test plugin validate ./examples/plugins/service-lab
kelpi_test plugin install ./examples/plugins/service-lab --trust
kelpi_test plugin service-select kelpi.git example.service-lab.git
kelpi_test plugin service-select kelpi.content.render example.service-lab.renderer
kelpi_test plugin service-select kelpi.process example.service-lab.process
kelpi_test plugin service-call kelpi.git getCurrentBranch --args '{"repoPath":"/path/to/repository"}'
kelpi_test plugin run example.service-lab.exec --args '{"file":"git","args":["--version"]}'
kelpi_test plugin run example.service-lab.history
```

Open a native Markdown or diff pane to see the banner. Repository discovery/status,
worktree commands, graft, and diff generation also pass through the selected Git adapter.
Background callers may provide only daemon context; all primitives carry explicit paths.
Use the history command to see service/method/path entries. Git/process providers have a
30-second deadline; the renderer has 5 seconds. No Git responses are fabricated.

Restore bundled defaults:

```sh
kelpi_test plugin service-select kelpi.git default
kelpi_test plugin service-select kelpi.content.render default
kelpi_test plugin service-select kelpi.process default
```

Disabling this plugin also restores bundled fallback while retaining the saved preferences.
Run `kelpi_test plugin dev examples/plugins/service-lab --trust` from the checkout root to
install source changes. Reload restarts the installed copy and clears this example's call
history. Settings → Plugins → Versions selects compatible retained revisions while keeping
provider preferences. See the [service guide](../../../docs/plugin-services.md) for contracts
and lifecycle boundaries, including editor saves and terminal process ownership.

Run `node scripts/scenario.mjs plugin-native-services --window hidden` for the native adapter
scenario, or use `--window onscreen` for visual inspection. The
[validation record](../../../docs/plugin-validation.md) contains dated results; the
[plugin roadmap](../../../docs/plugin-roadmap.md) tracks overall progress and remaining scope.
