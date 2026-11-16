import { describe, expect, it } from 'vitest';

import {
    agentOf,
    appBundleName,
    decodeLsofName,
    isInteractiveShell,
    isSessionManager,
    displayCommand,
    isExposedAddress,
    isShellCommandWrapper,
    parseDockerContainers,
    parseLsofCwd,
    parseLsofListen,
    parseCpuTime,
    parsePsTable,
    programName,
    splitHostPort
} from './parse.js';

// The probe runs `ps` under TZ=UTC, so `lstart` reads as UTC.
const utc = (year: number, month: number, day: number, h: number, m: number, s: number): number =>
    Math.floor(Date.UTC(year, month, day, h, m, s) / 1000);

describe('parsePsTable', () => {
    it('reads the columns, a single-digit day and a command line with spaces (macOS)', () => {
        const text = [
            '  872     1   872     0 483648 257:14.93 Wed Oct 21 10:01:45 2026     /Applications/Kelpi.app/Contents/Resources/node /Users/x/Library/Application Support/kelpid/terminal-host.js',
            '56153 56146 56097     0  46416   0:26.04 Wed Nov  4 16:42:29 2026     next-server (v15.5.28)',
            '44552   872 44552 45027  2048 1-02:03:04 Mon Nov  2 12:24:55 2026     /bin/zsh -l'
        ].join('\n');
        expect(parsePsTable(text)).toEqual([
            {
                pid: 872,
                ppid: 1,
                pgid: 872,
                tpgid: 0,
                rssBytes: 483_648 * 1024,
                cpuSeconds: 257 * 60 + 14.93,
                startedAt: utc(2026, 9, 21, 10, 1, 45),
                args: '/Applications/Kelpi.app/Contents/Resources/node /Users/x/Library/Application Support/kelpid/terminal-host.js'
            },
            {
                pid: 56153,
                ppid: 56146,
                pgid: 56097,
                tpgid: 0,
                rssBytes: 46_416 * 1024,
                cpuSeconds: 26.04,
                startedAt: utc(2026, 10, 4, 16, 42, 29),
                args: 'next-server (v15.5.28)'
            },
            {
                pid: 44552,
                ppid: 872,
                pgid: 44552,
                tpgid: 45027,
                rssBytes: 2048 * 1024,
                cpuSeconds: 86_400 + 2 * 3600 + 3 * 60 + 4,
                startedAt: utc(2026, 10, 2, 12, 24, 55),
                args: '/bin/zsh -l'
            }
        ]);
    });

    it("reads Linux procps's -1 tpgid as no terminal, and a zombie's empty command", () => {
        const rows = parsePsTable('  4242     1  4242    -1      0 00:00:00 Sat Nov 14 09:00:00 2026\n');
        expect(rows).toEqual([
            { pid: 4242, ppid: 1, pgid: 4242, tpgid: 0, rssBytes: 0, cpuSeconds: 0, startedAt: utc(2026, 10, 14, 9, 0, 0), args: '' }
        ]);
    });

    it("reads macOS's and Linux's CPU time, and keeps the row when it cannot", () => {
        expect(parseCpuTime('0:01.50')).toBe(1.5);
        expect(parseCpuTime('117:46.77')).toBeCloseTo(117 * 60 + 46.77);
        expect(parseCpuTime('01:02:03')).toBe(3723);
        expect(parseCpuTime('2-00:00:01')).toBe(172_801);
        expect(parseCpuTime('-')).toBe(0);
        expect(parsePsTable('  7     1     7     0     8 ?? Sat Nov 14 09:00:00 2026     odd\n')).toMatchObject([{ pid: 7, cpuSeconds: 0, args: 'odd' }]);
    });

    it('skips lines that are not rows', () => {
        expect(parsePsTable('PID PPID\n\ngarbage\n')).toEqual([]);
    });
});

describe('parseLsofListen', () => {
    it('reads IPv4, bracketed IPv6 and wildcard sockets per pid, without duplicates', () => {
        const text = [
            'p56153',
            'cnode',
            'f12',
            'n*:3200',
            'f13',
            'n*:3200',
            'p1853',
            'cnode',
            'f20',
            'n[::1]:61636',
            'p42986',
            'f3',
            'n127.0.0.1:8090',
            'f4',
            'n127.0.0.1:8090->127.0.0.1:50000'
        ].join('\n');
        const byPid = parseLsofListen(text);
        expect([...byPid.entries()]).toEqual([
            [56153, [{ address: '*', port: 3200 }]],
            [1853, [{ address: '::1', port: 61636 }]],
            [42986, [{ address: '127.0.0.1', port: 8090 }]]
        ]);
    });

    it('splits host and port', () => {
        expect(splitHostPort('[::]:6379')).toEqual({ address: '::', port: 6379 });
        expect(splitHostPort('localhost')).toBeNull();
        expect(splitHostPort('*:http')).toBeNull();
    });
});

describe('parseLsofCwd', () => {
    it('maps each pid to its working directory', () => {
        const text = 'p56153\nfcwd\nn/Users/x/worktrees/shop/demo/apps/admin-web\np1\nfcwd\nn/\n';
        expect([...parseLsofCwd(text).entries()]).toEqual([
            [56153, '/Users/x/worktrees/shop/demo/apps/admin-web'],
            [1, '/']
        ]);
    });
});

describe('decodeLsofName', () => {
    it("puts back the bytes lsof escapes, so a folder's real name matches", () => {
        expect(decodeLsofName('/w/\\xc3\\xa9t\\xc3\\xa9 dir')).toBe('/w/été dir');
        expect(decodeLsofName('/w/\\xf0\\x9f\\x93\\x9c notes')).toBe('/w/📜 notes');
        expect(decodeLsofName('/w/a\\tb\\\\c')).toBe('/w/a\tb\\c');
        // A character lsof printed as itself (a UTF-8 locale) is kept whole.
        expect(decodeLsofName('/w/📜\\x20x')).toBe('/w/📜 x');
        expect(decodeLsofName('/plain/path')).toBe('/plain/path');
    });

    it('decodes working directories', () => {
        expect([...parseLsofCwd('p7\nfcwd\nn/w/\\xc3\\xa9t\\xc3\\xa9\n').entries()]).toEqual([[7, '/w/été']]);
    });
});

describe('parseDockerContainers', () => {
    it('reads compose and Supabase labels, published tcp ports and the creation time', () => {
        const rows = parseDockerContainers([
            {
                Id: 'df6463c36a0bfc29a67c8c2410ba3579deadabc8be13b9285fccf5d92d6b14df',
                Names: ['/supabase_db_shop-7300'],
                Image: 'public.ecr.aws/supabase/postgres:15.19.0.007',
                Created: 1_794_665_303,
                Labels: {
                    'com.docker.compose.project': 'shop-7300',
                    'com.supabase.cli.project': 'shop-7300',
                    'com.supabase.cli.workdir': '/w/search-filters/packages'
                },
                Ports: [
                    { IP: '0.0.0.0', PrivatePort: 5432, PublicPort: 61622, Type: 'tcp' },
                    { IP: '::', PrivatePort: 5432, PublicPort: 61622, Type: 'tcp' },
                    { PrivatePort: 8080, Type: 'tcp' },
                    { IP: '0.0.0.0', PrivatePort: 53, PublicPort: 53, Type: 'udp' }
                ]
            },
            {
                Id: '30513f5e96a7aaaa',
                Names: ['/shop-7300-redis-1'],
                Image: 'redis:7-alpine',
                Created: 1_794_665_300,
                Labels: {
                    'com.docker.compose.project': 'shop-7300',
                    'com.docker.compose.service': 'redis',
                    'com.docker.compose.project.working_dir': '/w/search-filters/apps/api-server'
                },
                Ports: [{ IP: '', PrivatePort: 6379, PublicPort: 13679, Type: 'tcp' }]
            },
            'not a container',
            { Names: ['/no-id'] }
        ]);
        expect(rows).toEqual([
            {
                id: 'df6463c36a0bfc29a67c8c2410ba3579deadabc8be13b9285fccf5d92d6b14df',
                name: 'supabase_db_shop-7300',
                image: 'public.ecr.aws/supabase/postgres:15.19.0.007',
                project: 'shop-7300',
                service: null,
                directory: '/w/search-filters/packages',
                createdAt: 1_794_665_303,
                ports: [
                    { port: 61622, address: '0.0.0.0', containerPort: 5432 },
                    { port: 61622, address: '::', containerPort: 5432 }
                ]
            },
            {
                id: '30513f5e96a7aaaa',
                name: 'shop-7300-redis-1',
                image: 'redis:7-alpine',
                project: 'shop-7300',
                service: 'redis',
                directory: '/w/search-filters/apps/api-server',
                createdAt: 1_794_665_300,
                ports: [{ port: 13679, address: '0.0.0.0', containerPort: 6379 }]
            }
        ]);
    });

    it('reads anything that is not a list as no containers', () => {
        expect(parseDockerContainers({ message: 'nope' })).toEqual([]);
    });
});

describe('command helpers', () => {
    it('recognises Claude Code and Codex, however they were started', () => {
        expect(agentOf('claude')).toBe('claude');
        expect(agentOf('claude --resume abc')).toBe('claude');
        expect(agentOf('/Users/x/.local/share/claude/versions/2.1.325 --session-id 1')).toBe('claude');
        expect(agentOf('2.1.325 --session-id d0fc9435')).toBe('claude');
        expect(agentOf('node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js')).toBe('claude');
        expect(agentOf('codex')).toBe('codex');
        expect(agentOf('node /opt/node_modules/@openai/codex/bin/codex.js')).toBe('codex');
        expect(agentOf('node server.js')).toBeNull();
        expect(agentOf('next-server (v15.5.28)')).toBeNull();
        expect(agentOf('')).toBeNull();
    });

    it("spots an agent's shell wrapper but not an interactive shell", () => {
        expect(isShellCommandWrapper('/bin/zsh -c source /tmp/snap.sh && eval pnpm dev')).toBe(true);
        expect(isShellCommandWrapper('/bin/bash -lc pnpm dev')).toBe(true);
        expect(isShellCommandWrapper('bash --login script.sh')).toBe(false);
        expect(isShellCommandWrapper('/bin/zsh -l')).toBe(false);
        expect(isShellCommandWrapper('/bin/sh /Users/x/Library/pnpm/pnpm run dev')).toBe(false);
    });

    it('names an app bundle by its innermost app', () => {
        expect(appBundleName('/Applications/Google Drive.app/Contents/MacOS/Google Drive')).toBe('Google Drive');
        expect(appBundleName('/Applications/OrbStack.app/Contents/Frameworks/OrbStack Helper.app/Contents/MacOS/OrbStack Helper vmgr')).toBe(
            'OrbStack Helper'
        );
        expect(appBundleName('/Users/x/Applications/Tool.app/Contents/MacOS/Tool')).toBe('Tool');
        expect(appBundleName('/usr/local/bin/node server.js')).toBeNull();
    });

    it('does not take a language runtime, a bundled Electron or an argument for a desktop app', () => {
        expect(
            appBundleName('/opt/homebrew/Cellar/python@3.13/3.13.7/Frameworks/Python.framework/Versions/3.13/Resources/Python.app/Contents/MacOS/Python serve.py')
        ).toBeNull();
        expect(appBundleName('/Library/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python -m http.server')).toBeNull();
        expect(appBundleName('/w/app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .')).toBeNull();
        expect(appBundleName('node open.js /Applications/Notion.app/Contents/MacOS/Notion')).toBeNull();
    });

    it('tells an interactive shell from a script or a command', () => {
        expect(['-zsh', '/bin/zsh -l', 'bash --login', 'zsh', '/bin/zsh -i'].every(isInteractiveShell)).toBe(true);
        expect(isInteractiveShell('/bin/sh /Users/x/Library/pnpm/pnpm run dev')).toBe(false);
        expect(isInteractiveShell('/bin/zsh -c eval pnpm dev')).toBe(false);
        expect(isInteractiveShell('bash -lc pnpm dev')).toBe(false);
        expect(isInteractiveShell('node server.js')).toBe(false);
    });

    it('knows the processes that adopt orphans', () => {
        expect(isSessionManager('/sbin/launchd')).toBe(true);
        expect(isSessionManager('/usr/lib/systemd/systemd --user')).toBe(true);
        expect(isSessionManager('/sbin/init')).toBe(true);
        expect(isSessionManager('/bin/zsh -l')).toBe(false);
    });

    it('shows a command the way a person would type it', () => {
        expect(displayCommand('/bin/sh /Users/x/Library/pnpm/pnpm run dev:prebuilt')).toBe('pnpm run dev:prebuilt');
        expect(displayCommand('/opt/homebrew/bin/python3 -m http.server 8765')).toBe('python3 -m http.server 8765');
        expect(displayCommand('/bin/zsh -l')).toBe('zsh -l');
        expect(displayCommand(`node ${'x'.repeat(100)}`)).toHaveLength(80);
        expect(programName('next-server (v15.5.28)')).toBe('next-server');
    });

    it('knows which addresses every machine on the network can reach', () => {
        expect(['*', '0.0.0.0', '::', '[::]'].every(isExposedAddress)).toBe(true);
        expect(['127.0.0.1', '::1', '192.168.1.20'].some(isExposedAddress)).toBe(false);
    });
});
