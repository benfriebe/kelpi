/**
 * The phone's ONE key bar, and the content area it sits under (C9, docs/MOBILE-PLAN.md §4, §7).
 *
 * **Owner-directed divergence from the shipped Swift app.** The shipped app is a Mac app; there is
 * no Swift phone UI, so nothing in this file has a parity reference and nothing in it can have one.
 * `chrome/form-factor.ts` says that once for the whole phone program; this is the window layer's
 * instance of it.
 *
 * ## The report this file answers
 *
 * The owner, on a real Android phone, 2026-09-08: *"the phone button bar renders only inside a
 * single pane; when the panes are split the bar renders only in the active pane, instead of across
 * the bottom."* C1 mounted `<KeyBar>` inside `TerminalPane`, so the bar was a piece of one pane's
 * box: with one pane it looked window-wide because that pane WAS the window, and the moment the
 * grid held two panes the bar was half a screen wide, in a column, under one of them.
 *
 * So the bar is mounted once, here, at the bottom of the content area - the row that holds the
 * pane grid, under the title bar and above the status footer - spanning the window, and it acts on
 * the terminal pane that holds the caret. Everything C1, C3, C4 and C8 put in the bar is unchanged;
 * what changed is which box it is in and how it finds its terminal.
 *
 * ## How it finds its terminal
 *
 * Through `terminal/pane-registry.ts`, which already answered "the live terminal for pane X" for
 * the app's `copy` (#81) and line-editing writes (#82). The handle grew the six things the bar does
 * to a pane (`dispatchKey`, `pasteText`, `showKeyboard`, `hideKeyboard`, `root`, `cellHeight`) plus
 * the predicate that used to be the bar's own mount condition (`focusedOnScreen`, i.e. C1's
 * `focused && visible` asked once for the window). Two consequences worth stating:
 *
 *   - **the registry is the pane-type test**, as its header says. A handle exists exactly for a
 *     pane with a live terminal renderer, so the bar shows for a terminal, and hides for a web
 *     pane, a markdown pane, a pane whose engine has not opened yet, a remote workspace's grid and
 *     "no workspace selected", without this file knowing what any of those are;
 *   - **the bar re-targets rather than remounting.** The sticky-modifier interceptor binds to the
 *     FOCUSED pane's root (`KeyBar.tsx`'s header: the root is above the host, so a capture listener
 *     there runs before the kitty interceptor and the engine's own), so `captureRoot` is a ref
 *     whose identity changes when the target does and the interceptor rebinds with it. Tapping the
 *     other pane moves the whole bar's aim in one commit.
 *
 * ## Where it sits, and why it does not wrap the content row
 *
 * The bar is the LAST child of the content row (`App.tsx`), out of flow at the row's bottom edge,
 * and the row is given a bottom padding of the bar's height plus the keyboard's inset. The row's
 * content box therefore ends exactly at the bar's top edge: the sidebar, the pane grid and the
 * inspector all lose those pixels, every pane in the grid gets shorter through the
 * `ResizeObserver` it already has, and nothing is drawn over a terminal.
 *
 * A wrapper element around the row would have been the obvious shape and is deliberately not used:
 * a wrapper that exists only under the phone form factor RE-PARENTS the whole content row when the
 * form factor flips, which unmounts and rebuilds every pane's engine. That flip is rare on a device
 * (an iPad mini pairing a mouse) and constant in the audit, whose phone lane emulates and clears a
 * phone viewport around every step - eight engine rebuild storms per run, each one a chance at the
 * `RangeError` ghostty-web 0.4 throws on a freshly created terminal (run-F N1). Out of flow plus a
 * padding keeps the row's children exactly where React put them.
 *
 * The one thing that shape costs is that the bar's height is used twice - once as the element's own
 * height and once in the padding - so it is one exported constant (`KEY_BAR_HEIGHT_PX`) read in
 * both places, and the bar's height is fixed inline rather than derived from its contents.
 *
 * ## Where the keyboard inset lives now (§7, "Keyboard inset ownership")
 *
 * §7 recorded C1's bar as sitting in flow inside the pane, with the terminal host shrinking by the
 * bar's own height, and C6 then made the pane pad ITSELF for the software keyboard so the bar rode
 * the keyboard's animation. Both were consequences of the bar being in the pane. With one bar for
 * the window, the inset is one per window too, and it is applied HERE, in the same task as every
 * visual-viewport event, so
 *
 *   - the bar sits directly above the keyboard, riding its animation rather than jumping to its
 *     resting place a settle window later (C6's whole point, at the window's level): the padding
 *     grows with the keyboard and the bar's own `bottom` rises with it;
 *   - every pane in the grid gets shorter, and each one still tells the daemon exactly once per
 *     transition, because the settle gate is still the pane's (`TerminalPane`'s keyboard effect,
 *     `keyboard-inset.ts`). A pane's rect is a pixel value `grid/PaneGrid.tsx` rewrites from its
 *     own `ResizeObserver`, which fires after layout and re-renders through `flushSync` inside the
 *     same frame (§N31), so the panes follow this padding within the frame that moved it and are
 *     never painted stale - one rendering step behind a read taken in the viewport event's own
 *     task, which is what `phone-keyboard-inset` samples twice per frame to show;
 *   - the keyboard's pixels are taken ONCE, where the keyboard is. Two stacked panes each padding
 *     themselves took 300 px of terminal each for one 300 px keyboard.
 *
 * C7's `resizes-content` mode (`index.html`, Chrome 108+) shrinks the layout viewport instead, so
 * the measured inset is zero and only the bar's own height is taken: the arithmetic path below is
 * for the browsers that ignore the meta (iOS, and Chrome's own `resizes-visual` default).
 *
 * ## And nothing at all on a desktop
 *
 * Off the phone form factor this component renders NOTHING - no element, no listener, no
 * subscription, and not one attribute or style on the row it was given (MOBILE-PLAN.md §3,
 * principle 1). The desktop content row is the element it has always been, in the box it has
 * always had.
 */

import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
    type ReactElement,
    type RefObject
} from 'react';

import { defaultFormFactorWindow, useFormFactor, type FormFactorWindow } from '../chrome/form-factor';
import { KEY_BAR_HEIGHT_PX, KeyBar, type StickyModifiers } from './KeyBar';
import { PHONE_KEYBOARD_SETTLE_MS, keyboardBoxInset, watchSoftKeyboardMotion } from './keyboard-inset';
import { paneHandle, subscribeTerminalPanes, terminalPanesVersion, type TerminalPaneHandle } from './pane-registry';
import type { TerminalKeyInit } from './renderer';

/**
 * The content area's hook, for the audit and for the sibling phone lanes.
 *
 * Written on the CONTENT ROW (`App.tsx`) while the form factor is phone, and taken off again with
 * everything else this component applies. It marks the box the keyboard is taken out of and the box
 * the bar spans: `phone-key-bar-split` measures the bar's rect against this element's, and
 * `phone-keyboard-inset` reads the padding it takes frame by frame.
 */
export const PHONE_CONTENT_AREA_ATTR = 'data-phone-content-area';

/**
 * The keyboard inset this area's box is currently shrunk by, in CSS px, as a `data-` attribute.
 *
 * The window-level companion to the pane's own `data-terminal-keyboard-inset`: this is what was
 * APPLIED (clamped so a keyboard taller than the content area still leaves a line to type on), and
 * the pane's is what each pane MEASURED. They agree except under that clamp. The bar's own height
 * is NOT in it: that is a constant, and it is in the area's padding either way.
 */
export const PHONE_KEYBOARD_INSET_ATTR = 'data-phone-keyboard-inset';

/** The bar's own box inside the content area, for the audit's selectors. */
export const PHONE_KEY_BAR_SLOT_ATTR = 'data-phone-key-bar-slot';

export interface PhoneKeyBarProps {
    /**
     * The window's focused pane, from the app. The bar acts on this pane when it has a live
     * terminal renderer and shows nothing when it does not - a web pane, a content pane, a pane
     * still opening its engine, or nothing focused at all.
     */
    readonly paneID: string | null;
    /**
     * The content row this bar sits at the bottom of: the row that holds the pane grid, with the
     * sidebar and the inspector either side of it.
     *
     * A ref to a node the app renders rather than a wrapper of this component's own, so that a
     * form-factor flip mounts and unmounts THIS component and nothing else - see the header. The
     * row is `relative`, which is what the bar is positioned against; this component writes the
     * row's bottom padding and its two `data-` attributes while it is mounted, and takes all three
     * off when it goes.
     */
    readonly contentRow: RefObject<HTMLElement | null>;
    /**
     * The window the form factor and the software keyboard are read from. Defaults to the page's
     * own; it exists so a jsdom test can drive a fake `visualViewport`, which is the only way to
     * have a software keyboard at all off a device.
     */
    readonly formFactorWindow?: FormFactorWindow | undefined;
    /** How long the viewport must hold still; defaults to `PHONE_KEYBOARD_SETTLE_MS`. */
    readonly keyboardSettleMs?: number | undefined;
    /**
     * B1 - `paneID` names a terminal that is on its way: keep the bar's room in the row (and the
     * bar itself on screen, with its keys inert) while the registry has no handle for it yet.
     *
     * The phone shell shows ONE pane at a time, so a switch UNMOUNTS the old terminal and mounts
     * the new one. Read through the registry alone, that is a moment with no terminal: the bar's
     * 45 px came off the row, the new pane measured the taller box and attached at that grid,
     * the handle registered, the 45 px went back on, and the pane resized again - a reflow of a
     * replay the person had just been shown, which is the "garbage that flashes" the owner saw on
     * the device (2026-09-08; measured on the dev instance: rows 53 then 50 about 200 ms apart).
     * A split grid never had the gap because its other pane kept the registry warm. False (the
     * default, and the desktop's row) changes nothing.
     */
    readonly reserve?: boolean | undefined;
    /**
     * How the content row's box is measured; defaults to `clientWidth`/`clientHeight`.
     *
     * The same seam `TerminalPane` carries, for the same reason: jsdom reports 0x0 for every
     * element, and the clamp below is arithmetic on a real height.
     */
    readonly measure?: ((element: HTMLElement) => { width: number; height: number }) | undefined;
}

export function PhoneKeyBar({
    paneID,
    contentRow,
    formFactorWindow,
    keyboardSettleMs,
    measure,
    reserve
}: PhoneKeyBarProps): ReactElement | null {
    const win = formFactorWindow ?? defaultFormFactorWindow();
    const phone = useFormFactor(win) === 'phone';
    const settleMs = keyboardSettleMs ?? PHONE_KEYBOARD_SETTLE_MS;

    /*
     * The registry, re-read whenever it changes - and subscribed to ONLY on a phone.
     *
     * A pane registers inside its own mount effect, i.e. after the commit that rendered this
     * component, so a pull alone would decide "no terminal" once and never look again. The
     * subscription is what makes the bar appear when the engine opens, disappear when it goes, and
     * move when the ring does (`TerminalPane` announces that one). On a desktop `subscribe` binds
     * nothing and the snapshot never changes, so a pane opening or closing costs this component -
     * and the whole content row under it - not one render.
     */
    const subscribe = useCallback(
        (onChange: () => void): (() => void) => (phone ? subscribeTerminalPanes(onChange) : () => undefined),
        [phone]
    );
    const version = useSyncExternalStore(subscribe, terminalPanesVersion, terminalPanesVersion);
    const target = useMemo((): TerminalPaneHandle | null => {
        // `version` is a dependency and not an input: it is the registry saying "the map may have
        // moved", and the two lines below are the read.
        void version;
        if (!phone) return null;
        const handle = paneHandle(paneID);
        // C1's mount condition, asked once for the window. `focusedOnScreen` is the pane's own
        // `focused && visible`, which is why a zoomed-away pane and a background workspace's
        // focused pane both answer no.
        return handle !== null && handle.focusedOnScreen() ? handle : null;
    }, [phone, paneID, version]);

    /** What the row's KEYBOARD inset currently is, so a frame that changes nothing writes nothing. */
    const insetRef = useRef(0);
    /** …and the same number in state, because the bar's own `bottom` rides it. */
    const [keyboardInset, setKeyboardInset] = useState(0);
    /** Whether the row is currently making room for a bar. Read by {@link writeRowBox}. */
    // The room is held for a reserved pane before its handle lands; see `reserve`.
    const reserved = reserve === true && paneID !== null;
    const barShownRef = useRef(false);
    barShownRef.current = target !== null || reserved;
    /**
     * The pane every callback below acts on, read at CALL time.
     *
     * Written during render for the same reason `KeyBar` writes `sendKeyRef`: the bar's handlers
     * are built once and the target moves under them, and a stale closure would type into the pane
     * a thumb has just left.
     */
    const targetRef = useRef<TerminalPaneHandle | null>(null);
    targetRef.current = target;
    /** The measurement seam, read at apply time for the same reason. */
    const measureRef = useRef(measure);
    measureRef.current = measure;

    /**
     * The row's box, at the viewport's clock.
     *
     * `KEY_BAR_HEIGHT_PX` is always in the padding - the bar is out of flow, so the row has to make
     * the room itself - and the keyboard's inset is added to it. One height read per frame BEFORE
     * the write, so the browser flushes layout once rather than thrashing, and the capacity is the
     * row as it stands plus what has already been taken off it for the keyboard, i.e. the box with
     * no keyboard in it. {@link keyboardBoxInset} is the same clamp C6 used, one level up: the
     * content area never shrinks below one cell, because a keyboard taller than the window must
     * still leave a line to type on.
     *
     * The style write is imperative and the STATE write beside it is what moves the bar's own
     * `bottom`. Both happen in the task the viewport event arrived in; the state write costs this
     * component (and only this component) a render per frame of a keyboard animation, which is a
     * 45 px strip of buttons re-rendering, not the pane grid.
     */
    /**
     * The row's padding and the attributes that report it: the bar's height when there is a bar,
     * plus the keyboard's inset, whether or not there is one.
     *
     * The keyboard's half is applied even with no bar on screen (a web pane focused, say), because
     * it is a fact about the window rather than about the terminal: the bottom of the content area
     * is under a keyboard either way.
     */
    const writeRowBox = useCallback((): void => {
        const row = contentRow.current;
        if (row === null) return;
        const bar = barShownRef.current ? KEY_BAR_HEIGHT_PX : 0;
        row.style.paddingBottom = `${String(bar + insetRef.current)}px`;
        row.setAttribute(PHONE_KEYBOARD_INSET_ATTR, String(insetRef.current));
    }, [contentRow]);

    const applyKeyboardInset = useCallback(
        (inset: number): void => {
            const row = contentRow.current;
            if (row === null) return;
            const applied = insetRef.current;
            const box = measureRef.current?.(row) ?? { width: row.clientWidth, height: row.clientHeight };
            const capacity = box.height + applied;
            const next = inset > 0 ? keyboardBoxInset(capacity, inset, targetRef.current?.cellHeight() ?? 0) : 0;
            if (next === applied) return;
            insetRef.current = next;
            writeRowBox();
            setKeyboardInset(next);
        },
        [contentRow, writeRowBox]
    );

    // The bar appearing or going takes its 45 px with it: the row makes room for a bar that is
    // there and gives it back for one that is not, which is what a web pane taking the focus on a
    // phone looks like from here.
    useEffect(() => {
        if (!phone) return;
        writeRowBox();
    }, [phone, target, reserved, writeRowBox]);

    useEffect(() => {
        const row = contentRow.current;
        if (!phone || row === null) return;
        /*
         * The row's own state, applied on mount and taken off on unmount - which is the form
         * factor's edge, and the whole of "a desktop window is byte-identical".
         *
         * Written imperatively rather than through React because the row is the APP's element:
         * React renders neither a `style` nor these attributes on it, so nothing here can be
         * clobbered by a re-render and nothing the app renders is fighting these writes.
         */
        row.setAttribute(PHONE_CONTENT_AREA_ATTR, '');
        writeRowBox();
        const motion = watchSoftKeyboardMotion(
            win,
            {
                onMove: applyKeyboardInset,
                // The settle is the PANE's clock, not this one's: what the window owes the
                // keyboard's end is the same box it owed every frame of it. Applying it again is
                // the cheap way to be sure the last frame and the rest agree, and the panes
                // measure themselves off the box this leaves.
                onSettle: applyKeyboardInset
            },
            settleMs
        );
        // A window that opens (or turns into a phone) with the keyboard already up takes it
        // straight away: that is not a transition, so it neither waits for a settle nor pretends
        // one happened.
        applyKeyboardInset(motion.live());
        return () => {
            motion.dispose();
            insetRef.current = 0;
            setKeyboardInset(0);
            row.style.removeProperty('padding-bottom');
            row.removeAttribute(PHONE_CONTENT_AREA_ATTR);
            row.removeAttribute(PHONE_KEYBOARD_INSET_ATTR);
        };
    }, [phone, win, settleMs, applyKeyboardInset, writeRowBox, contentRow]);

    /**
     * The pane root the bar's interceptor binds to, as a ref whose IDENTITY moves with the target.
     *
     * `KeyBar`'s two capture-phase effects depend on this object, so a new one is what makes them
     * unbind from the pane that lost the caret and bind to the pane that took it. The node itself
     * is stable for a pane's mount, so this is one object per target, not one per render.
     */
    const captureRoot = useMemo(() => ({ current: target?.root() ?? null }), [target]);

    // Read at call time, never closed over: the target moves between the render that painted a key
    // and the tap that presses it.
    const sendKey = useCallback((init: TerminalKeyInit): boolean => targetRef.current?.dispatchKey(init) ?? false, []);
    const pasteText = useCallback((text: string): boolean => targetRef.current?.pasteText(text) ?? false, []);
    const showKeyboard = useCallback((): void => targetRef.current?.showKeyboard(), []);
    const hideKeyboard = useCallback((): void => targetRef.current?.hideKeyboard(), []);
    // Capture this handle so a rebind can clear the old renderer's modifier state.
    const setInputModifiers = useCallback((modifiers: StickyModifiers): void => target?.setModifiers?.(modifiers), [target]);

    // AND NOT ON DESKTOP: no element, no attributes, no bar. The content row is exactly the row
    // the app rendered before this component existed.
    if (!phone || paneID === null || (target === null && !reserved)) return null;

    return (
        <div
            {...{ [PHONE_KEY_BAR_SLOT_ATTR]: '' }}
            /*
             * Out of flow at the bottom of the content row, spanning it edge to edge, with the row
             * padded by exactly this element's height so nothing is drawn over a terminal (see the
             * header for why it is not a flex child). `z-10` puts it over the pane grid and under
             * every overlay: the palette's scrim is z-40 and the settings sheet z-50.
             */
            className="absolute right-0 bottom-0 left-0 z-10"
            // …and it RIDES the keyboard: the bar's bottom edge is the top of the keyboard, moved
            // in the same task as each viewport event (C6's rule, at the window's box).
            style={{ bottom: keyboardInset }}
        >
            <KeyBar
                paneID={paneID}
                sendKey={sendKey}
                captureRoot={captureRoot}
                setInputModifiers={setInputModifiers}
                hideKeyboard={hideKeyboard}
                showKeyboard={showKeyboard}
                pasteText={pasteText}
            />
        </div>
    );
}
