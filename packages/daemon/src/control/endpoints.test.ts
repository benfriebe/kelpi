/// <reference types="node" />

import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_CONTROL_SOCKET_PATH, resolveControlEndpoints } from './endpoints.js';

describe('control endpoints', () => {
    it('defaults to the CLI-hardcoded /tmp/nex.sock with no TCP listener', () => {
        const endpoints = resolveControlEndpoints({});
        expect(endpoints.socketPath).toBe(DEFAULT_CONTROL_SOCKET_PATH);
        expect(endpoints.tcpPort).toBeUndefined();
        expect(endpoints.source).toEqual({ socketPath: 'default', tcpPort: 'none' });
    });

    it('honors NEXD_SOCKET_PATH and NEXD_TCP_PORT', () => {
        const endpoints = resolveControlEndpoints({ NEXD_SOCKET_PATH: '/tmp/nexd-dev.sock', NEXD_TCP_PORT: '19400' });
        expect(endpoints.socketPath).toBe('/tmp/nexd-dev.sock');
        expect(endpoints.tcpPort).toBe(19400);
        expect(endpoints.source).toEqual({ socketPath: 'env', tcpPort: 'env' });
    });

    it('expands a leading ~ in the socket path override', () => {
        const endpoints = resolveControlEndpoints({ NEXD_SOCKET_PATH: '~/nexd.sock' });
        expect(endpoints.socketPath).toBe(path.join(os.homedir(), 'nexd.sock'));
    });

    it('falls back to config values when the env is silent', () => {
        const endpoints = resolveControlEndpoints({}, { socketPath: '/tmp/from-config.sock', tcpPort: 19500 });
        expect(endpoints.socketPath).toBe('/tmp/from-config.sock');
        expect(endpoints.tcpPort).toBe(19500);
        expect(endpoints.source).toEqual({ socketPath: 'config', tcpPort: 'config' });
    });

    it('lets the env override the config file (dev daemon vs the running Swift app)', () => {
        const endpoints = resolveControlEndpoints({ NEXD_TCP_PORT: '19400' }, { tcpPort: 19500 });
        expect(endpoints.tcpPort).toBe(19400);
        expect(endpoints.source.tcpPort).toBe('env');
    });

    it('ignores a malformed or out-of-range NEXD_TCP_PORT', () => {
        for (const value of ['', '   ', 'abc', '-1', '70000', '80.5']) {
            expect(resolveControlEndpoints({ NEXD_TCP_PORT: value }).tcpPort).toBeUndefined();
        }
    });

    it('accepts port 0 (ephemeral) as an explicit request', () => {
        expect(resolveControlEndpoints({ NEXD_TCP_PORT: '0' }).tcpPort).toBe(0);
    });

    it('ignores an empty NEXD_SOCKET_PATH', () => {
        expect(resolveControlEndpoints({ NEXD_SOCKET_PATH: '  ' }).socketPath).toBe(DEFAULT_CONTROL_SOCKET_PATH);
    });
});
