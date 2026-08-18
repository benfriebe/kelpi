/**
 * The reply allowlist (wire-protocol.md §4).
 *
 * Whether a command gets a reply is determined **solely by its wire command name** — never
 * by a request field. Everything not listed here is fire-and-forget: the server reads,
 * acts, and never writes a byte.
 */

import { PANE_ID_REQUIRED_COMMANDS, EXPLICIT_CHAIN_COMMANDS, type WireCommandName } from './wire/messages.js';

export const REPLY_COMMANDS: ReadonlySet<WireCommandName> = new Set([
    'workspace-list',
    'group-list',
    'pane-list',
    'pane-close',
    'pane-capture',
    'pane-send',
    'pane-send-key',
    'pane-split',
    'pane-create',
    'pane-name',
    'pane-resize',
    'pane-move-adjacent',
    'pane-sync',
    'pane-sync-exclude',
    'workspace-create',
    'workspace-delete',
    'workspace-label',
    'group-reorder',
    'group-sort',
    'graft-start',
    'graft-stop',
    'graft-status',
    'ping',
    'web-open',
    'web-navigate',
    'web-url',
    'web-back',
    'web-forward',
    'web-reload',
    'web-capture',
    'web-tabs',
    'web-tab-new',
    'web-tab-close',
    'web-tab-select',
    'web-console',
    'web-inspect',
    'web-inspect-result',
    'web-private',
    'web-cookies-list',
    'web-cookies-clear',
    'web-cookies-delete',
    'web-click',
    'web-type',
    'web-q-text',
    'web-q-attr',
    'web-q-count',
    'web-q-exists',
    'web-q-dom',
    'web-wait',
    'web-select',
    'web-scroll',
    'web-hover',
    'web-key',
    'web-exec'
]);

/** Request/response iff the command name is allowlisted; everything else stays silent. */
export function isReplyCommand(command: string): boolean {
    return REPLY_COMMANDS.has(command as WireCommandName);
}

/** The complement of the allowlist: commands that must never elicit any bytes. */
export const FIRE_AND_FORGET_COMMANDS: ReadonlySet<WireCommandName> = new Set(
    [...EXPLICIT_CHAIN_COMMANDS, ...PANE_ID_REQUIRED_COMMANDS].filter((command) => !REPLY_COMMANDS.has(command))
);

/**
 * The one streaming command: `web-console` with `follow:true` keeps the connection open
 * after the catch-up drain and pushes one JSON line per console entry (§2.4).
 */
export function isStreamingReply(command: string, follow: boolean): boolean {
    return command === 'web-console' && follow;
}
