/**
 * A csv pane: the virtualised grid, or the file as raw text (#324, docs/csv-pane.md).
 *
 * Which body is drawn follows the pane record's `isEditing`, exactly as a markdown pane's edit
 * mode does, and for the same reason: the mode is daemon state (`markdown-set-mode` flips it, and
 * for a csv pane the daemon refuses the switch above `CSV_LIMITS.rawEditLimitBytes` or for a
 * read-only file), so the pane never guesses.
 *
 *   grid  `CsvGrid` over a `CsvPaneModel` (rows by range through the csv verbs). It never
 *         touches the content service: a 1 GB file must not be read into a string because a pane
 *         was mounted, so `useContent` is NOT called in this mode.
 *   raw   the shared `PlainTextEditor` through `useContent`, the same body markdown edit mode
 *         uses (debounced `content-set-text`, the daemon's atomic write). Mounted only in raw
 *         mode, and only once the daemon's snapshot says it is editing, so an empty field can
 *         never be typed over the file.
 *
 * The grid publishes the facts the pane header needs (`chrome-facts.ts`): whether ⌘E is
 * available and why not, and the authoritative header-row flag.
 */

import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react';

import type { FindPalette } from '../bridge';
import type { ContentApi } from '../client';
import { ContentStatus } from '../ContentFrame';
import { contentPaneLabel } from '../labels';
import { PlainTextEditor } from '../PlainTextEditor';
import type { ScrollStore } from '../scroll';
import { useContent } from '../useContent';
import { publishCsvChromeFacts } from './chrome-facts';
import type { CsvApi } from './csv-client';
import { createCsvPaneModel, type CsvPaneModel } from './csv-model';
import { CsvGrid } from './CsvGrid';
import { csvRawUnavailableReason } from './state-text';

export interface CsvPaneProps {
    readonly paneID: string;
    readonly csv: CsvApi;
    readonly content: ContentApi;
    /** The pane record's `isEditing`: raw text when true. */
    readonly editing: boolean;
    readonly filePath?: string | null | undefined;
    readonly focused?: boolean | undefined;
    readonly visible?: boolean | undefined;
    readonly background?: string | undefined;
    readonly phone?: boolean | undefined;
    readonly findToken?: number | undefined;
    readonly findPalette?: Partial<FindPalette> | undefined;
    readonly onFocusRequest?: ((paneID: string) => void) | undefined;
    readonly onToggleEdit?: ((paneID: string) => void) | undefined;
    readonly scrollStore?: ScrollStore | undefined;
    /** Test seam: the grid's viewport, which jsdom cannot measure. */
    readonly viewportSize?: { readonly width: number; readonly height: number } | undefined;
}

export function CsvPane(props: CsvPaneProps): ReactElement {
    return props.editing ? <CsvRawEditor {...props} /> : <CsvGridMode {...props} />;
}

const NO_SUBSCRIBE = (): (() => void) => () => undefined;
const ZERO = (): number => 0;

/** One model per mounted grid; created in an effect so StrictMode's double mount cannot leak one. */
export function useCsvPaneModel(api: CsvApi, paneID: string): CsvPaneModel | null {
    const [held, setHeld] = useState<{ api: CsvApi; paneID: string; model: CsvPaneModel } | null>(null);
    useEffect(() => {
        const model = createCsvPaneModel(api, paneID);
        setHeld({ api, paneID, model });
        return () => {
            model.dispose();
        };
    }, [api, paneID]);
    return held !== null && held.api === api && held.paneID === paneID ? held.model : null;
}

function CsvGridMode(props: CsvPaneProps): ReactElement {
    const { paneID } = props;
    const model = useCsvPaneModel(props.csv, paneID);
    useSyncExternalStore(model?.subscribe ?? NO_SUBSCRIBE, model?.getVersion ?? ZERO, model?.getVersion ?? ZERO);
    const state = model?.state() ?? null;

    const rawEditable = state?.rawEditable ?? true;
    const rawReason = state === null ? null : csvRawUnavailableReason(state);
    const headerRow = state?.headerRow ?? null;
    const canUndo = state?.canUndo ?? false;
    const canRedo = state?.canRedo ?? false;
    useEffect(() => {
        if (headerRow === null) return;
        publishCsvChromeFacts(paneID, { rawEditable, rawUnavailableReason: rawReason, headerRow, canUndo, canRedo });
    }, [paneID, rawEditable, rawReason, headerRow, canUndo, canRedo]);
    useEffect(() => () => publishCsvChromeFacts(paneID, null), [paneID]);

    if (model === null || state === null) {
        const error = model?.error() ?? null;
        return error === null ? <ContentStatus paneID={paneID} text="" /> : <ContentStatus paneID={paneID} text={error} tone="error" />;
    }
    // A file that could not be opened at all (missing, a directory, a FIFO): the daemon's reason,
    // and no grid. A reload in progress keeps the grid; only a failure with nothing to show is this.
    if (!state.loaded && state.error !== null) {
        return <ContentStatus paneID={paneID} text={state.error} tone="error" />;
    }
    return (
        <CsvGrid
            paneID={paneID}
            model={model}
            filePath={props.filePath ?? state.filePath}
            focused={props.focused}
            visible={props.visible}
            background={props.background}
            phone={props.phone}
            findToken={props.findToken}
            findPalette={props.findPalette}
            onFocusRequest={props.onFocusRequest}
            viewportSize={props.viewportSize}
        />
    );
}

function CsvRawEditor(props: CsvPaneProps): ReactElement {
    const { paneID, content } = props;
    const { state, error } = useContent(content, paneID);
    if (state === null || state.mode !== 'edit') {
        return error === null ? <ContentStatus paneID={paneID} text="" /> : <ContentStatus paneID={paneID} text={error} tone="error" />;
    }
    return (
        <PlainTextEditor
            paneID={paneID}
            ariaLabel={contentPaneLabel('csv editor', paneID, state.filePath)}
            value={state.text ?? ''}
            isDark={state.isDark}
            focused={props.focused}
            visible={props.visible}
            background={props.background}
            onChange={(text) => content.setText(paneID, text)}
            onFlush={() => void content.flush(paneID)}
            onToggleEdit={props.onToggleEdit}
            onFocusRequest={props.onFocusRequest}
            scrollStore={props.scrollStore}
            showGutter
            findToken={props.findToken}
            findPalette={props.findPalette}
        />
    );
}
