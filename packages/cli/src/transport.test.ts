/**
 * Transport selection and failure rendering (cli.md §5.4/§5.5).
 *
 * The `Error:`/`Repair:` pairs are what a user sees when the CLI cannot reach Kelpi, and they
 * are quoted in issue threads, so they are pinned verbatim. Transport selection matters just
 * as much: a malformed `tcp:` value must fall back to the Unix socket SILENTLY rather than
 * erroring, which is what keeps a typo in a dev container from breaking every hook fire.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { resetIO, setIO } from './io.js';
import { describeTransportFailure, LEGACY_UNIX_SOCKET_PATH, printTransportFailure, resolveTransport, setLastTransportFailure, UNIX_SOCKET_PATH } from './transport.js';

/** Deterministic socket probes: tests never consult the real /tmp. */
const neither = () => false;
const onlyLegacy = (path: string) => path === LEGACY_UNIX_SOCKET_PATH;

afterEach(() => {
    resetIO();
    setLastTransportFailure(null);
});

describe('resolveTransport', () => {
    it('defaults to the hardcoded unix socket', () => {
        expect(resolveTransport({}, neither)).toEqual({ kind: 'unix', path: UNIX_SOCKET_PATH });
        expect(resolveTransport({ NEX_SOCKET: '' }, neither)).toEqual({ kind: 'unix', path: UNIX_SOCKET_PATH });
        expect(resolveTransport({ NEX_SOCKET: '/tmp/other.sock' }, neither)).toEqual({ kind: 'unix', path: UNIX_SOCKET_PATH });
    });

    it('falls back to the pre-rename socket only when it alone exists', () => {
        expect(resolveTransport({}, onlyLegacy)).toEqual({ kind: 'unix', path: LEGACY_UNIX_SOCKET_PATH });
        expect(resolveTransport({}, () => true)).toEqual({ kind: 'unix', path: UNIX_SOCKET_PATH });
    });

    it('honours KELPI_SOCKET over NEX_SOCKET', () => {
        expect(resolveTransport({ KELPI_SOCKET: 'tcp:127.0.0.1:1', NEX_SOCKET: 'tcp:127.0.0.1:2' })).toEqual({
            kind: 'tcp',
            host: '127.0.0.1',
            port: 1
        });
    });

    it('parses tcp:<host>:<port>', () => {
        expect(resolveTransport({ NEX_SOCKET: 'tcp:127.0.0.1:19400' })).toEqual({
            kind: 'tcp',
            host: '127.0.0.1',
            port: 19400
        });
        expect(resolveTransport({ NEX_SOCKET: 'tcp:host.docker.internal:19400' })).toEqual({
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
        expect(resolveTransport({ NEX_SOCKET: value }, neither)).toEqual({ kind: 'unix', path: UNIX_SOCKET_PATH });
    });
});

describe('describeTransportFailure', () => {
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
        expect(resolveLine).toBe('kelpi pane list: cannot resolve host "host.docker.internal" (from KELPI_SOCKET / NEX_SOCKET).');
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
