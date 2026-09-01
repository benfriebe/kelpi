/**
 * The card a pane shows when its body is not on screen.
 *
 * There is exactly one live case left, and it is not a missing feature: a **terminal pane the
 * mount policy evicted** (`variant="detached"`). The renderer cap is real — WebGL contexts are
 * finite — and an evicted pane's PTY keeps running server-side, so the card says the true
 * thing: the process is alive, and focusing the pane re-attaches it and replays its screen.
 *
 * The `content` variant is the defensive one: every pane type the daemon can create now has a
 * renderer (markdown/diff/scratchpad in M5, web panes in M8), so it is only reachable if a
 * newer daemon invents a pane type this client has never heard of — which is exactly when an
 * honest box beats an empty one. The "renders in M5/M6" rows it used to carry are gone with the
 * milestones that made them true.
 */

import type { ReactElement } from 'react';

import { Icon, type IconName } from '../grid/icons';
import { tokens } from '../grid/tokens';
import type { PaneModel } from '../grid/types';

const TYPE_ICON: Readonly<Record<PaneModel['type'], IconName>> = {
    shell: 'terminal',
    markdown: 'document',
    scratchpad: 'note',
    diff: 'plusminus',
    web: 'globe'
};

const TYPE_LABEL: Readonly<Record<PaneModel['type'], string>> = {
    shell: 'Terminal',
    markdown: 'Markdown preview',
    scratchpad: 'Scratchpad',
    diff: 'Diff',
    web: 'Web page'
};

export interface ContentPanePlaceholderProps {
    readonly pane: PaneModel;
    /**
     * `detached` — a shell pane the mount policy evicted; its PTY is alive server-side.
     * `content` — a pane type this client has no renderer for (a newer daemon).
     */
    readonly variant?: 'content' | 'detached' | undefined;
}

export function ContentPanePlaceholder(props: ContentPanePlaceholderProps): ReactElement {
    const { pane } = props;
    const variant = props.variant ?? 'content';
    const detached = variant === 'detached';
    const detail = pane.filePath ?? pane.workingDirectory;

    return (
        <div
            data-testid={`pane-placeholder-${pane.id}`}
            data-variant={variant}
            className="flex h-full w-full items-center justify-center overflow-hidden p-4"
            style={{ background: tokens.windowBackground }}
        >
            <div
                className="flex max-w-full flex-col items-center gap-2 rounded-lg px-5 py-4 text-center"
                style={{
                    background: tokens.surfaceBackground,
                    border: `1px solid ${tokens.divider}`,
                    color: tokens.textSecondary
                }}
            >
                <span style={{ color: tokens.textTertiary }}>
                    <Icon name={TYPE_ICON[pane.type]} size={22} />
                </span>
                <span className="text-[13px] font-medium" style={{ color: tokens.textPrimary }}>
                    {detached ? 'Terminal detached' : TYPE_LABEL[pane.type]}
                </span>
                {detail.length === 0 ? null : (
                    <span className="max-w-[42ch] truncate font-mono text-[11px]" title={detail}>
                        {detail}
                    </span>
                )}
                <span className="text-[11px]" style={{ color: tokens.textTertiary }}>
                    {detached
                        ? 'the process keeps running - focus this pane to re-attach'
                        : 'this client has no renderer for this pane type'}
                </span>
            </div>
        </div>
    );
}
