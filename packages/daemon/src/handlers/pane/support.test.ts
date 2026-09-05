import { describe, expect, it } from 'vitest';

import type { HandlerContext } from '../../seams.js';
import type { DaemonState, DomainAction, DomainEvent } from '../../store/index.js';
import type { PaneHandlerContext } from './context.js';
import { paneHandlers } from './index.js';
import { spawnEnvVars, spawnPaneIfShell, tailLines, wireTimestamp } from './support.js';
import { NOW, W1, harness, seedWorkspace, testID } from './testing.js';

const P1 = testID('1', 1);

describe('tailLines', () => {
    it('keeps empty segments and the trailing newline', () => {
        expect(tailLines('a\n\nb\nc\n', 3)).toBe('\nb\nc\n');
        expect(tailLines('a\n\nb\nc', 3)).toBe('\nb\nc');
    });

    it('returns the whole text when it has fewer lines than requested', () => {
        expect(tailLines('one\ntwo\n', 10)).toBe('one\ntwo\n');
    });

    it('is empty for a non-positive count or empty text', () => {
        expect(tailLines('a\nb\n', 0)).toBe('');
        expect(tailLines('a\nb\n', -1)).toBe('');
        expect(tailLines('', 5)).toBe('');
    });

    it('handles a single line with no newline at all', () => {
        expect(tailLines('solo', 1)).toBe('solo');
        expect(tailLines('solo\n', 1)).toBe('solo\n');
    });
});

describe('wireTimestamp', () => {
    it('formats epoch SECONDS as ISO 8601 UTC without milliseconds', () => {
        expect(wireTimestamp(NOW / 1000)).toBe('2025-08-18T06:53:20Z');
        expect(wireTimestamp(1755500000.75)).toBe('2025-08-18T06:53:20Z');
    });
});

describe('spawnEnvVars', () => {
    it('orders NEX_PANE_ID, PATH, then the profile vars sorted by key', () => {
        const h = harness();
        seedWorkspace(h, { id: W1, name: 'dev', paneID: P1 });
        const ctx = {
            ...h.ctx,
            profiles: () => [
                {
                    name: 'default',
                    env: { ZED: '1', ALPHA: '2', PATH: '/hijack', KELPI_PANE_ID: 'spoof' }
                }
            ]
        };

        expect(spawnEnvVars(ctx, P1, h.workspace(W1))).toEqual([
            { key: 'KELPI_PANE_ID', value: P1 },
            { key: 'PATH', value: '/opt/kelpi/helpers:/usr/bin' },
            { key: 'ALPHA', value: '2' },
            { key: 'KELPI_PROFILE', value: 'default' },
            { key: 'ZED', value: '1' }
        ]);
    });

    it('resolves the workspace profile assignment and never emits an empty PATH element', () => {
        const h = harness();
        seedWorkspace(h, { id: W1, name: 'dev', paneID: P1 });
        h.store.dispatch({ type: 'set-workspace-profile', id: W1, profileName: 'work' });
        const ctx = {
            ...h.ctx,
            spawn: { inheritedPath: '/usr/bin' },
            profiles: () => [{ name: 'work', env: { CLAUDE_CONFIG_DIR: '/w' } }]
        };

        expect(spawnEnvVars(ctx, P1, h.workspace(W1))).toEqual([
            { key: 'KELPI_PANE_ID', value: P1 },
            { key: 'PATH', value: '/usr/bin' },
            { key: 'CLAUDE_CONFIG_DIR', value: '/w' },
            { key: 'KELPI_PROFILE', value: 'work' },
        ]);
    });

    // §SET-209: the marker is injected either way, but an assignment nothing defines is
    // almost always a typo, and silence makes it look like it worked.
    it('warns when a non-default profile has no definitions, and still injects the marker', () => {
        const h = harness();
        seedWorkspace(h, { id: W1, name: 'dev', paneID: P1 });
        h.store.dispatch({ type: 'set-workspace-profile', id: W1, profileName: 'ghost' });
        const logs: string[] = [];
        const ctx = {
            ...h.ctx,
            spawn: { inheritedPath: '/usr/bin' },
            profiles: () => [{ name: 'work', env: { CLAUDE_CONFIG_DIR: '/w' } }],
            onLog: (message: string) => logs.push(message)
        };

        expect(spawnEnvVars(ctx, P1, h.workspace(W1))).toEqual([
            { key: 'KELPI_PANE_ID', value: P1 },
            { key: 'PATH', value: '/usr/bin' },
            { key: 'KELPI_PROFILE', value: 'ghost' },
        ]);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain('"ghost"');
        expect(logs[0]).toContain('dev');
        // The hint names the file and marker Kelpi really uses, not the pre-port ones (#46).
        expect(logs[0]).toContain('~/.config/kelpi/config; only KELPI_PROFILE will be set');
    });

    it('never warns about an empty default profile, which is the expected state', () => {
        const h = harness();
        seedWorkspace(h, { id: W1, name: 'dev', paneID: P1 });
        const logs: string[] = [];
        const ctx = {
            ...h.ctx,
            spawn: { inheritedPath: '/usr/bin' },
            // No `default` definition at all — the built-in baseline is virtual until it has
            // vars (§SET-206), so this is the shipped configuration, not a mistake.
            profiles: () => [],
            onLog: (message: string) => logs.push(message)
        };

        expect(spawnEnvVars(ctx, P1, h.workspace(W1))).toEqual([
            { key: 'KELPI_PANE_ID', value: P1 },
            { key: 'PATH', value: '/usr/bin' },
            { key: 'KELPI_PROFILE', value: 'default' },
        ]);
        expect(logs).toEqual([]);
    });

    it('does not warn for a profile the config file does define', () => {
        const h = harness();
        seedWorkspace(h, { id: W1, name: 'dev', paneID: P1 });
        h.store.dispatch({ type: 'set-workspace-profile', id: W1, profileName: 'work' });
        const logs: string[] = [];
        const ctx = {
            ...h.ctx,
            spawn: { inheritedPath: '/usr/bin' },
            profiles: () => [{ name: 'work', env: { CLAUDE_CONFIG_DIR: '/w' } }],
            onLog: (message: string) => logs.push(message)
        };

        spawnEnvVars(ctx, P1, h.workspace(W1));
        expect(logs).toEqual([]);
    });
});

describe('spawnPaneIfShell', () => {
    it('spawns a new pane at the last-known grid rather than 80×24', () => {
        // A split's child has no history of its own, so the geometry cache answers with the
        // grid the window was last rendered at — anything beats a shell that draws its first
        // prompt 80 columns wide into a 200-column pane, because it never reflows.
        const h = harness();
        seedWorkspace(h, { id: W1, name: 'dev', paneID: P1 });
        const ctx: PaneHandlerContext = {
            ...h.ctx,
            spawn: { ...h.ctx.spawn, sizeFor: () => ({ cols: 169, rows: 47 }) }
        };

        spawnPaneIfShell(ctx, W1, P1);

        expect(h.pty.spawns[0]?.cols).toBe(169);
        expect(h.pty.spawns[0]?.rows).toBe(47);
    });

    it('keeps the configured default when nothing is remembered', () => {
        const h = harness();
        seedWorkspace(h, { id: W1, name: 'dev', paneID: P1 });

        spawnPaneIfShell({ ...h.ctx, spawn: { ...h.ctx.spawn, sizeFor: () => null } }, W1, P1);

        expect(h.pty.spawns[0]?.cols).toBe(80);
        expect(h.pty.spawns[0]?.rows).toBe(24);
    });

    /**
     * The deferral half (`pty/spawn-gate.ts`). The cache's answer for a pane it has never seen
     * is a guess — for a split's child it is the PARENT's full width — and a guess printed at
     * the top of the scrollback is permanent. When boot says a client is about to measure the
     * pane, this function hands the spawn over instead of guessing.
     */
    it('hands a never-seen pane to the gate instead of spawning it', () => {
        const h = harness();
        seedWorkspace(h, { id: W1, name: 'dev', paneID: P1 });
        const deferred: ((size: { cols: number; rows: number } | null) => void)[] = [];
        const ctx: PaneHandlerContext = {
            ...h.ctx,
            spawn: {
                ...h.ctx.spawn,
                sizeFor: () => ({ cols: 169, rows: 47 }),
                deferSpawn: (_paneID, spawn) => {
                    deferred.push(spawn);
                    return true;
                }
            }
        };

        spawnPaneIfShell(ctx, W1, P1);
        expect(h.pty.spawns).toEqual([]); // nothing is born until somebody measures it

        deferred[0]?.({ cols: 84, rows: 47 });

        // The client's own measurement of THIS pane, not the cache's guess about its parent.
        expect(h.pty.spawns[0]?.cols).toBe(84);
        expect(h.pty.spawns[0]?.rows).toBe(47);
        expect(h.term.attached).toContainEqual({ paneID: P1, cols: 84, rows: 47 });
    });

    it('falls back to the remembered grid when the gate gives up waiting', () => {
        const h = harness();
        seedWorkspace(h, { id: W1, name: 'dev', paneID: P1 });
        const deferred: ((size: { cols: number; rows: number } | null) => void)[] = [];
        const ctx: PaneHandlerContext = {
            ...h.ctx,
            spawn: {
                ...h.ctx.spawn,
                sizeFor: () => ({ cols: 169, rows: 47 }),
                deferSpawn: (_paneID, spawn) => {
                    deferred.push(spawn);
                    return true;
                }
            }
        };

        spawnPaneIfShell(ctx, W1, P1);
        deferred[0]?.(null); // the timeout: "you were right, use your fallback"

        expect(h.pty.spawns[0]?.cols).toBe(169);
        expect(h.pty.spawns[0]?.rows).toBe(47);
    });

    it('never spawns a pane that was closed while its spawn waited', () => {
        const h = harness();
        seedWorkspace(h, { id: W1, name: 'dev', paneID: P1 });
        const deferred: ((size: { cols: number; rows: number } | null) => void)[] = [];
        const ctx: PaneHandlerContext = {
            ...h.ctx,
            spawn: {
                ...h.ctx.spawn,
                deferSpawn: (_paneID, spawn) => {
                    deferred.push(spawn);
                    return true;
                }
            }
        };

        spawnPaneIfShell(ctx, W1, P1);
        // The gate cancels on `pty.kill`, but state can also move under a spawn that is
        // already running: the callback re-reads the store rather than trusting its closure.
        h.store.dispatch({ type: 'close-pane', workspaceID: W1, paneID: P1 });
        deferred[0]?.({ cols: 100, rows: 40 });

        expect(h.pty.spawns).toEqual([]);
    });

    it('spawns immediately when the gate declines — the CLI/headless daemon', () => {
        const h = harness();
        seedWorkspace(h, { id: W1, name: 'dev', paneID: P1 });
        const ctx: PaneHandlerContext = {
            ...h.ctx,
            spawn: { ...h.ctx.spawn, sizeFor: () => null, deferSpawn: () => false }
        };

        spawnPaneIfShell(ctx, W1, P1);

        expect(h.pty.spawns[0]?.cols).toBe(80);
        expect(h.pty.spawns[0]?.rows).toBe(24);
    });
});

describe('the context widening', () => {
    it('accepts a bare HandlerContext, so boot can compose one object for every family', () => {
        const h = harness();
        // Type-level assertion: the extra members are all optional, so the seam's own
        // instantiation satisfies `PaneHandlerContext`.
        const base: HandlerContext<DaemonState, DomainAction, DomainEvent> = h.ctx;
        const widened: PaneHandlerContext = base;

        expect(widened.store).toBe(h.store);
        expect(widened.version.protocol).toBe(1);
    });
});

describe('the handler table', () => {
    it('covers exactly the pane-* wire commands this work package owns', () => {
        expect([...paneHandlers.keys()].sort()).toEqual(
            [
                'pane-capture',
                'pane-close',
                'pane-create',
                'pane-list',
                'pane-move',
                'pane-move-adjacent',
                'pane-move-to-workspace',
                'pane-name',
                'pane-resize',
                'pane-send',
                'pane-send-key',
                'pane-split',
                'pane-sync',
                'pane-sync-exclude'
            ].sort()
        );
    });

    it('ignores a message whose command it does not own', () => {
        const h = harness();
        seedWorkspace(h, { id: W1, name: 'dev', paneID: P1 });
        const handler = paneHandlers.get('pane-close');
        const reply = { payloads: [] as unknown[] };

        handler?.({ command: 'ping' }, h.ctx, {
            send: (payload) => reply.payloads.push(payload),
            close: () => undefined,
            closed: false,
            onDisconnect: () => undefined
        });

        expect(reply.payloads).toEqual([]);
    });
});
