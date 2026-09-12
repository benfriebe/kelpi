import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createInteractionSurface, type InteractionSurface, type InteractionSurfaceConfig } from './surface';

/**
 * The window's one interaction surface, held across renders and disposed on the real unmount.
 *
 * Two hazards, both of which the old prompt host (formerly `plugins/UIServiceHost.tsx`) already had
 * to answer, and both answered the same way here:
 *
 *   1. **StrictMode's effect rehearsal.** React mounts, unmounts and remounts every effect in
 *      development. Disposing on the rehearsal's cleanup would resolve every pending request with
 *      null before the window had finished mounting, so disposal is deferred by one microtask and
 *      declines if the component came back.
 *
 *   2. **Callbacks that change identity every render.** `App` builds its accessors inline, so the
 *      surface is created ONCE against an indirection that reads the latest render's config. The
 *      alternative - recreating the surface when a callback changed - would drop every pending
 *      prompt on an unrelated re-render.
 */
export function useInteractionSurface(config: InteractionSurfaceConfig = {}): InteractionSurface {
    const latest = useRef(config);
    latest.current = config;

    const [surface] = useState((): InteractionSurface => {
        const first = latest.current;
        return createInteractionSurface({
            // Each arm is installed only when the first render supplied it, so a bare
            // `useInteractionSurface()` still gets the surface's own defaults.
            ...(first.paletteState === undefined
                ? {}
                : {
                      paletteState: {
                          isOpen: () => latest.current.paletteState?.isOpen() ?? false,
                          getQuery: () => latest.current.paletteState?.getQuery() ?? '',
                          setOpen: (open: boolean) => latest.current.paletteState?.setOpen(open),
                          setQuery: (query: string) => latest.current.paletteState?.setQuery(query)
                      }
                  }),
            ...(first.focus === undefined
                ? {}
                : {
                      focus: {
                          fallbackPaneID: () => latest.current.focus?.fallbackPaneID() ?? null,
                          handBackCaret: (paneID: string | null) => latest.current.focus?.handBackCaret(paneID),
                          paneHandoff: (paneID: string | null) => latest.current.focus?.paneHandoff(paneID),
                          ...(first.focus.handoffDelayMs === undefined
                              ? {}
                              : { handoffDelayMs: first.focus.handoffDelayMs })
                      }
                  }),
            ...(first.remoteWorkspaceSelected === undefined
                ? {}
                : { remoteWorkspaceSelected: () => latest.current.remoteWorkspaceSelected?.() ?? false }),
            ...(first.reportFailure === undefined
                ? {}
                : {
                      reportFailure: (label: string, detail: string) =>
                          latest.current.reportFailure?.(label, detail)
                  })
        });
    });

    // The palette's feed arrives later than the surface (and is null until it does). It must be
    // identity-stable across renders - a fresh object here resubscribes and republishes.
    const feed = config.palette ?? null;
    useLayoutEffect(() => {
        surface.palette.setSource(feed);
    }, [surface, feed]);

    const mounted = useRef(false);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            queueMicrotask(() => {
                if (!mounted.current) surface.dispose();
            });
        };
    }, [surface]);

    return surface;
}
