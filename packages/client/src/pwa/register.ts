/**
 * Registering the service worker, and the three reasons not to.
 *
 * `main.tsx` calls `registerServiceWorker()` exactly once. The decision it makes is split out
 * as a pure function over four facts so every branch is a unit test rather than a browser.
 *
 * Every phone rule in `pwa/` is an owner-directed divergence from the shipped Swift app, which
 * has no phone UI, no install and no worker to be faithful to (`manifest.ts`'s header states
 * that once for the package).
 */

import { readShellWindowID } from '../webpane/shell-window';

/**
 * Where the worker is served from and what it controls.
 *
 * Both are literals with no query string and no fragment, and `register.test.ts` asserts that
 * shape rather than trusting it. Guardrail 3 of the phone program is that the token stays out
 * of URLs and caches, and a registration is the one call that would make a URL permanent: the
 * browser remembers the script URL and the scope for the life of the installation, re-fetches
 * that exact URL to check for updates, and shows it in the install metadata. A `?token=` here
 * would outlive the address-bar strip `app/config.ts` does on first sight, and the failure
 * would be silent because everything would work.
 *
 * The scope is `/` and the script sits at the site root so the scope is legal without any
 * header; the daemon sends `Service-Worker-Allowed: /` anyway (`daemon/src/ws/http.ts`), which
 * is what keeps that true if the file ever moves under `/assets/`.
 */
export const SERVICE_WORKER_URL = '/sw.js';
export const SERVICE_WORKER_SCOPE = '/';

/** The facts the decision is made on, so it can be made without a browser. */
export interface ServiceWorkerEnvironment {
    /** `'serviceWorker' in navigator`. */
    readonly supported: boolean;
    /** `readShellWindowID()`: non-null exactly when this page is inside an Electron window. */
    readonly shellWindowID: string | null;
    /** `window.isSecureContext`. */
    readonly secureContext: boolean;
    /** `location.hostname`, for the loopback case a host might not call secure. */
    readonly hostname: string;
}

/** Why the worker was or was not registered. Returned so a caller (and a test) can say. */
export type ServiceWorkerDecision =
    | 'register'
    | 'unsupported'
    | 'electron-shell'
    | 'insecure-origin';

/** Hostnames a browser treats as trustworthy over plain http. */
function isLoopback(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return (
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        host === '127.0.0.1' ||
        host === '::1'
    );
}

/**
 * The gate, in the order the reasons matter.
 *
 * 1. **No `serviceWorker` in `navigator`.** Some browsers, and every private window in Firefox.
 *    Nothing to do; the app is unaffected, because the worker is a launch nicety and never a
 *    dependency.
 *
 * 2. **The Electron shell.** The shell loads the SAME URL the browser does, so without this
 *    check the desktop app would install a worker on the daemon's origin, and every one of the
 *    shell's own asset loads would go through it. Guardrail 1 of the phone program is that
 *    desktop is untouched, and the cheapest way to keep a promise like that is to not run the
 *    code. The signal is `readShellWindowID()` from `webpane/shell-window.ts`, which the client
 *    already trusts for two other things: whether web panes get real pixels, and whether a
 *    notification click lands in this window. The shell appends `?shellWindow=<uuid>` and that
 *    marker deliberately survives `sanitizedSearch`, so it is still there after a reload, which
 *    is the property this gate needs. Note the plan's suggestion of `data-embedded` is a
 *    different thing: that attribute is on the web-pane element (`webpane/WebPane.tsx:927`) and
 *    describes whether a pane's page is drawn by a native view, not whether the client is in a
 *    shell.
 *
 * 3. **An insecure origin.** `navigator.serviceWorker` exists but `register()` rejects, and the
 *    rejection is an unhandled promise in the console of a page that is otherwise working.
 *    Deciding beforehand is quieter and says why. Loopback is checked as well as
 *    `isSecureContext` because loopback IS a secure context in every browser that matters, and
 *    the belt is free: it keeps `http://127.0.0.1:<port>` registering in an automation host
 *    whose flags say otherwise, which is what the `phone-pwa-shell` smoke runs on.
 */
export function serviceWorkerDecision(env: ServiceWorkerEnvironment): ServiceWorkerDecision {
    if (!env.supported) return 'unsupported';
    if (env.shellWindowID !== null) return 'electron-shell';
    if (!env.secureContext && !isLoopback(env.hostname)) return 'insecure-origin';
    return 'register';
}

/** The live facts. Undefined globals (a non-browser import) answer "unsupported". */
export function readServiceWorkerEnvironment(): ServiceWorkerEnvironment {
    const nav = (globalThis as { navigator?: Navigator }).navigator;
    const loc = (globalThis as { location?: Location }).location;
    return {
        supported: nav !== undefined && 'serviceWorker' in nav,
        shellWindowID: readShellWindowID(),
        secureContext: (globalThis as { isSecureContext?: boolean }).isSecureContext === true,
        hostname: loc?.hostname ?? ''
    };
}

/**
 * Register the worker, once, from `main.tsx`. Returns the decision; the registration itself is
 * fire-and-forget.
 *
 * Not deferred to the `load` event, which is the usual advice. The advice is about a worker's
 * install competing with the page's own first load for bandwidth, and there is nothing to
 * compete for here: `cache.addAll` is asking for the very files the document just pulled, and
 * the daemon serves `/assets/*` as `public, max-age=31536000, immutable`
 * (`daemon/src/ws/http.ts`), so the precache of the bundle is served out of the HTTP cache the
 * page has just filled. Only `/` and the six unhashed root files are `no-cache`, and those are
 * revalidations of a few kilobytes.
 *
 * A rejected registration is swallowed on purpose. The client is deliberately console-silent
 * (there is not one `console.warn` in `packages/client/src`), the `renderer-console` audit step
 * asserts zero distinct warnings, and there is nothing a person could do about it: an app whose
 * worker did not register is an app that works exactly as it did before this task.
 */
export function registerServiceWorker(
    env: ServiceWorkerEnvironment = readServiceWorkerEnvironment()
): ServiceWorkerDecision {
    const decision = serviceWorkerDecision(env);
    if (decision !== 'register') return decision;
    void navigator.serviceWorker
        .register(SERVICE_WORKER_URL, { scope: SERVICE_WORKER_SCOPE })
        .catch(() => undefined);
    return decision;
}
