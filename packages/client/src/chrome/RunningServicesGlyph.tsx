/**
 * The sidebar row's running-services mark (docs/running-services.md §7): a plug with the count
 * of services the workspace started, drawn like the pull-request glyph beside it. Nothing for a
 * workspace with none. Amber when one has sat idle for days (D7), with how long in its tooltip.
 */

import type { ReactElement } from 'react';

import { ChromeIcon } from './icons';
import { runningSummary, type WorkspaceRunning } from './running';
import { workspaceColorHex, type ChromeBucket } from './theme';
import { tokens } from './tokens';

export function RunningServicesGlyph(props: {
    readonly workspaceID: string;
    readonly running: WorkspaceRunning | undefined;
    /** A collapsed group header draws its workspaces' total under its own test id. */
    readonly testID?: string | undefined;
    /** D7: the longest a service here has sat idle, in whole days; absent when none has. */
    readonly idleDays?: number | undefined;
    readonly bucket?: ChromeBucket | undefined;
}): ReactElement | null {
    const running = props.running;
    if (running === undefined || running.services.length === 0) return null;
    const idle = props.idleDays;
    const summary = `${runningSummary(running)}${idle === undefined ? '' : ` · idle for ${String(idle)} day${idle === 1 ? '' : 's'}`}`;
    return (
        <span
            data-testid={props.testID ?? `workspace-running-${props.workspaceID}`}
            data-running-count={running.services.length}
            data-idle={idle === undefined ? undefined : 'true'}
            title={summary}
            aria-label={summary}
            role="img"
            className="flex shrink-0 items-center gap-[2px]"
            style={{ color: idle === undefined ? tokens.statusRunning : workspaceColorHex('orange', props.bucket ?? 'dark') }}
        >
            <ChromeIcon name="plug" size={11} />
            {running.services.length > 1 ? (
                <span className="font-mono text-[10px] leading-none">{running.services.length}</span>
            ) : null}
        </span>
    );
}
