import { describe, expect, it } from 'vitest';

import { parseWireLine, decodeWireObject, type WireDecodeSuccess, type WireRejection } from './decode.js';
import type { WireMessage } from './messages.js';

const PANE = '1b4e4e5a-9f2b-4c58-8d1f-2a81d9a3e111';
const PANE_UPPER = '1B4E4E5A-9F2B-4C58-8D1F-2A81D9A3E111';
const OTHER = 'a7c0f1de-1111-2222-3333-444455556666';

function decode(payload: Record<string, unknown>): WireDecodeSuccess | WireRejection {
    return parseWireLine(JSON.stringify(payload));
}

function ok(payload: Record<string, unknown>): WireMessage {
    const result = decode(payload);
    if (!result.ok) throw new Error(`expected success, got rejection: ${result.detail}`);
    return result.message;
}

function rejected(payload: Record<string, unknown>): WireRejection {
    const result = decode(payload);
    if (result.ok) throw new Error(`expected rejection, got ${JSON.stringify(result.message)}`);
    return result;
}

describe('line-level framing rules', () => {
    it('trims surrounding whitespace before parsing', () => {
        const result = parseWireLine('  \t {"command":"ping"} \r ');
        expect(result.ok).toBe(true);
    });

    it('rejects blank and malformed lines as invalid JSON', () => {
        expect(parseWireLine('')).toMatchObject({ ok: false, reason: 'invalid-json' });
        expect(parseWireLine('   ')).toMatchObject({ ok: false, reason: 'invalid-json' });
        expect(parseWireLine('{"command":')).toMatchObject({ ok: false, reason: 'invalid-json' });
    });

    it('rejects non-object JSON documents', () => {
        expect(parseWireLine('[]')).toMatchObject({ ok: false, reason: 'not-an-object' });
        expect(parseWireLine('"ping"')).toMatchObject({ ok: false, reason: 'not-an-object' });
        expect(parseWireLine('null')).toMatchObject({ ok: false, reason: 'not-an-object' });
        expect(decodeWireObject(7)).toMatchObject({ ok: false, reason: 'not-an-object' });
    });

    it('rejects a missing or non-string command', () => {
        expect(rejected({ pane_id: PANE }).reason).toBe('missing-command');
        expect(rejected({ command: null, pane_id: PANE }).reason).toBe('missing-command');
        expect(rejected({ command: 12 })).toMatchObject({ reason: 'field-type', field: 'command' });
    });

    it('rejects unknown commands but keeps the name for diagnostics', () => {
        expect(rejected({ command: 'pane-teleport' })).toMatchObject({
            reason: 'unknown-command',
            command: 'pane-teleport'
        });
    });
});

describe('type-strict field decoding', () => {
    it('ignores unknown keys', () => {
        expect(ok({ command: 'ping', nonsense: { deep: true }, other: 5 })).toEqual({ command: 'ping' });
    });

    it('poisons the whole message when a known field has the wrong type', () => {
        expect(rejected({ command: 'pane-send', target: 'w', text: 'ls', bare: 'true' })).toMatchObject({
            reason: 'field-type',
            field: 'bare',
            command: 'pane-send'
        });
        expect(rejected({ command: 'workspace-move', name: 'x', index: '3' })).toMatchObject({
            reason: 'field-type',
            field: 'index'
        });
        expect(rejected({ command: 'workspace-label', name: 'x', label_op: 'add', label_values: 'wip' })).toMatchObject(
            { reason: 'field-type', field: 'label_values' }
        );
        expect(
            rejected({ command: 'workspace-label', name: 'x', label_op: 'add', label_values: ['ok', 3] })
        ).toMatchObject({ reason: 'field-type', field: 'label_values' });
    });

    it('poisons the message even when the bad field is unrelated to the command', () => {
        expect(rejected({ command: 'ping', bare: 'true' })).toMatchObject({
            reason: 'field-type',
            field: 'bare',
            command: 'ping'
        });
    });

    it('treats explicit nulls as absent', () => {
        expect(ok({ command: 'pane-list', workspace: null, scope: null, pane_id: null })).toEqual({
            command: 'pane-list',
            pane_id: undefined,
            workspace: undefined,
            scope: undefined
        });
    });

    it('requires integers for int fields and non-negative integers for since', () => {
        expect(rejected({ command: 'pane-capture', pane_id: PANE, lines: 3.5 }).field).toBe('lines');
        expect(rejected({ command: 'web-console', pane_id: PANE, since: -1 }).field).toBe('since');
        expect(rejected({ command: 'web-console', pane_id: PANE, since: 1.5 }).field).toBe('since');
        expect(ok({ command: 'web-console', pane_id: PANE, since: 42 })).toMatchObject({ since: 42 });
    });

    it('accepts integer JSON numbers for double fields', () => {
        expect(ok({ command: 'pane-resize', pane_id: PANE, ratio: 1 })).toMatchObject({ ratio: 1 });
        expect(rejected({ command: 'pane-resize', pane_id: PANE, ratio: '0.5' }).field).toBe('ratio');
    });

    it('normalizes empty strings to absent for the listed optional fields', () => {
        expect(ok({ command: 'pane-list', pane_id: PANE, workspace: '', scope: '' })).toEqual({
            command: 'pane-list',
            pane_id: PANE_UPPER,
            workspace: undefined,
            scope: undefined
        });
        // an empty `target` counts as absent, so this message loses its only addressing
        expect(rejected({ command: 'pane-close', target: '' })).toMatchObject({ reason: 'guard' });
    });

    it('keeps empty strings for fields outside the normalization list', () => {
        expect(ok({ command: 'web-type', pane_id: PANE, selector: 'css:#q', text: '' })).toMatchObject({ text: '' });
        expect(ok({ command: 'web-tab-new', pane_id: PANE, url: '' })).toMatchObject({ url: '' });
    });

    it('uppercases valid pane ids and treats invalid ones as absent', () => {
        expect(ok({ command: 'pane-close', pane_id: PANE })).toMatchObject({ pane_id: PANE_UPPER });
        // invalid uuid → pane_id absent → target must carry the addressing
        expect(ok({ command: 'pane-close', pane_id: 'not-a-uuid', target: 'worker' })).toMatchObject({
            pane_id: undefined,
            target: 'worker'
        });
        expect(rejected({ command: 'pane-close', pane_id: 'not-a-uuid' })).toMatchObject({ reason: 'guard' });
    });
});

describe('parse order: explicit chain vs mandatory pane_id guard', () => {
    it('lets explicit-chain commands work with no pane_id at all', () => {
        expect(ok({ command: 'pane-send', target: 'worker', text: 'ls', workspace: 'beta' })).toEqual({
            command: 'pane-send',
            pane_id: undefined,
            target: 'worker',
            workspace: 'beta',
            text: 'ls',
            bare: false
        });
        expect(ok({ command: 'pane-create', workspace: 'beta' })).toMatchObject({ command: 'pane-create' });
        expect(ok({ command: 'workspace-list' })).toEqual({ command: 'workspace-list', group: undefined });
    });

    it('drops fallback commands without a valid pane_id', () => {
        for (const command of [
            'start',
            'stop',
            'error',
            'notification',
            'session-start',
            'session-end',
            'pane-move',
            'pane-move-to-workspace',
            'layout-cycle',
            'layout-select'
        ]) {
            expect(rejected({ command, name: 'x', session_id: 's', direction: 'left' })).toMatchObject({
                reason: 'guard',
                field: 'pane_id',
                command
            });
        }
    });
});

describe('agent lifecycle events', () => {
    it('decodes start with the agent kind, defaulting to claude', () => {
        expect(ok({ command: 'start', pane_id: PANE })).toEqual({
            command: 'start',
            pane_id: PANE_UPPER,
            agent: 'claude'
        });
        expect(ok({ command: 'start', pane_id: PANE, agent: 'CoDeX' })).toMatchObject({ agent: 'codex' });
        expect(ok({ command: 'start', pane_id: PANE, agent: 'gemini' })).toMatchObject({ agent: 'claude' });
    });

    it('defaults background_tasks, message, title and body', () => {
        expect(ok({ command: 'stop', pane_id: PANE })).toEqual({
            command: 'stop',
            pane_id: PANE_UPPER,
            background_tasks: 0
        });
        expect(ok({ command: 'stop', pane_id: PANE, background_tasks: 2 })).toMatchObject({ background_tasks: 2 });
        expect(ok({ command: 'error', pane_id: PANE })).toMatchObject({ message: 'Unknown error' });
        expect(ok({ command: 'notification', pane_id: PANE })).toMatchObject({
            title: 'Agent',
            body: '',
            background_tasks: 0
        });
    });

    it('requires a non-empty session id on session-start / session-end', () => {
        expect(ok({ command: 'session-start', pane_id: PANE, session_id: 'abc', agent: 'codex' })).toEqual({
            command: 'session-start',
            pane_id: PANE_UPPER,
            session_id: 'abc',
            agent: 'codex'
        });
        expect(ok({ command: 'session-end', pane_id: PANE, session_id: 'abc' })).toEqual({
            command: 'session-end',
            pane_id: PANE_UPPER,
            session_id: 'abc'
        });
        expect(rejected({ command: 'session-start', pane_id: PANE, session_id: '' }).field).toBe('session_id');
        expect(rejected({ command: 'session-end', pane_id: PANE }).field).toBe('session_id');
    });

    it('exposes the hook fields that feed the dual-fire', () => {
        const result = decode({ command: 'stop', pane_id: PANE, session_id: 'abc-123', agent: 'CODEX' });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.hook).toEqual({ pane_id: PANE_UPPER, session_id: 'abc-123', agent: 'codex' });
    });
});

describe('pane commands', () => {
    it('accepts workspace alone for split/create but not for close/name/capture', () => {
        expect(ok({ command: 'pane-split', workspace: 'beta' })).toMatchObject({ workspace: 'beta' });
        expect(ok({ command: 'pane-create', workspace: 'beta' })).toMatchObject({ workspace: 'beta' });
        expect(rejected({ command: 'pane-close', workspace: 'beta' }).reason).toBe('guard');
        expect(rejected({ command: 'pane-capture', workspace: 'beta' }).reason).toBe('guard');
        expect(rejected({ command: 'pane-name', workspace: 'beta', name: 'x' }).reason).toBe('guard');
        expect(rejected({ command: 'pane-split' }).reason).toBe('guard');
    });

    it('treats an invalid split direction as absent instead of dropping', () => {
        expect(ok({ command: 'pane-split', pane_id: PANE, direction: 'diagonal' })).toMatchObject({
            direction: undefined
        });
        expect(ok({ command: 'pane-split', pane_id: PANE, direction: 'vertical' })).toMatchObject({
            direction: 'vertical'
        });
    });

    it('drops pane-move on an invalid move direction', () => {
        expect(ok({ command: 'pane-move', pane_id: PANE, direction: 'up' })).toEqual({
            command: 'pane-move',
            pane_id: PANE_UPPER,
            direction: 'up'
        });
        expect(rejected({ command: 'pane-move', pane_id: PANE, direction: 'diagonal' })).toMatchObject({
            reason: 'guard',
            field: 'direction'
        });
        expect(rejected({ command: 'pane-move', pane_id: PANE }).field).toBe('direction');
    });

    it('requires target + non-empty text for pane-send and defaults bare', () => {
        expect(ok({ command: 'pane-send', pane_id: PANE, target: 'worker', text: 'ls', bare: true })).toEqual({
            command: 'pane-send',
            pane_id: PANE_UPPER,
            target: 'worker',
            workspace: undefined,
            text: 'ls',
            bare: true
        });
        expect(rejected({ command: 'pane-send', pane_id: PANE, text: 'ls' }).field).toBe('target');
        expect(rejected({ command: 'pane-send', pane_id: PANE, target: 'worker', text: '' }).field).toBe('text');
    });

    it('keeps pane-send-key names raw so the handler can error on unknown keys', () => {
        expect(ok({ command: 'pane-send-key', target: 'worker', key: 'ENTER' })).toMatchObject({ key: 'ENTER' });
        expect(ok({ command: 'pane-send-key', target: 'worker', key: 'f13' })).toMatchObject({ key: 'f13' });
        expect(rejected({ command: 'pane-send-key', target: 'worker' }).field).toBe('key');
    });

    it('enforces the pane-resize ratio/delta XOR', () => {
        expect(ok({ command: 'pane-resize', pane_id: PANE, ratio: 0.7 })).toMatchObject({
            ratio: 0.7,
            delta: undefined
        });
        expect(ok({ command: 'pane-resize', pane_id: PANE, delta: -0.05 })).toMatchObject({
            ratio: undefined,
            delta: -0.05
        });
        expect(rejected({ command: 'pane-resize', pane_id: PANE }).reason).toBe('guard');
        expect(rejected({ command: 'pane-resize', pane_id: PANE, ratio: 0.7, delta: 0.05 }).reason).toBe('guard');
    });

    it('decodes pane-move-adjacent and drops unknown zones', () => {
        expect(
            ok({ command: 'pane-move-adjacent', target: 'logs', anchor: 'coordinator', zone: 'below', workspace: 'main' })
        ).toEqual({
            command: 'pane-move-adjacent',
            pane_id: undefined,
            target: 'logs',
            anchor: 'coordinator',
            zone: 'below',
            workspace: 'main'
        });
        expect(rejected({ command: 'pane-move-adjacent', target: 'a', anchor: 'b', zone: 'beside' }).field).toBe('zone');
        expect(rejected({ command: 'pane-move-adjacent', target: 'a', anchor: 'b' }).field).toBe('zone');
        expect(rejected({ command: 'pane-move-adjacent', target: 'a', zone: 'below' }).field).toBe('anchor');
    });

    it('implements the pane-move-to-workspace text=="true" create quirk', () => {
        expect(ok({ command: 'pane-move-to-workspace', pane_id: PANE, name: 'scratch', text: 'true' })).toEqual({
            command: 'pane-move-to-workspace',
            pane_id: PANE_UPPER,
            name: 'scratch',
            text: 'true',
            create: true
        });
        expect(ok({ command: 'pane-move-to-workspace', pane_id: PANE, name: 'scratch' })).toMatchObject({
            create: false
        });
        expect(ok({ command: 'pane-move-to-workspace', pane_id: PANE, name: 'scratch', text: 'TRUE' })).toMatchObject({
            create: false
        });
        expect(ok({ command: 'pane-move-to-workspace', pane_id: PANE, name: 'scratch', text: '1' })).toMatchObject({
            create: false
        });
        // the flag is a *string* comparison: a real boolean poisons the line
        expect(rejected({ command: 'pane-move-to-workspace', pane_id: PANE, name: 'scratch', text: true })).toMatchObject(
            { reason: 'field-type', field: 'text' }
        );
    });

    it('decodes pane-capture and pane-list options', () => {
        expect(ok({ command: 'pane-capture', target: 'worker', workspace: 'beta', lines: 50, scrollback: true })).toEqual(
            {
                command: 'pane-capture',
                pane_id: undefined,
                target: 'worker',
                workspace: 'beta',
                lines: 50,
                scrollback: true
            }
        );
        expect(ok({ command: 'pane-capture', pane_id: PANE })).toMatchObject({ scrollback: false, lines: undefined });
        expect(ok({ command: 'pane-list', workspace: 'main' })).toMatchObject({ workspace: 'main' });
        expect(ok({ command: 'pane-list', pane_id: PANE, scope: 'current' })).toMatchObject({ scope: 'current' });
        // unknown scope values survive the wire; the handler answers `unknown scope: …`
        expect(ok({ command: 'pane-list', scope: 'galaxy' })).toMatchObject({ scope: 'galaxy' });
    });

    it('decodes the sync commands', () => {
        expect(ok({ command: 'pane-sync', pane_id: PANE, action: 'on' })).toEqual({
            command: 'pane-sync',
            pane_id: PANE_UPPER,
            workspace: undefined,
            action: 'on'
        });
        expect(rejected({ command: 'pane-sync', pane_id: PANE }).field).toBe('action');
        expect(ok({ command: 'pane-sync-exclude', target: 'logs', workspace: 'main', excluded: true })).toEqual({
            command: 'pane-sync-exclude',
            pane_id: undefined,
            target: 'logs',
            workspace: 'main',
            excluded: true
        });
        expect(rejected({ command: 'pane-sync-exclude', target: 'logs' }).field).toBe('excluded');
        expect(rejected({ command: 'pane-sync-exclude', excluded: true }).field).toBe('target');
    });
});

describe('workspace and group commands', () => {
    it('decodes workspace-create with color normalization and worktree fields', () => {
        expect(ok({ command: 'workspace-create' })).toEqual({
            command: 'workspace-create',
            name: undefined,
            path: undefined,
            color: undefined,
            group: undefined,
            profile: undefined,
            worktree: undefined,
            branch: undefined,
            update_main: false,
            repo: undefined
        });
        expect(ok({ command: 'workspace-create', color: 'chartreuse' })).toMatchObject({ color: undefined });
        expect(ok({ command: 'workspace-create', color: 'blue' })).toMatchObject({ color: 'blue' });
        expect(
            ok({
                command: 'workspace-create',
                name: 'feat-x',
                worktree: 'feat-x',
                branch: 'feat-x',
                update_main: true,
                repo: '/repo'
            })
        ).toMatchObject({ worktree: 'feat-x', branch: 'feat-x', update_main: true, repo: '/repo' });
    });

    it('requires non-empty names on the name-addressed commands', () => {
        for (const command of [
            'workspace-move',
            'workspace-delete',
            'workspace-profile',
            'workspace-label',
            'group-create',
            'group-rename',
            'group-delete',
            'group-reorder',
            'group-sort'
        ]) {
            expect(rejected({ command, name: '', label_op: 'add', new_name: 'n', by: 'name' }).field).toBe('name');
            expect(rejected({ command, label_op: 'add', new_name: 'n', by: 'name' }).field).toBe('name');
        }
    });

    it('decodes workspace-label operations with defaulted values', () => {
        expect(ok({ command: 'workspace-label', name: 'main', label_op: 'add', label_values: ['wip'] })).toEqual({
            command: 'workspace-label',
            name: 'main',
            label_op: 'add',
            label_values: ['wip']
        });
        expect(ok({ command: 'workspace-label', name: 'main', label_op: 'clear' })).toMatchObject({
            label_values: []
        });
        // unknown ops ride through: the handler answers `unknown label operation '<op>'`
        expect(ok({ command: 'workspace-label', name: 'main', label_op: 'append' })).toMatchObject({
            label_op: 'append'
        });
        expect(rejected({ command: 'workspace-label', name: 'main', label_op: '' }).field).toBe('label_op');
    });

    it('decodes group ordering commands', () => {
        expect(ok({ command: 'group-reorder', name: 'projects', order: ['beta', 'main'] })).toEqual({
            command: 'group-reorder',
            name: 'projects',
            order: ['beta', 'main']
        });
        expect(ok({ command: 'group-reorder', name: 'projects' })).toMatchObject({ order: [] });
        expect(ok({ command: 'group-sort', name: 'projects', by: 'last-activity', descending: true })).toEqual({
            command: 'group-sort',
            name: 'projects',
            by: 'last-activity',
            descending: true
        });
        expect(ok({ command: 'group-sort', name: 'projects', by: 'name' })).toMatchObject({ descending: false });
        expect(rejected({ command: 'group-sort', name: 'projects' }).field).toBe('by');
        expect(ok({ command: 'group-list' })).toEqual({ command: 'group-list' });
        expect(ok({ command: 'group-create', name: 'projects', color: 'blue' })).toEqual({
            command: 'group-create',
            name: 'projects',
            color: 'blue'
        });
        expect(ok({ command: 'group-delete', name: 'projects' })).toMatchObject({ cascade: false });
    });

    it('omits group on workspace-move to express top level', () => {
        expect(ok({ command: 'workspace-move', name: 'Test', index: 0 })).toEqual({
            command: 'workspace-move',
            name: 'Test',
            group: undefined,
            index: 0
        });
        expect(ok({ command: 'workspace-move', name: 'Test', group: '' })).toMatchObject({ group: undefined });
    });
});

describe('layout, file and graft commands', () => {
    it('decodes layout commands', () => {
        expect(ok({ command: 'layout-cycle', pane_id: PANE })).toEqual({
            command: 'layout-cycle',
            pane_id: PANE_UPPER
        });
        expect(ok({ command: 'layout-select', pane_id: PANE, name: 'tiled' })).toEqual({
            command: 'layout-select',
            pane_id: PANE_UPPER,
            name: 'tiled'
        });
        // layout names are validated silently downstream
        expect(ok({ command: 'layout-select', pane_id: PANE, name: 'spiral' })).toMatchObject({ name: 'spiral' });
        expect(rejected({ command: 'layout-select', pane_id: PANE }).field).toBe('name');
    });

    it('decodes open and diff', () => {
        expect(ok({ command: 'open', path: '/notes/plan.md', pane_id: PANE, reuse: true })).toEqual({
            command: 'open',
            path: '/notes/plan.md',
            pane_id: PANE_UPPER,
            reuse: true
        });
        expect(ok({ command: 'open', path: '/notes/plan.md' })).toMatchObject({ reuse: false, pane_id: undefined });
        expect(rejected({ command: 'open', path: '' }).field).toBe('path');
        expect(ok({ command: 'diff', repo_path: '/repo', target_path: '', pane_id: PANE })).toEqual({
            command: 'diff',
            repo_path: '/repo',
            target_path: undefined,
            pane_id: PANE_UPPER
        });
        expect(rejected({ command: 'diff' }).field).toBe('repo_path');
    });

    it('decodes graft and ping commands with no required fields', () => {
        expect(ok({ command: 'graft-start', pane_id: PANE })).toEqual({
            command: 'graft-start',
            workspace: undefined,
            repo: undefined,
            pane_id: PANE_UPPER
        });
        expect(ok({ command: 'graft-stop', workspace: 'main', repo: '/repo' })).toMatchObject({
            command: 'graft-stop',
            workspace: 'main',
            repo: '/repo'
        });
        expect(ok({ command: 'graft-status' })).toEqual({ command: 'graft-status' });
        expect(ok({ command: 'ping' })).toEqual({ command: 'ping' });
    });
});

describe('web pane commands', () => {
    it('requires a pane target for every web verb except web-open', () => {
        expect(ok({ command: 'web-open', url: 'https://example.com' })).toEqual({
            command: 'web-open',
            url: 'https://example.com',
            private: false,
            pane_id: undefined
        });
        expect(rejected({ command: 'web-open', url: '' }).field).toBe('url');
        for (const command of ['web-url', 'web-back', 'web-forward', 'web-tabs', 'web-cookies-list', 'web-reload']) {
            expect(rejected({ command }).reason).toBe('guard');
            expect(ok({ command, pane_id: PANE })).toMatchObject({ command, pane_id: PANE_UPPER });
        }
        expect(rejected({ command: 'web-navigate', url: 'https://x.test' }).reason).toBe('guard');
    });

    it('applies web defaults', () => {
        expect(ok({ command: 'web-reload', pane_id: PANE })).toMatchObject({ hard: false });
        expect(ok({ command: 'web-capture', pane_id: PANE })).toMatchObject({ mode: 'meta' });
        expect(ok({ command: 'web-capture', pane_id: PANE, mode: '' })).toMatchObject({ mode: 'meta' });
        expect(ok({ command: 'web-capture', pane_id: PANE, mode: 'nonsense' })).toMatchObject({ mode: 'nonsense' });
        expect(ok({ command: 'web-tab-new', pane_id: PANE })).toMatchObject({ url: '', make_active: true });
        expect(ok({ command: 'web-tab-new', pane_id: PANE, make_active: false })).toMatchObject({ make_active: false });
        expect(ok({ command: 'web-console', pane_id: PANE })).toMatchObject({
            since: 0,
            level: undefined,
            clear: false,
            follow: false
        });
        expect(ok({ command: 'web-inspect', pane_id: PANE, send_to: '' })).toMatchObject({
            send_to: undefined,
            submit: false,
            disarm: false
        });
        expect(ok({ command: 'web-inspect-result', pane_id: PANE })).toMatchObject({ clear: false });
        expect(ok({ command: 'web-cookies-clear', pane_id: PANE })).toMatchObject({ domain: undefined, all: false });
        expect(ok({ command: 'web-scroll', pane_id: PANE, selector: 'css:#f' })).toMatchObject({
            block: 'center',
            behavior: 'instant'
        });
        expect(ok({ command: 'web-type', pane_id: PANE, selector: 'css:#q', text: 'hi' })).toMatchObject({
            submit: false,
            replace: true
        });
        expect(ok({ command: 'web-wait', pane_id: PANE, selector: 'css:.x' })).toMatchObject({ timeout_ms: 0 });
    });

    it('requires web-private to carry an explicit boolean', () => {
        expect(ok({ command: 'web-private', pane_id: PANE, private: true })).toMatchObject({ private: true });
        expect(rejected({ command: 'web-private', pane_id: PANE }).field).toBe('private');
        expect(rejected({ command: 'web-private', pane_id: PANE, private: 'on' })).toMatchObject({
            reason: 'field-type',
            field: 'private'
        });
    });

    it('requires non-empty selectors, tabs, names and scripts', () => {
        expect(rejected({ command: 'web-click', pane_id: PANE, selector: '' }).field).toBe('selector');
        expect(rejected({ command: 'web-q-attr', pane_id: PANE, selector: 'css:a' }).field).toBe('attribute');
        expect(rejected({ command: 'web-tab-close', pane_id: PANE }).field).toBe('tab');
        expect(rejected({ command: 'web-tab-select', pane_id: PANE, tab: '' }).field).toBe('tab');
        expect(rejected({ command: 'web-cookies-delete', pane_id: PANE }).field).toBe('name');
        expect(rejected({ command: 'web-exec', pane_id: PANE, script: '' }).field).toBe('script');
        expect(rejected({ command: 'web-key', pane_id: PANE, key: '' }).field).toBe('key');
        expect(rejected({ command: 'web-type', pane_id: PANE, selector: 'css:#q' }).field).toBe('text');
        expect(rejected({ command: 'web-select', pane_id: PANE, selector: 'css:#c' }).field).toBe('value_or_label');
        expect(ok({ command: 'web-select', pane_id: PANE, selector: 'css:#c', value_or_label: '' })).toMatchObject({
            value_or_label: ''
        });
    });

    it('enforces the web-wait selector/url_match XOR', () => {
        expect(ok({ command: 'web-wait', pane_id: PANE, url_match: '/dashboard/', for: 'url-match' })).toMatchObject({
            selector: undefined,
            url_match: '/dashboard/',
            for: 'url-match'
        });
        expect(rejected({ command: 'web-wait', pane_id: PANE }).reason).toBe('guard');
        expect(rejected({ command: 'web-wait', pane_id: PANE, selector: 'css:.x', url_match: '/d/' }).reason).toBe(
            'guard'
        );
        // empty strings normalize to absent, so an empty selector + a url_match is legal
        expect(ok({ command: 'web-wait', pane_id: PANE, selector: '', url_match: '/d/' })).toMatchObject({
            url_match: '/d/'
        });
    });

    it('keeps web-click coordinates as separate optional doubles', () => {
        expect(
            ok({ command: 'web-click', target: 'browser', selector: 'text:Submit', at_x: 4, at_y: 8.5 })
        ).toMatchObject({ at_x: 4, at_y: 8.5, double: false, right: false });
        expect(ok({ command: 'web-click', pane_id: PANE, selector: 'text:Go', at_x: 4 })).toMatchObject({
            at_x: 4,
            at_y: undefined
        });
    });

    it('decodes a fully-populated web-exec through the scope triple', () => {
        expect(
            ok({ command: 'web-exec', pane_id: PANE, target: OTHER, workspace: 'main', script: 'return 1' })
        ).toEqual({
            command: 'web-exec',
            pane_id: PANE_UPPER,
            target: OTHER,
            workspace: 'main',
            script: 'return 1'
        });
    });
});
