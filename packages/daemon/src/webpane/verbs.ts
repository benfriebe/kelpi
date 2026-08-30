/**
 * The host RPC vocabulary and its per-verb budgets.
 *
 * Verb names are the daemon↔host contract (`./HOST_PROTOCOL.md`), deliberately NOT the wire
 * command names: several `web-*` verbs collapse onto one host verb (every actuator verb is one
 * `actuate` call whose `method` names the `__kelpiAct` function), and the daemon adds lifecycle
 * verbs the CLI has no equivalent for (`pane-open`, `tab-select`, …).
 */

export const HOST_VERBS = [
    // lifecycle — daemon-owned state mirrored onto real browser views
    'pane-open',
    'pane-close',
    'pane-set-private',
    'tab-open',
    'tab-close',
    'tab-select',
    // navigation
    'navigate',
    'back',
    'forward',
    'reload',
    'url',
    'capture',
    // automation
    'actuate',
    'exec',
    'inspect-arm',
    'inspect-disarm',
    // storage
    'cookies-list',
    'cookies-clear',
    'cookies-delete'
] as const;
export type HostVerb = (typeof HOST_VERBS)[number];

/** Default budget for a snappy verb (a click, a navigate ack, a cookie read). */
export const HOST_TIMEOUT_DEFAULT_MS = 5_000;
/** A screenshot has to wait for pending screen updates, and `all` also serialises the DOM. */
export const HOST_TIMEOUT_CAPTURE_MS = 20_000;
/** `kelpi web exec` scripts routinely `await kelpi.wait(...)`; the CLI's own default is 30 s. */
export const HOST_TIMEOUT_EXEC_MS = 30_000;
/** Slack added on top of a caller-supplied wait budget so the host answers first. */
export const HOST_TIMEOUT_WAIT_SLACK_MS = 5_000;
/** `__kelpiAct.wait`'s own default when `timeout_ms` is 0/absent (web-pane.md §7.4). */
export const ACTUATOR_WAIT_DEFAULT_MS = 10_000;

/** `web-wait`: honour the wire budget, padded so the host's own timeout lands first. */
export function waitTimeoutMs(timeoutMs: number): number {
    const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : ACTUATOR_WAIT_DEFAULT_MS;
    return budget + HOST_TIMEOUT_WAIT_SLACK_MS;
}
