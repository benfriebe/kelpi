import type { ReactElement } from 'react';
import type { WebPaneProps } from '../webpane/WebPane';
import { WebPageSurface } from '../webpane/WebPageSurface';
import type { BrowserFrameBounds, BrowserPresentation, BrowserSurfaceState } from './browser';

export interface BrowserViewHost extends WebPaneProps {
    readonly available: boolean;
    readonly reason?: string | undefined;
}
export function browserPresentation(host: BrowserViewHost): BrowserPresentation {
    return { available: host.available, visible: host.visible !== false, focused: host.focused === true,
        ...(host.reason ? { reason: host.reason.slice(0, 4096) } : {}) };
}
export function browserFrameBounds(frame: HTMLIFrameElement | null): BrowserFrameBounds | null {
    if (!frame?.isConnected) return null;
    const box = frame.getBoundingClientRect(), view = frame.ownerDocument.defaultView;
    return { rect: { x: box.x, y: box.y, w: box.width, h: box.height }, width: frame.clientWidth, height: frame.clientHeight,
        viewport: { width: view?.innerWidth ?? 0, height: view?.innerHeight ?? 0 } };
}

/** Recovery remains in the host even when the author's UI cannot run. */
export function PluginBrowserSurface(props: { readonly host: BrowserViewHost; readonly surface: BrowserSurfaceState; readonly root: HTMLElement | null }): ReactElement {
    const { host, surface, root } = props;
    const origin = root?.getBoundingClientRect();
    return <div data-plugin-browser-surface={host.paneID} style={{ position: 'absolute', display: surface.visible ? 'flex' : 'none',
        left: surface.rect.x - (origin?.x ?? 0), top: surface.rect.y - (origin?.y ?? 0), width: surface.rect.w, height: surface.rect.h,
        visibility: surface.covered ? 'hidden' : undefined }}>
        <WebPageSurface {...host} embedded={host.available} visible={host.visible !== false && surface.visible && !surface.covered}
            unavailableReason={host.reason} measure={() => surface.rect} />
    </div>;
}
