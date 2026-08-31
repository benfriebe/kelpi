/**
 * §APP-116 — the one-shot legacy-label → preset migration.
 *
 * Spec: app-state-core.md §6.5 (gate + walk), §6.4 (`addLabelPreset` is idempotent by name),
 * §13 note 13 (the marker must be set on fresh installs too); persistence.md §6.2 step 9.
 *
 * The three properties that matter, and the reason each one is here:
 *   1. a LEGACY database (labels applied, presets absent, no marker) comes up with a gray
 *      preset for every label — otherwise those labels are invisible in Settings ▸ Labels and
 *      vanish for good the moment they are unapplied;
 *   2. a preset that already exists is not touched, so a colour the user chose survives;
 *   3. it runs EXACTLY once — proven here by a spy on the walk and, end to end, by deleting a
 *      preset whose label is still applied and restarting: the delete must stick.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { leaf } from '@kelpi/core/layout';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPersistence, openSqliteDatabase, APP_STATE_LABEL_PRESETS_MIGRATED } from '../db/index.js';
import {
    createStore,
    emptyDaemonState,
    fromSnapshot,
    toSnapshot,
    type DaemonState,
    type LabelPreset,
    type PersistedSnapshot,
    type PersistedWorkspace
} from '../store/index.js';
import { serializeState } from '../ws/index.js';
import { createDaemon, type Daemon } from './compose.js';
import { collectMissingLabelPresets, runLabelPresetMigration } from './labels.js';

const HOME = '/Users/test';
const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const W2 = 'AAAAAAAA-0000-4000-8000-000000000002';
const P1 = 'BBBBBBBB-0000-4000-8000-000000000001';
const P2 = 'BBBBBBBB-0000-4000-8000-000000000002';

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
    while (cleanups.length > 0) {
        const cleanup = cleanups.pop();
        if (cleanup !== undefined) await cleanup();
    }
});

function workspaceRecord(id: string, paneID: string, name: string, labels: readonly string[]): PersistedWorkspace {
    return {
        id,
        name,
        slug: `${name}-0000`,
        color: 'blue',
        icon: null,
        profileName: null,
        layout: leaf(paneID),
        focusedPaneID: paneID,
        createdAt: 1_700_000_000,
        lastAccessedAt: 1_700_000_000,
        labels: [...labels],
        panes: [
            {
                id: paneID,
                label: null,
                type: 'shell',
                workingDirectory: HOME,
                createdAt: 1_700_000_000,
                lastActivityAt: 1_700_000_000,
                agentSessionID: null,
                agentKind: null,
                agentProfileName: null,
                status: 'idle',
                filePath: null,
                scratchpadContent: null,
                webTabs: null,
                webActiveTabID: null,
                webIsPrivate: false
            }
        ],
        repoAssociations: []
    };
}

/**
 * A database written by a build that predates presets: labels on the workspaces, whatever
 * presets happen to exist, and NO migration marker at all (the field is absent, exactly as the
 * `appState` row would be).
 */
function legacySnapshot(presets: readonly LabelPreset[] = []): PersistedSnapshot {
    return {
        version: 1,
        workspaces: [
            workspaceRecord(W1, P1, 'alpha', ['backend', 'wip']),
            // 'wip' repeats (must dedupe to ONE preset), '' is junk a preset can never address.
            workspaceRecord(W2, P2, 'beta', ['wip', 'frontend', ''])
        ],
        groups: [],
        topLevelOrder: [
            { kind: 'workspace', id: W1 },
            { kind: 'workspace', id: W2 }
        ],
        activeWorkspaceID: W1,
        repos: [],
        labelPresets: [...presets]
    };
}

function legacyState(presets: readonly LabelPreset[] = []): DaemonState {
    return fromSnapshot(legacySnapshot(presets), { homeDirectory: HOME });
}

function presetNames(state: DaemonState): readonly string[] {
    return state.labelPresets.map((preset) => preset.name);
}

describe('collectMissingLabelPresets', () => {
    it('walks every workspace label, deduped, in first-seen order, skipping empties', () => {
        expect(collectMissingLabelPresets(legacyState())).toEqual(['backend', 'wip', 'frontend']);
    });

    it('skips a label that already has a preset (whatever colour it is)', () => {
        const state = legacyState([{ name: 'wip', color: { kind: 'custom', hex: '#ff00aa' }, textColor: null }]);
        expect(collectMissingLabelPresets(state)).toEqual(['backend', 'frontend']);
    });

    it('compares names verbatim — a preset for a differently-cased label is a different preset', () => {
        const state = legacyState([{ name: 'WIP', color: { kind: 'named', color: 'red' }, textColor: null }]);
        expect(collectMissingLabelPresets(state)).toContain('wip');
    });
});

describe('runLabelPresetMigration', () => {
    it('back-fills a gray preset for every legacy label and sets the marker', () => {
        const store = createStore(legacyState());
        expect(store.getState().labelPresetsMigrated).toBe(false);

        const outcome = runLabelPresetMigration(store);

        expect(outcome).toEqual({ ran: true, backfilled: ['backend', 'wip', 'frontend'] });
        expect(presetNames(store.getState())).toEqual(['backend', 'wip', 'frontend']);
        for (const preset of store.getState().labelPresets) {
            expect(preset.color).toEqual({ kind: 'named', color: 'gray' });
            expect(preset.textColor).toBeNull();
        }
        expect(store.getState().labelPresetsMigrated).toBe(true);
    });

    it('never overwrites an existing preset colour (§6.4 idempotence)', () => {
        const chosen: LabelPreset = { name: 'wip', color: { kind: 'custom', hex: '#ff00aa' }, textColor: null };
        const store = createStore(legacyState([chosen]));

        const outcome = runLabelPresetMigration(store);

        expect(outcome.backfilled).toEqual(['backend', 'frontend']);
        expect(store.getState().labelPresets[0]).toEqual(chosen);
        expect(presetNames(store.getState())).toEqual(['wip', 'backend', 'frontend']);
    });

    it('emits ONE label-presets-changed batch per added preset and none for the marker', () => {
        const store = createStore(legacyState());
        const batches: number[] = [];
        store.subscribe((events) => {
            batches.push(events.length);
            for (const event of events) expect(event.kind).toBe('label-presets-changed');
        });

        runLabelPresetMigration(store);

        // Three presets = three batches; the marker flip carries no client-visible event.
        expect(batches).toEqual([1, 1, 1]);
    });

    it('is a no-op on the second boot — the walk itself is skipped', () => {
        const store = createStore(legacyState());
        const collect = vi.fn(collectMissingLabelPresets);

        expect(runLabelPresetMigration(store, { collect }).ran).toBe(true);
        expect(collect).toHaveBeenCalledTimes(1);

        const afterFirst = store.getState();
        const second = runLabelPresetMigration(store, { collect });

        expect(second).toEqual({ ran: false, backfilled: [] });
        // Not called a second time: the marker short-circuits BEFORE the walk.
        expect(collect).toHaveBeenCalledTimes(1);
        // …and nothing at all moved: same object, so no event and no save was woken.
        expect(store.getState()).toBe(afterFirst);
    });

    it('does not resurrect a preset the user deleted while its label is still applied', () => {
        const store = createStore(legacyState());
        runLabelPresetMigration(store);
        store.dispatch({ type: 'remove-label-preset', id: 'wip' });
        expect(presetNames(store.getState())).toEqual(['backend', 'frontend']);

        // Every later launch runs the migration again; the marker is what protects the delete.
        runLabelPresetMigration(store);
        runLabelPresetMigration(store);

        expect(presetNames(store.getState())).toEqual(['backend', 'frontend']);
        expect(store.getState().workspaces[0]?.labels).toContain('wip');
    });

    it('sets the marker on a fresh install without doing any work (§13 note 13)', () => {
        const store = createStore(emptyDaemonState(HOME));
        const collect = vi.fn(collectMissingLabelPresets);

        const outcome = runLabelPresetMigration(store, { collect });

        expect(outcome).toEqual({ ran: true, backfilled: [] });
        expect(collect).toHaveBeenCalledTimes(1);
        expect(store.getState().labelPresets).toEqual([]);
        expect(store.getState().labelPresetsMigrated).toBe(true);
    });

    it('leaves the marker one-way: setting it twice returns the identical state object', () => {
        const store = createStore(emptyDaemonState(HOME));
        store.dispatch({ type: 'set-label-presets-migrated' });
        const marked = store.getState();
        store.dispatch({ type: 'set-label-presets-migrated' });
        expect(store.getState()).toBe(marked);
    });
});

describe('the marker in the database', () => {
    function scratchDir(): string {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpid-labelmig-'));
        cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
        return root;
    }

    it('reads a database with no marker row at all as "never migrated"', () => {
        const file = path.join(scratchDir(), 'nex.db');
        const writer = createPersistence({ path: file });
        expect(writer.saveNow(legacySnapshot())).toBe(true);
        writer.close();

        // A build that predates the key wrote no row for it. Remove it to get exactly that DB.
        const raw = openSqliteDatabase(file);
        raw.run('DELETE FROM appState WHERE key = ?', APP_STATE_LABEL_PRESETS_MIGRATED);
        expect(raw.get('SELECT value FROM appState WHERE key = ?', APP_STATE_LABEL_PRESETS_MIGRATED)).toBeUndefined();
        raw.close();

        const reader = createPersistence({ path: file });
        const loaded = reader.load() as PersistedSnapshot;
        reader.close();

        expect(loaded.labelPresetsMigrated).toBe(false);
        expect(fromSnapshot(loaded, { homeDirectory: HOME }).labelPresetsMigrated).toBe(false);
    });

    it('round-trips the marker and the back-filled presets through a real file', () => {
        const file = path.join(scratchDir(), 'nex.db');
        const first = createPersistence({ path: file });
        expect(first.saveNow(legacySnapshot())).toBe(true);
        first.close();

        // Boot 1: load → migrate → save.
        const reader = createPersistence({ path: file });
        const store = createStore(fromSnapshot(reader.load() as PersistedSnapshot, { homeDirectory: HOME }));
        expect(runLabelPresetMigration(store).backfilled).toEqual(['backend', 'wip', 'frontend']);
        expect(reader.saveNow(toSnapshot(store.getState()))).toBe(true);
        reader.close();

        // Boot 2: the marker survived, so the migration does not run again.
        const second = createPersistence({ path: file });
        const reloaded = second.load() as PersistedSnapshot;
        second.close();
        expect(reloaded.labelPresetsMigrated).toBe(true);
        expect(reloaded.labelPresets.map((preset) => preset.name)).toEqual(['backend', 'wip', 'frontend']);

        const rebooted = createStore(fromSnapshot(reloaded, { homeDirectory: HOME }));
        expect(runLabelPresetMigration(rebooted)).toEqual({ ran: false, backfilled: [] });
    });
});

describe('createDaemon', () => {
    interface Scratch {
        readonly root: string;
        readonly home: string;
        readonly dbPath: string;
    }

    function scratch(): Scratch {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpid-labelmig-boot-'));
        cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
        const home = path.join(root, 'home');
        fs.mkdirSync(home, { recursive: true });
        return { root, home, dbPath: path.join(root, 'nex.db') };
    }

    function daemonFor(paths: Scratch): Daemon {
        const daemon = createDaemon({
            // No ambient environment and no ambient HOME: every path this daemon touches is
            // inside `paths.root` (asserted below), so the developer's real ~ is untouched.
            env: {},
            home: paths.home,
            runDir: path.join(paths.root, 'run'),
            controlSocketPath: path.join(paths.root, 'kelpi.sock'),
            dbPath: paths.dbPath,
            configPath: path.join(paths.root, 'config'),
            httpPort: 0,
            settleMs: 0,
            spawn: { cols: 80, rows: 24, shell: '/bin/sh' }
        });
        cleanups.push(() => daemon.stop());
        return daemon;
    }

    function seedLegacyDatabase(dbPath: string, home: string): void {
        const snapshot = legacySnapshot([
            { name: 'wip', color: { kind: 'custom', hex: '#ff00aa' }, textColor: null }
        ]);
        const withHome: PersistedSnapshot = {
            ...snapshot,
            workspaces: snapshot.workspaces.map((workspace) => ({
                ...workspace,
                panes: workspace.panes.map((pane) => ({ ...pane, workingDirectory: home }))
            }))
        };
        const persistence = createPersistence({ path: dbPath });
        expect(persistence.saveNow(withHome)).toBe(true);
        persistence.close();
        const raw = openSqliteDatabase(dbPath);
        raw.run('DELETE FROM appState WHERE key = ?', APP_STATE_LABEL_PRESETS_MIGRATED);
        raw.close();
    }

    function readBack(dbPath: string): PersistedSnapshot | null {
        const persistence = createPersistence({ path: dbPath });
        const snapshot = persistence.load();
        persistence.close();
        return snapshot;
    }

    it('back-fills a legacy database on the first launch after the upgrade', async () => {
        const paths = scratch();
        seedLegacyDatabase(paths.dbPath, paths.home);

        const daemon = daemonFor(paths);
        const info = await daemon.start();
        expect(info.loadStatus).toBe('ok');
        // Sandbox held: nothing was written outside the temp root.
        expect(info.dbPath.startsWith(paths.root)).toBe(true);
        expect(info.runDir.startsWith(paths.root)).toBe(true);

        const state = daemon.store.getState();
        expect(state.labelPresets).toEqual([
            // The user's colour, untouched by the back-fill…
            { name: 'wip', color: { kind: 'custom', hex: '#ff00aa' }, textColor: null },
            // …and a gray preset for each label that had none.
            { name: 'backend', color: { kind: 'named', color: 'gray' }, textColor: null },
            { name: 'frontend', color: { kind: 'named', color: 'gray' }, textColor: null }
        ]);
        expect(state.labelPresetsMigrated).toBe(true);

        // What Settings ▸ Labels actually renders from: the serialized state payload. (The
        // marker is server-only and must NOT be in it.)
        const serialized = serializeState(state) as { labelPresets: { name: string }[] };
        expect(serialized.labelPresets.map((preset) => preset.name)).toEqual(['wip', 'backend', 'frontend']);
        expect(Object.keys(serialized)).not.toContain('labelPresetsMigrated');

        await daemon.restored;
        await daemon.stop();

        const saved = readBack(paths.dbPath);
        expect(saved?.labelPresets.map((preset) => preset.name)).toEqual(['wip', 'backend', 'frontend']);
        expect(saved?.labelPresetsMigrated).toBe(true);
    }, 20_000);

    it('marks a fresh install migrated without minting anything', async () => {
        const paths = scratch();
        const daemon = daemonFor(paths);
        const info = await daemon.start();

        expect(info.loadStatus).toBe('empty');
        expect(daemon.store.getState().workspaces.map((workspace) => workspace.name)).toEqual(['Default']);
        expect(daemon.store.getState().labelPresets).toEqual([]);
        expect(daemon.store.getState().labelPresetsMigrated).toBe(true);

        await daemon.restored;
        await daemon.stop();
        expect(readBack(paths.dbPath)?.labelPresetsMigrated).toBe(true);
    }, 20_000);

    it('keeps a preset the user deleted deleted, across the next launch', async () => {
        const paths = scratch();
        seedLegacyDatabase(paths.dbPath, paths.home);

        const first = daemonFor(paths);
        await first.start();
        await first.restored;
        // The user opens Settings ▸ Labels and deletes the back-filled preset. Its label is
        // still applied to a workspace, which is exactly the case a re-run would undo.
        first.store.dispatch({ type: 'remove-label-preset', id: 'backend' });
        await first.stop();
        expect(readBack(paths.dbPath)?.labelPresets.map((preset) => preset.name)).toEqual(['wip', 'frontend']);

        const second = daemonFor(paths);
        await second.start();
        expect(second.store.getState().labelPresets.map((preset) => preset.name)).toEqual(['wip', 'frontend']);
        expect(second.store.getState().workspaces[0]?.labels).toContain('backend');
        await second.restored;
        await second.stop();
    }, 30_000);
});
