/**
 * Table rendering and the `--json` shape (cli.md §9.11/§10.1/§11.1, port notes 17 and 19).
 *
 * Humans read these tables and scripts occasionally parse them with `--no-header`, so the
 * column order, the full pane UUID (issue #240), the short `first8…last4` workspace/group ids,
 * the `●` marker, the `-` placeholders and the unpadded final column are all pinned.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { resetIO, setIO } from './io.js';
import { stableStringify } from './json.js';
import { collapseHome, printCookiesTable, printGroupTable, printPaneTable, printTabsTable, printWorkspaceTable, shortUUID } from './table.js';

function capture(run: () => void): string[] {
    const lines: string[] = [];
    setIO({ out: (text) => lines.push(text), err: () => undefined });
    run();
    return lines.join('').split('\n').slice(0, -1);
}

afterEach(() => {
    resetIO();
});

const PANE_A = '9C2B9A2E-1111-2222-3333-444455556666';
const PANE_B = '0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9';

describe('printPaneTable', () => {
    it('prints full pane ids, `-` placeholders and a ~-collapsed cwd', () => {
        const lines = capture(() => {
            printPaneTable(
                [
                    {
                        id: PANE_A,
                        label: 'worker-1',
                        type: 'shell',
                        workspace_name: 'alpha',
                        status: 'running',
                        agent_session_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
                        working_directory: '/Users/tester/code/nex'
                    },
                    {
                        id: PANE_B,
                        type: '',
                        workspace_name: 'alpha',
                        status: 'idle',
                        working_directory: '/tmp'
                    }
                ],
                false,
                '/Users/tester'
            );
        });
        expect(lines[0]).toBe(
            'ID                                    LABEL     TYPE   WORKSPACE  STATUS   SESSION        CWD'
        );
        expect(lines[1]).toContain(PANE_A);
        expect(lines[1]).toContain('a1b2c3d4…4c5d');
        expect(lines[1]).toContain('~/code/nex');
        // Unlabelled / typeless panes render `-`, and the last column has no trailing pad.
        expect(lines[2]).toContain('-       ');
        expect(lines[2]?.endsWith('/tmp')).toBe(true);
    });

    it('omits the header with --no-header', () => {
        const lines = capture(() => {
            printPaneTable([{ id: PANE_A, workspace_name: 'alpha', status: 'idle', working_directory: '/tmp' }], true, '');
        });
        expect(lines).toHaveLength(1);
        expect(lines[0]?.startsWith(PANE_A)).toBe(true);
    });
});

describe('printWorkspaceTable', () => {
    it('shortens ids, marks the active workspace and comma-joins labels', () => {
        const lines = capture(() => {
            printWorkspaceTable(
                [
                    { id: PANE_A, name: 'alpha', pane_count: 2, is_active: true, labels: ['ship-it', 'review'] },
                    { id: PANE_B, name: 'beta', group_name: 'squad', pane_count: 0, is_active: false, labels: [] }
                ],
                false
            );
        });
        expect(lines[0]).toBe('ID             NAME   GROUP  PANES  ACTIVE  LABELS');
        expect(lines[1]).toBe('9C2B9A2E…6666  alpha  -      2      ●       ship-it,review');
        expect(lines[2]).toBe('0A1B2C3D…E8F9  beta   squad  0      -       -');
    });
});

describe('printGroupTable', () => {
    it('renders members as `name (short-id)`', () => {
        const lines = capture(() => {
            printGroupTable(
                [{ id: PANE_A, name: 'squad', color: 'red', workspaces: [{ id: PANE_B, name: 'alpha' }] }],
                false
            );
        });
        expect(lines[0]).toBe('ID             NAME   COLOR  WORKSPACES');
        expect(lines[1]).toBe('9C2B9A2E…6666  squad  red    alpha (0A1B2C3D…E8F9)');
    });

    it('falls back to `-` for a colorless, memberless group', () => {
        const lines = capture(() => {
            printGroupTable([{ id: PANE_A, name: 'solo', workspaces: [] }], true);
        });
        expect(lines[0]).toBe('9C2B9A2E…6666  solo  -  -');
    });
});

describe('printTabsTable', () => {
    it('marks the active tab and clips a long title at 24 columns', () => {
        const lines = capture(() => {
            printTabsTable(
                [
                    { index: 0, active: true, title: 'A very very long page title here', url: 'https://a/' },
                    { index: 1, active: false, title: 'Short', url: 'https://b/' }
                ],
                false
            );
        });
        expect(lines[0]).toBe('IDX  A  TITLE                    URL');
        expect(lines[1]).toBe('0    *  A very very long page t…  https://a/');
        expect(lines[2]).toBe('1       Short                     https://b/');
    });
});

describe('printCookiesTable', () => {
    it('sorts by (domain, name) and clips each column', () => {
        const lines = capture(() => {
            printCookiesTable([
                { domain: 'b.example.com', name: 'session', value: 'x' },
                { domain: 'a.example.com', name: 'zeta', value: 'y' },
                { domain: 'a.example.com', name: 'alpha', value: 'z' }
            ]);
        });
        expect(lines[0]).toBe('DOMAIN                     NAME                 VALUE');
        expect(lines[1]?.startsWith('a.example.com')).toBe(true);
        expect(lines[1]).toContain('alpha');
        expect(lines[2]).toContain('zeta');
        expect(lines[3]?.startsWith('b.example.com')).toBe(true);
    });
});

describe('helpers', () => {
    it('only shortens ids long enough to shorten', () => {
        expect(shortUUID(PANE_A)).toBe('9C2B9A2E…6666');
        expect(shortUUID('short')).toBe('short');
        expect(shortUUID('123456789012')).toBe('12345678…9012');
    });

    it('collapses only a real $HOME prefix', () => {
        expect(collapseHome('/Users/tester/code', '/Users/tester')).toBe('~/code');
        expect(collapseHome('/Users/other/code', '/Users/tester')).toBe('/Users/other/code');
        expect(collapseHome('/Users/tester/code', '')).toBe('/Users/tester/code');
    });
});

describe('stableStringify', () => {
    it('sorts keys at every level and stays on one line', () => {
        expect(stableStringify({ b: 1, a: { d: [{ z: 1, y: 2 }], c: true } })).toBe(
            '{"a":{"c":true,"d":[{"y":2,"z":1}]},"b":1}'
        );
    });
});
