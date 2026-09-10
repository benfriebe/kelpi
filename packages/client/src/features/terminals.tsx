import { TerminalPane, type TerminalPaneProps } from '../terminal/TerminalPane';
import { TERMINAL_FEATURE } from './definitions';
import type { BundledFeatureBinding } from './feature';

/** Renderer lifetime is independent of the daemon-owned pane and process. */
export function bindTerminalFeature(props: TerminalPaneProps): BundledFeatureBinding {
    return { definition: TERMINAL_FEATURE, render: context => <TerminalPane {...props} visible={context.visible} /> };
}
