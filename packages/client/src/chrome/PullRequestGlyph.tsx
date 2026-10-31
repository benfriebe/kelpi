/**
 * A workspace's pull request status (workspace-feature.md §11, shell-ui.md §5.3 / §6).
 *
 * The row shows ONE mark for all of a workspace's PRs, in the state that matters most (open >
 * draft > merged > closed), with a count when there is more than one. GitHub's colours (open
 * green, draft grey, merged purple, closed red), and a different drawing per state, so the state
 * never rests on colour alone.
 */

import {
    aggregatePullRequestState,
    PULL_REQUEST_STATES,
    type PullRequestState,
    type WorkspacePullRequest
} from '@kelpi/core/git';
import type { ReactElement } from 'react';

import { ChromeIcon, type ChromeIconName } from './icons';
import { workspaceColorHex, type ChromeBucket } from './theme';
import { tokens } from './tokens';

const ICON: Readonly<Record<PullRequestState, ChromeIconName>> = {
    open: 'pull-request',
    draft: 'pull-request-draft',
    merged: 'pull-request-merged',
    closed: 'pull-request-closed'
};

export function pullRequestColor(state: PullRequestState, bucket: ChromeBucket): string {
    switch (state) {
        case 'open':
            return workspaceColorHex('green', bucket);
        case 'draft':
            return tokens.textTertiary;
        case 'merged':
            return workspaceColorHex('purple', bucket);
        case 'closed':
            return workspaceColorHex('red', bucket);
    }
}

/** "Pull request #412 open", or "3 pull requests: 1 open, 2 merged". */
export function pullRequestSummary(pullRequests: readonly WorkspacePullRequest[]): string {
    const [only] = pullRequests;
    if (pullRequests.length === 1 && only !== undefined) return `Pull request #${String(only.number)} ${only.state}`;
    const counts = PULL_REQUEST_STATES.map((state) => [state, pullRequests.filter((entry) => entry.state === state).length] as const)
        .filter(([, count]) => count > 0)
        .map(([state, count]) => `${String(count)} ${state}`);
    return `${String(pullRequests.length)} pull requests: ${counts.join(', ')}`;
}

/** One PR's mark, in its own state's colour (the inspector's link lines). */
export function PullRequestStateIcon(props: {
    readonly state: PullRequestState;
    readonly bucket: ChromeBucket;
    readonly size?: number | undefined;
}): ReactElement {
    return (
        <span className="flex shrink-0 items-center" style={{ color: pullRequestColor(props.state, props.bucket) }}>
            <ChromeIcon name={ICON[props.state]} size={props.size ?? 11} />
        </span>
    );
}

/** The sidebar row's trailing mark; nothing at all for a workspace with no PRs. */
export function PullRequestGlyph(props: {
    readonly workspaceID: string;
    readonly pullRequests: readonly WorkspacePullRequest[] | undefined;
    readonly bucket: ChromeBucket;
}): ReactElement | null {
    const pullRequests = props.pullRequests ?? [];
    const state = aggregatePullRequestState(pullRequests);
    if (state === null) return null;
    const summary = pullRequestSummary(pullRequests);
    return (
        <span
            data-testid={`workspace-pr-${props.workspaceID}`}
            data-pr-state={state}
            data-pr-count={pullRequests.length}
            title={summary}
            aria-label={summary}
            role="img"
            className="flex shrink-0 items-center gap-[2px]"
            style={{ color: pullRequestColor(state, props.bucket) }}
        >
            <ChromeIcon name={ICON[state]} size={11} />
            {pullRequests.length > 1 ? (
                <span className="font-mono text-[10px] leading-none">{pullRequests.length}</span>
            ) : null}
        </span>
    );
}

/**
 * The inspector's PR lines under one association (shell-ui.md §6): each a link to the PR on
 * GitHub. `target="_blank"` is the shell's external-open path (`setWindowOpenHandler` hands
 * http(s) to the system browser); a browser client opens a tab.
 */
export function PullRequestLinks(props: {
    readonly pullRequests: readonly WorkspacePullRequest[];
    readonly bucket: ChromeBucket;
}): ReactElement | null {
    if (props.pullRequests.length === 0) return null;
    return (
        <ul className="flex flex-col gap-0.5 pl-5" data-testid="inspector-pr-list">
            {props.pullRequests.map((pullRequest) => (
                <li key={pullRequest.url} className="min-w-0">
                    <a
                        href={pullRequest.url}
                        target="_blank"
                        rel="noreferrer"
                        data-testid="inspector-pr-link"
                        data-pr-state={pullRequest.state}
                        title={`${pullRequest.title} (#${String(pullRequest.number)}, ${pullRequest.state})`}
                        className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-[11px] hover:underline"
                        style={{ color: tokens.textSecondary }}
                    >
                        <PullRequestStateIcon state={pullRequest.state} bucket={props.bucket} />
                        <span className="shrink-0 font-mono" style={{ color: tokens.textTertiary }}>
                            #{pullRequest.number}
                        </span>
                        <span className="truncate">{pullRequest.title}</span>
                    </a>
                </li>
            ))}
        </ul>
    );
}
