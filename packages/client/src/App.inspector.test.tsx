/**
 * Assembly for the workspace inspector and the sidebar's width (§WS-137…§WS-150, §WS-002).
 *
 * The panel itself is covered from a fixture in `chrome/Inspector.test.tsx`; what is checked
 * here is the wiring only assembly can have: ⌘I and the top-bar button open it, opening it
 * reads git over the socket, the reply's rows reach the panel, and each button leaves as the
 * expected wire command.
 */

import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import type { JsonObject } from '@kelpi/protocol';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { completeHandshake, createFakeSocketFactory, type FakeWebSocket } from './connection';
import { createKelpiRuntime, createKelpiStore } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const NOW = 1_755_500_000_000;
const REPO = 'EEEEEEEE-0000-4000-8000-000000000001';
const ASSOC = 'FFFFFFFF-0000-4000-8000-000000000001';

function snapshotState(): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({
        type: 'create-workspace',
        id: W1,
        paneID: PANE_A,
        name: 'dev',
        color: 'blue',
        now: NOW
    });
    store.dispatch({
        type: 'add-repo',
        repo: {
            id: REPO,
            path: '/src/app',
            name: 'app',
            remoteURL: null,
            lastAccessedAt: NOW / 1000,
            isAutoDiscovered: false
        }
    });
    store.dispatch({
        type: 'add-repo-association',
        workspaceID: W1,
        association: {
            id: ASSOC,
            repoID: REPO,
            worktreePath: '/src/app',
            branchName: 'main',
            isAutoDetected: false
        }
    });
    return store.getState() as unknown as JsonObject;
}

interface Harness {
    socket(): FakeWebSocket;
    sent(): Record<string, unknown>[];
    commands(): Record<string, unknown>[];
    /** Answer the last command of a given name, the way the daemon's async verbs do. */
    answer(command: string, reply: JsonObject): void;
}

function setup(): Harness {
    const sockets = createFakeSocketFactory();
    const runtime = createKelpiRuntime({
        url: 'ws://daemon.test/ws',
        token: 'tok',
        socketFactory: sockets.factory,
        store: createKelpiStore(),
        notifications: null,
        tokenStorage: null,
        heartbeatIntervalMs: 0,
        backoff: { initialMs: 10, maxMs: 10, factor: 1, jitter: 0 }
    });
    render(<App runtime={runtime} createRenderer={createFakeRendererFactory().factory} />);
    act(() => {
        completeHandshake(sockets.last(), { state: snapshotState() });
    });
    const sent = (): Record<string, unknown>[] => sockets.last().messages();
    const commands = (): Record<string, unknown>[] =>
        sent()
            .filter((message) => message['type'] === 'command')
            .map((message) => message['payload'] as Record<string, unknown>);
    return {
        socket: () => sockets.last(),
        sent,
        commands,
        answer(command, reply) {
            const message = [...sent()]
                .reverse()
                .find(
                    (entry) =>
                        entry['type'] === 'command' &&
                        (entry['payload'] as Record<string, unknown>)['command'] === command
                );
            if (message === undefined) throw new Error(`no ${command} command was sent`);
            act(() => {
                sockets.last().emit({ type: 'command-reply', id: message['id'] as string, reply });
            });
        }
    };
}

const STATUS_REPLY: JsonObject = {
    ok: true,
    workspace_id: W1,
    associations: [
        {
            id: ASSOC,
            repo_id: REPO,
            repo_name: 'app',
            repo_path: '/src/app',
            worktree_path: '/src/app',
            branch: 'main',
            is_worktree: false,
            status: { kind: 'dirty', changed_files: 2, additions: 9, deletions: 4 }
        }
    ]
};

const REGISTRY_REPLY: JsonObject = {
    ok: true,
    repos: [
        {
            id: REPO,
            name: 'app',
            path: '/src/app',
            remote_url: null,
            is_auto_discovered: false,
            worktree_base: '/Users/test/nex/worktrees/app'
        }
    ]
};

afterEach(cleanup);

async function openInspector(h: Harness): Promise<void> {
    fireEvent.click(screen.getByTestId('toggle-inspector'));
    await waitFor(() => {
        expect(screen.getByTestId('inspector')).toBeTruthy();
    });
    h.answer('repo-registry', REGISTRY_REPLY);
    h.answer('workspace-repo-status', STATUS_REPLY);
}

describe('the inspector', () => {
    it('opens from ⌘I and from the top-bar button, and reads git when it does', async () => {
        const h = setup();
        expect(screen.queryByTestId('inspector')).toBeNull();

        // `toggle_inspector` is bound to ⌘I by default (`core/config/bindings.ts`).
        fireEvent.keyDown(window, { code: 'KeyI', key: 'i', metaKey: true });
        await waitFor(() => {
            expect(screen.getByTestId('inspector')).toBeTruthy();
        });
        await waitFor(() => {
            expect(
                h.commands().some((command) => command['command'] === 'workspace-repo-status')
            ).toBe(true);
        });
        // §APP-071: the footer keeps this feed alive with the panel shut, so the FIRST read is
        // the cheap one (`refresh: false` — the daemon watcher's last known values). Opening the
        // panel is what asks the daemon to re-run git, so the open's read is the latest one.
        const reads = h.commands().filter((command) => command['command'] === 'workspace-repo-status');
        expect(reads[0]).toMatchObject({ workspace_id: W1, refresh: false });
        await waitFor(() => {
            const latest = h
                .commands()
                .filter((command) => command['command'] === 'workspace-repo-status')
                .at(-1);
            expect(latest).toMatchObject({ workspace_id: W1, refresh: true });
        });
        expect(h.commands().some((command) => command['command'] === 'repo-registry')).toBe(true);

        fireEvent.keyDown(window, { code: 'KeyI', key: 'i', metaKey: true });
        await waitFor(() => {
            expect(screen.queryByTestId('inspector')).toBeNull();
        });

        fireEvent.click(screen.getByTestId('toggle-inspector'));
        await waitFor(() => {
            expect(screen.getByTestId('inspector')).toBeTruthy();
        });
    });

    it('renders the association the daemon reported, with its dot and diff stats', async () => {
        const h = setup();
        await openInspector(h);
        await waitFor(() => {
            expect(screen.getByTestId(`inspector-assoc-${ASSOC}`)).toBeTruthy();
        });
        expect(screen.getByTestId('inspector-status-dot').getAttribute('data-status')).toBe('dirty');
        const stats = screen.getByTestId('inspector-stats');
        expect(stats.textContent).toContain('2 files');
        expect(stats.textContent).toContain('+9');
        expect(stats.textContent).toContain('-4');
    });

    it('opens a diff pane and a terminal for the association’s path', async () => {
        const h = setup();
        await openInspector(h);
        await waitFor(() => {
            expect(screen.getByTestId(`inspector-diff-${ASSOC}`)).toBeTruthy();
        });
        fireEvent.click(screen.getByTestId(`inspector-diff-${ASSOC}`));
        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({ command: 'diff', repo_path: '/src/app' });
        });
        fireEvent.click(screen.getByTestId(`inspector-terminal-${ASSOC}`), { shiftKey: true });
        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({
                command: 'pane-split',
                direction: 'vertical',
                path: '/src/app'
            });
        });
    });

    it('removes an association and creates a worktree through the WS verbs', async () => {
        const h = setup();
        await openInspector(h);
        await waitFor(() => {
            expect(screen.getByTestId(`inspector-assoc-menu-${ASSOC}`)).toBeTruthy();
        });

        fireEvent.click(screen.getByTestId('inspector-add-repo'));
        fireEvent.click(screen.getByText('New Worktree…'));
        fireEvent.change(screen.getByTestId('worktree-name'), { target: { value: 'login fix' } });
        // The preview is the daemon's own sanitization, resolved base path included.
        expect(screen.getByTestId('worktree-preview').textContent).toContain(
            '/Users/test/nex/worktrees/app/login-fix'
        );
        fireEvent.click(screen.getByTestId('worktree-create'));
        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({
                command: 'workspace-add-worktree',
                workspace_id: W1,
                repo_id: REPO,
                name: 'login fix',
                branch: 'login fix'
            });
        });
        h.answer('workspace-add-worktree', { ok: true, workspace_id: W1 });

        fireEvent.click(screen.getByTestId(`inspector-assoc-menu-${ASSOC}`));
        fireEvent.click(screen.getByText('Remove'));
        // The removal is followed by a re-read, so look it up by name rather than by position.
        await waitFor(() => {
            expect(
                h.commands().find((command) => command['command'] === 'remove-repo-association')
            ).toMatchObject({
                workspace_id: W1,
                association_id: ASSOC,
                delete_worktree: false
            });
        });
    });

    it('assigns a profile and recolours the workspace from the panel', async () => {
        const h = setup();
        await openInspector(h);
        fireEvent.click(screen.getByTestId('inspector-color-purple'));
        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({
                command: 'set-bulk-color',
                workspace_ids: [W1],
                color: 'purple'
            });
        });
    });
});

describe('the sidebar’s width (§WS-002)', () => {
    it('renders at 220 with a drag handle, and clamps a drag to 300', async () => {
        setup();
        const handle = screen.getByTestId('sidebar-resizer');
        const shell = handle.parentElement as HTMLElement;
        expect(shell.style.width).toBe('220px');

        handle.dispatchEvent(new MouseEvent('pointerdown', { clientX: 220, button: 0, bubbles: true }));
        act(() => {
            window.dispatchEvent(new MouseEvent('pointermove', { clientX: 700 }));
            window.dispatchEvent(new MouseEvent('pointerup', { clientX: 700 }));
        });
        await waitFor(() => {
            expect((screen.getByTestId('sidebar-resizer').parentElement as HTMLElement).style.width).toBe(
                '300px'
            );
        });
    });
});

/**
 * §APP-066 — "sidebar and inspector show/hide are animated".
 *
 * The sidebar half landed in burn-down 5; this is the clause that kept the item partial. What is
 * asserted here is the STATE MACHINE, not the appearance: that the panel is kept in the tree for
 * the length of a close (a conditional mount has nothing to transition from), that the slot
 * carries the same ~0.25s curve the sidebar's does, and that the panel is translated off the
 * TRAILING edge rather than the leading one. The picture is `docs/audit`'s `mac-chrome`.
 */
describe('the inspector’s slide (§APP-066)', () => {
    it('stays mounted for the length of a close, sliding off the trailing edge', async () => {
        setup();
        fireEvent.keyDown(window, { code: 'KeyI', key: 'i', metaKey: true });
        await waitFor(() => {
            expect(screen.getByTestId('inspector-slot').getAttribute('data-inspector-phase')).toBe(
                'open'
            );
        });

        const slot = screen.getByTestId('inspector-slot');
        const panel = screen.getByTestId('inspector-panel');
        // At rest: the slot holds the 280px the grid is pushed by, and the panel sits in it.
        expect(slot.style.width).toBe('280px');
        expect(panel.style.transform).toBe('translateX(0px)');
        expect(slot.style.transition).toContain('250ms');

        fireEvent.keyDown(window, { code: 'KeyI', key: 'i', metaKey: true });

        // Mid-close: still in the tree, slot collapsed (that is what moves the grid), panel
        // translated to the RIGHT — the mirror of the sidebar's `-width`.
        await waitFor(() => {
            expect(screen.getByTestId('inspector-slot').getAttribute('data-inspector-phase')).toBe(
                'closing'
            );
        });
        expect(screen.getByTestId('inspector-slot').style.width).toBe('0px');
        expect(screen.getByTestId('inspector-panel').style.transform).toBe('translateX(280px)');
        expect(screen.getByTestId('inspector-panel').style.opacity).toBe('0');
        expect(screen.getByTestId('inspector-panel').style.pointerEvents).toBe('none');
        // The panel is still there while it travels — the whole point.
        expect(screen.queryByTestId('inspector')).not.toBeNull();

        await waitFor(() => {
            expect(screen.queryByTestId('inspector-slot')).toBeNull();
        });
    });

    it('reverses mid-flight without a second animation', async () => {
        setup();
        // Open, then close, then re-open before the close has finished: the panel is already
        // mounted at the collapsed end, so it transitions straight back out.
        fireEvent.keyDown(window, { code: 'KeyI', key: 'i', metaKey: true });
        await waitFor(() => {
            expect(screen.getByTestId('inspector-slot').getAttribute('data-inspector-phase')).toBe(
                'open'
            );
        });
        fireEvent.keyDown(window, { code: 'KeyI', key: 'i', metaKey: true });
        await waitFor(() => {
            expect(screen.getByTestId('inspector-slot').getAttribute('data-inspector-phase')).toBe(
                'closing'
            );
        });
        fireEvent.keyDown(window, { code: 'KeyI', key: 'i', metaKey: true });

        expect(screen.getByTestId('inspector-slot').getAttribute('data-inspector-phase')).toBe('open');
        expect(screen.getByTestId('inspector-slot').style.width).toBe('280px');
    });
});
