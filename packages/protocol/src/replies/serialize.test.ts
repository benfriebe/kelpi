import { describe, expect, it } from 'vitest';

import { buildPaneListEntry, buildWorkspaceListEntry } from './build.js';
import { errorReply, serializeError, serializeReply } from './serialize.js';
import type { PaneSyncReply, PingReply } from './types.js';

describe('serializeReply', () => {
    it('writes one compact JSON line terminated by a newline', () => {
        const reply: PingReply = { ok: true, version: '0.32.0', build: '123', pid: 48291 };
        const line = serializeReply(reply);
        expect(line.endsWith('\n')).toBe(true);
        expect(line.slice(0, -1).includes('\n')).toBe(false);
        expect(line).toBe('{"ok":true,"version":"0.32.0","build":"123","pid":48291}\n');
        expect(JSON.parse(line)).toEqual(reply);
    });

    it('omits undefined optionals rather than emitting nulls', () => {
        const line = serializeReply({ ok: true, pane_id: 'A', label: undefined });
        expect(line).toBe('{"ok":true,"pane_id":"A"}\n');
    });

    it('escapes embedded newlines so a capture reply stays one line', () => {
        const line = serializeReply({ ok: true, text: 'first\nsecond\n' });
        expect(line.split('\n')).toHaveLength(2);
        expect(JSON.parse(line)).toEqual({ ok: true, text: 'first\nsecond\n' });
    });

    it('builds failure replies with typed extras', () => {
        expect(errorReply('workspace feat-x has 2 running agents; pass --force to delete anyway', { active_agents: 2 })).toEqual(
            {
                ok: false,
                error: 'workspace feat-x has 2 running agents; pass --force to delete anyway',
                active_agents: 2
            }
        );
        expect(serializeError('no pane with label \'worker\'')).toBe(
            '{"ok":false,"error":"no pane with label \'worker\'"}\n'
        );
    });

    it('round-trips a sync status payload', () => {
        const reply: PaneSyncReply = {
            ok: true,
            workspace_id: 'W',
            workspace_name: 'main',
            active: true,
            synced_pane_ids: ['A', 'B'],
            excluded: [{ id: 'C', label: 'logs' }]
        };
        expect(JSON.parse(serializeReply(reply))).toEqual(reply);
    });
});

describe('pane-list entry construction', () => {
    const base = {
        id: 'A',
        type: 'shell',
        workspace_id: 'W',
        workspace_name: 'main',
        working_directory: '/repo',
        status: 'running',
        is_focused: true,
        is_active_workspace: true,
        created_at: '2026-08-18T09:00:00Z',
        last_activity_at: '2026-08-18T09:05:12Z'
    } as const;

    it('keeps every always-present key and drops absent conditionals', () => {
        expect(buildPaneListEntry(base)).toEqual(base);
    });

    it('includes background_tasks only when positive', () => {
        expect(buildPaneListEntry({ ...base, background_tasks: 0 })).not.toHaveProperty('background_tasks');
        expect(buildPaneListEntry({ ...base, background_tasks: undefined })).not.toHaveProperty('background_tasks');
        expect(buildPaneListEntry({ ...base, background_tasks: 2 })).toMatchObject({ background_tasks: 2 });
    });

    it('emits group_id and group_name together or not at all', () => {
        const topLevel = buildPaneListEntry(base);
        expect(topLevel).not.toHaveProperty('group_id');
        expect(topLevel).not.toHaveProperty('group_name');
        const grouped = buildPaneListEntry({ ...base, group: { id: 'G', name: 'projects' } });
        expect(grouped).toMatchObject({ group_id: 'G', group_name: 'projects' });
    });

    it('drops empty conditional strings but keeps the real ones', () => {
        const entry = buildPaneListEntry({
            ...base,
            label: '',
            title: 'zsh',
            git_branch: 'main',
            agent_session_id: '3f2a-full-session-id',
            agent: 'codex',
            file_path: undefined
        });
        expect(entry).not.toHaveProperty('label');
        expect(entry).not.toHaveProperty('file_path');
        expect(entry).toMatchObject({
            title: 'zsh',
            git_branch: 'main',
            agent_session_id: '3f2a-full-session-id',
            agent: 'codex'
        });
    });
});

describe('workspace-list entry construction', () => {
    const base = {
        id: 'W',
        name: 'main',
        color: 'blue',
        pane_count: 3,
        is_active: true,
        created_at: '2026-08-01T10:00:00Z',
        last_accessed_at: '2026-08-18T08:00:00Z',
        labels: []
    } as const;

    it('always emits labels, even when empty', () => {
        expect(buildWorkspaceListEntry(base)).toEqual({ ...base, labels: [] });
    });

    it('omits last_activity_at and agent_session_id when absent', () => {
        const entry = buildWorkspaceListEntry(base);
        expect(entry).not.toHaveProperty('last_activity_at');
        expect(entry).not.toHaveProperty('agent_session_id');
    });

    it('emits the group pair together', () => {
        const entry = buildWorkspaceListEntry({
            ...base,
            labels: ['wip'],
            last_activity_at: '2026-08-18T08:59:00Z',
            agent_session_id: '3f2a',
            group: { id: 'G', name: 'projects' }
        });
        expect(entry).toEqual({
            ...base,
            labels: ['wip'],
            last_activity_at: '2026-08-18T08:59:00Z',
            agent_session_id: '3f2a',
            group_id: 'G',
            group_name: 'projects'
        });
    });
});
