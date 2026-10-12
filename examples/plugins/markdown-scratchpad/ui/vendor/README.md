# Vendored CodeMirror

Plugin views load no network code, so CodeMirror ships inside the plugin as one prebuilt ES
module, `codemirror.js`, under its MIT licence (`LICENSE`).

| Package | Version |
| --- | --- |
| `@codemirror/state` | 6.7.5 |
| `@codemirror/view` | 6.43.12 |
| `@codemirror/commands` | 6.11.1 |
| `@codemirror/language` | 6.12.4 |
| `@codemirror/lang-markdown` | 6.5.2 |
| `@lezer/markdown` | 1.7.2 |
| `@lezer/highlight` | 1.2.3 |
| `@lezer/common` | 1.5.2 |

The bundle exports only the names `ui/*.js` and the plugin's test import from it. It leaves out
lang-markdown's `markdown()` helper on purpose: that one pulls in the HTML, CSS and JavaScript
parsers for embedded code, about 190 KB, which a scratchpad does not need.

Rebuild after changing which names are imported from `./vendor/codemirror.js`. Install the exact
versions into an empty directory outside the checkout, with `overrides` holding every shared
dependency at the versions above:

~~~sh
mkdir cm-deps && cd cm-deps
# package.json: the eight packages above as "dependencies", and the same pins for every one
# except lang-markdown again under "overrides"
npm install --ignore-scripts
~~~

Then bundle from a separate directory, with the checkout's esbuild:

~~~sh
cat > entry.js <<'JS'
export { Annotation, Compartment, EditorSelection, EditorState, Prec, Transaction } from '@codemirror/state';
export { Decoration, EditorView, ViewPlugin, WidgetType, keymap } from '@codemirror/view';
export { defaultKeymap, history, historyKeymap, indentLess, indentMore, insertTab } from '@codemirror/commands';
export { HighlightStyle, Language, LanguageSupport, ensureSyntaxTree, indentUnit, syntaxHighlighting, syntaxTree } from '@codemirror/language';
export { deleteMarkupBackward, insertNewlineContinueMarkup, markdownLanguage } from '@codemirror/lang-markdown';
export { tags } from '@lezer/highlight';
JS
NODE_PATH=<cm-deps>/node_modules <checkout>/node_modules/.pnpm/node_modules/.bin/esbuild entry.js \
  --bundle --format=esm --minify --legal-comments=none --outfile=cm.min.js
~~~

Prefix the result with the one-line header comment from the current `codemirror.js` (update the
versions in it) when replacing the file here.
