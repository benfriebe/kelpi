import { useCallback, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { RemoteDaemonRuntime } from './remote-daemons';
import type { RemoteSelection } from './RemoteDaemonSections';

interface HeldSelection {
    readonly selection: RemoteSelection;
    readonly url: string;
}

function selectedRemote(held: HeldSelection | null, remotes: ReadonlyMap<string, RemoteDaemonRuntime>): RemoteDaemonRuntime | null {
    if (!held) return null;
    const remote = remotes.get(held.selection.daemon);
    return remote?.name === held.selection.daemon && remote.url === held.url ? remote : null;
}

/** A selected workspace belongs to the configured name/URL that the user chose. */
export function useRemoteWorkspaceSelection(remotes: ReadonlyMap<string, RemoteDaemonRuntime>): {
    readonly selection: RemoteSelection | null;
    readonly select: Dispatch<SetStateAction<RemoteSelection | null>>;
    readonly activeRemote: RemoteDaemonRuntime | null;
} {
    const committedRemotes = useRef(remotes);
    const [held, setHeld] = useState<HeldSelection | null>(null);
    const activeRemote = selectedRemote(held, remotes);
    // Invalidate during render, before a replacement RemoteWorkspaceView can mount or
    // activate the old workspace ID against a different daemon. Cleanup forgets the old
    // choice, so later removing/readding the original URL cannot resurrect it either.
    const selection = activeRemote ? held!.selection : null;
    useLayoutEffect(() => {
        committedRemotes.current = remotes;
        if (held && !activeRemote) setHeld(current => current === held ? null : current);
    }, [remotes, held, activeRemote]);
    const select = useCallback<Dispatch<SetStateAction<RemoteSelection | null>>>(action => {
        // Capture at dispatch, not when React eventually applies a deferred state update.
        const chosenFrom = committedRemotes.current;
        setHeld(current => {
            const previous = selectedRemote(current, chosenFrom) ? current!.selection : null;
            const next = typeof action === 'function' ? action(previous) : action;
            if (!next) return null;
            const remote = chosenFrom.get(next.daemon);
            if (!remote || remote.name !== next.daemon) return null;
            if (current?.selection === next && current.url === remote.url) return current;
            return { selection: next, url: remote.url };
        });
    }, []);
    return { selection, select, activeRemote };
}
