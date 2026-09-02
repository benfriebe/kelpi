/**
 * Browser entrypoint: resolve the daemon, build the runtime, mount the app.
 *
 * Deliberately thin — everything interesting is `App.tsx` (assembly) and `state/bridge.ts`
 * (the connection + command + PTY + store wiring). The three things that can only happen here:
 *
 *   1. **Target resolution.** Same-origin by default (the daemon serves this bundle);
 *      `?daemon=` / `?token=` override and are remembered, then stripped from the address bar
 *      so a token does not sit in the history or a screenshot (`app/config.ts`).
 *   2. **The xterm stylesheet.** The fallback engine (`VITE_TERMINAL_ENGINE=xterm`) needs its
 *      CSS loaded by the host page; ghostty-web needs none, so it is imported only when that
 *      engine is selected and never ships in the default bundle.
 *   3. **No `StrictMode`.** Its double-invoked effects would connect, dispose and re-connect the
 *      runtime on every mount — and `dispose()` is terminal for a `KelpiConnection` (it stops the
 *      reconnect loop by design). The app is mounted once, for the life of the page.
 */

import { createRoot } from 'react-dom/client';

import { App } from './App';
import { resolveDaemonTarget, sanitizedSearch } from './app/config';
import { setAssetCredentialToken } from './content/asset-credential';
import { registerServiceWorker } from './pwa/register';
import { createKelpiRuntime } from './state';
import { configuredTerminalEngine, loadTerminalFonts } from './terminal';
import './styles.css';

// Start the bundled terminal font before anything renders. `@font-face` is lazy, and a pane
// that measures its cell against the fallback face computes columns the engine cannot draw —
// so every pane awaits this same promise (`terminal/fonts.ts`). Kicking it off here means the
// first pane usually finds it already settled instead of waiting a frame for the fetch.
void loadTerminalFonts();

const target = resolveDaemonTarget();

// Derive the pane-assets credential from the token BEFORE anything renders: content panes
// rewrite their `<base href>` through it (`content/asset-credential.ts`), and it must be in
// place by the time the first mirror arrives.
setAssetCredentialToken(target.token);

// The credentials are remembered; take them out of the visible URL.
if (target.fromQuery && typeof history !== 'undefined' && typeof location !== 'undefined') {
    const search = sanitizedSearch(location.search);
    history.replaceState(null, '', `${location.pathname}${search}${location.hash}`);
}

if (configuredTerminalEngine() === 'xterm') {
    await import('@xterm/xterm/css/xterm.css');
}

const runtime = createKelpiRuntime({
    url: target.url,
    token: target.token,
    client: { kind: 'browser', name: 'kelpi-web' }
});

const container = document.getElementById('root');
if (container !== null) {
    createRoot(container).render(<App runtime={runtime} target={target} />);
}

// After the render, and only in a browser that is not the Electron shell: `pwa/register.ts`
// owns every reason not to. An installed phone app whose Mac is asleep opens on Kelpi's own
// connection screen instead of Safari's error page; the desktop registers nothing.
registerServiceWorker();
