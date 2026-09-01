import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ReactElement } from 'react';

import type { KelpiRuntime } from '../state';
import {
    tokenFromPairingURL,
    useRemoteDaemons,
    type RemoteDaemonEntry,
    type RemoteDaemonRuntime
} from './remote-daemons';

afterEach(cleanup);

function fakeRuntime(): KelpiRuntime & { connects: number; disposed: boolean } {
    const runtime = {
        connects: 0,
        disposed: false,
        connect() {
            runtime.connects += 1;
        },
        dispose() {
            runtime.disposed = true;
        }
    };
    return runtime as unknown as KelpiRuntime & { connects: number; disposed: boolean };
}

function Probe(props: {
    readonly entries: readonly RemoteDaemonEntry[];
    readonly factory: (entry: RemoteDaemonEntry) => KelpiRuntime;
    readonly onMap: (map: ReadonlyMap<string, RemoteDaemonRuntime>) => void;
}): ReactElement | null {
    props.onMap(useRemoteDaemons(props.entries, props.factory));
    return null;
}

describe('useRemoteDaemons (§1.7)', () => {
    it('creates-and-connects per entry, recreates on a URL change, disposes on removal and unmount', () => {
        const made: (KelpiRuntime & { connects: number; disposed: boolean })[] = [];
        const factory = vi.fn((_entry: RemoteDaemonEntry) => {
            const runtime = fakeRuntime();
            made.push(runtime);
            return runtime;
        });
        let latest: ReadonlyMap<string, RemoteDaemonRuntime> = new Map();
        const view = render(
            <Probe
                entries={[{ name: 'werk', url: 'https://werk/?token=kd_a' }]}
                factory={factory}
                onMap={(map) => (latest = map)}
            />
        );
        expect(made).toHaveLength(1);
        expect(made[0]?.connects).toBe(1);
        expect([...latest.keys()]).toEqual(['werk']);

        // Same name, new URL: a different daemon wearing the same name — recreate.
        view.rerender(
            <Probe
                entries={[{ name: 'werk', url: 'https://elsewhere/?token=kd_b' }]}
                factory={factory}
                onMap={(map) => (latest = map)}
            />
        );
        expect(made).toHaveLength(2);
        expect(made[0]?.disposed).toBe(true);
        expect(made[1]?.connects).toBe(1);

        // Removal disposes; unmount disposes the rest.
        view.rerender(<Probe entries={[]} factory={factory} onMap={(map) => (latest = map)} />);
        expect(made[1]?.disposed).toBe(true);
        expect(latest.size).toBe(0);
        view.unmount();
    });

    it('tokenFromPairingURL reads the credential off a pairing URL, and shrugs at junk', () => {
        expect(tokenFromPairingURL('https://werk.taila.ts.net/?token=kd_abc')).toBe('kd_abc');
        expect(tokenFromPairingURL('https://werk.taila.ts.net/')).toBeUndefined();
        expect(tokenFromPairingURL('not a url')).toBeUndefined();
    });
});
