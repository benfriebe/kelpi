/**
 * The phone's overflow menu (B4): the verbs that make sense with a thumb and one pane on screen.
 *
 * Split, layouts, divider drags and the Inspector are a desktop's; what is left is the subset the
 * plan names - new pane, rename, close, sync input, the palette, Settings - and each row calls the
 * SAME daemon command the desktop verb calls. The surface shrinks; the commands do not change.
 */

import type { ReactElement } from 'react';

import { PhoneRow, PhoneSheet, PhoneSheetHeader } from './ui';

export interface PhoneMenuItem {
    readonly id: string;
    readonly label: string;
    readonly onSelect: () => void;
    readonly danger?: boolean | undefined;
    readonly disabled?: boolean | undefined;
}

export interface PhoneMenuSheetProps {
    readonly open: boolean;
    readonly title: string;
    readonly items: readonly PhoneMenuItem[];
    readonly onClose: () => void;
}

export function PhoneMenuSheet(props: PhoneMenuSheetProps): ReactElement | null {
    return (
        <PhoneSheet open={props.open} side="bottom" label={props.title} testID="phone-menu" onClose={props.onClose}>
            <PhoneSheetHeader title={props.title} testID="phone-menu-header" onClose={props.onClose} />
            <div className="flex min-h-0 flex-col overflow-y-auto" data-testid="phone-menu-items">
                {props.items.map((item) => (
                    <PhoneRow
                        key={item.id}
                        testID={`phone-menu-${item.id}`}
                        danger={item.danger}
                        disabled={item.disabled}
                        onClick={() => {
                            props.onClose();
                            item.onSelect();
                        }}
                    >
                        {item.label}
                    </PhoneRow>
                ))}
            </div>
        </PhoneSheet>
    );
}
