import { MarkdownPane, type MarkdownPaneProps } from '../content/MarkdownPane';
import { DiffPane } from '../content/DiffPane';
import { ScratchpadPane } from '../content/ScratchpadPane';
import { DIFF_FEATURE, MARKDOWN_FEATURE, SCRATCHPAD_FEATURE } from './definitions';
import type { BundledFeatureBinding } from './feature';

/** Per-pane bindings share one content owner across native and external renderers. */
export function bindDocumentFeatures(props: MarkdownPaneProps): readonly BundledFeatureBinding[] {
    return [
        { definition: MARKDOWN_FEATURE, render: context => <MarkdownPane {...props} visible={context.visible} /> },
        { definition: SCRATCHPAD_FEATURE, render: context => <ScratchpadPane {...props} visible={context.visible} /> },
        { definition: DIFF_FEATURE, render: context => <DiffPane {...props} visible={context.visible} /> }
    ];
}
