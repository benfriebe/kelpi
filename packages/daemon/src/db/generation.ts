import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openSqliteDatabase } from './adapter.js';

export const PLUGIN_DATABASE_FILENAME = 'kelpi-v2.db';

/** Older daemons interpret unknown panes as shells. Give them their own, unchanged DB.
 * VACUUM INTO includes committed WAL data; a plain file copy does not. Publish only a
 * complete snapshot, exclusively, so concurrent first boots cannot replace each other.
 */
export function migrateDatabaseGeneration(destination: string): void {
    if (path.basename(destination) !== PLUGIN_DATABASE_FILENAME || fs.existsSync(destination)) return;
    const source = path.join(path.dirname(destination), 'kelpi.db');
    if (!fs.existsSync(source)) return;
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const db = openSqliteDatabase(source, { readOnly: true, wal: false });
    try {
        db.run('VACUUM INTO ?', temporary);
        fs.chmodSync(temporary, 0o600);
        try { fs.linkSync(temporary, destination); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    } finally { db.close(); fs.rmSync(temporary, { force: true }); }
}
