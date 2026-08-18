/// <reference types="node" />

/**
 * Adoption smoke test against a REAL `nex.db` written by the Swift app.
 *
 * Skipped unless `NEXD_LEGACY_DB_FIXTURE` points at a copy of one (the file is personal data —
 * paths, labels, session ids — so it is never committed). Run it before touching the codec:
 *
 *   cp ~/Library/Application\\ Support/Nex/nex.db* /tmp/legacy/
 *   NEXD_LEGACY_DB_FIXTURE=/tmp/legacy/nex.db npx vitest run packages/daemon/src/db
 *
 * The fixture is opened READ-ONLY with migrations disabled: this test proves the daemon can
 * *read* a live database, and must never modify one.
 */

import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import { openSqliteDatabase } from './adapter.js';
import { createPersistence } from './persistence.js';
import { appliedMigrations, MIGRATION_IDENTIFIERS } from './schema.js';

const fixture = process.env['NEXD_LEGACY_DB_FIXTURE'];
const available = fixture !== undefined && fixture.length > 0 && fs.existsSync(fixture);

describe.skipIf(!available)('adopting a real Swift-written nex.db', () => {
    it('reads the whole database without losing rows', () => {
        const db = openSqliteDatabase(fixture as string, { readOnly: true, wal: false });
        try {
            // Every migration this daemon owns is already recorded — nothing to apply.
            const ledger = appliedMigrations(db);
            for (const identifier of MIGRATION_IDENTIFIERS) expect(ledger).toContain(identifier);

            const store = createPersistence({ db, path: fixture as string, migrate: false });
            const snapshot = store.load();
            expect(snapshot).not.toBeNull();
            if (snapshot === null) return;

            const workspaceRows = Number(db.get('SELECT COUNT(*) AS n FROM "workspace"')?.['n']);
            const paneRows = Number(db.get('SELECT COUNT(*) AS n FROM "pane"')?.['n']);
            const groupRows = Number(db.get('SELECT COUNT(*) AS n FROM "workspace_group"')?.['n']);
            const repoRows = Number(db.get('SELECT COUNT(*) AS n FROM "repo"')?.['n']);

            expect(snapshot.workspaces).toHaveLength(workspaceRows);
            expect(snapshot.groups).toHaveLength(groupRows);
            expect(snapshot.repos).toHaveLength(repoRows);
            expect(snapshot.workspaces.reduce((total, w) => total + w.panes.length, 0)).toBe(paneRows);

            for (const workspace of snapshot.workspaces) {
                expect(workspace.id).toMatch(/^[0-9A-F-]{36}$/);
                expect(workspace.slug.length).toBeGreaterThan(0);
                // Epoch SECONDS, not milliseconds.
                expect(workspace.createdAt).toBeLessThan(1e11);
                expect(workspace.createdAt).toBeGreaterThan(1e9);
            }
            expect(snapshot.topLevelOrder.length).toBeGreaterThan(0);
        } finally {
            db.close();
        }
    });
});
