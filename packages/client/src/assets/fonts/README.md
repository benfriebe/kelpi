# Bundled terminal font

`JetBrainsMono Nerd Font` — the **same** family the Swift app's terminals used, because
libghostty bundles it (`ghostty/src/font/res/JetBrainsMonoNerdFont-*.ttf`) and falls back to it
for every glyph the user's configured font is missing. Without it the web client falls through
to Menlo, which has no Powerline separators and no Nerd Font private-use icons, so a
powerlevel10k / starship prompt renders as a row of tofu boxes.

| file | source | license |
| --- | --- | --- |
| `JetBrainsMonoNerdFont-Regular.woff2` | `JetBrainsMonoNerdFont-Regular.ttf` (Nerd Fonts v3 patch of JetBrains Mono) | SIL OFL 1.1 (`OFL.txt`) |
| `JetBrainsMonoNerdFont-Bold.woff2` | `JetBrainsMonoNerdFont-Bold.ttf` | SIL OFL 1.1 (`OFL.txt`) |

Both are the upstream TTFs converted to WOFF2 (lossless repackaging — same glyphs, same
metrics, ~60 % smaller). Italics are deliberately not bundled: a terminal renders italic text
with the regular face at the cell metrics it already measured, and two more megabytes of font
for a rarely-used SGR is a bad trade over a tailnet.

## Regenerating

```sh
# from a ghostty checkout that has the patched TTFs (the Swift app's own source):
node packages/client/scripts/build-fonts.mjs --ttf-dir ../nex/ghostty/src/font/res

# or straight from the Nerd Fonts release (needs network):
node packages/client/scripts/build-fonts.mjs --download
```

The script is byte-deterministic for a given input TTF, so a regenerated file that differs
means the upstream font changed.
