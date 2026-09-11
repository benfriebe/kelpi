import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { decodePluginManifest, pluginRecord, type JsonValue, type PluginInfo, type PluginRevisionInfo } from '@kelpi/protocol';
import type { KelpiRuntime } from '../state';
import { pluginRequest } from './client';

function readHistory(result: JsonValue, pluginID: string): PluginRevisionInfo[] {
    const invalid = (): never => { throw new Error('This daemon returned invalid plugin version history.'); };
    if (!Array.isArray(result)) return invalid();
    const seen = new Set<string>();
    let selected = false;
    return result.map(row => {
        if (!pluginRecord(row) || typeof row['revision'] !== 'string' || !/^[a-f0-9]{64}$/.test(row['revision']) || seen.has(row['revision'])
            || typeof row['selected'] !== 'boolean' || (row['problem'] !== null && typeof row['problem'] !== 'string')
            || (row['installedAt'] !== null && (typeof row['installedAt'] !== 'number' || !Number.isSafeInteger(row['installedAt']) || row['installedAt'] < 0 || row['installedAt'] > 8.64e15))) return invalid();
        if (row['selected'] && selected) return invalid();
        selected ||= row['selected']; seen.add(row['revision']);
        const manifest = decodePluginManifest(row['manifest']);
        if (manifest.id !== pluginID) return invalid();
        return { revision: row['revision'], manifest, installedAt: row['installedAt'], selected: row['selected'], problem: row['problem'] };
    });
}

/** Retained code belongs to one daemon and installed instance; never carry a read across either. */
export function PluginRevisions(props: {
    runtime: KelpiRuntime;
    plugin: PluginInfo;
    busy: boolean;
    selectRevision(revision: string): Promise<boolean>;
}): ReactElement {
    const { runtime, plugin } = props;
    const owner = useMemo(() => ({ runtime, pluginID: plugin.manifest.id, revision: plugin.revision, instanceID: plugin.instanceID }),
        [runtime, plugin.manifest.id, plugin.revision, plugin.instanceID]);
    const current = useRef(owner); current.current = owner;
    const [expanded, setExpanded] = useState(false);
    const [history, setHistory] = useState<{ owner: typeof owner; entries: PluginRevisionInfo[]; loading: boolean; error: string | null } | null>(null);
    const [switching, setSwitching] = useState<{ owner: typeof owner; revision: string } | null>(null);
    const [failure, setFailure] = useState<{ owner: typeof owner; message: string } | null>(null);
    const refresh = useRef<(() => void) | null>(null);
    const pending = useRef<typeof owner | null>(null);
    const mounted = useRef(false);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    useEffect(() => {
        if (!expanded) return;
        let active = true, generation = 0;
        const update = (state: { entries: PluginRevisionInfo[]; loading: boolean; error: string | null }): void => {
            if (active && current.current === owner) setHistory({ owner, ...state });
        };
        const load = (): void => {
            const requested = ++generation;
            if (!runtime.connection.isConnected) { update({ entries: [], loading: false, error: 'Reconnect to load version history.' }); return; }
            setHistory(previous => ({ owner, entries: previous?.owner === owner ? previous.entries : [], loading: true, error: null }));
            void pluginRequest(runtime, 'history', { pluginID: owner.pluginID }).then(result => {
                if (!active || requested !== generation || current.current !== owner) return;
                update({ entries: readHistory(result, owner.pluginID), loading: false, error: null });
            }).catch(error => {
                if (active && requested === generation && current.current === owner) update({ entries: [], loading: false, error: error instanceof Error ? error.message : String(error) });
            });
        };
        refresh.current = load; load();
        const offMessage = runtime.connection.on('message', message => {
            if (message['type'] !== 'plugins-changed') return;
            // Broadcasts arrive before React commits the new props. Revoke an old read
            // immediately and let the new owner load its own history after that commit.
            if (Array.isArray(message['plugins'])) {
                const next = message['plugins'].find(row => pluginRecord(row) && pluginRecord(row['manifest']) && row['manifest']['id'] === owner.pluginID);
                if (!pluginRecord(next) || next['revision'] !== owner.revision || next['instanceID'] !== owner.instanceID) {
                    generation += 1; update({ entries: [], loading: true, error: null }); return;
                }
            }
            load();
        });
        const offStatus = runtime.connection.on('status', () => { load(); });
        return () => { active = false; generation += 1; offMessage(); offStatus(); if (refresh.current === load) refresh.current = null; };
    }, [owner, expanded, runtime]);

    const state = history?.owner === owner ? history : null;
    const working = switching?.owner === owner ? switching.revision : null;
    const error = failure?.owner === owner ? failure.message : state?.error;
    const disabled = props.busy || working !== null || state?.loading !== false || !runtime.connection.isConnected;
    const select = async (entry: PluginRevisionInfo): Promise<void> => {
        if (disabled || pending.current === owner || entry.selected || entry.problem || current.current !== owner) return;
        pending.current = owner; setSwitching({ owner, revision: entry.revision }); setFailure(null);
        try {
            const accepted = await props.selectRevision(entry.revision);
            if (accepted && mounted.current && current.current === owner) refresh.current?.();
        } catch (error) {
            if (mounted.current && current.current === owner) setFailure({ owner, message: error instanceof Error ? error.message : String(error) });
        } finally {
            if (pending.current === owner) pending.current = null;
            if (mounted.current && current.current === owner) setSwitching(null);
        }
    };

    return <div className="flex flex-col gap-2" data-testid={`plugin-revisions-${plugin.manifest.id}`}>
        <button type="button" className="self-start" aria-expanded={expanded} aria-controls={`plugin-versions-${plugin.manifest.id}`} onClick={() => setExpanded(value => !value)}>Versions</button>
        {expanded ? <div id={`plugin-versions-${plugin.manifest.id}`} className="flex flex-col gap-2">
            <p>Switch retained plugin versions while preserving panes and native sessions.</p>
            {!state || state.loading ? <p role="status">Loading version history…</p> : null}
            {error ? <p role="alert">{error}</p> : null}
            {state && !state.loading && !state.error && state.entries.length === 0 ? <p>No retained versions.</p> : null}
            {state?.entries.map(entry => {
                const short = entry.revision.slice(0, 12), problemID = `plugin-version-problem-${plugin.manifest.id}-${entry.revision}`;
                return <div key={entry.revision} className="flex flex-col gap-1 rounded border p-2" data-plugin-revision={entry.revision}>
                    <div className="flex flex-wrap items-center justify-between gap-2"><span><strong>{entry.manifest.version}</strong> · <code title={entry.revision}>{short}</code>{entry.selected ? ' · Current' : ''}</span>
                        {entry.selected ? null : <button type="button" disabled={disabled || entry.problem !== null} aria-label={`Use version ${entry.manifest.version} (${short})`} aria-describedby={entry.problem ? problemID : undefined} onClick={() => void select(entry)}>{working === entry.revision ? 'Switching…' : 'Use this version'}</button>}
                    </div>
                    <span className="opacity-70">{entry.installedAt === null ? 'Installation date unavailable' : <>Installed <time dateTime={new Date(entry.installedAt).toISOString()}>{new Date(entry.installedAt).toLocaleString()}</time></>}</span>
                    {entry.problem ? <p id={problemID}>{entry.problem}</p> : null}
                </div>;
            })}
            <button type="button" className="self-start" disabled={props.busy || working !== null || state?.loading === true || !runtime.connection.isConnected} onClick={() => refresh.current?.()}>Refresh versions</button>
        </div> : null}
    </div>;
}
