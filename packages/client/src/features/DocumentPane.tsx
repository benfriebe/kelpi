import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { MarkdownPaneProps } from '../content/MarkdownPane';
import { createContentClient, type ContentApi } from '../content/client';
import { useContent } from '../content/useContent';
import type { ContentPaneType } from '../content/types';
import type { KelpiRuntime } from '../state';
import { PluginView } from '../plugins/PluginView';
import { useWorkbenchLayout } from '../plugins/Workbench';
import { getCurrentPlugins } from '../plugins/client';
import { resolveSlot, slotViews } from '../plugins/registry';
import { clearDocumentDraft, documentRequest, isRecoveredDocumentDraft, registerDocumentCloseGuard, stageDocumentDraft, useDocumentDraft } from '../plugins/document-drafts';
import { bindDocumentFeatures } from './documents';
import { featureBindings } from './feature';
import { tokens } from '../chrome/tokens';

export interface DocumentPaneProps extends Omit<MarkdownPaneProps, 'content'> {
    readonly runtime: KelpiRuntime;
    readonly workspaceID: string;
    readonly kind: ContentPaneType;
    readonly content?: ContentApi;
}
export function isDocumentPane(kind: string): kind is ContentPaneType { return ['markdown', 'scratchpad', 'diff'].includes(kind); }

export function DocumentPane(props: DocumentPaneProps): ReactElement {
    const [owned, setOwned] = useState<{ runtime: KelpiRuntime; paneID: string; content: ContentApi } | null>(null);
    useEffect(() => {
        if (props.content) return;
        const content = createContentClient({ connection: props.runtime.connection, commands: props.runtime.commands });
        const stop = registerDocumentCloseGuard(props.runtime, content, props.paneID);
        setOwned({ runtime: props.runtime, paneID: props.paneID, content }); return () => { stop(); content.dispose(); };
    }, [props.runtime, props.content, props.paneID]);
    const content = props.content ?? (owned?.runtime === props.runtime && owned.paneID === props.paneID ? owned.content : null);
    return content ? <DocumentBody key={props.paneID} {...props} content={content} /> : <div role="status">Loading document…</div>;
}

function DocumentBody(props: DocumentPaneProps & { content: ContentApi }): ReactElement {
    const { runtime, paneID, kind, content } = props;
    const layout = useWorkbenchLayout(runtime), placement = `document.${kind}` as const;
    const selected = resolveSlot(layout.views, placement, layout.selections[placement]);
    const nativeID = `kelpi.${kind}`, viewID = selected?.id ?? nativeID;
    const plugin = getCurrentPlugins(runtime).find(plugin => plugin.manifest.id === selected?.pluginID);
    const generation = `${viewID}:${plugin?.instanceID ?? ''}`;
    const [failure, setFailure] = useState<{ generation: string; message: string } | null>(null);
    const failed = failure?.generation === generation ? failure.message : null;
    const { state, error } = useContent(content, paneID);
    const draft = useDocumentDraft(runtime, paneID);
    const [review, setReview] = useState(false), [busy, setBusy] = useState(false), [recoveryError, setRecoveryError] = useState<string | null>(null);
    useEffect(() => {
        if (draft && state?.loaded && !state.dirty && state.text === draft.text
            && (draft.applied || (draft.nativeRevision !== undefined && state.revision > draft.nativeRevision))) clearDocumentDraft(runtime, paneID, draft.id);
    }, [runtime, paneID, draft, state]);
    const nativeContent = useMemo<ContentApi>(() => ({ ...content,
        setText(id, text) {
            try { stageDocumentDraft(runtime, id, text, '', nativeID, content.peek(id)?.revision); }
            catch { /* The host shows the volatile draft; still let the daemon save native edits. */ }
            content.setText(id, text);
        }
    }), [content, runtime, nativeID]);
    const bindings = featureBindings(bindDocumentFeatures({ ...props, content: nativeContent,
        onToggleEdit: props.onToggleEdit ?? (id => { void content.setMode(id, content.peek(id)?.mode === 'edit' ? 'view' : 'edit'); }) }));
    const native = bindings.get(nativeID)!.render({ visible: props.visible ?? true, trafficLightInset: 0 });
    const recovery = draft && (isRecoveredDocumentDraft(draft) || draft.error || failed || error || state?.error || draft.viewID !== (selected?.pluginID && !failed ? viewID : nativeID));
    const restore = async (): Promise<void> => {
        if (!draft || busy) return; setBusy(true); setRecoveryError(null);
        try {
            let current = await documentRequest(runtime, 'get', { paneID });
            if (current.kind === 'markdown' && current.mode !== 'edit') current = await documentRequest(runtime, 'mode', { paneID, mode: 'edit', revision: current.revision });
            current = await documentRequest(runtime, 'edit', { paneID, text: draft.text, revision: current.revision });
            const saved = await documentRequest(runtime, 'save', { paneID, revision: current.revision });
            if (!saved.dirty) clearDocumentDraft(runtime, paneID, draft.id);
        } catch (error) { setRecoveryError(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(false); }
    };
    const choices = slotViews(layout.views, placement).filter(view => !view.container);
    return <div data-document-pane={paneID} data-document-renderer={selected?.pluginID && !failed ? viewID : nativeID} className="flex h-full min-h-0 flex-col">
        {choices.length > 1 || failed ? <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1 text-[11px]" style={{ borderColor: tokens.divider }}>
            <label>{kind === 'scratchpad' ? 'Scratchpad' : kind === 'diff' ? 'Diff' : 'Markdown'} renderer <select aria-label={`${kind} renderer`} value={viewID} onChange={event => layout.select(placement, event.target.value)}>
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
