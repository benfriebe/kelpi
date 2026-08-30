import { describe, expect, it } from 'vitest';

import type { Pane } from './pane.js';
import {
    DEFAULT_MARKDOWN_FONT_SIZE,
    isTerminalPane,
    isUsingExternalEditor,
    makePane,
    PANE_PERSISTED_COLUMNS,
    PANE_PERSISTED_FIELDS,
    PANE_STATUSES,
    PANE_TRANSIENT_FIELDS,
    PANE_TYPES,
    resetTransientPaneFields
} from './pane.js';

const A = 'AAAAAAAA-0000-0000-0000-000000000001';

function samplePane(): Pane {
    return makePane({
        id: A,
        workingDirectory: '/Users/ben/code/kelpi',
        createdAt: 1_700_000_000,
        lastActivityAt: 1_700_000_100
    });
}

describe('pane type vocabulary', () => {
    it('uses the exact persisted raw strings', () => {
        expect(PANE_TYPES).toEqual(['shell', 'markdown', 'scratchpad', 'diff', 'web']);
        expect(PANE_STATUSES).toEqual(['idle', 'running', 'waitingForInput']);
    });
});

describe('makePane defaults', () => {
    it('applies the spec defaults', () => {
        const pane = samplePane();
        expect(pane.label).toBeNull();
        expect(pane.type).toBe('shell');
        expect(pane.status).toBe('idle');
        expect(pane.title).toBeNull();
        expect(pane.gitBranch).toBeNull();
        expect(pane.filePath).toBeNull();
        expect(pane.isEditing).toBe(false);
        expect(pane.externalEditorCommand).toBeNull();
        expect(pane.scratchpadContent).toBeNull();
        expect(pane.agentSessionID).toBeNull();
        expect(pane.agentKind).toBeNull();
        expect(pane.markdownFontSize).toBe(DEFAULT_MARKDOWN_FONT_SIZE);
        expect(pane.markdownFontSize).toBe(14);
        expect(pane.parkedSourcePaneID).toBeNull();
        expect(pane.agentStartedAt).toBeNull();
        expect(pane.backgroundTaskCount).toBe(0);
    });

    it('honours supplied persisted fields', () => {
        const pane = makePane({
            id: A,
            workingDirectory: '/tmp',
            createdAt: 1,
            lastActivityAt: 2,
            label: 'coordinator',
            type: 'markdown',
            status: 'running',
            filePath: '/tmp/notes.md',
            agentSessionID: 'abc-123',
            agentKind: 'codex'
        });
        expect(pane.label).toBe('coordinator');
        expect(pane.type).toBe('markdown');
        expect(pane.status).toBe('running');
        expect(pane.filePath).toBe('/tmp/notes.md');
        expect(pane.agentKind).toBe('codex');
    });
});

describe('persisted / transient split (§13.2, §15.10)', () => {
    it('partitions every field exactly once', () => {
        const keys = Object.keys(samplePane()).sort();
        const partitioned = [...PANE_PERSISTED_FIELDS, ...PANE_TRANSIENT_FIELDS].sort();
        expect(partitioned).toEqual(keys);
        expect(new Set(partitioned).size).toBe(partitioned.length);
    });

    it('maps scratchpadContent to the `content` column', () => {
        expect(PANE_PERSISTED_COLUMNS['scratchpadContent']).toBe('content');
        expect(PANE_PERSISTED_COLUMNS['agentKind']).toBe('agentKind');
        expect(Object.keys(PANE_PERSISTED_COLUMNS).sort()).toEqual([...PANE_PERSISTED_FIELDS].sort());
    });

    it('marks agentKind persisted and agentStartedAt / backgroundTaskCount transient', () => {
        expect(PANE_PERSISTED_FIELDS).toContain('agentKind');
        expect(PANE_PERSISTED_FIELDS).toContain('agentSessionID');
        expect(PANE_TRANSIENT_FIELDS).toContain('agentStartedAt');
        expect(PANE_TRANSIENT_FIELDS).toContain('backgroundTaskCount');
        expect(PANE_TRANSIENT_FIELDS).toContain('title');
        expect(PANE_TRANSIENT_FIELDS).toContain('gitBranch');
    });
});

describe('resetTransientPaneFields', () => {
    it('clears transient state on load but keeps agentKind and the session id', () => {
        const loaded: Pane = {
            ...samplePane(),
            title: 'zsh',
            gitBranch: 'main',
            isEditing: true,
            externalEditorCommand: 'nvim /tmp/x.md',
            markdownFontSize: 22,
            parkedSourcePaneID: 'BBBBBBBB-0000-0000-0000-000000000002',
            agentStartedAt: 1_700_000_050,
            backgroundTaskCount: 3,
            agentKind: 'codex',
            agentSessionID: 'session-1',
            status: 'running',
            label: 'worker'
        };
        const reset = resetTransientPaneFields(loaded);

        for (const field of PANE_TRANSIENT_FIELDS) {
            expect(reset[field]).toEqual(samplePane()[field]);
        }
        expect(reset.agentKind).toBe('codex');
        expect(reset.agentSessionID).toBe('session-1');
        expect(reset.status).toBe('running');
        expect(reset.label).toBe('worker');
    });
});

describe('derived helpers', () => {
    it('isUsingExternalEditor tracks externalEditorCommand', () => {
        const pane = samplePane();
        expect(isUsingExternalEditor(pane)).toBe(false);
        expect(isUsingExternalEditor({ ...pane, externalEditorCommand: 'nvim' })).toBe(true);
    });

    it('only shell panes are terminal panes', () => {
        const pane = samplePane();
        expect(isTerminalPane(pane)).toBe(true);
        for (const type of ['markdown', 'scratchpad', 'diff', 'web'] as const) {
            expect(isTerminalPane({ ...pane, type })).toBe(false);
        }
    });
});
