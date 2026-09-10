import { WebPane, type WebPaneProps } from '../webpane/WebPane';
import { BROWSER_FEATURE } from './definitions';
import type { BundledFeatureBinding } from './feature';

/** Browser controls may be replaced without replacing the daemon-owned tabs or native pages. */
export function bindBrowserFeature(props: WebPaneProps): BundledFeatureBinding {
    return { definition: BROWSER_FEATURE, render: context => <WebPane {...props} visible={context.visible} /> };
}
