import { useLayoutEffect, useRef, useState } from 'react';
import { createPluginNavigation, type PluginNavigation, type PluginNavigationOptions } from './navigation';

/** Create and update only after commit; StrictMode recreates disposed models safely. */
export function usePluginNavigation(options: PluginNavigationOptions): PluginNavigation | null {
    const optionsRef = useRef(options);
    const [held, setHeld] = useState<{ readonly options: PluginNavigationOptions; readonly model: PluginNavigation } | null>(null);
    useLayoutEffect(() => { optionsRef.current = options; });
    useLayoutEffect(() => {
        const current = optionsRef.current;
        const model = createPluginNavigation(current);
        setHeld({ options: current, model });
        return () => model.dispose();
    }, [options.runtime, options.activateLocalWorkspace, options.selectRemoteWorkspace]);
    const matches = held?.options.runtime === options.runtime && held.options.activateLocalWorkspace === options.activateLocalWorkspace &&
        held.options.selectRemoteWorkspace === options.selectRemoteWorkspace;
    useLayoutEffect(() => { if (matches) held.model.update(options); });
    return matches ? held.model : null;
}
