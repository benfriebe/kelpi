/**
 * The built-in plain-text editor (content-panes.md §4.2), shared by markdown edit mode and
 * scratchpad panes — the two places the port keeps a local buffer.
 *
 * Deliberately plain: a monospace `textarea`, never a rich editor, sitting transparent on the
 * pane's ghostty-colored fill with a luminance-picked text color. The daemon owns the save (a
 * 500 ms debounced atomic write for markdown, the pane record for a scratchpad); this owns
 * only what a text field must: the caret, the local buffer, and the scroll position.
 *
 * Three rules are worth naming:
 *
 *   - **The typist wins.** An incoming buffer (another client's autosave echoing back, the
 *     daemon re-reading the file) is refused while this field holds the caret AND has unsaved
 *     local edits in it. Mid-keystroke adoption would move the caret and lose characters, and
 *     §4.2 is explicit that the last writer wins rather than the two being merged. Issue #106
 *     is why the rule names both halves: keyed on focus alone it also refused the FIRST
 *     snapshot of a pane that had been handed the caret before its text arrived, which is a
 *     document dropped rather than a keystroke protected.
 *   - **⌘E is handled here.** The app's key interceptor deliberately ignores pane bindings while
 *     a text field has focus, so the editor answers the toggle itself — otherwise ⌘E would work
 *     going into edit mode and not coming back out.
 *   - **⌘F is the editor's own find (§4.4).** `NSTextView`'s `usesFindBar` has no `<textarea>`
 *     equivalent, and the Electron shell has no find of its own for the key to fall through to,
 *     so the app routes `toggle_search` here (`findToken`) and this draws the same
 *     `PaneSearchOverlay` a preview does, over a scan of the buffer it already holds.
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

import { PANE_SURFACE_ATTR, armCaretClaim } from '../app/pane-focus';
import { PaneSearchOverlay } from '../grid/PaneSearchOverlay';
import { resolveFindPalette, type FindPalette } from './bridge';
import { CONTENT_FIND_BAR_OFFSET } from './ContentFrame';
import { cachedLineStarts, lineNumberAt, visibleLineWindow, type LineWindow } from './gutter';
import { contentScrollStore, type ScrollStore } from './scroll';
import { fieldOffset, findSegments, findTextMatches, shownRun, stepMatch, type TextMatch } from './text-find';
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
    /** Bump to open the find bar (the app's `toggle_search` binding, §4.4); 0 never opens it. */
    readonly findToken?: number | undefined;
    /** SET-219's overridable find-highlight colours; absent = the Swift defaults (§3.13). */
    readonly findPalette?: Partial<FindPalette> | undefined;
    readonly testID?: string | undefined;
}

export function PlainTextEditor(props: PlainTextEditorProps): ReactElement {
    const { paneID, value: incoming, ariaLabel } = props;
    const store = props.scrollStore ?? contentScrollStore;

    const areaRef = useRef<HTMLTextAreaElement | null>(null);
    const [value, setValue] = useState(incoming);
    const externalRef = useRef(incoming);
    const hasFocusRef = useRef(false);
    /**
     * Issue #106 - "the typist wins" is about UNSAVED LOCAL EDITS, not about the caret.
     *
     * Holding the caret was standing in for having typed, and the two come apart exactly where
     * the bug lived: a pane that remounts after a workspace switch can be handed the caret
     * before its first snapshot arrives (its own mount claim, or `focusPaneSurface` from
     * `handCaretToPaneWhenReady`), and the buffer it is guarding at that moment is the empty
     * one `useState(incoming)` seeded. Refusing the snapshot there is refusing the document -
     * and since the daemon emits only on save, nothing ever re-delivers it, so the first
     * keystroke goes out as the whole file.
     *
     * Set once, on the first local edit of this mount, and never cleared: from then on this is
     * the rule it always was, which is what keeps the "two clients typing" behaviour
     * (`MarkdownPane.test.tsx`) intact. Before it, a focused field with nothing typed into it
     * has nothing to lose by adopting, and everything to lose by refusing.
     */
    const typedRef = useRef(false);

    const latest = useRef(props);
    useEffect(() => {
        latest.current = props;
    });

    // Adopt the daemon's buffer unless the user has typed into this one and still holds it.
    useEffect(() => {
        if (incoming === externalRef.current) return;
        externalRef.current = incoming;
        if (hasFocusRef.current && typedRef.current) return;
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

    /*
     * Mounting into a focused pane claims the caret; losing focus releases it so the next
     * pane's claim is not blocked (§4.3) — the port of `ScratchpadEditorView.swift:86-89,
     * 108-116` (`claimFirstResponder` in `makeNSView`, `releaseFirstResponderIfHeld` on
     * true → false), which `MarkdownEditorView.swift:78-80,102-116` repeats verbatim.
     *
     * N19 — two things were wrong here, and both are visible the moment a scratchpad is born
     * out of a TERMINAL, which is every ⇧⌘N:
     *
     *   - the politeness test was local, and read the ghostty-web engine's hidden `<textarea>`
     *     as "a text field outside this pane" — so the claim was declined every time and the
     *     new pane got a focus ring with no caret. `shouldGrabFocus` is now the shared rule
     *     (`app/pane-focus.ts`): chrome text fields still win, pane SURFACES do not. Note the
     *     Swift's own guard here is narrower still — only `sidebarTextEditingActive`.
     *   - `visible` was not consulted, so an editor mounted into a pane that is focused but
     *     off-screen (its workspace is not the one on screen; a zoomed sibling covers it)
     *     would have taken the window's caret. `TerminalPane` has always gated on both, and a
     *     BACKGROUND create must not steal the keyboard from the pane the user is typing in.
     *
     * Issue #35 - and a THIRD thing, the explicit one: `wasFocused.current = claimable` ran
     * unconditionally, so a claim the politeness rule DECLINED still spent the focus gain. Even
     * a re-run for the same focus episode then read `wasFocused.current` as true and never tried
     * again, which is worse than the terminal's version of the same defect: there nothing
     * re-armed the claim, here the arming was actively thrown away. The gain is now spent only
     * when the claim is actually MADE (`armCaretClaim`, the rule the web pane has carried since
     * §N30's residual), and the editor stays armed until the field it deferred to lets go.
     *
     * Two refs, because the two edges ask different questions: `claimSpent` is "has this focus
     * gain been used", and `wasClaimable` is the true → false transition that
     * `releaseFirstResponderIfHeld` is the port of. Folding them into one is what tied the
     * release to a claim that may never have happened.
     */
    const focused = props.focused === true;
    const onScreen = props.visible !== false;
    const claimable = focused && onScreen;
    const claimSpent = useRef(false);
    const wasClaimable = useRef(false);
    useEffect(() => {
        const area = areaRef.current;
        if (area === null) return;
        const lost = wasClaimable.current && !claimable;
        wasClaimable.current = claimable;
        if (!claimable) {
            claimSpent.current = false;
            if (lost && document.activeElement === area) area.blur();
            return;
        }
        if (claimSpent.current) return;
        return armCaretClaim(area, () => {
            claimSpent.current = true;
            areaRef.current?.focus();
        });
    }, [claimable]);

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

    // ── find (§4.4), per client ──────────────────────────────────────────────────────
    //
    // The needle, the matches and the selected one live here, in component state, exactly as a
    // preview's live in `ContentFrame`: two windows searching the same scratchpad never see each
    // other's highlights, and nothing about a find reaches the daemon.
    const softWrap = props.wrap === 'soft';
    const [findOpen, setFindOpen] = useState(false);
    /** Mirrors `findOpen` for the handlers, which must not wait for a render to read it. */
    const findOpenRef = useRef(false);
    /** Bumped per open request and used as the bar's `key`, as `ContentFrame` does (L29). */
    const [findSeq, setFindSeq] = useState(0);
    const [needle, setNeedle] = useState('');
    /** The selected match's index, or -1 for "none yet" (a bar reopened on its old needle). */
    const [currentMatch, setCurrentMatch] = useState(-1);
    /** Bumped whenever the selected match should be selected and scrolled to. */
    const [revealSeq, setRevealSeq] = useState(0);
    const revealedSeq = useRef(0);
    /** The field's own selection when the bar opened: what a close with no match hands back. */
    const originRef = useRef<readonly [number, number] | null>(null);

    /*
     * Recomputed when the BUFFER moves too, not only the needle: an adopted snapshot (another
     * client's autosave) or a keystroke made with the bar open shifts every offset, and a stale
     * list would highlight and select the wrong characters. The selection is clamped rather than
     * reset, so editing near the end of a find session does not throw the bar back to match 1.
     */
    const matches = useMemo(
        () => (findOpen ? findTextMatches(value, needle) : NO_MATCHES),
        [findOpen, value, needle]
    );
    const selectedMatch = currentMatch < 0 || matches.length === 0 ? -1 : Math.min(currentMatch, matches.length - 1);
    const findState = useRef({ matches: NO_MATCHES as readonly TextMatch[], selected: -1, text: '' });
    useEffect(() => {
        findState.current = { matches, selected: selectedMatch, text: value };
    });

    // The app's `toggle_search` binding: a token bump opens the bar and claims the caret.
    const findToken = props.findToken ?? 0;
    const lastFindToken = useRef(findToken);
    useEffect(() => {
        if (findToken === lastFindToken.current) return;
        lastFindToken.current = findToken;
        // The app hands every OTHER pane a 0 when a request moves elsewhere: that is this pane
        // losing the request, not being asked, so it must not open (or re-key) the bar.
        if (findToken === 0) return;
        setFindSeq((seq) => seq + 1);
        if (findOpenRef.current) return;
        /*
         * A reopened bar keeps its needle (as a preview's does) and highlights its matches, but
         * SELECTS nothing until the needle is edited or stepped: opening the bar is not a request
         * to move, so ⌘F then Escape leaves the caret and the scroll exactly where they were.
         */
        const area = areaRef.current;
        originRef.current = area === null ? null : [area.selectionStart, area.selectionEnd];
        findOpenRef.current = true;
        setFindOpen(true);
        setCurrentMatch(-1);
    }, [findToken]);

    const changeNeedle = useCallback((next: string): void => {
        setNeedle(next);
        setCurrentMatch(0);
        setRevealSeq((seq) => seq + 1);
    }, []);

    const stepFind = useCallback((delta: 1 | -1): void => {
        const { matches: found, selected } = findState.current;
        if (found.length === 0) return;
        setCurrentMatch(stepMatch(selected, found.length, delta));
        setRevealSeq((seq) => seq + 1);
    }, []);

    /**
     * Escape, the ✕, or a second ⌘F from the bar. The caret goes back to the TEXT with the match
     * the bar was on selected (`NSTextView` leaves the found text selected when its find bar
     * closes), so the next keystroke edits where the search ended rather than where it began.
     * With no match selected (nothing typed, or a needle that matches nothing) it goes back to
     * where it was when the bar opened, not to a match an earlier, shorter needle passed through.
     */
    const closeFind = useCallback((): void => {
        const { matches: found, selected, text } = findState.current;
        const match = found[selected];
        const origin = originRef.current;
        findOpenRef.current = false;
        setFindOpen(false);
        const area = areaRef.current;
        if (area === null) return;
        area.focus();
        if (match !== undefined) area.setSelectionRange(fieldOffset(text, match.start), fieldOffset(text, match.end));
        else if (origin !== null) area.setSelectionRange(origin[0], origin[1]);
    }, []);

    /**
     * Escape in the TEXT with the bar still open (the user clicked back in to edit). The marks go,
     * and the caret stays exactly where the user put it: it is theirs, not the find's.
     */
    const dismissFind = useCallback((): void => {
        findOpenRef.current = false;
        setFindOpen(false);
    }, []);

    /**
     * The highlight layer's two boxes: the clip, sized to the textarea's CLIENT box (so a mark
     * never paints over a scrollbar), and the text, moved by the textarea's own scroll offsets.
     * Imperative for the same reason the gutter's transform is: a scroll must not cost a render.
     * A scroll moves the text and nothing else; the box and the typography (a computed-style read)
     * are synced on a render or a resize, which are the only things that can change them.
     */
    const findClipRef = useRef<HTMLDivElement | null>(null);
    const findLayerRef = useRef<HTMLDivElement | null>(null);
    const scrollFindLayer = useCallback((): void => {
        const layer = findLayerRef.current;
        const area = areaRef.current;
        if (layer === null || area === null) return;
        layer.style.transform = `translate(${String(-area.scrollLeft)}px, ${String(-area.scrollTop)}px)`;
    }, []);
    const syncFindLayer = useCallback((): void => {
        const clip = findClipRef.current;
        const layer = findLayerRef.current;
        const area = areaRef.current;
        if (clip === null || layer === null || area === null) return;
        if (area.clientWidth > 0) clip.style.width = `${String(area.clientWidth)}px`;
        if (area.clientHeight > 0) clip.style.height = `${String(area.clientHeight)}px`;
        syncMirrorStyle(layer, area, softWrap && area.clientWidth > 0 ? area.clientWidth : undefined);
        scrollFindLayer();
    }, [scrollFindLayer, softWrap]);
    useLayoutEffect(() => {
        syncFindLayer();
    });
    // A split being dragged resizes the field without re-rendering it, and the scratchpad has no
    // wrap observer of its own (§M60), so the open bar watches the box itself.
    useEffect(() => {
        const area = areaRef.current;
        if (!findOpen || area === null || typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver(() => {
            syncFindLayer();
        });
        observer.observe(area);
        return () => {
            observer.disconnect();
        };
    }, [findOpen, syncFindLayer]);

    const onScroll = useCallback((): void => {
        const area = areaRef.current;
        if (area === null) return;
        const max = Math.max(0, area.scrollHeight - area.clientHeight);
        store.set(paneID, { top: area.scrollTop, fraction: max > 0 ? area.scrollTop / max : 0 });
        const gutter = gutterRef.current;
        if (gutter !== null) gutter.style.transform = `translateY(${String(-area.scrollTop)}px)`;
        scrollFindLayer();
        if (showGutter) measureWindow();
    }, [measureWindow, paneID, scrollFindLayer, showGutter, store]);

    /**
     * The hidden node the selected match is measured in: the match's own LINE, styled to the
     * textarea's content box, with the match in a marker span. The marker's offsets are where the
     * match sits inside that line, wrapped or not, tabs and wide glyphs included: the standard
     * caret-position technique, and the same apparatus the gutter's mirror is (§M60).
     */
    const findMeasureRef = useRef<HTMLDivElement | null>(null);

    /**
     * Select the match and scroll it into view. Neither half is optional: the bar's field holds the
     * caret while it is open, and a browser does not scroll (nor, in Chromium, paint) the selection
     * of a field that is not focused, which is why the highlight layer below exists at all.
     */
    const revealMatch = useCallback(
        (match: TextMatch): void => {
            const area = areaRef.current;
            if (area === null) return;
            area.setSelectionRange(fieldOffset(value, match.start), fieldOffset(value, match.end));

            const lineStartsNow = cachedLineStarts(value);
            const line = lineNumberAt(lineStartsNow, match.start) - 1;
            const lineStart = lineStartsNow[line] ?? 0;
            // The line's first visual row: the measured prefix sums when the editor wraps and has
            // them (§M60), the fixed pitch otherwise.
            const measured = metricsRef.current;
            const firstRow =
                measured !== null && measured.rows.length === lineStartsNow.length
                    ? (measured.offsets[line] ?? line)
                    : line;
            let top = EDITOR_PADDING + firstRow * EDITOR_LINE_PX;
            let left = EDITOR_PADDING;
            let width = 0;
            const probe = findMeasureRef.current;
            if (probe !== null) {
                syncMirrorStyle(probe, area, softWrap ? contentBoxWidth(area) : undefined);
                probe.textContent = value.slice(lineStart, match.start);
                const marker = probe.ownerDocument.createElement('span');
                marker.textContent = value.slice(match.start, match.end);
                probe.appendChild(marker);
                top += marker.offsetTop;
                left += marker.offsetLeft;
                width = marker.offsetWidth;
                probe.textContent = '';
            }

            // Only when it is not already on screen, and then to the middle: the preview's
            // `block:'center'`, without moving a match the reader can already see.
            const viewport = area.clientHeight;
            let moved = false;
            if (viewport > 0 && (top < area.scrollTop || top + EDITOR_LINE_PX > area.scrollTop + viewport)) {
                area.scrollTop = Math.max(0, top - (viewport - EDITOR_LINE_PX) / 2);
                moved = true;
            }
            // `wrap="off"` (the scratchpad, CONT-070) scrolls sideways too; a wrapping editor never
            // has anything off to the right.
            const across = area.clientWidth;
            if (!softWrap && across > 0 && (left < area.scrollLeft || left + width > area.scrollLeft + across)) {
                area.scrollLeft = Math.max(0, left - across / 2);
                moved = true;
            }
            // The `scroll` event arrives a frame later. Answering it now moves the gutter and the
            // highlight window in this commit, so the match is never drawn without its mark.
            if (moved) onScroll();
        },
        [onScroll, softWrap, value]
    );

    // After the render that moved the selection, so the measuring node exists and the matches
    // are the ones the bar is counting.
    useLayoutEffect(() => {
        if (revealSeq === revealedSeq.current) return;
        revealedSeq.current = revealSeq;
        const match = matches[selectedMatch];
        if (!findOpen || match === undefined) return;
        revealMatch(match);
    }, [findOpen, matches, revealMatch, revealSeq, selectedMatch]);

    /*
     * The selection follows the selected match when the BUFFER moves under the bar (an adopted
     * snapshot shifts every offset), without a scroll: nobody asked to go anywhere. Never while
     * the field itself holds the caret, because then the selection is the typist's.
     */
    useLayoutEffect(() => {
        const area = areaRef.current;
        const match = matches[selectedMatch];
        if (!findOpen || area === null || match === undefined) return;
        if (area.ownerDocument.activeElement === area) return;
        area.setSelectionRange(fieldOffset(value, match.start), fieldOffset(value, match.end));
    }, [findOpen, matches, selectedMatch, value]);

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
    /**
     * The window's own top edge: the rows above it are not drawn, so the padding stands in for
     * their height. §M60: with measured heights that is the TRUE first visual row of `firstLine`
     * (the prefix sum), not `firstLine - 1` fixed-pitch rows. Shared by the gutter and the find
     * highlights, which draw the same window.
     */
    const windowTop =
        EDITOR_PADDING +
        (wrapOffsets === null
            ? (firstLine - 1) * EDITOR_LINE_PX
            : (wrapOffsets[firstLine - 1] ?? firstLine - 1) * EDITOR_LINE_PX);

    /*
     * §4.4's highlights, for the lines the gutter draws and no others (CONT-078's bounded node
     * count holds for a find in a 200k-line buffer too). Without a gutter there is no window, and
     * the whole buffer is drawn.
     */
    const palette = useMemo(() => resolveFindPalette(props.findPalette), [props.findPalette]);
    const highlightFrom = showGutter ? (starts[firstLine - 1] ?? 0) : 0;
    const highlightTo = showGutter && lastLine < starts.length ? (starts[lastLine] as number) - 1 : value.length;
    const highlights =
        findOpen && matches.length > 0
            ? findSegments(value, highlightFrom, highlightTo, matches, selectedMatch)
            : null;

    return (
        <>
        <div
            data-testid={props.testID ?? `content-editor-${paneID}`}
            data-pane-id={paneID}
            className="relative flex h-full w-full overflow-hidden"
            style={{
                background: props.background ?? 'var(--kelpi-term-bg, #0A0A0C)',
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
                        background: 'var(--kelpi-header-bg, #17171B)'
                    }}
                >
                    <div
                        ref={gutterRef}
                        className="text-right"
                        style={{
                            // The window's own top edge (`windowTop`), so row N stays on the same
                            // baseline as the text it numbers. A wrapped line above the window
                            // takes two rows and the padding has to carry both.
                            paddingTop: windowTop,
                            paddingRight: GUTTER_TEXT_PADDING,
                            color: 'var(--kelpi-fg-tertiary, #6A6A72)',
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
                /* N19: this IS the pane's surface — the caret belongs here, not to the chrome.
                   Marking it makes the shared politeness rule treat it as `SurfaceContainerView`
                   treats a terminal surface, and lets `focusPaneSurface` hand an editor pane the
                   caret on an overlay close (the palette handoff, ⌘, closing, ⌘F closing). */
                {...{ [PANE_SURFACE_ATTR]: '' }}
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
                    // #106: the local buffer now holds an edit the daemon has not confirmed.
                    typedRef.current = true;
                    setValue(next);
                    latest.current.onChange(next);
                }}
                onKeyDown={(event) => {
                    // §4.4: Escape in the text closes an open find bar. The app's `close_search`
                    // only knows the daemon's terminal search, so it leaves the key to us.
                    if (
                        event.key === 'Escape' &&
                        findOpenRef.current &&
                        !event.metaKey &&
                        !event.ctrlKey &&
                        !event.altKey &&
                        !event.shiftKey
                    ) {
                        event.preventDefault();
                        event.stopPropagation();
                        dismissFind();
                        return;
                    }
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
                    typedRef.current = true;
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
            {highlights === null ? null : (
                /*
                 * §4.4: the highlight layer, OVER the field and inert.
                 *
                 * A `<textarea>` can colour nothing inside itself, and the selection `revealMatch`
                 * sets is not painted while the bar's field holds the caret. So the visible lines
                 * are drawn a second time on top, in the field's own typography and scroll, with
                 * the plain runs transparent and each match an opaque `<mark>` in §3.13's palette:
                 * the match glyphs under it are covered and redrawn in the match text colour, so
                 * an editor's find reads exactly as a preview's does. `pointer-events: none` keeps
                 * every click on the field.
                 */
                <div
                    ref={findClipRef}
                    aria-hidden
                    data-testid={`content-find-highlights-${paneID}`}
                    className="pointer-events-none absolute overflow-hidden"
                    style={{ top: 0, right: 0, bottom: 0, left: gutterPx }}
                >
                    <div
                        ref={findLayerRef}
                        style={{
                            boxSizing: 'border-box',
                            paddingTop: windowTop,
                            paddingLeft: EDITOR_PADDING,
                            paddingRight: EDITOR_PADDING,
                            whiteSpace: softWrap ? 'pre-wrap' : 'pre',
                            overflowWrap: softWrap ? 'break-word' : 'normal',
                            wordBreak: 'normal',
                            color: 'transparent',
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                            fontSize: `${EDITOR_FONT_SIZE}px`,
                            lineHeight: `${String(EDITOR_LINE_PX)}px`,
                            tabSize: 4
                        }}
                    >
                        {highlights.map((segment, index) =>
                            segment.kind === 'text' ? (
                                shownRun(segment.text)
                            ) : (
                                <mark
                                    key={index}
                                    data-find-match={segment.kind}
                                    style={{
                                        background: segment.kind === 'current' ? palette.current : palette.match,
                                        color: segment.kind === 'current' ? palette.currentText : palette.matchText,
                                        borderRadius: 2,
                                        padding: 0
                                    }}
                                >
                                    {segment.text}
                                </mark>
                            )
                        )}
                    </div>
                </div>
            )}
            {findOpen ? (
                <div
                    ref={findMeasureRef}
                    aria-hidden
                    data-testid={`content-find-measure-${paneID}`}
                    style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        visibility: 'hidden',
                        pointerEvents: 'none',
                        zIndex: -1,
                        margin: 0,
                        padding: 0,
                        border: 0,
                        boxSizing: 'content-box',
                        whiteSpace: softWrap ? 'pre-wrap' : 'pre',
                        overflowWrap: softWrap ? 'break-word' : 'normal',
                        wordBreak: 'normal',
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                        fontSize: `${EDITOR_FONT_SIZE}px`,
                        lineHeight: `${String(EDITOR_LINE_PX)}px`,
                        tabSize: 4
                    }}
                />
            ) : null}
        </div>

        {/*
          * §4.4's bar IS the preview's, which is the terminal's (`PaneSearchOverlay`, §H29): the
          * same field, chevrons, ✕ and counter rule, the same `content-find-…` test ids, and the
          * same corner of the pane (`CONTENT_FIND_BAR_OFFSET`), so ⌘E between the two modes of a
          * markdown pane leaves one bar in one place. It hangs beside the editor rather than in
          * it for the reason the preview's does (§S9): the editor is `overflow-hidden`, and the
          * bar has to reach back up over the pane header.
          */}
        {findOpen ? (
            /*
             * Hidden rather than unmounted while the pane is off screen (a zoomed sibling, a
             * parked pane): the bar claims the caret when it MOUNTS (L29), so remounting it on
             * the way back would pull the keyboard out of whatever the user is typing in by then.
             * `display: contents` keeps the pane body as the bar's containing block.
             */
            <div style={{ display: onScreen ? 'contents' : 'none' }}>
            <PaneSearchOverlay
                key={findSeq}
                paneID={paneID}
                testIDPrefix="content-find"
                label={`Find in ${ariaLabel}`}
                needle={needle}
                total={matches.length}
                selected={selectedMatch >= 0 ? selectedMatch : null}
                top={CONTENT_FIND_BAR_OFFSET.top}
                right={CONTENT_FIND_BAR_OFFSET.right}
                onNeedleChange={changeNeedle}
                onNext={() => stepFind(1)}
                onPrevious={() => stepFind(-1)}
                onClose={closeFind}
            />
            </div>
        ) : null}
        </>
    );
}

/** A stable empty list, so a closed bar does not hand the memo a new identity every render. */
const NO_MATCHES: readonly TextMatch[] = [];
