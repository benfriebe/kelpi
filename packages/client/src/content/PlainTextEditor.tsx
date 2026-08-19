/**
 * The built-in plain-text editor (content-panes.md §4.2), shared by markdown edit mode and
 * scratchpad panes — the two places the port keeps a local buffer.
 *
 * Deliberately plain: a monospace `textarea`, never a rich editor, sitting transparent on the
 * pane's ghostty-colored fill with a luminance-picked text color. The daemon owns the save (a
 * 500 ms debounced atomic write for markdown, the pane record for a scratchpad); this owns
 * only what a text field must: the caret, the local buffer, and the scroll position.
 *
 * Two rules are worth naming:
 *
 *   - **The typist wins.** An incoming buffer (another client's autosave echoing back, the
 *     daemon re-reading the file) is adopted only while the field is unfocused. Mid-keystroke
 *     adoption would move the caret and lose characters, and §4.2 is explicit that the last
 *     writer wins rather than the two being merged.
 *   - **⌘E is handled here.** The app's key interceptor deliberately ignores pane bindings while
 *     a text field has focus, so the editor answers the toggle itself — otherwise ⌘E would work
 *     going into edit mode and not coming back out.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import { contentScrollStore, type ScrollStore } from './scroll';
import { editorTextColor } from './types';

/** §4.2: the editor is fixed 13 px monospace; the preview's font-size bindings do not apply. */
export const EDITOR_FONT_SIZE = 13;

/** §4.2 gutter metrics: 11 px numbers, ≥36 px wide, 8 px gutter padding + 4 px text padding. */
export const GUTTER_FONT_SIZE = 11;
export const GUTTER_MIN_WIDTH = 36;
export const GUTTER_PADDING = 8;
export const GUTTER_TEXT_PADDING = 4;
/** Shared by the textarea and the gutter so their first rows sit on the same baseline. */
const EDITOR_PADDING = 12;
const LINE_HEIGHT = 1.5;

/** §4.2: `\n` count + 1 — a trailing newline shows one extra number, an empty document "1". */
export function lineCount(text: string): number {
    let lines = 1;
    for (let index = 0; index < text.length; index += 1) {
        if (text[index] === '\n') lines += 1;
    }
    return lines;
}

/**
 * §4.2: 36 px minimum, growing to fit the largest line number. The digits are monospace, so
 * the width is a character count rather than a measurement — which keeps this pure and lets
 * the gutter size itself before the first paint.
 */
export function gutterWidth(lines: number): number {
    const digits = String(Math.max(1, lines)).length;
    // 0.6em is the advance width of the monospace stacks used below; rounding up keeps the
    // last digit clear of the divider at every count.
    const text = Math.ceil(digits * GUTTER_FONT_SIZE * 0.6) + GUTTER_TEXT_PADDING;
    return Math.max(GUTTER_MIN_WIDTH, text + GUTTER_PADDING);
}

export interface PlainTextEditorProps {
    readonly paneID: string;
    readonly value: string;
    readonly onChange: (text: string) => void;
    /** Blur / unmount: push whatever the debounce still holds. */
    readonly onFlush?: (() => void) | undefined;
    readonly isDark?: boolean | undefined;
    readonly focused?: boolean | undefined;
    readonly visible?: boolean | undefined;
    readonly readOnly?: boolean | undefined;
    readonly onToggleEdit?: ((paneID: string) => void) | undefined;
    readonly onFocusRequest?: ((paneID: string) => void) | undefined;
    readonly scrollStore?: ScrollStore | undefined;
    readonly ariaLabel: string;
    readonly background?: string | undefined;
    /** §4.2's line-number gutter. Off by default so a bare editor stays a bare editor. */
    readonly showGutter?: boolean | undefined;
    readonly testID?: string | undefined;
}

/** Never steal the caret from a text field outside this pane (a rename, the palette). */
function mayGrabFocus(element: HTMLElement | null): boolean {
    if (typeof document === 'undefined') return true;
    const active = document.activeElement;
    if (active === null || active === document.body || active === element) return true;
    const tag = active.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return false;
    return !(active instanceof HTMLElement && active.isContentEditable);
}

export function PlainTextEditor(props: PlainTextEditorProps): ReactElement {
    const { paneID, value: incoming, ariaLabel } = props;
    const store = props.scrollStore ?? contentScrollStore;

    const areaRef = useRef<HTMLTextAreaElement | null>(null);
    const [value, setValue] = useState(incoming);
    const externalRef = useRef(incoming);
    const hasFocusRef = useRef(false);

    const latest = useRef(props);
    useEffect(() => {
        latest.current = props;
    });

    // Adopt the daemon's buffer only when the user is not typing into this one.
    useEffect(() => {
        if (incoming === externalRef.current) return;
        externalRef.current = incoming;
        if (hasFocusRef.current) return;
        setValue(incoming);
    }, [incoming]);

    // Scroll position is shared with the preview, so ⌘E keeps your place both ways (§9).
    useEffect(() => {
        const area = areaRef.current;
        if (area === null) return;
        const saved = store.get(paneID);
        if (saved === null || saved.fraction <= 0) return;
        const max = Math.max(0, area.scrollHeight - area.clientHeight);
        if (max > 0) area.scrollTop = saved.fraction * max;
    }, [paneID, store]);

    // Mounting into a focused pane claims the caret; losing focus releases it so the next
    // pane's claim is not blocked (§4.3).
    const focused = props.focused === true;
    const wasFocused = useRef(false);
    useEffect(() => {
        const area = areaRef.current;
        if (area === null) return;
        if (focused && !wasFocused.current && mayGrabFocus(area)) area.focus();
        if (!focused && wasFocused.current && document.activeElement === area) area.blur();
        wasFocused.current = focused;
    }, [focused]);

    // A pane whose body unmounts (workspace switch, ⌘E back to preview) still owes its text.
    useEffect(
        () => () => {
            latest.current.onFlush?.();
        },
        []
    );

    // The gutter is a plain scrolled div, not a second scroller: it is translated by the
    // textarea's own `scrollTop` so the numbers cannot drift out of step with the rows.
    const gutterRef = useRef<HTMLDivElement | null>(null);

    const onScroll = useCallback((): void => {
        const area = areaRef.current;
        if (area === null) return;
        const max = Math.max(0, area.scrollHeight - area.clientHeight);
        store.set(paneID, { top: area.scrollTop, fraction: max > 0 ? area.scrollTop / max : 0 });
        const gutter = gutterRef.current;
        if (gutter !== null) gutter.style.transform = `translateY(${String(-area.scrollTop)}px)`;
    }, [paneID, store]);

    const showGutter = props.showGutter === true;
    const lines = showGutter ? lineCount(value) : 1;
    const gutterPx = showGutter ? gutterWidth(lines) : 0;

    return (
        <div
            data-testid={props.testID ?? `content-editor-${paneID}`}
            data-pane-id={paneID}
            className="relative flex h-full w-full overflow-hidden"
            style={{
                background: props.background ?? 'var(--nex-term-bg, #0A0A0C)',
                visibility: props.visible === false ? 'hidden' : 'visible'
            }}
            onMouseDownCapture={() => latest.current.onFocusRequest?.(paneID)}
        >
            {showGutter ? (
                <div
                    aria-hidden
                    data-testid={`content-gutter-${paneID}`}
                    data-lines={lines}
                    className="h-full shrink-0 select-none overflow-hidden"
                    style={{
                        width: gutterPx,
                        // §4.2: the gutter wears the pane-header chrome color, the numbers the
                        // tertiary chrome text color — chrome tokens, unlike the editor's own
                        // luminance-picked text, because the gutter is chrome.
                        background: 'var(--nex-header-bg, #17171B)',
                        borderRight: '1px solid var(--nex-divider, #2A2A31)'
                    }}
                >
                    <div
                        ref={gutterRef}
                        className="text-right"
                        style={{
                            paddingTop: EDITOR_PADDING,
                            paddingRight: GUTTER_TEXT_PADDING,
                            color: 'var(--nex-fg-tertiary, #6A6A72)',
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                            fontSize: `${GUTTER_FONT_SIZE}px`,
                            // The numbers must ride the TEXT's line box, not their own, or the
                            // two columns diverge a fraction of a pixel per line.
                            lineHeight: `${String(EDITOR_FONT_SIZE * LINE_HEIGHT)}px`
                        }}
                    >
                        {Array.from({ length: lines }, (_unused, index) => (
                            <div key={index}>{index + 1}</div>
                        ))}
                    </div>
                </div>
            ) : null}
            <textarea
                ref={areaRef}
                data-testid={`content-textarea-${paneID}`}
                aria-label={ariaLabel}
                className="h-full min-w-0 flex-1 resize-none border-0 bg-transparent p-3 outline-none"
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                wrap="off"
                readOnly={props.readOnly === true}
                value={value}
                style={{
                    color: editorTextColor(props.isDark !== false),
                    caretColor: editorTextColor(props.isDark !== false),
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: `${EDITOR_FONT_SIZE}px`,
                    lineHeight: 1.5,
                    tabSize: 4
                }}
                onChange={(event) => {
                    const next = event.target.value;
                    setValue(next);
                    latest.current.onChange(next);
                }}
                onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && (event.key === 'e' || event.key === 'E')) {
                        event.preventDefault();
                        event.stopPropagation();
                        latest.current.onToggleEdit?.(paneID);
                    }
                }}
                onFocus={() => {
                    hasFocusRef.current = true;
                    latest.current.onFocusRequest?.(paneID);
                }}
                onBlur={() => {
                    // The buffer stays as typed: what the daemon saves comes back as an
                    // `incoming` change, which the adoption effect then applies.
                    hasFocusRef.current = false;
                    latest.current.onFlush?.();
                }}
                onScroll={onScroll}
            />
        </div>
    );
}
