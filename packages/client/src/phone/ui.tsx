/**
 * The phone shell's primitives: a thumb-sized button, the safe-area insets, and the sheet every
 * phone overlay is built from (a bottom sheet for lists and actions, a left drawer for the
 * workspaces).
 *
 * **An owner-directed divergence from the shipped Swift app**, like every phone rule in this
 * program (there is no Swift phone UI; `chrome/form-factor.ts` says so once for all of it).
 *
 * Every sheet registers with `chrome/modal-presence.ts` for as long as it is open, exactly as B5's
 * two full-screen sheets and every desktop dialog do, so a live web pane's view is parked and the
 * assembly's `modalOpen` predicate sees it without being told. A sheet takes DOM focus when it
 * opens: that is what lets Escape reach its own handler, and it is what puts a software keyboard
 * AWAY when a drawer slides over the terminal (the caret leaves the engine's textarea). It does
 * not hand the caret back when it closes - C5's rule (`mayClaimPaneCaret`): on a phone the
 * keyboard rises only when the person taps the terminal.
 */

import { useEffect, useRef, type KeyboardEvent, type ReactElement, type ReactNode, type RefObject } from 'react';

import { useModalPresence } from '../chrome/modal-presence';
import { tokens } from '../chrome/tokens';

/** The smallest box a thumb can hit reliably; the same floor B5's sheets use. */
export const PHONE_ROW_MIN_PX = 44;

/**
 * `calc()`-wrapped so jsdom keeps the declaration (B5 measured that a bare `env()` is dropped by a
 * parser that does not know it, while the `calc()` form round-trips verbatim).
 */
export const PHONE_SAFE_AREA = {
    top: 'calc(env(safe-area-inset-top))',
    bottom: 'calc(env(safe-area-inset-bottom))',
    left: 'calc(env(safe-area-inset-left))',
    right: 'calc(env(safe-area-inset-right))'
} as const;

export interface PhoneButtonProps {
    readonly testID: string;
    readonly onClick: () => void;
    readonly children: ReactNode;
    readonly ariaLabel?: string | undefined;
    readonly ariaExpanded?: boolean | undefined;
    readonly disabled?: boolean | undefined;
    readonly danger?: boolean | undefined;
    readonly buttonRef?: RefObject<HTMLButtonElement | null> | undefined;
    readonly className?: string | undefined;
}

/** A thumb-sized, accent-coloured text/glyph button. */
export function PhoneButton(props: PhoneButtonProps): ReactElement {
    return (
        <button
            ref={props.buttonRef ?? null}
            type="button"
            data-testid={props.testID}
            aria-label={props.ariaLabel ?? undefined}
            aria-expanded={props.ariaExpanded ?? undefined}
            disabled={props.disabled ?? false}
            className={`flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded px-2 text-[15px] ${props.className ?? ''}`}
            style={{
                color: props.danger === true ? '#E5484D' : tokens.accent,
                minHeight: `${String(PHONE_ROW_MIN_PX)}px`,
                minWidth: `${String(PHONE_ROW_MIN_PX)}px`,
                opacity: props.disabled === true ? 0.4 : 1
            }}
            onClick={props.onClick}
        >
            {props.children}
        </button>
    );
}

export interface PhoneSheetProps {
    readonly open: boolean;
    /** `bottom` slides up from the home edge; `left` is the drawer. */
    readonly side: 'bottom' | 'left';
    readonly label: string;
    readonly testID: string;
    readonly onClose: () => void;
    readonly children: ReactNode;
}

/**
 * A modal sheet: a scrim that closes on tap, a panel that closes on Escape, focus on open.
 *
 * `fixed` against the viewport for the reason B5 recorded on the Settings sheet: the phone shell
 * is the assembly and a sheet must not care what box it was mounted in.
 */
export function PhoneSheet(props: PhoneSheetProps): ReactElement | null {
    const panelRef = useRef<HTMLDivElement | null>(null);
    useModalPresence(props.open);

    useEffect(() => {
        if (props.open) panelRef.current?.focus();
    }, [props.open]);

    if (!props.open) return null;

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        props.onClose();
    };

    const bottom = props.side === 'bottom';
    return (
        <div
            data-testid={props.testID}
            data-phone-sheet-side={props.side}
            className="fixed inset-0 z-40 flex"
            style={{ flexDirection: bottom ? 'column' : 'row-reverse' }}
        >
            {/* The scrim is what "tap outside" hits; the panel is a sibling so its taps stay its own. */}
            <div
                data-testid={`${props.testID}-scrim`}
                className="min-h-0 min-w-0 flex-1"
                style={{ background: 'rgba(0, 0, 0, 0.45)' }}
                onClick={props.onClose}
            />
            <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-label={props.label}
                tabIndex={-1}
                data-testid={`${props.testID}-panel`}
                className={
                    bottom
                        ? 'flex max-h-[75vh] shrink-0 flex-col overflow-hidden rounded-t-2xl outline-none'
                        : 'flex h-full w-[82vw] max-w-[340px] shrink-0 flex-col overflow-hidden outline-none'
                }
                style={{
                    background: tokens.surfaceBackground,
                    color: tokens.textPrimary,
                    boxShadow: '0 -4px 24px rgba(0, 0, 0, 0.35)',
                    paddingBottom: PHONE_SAFE_AREA.bottom,
                    ...(bottom
                        ? { paddingLeft: PHONE_SAFE_AREA.left, paddingRight: PHONE_SAFE_AREA.right }
                        : { paddingTop: PHONE_SAFE_AREA.top, paddingLeft: PHONE_SAFE_AREA.left })
                }}
                onKeyDown={onKeyDown}
            >
                {props.children}
            </div>
        </div>
    );
}

export interface PhoneSheetHeaderProps {
    readonly title: string;
    readonly testID: string;
    readonly onClose: () => void;
    readonly leading?: ReactNode;
}

/** One header shape for every sheet: a title and Close on the trailing edge. */
export function PhoneSheetHeader(props: PhoneSheetHeaderProps): ReactElement {
    return (
        <div
            data-testid={props.testID}
            className="flex shrink-0 items-center gap-2 border-b px-3"
            style={{ borderColor: tokens.divider, minHeight: `${String(PHONE_ROW_MIN_PX)}px` }}
        >
            {props.leading}
            <span className="truncate text-[15px] font-semibold" style={{ color: tokens.textPrimary }}>
                {props.title}
            </span>
            <span className="ml-auto">
                <PhoneButton testID={`${props.testID}-close`} onClick={props.onClose}>
                    Close
                </PhoneButton>
            </span>
        </div>
    );
}

export interface PhoneRowProps {
    readonly testID: string;
    readonly onClick: () => void;
    readonly children: ReactNode;
    readonly active?: boolean | undefined;
    readonly danger?: boolean | undefined;
    readonly disabled?: boolean | undefined;
    readonly ariaLabel?: string | undefined;
}

/** A full-width list row at the thumb floor. */
export function PhoneRow(props: PhoneRowProps): ReactElement {
    return (
        <button
            type="button"
            data-testid={props.testID}
            data-active={props.active === true ? 'true' : 'false'}
            aria-label={props.ariaLabel ?? undefined}
            disabled={props.disabled ?? false}
            className="flex w-full items-center gap-3 px-4 text-left text-[15px]"
            style={{
                minHeight: `${String(PHONE_ROW_MIN_PX)}px`,
                color: props.danger === true ? '#E5484D' : tokens.textPrimary,
                background: props.active === true ? tokens.selectionFill : 'transparent',
                opacity: props.disabled === true ? 0.4 : 1
            }}
            onClick={props.onClick}
        >
            {props.children}
        </button>
    );
}

/** The pane-status dot the sidebar and the footer draw, at header size. */
export function statusDotColor(status: string): string | null {
    if (status === 'waitingForInput') return tokens.statusWaiting;
    if (status === 'running') return tokens.statusRunning;
    return null;
}
