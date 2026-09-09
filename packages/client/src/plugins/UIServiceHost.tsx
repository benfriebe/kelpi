import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { modalPresenceCount, useModalPresence, useModalPresenceCount, useOverlayPresence } from '../chrome/modal-presence';
import { tokens } from '../chrome/tokens';
import { createUIServices, type UIServiceModel, type UIServiceModal, type UIServiceNotification } from './ui-services';

const fieldStyle: CSSProperties = { color: tokens.textPrimary, background: tokens.windowBackground, border: `1px solid ${tokens.divider}` };
const buttonStyle: CSSProperties = { color: tokens.textPrimary, border: `1px solid ${tokens.divider}` };
const primaryStyle: CSSProperties = { ...buttonStyle, borderColor: tokens.accent, background: tokens.selectionFill };

/** The model survives StrictMode's effect rehearsal, and disposes on the actual window unmount. */
export function useUIServices(): UIServiceModel {
    const [services] = useState(createUIServices);
    const mounted = useRef(false);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; queueMicrotask(() => { if (!mounted.current) services.dispose(); }); };
    }, [services]);
    return services;
}

function canRestoreFocus(target: HTMLElement): boolean {
    if (!target.isConnected || target.closest('[hidden], [inert], [aria-hidden="true"]') || ('disabled' in target && target.disabled)) return false;
    for (let node: HTMLElement | null = target; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
    }
    if (target instanceof HTMLIFrameElement) {
        const box = target.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0 || box.right <= 0 || box.bottom <= 0 || box.left >= innerWidth || box.top >= innerHeight) return false;
    }
    return true;
}

export function UIServiceHost({ services }: { readonly services: UIServiceModel }): ReactElement | null {
    const snapshot = useSyncExternalStore(services.subscribe, services.getSnapshot, services.getSnapshot);
    const count = useModalPresenceCount();
    const holdsModal = useRef(false);
    const origin = useRef<HTMLElement | null>(null);
    const mounted = useRef(false);
    const visible = snapshot.active !== null && count - (holdsModal.current ? 1 : 0) <= 0;

    // Update our ownership before registration changes notify the shared count subscribers.
    useLayoutEffect(() => { holdsModal.current = visible; return () => { holdsModal.current = false; }; }, [visible]);
    useModalPresence(visible);
    const captureFocus = useCallback(() => {
        if (origin.current === null && document.activeElement instanceof HTMLElement) origin.current = document.activeElement;
    }, []);
    const restoreFocus = useCallback(() => {
        if (services.getSnapshot().active || modalPresenceCount() > 0) return;
        const target = origin.current; origin.current = null;
        if (target && canRestoreFocus(target)) target.focus({ preventScroll: true });
    }, [services]);
    useLayoutEffect(() => { if (!snapshot.active) restoreFocus(); }, [snapshot.active, count, restoreFocus]);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; queueMicrotask(() => { if (!mounted.current) restoreFocus(); }); };
    }, [restoreFocus]);
    if (typeof document === 'undefined') return null;
    return createPortal(<>
        {snapshot.active && <ModalRequest key={snapshot.active.id} request={snapshot.active} visible={visible} services={services} captureFocus={captureFocus} />}
        <Notifications requests={snapshot.notifications} services={services} />
    </>, document.body);
}

function ModalRequest({ request, visible, services, captureFocus }: {
    readonly request: UIServiceModal;
    readonly visible: boolean;
    readonly services: UIServiceModel;
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
    const cancel = useCallback(() => services.answer(request.id, null), [request.id, services]);
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
        const onKey = (event: KeyboardEvent): void => {
            if (event.isComposing) return;
            if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); cancel(); return; }
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
                if (request.kind === 'input') services.answer(request.id, value);
                else if (selectedID !== null) services.answer(request.id, selectedID);
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [visible, request, enabled, selectedID, value, cancel, services]);

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
                <div className="min-w-0 flex-1"><p className="mb-1 truncate text-[10px]" style={{ color: tokens.textSecondary }}>{request.owner.pluginName}</p>
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
                        onClick={() => services.answer(request.id, item.id)}>
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
                    <button type="button" onClick={() => services.answer(request.id, value)} className="min-w-[68px] rounded px-3 py-1" style={primaryStyle}>Continue</button>
                </div>
            </> : <>
                <div id={detailID} className="mb-4 whitespace-pre-wrap break-words">
                    <p>{request.options.message}</p>
                    {request.options.detail && <p className="mt-2 text-[11px]" style={{ color: tokens.textSecondary }}>{request.options.detail}</p>}
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                    {request.options.actions.map(action => <button type="button" key={action.id}
                        ref={action.id === defaultAction ? preferredButton : undefined}
                        onClick={() => services.answer(request.id, action.id)} className="min-w-[68px] max-w-full break-words rounded px-3 py-1"
                        style={{ ...(action.kind === 'primary' ? primaryStyle : buttonStyle), ...(action.kind === 'danger' ? { color: '#E0655C' } : {}) }}>{action.label}</button>)}
                </div>
            </>}
        </div>
    </div>;
}

function Notifications({ requests, services }: { readonly requests: readonly UIServiceNotification[]; readonly services: UIServiceModel }): ReactElement | null {
    const root = useRef<HTMLDivElement | null>(null);
    useOverlayPresence(root, requests.length > 0);
    if (!requests.length) return null;
    const colors = { info: tokens.accent, success: '#7bbb8c', warning: '#d9ae62', error: '#E0655C' };
    return <div ref={root} aria-label="Plugin notifications" className="fixed bottom-10 right-3 z-40 flex max-h-[calc(100vh-64px)] w-[min(360px,calc(100vw-24px))] flex-col gap-2 overflow-y-auto">
        {requests.map(request => <div key={request.id} data-testid="plugin-ui-notification" role={request.options.tone === 'error' ? 'alert' : 'status'}
            className="rounded-lg p-3 text-[12px] shadow-xl" style={{ color: tokens.textPrimary, background: tokens.surfaceBackground, border: `1px solid ${tokens.divider}`, borderLeft: `3px solid ${colors[request.options.tone ?? 'info']}` }}>
            <div className="flex items-start gap-2"><div className="min-w-0 flex-1">
                <p className="mb-1 truncate text-[10px]" style={{ color: tokens.textSecondary }}>{request.owner.pluginName}</p>
                <p className="whitespace-pre-wrap break-words">{request.options.message}</p>
            </div><button type="button" aria-label="Dismiss notification" className="rounded px-2 py-1" style={buttonStyle} onClick={() => services.answer(request.id, null)}>×</button></div>
            {request.options.detail && <p className="mt-2 whitespace-pre-wrap break-words text-[11px]" style={{ color: tokens.textSecondary }}>{request.options.detail}</p>}
            {!!request.options.actions?.length && <div className="mt-3 flex flex-wrap gap-2">{request.options.actions.map(action => <button type="button" key={action.id} onClick={() => services.answer(request.id, action.id)} className="rounded px-2 py-1" style={buttonStyle}>{action.label}</button>)}</div>}
        </div>)}
    </div>;
}
