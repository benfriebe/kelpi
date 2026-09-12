/**
 * The bundled presenter for the four prompt kinds: the presentational half, moved unchanged out of
 * the component that used to be both halves (formerly `plugins/UIServiceHost.tsx`, now deleted).
 *
 * "Presentational" is a real boundary now, not a tidy-up: `InteractionHost` keeps the modal
 * registration, the visibility gate, the focus capture and release, and the Escape/IME policy, so
 * a phase-2 presenter that replaces this file cannot take any of those with it. What is left here
 * is what §2.5 calls presenter-owned: the DOM, the field's own state, filtering, arrows, Enter, the
 * Tab trap and scroll-to-selection.
 *
 * The three test ids - `plugin-ui-backdrop`, `plugin-ui-dialog`, `plugin-ui-notification` - are
 * part of the contract: `scripts/scenarios/plugin-ui-services.mjs` presses all three live.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { useOverlayPresence } from '../chrome/modal-presence';
import { tokens } from '../chrome/tokens';
import type { InteractionModalRequest, InteractionNotification } from './contract';

const fieldStyle: CSSProperties = { color: tokens.textPrimary, background: tokens.windowBackground, border: `1px solid ${tokens.divider}` };
const buttonStyle: CSSProperties = { color: tokens.textPrimary, border: `1px solid ${tokens.divider}` };
const primaryStyle: CSSProperties = { ...buttonStyle, borderColor: tokens.accent, background: tokens.selectionFill };

export function ModalRequest({ request, visible, answer, captureFocus }: {
    readonly request: InteractionModalRequest;
    readonly visible: boolean;
    readonly answer: (requestID: string, value: string | null) => void;
    /**
     * Called immediately before this panel takes focus, so the host records where the caret came
     * FROM rather than where the prompt put it. React runs a child's layout effects before its
     * parent's, so the host cannot capture on its own account and still be in time.
     */
    readonly captureFocus: () => void;
}): ReactElement {
    const panel = useRef<HTMLDivElement | null>(null);
    const input = useRef<HTMLInputElement | null>(null);
    const preferredButton = useRef<HTMLButtonElement | null>(null);
    const [query, setQuery] = useState('');
    const [value, setValue] = useState(request.kind === 'input' ? request.options.value ?? '' : '');
    const [selection, setSelection] = useState(request.kind === 'quickPick' ? request.options.selectedID ?? '' : '');
    const items = request.kind === 'quickPick'
        ? request.options.items.filter(item => `${item.label} ${item.description ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
        : [];
    const enabled = items.filter(item => !item.disabled);
    const selectedID = enabled.find(item => item.id === selection)?.id ?? enabled[0]?.id ?? null;
    const selectedIndex = items.findIndex(item => item.id === selectedID);
    const listID = `${request.id}-items`, titleID = `${request.id}-title`, detailID = `${request.id}-detail`;
    const cancel = useCallback(() => answer(request.id, null), [request.id, answer]);
    const focusDefault = useCallback(() => (input.current ?? preferredButton.current ?? panel.current)?.focus(), []);

    useLayoutEffect(() => {
        if (!visible) return;
        captureFocus(); focusDefault(); input.current?.select();
        const onFocus = (event: FocusEvent): void => {
            if (event.target instanceof Node && panel.current && !panel.current.contains(event.target)) focusDefault();
        };
        window.addEventListener('focusin', onFocus, true);
        return () => window.removeEventListener('focusin', onFocus, true);
    }, [visible, captureFocus, focusDefault]);
    useEffect(() => {
        if (visible && selectedIndex >= 0) document.getElementById(`${request.id}-item-${selectedIndex}`)?.scrollIntoView?.({ block: 'nearest' });
    }, [visible, request.id, selectedIndex]);
    useLayoutEffect(() => {
        if (!visible) return;
        // Escape is NOT handled here: it is host-guaranteed, so it keeps working for a presenter
        // that never thought about it (`InteractionHost`, §2.5).
        const onKey = (event: KeyboardEvent): void => {
            if (event.isComposing) return;
            if (event.key === 'Tab') {
                event.preventDefault(); event.stopImmediatePropagation();
                const stops = [...panel.current?.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]') ?? []]
                    .filter(element => element.tabIndex >= 0 && !('disabled' in element && element.disabled) && !element.closest('[hidden]'));
                const index = stops.indexOf(document.activeElement as HTMLElement);
                const next = index < 0 ? (event.shiftKey ? stops.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + stops.length) % stops.length;
                stops[next]?.focus();
                return;
            }
            if (event.target instanceof HTMLButtonElement) return;
            if (request.kind === 'quickPick' && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                event.preventDefault(); event.stopImmediatePropagation();
                const current = enabled.findIndex(item => item.id === selectedID);
                setSelection(enabled[(current + (event.key === 'ArrowUp' ? -1 : 1) + enabled.length) % enabled.length]?.id ?? '');
            } else if (event.key === 'Enter' && request.kind !== 'dialog') {
                event.preventDefault(); event.stopImmediatePropagation();
                if (request.kind === 'input') answer(request.id, value);
                else if (selectedID !== null) answer(request.id, selectedID);
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [visible, request, enabled, selectedID, value, cancel, answer]);

    const defaultAction = request.kind === 'dialog'
        ? request.options.cancelID ?? request.options.actions.find(action => action.kind === 'default')?.id ?? request.options.actions.find(action => action.kind !== 'danger')?.id
        : undefined;
    return <div data-testid="plugin-ui-backdrop" hidden={!visible} aria-hidden={!visible || undefined}
        className="fixed inset-0 z-50 items-start justify-center overflow-y-auto p-4 pt-[18vh]" style={{ display: visible ? 'flex' : 'none', background: 'rgba(0,0,0,0.4)' }}
        onClick={event => { if (event.target === event.currentTarget) cancel(); }}>
        <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleID} aria-describedby={request.kind === 'input' && !request.options.prompt ? undefined : detailID} tabIndex={-1}
            data-testid="plugin-ui-dialog" data-request-id={request.id}
            className="w-full max-w-[440px] rounded-lg p-4 text-[12px] shadow-2xl"
            style={{ color: tokens.textPrimary, background: tokens.surfaceBackground, border: `1px solid ${tokens.divider}` }}>
            <div className="mb-3 flex items-start gap-3">
                <div className="min-w-0 flex-1"><p className="mb-1 truncate text-[10px]" style={{ color: tokens.textSecondary }}>{request.owner.displayName}</p>
                    <h2 id={titleID} className="break-words text-[14px] font-semibold">{request.options.title}</h2></div>
                <button type="button" aria-label="Dismiss prompt" onClick={cancel} ref={request.kind === 'dialog' && !defaultAction ? preferredButton : undefined}
                    className="rounded px-2 py-1" style={buttonStyle}>×</button>
            </div>
            {request.kind === 'quickPick' ? <>
                <input ref={input} role="combobox" aria-label={request.options.title} aria-controls={listID} aria-expanded="true" aria-autocomplete="list"
                    aria-activedescendant={selectedIndex >= 0 ? `${request.id}-item-${selectedIndex}` : undefined}
                    value={query} placeholder={request.options.placeholder ?? 'Filter choices…'} maxLength={200}
                    onChange={event => setQuery(event.target.value)} className="mb-2 w-full rounded px-3 py-2 outline-offset-2" style={fieldStyle} />
                <div id={listID} role="listbox" aria-label="Choices" className="max-h-[min(45vh,320px)] overflow-y-auto">
                    {items.map((item, index) => <button type="button" role="option" key={item.id} id={`${request.id}-item-${index}`} tabIndex={-1}
                        disabled={item.disabled} aria-disabled={item.disabled || undefined} aria-selected={item.id === selectedID}
                        className="mb-1 block w-full rounded px-3 py-2 text-left disabled:opacity-40"
                        style={{ background: item.id === selectedID ? tokens.selectionFill : 'transparent' }}
                        onClick={() => answer(request.id, item.id)}>
                        <span className="block break-words">{item.label}</span>
                        {item.description && <span className="mt-1 block whitespace-pre-wrap break-words text-[11px]" style={{ color: tokens.textSecondary }}>{item.description}</span>}
                    </button>)}
                    {!items.length && <p className="px-3 py-5 text-center" style={{ color: tokens.textSecondary }}>No matching choices.</p>}
                </div>
                <p id={detailID} className="mt-2 text-[10px]" style={{ color: tokens.textSecondary }}>Use ↑ and ↓ to choose, Enter to select, or Escape to cancel.</p>
                <div className="mt-3 flex justify-end"><button type="button" onClick={cancel} className="min-w-[68px] rounded px-3 py-1" style={buttonStyle}>Cancel</button></div>
            </> : request.kind === 'input' ? <>
                {request.options.prompt && <p id={detailID} className="mb-3 whitespace-pre-wrap break-words" style={{ color: tokens.textSecondary }}>{request.options.prompt}</p>}
                <input ref={input} aria-label={request.options.title} type={request.options.password ? 'password' : 'text'} autoComplete="off"
                    value={value} placeholder={request.options.placeholder} maxLength={request.options.maxLength}
                    onChange={event => setValue(event.target.value)} className="w-full rounded px-3 py-2 outline-offset-2" style={fieldStyle} />
                <div className="mt-4 flex justify-end gap-2">
                    <button type="button" onClick={cancel} className="min-w-[68px] rounded px-3 py-1" style={buttonStyle}>Cancel</button>
                    <button type="button" onClick={() => answer(request.id, value)} className="min-w-[68px] rounded px-3 py-1" style={primaryStyle}>Continue</button>
                </div>
            </> : <>
                <div id={detailID} className="mb-4 whitespace-pre-wrap break-words">
                    <p>{request.options.message}</p>
                    {request.options.detail && <p className="mt-2 text-[11px]" style={{ color: tokens.textSecondary }}>{request.options.detail}</p>}
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                    {request.options.actions.map(action => <button type="button" key={action.id}
                        ref={action.id === defaultAction ? preferredButton : undefined}
                        onClick={() => answer(request.id, action.id)} className="min-w-[68px] max-w-full break-words rounded px-3 py-1"
                        style={{ ...(action.kind === 'primary' ? primaryStyle : buttonStyle), ...(action.kind === 'danger' ? { color: '#E0655C' } : {}) }}>{action.label}</button>)}
                </div>
            </>}
        </div>
    </div>;
}

/**
 * The notification stack. It registers its RECT, not a window modal (§2.6): a toast in the corner
 * has no business parking a page it does not cover.
 */
export function Notifications({ requests, answer }: {
    readonly requests: readonly InteractionNotification[];
    readonly answer: (requestID: string, value: string | null) => void;
}): ReactElement | null {
    const root = useRef<HTMLDivElement | null>(null);
    useOverlayPresence(root, requests.length > 0);
    if (!requests.length) return null;
    const colors = { info: tokens.accent, success: '#7bbb8c', warning: '#d9ae62', error: '#E0655C' };
    return <div ref={root} aria-label="Plugin notifications" className="fixed bottom-10 right-3 z-40 flex max-h-[calc(100vh-64px)] w-[min(360px,calc(100vw-24px))] flex-col gap-2 overflow-y-auto">
        {requests.map(request => <div key={request.id} data-testid="plugin-ui-notification" role={request.options.tone === 'error' ? 'alert' : 'status'}
            className="rounded-lg p-3 text-[12px] shadow-xl" style={{ color: tokens.textPrimary, background: tokens.surfaceBackground, border: `1px solid ${tokens.divider}`, borderLeft: `3px solid ${colors[request.options.tone ?? 'info']}` }}>
            <div className="flex items-start gap-2"><div className="min-w-0 flex-1">
                <p className="mb-1 truncate text-[10px]" style={{ color: tokens.textSecondary }}>{request.owner.displayName}</p>
                <p className="whitespace-pre-wrap break-words">{request.options.message}</p>
            </div><button type="button" aria-label="Dismiss notification" className="rounded px-2 py-1" style={buttonStyle} onClick={() => answer(request.id, null)}>×</button></div>
            {request.options.detail && <p className="mt-2 whitespace-pre-wrap break-words text-[11px]" style={{ color: tokens.textSecondary }}>{request.options.detail}</p>}
            {!!request.options.actions?.length && <div className="mt-3 flex flex-wrap gap-2">{request.options.actions.map(action => <button type="button" key={action.id} onClick={() => answer(request.id, action.id)} className="rounded px-2 py-1" style={buttonStyle}>{action.label}</button>)}</div>}
        </div>)}
    </div>;
}
