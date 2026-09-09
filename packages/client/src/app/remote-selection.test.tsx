import { StrictMode, startTransition, type Dispatch, type SetStateAction } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { KelpiRuntime } from '../state';
import type { RemoteDaemonRuntime } from './remote-daemons';
import type { RemoteSelection } from './RemoteDaemonSections';
import { useRemoteWorkspaceSelection } from './remote-selection';

function host(name: string, url = `https://${name}.invalid/?token=private`): RemoteDaemonRuntime {
    return { name, url, runtime: {} as KelpiRuntime };
}
const remotes = (...hosts: RemoteDaemonRuntime[]): ReadonlyMap<string, RemoteDaemonRuntime> => new Map(hosts.map(host => [host.name, host]));
afterEach(cleanup);

describe('remote workspace selection identity', () => {
    it('provides a stable Dispatch-compatible selector through StrictMode and functional updates', () => {
        const first = host('first'), second = host('second');
        const mounted = renderHook(({ hosts }) => useRemoteWorkspaceSelection(hosts), {
            initialProps: { hosts: remotes(first, second) }, wrapper: StrictMode,
        });
        const select: Dispatch<SetStateAction<RemoteSelection | null>> = mounted.result.current.select;
        expect(mounted.result.current.selection).toBeNull();
        act(() => select({ daemon: 'first', workspaceID: 'W1' }));
        expect(mounted.result.current.activeRemote).toBe(first);
        expect(mounted.result.current.selection).toEqual({ daemon: 'first', workspaceID: 'W1' });
        act(() => select(previous => ({ daemon: 'second', workspaceID: `${previous!.workspaceID}-next` })));
        expect(mounted.result.current.selection).toEqual({ daemon: 'second', workspaceID: 'W1-next' });
        expect(mounted.result.current.activeRemote).toBe(second);
        mounted.rerender({ hosts: remotes(first, second) });
        expect(mounted.result.current.select).toBe(select);
        act(() => select(null));
        expect(mounted.result.current.selection).toBeNull();
        expect(mounted.result.current.activeRemote).toBeNull();
    });

    it('never renders a replacement URL as selected and forgets the old selection', () => {
        const original = host('remote'), replacement = host('remote', 'https://replacement.invalid/?token=new');
        const observed: Array<RemoteDaemonRuntime | null> = [];
        const mounted = renderHook(({ hosts }) => {
            const result = useRemoteWorkspaceSelection(hosts); observed.push(result.activeRemote); return result;
        }, { initialProps: { hosts: remotes(original) }, wrapper: StrictMode });
        act(() => mounted.result.current.select({ daemon: 'remote', workspaceID: 'W' }));
        observed.length = 0;
        mounted.rerender({ hosts: remotes(replacement) });
        expect(observed.length).toBeGreaterThan(0);
        expect(observed.every(remote => remote === null)).toBe(true);
        expect(mounted.result.current.selection).toBeNull();
        mounted.rerender({ hosts: remotes(original) });
        expect(mounted.result.current.selection).toBeNull();
        expect(mounted.result.current.activeRemote).toBeNull();
        act(() => mounted.result.current.select({ daemon: 'remote', workspaceID: 'W' }));
        expect(mounted.result.current.activeRemote).toBe(original);
    });

    it('retains selection when the same configured identity reconnects through a new runtime', () => {
        const original = host('remote'), reconnected = host('remote');
        const mounted = renderHook(({ hosts }) => useRemoteWorkspaceSelection(hosts), { initialProps: { hosts: remotes(original) } });
        act(() => mounted.result.current.select({ daemon: 'remote', workspaceID: 'W' }));
        const selection = mounted.result.current.selection;
        mounted.rerender({ hosts: remotes(reconnected) });
        expect(mounted.result.current.selection).toBe(selection);
        expect(mounted.result.current.activeRemote).toBe(reconnected);
    });

    it('invalidates removals and renamed identities, including a later re-add of the same host', () => {
        const original = host('remote'), renamed = { ...original, name: 'renamed' };
        const mounted = renderHook(({ hosts }) => useRemoteWorkspaceSelection(hosts), { initialProps: { hosts: remotes(original) } });
        act(() => mounted.result.current.select({ daemon: 'remote', workspaceID: 'W' }));
        mounted.rerender({ hosts: remotes() });
        expect(mounted.result.current.selection).toBeNull();
        mounted.rerender({ hosts: remotes(original) });
        expect(mounted.result.current.selection).toBeNull();
        act(() => mounted.result.current.select({ daemon: 'remote', workspaceID: 'W' }));
        mounted.rerender({ hosts: remotes(renamed) });
        expect(mounted.result.current.selection).toBeNull();
        act(() => mounted.result.current.select({ daemon: 'remote', workspaceID: 'W' }));
        expect(mounted.result.current.activeRemote).toBeNull();
        act(() => mounted.result.current.select({ daemon: 'renamed', workspaceID: 'W' }));
        expect(mounted.result.current.activeRemote).toBe(renamed);
    });

    it('pins a deferred selection at dispatch time, so a concurrent replacement cannot inherit it', () => {
        const original = host('remote'), replacement = host('remote', 'https://replacement.invalid');
        const mounted = renderHook(({ hosts }) => useRemoteWorkspaceSelection(hosts), { initialProps: { hosts: remotes(original) } });
        const select = mounted.result.current.select;
        act(() => {
            startTransition(() => select({ daemon: 'remote', workspaceID: 'W' }));
            mounted.rerender({ hosts: remotes(replacement) });
        });
        expect(mounted.result.current.selection).toBeNull();
        expect(mounted.result.current.activeRemote).toBeNull();
        let previous: RemoteSelection | null | undefined;
        act(() => select(value => { previous = value; return { daemon: 'remote', workspaceID: 'new' }; }));
        expect(previous).toBeNull();
        expect(mounted.result.current.activeRemote).toBe(replacement);
    });
});
