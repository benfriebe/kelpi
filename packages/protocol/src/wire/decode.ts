/**
 * The type-strict request decoder (wire-protocol.md §2.2, §3, §6).
 *
 * Contract, in order:
 *   1. one JSON object per line (leading/trailing whitespace trimmed);
 *   2. a known key with the wrong JSON type poisons the whole message; unknown keys are
 *      ignored; JSON `null` reads as absent;
 *   3. listed optional string fields normalize an empty string to absent;
 *   4. explicit-chain commands are matched BEFORE the mandatory-`pane_id` guard;
 *   5. per-command guards decide drop-vs-error semantics.
 *
 * A rejection is a *typed* value rather than an exception: the Swift server drops these
 * lines silently, while the daemon may answer allowlisted commands with
 * `{"ok":false,"error":…}` (PLAN.md "deliberate fixes"). Keeping the command name on the
 * rejection is what makes that choice possible.
 */

import { createFieldAccess, validateWireFields, type WireFieldAccess } from './fields.js';
import {
    EXPLICIT_CHAIN_COMMANDS,
    PANE_ID_REQUIRED_COMMANDS,
    isWireCommand,
    type PaneTargetScope,
    type WireCommandName,
    type WireMessage
} from './messages.js';
import { parseAgentKind, parseDropZone, parseMoveDirection, parseSplitDirection, parseWorkspaceColor, type AgentKind } from './vocab.js';

export type WireRejectionReason =
    | 'invalid-json'
    | 'not-an-object'
    | 'missing-command'
    | 'unknown-command'
    | 'field-type'
    | 'guard';

export interface WireRejection {
    readonly ok: false;
    readonly reason: WireRejectionReason;
    readonly detail: string;
    /** Present whenever the `command` key was readable — lets the daemon decide to reply. */
    readonly command?: string | undefined;
    readonly field?: string | undefined;
}

/** Fields that ride on any command and feed the `session_id` dual-fire (§3.1). */
export interface WireHookFields {
    readonly pane_id?: string | undefined;
    readonly session_id?: string | undefined;
    readonly agent: AgentKind;
}

export interface WireDecodeSuccess {
    readonly ok: true;
    readonly message: WireMessage;
    readonly hook: WireHookFields;
}

export type WireDecodeResult = WireDecodeSuccess | WireRejection;

function reject(
    reason: WireRejectionReason,
    detail: string,
    extra?: { command?: string | undefined; field?: string | undefined }
): WireRejection {
    return {
        ok: false,
        reason,
        detail,
        command: extra?.command,
        field: extra?.field
    };
}

/** Parse one newline-delimited request line. */
export function parseWireLine(line: string): WireDecodeResult {
    const trimmed = line.trim();
    if (trimmed.length === 0) return reject('invalid-json', 'empty line');
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return reject('invalid-json', 'line is not valid JSON');
    }
    return decodeWireObject(parsed);
}

/** Decode an already-parsed JSON value into a wire message. */
export function decodeWireObject(raw: unknown): WireDecodeResult {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return reject('not-an-object', 'request must be a JSON object');
    }
    const object = raw as Record<string, unknown>;

    const typeError = validateWireFields(object);
    if (typeError !== undefined) {
        const commandValue = object['command'];
        return reject('field-type', `field '${typeError.field}' must be ${typeError.kind}`, {
            command: typeof commandValue === 'string' ? commandValue : undefined,
            field: typeError.field
        });
    }

    const commandValue = object['command'];
    if (typeof commandValue !== 'string') return reject('missing-command', 'missing "command" key');
    if (!isWireCommand(commandValue)) {
        return reject('unknown-command', `unknown command '${commandValue}'`, { command: commandValue });
    }
    const command: WireCommandName = commandValue;

    const fields = createFieldAccess(object);
    const paneId = fields.paneId();
    const hook: WireHookFields = {
        pane_id: paneId,
        session_id: fields.rawText('session_id'),
        agent: parseAgentKind(fields.rawText('agent'))
    };

    if (PANE_ID_REQUIRED_COMMANDS.has(command) && paneId === undefined) {
        return reject('guard', `${command} requires a valid pane_id`, { command, field: 'pane_id' });
    }

    const message = decodeCommand(command, fields, paneId);
    if ('ok' in message) return message;
    return { ok: true, message, hook };
}

function guard(command: WireCommandName, detail: string, field?: string): WireRejection {
    return reject('guard', detail, { command, field });
}

/** Returns the decoded message, or a rejection when a command guard fails. */
function decodeCommand(
    command: WireCommandName,
    fields: WireFieldAccess,
    paneId: string | undefined
): WireMessage | WireRejection {
    const scope = (): PaneTargetScope => ({
        pane_id: paneId,
        target: fields.text('target'),
        workspace: fields.text('workspace')
    });
    /** §5.7 shared parse-time guard: at least one of pane_id / target. */
    const requireTargetable = (): WireRejection | undefined =>
        paneId === undefined && fields.text('target') === undefined
            ? guard(command, `${command} requires pane_id or target`, 'target')
            : undefined;
    const requireSelector = (): string | WireRejection => {
        const selector = fields.text('selector');
        return selector ?? guard(command, `${command} requires a non-empty selector`, 'selector');
    };

    switch (command) {
        // ── 6.1 agent lifecycle (pane_id already validated) ──────────────────────────
        case 'start':
            return { command, pane_id: paneId as string, agent: parseAgentKind(fields.rawText('agent')) };
        case 'stop':
            return { command, pane_id: paneId as string, background_tasks: fields.int('background_tasks') ?? 0 };
        case 'error':
            return { command, pane_id: paneId as string, message: fields.rawText('message') ?? 'Unknown error' };
        case 'notification':
            return {
                command,
                pane_id: paneId as string,
                title: fields.rawText('title') ?? 'Agent',
                body: fields.rawText('body') ?? '',
                background_tasks: fields.int('background_tasks') ?? 0
            };
        case 'session-start': {
            const sessionId = fields.nonEmpty('session_id');
            if (sessionId === undefined) return guard(command, 'session-start requires session_id', 'session_id');
            return {
                command,
                pane_id: paneId as string,
                session_id: sessionId,
                agent: parseAgentKind(fields.rawText('agent'))
            };
        }
        case 'session-end': {
            const sessionId = fields.nonEmpty('session_id');
            if (sessionId === undefined) return guard(command, 'session-end requires session_id', 'session_id');
            return { command, pane_id: paneId as string, session_id: sessionId };
        }

        // ── 6.2 pane commands ────────────────────────────────────────────────────────
        case 'pane-split': {
            const workspace = fields.text('workspace');
            if (paneId === undefined && fields.text('target') === undefined && workspace === undefined) {
                return guard(command, 'pane-split requires pane_id, target or workspace');
            }
            return {
                command,
                ...scope(),
                direction: parseSplitDirection(fields.rawText('direction')),
                path: fields.rawText('path'),
                name: fields.rawText('name')
            };
        }
        case 'pane-create': {
            const workspace = fields.text('workspace');
            if (paneId === undefined && fields.text('target') === undefined && workspace === undefined) {
                return guard(command, 'pane-create requires pane_id, target or workspace');
            }
            return { command, ...scope(), path: fields.rawText('path'), name: fields.rawText('name') };
        }
        case 'pane-close': {
            const failure = requireTargetable();
            if (failure) return failure;
            return { command, ...scope() };
        }
        case 'pane-name': {
            const failure = requireTargetable();
            if (failure) return failure;
            const name = fields.nonEmpty('name');
            if (name === undefined) return guard(command, 'pane-name requires a non-empty name', 'name');
            return { command, ...scope(), name };
        }
        case 'pane-send': {
            const target = fields.text('target');
            if (target === undefined) return guard(command, 'pane-send requires target', 'target');
            const text = fields.nonEmpty('text');
            if (text === undefined) return guard(command, 'pane-send requires non-empty text', 'text');
            return { command, ...scope(), target, text, bare: fields.flag('bare', false) };
        }
        case 'pane-send-key': {
            const target = fields.text('target');
            if (target === undefined) return guard(command, 'pane-send-key requires target', 'target');
            const key = fields.nonEmpty('key');
            if (key === undefined) return guard(command, 'pane-send-key requires key', 'key');
            return { command, ...scope(), target, key };
        }
        case 'pane-resize': {
            const failure = requireTargetable();
            if (failure) return failure;
            const ratio = fields.number('ratio');
            const delta = fields.number('delta');
            if ((ratio === undefined) === (delta === undefined)) {
                return guard(command, 'pane-resize requires exactly one of ratio / delta');
            }
            return { command, ...scope(), ratio, delta };
        }
        case 'pane-move': {
            const direction = parseMoveDirection(fields.rawText('direction'));
            if (direction === undefined) {
                return guard(command, 'pane-move requires direction left|right|up|down', 'direction');
            }
            return { command, pane_id: paneId as string, direction };
        }
        case 'pane-move-adjacent': {
            const target = fields.text('target');
            if (target === undefined) return guard(command, 'pane-move-adjacent requires target', 'target');
            const anchor = fields.nonEmpty('anchor');
            if (anchor === undefined) return guard(command, 'pane-move-adjacent requires anchor', 'anchor');
            const zone = parseDropZone(fields.rawText('zone'));
            if (zone === undefined) {
                return guard(command, 'pane-move-adjacent requires zone above|below|left-of|right-of', 'zone');
            }
            return { command, ...scope(), target, anchor, zone };
        }
        case 'pane-move-to-workspace': {
            const name = fields.nonEmpty('name');
            if (name === undefined) return guard(command, 'pane-move-to-workspace requires name', 'name');
            const text = fields.rawText('text');
            return { command, pane_id: paneId as string, name, text, create: text === 'true' };
        }
        case 'pane-list':
            return {
                command,
                pane_id: paneId,
                workspace: fields.text('workspace'),
                scope: fields.text('scope')
            };
        case 'pane-capture': {
            const failure = requireTargetable();
            if (failure) return failure;
            return {
                command,
                ...scope(),
                lines: fields.int('lines'),
                scrollback: fields.flag('scrollback', false)
            };
        }
        case 'pane-sync': {
            const action = fields.rawText('action');
            if (action === undefined) return guard(command, 'pane-sync requires action', 'action');
            return { command, pane_id: paneId, workspace: fields.text('workspace'), action };
        }
        case 'pane-sync-exclude': {
            const target = fields.text('target');
            if (target === undefined) return guard(command, 'pane-sync-exclude requires target', 'target');
            const excluded = fields.bool('excluded');
            if (excluded === undefined) return guard(command, 'pane-sync-exclude requires excluded', 'excluded');
            return { command, ...scope(), target, excluded };
        }

        // ── 6.3 workspace commands ───────────────────────────────────────────────────
        case 'workspace-list':
            return { command, group: fields.text('group') };
        case 'workspace-create':
            return {
                command,
                name: fields.rawText('name'),
                path: fields.rawText('path'),
                color: parseWorkspaceColor(fields.rawText('color')),
                group: fields.text('group'),
                profile: fields.text('profile'),
                worktree: fields.text('worktree'),
                branch: fields.text('branch'),
                update_main: fields.flag('update_main', false),
                repo: fields.text('repo')
            };
        case 'workspace-move': {
            const name = fields.nonEmpty('name');
            if (name === undefined) return guard(command, 'workspace-move requires name', 'name');
            return { command, name, group: fields.text('group'), index: fields.int('index') };
        }
        case 'workspace-delete': {
            const name = fields.nonEmpty('name');
            if (name === undefined) return guard(command, 'workspace-delete requires name', 'name');
            // `allow_last` is deliberately NOT decoded here: it is not a wire field, it has no
            // entry in §7's dictionary, and nothing arriving over the control socket may set it.
            // The GUI's own `delete-workspace` verb constructs it (`ws/sync.ts`); see
            // `WorkspaceDeleteMessage`.
            return { command, name, force: fields.flag('force', false) };
        }
        case 'workspace-profile': {
            const name = fields.nonEmpty('name');
            if (name === undefined) return guard(command, 'workspace-profile requires name', 'name');
            return { command, name, profile: fields.text('profile') };
        }
        case 'workspace-label': {
            const name = fields.nonEmpty('name');
            if (name === undefined) return guard(command, 'workspace-label requires name', 'name');
            const labelOp = fields.nonEmpty('label_op');
            if (labelOp === undefined) return guard(command, 'workspace-label requires label_op', 'label_op');
            return { command, name, label_op: labelOp, label_values: fields.list('label_values') ?? [] };
        }

        // ── 6.4 group commands ───────────────────────────────────────────────────────
        case 'group-list':
            return { command };
        case 'group-create': {
            const name = fields.nonEmpty('name');
            if (name === undefined) return guard(command, 'group-create requires name', 'name');
            return { command, name, color: parseWorkspaceColor(fields.rawText('color')) };
        }
        case 'group-rename': {
            const name = fields.nonEmpty('name');
            if (name === undefined) return guard(command, 'group-rename requires name', 'name');
            const newName = fields.nonEmpty('new_name');
            if (newName === undefined) return guard(command, 'group-rename requires new_name', 'new_name');
            return { command, name, new_name: newName };
        }
        case 'group-delete': {
            const name = fields.nonEmpty('name');
            if (name === undefined) return guard(command, 'group-delete requires name', 'name');
            return { command, name, cascade: fields.flag('cascade', false) };
        }
        case 'group-reorder': {
            const name = fields.nonEmpty('name');
            if (name === undefined) return guard(command, 'group-reorder requires name', 'name');
            return { command, name, order: fields.list('order') ?? [] };
        }
        case 'group-sort': {
            const name = fields.nonEmpty('name');
            if (name === undefined) return guard(command, 'group-sort requires name', 'name');
            const by = fields.nonEmpty('by');
            if (by === undefined) return guard(command, 'group-sort requires by', 'by');
            return { command, name, by, descending: fields.flag('descending', false) };
        }

        // ── 6.5 layout commands (pane_id already validated) ──────────────────────────
        case 'layout-cycle':
            return { command, pane_id: paneId as string };
        case 'layout-select': {
            const name = fields.nonEmpty('name');
            if (name === undefined) return guard(command, 'layout-select requires name', 'name');
            return { command, pane_id: paneId as string, name };
        }

        // ── 6.6 file / diff ──────────────────────────────────────────────────────────
        case 'open': {
            const path = fields.nonEmpty('path');
            if (path === undefined) return guard(command, 'open requires path', 'path');
            return { command, path, pane_id: paneId, reuse: fields.flag('reuse', false) };
        }
        case 'diff': {
            const repoPath = fields.nonEmpty('repo_path');
            if (repoPath === undefined) return guard(command, 'diff requires repo_path', 'repo_path');
            return { command, repo_path: repoPath, target_path: fields.text('target_path'), pane_id: paneId };
        }

        // ── 6.7 graft ────────────────────────────────────────────────────────────────
        // Grouped cases below share one identical shape per group, so the single
        // `as WireMessage` keeps the literal from widening across the union members.
        case 'graft-start':
        case 'graft-stop':
            return {
                command,
                workspace: fields.text('workspace'),
                repo: fields.text('repo'),
                pane_id: paneId
            } as WireMessage;
        case 'graft-status':
            return { command };

        // ── 6.8 ping ─────────────────────────────────────────────────────────────────
        case 'ping':
            return { command };

        // ── 6.9 web pane commands ────────────────────────────────────────────────────
        case 'web-open': {
            const url = fields.nonEmpty('url');
            if (url === undefined) return guard(command, 'web-open requires a non-empty url', 'url');
            // WEB-011: `target` names the pane to split off and `direction` which way. Both are
            // optional and only the GUI sends them; an unrecognized direction reads as absent
            // (the reducer's own default is horizontal), so a typo can never drop the open.
            return {
                command,
                url,
                private: fields.flag('private', false),
                pane_id: paneId,
                target: fields.text('target'),
                direction: parseSplitDirection(fields.text('direction'))
            };
        }
        case 'web-navigate': {
            const failure = requireTargetable();
            if (failure) return failure;
            const url = fields.nonEmpty('url');
            if (url === undefined) return guard(command, 'web-navigate requires a non-empty url', 'url');
            return { command, ...scope(), url };
        }
        case 'web-url':
        case 'web-back':
        case 'web-forward':
        case 'web-tabs':
        case 'web-cookies-list': {
            const failure = requireTargetable();
            if (failure) return failure;
            return { command, ...scope() } as WireMessage;
        }
        case 'web-reload': {
            const failure = requireTargetable();
            if (failure) return failure;
            return { command, ...scope(), hard: fields.flag('hard', false) };
        }
        case 'web-capture': {
            const failure = requireTargetable();
            if (failure) return failure;
            return { command, ...scope(), mode: fields.text('mode') ?? 'meta' };
        }
        case 'web-tab-new': {
            const failure = requireTargetable();
            if (failure) return failure;
            return {
                command,
                ...scope(),
                url: fields.rawText('url') ?? '',
                make_active: fields.flag('make_active', true)
            };
        }
        case 'web-tab-close':
        case 'web-tab-select': {
            const failure = requireTargetable();
            if (failure) return failure;
            const tab = fields.nonEmpty('tab');
            if (tab === undefined) return guard(command, `${command} requires a non-empty tab`, 'tab');
            return { command, ...scope(), tab } as WireMessage;
        }
        case 'web-console': {
            const failure = requireTargetable();
            if (failure) return failure;
            return {
                command,
                ...scope(),
                since: fields.int('since') ?? 0,
                level: fields.text('level'),
                clear: fields.flag('clear', false),
                follow: fields.flag('follow', false)
            };
        }
        case 'web-inspect': {
            const failure = requireTargetable();
            if (failure) return failure;
            return {
                command,
                ...scope(),
                send_to: fields.text('send_to'),
                submit: fields.flag('submit', false),
                disarm: fields.flag('disarm', false)
            };
        }
        case 'web-inspect-result': {
            const failure = requireTargetable();
            if (failure) return failure;
            return { command, ...scope(), clear: fields.flag('clear', false) };
        }
        case 'web-private': {
            const failure = requireTargetable();
            if (failure) return failure;
            const isPrivate = fields.bool('private');
            if (isPrivate === undefined) return guard(command, 'web-private requires private', 'private');
            return { command, ...scope(), private: isPrivate };
        }
        case 'web-cookies-clear': {
            const failure = requireTargetable();
            if (failure) return failure;
            return { command, ...scope(), domain: fields.text('domain'), all: fields.flag('all', false) };
        }
        case 'web-cookies-delete': {
            const failure = requireTargetable();
            if (failure) return failure;
            const name = fields.nonEmpty('name');
            if (name === undefined) return guard(command, 'web-cookies-delete requires name', 'name');
            return { command, ...scope(), name, domain: fields.text('domain') };
        }
        case 'web-click': {
            const failure = requireTargetable();
            if (failure) return failure;
            const selector = requireSelector();
            if (typeof selector !== 'string') return selector;
            return {
                command,
                ...scope(),
                selector,
                double: fields.flag('double', false),
                right: fields.flag('right', false),
                at_x: fields.number('at_x'),
                at_y: fields.number('at_y')
            };
        }
        case 'web-type': {
            const failure = requireTargetable();
            if (failure) return failure;
            const selector = requireSelector();
            if (typeof selector !== 'string') return selector;
            const text = fields.rawText('text');
            if (text === undefined) return guard(command, 'web-type requires text', 'text');
            return {
                command,
                ...scope(),
                selector,
                text,
                submit: fields.flag('submit', false),
                replace: fields.flag('replace', true)
            };
        }
        case 'web-q-text':
        case 'web-q-dom': {
            const failure = requireTargetable();
            if (failure) return failure;
            const selector = requireSelector();
            if (typeof selector !== 'string') return selector;
            return { command, ...scope(), selector, max_bytes: fields.int('max_bytes') } as WireMessage;
        }
        case 'web-q-attr': {
            const failure = requireTargetable();
            if (failure) return failure;
            const selector = requireSelector();
            if (typeof selector !== 'string') return selector;
            const attribute = fields.nonEmpty('attribute');
            if (attribute === undefined) return guard(command, 'web-q-attr requires attribute', 'attribute');
            return { command, ...scope(), selector, attribute };
        }
        case 'web-q-count':
        case 'web-q-exists':
        case 'web-hover': {
            const failure = requireTargetable();
            if (failure) return failure;
            const selector = requireSelector();
            if (typeof selector !== 'string') return selector;
            return { command, ...scope(), selector } as WireMessage;
        }
        case 'web-wait': {
            const failure = requireTargetable();
            if (failure) return failure;
            const selector = fields.text('selector');
            const urlMatch = fields.text('url_match');
            if ((selector === undefined) === (urlMatch === undefined)) {
                return guard(command, 'web-wait requires exactly one of selector / url_match');
            }
            return {
                command,
                ...scope(),
                selector,
                url_match: urlMatch,
                for: fields.text('for'),
                timeout_ms: fields.int('timeout_ms') ?? 0
            };
        }
        case 'web-select': {
            const failure = requireTargetable();
            if (failure) return failure;
            const selector = requireSelector();
            if (typeof selector !== 'string') return selector;
            const valueOrLabel = fields.rawText('value_or_label');
            if (valueOrLabel === undefined) return guard(command, 'web-select requires value_or_label', 'value_or_label');
            return { command, ...scope(), selector, value_or_label: valueOrLabel };
        }
        case 'web-scroll': {
            const failure = requireTargetable();
            if (failure) return failure;
            const selector = requireSelector();
            if (typeof selector !== 'string') return selector;
            return {
                command,
                ...scope(),
                selector,
                block: fields.text('block') ?? 'center',
                behavior: fields.text('behavior') ?? 'instant'
            };
        }
        case 'web-key': {
            const failure = requireTargetable();
            if (failure) return failure;
            const key = fields.nonEmpty('key');
            if (key === undefined) return guard(command, 'web-key requires a non-empty key', 'key');
            return { command, ...scope(), key, selector: fields.text('selector') };
        }
        case 'web-exec': {
            const failure = requireTargetable();
            if (failure) return failure;
            const script = fields.nonEmpty('script');
            if (script === undefined) return guard(command, 'web-exec requires a non-empty script', 'script');
            return { command, ...scope(), script };
        }
    }
}

/** True when the command is matched before the mandatory-`pane_id` guard (§3 stage 1). */
export function isExplicitChainCommand(command: string): boolean {
    return EXPLICIT_CHAIN_COMMANDS.has(command as WireCommandName);
}
