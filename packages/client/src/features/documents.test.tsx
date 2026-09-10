import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodePluginManifest, type JsonValue, type PluginInfo } from '@kelpi/protocol';
import type { KelpiRuntime } from '../state';
import { contentState, createFakeContentApi } from '../content/testing';
import { DocumentPane } from './DocumentPane';
import { clearDocumentDraft, getDocumentDraft, runDocumentEdit, stageDocumentDraft, type DocumentDraft } from '../plugins/document-drafts';

let plugins: PluginInfo[] = [];
vi.mock('../plugins/client', async original => ({ ...await original<object>(),
    usePlugins: (runtime: KelpiRuntime) => ({ plugins, daemonID: new URL(runtime.connection.target).host }),
    getCurrentPlugins: () => plugins,
    getPluginDaemonID: (runtime: KelpiRuntime) => new URL(runtime.connection.target).host
}));
vi.mock('../plugins/PluginView', () => ({ PluginView: (props: { paneID: string; viewID: string; onError(message: string): void }) =>
    <div data-testid={`replacement-${props.paneID}`}><button onClick={() => props.onError('Renderer failed')}>Fail {props.paneID}</button>{props.viewID}</div> }));
const runtime = (host: string) => ({ connection: { target: `ws://${host}/ws` } } as KelpiRuntime);
const local = runtime('document-features.test'), remote = runtime('document-remote.test');
let counter = 0;
const ids: string[] = [];
beforeEach(() => {
    localStorage.clear();
    plugins = [{ manifest: decodePluginManifest({ id: 'sample.editor', version: '1.0.0', apiVersion: 1, trust: 'full', contributes: {
        views: [{ id: 'sample.editor.document', title: 'Custom editor', entry: 'ui/index.html', placements: ['document.scratchpad', 'document.markdown', 'document.diff'] }]
    } }), enabled: true, status: 'inactive', revision: 'one', instanceID: 'one', error: null }];
});
afterEach(() => { cleanup(); for (const id of ids.splice(0)) { clearDocumentDraft(local, id); clearDocumentDraft(remote, id); } });
const paneID = () => { const id = `document-${++counter}`; ids.push(id); return id; };
const push = (content: ReturnType<typeof createFakeContentApi>, id: string, text = 'Retained text', dirty = false, revision = 1) => act(() => content.push(contentState({ paneID: id, type: 'scratchpad', mode: 'edit', text, dirty, revision })));
function pendingEdit() {
    let resolve!: (value: JsonValue) => void;
    const promise = new Promise<JsonValue>(accept => { resolve = accept; });
    return { promise, resolve };
}

describe('registered native document features', () => {
    it('resets a focused native editor when a shared content host renders a different pane', () => {
        const first = paneID(), second = paneID(), content = createFakeContentApi();
        const draw = (id: string, focused = true) => <DocumentPane runtime={local} workspaceID="workspace" paneID={id} kind="scratchpad" content={content} focused={focused} />;
        const view = render(draw(first, false));
        push(content, first, 'First document');
        view.rerender(draw(first));
        const firstEditor = screen.getByRole('textbox') as HTMLTextAreaElement;
        act(() => firstEditor.focus());
        view.rerender(draw(second));
        push(content, second, 'Second document');
        const secondEditor = screen.getByRole('textbox') as HTMLTextAreaElement;
        expect(secondEditor).not.toBe(firstEditor);
        expect(secondEditor.value).toBe('Second document');
        fireEvent.change(secondEditor, { target: { value: `${secondEditor.value}!` } });
        expect(content.texts).toEqual([{ paneID: second, text: 'Second document!' }]);
    });

    it('keeps the content owner mounted through replacement, failure, disable and reenabling', async () => {
        const id = paneID(), content = createFakeContentApi();
        const draw = () => <DocumentPane runtime={local} workspaceID="workspace" paneID={id} kind="scratchpad" content={content} />;
        const view = render(draw()); push(content, id);
        expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Retained text');
        fireEvent.change(screen.getByLabelText('scratchpad renderer'), { target: { value: 'sample.editor.document' } });
        await screen.findByTestId(`replacement-${id}`);
        expect(content.listenerCount(id)).toBe(1);
        fireEvent.click(screen.getByText(`Fail ${id}`)); push(content, id);
        expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Retained text');
        expect(screen.getByText('Renderer failed')).toBeTruthy();
        fireEvent.click(screen.getByText('Retry renderer'));
        expect(screen.getByTestId(`replacement-${id}`)).toBeTruthy();
        plugins = plugins.map(plugin => ({ ...plugin, enabled: false })); view.rerender(draw()); push(content, id);
        expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Retained text');
        plugins = plugins.map(plugin => ({ ...plugin, enabled: true, instanceID: 'two' })); view.rerender(draw());
        expect(screen.getByTestId(`replacement-${id}`)).toBeTruthy();
        view.unmount(); expect(content.listenerCount(id)).toBe(0);
    });

    it('persists native pending input before replacement and offers explicit recovery', async () => {
        const id = paneID(), content = createFakeContentApi();
        render(<DocumentPane runtime={local} workspaceID="workspace" paneID={id} kind="scratchpad" content={content} />); push(content, id);
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Not acknowledged yet' } });
        expect(content.texts.at(-1)?.text).toBe('Not acknowledged yet');
        expect(getDocumentDraft(local, id)?.text).toBe('Not acknowledged yet');
        fireEvent.change(screen.getByLabelText('scratchpad renderer'), { target: { value: 'sample.editor.document' } });
        await screen.findByTestId(`replacement-${id}`);
        expect(screen.getByTestId(`document-recovery-${id}`)).toBeTruthy();
        fireEvent.click(screen.getByText('Review'));
        expect((screen.getByLabelText('Recovery draft') as HTMLTextAreaElement).value).toBe('Not acknowledged yet');
        act(() => content.push(contentState({ paneID: id, type: 'scratchpad', mode: 'edit', text: 'Not acknowledged yet', dirty: false, revision: 2 })));
        await waitFor(() => expect(getDocumentDraft(local, id)).toBeNull());
    });

    it('retains staged text matching an earlier saved source until that draft is acknowledged', async () => {
        const id = paneID(), content = createFakeContentApi();
        render(<DocumentPane runtime={local} workspaceID="workspace" paneID={id} kind="scratchpad" content={content} />); push(content, id, '');
        fireEvent.change(screen.getByLabelText('scratchpad renderer'), { target: { value: 'sample.editor.document' } });
        await screen.findByTestId(`replacement-${id}`);
        let draft!: DocumentDraft;
        act(() => { draft = stageDocumentDraft(local, id, '', 'source:1', 'sample.editor.document'); });
        // An erased input can equal the last saved source even while an earlier write is in
        // flight. Neither the cached source nor a refresh acknowledges this unsubmitted input.
        expect(getDocumentDraft(local, id)).toEqual(draft);
        push(content, id, '', false, 2);
        expect(getDocumentDraft(local, id)).toEqual(draft);
        const pending = pendingEdit();
        let editing!: Promise<JsonValue>;
        act(() => { editing = runDocumentEdit(local, id, '', 'source:2', draft.viewID, () => pending.promise, draft); });
        push(content, id, '', false, 3);
        expect(getDocumentDraft(local, id)).toEqual(draft);
        await act(async () => { pending.resolve({ text: '', revision: 'source:3', dirty: false }); await editing; });
        await waitFor(() => expect(getDocumentDraft(local, id)).toBeNull());
        expect(screen.getByTestId(`replacement-${id}`)).toBeTruthy();
    });

    it('does not let an older matching edit response acknowledge a newer staged input', async () => {
        const id = paneID(), content = createFakeContentApi();
        render(<DocumentPane runtime={local} workspaceID="workspace" paneID={id} kind="scratchpad" content={content} />); push(content, id, '');
        const pending = pendingEdit();
        let editing!: Promise<JsonValue>, older!: DocumentDraft, latest!: DocumentDraft;
        act(() => {
            older = stageDocumentDraft(local, id, '', 'source:1', 'sample.editor.document');
            editing = runDocumentEdit(local, id, '', 'source:1', older.viewID, () => pending.promise, older);
        });
        act(() => {
            stageDocumentDraft(local, id, 'a', 'source:1', 'sample.editor.document');
            latest = stageDocumentDraft(local, id, '', 'source:1', 'sample.editor.document');
        });
        expect(latest.id).not.toBe(older.id);
        await act(async () => { pending.resolve({ text: '', revision: 'source:2', dirty: false }); await editing; });
        push(content, id, '', false, 2);
        expect(getDocumentDraft(local, id)).toEqual(latest);
        expect(getDocumentDraft(local, id)?.applied).toBeUndefined();
        expect(screen.getByTestId(`document-recovery-${id}`)).toBeTruthy();
        fireEvent.click(screen.getByText('Review'));
        expect((screen.getByLabelText('Recovery draft') as HTMLTextAreaElement).value).toBe('');
    });

    it('clears native input only after a later clean snapshot confirms the exact source', async () => {
        const id = paneID(), content = createFakeContentApi();
        render(<DocumentPane runtime={local} workspaceID="workspace" paneID={id} kind="scratchpad" content={content} />); push(content, id, '', false, 41);
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a' } });
        fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } });
        const draft = getDocumentDraft(local, id);
        expect(draft).toMatchObject({ text: '', nativeRevision: 41, viewID: 'kelpi.scratchpad' });
        expect(content.texts.map(edit => edit.text)).toEqual(['a', '']);
        push(content, id, '', false, 41);
        expect(getDocumentDraft(local, id)).toEqual(draft);
        push(content, id, 'another source', false, 42);
        expect(getDocumentDraft(local, id)).toEqual(draft);
        push(content, id, '', true, 43);
        expect(getDocumentDraft(local, id)).toEqual(draft);
        push(content, id, '', false, 44);
        await waitFor(() => expect(getDocumentDraft(local, id)).toBeNull());
    });

    it('synchronizes document choices within one daemon and isolates another daemon', async () => {
        const a = paneID(), b = paneID(), c = paneID(), content = createFakeContentApi();
        render(<StrictMode><DocumentPane runtime={local} workspaceID="one" paneID={a} kind="scratchpad" content={content} />
            <DocumentPane runtime={local} workspaceID="two" paneID={b} kind="scratchpad" content={content} />
            <DocumentPane runtime={remote} workspaceID="remote" paneID={c} kind="scratchpad" content={content} /></StrictMode>);
        fireEvent.change(screen.getAllByLabelText('scratchpad renderer')[0]!, { target: { value: 'sample.editor.document' } });
        await screen.findByTestId(`replacement-${a}`); await screen.findByTestId(`replacement-${b}`);
        expect(screen.queryByTestId(`replacement-${c}`)).toBeNull();
        expect(content.listenerCount(c)).toBe(2);
    });
});
