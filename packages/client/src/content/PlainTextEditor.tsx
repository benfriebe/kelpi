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

import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type ReactElement
} from 'react';

import { cachedLineStarts, visibleLineWindow, type LineWindow } from './gutter';
import { contentScrollStore, type ScrollStore } from './scroll';
import { editorTextColor } from './types';
import {
    CHAR_PROBE,
    contentBoxWidth,
    createWrapCache,
    measureCharWidth,
    measureRows,
    splitLines,
    syncMirrorStyle,
    wrapMetrics,
    wrappedLineWindow,
    type WrapMetrics
} from './wrap';

/** §4.2: the editor is fixed 13 px monospace; the preview's font-size bindings do not apply. */
export const EDITOR_FONT_SIZE = 13;

/** §4.2 gutter metrics: 11 px numbers, ≥36 px wide, 8 px gutter padding + 4 px text padding. */
export const GUTTER_FONT_SIZE = 11;
export const GUTTER_MIN_WIDTH = 36;
export const GUTTER_PADDING = 8;
export const GUTTER_TEXT_PADDING = 4;
/**
 * Shared by the textarea and the gutter so their first rows sit on the same baseline.
 *
 * §M27: 8, not 12 — `ScratchpadEditorView.swift:44-48` and `MarkdownEditorView.swift:36` both
 * set `textContainerInset = NSSize(width: 8, height: 8)`, and the port had grown a `p-3`.
 */
export const EDITOR_PADDING = 8;
/**
 * §M27 — the rendered height of one row, shared by the textarea and the gutter.
 *
 * An `NSTextView` lays `monospacedSystemFont(ofSize: 13)` out at its ascender + descender,
 * ~15.9 px, i.e. about 1.2 em. This was `1.5` (19.5 px), which gave away roughly a quarter of
 * the visible rows in every editor in the app.
 *
 * **An exact integer of px, not the unitless `1.2` the register sketched**, and the difference
 * is not cosmetic: `13 × 1.2` is 15.6, which Chromium snaps to the nearest 1/64 px (15.6015625)
 * when it lays a row out, while the gutter's `padding-top` arithmetic below uses the unrounded
 * value. Over a long document the two diverge — the audit's own alignment check measured the
 * first drawn number **3.12 px** (a fifth of a row) off the line it numbers at line 1992, and it
 * would keep growing. 16 px is within 0.4 px of the 1.2 em estimate, is nearer to what AppKit
 * actually lays SF Mono 13 pt out at, and accumulates nothing.
 */
export const EDITOR_LINE_PX = 16;

/**
 * §4.2: `\n` count + 1 — a trailing newline shows one extra number, an empty document "1".
 *
 * Reads it off the cached line-start array (`./gutter`), so a re-render that did not change the
 * buffer costs a string comparison instead of a scan.
 */
export function lineCount(text: string): number {
    return cachedLineStarts(text).length;
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
    /**
     * §M29 — soft wrap, or a horizontal scrollbar.
     *
     * `MarkdownEditorView.swift:38-40` leaves the text container tracking the view's width, so
     * a markdown buffer wraps to the pane; the port ran every editor at `wrap="off"` and a
     * paragraph of prose disappeared off the right edge. The default stays `'off'` because the
     * SCRATCHPAD's is ledgered that way (`CONT-070` `[d]`) — the markdown editor opts in.
     */
    readonly wrap?: 'off' | 'soft' | undefined;
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

    const showGutter = props.showGutter === true;
    /**
     * §M60 — a wrapping editor needs MEASURED per-line heights; a `wrap="off"` one does not.
     *
     * The scratchpad keeps the cheap fixed-pitch path exactly as it was (`CONT-070`'s ledgered
     * `wrap="off"`): no mirror node, no measurement, no cache. Only the markdown editor, which
     * M29 turned into a soft-wrapping one, pays for the mirror.
     */
    const wrapping = showGutter && props.wrap === 'soft';
    /**
     * §4.2 / §CONT-078: the cached line-start array. A re-render that did not change the buffer
     * reuses it (the port of the ruler's `lineStarts` cache), and its LENGTH is the line count.
     */
    const starts = useMemo(() => cachedLineStarts(showGutter ? value : ''), [showGutter, value]);
    const lines = showGutter ? starts.length : 1;

    /**
     * §M60 — the mirror node, the measurement cache, and the metrics they produce.
     *
     * `metrics` is state because the gutter renders from it; the cache and the last answer are
     * refs because they are the measuring apparatus, not the picture. `wrapMetrics` returns the
     * PREVIOUS object by identity when nothing moved, which is what keeps the layout effect below
     * from looping.
     */
    const mirrorRef = useRef<HTMLDivElement | null>(null);
    const probeRef = useRef<HTMLSpanElement | null>(null);
    const cacheRef = useRef(createWrapCache());
    const metricsRef = useRef<WrapMetrics | null>(null);
    const [metrics, setMetrics] = useState<WrapMetrics | null>(null);

    const remeasure = useCallback((): void => {
        if (!wrapping) {
            if (metricsRef.current !== null) {
                metricsRef.current = null;
                setMetrics(null);
            }
            return;
        }
        const area = areaRef.current;
        const mirror = mirrorRef.current;
        if (area === null || mirror === null) return;

        const width = contentBoxWidth(area);
        // An unmeasured box (a hidden pane, the frame before first layout) has no answer, and
        // bailing HERE keeps that case down to two cheap reads — the retry effect below runs on
        // every render while it lasts, so it must not cost a pass over the buffer.
        if (!(width > 0)) {
            if (metricsRef.current !== null) {
                metricsRef.current = null;
                setMetrics(null);
            }
            return;
        }
        syncMirrorStyle(mirror, area, width);
        const probe = probeRef.current;
        // No width for the probe: it reports its own, and a content-box width would clamp it.
        if (probe !== null) syncMirrorStyle(probe, area);
        const charWidth = probe === null ? 0 : measureCharWidth(probe);

        const next = wrapMetrics(cacheRef.current, {
            lines: splitLines(value),
            width,
            charWidth,
            measure: (text) => measureRows(mirror, text, EDITOR_LINE_PX),
            previous: metricsRef.current
        });
        if (next === metricsRef.current) return;
        metricsRef.current = next;
        setMetrics(next);
    }, [value, wrapping]);

    // Before paint, so the numbers never show at the fixed pitch first and jump afterwards.
    useLayoutEffect(() => {
        remeasure();
    }, [remeasure]);

    /*
     * The retry: deliberately dependency-free, and deliberately guarded on there being NO metrics
     * yet. A pane that mounted while hidden — or before the frame had laid out — has an
     * unmeasurable box, and the effect above only re-runs when the buffer changes, so without this
     * the gutter would stay on the fixed pitch until the next keystroke. The guard is what keeps
     * it cheap: once the heights exist this returns immediately, and while they do not, the bail
     * inside `remeasure` costs two reads rather than a pass over the document.
     */
    useLayoutEffect(() => {
        if (wrapping && metricsRef.current === null) remeasure();
    });

    /**
     * Only the numbers over the visible rows are in the DOM — the ruler draws for the visible
     * rect, and a 200k-line document must not become 200k nodes. `null` until the textarea has
     * been measured, which renders the whole document (short buffers, and the first paint).
     */
    const [lineWindow, setWindow] = useState<LineWindow | null>(null);
    /**
     * §M60: with measured heights the window resolves rows → line through the prefix sums; with
     * `wrap="off"` (the scratchpad) it stays the fixed-pitch arithmetic it has always been. The
     * length check guards the one frame where a keystroke has changed the buffer but the layout
     * effect has not re-measured it yet.
     */
    const wrapRows = metrics !== null && metrics.rows.length === lines ? metrics.rows : null;
    const wrapOffsets = wrapRows === null || metrics === null ? null : metrics.offsets;
    const measureWindow = useCallback((): void => {
        const area = areaRef.current;
        if (area === null) return;
        const measured = metricsRef.current;
        const offsets = measured !== null && measured.rows.length === starts.length ? measured.offsets : null;
        const next =
            offsets === null
                ? visibleLineWindow({
                      starts,
                      scrollTop: area.scrollTop,
                      viewportHeight: area.clientHeight,
                      lineHeight: EDITOR_LINE_PX,
                      paddingTop: EDITOR_PADDING
                  })
                : wrappedLineWindow({
                      offsets,
                      scrollTop: area.scrollTop,
                      viewportHeight: area.clientHeight,
                      lineHeight: EDITOR_LINE_PX,
                      paddingTop: EDITOR_PADDING
                  });
        setWindow((current) =>
            current !== null && current.first === next.first && current.last === next.last
                ? current
                : next
        );
    }, [starts]);

    // Re-clamp when the buffer changes (typing at the end grows the document under the window)
    // and when the measured heights land — the window is computed FROM them.
    useEffect(() => {
        if (!showGutter) return;
        measureWindow();
    }, [measureWindow, metrics, showGutter]);

    /**
     * §M60 — a resize is what invalidates every measured height at once, so the gutter has to be
     * told about one. `ResizeObserver` is absent in jsdom, where nothing has a size anyway.
     */
    useEffect(() => {
        if (!wrapping) return undefined;
        const area = areaRef.current;
        if (area === null || typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver(() => {
            remeasure();
            measureWindow();
        });
        observer.observe(area);
        return () => {
            observer.disconnect();
        };
    }, [measureWindow, remeasure, wrapping]);

    const onScroll = useCallback((): void => {
        const area = areaRef.current;
        if (area === null) return;
        const max = Math.max(0, area.scrollHeight - area.clientHeight);
        store.set(paneID, { top: area.scrollTop, fraction: max > 0 ? area.scrollTop / max : 0 });
        const gutter = gutterRef.current;
        if (gutter !== null) gutter.style.transform = `translateY(${String(-area.scrollTop)}px)`;
        if (showGutter) measureWindow();
    }, [measureWindow, paneID, showGutter, store]);

    const firstLine = lineWindow === null ? 1 : Math.min(lineWindow.first, lines);
    const lastLine = lineWindow === null ? lines : Math.min(lineWindow.last, lines);
    const gutterPx = showGutter ? gutterWidth(lines) : 0;
    /**
     * §M60: the document's height in VISUAL rows — the same number the textarea's own
     * `scrollHeight` implies, which is what lets a live check confirm the measured heights against
     * the browser's real layout instead of against the measurement that produced them. Equal to
     * the line count whenever nothing wraps.
     */
    const totalRows = wrapOffsets === null ? lines : (wrapOffsets[lines] ?? lines);

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
                    // The window actually drawn, so a test can tell "all of it" from "the rows
                    // over the viewport" without measuring the DOM.
                    data-window={`${String(firstLine)}-${String(lastLine)}`}
                    // §M60: visual rows across the whole document (== `data-lines` when nothing
                    // wraps), so a check can hold the measured heights against the textarea's own
                    // `scrollHeight`.
                    data-rows-total={totalRows}
                    className="h-full shrink-0 select-none overflow-hidden"
                    style={{
                        width: gutterPx,
                        // §4.2: the gutter wears the pane-header chrome color, the numbers the
                        // tertiary chrome text color — chrome tokens, unlike the editor's own
                        // luminance-picked text, because the gutter is chrome.
                        // L38: fill only, no rule. `LineNumberRulerView.swift:88-133` fills
                        // `bounds` with the gutter colour and then draws the numbers — it strokes
                        // nothing, so the shipped gutter meets the text on a pure tone change.
                        // The port's 1 px divider drew a hard seam down the middle of the editor
                        // (`run-N/72-scratchpad-create.png`), which reads as a second pane edge
                        // inside one pane. (Register U6 asks whether `NSRulerView`'s own
                        // `draw(_:)` contributes a hairline of its own; nothing in the subclass
                        // does, so parity is the default here and U6 stays the verifier's.)
                        background: 'var(--nex-header-bg, #17171B)'
                    }}
                >
                    <div
                        ref={gutterRef}
                        className="text-right"
                        style={{
                            // The window's own top edge: the rows above it are not drawn, so
                            // the padding stands in for their height and row N stays on the
                            // same baseline as the text it numbers. §M60: with measured heights
                            // that is the TRUE first visual row of `firstLine` (the prefix sum),
                            // not `firstLine - 1` fixed-pitch rows — a wrapped line above the
                            // window takes two rows and the padding has to carry both.
                            paddingTop:
                                EDITOR_PADDING +
                                (wrapOffsets === null
                                    ? (firstLine - 1) * EDITOR_LINE_PX
                                    : (wrapOffsets[firstLine - 1] ?? firstLine - 1) * EDITOR_LINE_PX),
                            paddingRight: GUTTER_TEXT_PADDING,
                            color: 'var(--nex-fg-tertiary, #6A6A72)',
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                            fontSize: `${GUTTER_FONT_SIZE}px`,
                            // The numbers must ride the TEXT's line box, not their own, or the
                            // two columns diverge a fraction of a pixel per line.
                            lineHeight: `${String(EDITOR_LINE_PX)}px`
                        }}
                    >
                        {Array.from({ length: Math.max(0, lastLine - firstLine + 1) }, (_unused, index) => {
                            const line = firstLine + index;
                            // §M60: a wrapped line's number sits beside its FIRST visual row —
                            // `LineNumberRulerView.swift:88-133` draws at the first
                            // `lineFragmentRect` — so the node is as tall as the whole line and
                            // its single 16 px text row lands at the top of that box.
                            const rows = wrapRows === null ? 1 : (wrapRows[line - 1] ?? 1);
                            return (
                                <div
                                    key={line}
                                    data-rows={wrapRows === null ? undefined : rows}
                                    style={rows > 1 ? { height: rows * EDITOR_LINE_PX } : undefined}
                                >
                                    {line}
                                </div>
                            );
                        })}
                    </div>
                </div>
            ) : null}
            {wrapping ? (
                /*
                 * §M60 — the measuring mirror.
                 *
                 * Out of flow, invisible, inert, and styled to the textarea's CONTENT box, so a
                 * line that wraps in the field wraps here at the same character. `pre-wrap` +
                 * `break-word` is the pair a `<textarea>`'s UA stylesheet applies; the probe is a
                 * fixed 64-character run whose width gives one monospace advance, which is what
                 * lets a short ASCII line be answered without touching the DOM at all.
                 */
                <div
                    aria-hidden
                    data-testid={`content-gutter-mirror-${paneID}`}
                    style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        visibility: 'hidden',
                        pointerEvents: 'none',
                        zIndex: -1,
                        height: 'auto',
                        margin: 0,
                        padding: 0,
                        border: 0,
                        boxSizing: 'content-box',
                        whiteSpace: 'pre-wrap',
                        overflowWrap: 'break-word',
                        wordBreak: 'normal',
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                        fontSize: `${EDITOR_FONT_SIZE}px`,
                        lineHeight: `${String(EDITOR_LINE_PX)}px`,
                        tabSize: 4
                    }}
                >
                    <span
                        ref={probeRef}
                        data-testid={`content-gutter-probe-${paneID}`}
                        style={{ position: 'absolute', whiteSpace: 'pre', visibility: 'hidden' }}
                    >
                        {CHAR_PROBE}
                    </span>
                    <div
                        ref={mirrorRef}
                        style={{
                            margin: 0,
                            padding: 0,
                            border: 0,
                            boxSizing: 'content-box',
                            whiteSpace: 'pre-wrap',
                            overflowWrap: 'break-word',
                            wordBreak: 'normal',
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                            fontSize: `${EDITOR_FONT_SIZE}px`,
                            lineHeight: `${String(EDITOR_LINE_PX)}px`,
                            tabSize: 4
                        }}
                    />
                </div>
            ) : null}
            <textarea
                ref={areaRef}
                data-testid={`content-textarea-${paneID}`}
                aria-label={ariaLabel}
                // §M27: `p-2` = the Swift's 8 pt `textContainerInset`.
                className="h-full min-w-0 flex-1 resize-none border-0 bg-transparent p-2 outline-none"
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                wrap={props.wrap ?? 'off'}
                readOnly={props.readOnly === true}
                value={value}
                style={{
                    color: editorTextColor(props.isDark !== false),
                    caretColor: editorTextColor(props.isDark !== false),
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: `${EDITOR_FONT_SIZE}px`,
                    // The constant in PX, not a second literal and not a ratio: the gutter
                    // positions its numbers off `EDITOR_LINE_PX`, and the two disagreeing — even
                    // by the 1/64 px a fractional row height rounds to — is drift down the page.
                    lineHeight: `${String(EDITOR_LINE_PX)}px`,
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
                        return;
                    }
                    /*
                     * §M26 — Tab types a tab.
                     *
                     * `ScratchpadEditorView.swift:23-33` is an `NSTextView`, where Tab is a text
                     * insertion, not focus traversal. In a `textarea` it is traversal by default,
                     * so the caret left the pane entirely — in an editor that sets `tabSize: 4`
                     * and can therefore never receive the character it is sized for. ⇧Tab and any
                     * modified Tab are deliberately left alone: those are still navigation, and
                     * the Swift's own `insertTab` is the unmodified key.
                     */
                    if (event.key !== 'Tab' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
                        return;
                    }
                    if (props.readOnly === true) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const area = event.currentTarget;
                    const start = area.selectionStart;
                    const end = area.selectionEnd;
                    /*
                     * The insertion is made on the DOM node first, caret included, and only
                     * then pushed into state. A controlled `textarea` re-rendered with a string
                     * it already holds is left alone by React, so the caret survives — whereas
                     * computing the next buffer and calling `setValue` alone would re-render the
                     * field from the top and drop the caret at the end of the document.
                     */
                    if (typeof area.setRangeText === 'function') {
                        area.setRangeText('\t', start, end, 'end');
                    } else {
                        area.value = `${area.value.slice(0, start)}\t${area.value.slice(end)}`;
                        area.setSelectionRange(start + 1, start + 1);
                    }
                    const next = area.value;
                    setValue(next);
                    latest.current.onChange(next);
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
