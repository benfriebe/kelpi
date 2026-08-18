/**
 * The body of a pane whose renderer is not built yet — markdown and diff land in M5, web panes
 * in M6 (PLAN.md).
 *
 * It is deliberately an **honest** placeholder rather than a broken-looking empty box: the pane
 * genuinely exists in the daemon (it is persisted, it is addressable by `nex pane list`, it
 * survives a restart), and everything about it that the daemon knows — its type, its file path
 * or URL, its working directory — is real and worth showing. Only the rendering is missing, and
 * the card says which milestone brings it.
 *
 * The same card covers the terminal-pane eviction case (`variant="detached"`): the mount policy
 * caps live renderers, and an evicted pane's PTY keeps running server-side — the daemon replays
 * its screen when the pane is mounted again (`terminal/mount-policy.ts`).
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

/** Which milestone builds each renderer; shown verbatim so the UI cannot over-promise. */
const TYPE_MILESTONE: Readonly<Record<PaneModel['type'], string>> = {
    shell: '',
    markdown: 'renders in M5',
    scratchpad: 'renders in M5',
    diff: 'renders in M5',
    web: 'renders in M6'
};

export interface ContentPanePlaceholderProps {
    readonly pane: PaneModel;
    /** Web panes: the active tab's URL (the daemon keeps it in `workspace.webPanes`). */
    readonly url?: string | null | undefined;
    /**
     * `content` — a pane type whose renderer is a later milestone.
     * `detached` — a shell pane the mount policy evicted; its PTY is alive server-side.
     */
    readonly variant?: 'content' | 'detached' | undefined;
}

export function ContentPanePlaceholder(props: ContentPanePlaceholderProps): ReactElement {
    const { pane, url } = props;
    const variant = props.variant ?? 'content';
    const detached = variant === 'detached';
    const detail = url ?? pane.filePath ?? pane.workingDirectory;

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
                        ? 'the process keeps running — focus this pane to re-attach'
                        : TYPE_MILESTONE[pane.type]}
                </span>
            </div>
        </div>
    );
}
