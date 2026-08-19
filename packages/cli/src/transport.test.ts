/**
 * Transport selection and failure rendering (cli.md §5.4/§5.5).
 *
 * The `Error:`/`Repair:` pairs are what a user sees when the CLI cannot reach Nex, and they
 * are quoted in issue threads, so they are pinned verbatim. Transport selection matters just
 * as much: a malformed `tcp:` value must fall back to the Unix socket SILENTLY rather than
 * erroring, which is what keeps a typo in a dev container from breaking every hook fire.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { resetIO, setIO } from './io.js';
import { describeTransportFailure, printTransportFailure, resolveTransport, setLastTransportFailure, UNIX_SOCKET_PATH } from './transport.js';

afterEach(() => {
    resetIO();
    setLastTransportFailure(null);
});

describe('resolveTransport', () => {
    it('defaults to the hardcoded unix socket', () => {
        expect(resolveTransport({})).toEqual({ kind: 'unix', path: UNIX_SOCKET_PATH });
        expect(resolveTransport({ NEX_SOCKET: '' })).toEqual({ kind: 'unix', path: UNIX_SOCKET_PATH });
        expect(resolveTransport({ NEX_SOCKET: '/tmp/other.sock' })).toEqual({ kind: 'unix', path: UNIX_SOCKET_PATH });
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
        expect(resolveTransport({ NEX_SOCKET: value })).toEqual({ kind: 'unix', path: UNIX_SOCKET_PATH });
    });
});

describe('describeTransportFailure', () => {
    it('names the missing socket and points at the app', () => {
        const [line, repair] = describeTransportFailure(
            { kind: 'unixSocketMissing', path: '/tmp/nex.sock' },
            'nex pane close'
        );
        expect(line).toBe('nex pane close: cannot reach Nex — socket /tmp/nex.sock does not exist.');
        expect(repair).toBe(
            'Is Nex running? Launch the app, then retry. If Nex is running but using TCP, set NEX_SOCKET=tcp:<host>:<port>.'
        );
    });

    it('calls out a stale socket file separately from a missing one', () => {
        const [line] = describeTransportFailure({ kind: 'unixConnectRefused', path: '/tmp/nex.sock' }, 'nex doctor');
        expect(line).toContain('exists but connect was refused');
        expect(line).toContain('stale socket from a previous crash');
    });

    it('quotes the host for a resolve failure and the port for a connect failure', () => {
        const [resolveLine, resolveRepair] = describeTransportFailure(
            { kind: 'tcpResolveFailed', host: 'host.docker.internal' },
            'nex pane list'
        );
        expect(resolveLine).toBe('nex pane list: cannot resolve host "host.docker.internal" (from NEX_SOCKET).');
        expect(resolveRepair).toContain('tcp:host.docker.internal:<port>');

        const [connectLine, connectRepair] = describeTransportFailure(
            { kind: 'tcpConnectFailed', host: '127.0.0.1', port: 19400, errno: 61, message: 'Connection refused' },
            'nex pane list'
        );
        expect(connectLine).toBe('nex pane list: TCP connect to 127.0.0.1:19400 failed (errno 61: Connection refused).');
        expect(connectRepair).toContain('`tcp-port = 19400`');
    });

    it('attributes an empty reply to the WIRE command, not the CLI label', () => {
        const [line] = describeTransportFailure({ kind: 'emptyReply', command: 'pane-list' }, 'nex pane list');
        expect(line).toBe(
            'nex pane list: no response from Nex for `pane-list` (connected, then peer closed before replying).'
        );
    });
});

describe('printTransportFailure', () => {
    it('prints Error + Repair for request/response commands', () => {
        const err: string[] = [];
        setIO({ out: () => undefined, err: (text) => err.push(text) });
        setLastTransportFailure({ kind: 'unixSocketMissing', path: '/tmp/nex.sock' });
        printTransportFailure('nex pane list');
        expect(err.join('').split('\n')[0]?.startsWith('Error: ')).toBe(true);
        expect(err.join('')).toContain('\nRepair: ');
    });

    it('switches the prefix to Warning for fire-and-forget commands', () => {
        const err: string[] = [];
        setIO({ out: () => undefined, err: (text) => err.push(text) });
        setLastTransportFailure({ kind: 'unixSocketMissing', path: '/tmp/nex.sock' });
        printTransportFailure('nex event stop', { fireAndForget: true });
        expect(err.join('').startsWith('Warning: ')).toBe(true);
    });

    it('degrades to one line when nothing was captured', () => {
        const err: string[] = [];
        setIO({ out: () => undefined, err: (text) => err.push(text) });
        setLastTransportFailure(null);
        printTransportFailure('nex pane list');
        expect(err.join('')).toBe('nex pane list: transport failure (no diagnostic captured).\n');
    });
});
