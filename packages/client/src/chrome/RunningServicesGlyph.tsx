/**
 * The sidebar row's running-services mark (docs/running-services.md §7): a plug with the count
 * of services the workspace started, drawn like the pull-request glyph beside it. Nothing for a
 * workspace with none.
 */

import type { ReactElement } from 'react';

import { ChromeIcon } from './icons';
import { runningSummary, type WorkspaceRunning } from './running';
import { tokens } from './tokens';

export function RunningServicesGlyph(props: {
    readonly workspaceID: string;
    readonly running: WorkspaceRunning | undefined;
    /** A collapsed group header draws its workspaces' total under its own test id. */
    readonly testID?: string | undefined;
}): ReactElement | null {
    const running = props.running;
    if (running === undefined || running.services.length === 0) return null;
    const summary = runningSummary(running);
    return (
        <span
            data-testid={props.testID ?? `workspace-running-${props.workspaceID}`}
            data-running-count={running.services.length}
            title={summary}
            aria-label={summary}
            role="img"
            className="flex shrink-0 items-center gap-[2px]"
            style={{ color: tokens.statusRunning }}
        >
            <ChromeIcon name="plug" size={11} />
            {running.services.length > 1 ? (
                <span className="font-mono text-[10px] leading-none">{running.services.length}</span>
            ) : null}
        </span>
    );
}
