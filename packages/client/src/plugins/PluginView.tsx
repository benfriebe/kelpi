import { createWindowFeed, type WindowFeed } from './window-feed';
import { armCaretClaim, mayClaimPaneCaret } from '../app/pane-focus';
import { useContext, useEffect, useRef, useState, type ReactElement } from 'react';
import { PluginEventBuffer, type PluginEvent, pluginObject, pluginRecord, type JsonObject, type PluginPaneDescriptor } from '@kelpi/protocol';
import type { KelpiRuntime } from '../state';
import { tokens } from '../chrome/tokens';
import { pluginRequest, usePlugins } from './client';
import { pluginDocument } from './document';
import { PluginHostUIContext, requestHostUI, HOST_UI_METHODS } from './host-ui';
import { createPluginNavigationFeed, type PluginNavigationFeed } from './navigation';
import { WINDOW_UI_METHODS, type UIServiceScope } from './ui-services';
import { getDocumentDraft, runDocumentEdit, stageDocumentDraft } from './document-drafts';
import { createTerminalScope, type TerminalScope } from './terminal';
import { registerPluginTerminal, terminalPresentation } from './terminal-pane';
import { notifyTerminalPanes } from '../terminal/pane-registry';
import type { TerminalPaneProps } from '../terminal/TerminalPane';
import type { KeyEventLike } from '../chrome/keys';

export interface PluginViewProps {
    readonly onError?: ((message: string) => void) | undefined;
    readonly runtime: KelpiRuntime;
    readonly pluginID: string;
    readonly viewID: string;
    readonly workspaceID?: string | undefined;
    readonly paneID?: string | undefined;
    readonly descriptor?: PluginPaneDescriptor | undefined;
    readonly visible?: boolean | undefined;
    readonly focused?: boolean | undefined;
    readonly claimedChords?: readonly string[] | undefined;
    /** Granted only by the terminal feature host for this pane's selected renderer. */
    readonly terminal?: TerminalPaneProps | undefined;
    /** Terminal editing is handled against this view's owner before window shortcuts run. */
    readonly onTerminalKey?: ((event: KeyEventLike) => boolean) | undefined;
}
const themeVariables = ['--kelpi-bg', '--kelpi-fg', '--kelpi-fg-secondary', '--kelpi-fg-tertiary', '--kelpi-surface', '--kelpi-border', '--kelpi-accent'];
export function readPluginTheme(): Record<string, string> {
    const computed = getComputedStyle(document.documentElement);
    return Object.fromEntries(themeVariables.map(name => [name, computed.getPropertyValue(name).trim()]));
}

export function PluginView(props: PluginViewProps): ReactElement {
    const { runtime, pluginID, viewID, paneID, workspaceID } = props;
    const { plugins } = usePlugins(runtime);
    const plugin = plugins.find(item => item.manifest.id === pluginID);
    const frame = useRef<HTMLIFrameElement>(null);
    const port = useRef<MessagePort | null>(null);
    const terminal = useRef<TerminalScope | null>(null);
    const hasTerminal = props.terminal !== undefined;
    const latest = useRef(props); latest.current = props;
    const hostUI = useContext(PluginHostUIContext);
    const latestHostUI = useRef(hostUI); latestHostUI.current = hostUI;
    const chrome = hostUI?.runtime === runtime ? hostUI.chrome : undefined;
    const navigation = hostUI?.runtime === runtime ? hostUI.navigation : undefined;
    const services = hostUI?.runtime === runtime ? hostUI.services : undefined;
    const [documentHTML, setDocumentHTML] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    const [connection, setConnection] = useState(runtime.connection.status);
    useEffect(() => runtime.connection.on('status', setConnection), [runtime]);
    const unavailable = !plugin ? 'This plugin is not installed.' : !plugin.enabled ? 'This plugin is disabled.' : plugin.status === 'failed' ? plugin.error ?? 'This plugin failed.' : null;
    useEffect(() => {
        if (!plugin || unavailable || connection !== 'connected') { setDocumentHTML(''); return; }
        let disposed = false, failed = false, lease = '', outstanding = 0, sending = false;
        let readinessTimer: ReturnType<typeof setTimeout> | undefined;
        let chromeFeed: WindowFeed | undefined;
        let navigationFeed: PluginNavigationFeed | undefined;
        let uiScope: UIServiceScope | undefined;
        let terminalScope: TerminalScope | undefined;
        let releaseTerminal = (): void => {};
        const events = new PluginEventBuffer();
        const drain = (): void => {
            if (sending || !port.current) return;
            const event = events.shift(); if (!event) return;
            sending = true; port.current.postMessage({ type: 'event', event });
        };
        const nonce = crypto.randomUUID();
        const ownerWindow = frame.current?.ownerDocument.defaultView ?? window;
        const fail = (error: unknown): void => {
            if (disposed || failed) return;
            failed = true; clearTimeout(readinessTimer); port.current?.close(); port.current = null;
            navigationFeed?.dispose(); chromeFeed?.dispose();
            uiScope?.dispose();
            terminalScope?.dispose(); terminal.current = null; releaseTerminal();
            if (lease) { void pluginRequest(runtime, 'release', { lease }).catch(() => {}); lease = ''; }
            setError(error instanceof Error ? error.message : String(error));
            latest.current.onError?.(error instanceof Error ? error.message : String(error));
        };
        const contextUpdate = (): void => {
            port.current?.postMessage({ type: 'context', value: { theme: readPluginTheme(), chords: latest.current.visible === false ? [] : latest.current.claimedChords ?? [], visible: latest.current.visible ?? true, ...(latest.current.descriptor ? { state: latest.current.descriptor.state, stateVersion: latest.current.descriptor.stateVersion } : {}) } });
            if (latest.current.terminal) terminalScope?.update(terminalPresentation(latest.current.terminal));
        };
        const handleReady = (event: MessageEvent): void => {
            if (disposed || failed || !lease || event.source !== frame.current?.contentWindow || event.data?.type !== 'kelpi-plugin-ready' || event.data.nonce !== nonce || port.current) return;
            clearTimeout(readinessTimer);
            const channel = new MessageChannel(); port.current = channel.port1;
            try {
                if (services) uiScope = services.createScope({ id: nonce, pluginID, pluginName: plugin.manifest.name });
                if (latest.current.terminal && paneID && plugin.manifest.contributes.views.some(view => view.id === viewID && view.placements.includes('terminal'))) {
                    terminalScope = createTerminalScope({ paneID, pty: runtime.pty,
                        presentation: terminalPresentation(latest.current.terminal),
                        onResize: (cols, rows) => latest.current.terminal?.onDimensionsChange?.(paneID, { cols, rows }),
                        send: message => { if (!disposed && !failed) channel.port1.postMessage(message); }, fail });
                    terminal.current = terminalScope;
                }
            } catch (error) { channel.port2.close(); fail(error); return; }
            channel.port1.onmessage = ({ data }) => {
                if (disposed || failed || !pluginRecord(data)) return;
                if (data['type'] === 'view-error') { fail(new Error(String(data['message'] ?? 'Plugin view failed').slice(0, 4096))); return; }
                if (typeof data['type'] === 'string' && data['type'].startsWith('terminal-')) {
                    if (!terminalScope) return;
                    try {
                        terminalScope.receive(data);
                        if (!terminalScope.attached) releaseTerminal();
                        if (data['type'] === 'terminal-metrics') notifyTerminalPanes();
                        if (data['type'] === 'terminal-input' && data['direct'] === false && latest.current.visible !== false) frame.current?.dispatchEvent(new Event('kelpi-terminal-input'));
                    } catch (error) { fail(error); }
                    return;
                }
                if (data['type'] === 'event-ack') { sending = false; drain(); return; }
                if (data['type'] === 'chrome-ack') { chromeFeed?.ack(data['sequence']); return; }
                if (data['type'] === 'navigation-ack') { navigationFeed?.ack(data['sequence']); return; }
                if (data['type'] === 'focus') { if (latest.current.visible !== false && paneID && workspaceID) runtime.focusPane(workspaceID, paneID); return; }
                if (data['type'] === 'key') {
                    if (latest.current.visible === false) return;
                    if (typeof data['key'] !== 'string' || typeof data['code'] !== 'string') return;
                    const bits = (data['ctrlKey'] === true ? 1 : 0) | (data['altKey'] === true ? 2 : 0) | (data['shiftKey'] === true ? 4 : 0) | (data['metaKey'] === true ? 8 : 0);
                    if (!(latest.current.claimedChords ?? []).includes(`${bits}/${data['code']}`)) return;
                    const key = new KeyboardEvent('keydown', { key: data['key'], code: data['code'], ctrlKey: data['ctrlKey'] === true, altKey: data['altKey'] === true, shiftKey: data['shiftKey'] === true, metaKey: data['metaKey'] === true, bubbles: true, cancelable: true });
                    if (terminalScope && latest.current.onTerminalKey?.(key)) return;
                    ownerWindow.dispatchEvent(key); return;
                }
                if (data['type'] !== 'call' || typeof data['id'] !== 'string' || typeof data['method'] !== 'string') return;
                const id = data['id'];
                const respond = (result: unknown, error?: string): void => { if (!disposed && !failed) channel.port1.postMessage({ type: 'reply', id, result, ...(error ? { error } : {}) }); };
                if (outstanding >= 64) { respond(null, 'too many pending calls'); return; }
                outstanding += 1;
                void (async () => {
                    const args = pluginObject(data['args'] ?? {});
                    if (data['method'] === 'terminal.attach') {
                        if (!terminalScope || !paneID) throw new Error('Terminal attachment requires this pane\'s selected terminal renderer.');
                        const result = terminalScope.attach(args);
                        if (!terminalScope.attached) throw new Error('Terminal renderer attachment failed.');
                        releaseTerminal();
                        releaseTerminal = registerPluginTerminal(paneID, terminalScope, () => frame.current, () => latest.current.terminal);
                        if (latest.current.focused && latest.current.visible !== false && mayClaimPaneCaret()) void terminalScope.action({ type: 'focus' }).catch(() => {});
                        return result;
                    }
                    if ((WINDOW_UI_METHODS as readonly string[]).includes(String(data['method']))) {
                        if (!uiScope || latestHostUI.current?.runtime !== runtime || latestHostUI.current.services !== services) throw new Error('Window UI is unavailable for this daemon in this window.');
                        return uiScope.request(String(data['method']), args);
                    }
                    if ((HOST_UI_METHODS as readonly unknown[]).includes(data['method'])) return requestHostUI(latestHostUI.current, runtime, String(data['method']), args);
                    if (data['method'] === 'ui.activateWorkspace' || data['method'] === 'ui.focusPane') {
                        const id = String(args['workspaceID']);
                        const workspace = runtime.store.getState().daemon.state.workspaces.find(workspace => workspace.id === id);
                        if (!workspace) throw new Error('workspace does not exist');
                        if (data['method'] === 'ui.focusPane' && !workspace.panes.some(pane => pane.id === args['paneID'])) throw new Error('pane does not exist in workspace');
                        runtime.activateWorkspace(id);
                        if (data['method'] === 'ui.focusPane') {
                            runtime.focusPane(id, String(args['paneID']));
                        }
                        return null;
                    }
                    if (data['method'] === 'ui.notify') { runtime.store.getState().pushToast({ id: `plugin-${pluginID}`, kind: 'info', title: plugin.manifest.name, body: String(args['message'] ?? ''), paneID: paneID ?? null, workspaceID: workspaceID ?? null, createdAt: Date.now() }); return null; }
                    if (data['method'] === 'documents.stage' || data['method'] === 'documents.applyDraft') {
                        const pane = runtime.store.getState().daemon.state.workspaces.flatMap(workspace => workspace.panes).find(pane => pane.id === paneID);
                        if (!paneID || !pane || !['markdown', 'scratchpad'].includes(pane.type) || !plugin.manifest.contributes.views.some(view => view.id === viewID && view.placements.includes(`document.${pane.type}`))) throw new Error('Drafts require an editable document renderer.');
                        if (typeof args['revision'] !== 'string') throw new Error('revision is required');
                        if (data['method'] === 'documents.stage') {
                            if (typeof args['text'] !== 'string') throw new Error('text is required');
                            const draft = stageDocumentDraft(runtime, paneID, args['text'], args['revision'], viewID);
                            return { id: draft.id };
                        }
                        const draft = getDocumentDraft(runtime, paneID);
                        if (!draft || draft.id !== args['id'] || draft.viewID !== viewID) throw new Error('DOCUMENT_DRAFT_SUPERSEDED: A newer local draft has replaced this edit.');
                        const edit = { paneID, text: draft.text, revision: args['revision'] };
                        return runDocumentEdit(runtime, paneID, draft.text, args['revision'], viewID,
                            () => pluginRequest(runtime, 'api', { lease, method: 'documents.edit', args: edit }), draft);
                    }
                    if (data['method'] === 'documents.edit' && typeof args['text'] === 'string' && typeof args['revision'] === 'string' && typeof (args['paneID'] ?? paneID) === 'string') {
                        return runDocumentEdit(runtime, String(args['paneID'] ?? paneID), args['text'], args['revision'], viewID,
                            () => pluginRequest(runtime, 'api', { lease, method: 'documents.edit', args }));
                    }
                    return pluginRequest(runtime, 'api', { lease, method: String(data['method']), args });
                })().then(result => respond(result), error => respond(null, error.message)).finally(() => { outstanding -= 1; });
            };
            channel.port1.start();
            frame.current!.contentWindow!.postMessage({ type: 'kelpi-plugin-connect', nonce }, '*', [channel.port2]);
            contextUpdate(); drain();
            if (chrome) chromeFeed = createWindowFeed('chrome', (listener, onError) => chrome.subscribe(listener, onError), message => channel.port1.postMessage(message));
            if (navigation) navigationFeed = createPluginNavigationFeed(navigation, message => channel.port1.postMessage(message));
        };
        ownerWindow.addEventListener('message', handleReady);
        const offEvents = runtime.connection.on('message', message => { if (message['type'] === 'plugin-event') { events.push(message['event'] as unknown as PluginEvent); drain(); } });
        const observer = new MutationObserver(contextUpdate);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] });
        setError(null); setDocumentHTML('');
        void pluginRequest(runtime, 'attach', { pluginID, viewID, ...(paneID ? { paneID } : {}), ...(workspaceID ? { workspaceID } : {}) }).then(result => {
            const attached = pluginObject(result); lease = String(attached['lease']);
            if (disposed) { void pluginRequest(runtime, 'release', { lease }).catch(() => {}); return; }
            const url = new URL(runtime.connection.target); url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'; url.search = ''; url.hash = ''; url.pathname = `/plugin-assets/${lease}/`;
            setDocumentHTML(pluginDocument(String(attached['html']), url.href, String(attached['entry']), { nonce, context: attached['context']!, state: attached['state']!, stateVersion: attached['stateVersion']!, theme: readPluginTheme(), visible: latest.current.visible ?? true, chords: latest.current.visible === false ? [] : [...latest.current.claimedChords ?? []] }));
            readinessTimer = setTimeout(() => fail(new Error('Plugin view did not connect. Retry to reload it.')), 10_000);
        }).catch(fail);
        return () => { disposed = true; terminalScope?.dispose(); terminal.current = null; releaseTerminal(); navigationFeed?.dispose(); chromeFeed?.dispose(); uiScope?.dispose(); clearTimeout(readinessTimer); ownerWindow.removeEventListener('message', handleReady); observer.disconnect(); offEvents(); port.current?.close(); port.current = null; if (lease) void pluginRequest(runtime, 'release', { lease }).catch(() => {}); };
    }, [runtime, pluginID, viewID, paneID, workspaceID, plugin?.revision, plugin?.instanceID, unavailable, connection, attempt, navigation, services, chrome, hasTerminal]);
    useEffect(() => {
        if (props.terminal) { terminal.current?.update(terminalPresentation(props.terminal)); notifyTerminalPanes(); }
    }, [props.terminal]);
    useEffect(() => {
        if (props.visible === false) frame.current?.blur();
        port.current?.postMessage({ type: 'context', value: { visible: props.visible ?? true, chords: props.visible === false ? [] : props.claimedChords ?? [], ...(props.descriptor ? { state: props.descriptor.state, stateVersion: props.descriptor.stateVersion } : {}) } });
    }, [props.visible, props.claimedChords, props.descriptor]);
    useEffect(() => {
        if (!props.focused || props.visible === false || !documentHTML || !mayClaimPaneCaret()) return;
        return armCaretClaim(frame.current, () => { frame.current?.focus(); void terminal.current?.action({ type: 'focus' }).catch(() => {}); });
    }, [props.focused, props.visible, documentHTML]);
    const problem = unavailable ?? error;
    return <div data-testid={`plugin-view-${paneID ?? viewID}`} className="relative flex h-full min-h-0 w-full flex-col" style={{ color: tokens.textPrimary, background: tokens.surfaceBackground }}>
        {problem ? <div role="status" className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs"><strong>{plugin?.manifest.name ?? pluginID}</strong><span>{problem}</span><span>Your pane and its state are preserved.</span><button onClick={() => { if (plugin?.enabled && plugin.status === 'failed') void pluginRequest(runtime, 'reload', { pluginID }).catch(error => setError(error.message)); else setAttempt(value => value + 1); }}>Retry</button></div> : null}
        {!problem && !documentHTML ? <div role="status" className="p-4 text-xs">{connection === 'connected' ? 'Loading plugin…' : 'Connecting to daemon…'}</div> : null}
        {documentHTML && !problem ? <iframe ref={frame} data-pane-surface={paneID} title={plugin?.manifest.contributes.views.find(view => view.id === viewID)?.title ?? viewID} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={documentHTML} className="h-full min-h-0 w-full flex-1 border-0" /> : <iframe ref={frame} title="Plugin loading" hidden />}
    </div>;
}
