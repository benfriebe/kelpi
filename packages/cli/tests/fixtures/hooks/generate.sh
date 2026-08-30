#!/bin/bash
# Regenerate the `expected-*.json` goldens in this directory by running the REAL Swift-era
# installer logic — `scripts/install-hooks.sh`'s two heredocs, fed through the actual
# `scripts/merge_hooks.py` from the shipped Kelpi repo.
#
# That is the whole point of these files: `install-hooks.test.ts` asserts that the TypeScript
# port produces the same bytes as the Python did, on the same inputs, so "we ported it" is a
# claim with a diff behind it rather than a reading of the source.
#
#   ./generate.sh [path-to-swift-kelpi-repo]     (default: a sibling `kelpi` checkout of the Swift
#                                               app, next to this repo)
#
# The `input-*.json` files are hand-written by contrast: they are the *situations* a real user
# arrives in (a config full of their own hooks, a pre-v0.19 install with absolute paths and a
# `"startup"` matcher), and they are the inputs both implementations are fed.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
swift_repo="${1:-$(cd "$here/../../../../../.." && pwd)/kelpi}"
merge="$swift_repo/scripts/merge_hooks.py"

if [ ! -f "$merge" ]; then
    echo "merge_hooks.py not found at $merge — pass the Swift kelpi repo path as \$1" >&2
    exit 1
fi

# Verbatim from scripts/install-hooks.sh.
HOOKS='{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "kelpi event stop"
          }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "kelpi event notification"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "kelpi event session-start"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "kelpi event session-end"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "kelpi event start"
          }
        ]
      }
    ]
  }
}'

CODEX_HOOKS='{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "kelpi event stop --agent codex"
          }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "kelpi event notification --agent codex"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "kelpi event session-start --agent codex"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "kelpi event start --agent codex"
          }
        ]
      }
    ]
  }
}'

write_fresh() {
    # The `else` branch of install-hooks.sh: no settings file yet.
    printf '%s' "$2" | python3 -c "
import json, sys
data = json.load(sys.stdin)
with open('$1', 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
"
}

merge_into() {
    cp "$here/$1" "$here/$2"
    python3 "$merge" "$here/$2" "$3"
}

write_fresh "$here/expected-claude-fresh.json" "$HOOKS"
write_fresh "$here/expected-codex-fresh.json" "$CODEX_HOOKS"

# Idempotency: the installer re-run over its own output.
merge_into expected-claude-fresh.json expected-claude-rerun.json "$HOOKS"

# A user's own hooks, preserved (and the documented composite-command trade-off).
merge_into input-claude-usermerge.json expected-claude-usermerge.json "$HOOKS"

# A pre-v0.19 install: absolute-path commands + a stale `"startup"` SessionStart matcher.
merge_into input-claude-stale.json expected-claude-stale-migrated.json "$HOOKS"

# Codex: a hand-wired bare claude command plus a stale matcher group.
merge_into input-codex-stale.json expected-codex-stale-migrated.json "$CODEX_HOOKS"

echo "regenerated goldens in $here using $merge"
