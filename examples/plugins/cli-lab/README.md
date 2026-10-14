# CLI Lab

A build-free backend that adds its own top-level `kelpi` verb. It has no views. The manifest's
`contributes.cli` maps `kelpi hello` onto the `example.cli-lab.hello` command, which receives the
words after the verb as `argv` along with the caller's `cwd`, `isTTY` and `json`, and answers with
`{ text, json, exitCode, stderr }` for the CLI to print.

Follow the [private development setup](../../../docs/plugin-development.md#start-a-private-instance).
Run these commands from the checkout root using its `kelpi_test` helper:

```sh
kelpi_test plugin validate ./examples/plugins/cli-lab
kelpi_test plugin install ./examples/plugins/cli-lab --trust
kelpi_test hello a b            # hello a b
kelpi_test hello --exit 3 x     # hello x, exit status 3
kelpi_test hello --json a       # {"argv":["a"],"cwd":...,"isTTY":...,"paneID":...,"workspaceID":...}
kelpi_test hello --loud         # cli-lab: loud on standard error, hello on standard output
kelpi_test hello --help         # the plugin's own usage text
kelpi_test --help               # lists kelpi hello under CLI Lab
```

`--json` is the CLI's switch: it is removed from `argv` and asks for the result's `json` instead
of its `text`. `paneID` and `workspaceID` are filled in when the command runs inside a Kelpi pane.
`kelpi_test plugin disable example.cli-lab` makes `kelpi hello` fail with `plugin example.cli-lab
is disabled`, and `kelpi --help` marks the verb `(disabled)`. A second plugin that declares
`hello` is refused at install while this one holds the name, and a verb named after a built-in
such as `pane` fails `plugin validate`.

Run `node scripts/scenario.mjs plugin-cli-verbs --window hidden` for the CLI verb scenario. See
[CLI verbs](../../../docs/plugins.md#cli-verbs) for the manifest rules and
[the CLI reference](../../../docs/cli.md#plugin-cli-verbs) for dispatch, output and exit codes.
