/** Compiled against the distributed declarations; never executed. */
import type { BackendAPI, BrowserPresentation, BrowserSnapshot, BrowserSurface, ViewAPI } from './index.js';

async function browserAuthoring(view: ViewAPI, backend: BackendAPI, element: HTMLElement): Promise<void> {
    const state: BrowserSnapshot = await backend.browser.get('pane');
    const watch = await view.browser.watch();
    await view.browser.unwatch(watch.subscription);
    const surface: BrowserSurface = await view.browser.attach({ element, onPresentation(value: BrowserPresentation) { void value.available; }, onAction(action) { void action.type; } });
    surface.setCovered(true); surface.focus(); surface.dispose();
    await backend.browser.tabs.open(state.paneID, 'http://fixture', { makeActive: false });
    await backend.browser.tabs.reorder(state.paneID, state.tabs.map(tab => tab.id));
    await backend.browser.reload(state.paneID, { tabID: state.activeTabID ?? undefined, hard: true });
    await view.browser.find(state.paneID, 'tab', 'search', 'needle');
    const zoom: number = (await view.browser.zoom(state.paneID, 'tab', 'in')).zoom;
    const inspection = await backend.browser.inspect(state.paneID, { disarm: true });
    if (inspection.armed) { const destination: string = inspection.sendTo; void destination; }
    const favouriteDate: string | undefined = (await view.browser.favourites.list())[0]?.createdAt;
    const result = await view.browser.exec<{ snake_key: string }>(state.paneID, '({snake_key:"x"})');
    const originalKey: string = result.result.snake_key;
    await backend.browser.cookies.set(state.paneID, { name: 'x', value: 'y', domain: 'fixture', path: '/', isSecure: false, isHttpOnly: true });
    await view.browser.capture(state.paneID, { mode: 'screenshot' });
    await view.browser.batch.focus(state.paneID, null, 'panel');
    // @ts-expect-error Native surface attachment belongs only to an eligible view.
    await backend.browser.attach({ element, onPresentation() {} });
    // @ts-expect-error Numeric rects are not a native geometry grant.
    await view.browser.attach({ rect: { x: 0, y: 0, w: 80, h: 24 }, onPresentation() {} });
    // @ts-expect-error Surface grants never accept caller-supplied target IDs.
    await view.browser.attach({ element, paneID: state.paneID, onPresentation() {} });
    // @ts-expect-error Presentation callback is required for honest host availability.
    await view.browser.attach({ element });
    // @ts-expect-error Exact tab-targeted navigation is an option, not a window override.
    await view.browser.navigate(state.paneID, 'http://fixture', { windowID: 'other' });
    // @ts-expect-error Find actions use the supported native vocabulary.
    await view.browser.find(state.paneID, 'tab', 'replace', 'needle');
    // @ts-expect-error No unsupported capture aliases.
    await view.browser.capture(state.paneID, { mode: 'image' });
    // @ts-expect-error Private mode is an explicit boolean.
    await view.browser.setPrivate(state.paneID, 'on');
    void [favouriteDate, originalKey, zoom];
}
void browserAuthoring;
