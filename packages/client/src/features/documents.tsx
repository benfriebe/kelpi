import { MarkdownPane, type MarkdownPaneProps } from '../content/MarkdownPane';
import { DiffPane } from '../content/DiffPane';
import { ScratchpadPane } from '../content/ScratchpadPane';
import { CsvPane } from '../content/csv/CsvPane';
import type { CsvApi } from '../content/csv/csv-client';
import { CSV_FEATURE, DIFF_FEATURE, MARKDOWN_FEATURE, SCRATCHPAD_FEATURE } from './definitions';
import type { BundledFeatureBinding } from './feature';

/** What the native document renderers take: the markdown props, plus the csv pane's own. */
export interface DocumentFeatureProps extends MarkdownPaneProps {
    /** #324: the csv verbs. Absent, the csv binding renders nothing (a host with no csv client). */
    readonly csv?: CsvApi | undefined;
    /** The pane record's `isEditing` (a csv pane's raw-text mode). */
    readonly editing?: boolean | undefined;
    readonly phone?: boolean | undefined;
    readonly filePath?: string | null | undefined;
    /** A scratchpad's persisted wrap toggle (`Pane.scratchpadWrap`); absent = no wrap. */
    readonly wrap?: boolean | undefined;
}

/** Per-pane bindings share one content owner across native and external renderers. */
export function bindDocumentFeatures(props: DocumentFeatureProps): readonly BundledFeatureBinding[] {
    return [
        { definition: MARKDOWN_FEATURE, render: context => <MarkdownPane {...props} visible={context.visible} /> },
        { definition: SCRATCHPAD_FEATURE, render: context => <ScratchpadPane {...props} visible={context.visible} /> },
        { definition: DIFF_FEATURE, render: context => <DiffPane {...props} visible={context.visible} /> },
        {
            definition: CSV_FEATURE,
            render: context => props.csv === undefined ? null : (
                <CsvPane
                    paneID={props.paneID}
                    csv={props.csv}
                    content={props.content}
                    editing={props.editing === true}
                    filePath={props.filePath}
                    focused={props.focused}
                    visible={context.visible}
                    background={props.background}
                    phone={props.phone}
                    findToken={props.findToken}
                    findPalette={props.findPalette}
                    onFocusRequest={props.onFocusRequest}
                    onToggleEdit={props.onToggleEdit}
                    scrollStore={props.scrollStore}
                />
            )
        }
    ];
}
