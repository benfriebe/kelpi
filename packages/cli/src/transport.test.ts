/**
 * Transport selection and failure rendering (cli.md §5.4/§5.5).
 *
 * The `Error:`/`Repair:` pairs are what a user sees when the CLI cannot reach Kelpi, and they
 * are quoted in issue threads, so they are pinned verbatim. Transport selection matters just
 * as much: a malformed `tcp:` value must fall back to the Unix socket SILENTLY rather than
 * erroring, which is what keeps a typo in a dev container from breaking every hook fire.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { setEnv } from './env.js';
import { resetIO, setIO } from './io.js';
import {
    describeTransportFailure,
    printTransportFailure,
    resolveTransport,
    sendJSONAndReadReply,
    setLastTransportFailure,
    setTransport,
    takeLastTransportFailure,
    UNIX_SOCKET_PATH
} from './transport.js';

afterEach(() => {
    resetIO();
    setLastTransportFailure(null);
    setEnv(process.env);
    setTransport(resolveTransport(process.env));
});

describe('resolveTransport', () => {
    it('defaults to the hardcoded unix socket', () => {
        expect(resolveTransport({})).toEqual({ kind: 'unix', path: UNIX_SOCKET_PATH });
        expect(resolveTransport({ KELPI_SOCKET: '' })).toEqual({ kind: 'unix', path: UNIX_SOCKET_PATH });
        expect(resolveTransport({ KELPI_SOCKET: '/tmp/other.sock' })).toEqual({ kind: 'unix', path: UNIX_SOCKET_PATH });
        // The Swift app's variable means nothing to this CLI: the two apps do not share a wire.
        expect(resolveTransport({ NEX_SOCKET: 'tcp:127.0.0.1:2' })).toEqual({ kind: 'unix', path: UNIX_SOCKET_PATH });
    });

    it('parses tcp:<host>:<port>', () => {
        expect(resolveTransport({ KELPI_SOCKET: 'tcp:127.0.0.1:19400' })).toEqual({
            kind: 'tcp',
            host: '127.0.0.1',
            port: 19400
        });
        expect(resolveTransport({ KELPI_SOCKET: 'tcp:host.docker.internal:19400' })).toEqual({
            kind: 'tcp',
            host: 'host.docker.internal',
            port: 19400
        });
    });

    it.each([
        ['tcp:'],
        ['tcp:host'],
        ['tcp:host:'],
        ['tcp::19400'],
        ['tcp:host:notaport'],
        ['tcp:host:99999'],
        // The host may not contain a colon: the split takes the FIRST colon only.
        ['tcp:host:12:34']
    ])('falls back to the unix socket for %j', (value) => {
        expect(resolveTransport({ KELPI_SOCKET: value })).toEqual({ kind: 'unix', path: UNIX_SOCKET_PATH });
    });
});

describe('KELPI_REQUIRE_SOCKET (the sandbox-harness guard)', () => {
    it('refuses to dial the default unix socket when set and KELPI_SOCKET is absent', async () => {
        setEnv({ KELPI_REQUIRE_SOCKET: '1' });
        setTransport({ kind: 'unix', path: UNIX_SOCKET_PATH });
        const reply = await sendJSONAndReadReply({ command: 'ping' });
        expect(reply).toBeNull();
        expect(takeLastTransportFailure()).toEqual({ kind: 'requiredSocketUnmet', raw: undefined });
    });

    it('refuses when the silent tcp fallback fired (the stale-NEX_SOCKET shape), quoting the value', async () => {
        // The 2026-08-31 wipe: the harness exported a route under the pre-rename name, the
        // resolver saw nothing, and every call silently addressed the live daemon. Under the
        // guard the same environment must refuse instead.
        const stale = { KELPI_REQUIRE_SOCKET: '1', KELPI_SOCKET: 'tcp:host:notaport' };
        setEnv(stale);
        setTransport(resolveTransport(stale));
        const reply = await sendJSONAndReadReply({ command: 'ping' });
        expect(reply).toBeNull();
        expect(takeLastTransportFailure()).toEqual({ kind: 'requiredSocketUnmet', raw: 'tcp:host:notaport' });
    });

    it('leaves a well-formed tcp route alone — the guard gates the fallback, not the dial', async () => {
        // Port 1 on loopback: nothing listens, so a REAL dial happens and fails as a tcp
        // connect error — proof the guard did not intercept a valid route.
        const routed = { KELPI_REQUIRE_SOCKET: '1', KELPI_SOCKET: 'tcp:127.0.0.1:1' };
        setEnv(routed);
        setTransport(resolveTransport(routed));
        const reply = await sendJSONAndReadReply({ command: 'ping' });
        expect(reply).toBeNull();
        expect(takeLastTransportFailure()?.kind).toBe('tcpConnectFailed');
    });
});

describe('describeTransportFailure', () => {
    it('explains the harness guard and names both env vars', () => {
        const [line, repair] = describeTransportFailure(
            { kind: 'requiredSocketUnmet', raw: undefined },
            'kelpi workspace delete'
        );
        expect(line).toBe(
            `kelpi workspace delete: KELPI_REQUIRE_SOCKET is set but KELPI_SOCKET names no tcp route (value: (unset)) — refusing to dial the default socket ${UNIX_SOCKET_PATH}.`
        );
        expect(repair).toContain('sandbox');
        const [quoted] = describeTransportFailure(
            { kind: 'requiredSocketUnmet', raw: 'tcp:host:notaport' },
            'kelpi pane list'
        );
        expect(quoted).toContain('"tcp:host:notaport"');
    });

    it('names the missing socket and points at the app', () => {
        const [line, repair] = describeTransportFailure(
            { kind: 'unixSocketMissing', path: '/tmp/nex.sock' },
            'kelpi pane close'
        );
        expect(line).toBe('kelpi pane close: cannot reach Kelpi — socket /tmp/nex.sock does not exist.');
        expect(repair).toBe(
            'Is Kelpi running? Launch the app, then retry. If Kelpi is running but using TCP, set KELPI_SOCKET=tcp:<host>:<port>.'
        );
    });

    it('calls out a stale socket file separately from a missing one', () => {
        const [line] = describeTransportFailure({ kind: 'unixConnectRefused', path: '/tmp/nex.sock' }, 'kelpi doctor');
        expect(line).toContain('exists but connect was refused');
        expect(line).toContain('stale socket from a previous crash');
    });

    it('quotes the host for a resolve failure and the port for a connect failure', () => {
        const [resolveLine, resolveRepair] = describeTransportFailure(
            { kind: 'tcpResolveFailed', host: 'host.docker.internal' },
            'kelpi pane list'
        );
        expect(resolveLine).toBe('kelpi pane list: cannot resolve host "host.docker.internal" (from KELPI_SOCKET).');
        expect(resolveRepair).toContain('tcp:host.docker.internal:<port>');

        const [connectLine, connectRepair] = describeTransportFailure(
            { kind: 'tcpConnectFailed', host: '127.0.0.1', port: 19400, errno: 61, message: 'Connection refused' },
            'kelpi pane list'
        );
        expect(connectLine).toBe('kelpi pane list: TCP connect to 127.0.0.1:19400 failed (errno 61: Connection refused).');
        expect(connectRepair).toContain('`tcp-port = 19400`');
    });

    it('attributes an empty reply to the WIRE command, not the CLI label', () => {
        const [line] = describeTransportFailure({ kind: 'emptyReply', command: 'pane-list' }, 'kelpi pane list');
        expect(line).toBe(
            'kelpi pane list: no response from Kelpi for `pane-list` (connected, then peer closed before replying).'
        );
    });
});

describe('printTransportFailure', () => {
    it('prints Error + Repair for request/response commands', () => {
        const err: string[] = [];
        setIO({ out: () => undefined, err: (text) => err.push(text) });
        setLastTransportFailure({ kind: 'unixSocketMissing', path: '/tmp/nex.sock' });
        printTransportFailure('kelpi pane list');
        expect(err.join('').split('\n')[0]?.startsWith('Error: ')).toBe(true);
        expect(err.join('')).toContain('\nRepair: ');
    });

    it('switches the prefix to Warning for fire-and-forget commands', () => {
        const err: string[] = [];
        setIO({ out: () => undefined, err: (text) => err.push(text) });
        setLastTransportFailure({ kind: 'unixSocketMissing', path: '/tmp/nex.sock' });
        printTransportFailure('kelpi event stop', { fireAndForget: true });
        expect(err.join('').startsWith('Warning: ')).toBe(true);
    });

    it('degrades to one line when nothing was captured', () => {
        const err: string[] = [];
        setIO({ out: () => undefined, err: (text) => err.push(text) });
        setLastTransportFailure(null);
        printTransportFailure('kelpi pane list');
        expect(err.join('')).toBe('kelpi pane list: transport failure (no diagnostic captured).\n');
    });
});
