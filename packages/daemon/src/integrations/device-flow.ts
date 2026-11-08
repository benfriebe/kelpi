/**
 * GitHub's OAuth device flow, polled by the DAEMON (docs/integrations.md §9.3), so a link survives
 * the Settings window closing and a phone can start one for the desktop's daemon.
 *
 *   start   POST https://github.com/login/device/code {client_id, scope: repo}
 *           → device_code (kept in this closure, nowhere else), user_code + verification_uri
 *             (returned ONCE, to the session that asked), expires_in, interval
 *   poll    every `interval` seconds (at least 5): POST /login/oauth/access_token
 *             {client_id, device_code, grant_type: urn:ietf:params:oauth:grant-type:device_code}
 *           GitHub answers HTTP 200 with `error` while it is not done:
 *             authorization_pending         keep polling
 *             slow_down                     poll less often: the `interval` it returns (else +5 s)
 *             expired_token                 failed: expired
 *             access_denied                 failed: denied
 *             device_flow_disabled          failed: disabled
 *             incorrect_client_credentials, incorrect_device_code, unsupported_grant_type,
 *             anything else                 failed: error
 *           a transport failure, a timeout or a 5xx is retried up to 3 times, backing off;
 *           the code's own deadline ends the flow as expired without asking again
 *   token   handed to `onToken` (the service verifies it with GET /user, stores it, broadcasts)
 *
 * One flow per provider: a new start replaces the pending one (the first window sees the new
 * `flowID` in `integrations-changed` and resets), `cancel(flowID)` cancels only that flow, and
 * `dispose` (daemon stop and handoff) aborts the in-flight request and drops the flow, device code
 * and all; the successor daemon knows nothing of it and the client resets on reconnect.
 *
 * The device code and the token never reach a log line, a status, an error message or a reply.
 */

import { randomUUID } from 'node:crypto';

import { isGitHubWebURL, type IntegrationLinkFailureReason, type WsIntegrationLinking } from '@kelpi/protocol';

import { TicketServiceError } from '../handlers/app/context.js';
import type { GitHubHttp } from './http.js';

export const DEVICE_CODE_PATH = '/login/device/code';
export const ACCESS_TOKEN_PATH = '/login/oauth/access_token';
export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
/** RFC 8628's floor, and GitHub's. */
export const MIN_POLL_INTERVAL_S = 5;
/** `slow_down` without an `interval`: add this much. */
export const SLOW_DOWN_STEP_S = 5;
/** Transport failures in a row before the flow gives up. */
export const MAX_TRANSIENT_RETRIES = 3;
/** GitHub's codes last 15 minutes; never trust a promise of longer than this. */
const MAX_EXPIRES_IN_S = 1_800;

export interface DeviceFlowStart {
    readonly flowID: string;
    readonly userCode: string;
    readonly verificationURI: string;
    readonly expiresIn: number;
    readonly interval: number;
}

export interface DeviceFlowToken {
    readonly accessToken: string;
    readonly tokenType: string;
}

export interface DeviceFlowOptions {
    readonly http: GitHubHttp;
    readonly clientID: string;
    /** Called once with the token; a rejection fails the flow with its message (a `TicketServiceError`'s, or a generic one). */
    readonly onToken: (token: DeviceFlowToken, signal: AbortSignal) => Promise<void>;
    /** The pending/failed state changed (start, slow down excluded, failure, success, cancel). */
    readonly onChange: () => void;
    readonly now?: (() => number) | undefined;
    readonly newFlowID?: (() => string) | undefined;
    readonly log?: ((line: string) => void) | undefined;
}

export interface DeviceFlow {
    /** Start a flow (replacing any pending one). Rejects with a `TicketServiceError`. */
    start(signal?: AbortSignal): Promise<DeviceFlowStart>;
    /** Cancel the pending flow, or only `flowID`'s. True when a pending flow was cancelled. */
    cancel(flowID?: string): boolean;
    /** What the status carries: the pending flow or how the last one ended; undefined when neither. */
    linking(): WsIntegrationLinking | undefined;
    /** Forget any failed state (a successful link by another path). */
    clearFailure(): void;
    /** Stop and handoff: abort, clear timers, drop the flow. Later calls to `start` are refused. */
    dispose(): void;
}

interface PendingFlow {
    readonly flowID: string;
    /** Never leaves this object. */
    readonly deviceCode: string;
    readonly expiresAt: number;
    interval: number;
    transientFailures: number;
    timer: ReturnType<typeof setTimeout> | null;
    readonly controller: AbortController;
}

const FAILURE_MESSAGES: Readonly<Record<string, { reason: IntegrationLinkFailureReason; message: string }>> = {
    expired_token: { reason: 'expired', message: 'The code expired before it was entered: start again' },
    access_denied: { reason: 'denied', message: 'The request was denied at GitHub' },
    device_flow_disabled: { reason: 'disabled', message: "GitHub's device flow is disabled for Kelpi's app: link a personal access token instead" },
    incorrect_client_credentials: { reason: 'error', message: "GitHub did not recognize Kelpi's app: link a personal access token instead" },
    incorrect_device_code: { reason: 'error', message: 'GitHub did not recognize the device code: start again' },
    unsupported_grant_type: { reason: 'error', message: 'GitHub refused the request: start again' }
};

function positiveNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function createDeviceFlow(options: DeviceFlowOptions): DeviceFlow {
    const now = options.now ?? (() => Date.now());
    const newFlowID = options.newFlowID ?? (() => randomUUID());
    const log = options.log ?? ((): void => {});
    let pending: PendingFlow | null = null;
    let failed: Extract<WsIntegrationLinking, { state: 'failed' }> | null = null;
    let disposed = false;

    const stopFlow = (flow: PendingFlow): void => {
        if (flow.timer !== null) clearTimeout(flow.timer);
        flow.timer = null;
        flow.controller.abort(new Error('device flow stopped'));
        if (pending === flow) pending = null;
    };

    const fail = (flow: PendingFlow, reason: IntegrationLinkFailureReason, message: string): void => {
        if (pending !== flow) return;
        stopFlow(flow);
        failed = { state: 'failed', flowID: flow.flowID, reason, message };
        log(`integrations: github device flow ended (${reason})`);
        options.onChange();
    };

    const schedule = (flow: PendingFlow, delayS: number): void => {
        if (pending !== flow) return;
        const remainingMs = flow.expiresAt - now();
        if (remainingMs <= 0) {
            fail(flow, 'expired', FAILURE_MESSAGES['expired_token']!.message);
            return;
        }
        // Poll no later than the deadline, so an expired code is noticed when it expires.
        const delayMs = Math.min(delayS * 1000, remainingMs);
        flow.timer = setTimeout(() => {
            flow.timer = null;
            void poll(flow);
        }, delayMs);
        flow.timer.unref?.();
    };

    const poll = async (flow: PendingFlow): Promise<void> => {
        if (pending !== flow) return;
        if (now() >= flow.expiresAt) {
            fail(flow, 'expired', FAILURE_MESSAGES['expired_token']!.message);
            return;
        }
        let answer: Readonly<Record<string, unknown>>;
        try {
            answer = await options.http.loginPost(
                ACCESS_TOKEN_PATH,
                { client_id: options.clientID, device_code: flow.deviceCode, grant_type: DEVICE_GRANT_TYPE },
                flow.controller.signal
            );
        } catch (error) {
            if (pending !== flow) return;
            flow.transientFailures += 1;
            if (flow.transientFailures > MAX_TRANSIENT_RETRIES) {
                fail(flow, 'error', error instanceof TicketServiceError ? error.message : 'Could not reach GitHub: check the network');
                return;
            }
            // Back off: the interval, doubled per failure in a row.
            schedule(flow, flow.interval * 2 ** flow.transientFailures);
            return;
        }
        if (pending !== flow) return;
        flow.transientFailures = 0;
        const token = answer['access_token'];
        if (typeof token === 'string' && token !== '') {
            const tokenType = typeof answer['token_type'] === 'string' && answer['token_type'] !== '' ? answer['token_type'] : 'bearer';
            try {
                await options.onToken({ accessToken: token, tokenType }, flow.controller.signal);
            } catch (error) {
                fail(flow, 'error', error instanceof TicketServiceError ? error.message : 'GitHub linked, but Kelpi could not save the credential');
                return;
            }
            if (pending !== flow) return;
            stopFlow(flow);
            failed = null;
            log('integrations: github device flow completed');
            options.onChange();
            return;
        }
        const code = typeof answer['error'] === 'string' ? answer['error'] : '';
        if (code === 'authorization_pending') {
            schedule(flow, flow.interval);
            return;
        }
        if (code === 'slow_down') {
            const asked = positiveNumber(answer['interval']);
            flow.interval = Math.max(MIN_POLL_INTERVAL_S, asked ?? flow.interval + SLOW_DOWN_STEP_S);
            schedule(flow, flow.interval);
            return;
        }
        const known = FAILURE_MESSAGES[code];
        fail(flow, known?.reason ?? 'error', known?.message ?? 'GitHub ended the request: start again');
    };

    return {
        async start(signal) {
            if (disposed) throw new TicketServiceError('unavailable', 'The daemon is stopping');
            if (options.clientID === '') {
                throw new TicketServiceError('unavailable', "This build of Kelpi has no GitHub app for the device flow: link a personal access token instead");
            }
            const answer = await options.http.loginPost(DEVICE_CODE_PATH, { client_id: options.clientID, scope: 'repo' }, signal);
            if (disposed) throw new TicketServiceError('unavailable', 'The daemon is stopping');
            const code = typeof answer['error'] === 'string' ? answer['error'] : null;
            if (code === 'device_flow_disabled' || code === 'incorrect_client_credentials' || code === 'unauthorized_client') {
                throw new TicketServiceError('unavailable', FAILURE_MESSAGES[code === 'unauthorized_client' ? 'incorrect_client_credentials' : code]!.message);
            }
            if (code !== null) throw new TicketServiceError('github-error', 'GitHub refused to start the device flow');
            const deviceCode = answer['device_code'];
            const userCode = answer['user_code'];
            const verificationURI = answer['verification_uri'];
            const expiresIn = positiveNumber(answer['expires_in']);
            const interval = positiveNumber(answer['interval']);
            if (
                typeof deviceCode !== 'string' ||
                deviceCode === '' ||
                deviceCode.length > 512 ||
                typeof userCode !== 'string' ||
                !/^[A-Za-z0-9-]{4,32}$/.test(userCode) ||
                !isGitHubWebURL(verificationURI) ||
                expiresIn === null
            ) {
                throw new TicketServiceError('github-error', 'GitHub answered the device flow with something Kelpi cannot use');
            }
            if (pending !== null) stopFlow(pending);
            const flow: PendingFlow = {
                flowID: newFlowID(),
                deviceCode,
                expiresAt: now() + Math.min(expiresIn, MAX_EXPIRES_IN_S) * 1000,
                interval: Math.max(MIN_POLL_INTERVAL_S, interval ?? MIN_POLL_INTERVAL_S),
                transientFailures: 0,
                timer: null,
                controller: new AbortController()
            };
            pending = flow;
            failed = null;
            schedule(flow, flow.interval);
            log('integrations: github device flow started');
            options.onChange();
            return {
                flowID: flow.flowID,
                userCode,
                verificationURI,
                expiresIn: Math.round((flow.expiresAt - now()) / 1000),
                interval: flow.interval
            };
        },

        cancel(flowID) {
            if (pending !== null && (flowID === undefined || pending.flowID === flowID)) {
                stopFlow(pending);
                failed = null;
                log('integrations: github device flow cancelled');
                options.onChange();
                return true;
            }
            // A failed flow's state is dismissed by its own cancel; it was not pending, so `false`.
            if (pending === null && failed !== null && (flowID === undefined || failed.flowID === flowID)) {
                failed = null;
                options.onChange();
            }
            return false;
        },

        linking() {
            if (pending !== null) return { state: 'pending', flowID: pending.flowID, expiresAt: pending.expiresAt };
            return failed ?? undefined;
        },

        clearFailure() {
            failed = null;
        },

        dispose() {
            disposed = true;
            if (pending !== null) stopFlow(pending);
            failed = null;
        }
    };
}
