import type { ReactNode } from 'react';

/** Bundled adapters keep their React context; external adapters own their isolated view host. */
export interface ViewRenderContext {
    readonly visible: boolean;
    /** The outer plugin host already reserves the window buttons when this is zero. */
    readonly trafficLightInset: number;
}
export type ViewRenderers = Readonly<Record<string, (context: ViewRenderContext) => ReactNode>>;

export function renderRegisteredView(renderers: ViewRenderers, id: string, fallback: () => ReactNode, context: ViewRenderContext = { visible: true, trafficLightInset: 0 }): ReactNode {
    return (Object.hasOwn(renderers, id) ? renderers[id]! : fallback)(context);
}
