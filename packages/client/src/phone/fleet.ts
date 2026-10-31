/**
 * Every host the phone can show, read as ONE value: each host's connection, whether its snapshot
 * has landed, and its workspaces.
 *
 * Home, the location bar's picker and the Needs-you surface all answer questions ACROSS hosts
 * ("what is waiting anywhere", "how many workspaces on each"), and each host is its own zustand
 * mirror. Subscribing per host inside each component would mean a component per host just to call
 * `useStore`, so this hook subscribes to all of them at once and hands back one array.
 *
 * That array changes identity only when something the phone DRAWS from it changes, and that is
 * the point of the {@link fleetDigest}: a host's store moves on every delta, and an agent that
 * animates its terminal title sends one a second, but a title is not on Home, in the pill or in
 * the picker's host rows. Rebuilding the shell (and with it the pane on screen) for every frame of
 * some other host's spinner would cost more than the whole feature, so a reading keeps its old
 * workspaces until the digest says a workspace, a pane, a status, a name or a mute has changed.
 *
 * It writes nothing and asks no daemon for anything.
 */

import { useCallback, useRef, useSyncExternalStore } from 'react';

import type { WorkspaceState } from '@kelpi/daemon/store';

import type { ConnectionStatus } from '../connection';
import type { PhoneHostModel } from './model';

export interface PhoneHostReading {
    readonly host: PhoneHostModel;
    readonly connection: ConnectionStatus;
    /** False until the host's first snapshot: its zero workspaces are "not heard from yet". */
    readonly known: boolean;
    readonly workspaces: readonly WorkspaceState[];
}

/**
 * What the phone's cross-host surfaces read off a host's workspaces, as one string: every
 * workspace's id, name, colour, icon, mute and nesting, and every pane's id, type, status, agent,
 * label and background work. Not titles, directories or layouts, which only the workspace on screen
 * shows, through its own subscription.
 */
export function fleetDigest(workspaces: readonly WorkspaceState[]): string {
    const parts: string[] = [];
    for (const workspace of workspaces) {
        parts.push(
            `${workspace.id}|${workspace.name}|${workspace.color}|${JSON.stringify(workspace.icon)}|${String(workspace.muted)}|${(workspace.childOrder ?? []).join(',')}|${String(workspace.childrenCollapsed ?? false)}`
        );
        for (const pane of workspace.panes) {
            parts.push(`.${pane.id}|${pane.type}|${pane.status}|${pane.agentKind ?? ''}|${pane.label ?? ''}|${String(pane.backgroundTaskCount)}`);
        }
    }
    return parts.join('\n');
}

interface CachedReading {
    readonly reading: PhoneHostReading;
    readonly digest: string;
    readonly source: readonly WorkspaceState[];
}

export function readHost(host: PhoneHostModel): PhoneHostReading {
    const state = host.runtime.store.getState();
    return {
        host,
        connection: state.ui.connection,
        known: state.daemon.hasSnapshot,
        workspaces: state.daemon.state.workspaces
    };
}

/** All hosts, in the order given, re-read when any host's store moves and changed only when it matters. */
export function usePhoneFleet(hosts: readonly PhoneHostModel[]): readonly PhoneHostReading[] {
    const cache = useRef<{ readonly hosts: readonly PhoneHostModel[]; readonly readings: readonly CachedReading[]; readonly value: readonly PhoneHostReading[] } | null>(null);

    const subscribe = useCallback(
        (onChange: () => void): (() => void) => {
            const stops = hosts.map((host) => host.runtime.store.subscribe(onChange));
            return () => {
                for (const stop of stops) stop();
            };
        },
        [hosts]
    );

    const snapshot = useCallback((): readonly PhoneHostReading[] => {
        const previous = cache.current?.hosts === hosts ? cache.current : null;
        let changed = previous === null;
        const readings = hosts.map((host, index): CachedReading => {
            const fresh = readHost(host);
            const before = previous?.readings[index];
            if (before !== undefined && before.source === fresh.workspaces && before.reading.connection === fresh.connection && before.reading.known === fresh.known) {
                return before;
            }
            const digest = before?.source === fresh.workspaces ? before.digest : fleetDigest(fresh.workspaces);
            if (before !== undefined && before.digest === digest && before.reading.connection === fresh.connection && before.reading.known === fresh.known) {
                // Same picture, newer array: keep the reading the surfaces already drew from.
                return { reading: before.reading, digest, source: fresh.workspaces };
            }
            changed = true;
            return { reading: fresh, digest, source: fresh.workspaces };
        });
        if (!changed && previous !== null) {
            cache.current = { hosts, readings, value: previous.value };
            return previous.value;
        }
        const value = readings.map((entry) => entry.reading);
        cache.current = { hosts, readings, value };
        return value;
    }, [hosts]);

    return useSyncExternalStore(subscribe, snapshot, snapshot);
}
