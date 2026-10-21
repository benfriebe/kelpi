/**
 * The pane's actions (⋯ in the pane header, or the Kelpi mark on Home): the verbs that make sense
 * with a thumb and one pane on screen.
 *
 * Split, layouts, divider drags and the Inspector are a desktop's; what is left is the subset the
 * plan names - new pane, rename, close, sync input, size control, the palette, Settings - and each
 * row calls the SAME daemon command the desktop verb calls. The surface shrinks; the commands do
 * not change.
 *
 * Laid out as the handoff's actions sheet: the pane it acts on at the top, a row per verb with what
 * it does underneath and its current value on the right, and Close set apart at the foot because it
 * is the one that cannot be taken back. A row that opens another sheet (Rename) hands the sheet
 * over rather than closing first, so the phone's one history entry stays with the sheet on screen.
 */

import type { ReactElement } from 'react';

import { tokens } from '../chrome/tokens';
import { PhoneGlyph, type PhoneGlyphName } from './glyphs';
import { GlyphTile } from './parts';
import { phoneStyle } from './style';
import { PhoneSheet } from './ui';

export interface PhoneMenuItem {
    readonly id: string;
    readonly label: string;
    readonly onSelect: () => void;
    readonly danger?: boolean | undefined;
    readonly disabled?: boolean | undefined;
    readonly glyph?: PhoneGlyphName | undefined;
    /** One line under the label: what the row does, when the label alone does not say. */
    readonly detail?: string | undefined;
    /** The row's current value, on the right ("Off", "Desktop"). */
    readonly value?: string | undefined;
    /** The row opens a sheet of its own, which takes this one's place rather than following a close. */
    readonly opensSheet?: boolean | undefined;
}

export interface PhoneMenuSheetProps {
    readonly open: boolean;
    readonly title: string;
    /** Where the pane is: "mobile-ui · this Mac". */
    readonly subtitle?: string | undefined;
    readonly glyph?: PhoneGlyphName | undefined;
    readonly items: readonly PhoneMenuItem[];
    /** A note at the foot, above Close: what a choice here does to other screens. */
    readonly note?: string | undefined;
    readonly onClose: () => void;
}

export function PhoneMenuSheet(props: PhoneMenuSheetProps): ReactElement | null {
    const select = (item: PhoneMenuItem): void => {
        if (item.opensSheet !== true) props.onClose();
        item.onSelect();
    };
    const rows = props.items.filter((item) => item.danger !== true);
    const danger = props.items.filter((item) => item.danger === true);
    return (
        <PhoneSheet open={props.open} side="bottom" label={props.title} testID="phone-menu" onClose={props.onClose}>
            <div className="mt-2 h-[5px] w-[38px] shrink-0 self-center rounded-[3px]" style={{ background: phoneStyle.raisedBorder }} />
            <div className="flex shrink-0 items-center gap-3 pt-2 pr-2 pb-1 pl-4" data-testid="phone-menu-head">
                <GlyphTile name={props.glyph ?? 'terminal'} size={36} />
                <span className="flex min-w-0 flex-1 flex-col gap-[1px]">
                    <span className="truncate text-[16px] font-semibold" style={{ color: tokens.textPrimary }}>
                        {props.title}
                    </span>
                    {props.subtitle === undefined ? null : (
                        <span className="truncate text-[12px]" style={{ color: tokens.textSecondary }}>
                            {props.subtitle}
                        </span>
                    )}
                </span>
                <button
                    type="button"
                    data-testid="phone-menu-header-close"
                    aria-label="Close"
                    className="flex h-[44px] w-[44px] shrink-0 items-center justify-center"
                    style={{ color: tokens.textSecondary }}
                    onClick={props.onClose}
                >
                    <PhoneGlyph name="x" size={20} weight={2} />
                </button>
            </div>
            <div className="flex min-h-0 flex-col overflow-y-auto px-3 pb-3" data-testid="phone-menu-items">
                <div className="flex flex-col overflow-hidden rounded-[16px] border" style={{ background: phoneStyle.raised, borderColor: phoneStyle.raisedBorder }}>
                    {rows.map((item, index) => (
                        <button
                            key={item.id}
                            type="button"
                            data-testid={`phone-menu-${item.id}`}
                            disabled={item.disabled ?? false}
                            className="flex min-h-[52px] items-center gap-3 px-[14px] py-2 text-left"
                            style={{
                                color: tokens.textPrimary,
                                borderTop: index === 0 ? 'none' : `1px solid ${phoneStyle.raisedBorder}`,
                                opacity: item.disabled === true ? 0.45 : 1
                            }}
                            onClick={() => select(item)}
                        >
                            <span className="flex shrink-0" style={{ color: tokens.textSecondary }}>
                                <PhoneGlyph name={item.glyph ?? 'chevron-right'} size={19} />
                            </span>
                            <span className="flex min-w-0 flex-1 flex-col gap-[1px]">
                                <span className="truncate text-[15px]">{item.label}</span>
                                {item.detail === undefined ? null : (
                                    <span className="truncate text-[12px]" style={{ color: tokens.textSecondary }}>
                                        {item.detail}
                                    </span>
                                )}
                            </span>
                            {item.value === undefined ? null : (
                                <span className="shrink-0 text-[13px]" style={{ color: tokens.textSecondary }}>
                                    {item.value}
                                </span>
                            )}
                        </button>
                    ))}
                </div>
                {props.note === undefined ? null : (
                    <p className="m-0 flex gap-2 px-2 pt-3 text-[12px] leading-[17px]" style={{ color: tokens.textSecondary }} data-testid="phone-menu-note">
                        {props.note}
                    </p>
                )}
                {danger.map((item) => (
                    <button
                        key={item.id}
                        type="button"
                        data-testid={`phone-menu-${item.id}`}
                        disabled={item.disabled ?? false}
                        className="mt-3 flex min-h-[48px] items-center justify-center gap-2 rounded-[14px] border text-[15px] font-semibold"
                        style={{ color: '#E5484D', borderColor: 'color-mix(in srgb, #E5484D 35%, transparent)', background: 'color-mix(in srgb, #E5484D 8%, transparent)' }}
                        onClick={() => select(item)}
                    >
                        <PhoneGlyph name="x" size={16} weight={2.2} />
                        {item.label}
                    </button>
                ))}
            </div>
        </PhoneSheet>
    );
}
