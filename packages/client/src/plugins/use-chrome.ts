import { useLayoutEffect, useRef, useState } from 'react';
import type { KelpiRuntime } from '../state';
import { createPluginChrome, type ChromeSource, type PluginChrome } from './chrome';

/** Commit-only publication, stable bridge identity, and StrictMode-safe disposal. */
export function usePluginChrome(runtime: KelpiRuntime, source: ChromeSource): PluginChrome | null {
    const latest = useRef(source);
    const [held, setHeld] = useState<{ runtime: KelpiRuntime; model: PluginChrome } | null>(null);
    useLayoutEffect(() => { latest.current = source; });
    useLayoutEffect(() => {
        const model = createPluginChrome(latest.current); setHeld({ runtime, model });
        return () => model.dispose();
    }, [runtime]);
    const model = held?.runtime === runtime ? held.model : null;
    useLayoutEffect(() => { model?.update(source); });
    return model;
}
