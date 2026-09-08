/**
 * The pane sheet (B3's bottom sheet): the current workspace's panes as a list - type glyph, title,
 * status dot, working directory - plus New Pane and Close Pane.
 *
 * Tapping a row FOCUSES that pane (`phone/view.ts` explains why focus is the shown pane), and in
 * `pane` mode that is the whole switch: the daemon's focus moves, the mirror echoes it, and the
 * shell draws the pane that now holds it. In `layout` mode the same tap moves the ring inside the
 * grid, which is what a tap on that pane's header would do.
 */

import type { ReactElement } from 'react';

import { ChromeIcon, type ChromeIconName } from '../chrome/icons';
import { tokens } from '../chrome/tokens';
import { homeAbbreviated, paneDisplayTitle, type PaneModel } from '../grid';
import { PhoneButton, PhoneRow, PhoneSheet, PhoneSheetHeader, statusDotColor } from './ui';

export interface PhonePaneSheetProps {
    readonly open: boolean;
    readonly workspaceName: string | null;
    readonly panes: readonly PaneModel[];
    readonly shownPaneID: string | null;
    readonly homeDirectory: string;
    readonly onShow: (paneID: string) => void;
    readonly onNewPane: (() => void) | null;
    readonly onClosePane: ((paneID: string) => void) | null;
    readonly onClose: () => void;
}

/** The glyph a pane type wears in the sheet - the sidebar's own vocabulary. */
export function paneGlyph(type: PaneModel['type']): ChromeIconName {
    switch (type) {
        case 'markdown':
            return 'document';
        case 'diff':
            return 'plusminus';
        case 'scratchpad':
            return 'note';
        case 'web':
            return 'globe';
        default:
            return 'terminal';
    }
}

export function PhonePaneSheet(props: PhonePaneSheetProps): ReactElement | null {
    const title = props.workspaceName === null ? 'Panes' : `Panes · ${props.workspaceName}`;
    return (
        <PhoneSheet open={props.open} side="bottom" label="Panes" testID="phone-pane-sheet" onClose={props.onClose}>
            <PhoneSheetHeader title={title} testID="phone-pane-sheet-header" onClose={props.onClose} />
            <div className="flex min-h-0 flex-col overflow-y-auto" data-testid="phone-pane-list">
                {props.panes.length === 0 ? (
                    <span className="px-4 py-3 text-[13px]" style={{ color: tokens.textTertiary }}>
                        No panes in this workspace.
                    </span>
                ) : null}
                {props.panes.map((pane) => {
                    const shown = pane.id === props.shownPaneID;
                    const dot = statusDotColor(pane.status);
                    return (
                        <div key={pane.id} className="flex items-stretch" data-testid={`phone-pane-row-${pane.id}`} data-shown={shown ? 'true' : 'false'}>
                            <PhoneRow
                                testID={`phone-pane-show-${pane.id}`}
                                active={shown}
                                onClick={() => {
                                    props.onShow(pane.id);
                                    props.onClose();
                                }}
                            >
                                <span className="flex shrink-0 items-center" style={{ color: tokens.textSecondary }}>
                                    <ChromeIcon name={paneGlyph(pane.type)} size={14} />
                                </span>
                                <span className="flex min-w-0 flex-1 flex-col">
                                    <span className="truncate">{paneDisplayTitle(pane, props.homeDirectory)}</span>
                                    {pane.workingDirectory !== null && pane.workingDirectory.length > 0 ? (
                                        <span className="truncate text-[12px]" style={{ color: tokens.textTertiary }}>
                                            {homeAbbreviated(pane.workingDirectory, props.homeDirectory)}
                                        </span>
                                    ) : null}
                                </span>
                                {dot === null ? null : (
                                    <span
                                        aria-hidden
                                        data-testid={`phone-pane-status-${pane.id}`}
                                        data-status={pane.status}
                                        className="h-[8px] w-[8px] shrink-0 rounded-full"
                                        style={{ background: dot }}
                                    />
                                )}
                            </PhoneRow>
                            {props.onClosePane === null ? null : (
                                <PhoneButton
                                    testID={`phone-pane-close-${pane.id}`}
                                    ariaLabel={`Close ${paneDisplayTitle(pane, props.homeDirectory)}`}
                                    onClick={() => {
                                        props.onClosePane?.(pane.id);
                                    }}
                                >
                                    <ChromeIcon name="clear" size={12} />
                                </PhoneButton>
                            )}
                        </div>
                    );
                })}
            </div>
            {props.onNewPane === null ? null : (
                <div className="flex shrink-0 border-t px-2" style={{ borderColor: tokens.divider }}>
                    <PhoneButton
                        testID="phone-pane-new"
                        onClick={() => {
                            props.onNewPane?.();
                            props.onClose();
                        }}
                    >
                        <ChromeIcon name="plus" size={12} />
                        New pane
                    </PhoneButton>
                </div>
            )}
        </PhoneSheet>
    );
}
