/// <reference types="node" />

import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import { columnNames, openSqliteDatabase, tableNames, type SqlDatabase } from './adapter.js';
import { appliedMigrations, DAEMON_ONLY_MIGRATIONS, migrate, MIGRATION_IDENTIFIERS, MIGRATIONS_TABLE } from './schema.js';

/** The real GRDB ledger captured from a live `nex.db` (packages/core/fixtures/migrations.json). */
const LEDGER_FIXTURE: readonly { identifier: string }[] = JSON.parse(
    fs.readFileSync(new URL('../../../core/fixtures/migrations.json', import.meta.url), 'utf8')
) as { identifier: string }[];
const LIVE_LEDGER = LEDGER_FIXTURE.map((entry) => entry.identifier);

function freshDatabase(): SqlDatabase {
    return openSqliteDatabase(':memory:');
}

describe('migration ledger', () => {
    it('applies v1..v19 on a fresh install, in registration order', () => {
        const db = freshDatabase();
        const result = migrate(db);
        expect(result.applied).toEqual(MIGRATION_IDENTIFIERS);
        expect(appliedMigrations(db)).toEqual([...MIGRATION_IDENTIFIERS]);
        db.close();
    });

    it('matches the identifiers of a real nex.db ledger, plus its own post-parity tail', () => {
        // The live DB also carries `v7_scheduled_tasks` / `v9_workspace_folders` — features this
        // daemon does not implement. The SHARED identifiers must be exactly the rest, in the
        // same relative order; anything the daemon added after parity is declared in
        // `DAEMON_ONLY_MIGRATIONS` and never appears in a Swift ledger.
        const shared = MIGRATION_IDENTIFIERS.filter(
            (identifier) => !DAEMON_ONLY_MIGRATIONS.includes(identifier)
        );
        expect(shared).toEqual(
            LIVE_LEDGER.filter((identifier) => !identifier.endsWith('_scheduled_tasks') && !identifier.endsWith('_workspace_folders'))
        );
        for (const identifier of shared) expect(LIVE_LEDGER).toContain(identifier);
        for (const identifier of DAEMON_ONLY_MIGRATIONS) {
            expect(LIVE_LEDGER).not.toContain(identifier);
            expect(MIGRATION_IDENTIFIERS).toContain(identifier);
        }
        expect(MIGRATION_IDENTIFIERS[0]).toBe('v1_initial');
        expect(MIGRATION_IDENTIFIERS.at(-1)).toBe('v19_pane_agent_profile');
        expect(MIGRATION_IDENTIFIERS).toHaveLength(19);
    });

    it('is a no-op on the second run', () => {
        const db = freshDatabase();
        migrate(db);
        expect(migrate(db).applied).toEqual([]);
        expect(appliedMigrations(db)).toEqual([...MIGRATION_IDENTIFIERS]);
        db.close();
    });

    it('produces the post-v19 schema (§8 + the daemon-only tail)', () => {
        const db = freshDatabase();
        migrate(db);

        expect(columnNames(db, 'workspace')).toEqual([
            'id',
            'name',
            'color',
            'layoutJSON',
            'focusedPaneID',
            'createdAt',
            'lastAccessedAt',
            'sortOrder',
            'slug',
            'labelsJSON',
            'icon',
            'profileName'
        ]);
        expect(columnNames(db, 'pane')).toEqual([
            'id',
            'workspaceID',
            'label',
            'type',
            'workingDirectory',
            'createdAt',
            'lastActivityAt',
            'agentSessionID',
            'status',
            'filePath',
            'content',
            'webURL',
            'webTabsJSON',
            'webActiveTabID',
            'webIsPrivate',
            'agentKind',
            'agentProfileName'
        ]);
        expect(columnNames(db, 'workspace_group')).toEqual([
            'id',
            'name',
            'color',
            'isCollapsed',
            'childOrderJSON',
            'createdAt',
            'sortOrder',
            'icon'
        ]);
        expect(columnNames(db, 'repo')).toEqual([
            'id',
            'path',
            'name',
            'remoteURL',
            'lastAccessedAt',
            'isAutoDiscovered'
        ]);
        expect(columnNames(db, 'repoAssociation')).toEqual([
            'id',
            'workspaceID',
            'repoID',
            'worktreePath',
            'branchName',
            'isAutoDetected'
        ]);
        expect(columnNames(db, 'appState')).toEqual(['key', 'value']);
        db.close();
    });

    it('renames claudeSessionID to agentSessionID (v15) and never re-adds it', () => {
        const db = freshDatabase();
        migrate(db);
        const columns = columnNames(db, 'pane');
        expect(columns).toContain('agentSessionID');
        expect(columns).not.toContain('claudeSessionID');
        db.close();
    });

    it('replays the whole ledger against a v19 schema without throwing, keeping agentSessionID', () => {
        const db = freshDatabase();
        // Simulate ledger loss: the schema is at v19 but no migration rows exist at all.
        migrate(db);
        db.run(`DELETE FROM ${MIGRATIONS_TABLE}`);
        expect(() => migrate(db)).not.toThrow();
        expect(appliedMigrations(db)).toEqual([...MIGRATION_IDENTIFIERS]);
        // Same outcome the Swift guards produce: v4 re-adds the (now absent) legacy column and
        // v15 then declines to rename over the existing target. The vestigial column is inert —
        // nothing reads or writes it — and `agentSessionID` keeps its data.
        expect(columnNames(db, 'pane')).toContain('agentSessionID');
        expect(columnNames(db, 'pane')).toContain('claudeSessionID');
        db.close();
    });

    it('guards ADD COLUMN against a column that already exists', () => {
        const db = freshDatabase();
        migrate(db);
        // A hand-added column that a later migration would otherwise try to create again.
        db.run(`DELETE FROM ${MIGRATIONS_TABLE} WHERE identifier IN ('v18_pane_agent_kind','v11_workspace_labels')`);
        expect(() => migrate(db)).not.toThrow();
        expect(columnNames(db, 'pane').filter((name) => name === 'agentKind')).toHaveLength(1);
        expect(columnNames(db, 'workspace').filter((name) => name === 'labelsJSON')).toHaveLength(1);
        db.close();
    });

    it('applies only the absent identifiers when adopting a partially migrated DB', () => {
        const db = freshDatabase();
        // Pretend the file came from a v14-era Swift build carrying foreign identifiers too.
        migrate(db);
        db.run(
            `DELETE FROM ${MIGRATIONS_TABLE} WHERE identifier IN ('v15_rename_agent_session','v16_workspace_icon','v17_workspace_profile','v18_pane_agent_kind')`
        );
        db.exec('ALTER TABLE "pane" RENAME COLUMN "agentSessionID" TO "claudeSessionID"');
        db.exec('ALTER TABLE "workspace" DROP COLUMN "icon"');
        db.exec('ALTER TABLE "workspace" DROP COLUMN "profileName"');
        db.exec('ALTER TABLE "pane" DROP COLUMN "agentKind"');
        db.run(`INSERT INTO ${MIGRATIONS_TABLE} (identifier) VALUES ('v7_scheduled_tasks'), ('v9_workspace_folders')`);

        const result = migrate(db);
        expect(result.applied).toEqual([
            'v15_rename_agent_session',
            'v16_workspace_icon',
            'v17_workspace_profile',
            'v18_pane_agent_kind'
        ]);
        expect(columnNames(db, 'pane')).toContain('agentSessionID');
        expect(columnNames(db, 'pane')).not.toContain('claudeSessionID');
        expect(columnNames(db, 'workspace')).toContain('icon');
        // Foreign identifiers survive untouched.
        expect(result.ledger).toContain('v7_scheduled_tasks');
        expect(result.ledger).toContain('v9_workspace_folders');
        db.close();
    });

    it('leaves tables it does not own alone (scheduledTask / workspaceFolder)', () => {
        const db = freshDatabase();
        db.exec(`
            CREATE TABLE "scheduledTask" ("id" TEXT PRIMARY KEY NOT NULL, "name" TEXT NOT NULL);
            CREATE TABLE "workspaceFolder" ("id" TEXT PRIMARY KEY NOT NULL, "name" TEXT NOT NULL);
        `);
        db.run('INSERT INTO "scheduledTask" ("id","name") VALUES (?,?)', 'T1', 'nightly');
        migrate(db);
        expect(tableNames(db)).toContain('scheduledTask');
        expect(tableNames(db)).toContain('workspaceFolder');
        expect(db.all('SELECT "name" FROM "scheduledTask"')).toEqual([{ name: 'nightly' }]);
        db.close();
    });

    it('keeps extra columns on adopted tables (the live workspace.folderID)', () => {
        const db = freshDatabase();
        migrate(db);
        db.exec('ALTER TABLE "workspace" ADD COLUMN "folderID" TEXT');
        migrate(db);
        expect(columnNames(db, 'workspace')).toContain('folderID');
        db.close();
    });
});

describe('pragmas', () => {
    it('enables foreign keys so the cascades in §2.3 fire', () => {
        const db = freshDatabase();
        migrate(db);
        expect(db.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });

        db.run(
            'INSERT INTO "workspace" ("id","name","color","layoutJSON","createdAt","lastAccessedAt") VALUES (?,?,?,?,?,?)',
            'W',
            'ws',
            'blue',
            '{"empty":{}}',
            1,
            1
        );
        db.run(
            'INSERT INTO "pane" ("id","workspaceID","type","workingDirectory","createdAt","lastActivityAt") VALUES (?,?,?,?,?,?)',
            'P',
            'W',
            'shell',
            '/tmp',
            1,
            1
        );
        db.run('DELETE FROM "workspace"');
        expect(db.all('SELECT "id" FROM "pane"')).toEqual([]);
        db.close();
    });
});
