import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { createContentClient, type ContentApi } from '../content/client';
import { createCsvClient, flushCsvPane, type CsvApi } from '../content/csv/csv-client';
import { useContent } from '../content/useContent';
import type { ContentPaneType } from '../content/types';
import type { KelpiRuntime } from '../state';
import { PluginView } from '../plugins/PluginView';
import { useWorkbenchLayout } from '../plugins/Workbench';
import { getCurrentPlugins } from '../plugins/client';
import { resolveSlot, slotViews } from '../plugins/registry';
import { clearDocumentDraft, documentRequest, isRecoveredDocumentDraft, registerCsvCloseGuard, registerDocumentCloseGuard, stageDocumentDraft, useDocumentDraft } from '../plugins/document-drafts';
import { bindDocumentFeatures, type DocumentFeatureProps } from './documents';
import { featureBindings } from './feature';
import { tokens } from '../chrome/tokens';

export interface DocumentPaneProps extends Omit<DocumentFeatureProps, 'content' | 'csv'> {
    readonly runtime: KelpiRuntime;
    readonly workspaceID: string;
    readonly kind: ContentPaneType;
    readonly content?: ContentApi;
    /** #324: the window's csv client; a host without one gets a pane-owned client. */
    readonly csv?: CsvApi | undefined;
}
export function isDocumentPane(kind: string): kind is ContentPaneType { return ['markdown', 'scratchpad', 'diff', 'csv'].includes(kind); }

export function DocumentPane(props: DocumentPaneProps): ReactElement {
    const [owned, setOwned] = useState<{ runtime: KelpiRuntime; paneID: string; content: ContentApi } | null>(null);
    useEffect(() => {
        if (props.content) return;
        const content = createContentClient({ connection: props.runtime.connection, commands: props.runtime.commands });
        const stop = registerDocumentCloseGuard(props.runtime, content, props.paneID);
        setOwned({ runtime: props.runtime, paneID: props.paneID, content }); return () => { stop(); content.dispose(); };
    }, [props.runtime, props.content, props.paneID]);
    // #324: a csv pane on a host with no window-level csv client (a remote daemon's workspace)
    // owns one, exactly as it owns a content client above.
    const [ownedCsv, setOwnedCsv] = useState<{ runtime: KelpiRuntime; paneID: string; csv: CsvApi } | null>(null);
    const needsCsv = props.kind === 'csv' && props.csv === undefined;
    // #324: closing a csv pane waits for its grid's edits (the cell being typed, queued batches).
    useEffect(() => { if (props.kind === 'csv') registerCsvCloseGuard(props.runtime); }, [props.kind, props.runtime]);
    useEffect(() => {
        if (!needsCsv) return;
        const csv = createCsvClient({ connection: props.runtime.connection, commands: props.runtime.commands });
        setOwnedCsv({ runtime: props.runtime, paneID: props.paneID, csv }); return () => { csv.dispose(); };
    }, [needsCsv, props.runtime, props.paneID]);
    const content = props.content ?? (owned?.runtime === props.runtime && owned.paneID === props.paneID ? owned.content : null);
    const csv = props.csv ?? (ownedCsv?.runtime === props.runtime && ownedCsv.paneID === props.paneID ? ownedCsv.csv : undefined);
    if (needsCsv && csv === undefined) return <div role="status">Loading document…</div>;
    return content ? <DocumentBody key={props.paneID} {...props} content={content} csv={csv} /> : <div role="status">Loading document…</div>;
}

const DOCUMENT_LABELS: Readonly<Record<ContentPaneType, string>> = { markdown: 'Markdown', scratchpad: 'Scratchpad', diff: 'Diff', csv: 'CSV' };

function DocumentBody(props: DocumentPaneProps & { content: ContentApi; csv: CsvApi | undefined }): ReactElement {
    const { runtime, paneID, kind, content } = props;
    // #324: a csv pane in GRID mode is not a content subscription at all (its rows come through
    // the csv verbs), so nothing here may ask the content service to read the file.
    const csvGrid = kind === 'csv' && props.editing !== true;
    const layout = useWorkbenchLayout(runtime), placement = `document.${kind}` as const;
    const selected = resolveSlot(layout.views, placement, layout.selections[placement]);
    const nativeID = `kelpi.${kind}`, viewID = selected?.id ?? nativeID;
    const plugin = getCurrentPlugins(runtime).find(plugin => plugin.manifest.id === selected?.pluginID);
    const generation = `${viewID}:${plugin?.instanceID ?? ''}`;
    const [failure, setFailure] = useState<{ generation: string; message: string } | null>(null);
    const failed = failure?.generation === generation ? failure.message : null;
    const { state, error } = useContent(content, csvGrid ? null : paneID);
    const draft = useDocumentDraft(runtime, paneID);
    const [review, setReview] = useState(false), [busy, setBusy] = useState(false), [recoveryError, setRecoveryError] = useState<string | null>(null);
    useEffect(() => {
        if (draft && state?.loaded && !state.dirty && state.text === draft.text
            && (draft.applied || (draft.nativeRevision !== undefined && state.revision > draft.nativeRevision))) clearDocumentDraft(runtime, paneID, draft.id);
    }, [runtime, paneID, draft, state]);
    // #324: a csv pane leaves raw text only after the daemon flushed and saved its raw buffer
    // (`setMode` refuses otherwise), and the grid has no content state to clear a draft against.
    // So the draft is settled on that transition, but only when the daemon was last seen holding
    // exactly the draft's text: typing not yet sent (another client switched the pane, or the
    // daemon restarted and brought it back as a grid) keeps the draft and its recovery banner.
    // What the daemon holds is read by a listener of its own, not from `state`: the reply that
    // carries the text and the switch back to the grid can land in the same render. A dropped
    // connection forgets it, since a daemon that restarted saved nothing.
    const csvRaw = kind === 'csv' && props.editing === true;
    const rawHeld = useRef<string | null>(null);
    useEffect(() => {
        if (!csvRaw) return;
        const subscription = content.subscribe(paneID, { onState: next => { if (next.loaded && next.mode === 'edit') rawHeld.current = next.text; } });
        return () => subscription.unsubscribe();
    }, [csvRaw, content, paneID]);
    useEffect(() => {
        if (kind !== 'csv') return;
        return runtime.connection.on('status', status => { if (status !== 'connected') rawHeld.current = null; });
    }, [kind, runtime]);
    const wasRaw = useRef(csvRaw);
    useEffect(() => {
        const left = wasRaw.current && !csvRaw;
        wasRaw.current = csvRaw;
        if (!left) return;
        const held = rawHeld.current;
        rawHeld.current = null;
        if (draft && !isRecoveredDocumentDraft(draft) && !draft.error && draft.viewID === nativeID && held !== null && held === draft.text) clearDocumentDraft(runtime, paneID, draft.id);
    }, [csvRaw, draft, runtime, paneID, nativeID]);
    const nativeContent = useMemo<ContentApi>(() => ({ ...content,
        setText(id, text) {
            try { stageDocumentDraft(runtime, id, text, '', nativeID, content.peek(id)?.revision); }
            catch { /* The host shows the volatile draft; still let the daemon save native edits. */ }
            content.setText(id, text);
        }
    }), [content, runtime, nativeID]);
    const bindings = featureBindings(bindDocumentFeatures({ ...props, content: nativeContent,
        onToggleEdit: props.onToggleEdit ?? (id => {
            const editing = kind === 'csv' ? props.editing === true : content.peek(id)?.mode === 'edit';
            // #324: a csv grid's edits are answered before the daemon starts refusing them.
            if (kind === 'csv' && !editing) { void flushCsvPane(id).then(() => content.setMode(id, 'edit')); return; }
            void content.setMode(id, editing ? 'view' : 'edit');
        }) }));
    const native = bindings.get(nativeID)!.render({ visible: props.visible ?? true, trafficLightInset: 0 });
    // #324: a native draft that outlived raw text unconfirmed has no editor left to show it in.
    const csvUnsaved = csvGrid && draft !== null && draft.viewID === nativeID && rawHeld.current !== draft.text;
    const recovery = draft && (isRecoveredDocumentDraft(draft) || draft.error || failed || error || state?.error || csvUnsaved || draft.viewID !== (selected?.pluginID && !failed ? viewID : nativeID));
    const restore = async (): Promise<void> => {
        if (!draft || busy) return; setBusy(true); setRecoveryError(null);
        try {
            let current = await documentRequest(runtime, 'get', { paneID });
            if ((current.kind === 'markdown' || current.kind === 'csv') && current.mode !== 'edit') current = await documentRequest(runtime, 'mode', { paneID, mode: 'edit', revision: current.revision });
            current = await documentRequest(runtime, 'edit', { paneID, text: draft.text, revision: current.revision });
            const saved = await documentRequest(runtime, 'save', { paneID, revision: current.revision });
            if (!saved.dirty) clearDocumentDraft(runtime, paneID, draft.id);
        } catch (error) { setRecoveryError(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(false); }
    };
    const choices = slotViews(layout.views, placement).filter(view => !view.container);
    return <div data-document-pane={paneID} data-document-renderer={selected?.pluginID && !failed ? viewID : nativeID} className="flex h-full min-h-0 flex-col">
        {choices.length > 1 || failed ? <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1 text-[11px]" style={{ borderColor: tokens.divider }}>
            <label>{DOCUMENT_LABELS[kind]} renderer <select aria-label={`${kind} renderer`} value={viewID} onChange={event => layout.select(placement, event.target.value)}>
                {choices.map(view => <option key={view.id} value={view.id}>{view.title}</option>)}
            </select></label>
            {failed ? <><span role="status">{failed}</span><button onClick={() => setFailure(null)}>Retry renderer</button></> : null}
        </div> : null}
        {recovery ? <div data-testid={`document-recovery-${paneID}`} className="shrink-0 border-b p-2 text-xs" style={{ borderColor: tokens.divider }}>
            <span>{draft.volatile ? 'Recovery storage is unavailable. Keep this window open until your edits are saved. ' : 'Local edits are preserved for recovery. '}</span>
            <button onClick={() => setReview(value => !value)}>Review</button>{' '}
            <button disabled={busy} onClick={() => { void restore(); }}>Restore and save</button>{' '}
            <button disabled={busy} onClick={() => clearDocumentDraft(runtime, paneID, draft.id)}>Discard local draft</button>
            {review ? <textarea aria-label="Recovery draft" readOnly value={draft.text} className="mt-2 max-h-36 w-full font-mono" /> : null}
            {recoveryError ? <div role="alert">{recoveryError}</div> : null}
        </div> : null}
        <div className="min-h-0 flex-1">{selected?.pluginID && !failed ? <PluginView runtime={runtime} paneID={paneID} workspaceID={props.workspaceID}
            pluginID={selected.pluginID} viewID={selected.id} visible={props.visible} focused={props.focused} claimedChords={props.claimedChords}
            onError={message => setFailure({ generation, message })} /> : native}</div>
    </div>;
}
