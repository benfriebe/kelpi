/**
 * app-state-core.md §2.9: the read-only trees (the remote-daemon sections and the phone host
 * tree) draw a workspace row and, unless its parent folded them away, its nested rows one
 * level in, joined by the parent-coloured rule the local sidebar draws. This is the shared
 * plan for those rows; each tree renders it with its own `WorkspaceRow` wiring.
 */

import { agentCounts, groupGuideColor } from './Sidebar';
import type { ChromeBucket } from './theme';
import type { ChromeWorkspace } from './types';

export interface TreeRowOptions {
    readonly depth: 0 | 1 | 2;
    readonly groupID?: string;
    readonly guideColor?: string;
    readonly guideExtendUp?: boolean;
    readonly guideExtendDown?: boolean;
    readonly parentGuideColor?: string;
    readonly parentGuideExtendUp?: boolean;
    readonly parentGuideExtendDown?: boolean;
    readonly childCount?: number;
    readonly childrenCollapsed?: boolean;
    readonly rollupRunning?: number;
    readonly rollupWaiting?: number;
}

export interface TreeRow {
    readonly workspace: ChromeWorkspace;
    readonly options: TreeRowOptions;
}

export function nestedTreeRows(
    workspace: ChromeWorkspace,
    nested: ReadonlyMap<string, readonly ChromeWorkspace[]> | undefined,
    options: TreeRowOptions & { readonly depth: 0 | 1 },
    bucket: ChromeBucket
): TreeRow[] {
    const kids = nested?.get(workspace.id) ?? [];
    if (kids.length === 0) return [{ workspace, options }];
    const collapsed = workspace.childrenCollapsed === true;
    const rollup = collapsed ? agentCounts(kids) : null;
    const parent: TreeRow = {
        workspace,
        options: {
            ...options,
            ...(collapsed || options.guideColor === undefined ? {} : { guideExtendDown: true }),
            childCount: kids.length,
            childrenCollapsed: collapsed,
            rollupRunning: rollup?.running ?? 0,
            rollupWaiting: rollup?.waiting ?? 0
        }
    };
    if (collapsed) return [parent];
    const parentGuide = groupGuideColor(workspace.color, bucket);
    return [
        parent,
        ...kids.map((child, index) => ({
            workspace: child,
            options: {
                depth: options.depth === 0 ? (1 as const) : (2 as const),
                ...(options.groupID === undefined ? {} : { groupID: options.groupID }),
                ...(options.guideColor === undefined
                    ? {}
                    : {
                          guideColor: options.guideColor,
                          guideExtendUp: true,
                          guideExtendDown: index < kids.length - 1 || options.guideExtendDown === true
                      }),
                parentGuideColor: parentGuide,
                parentGuideExtendUp: index > 0,
                parentGuideExtendDown: index < kids.length - 1
            }
        }))
    ];
}
