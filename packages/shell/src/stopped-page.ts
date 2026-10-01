/**
 * The page the window shows while the daemon is stopped (#312).
 *
 * Before this, a stopped daemon left the window on Chromium's "This site can't be reached" page,
 * reloading it every 1.5 s, with nothing to say what had happened or what to do. This is a
 * document the shell renders itself, so it works with no daemon at all: what happened, what
 * starting the daemon brings back, and two buttons.
 *
 * Like the web pane's error card (`./webhost/error-page.ts`) it is a self-contained `data:` URL,
 * and its buttons are plain links rather than script: the window has no preload bridge and this
 * page is not the place to start one. They point at a reserved `.invalid` host that can never
 * resolve, and the window's `will-navigate` turns them into actions (`stoppedPageAction`) before
 * any navigation happens.
 *
 * Built here, and only here, so the markup can be asserted without an Electron process.
 */

/** The marker in the page's `<title>`, for logs and for the window to recognise its own page. */
export const STOPPED_PAGE_MARKER = 'kelpi-daemon-stopped';

const ACTION_ORIGIN = 'https://kelpi-shell.invalid';

export type StoppedPageAction = 'start-daemon' | 'quit';

export type StoppedPageState =
    | { readonly kind: 'stopped'; readonly runDir: string }
    | { readonly kind: 'starting' }
    | { readonly kind: 'failed'; readonly message: string; readonly repair: string };

export function stoppedPageActionURL(action: StoppedPageAction): string {
    return `${ACTION_ORIGIN}/${action}`;
}

/** The action a navigation to `target` asks for, or null when it is not one of this page's. */
export function stoppedPageAction(target: string): StoppedPageAction | null {
    let url: URL;
    try {
        url = new URL(target);
    } catch {
        return null;
    }
    if (url.origin !== ACTION_ORIGIN) return null;
    const action = url.pathname.slice(1);
    return action === 'start-daemon' || action === 'quit' ? action : null;
}

/** True for a URL this module built (a data URL carrying the marker). */
export function isStoppedPageURL(url: string): boolean {
    return url.startsWith('data:text/html') && decodeURIComponentSafe(url).includes(STOPPED_PAGE_MARKER);
}

function decodeURIComponentSafe(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function escapeHTML(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function button(action: StoppedPageAction, label: string, primary: boolean): string {
    return `<a class="button${primary ? ' primary' : ''}" href="${stoppedPageActionURL(action)}">${escapeHTML(label)}</a>`;
}

function content(state: StoppedPageState): { heading: string; body: string; actions: string } {
    switch (state.kind) {
        case 'stopped':
            return {
                heading: 'Kelpi’s daemon has stopped',
                body:
                    '<p>The daemon runs your terminals and agents, and this window shows them. It is not running, so there is nothing to show.</p>' +
                    '<p>Starting it brings back your workspaces and panes. Shells start fresh, and panes that had an agent session resume it.</p>' +
                    '<p class="aside">If you stopped it on purpose, you can leave this window open: it reconnects by itself when a daemon starts.</p>' +
                    `<p class="aside mono">${escapeHTML(state.runDir)}</p>`,
                actions: button('start-daemon', 'Start Daemon', true) + button('quit', 'Quit Kelpi', false)
            };
        case 'starting':
            return {
                heading: 'Starting Kelpi’s daemon…',
                body: '<p>Your workspaces and panes come back as soon as it answers.</p>',
                actions: ''
            };
        case 'failed':
            return {
                heading: 'Kelpi’s daemon did not start',
                body: `<p>${escapeHTML(state.message)}</p>${state.repair === '' ? '' : `<p class="aside">${escapeHTML(state.repair)}</p>`}`,
                actions: button('start-daemon', 'Try Again', true) + button('quit', 'Quit Kelpi', false)
            };
    }
}

/** The whole document. No script, no network: a strict CSP says so. */
export function stoppedPageHTML(state: StoppedPageState): string {
    const { heading, body, actions } = content(state);
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${STOPPED_PAGE_MARKER}</title>
<style>
:root { color-scheme: light dark; --bg: #f6f6f7; --fg: #1d1d1f; --muted: #6e6e73; --accent: #0a66d8; --accent-fg: #fff; --line: rgba(0,0,0,.12); }
@media (prefers-color-scheme: dark) { :root { --bg: #1c1c1e; --fg: #f2f2f7; --muted: #98989d; --accent: #3b8cf5; --line: rgba(255,255,255,.16); } }
html, body { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  display: flex; align-items: center; justify-content: center; -webkit-app-region: drag; -webkit-user-select: none; user-select: none; }
main { max-width: 30rem; padding: 3rem 1.5rem; }
h1 { font-size: 1.35rem; font-weight: 600; margin: 0 0 .75rem; }
p { margin: 0 0 .75rem; }
.aside { color: var(--muted); font-size: 12.5px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
.actions { display: flex; gap: .5rem; margin-top: 1.25rem; }
.button { -webkit-app-region: no-drag; display: inline-block; padding: .45rem .95rem; border-radius: 6px; border: 1px solid var(--line);
  color: var(--fg); text-decoration: none; font-weight: 500; cursor: default; }
.button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
.button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
</head>
<body>
<main>
<h1>${escapeHTML(heading)}</h1>
${body}
${actions === '' ? '' : `<div class="actions">${actions}</div>`}
</main>
</body>
</html>
`;
}

export function stoppedPageURL(state: StoppedPageState): string {
    return `data:text/html;charset=utf-8,${encodeURIComponent(stoppedPageHTML(state))}`;
}
