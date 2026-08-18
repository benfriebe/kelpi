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

    const onScroll = useCallback((): void => {
        const area = areaRef.current;
        if (area === null) return;
        const max = Math.max(0, area.scrollHeight - area.clientHeight);
        store.set(paneID, { top: area.scrollTop, fraction: max > 0 ? area.scrollTop / max : 0 });
    }, [paneID, store]);

    return (
        <div
            data-testid={props.testID ?? `content-editor-${paneID}`}
            data-pane-id={paneID}
            className="h-full w-full overflow-hidden"
            style={{
                background: props.background ?? 'var(--nex-term-bg, #0A0A0C)',
                visibility: props.visible === false ? 'hidden' : 'visible'
            }}
            onMouseDownCapture={() => latest.current.onFocusRequest?.(paneID)}
        >
            <textarea
                ref={areaRef}
                data-testid={`content-textarea-${paneID}`}
                aria-label={ariaLabel}
                className="h-full w-full resize-none border-0 bg-transparent p-3 outline-none"
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
