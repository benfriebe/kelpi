import { useEffect, useState, type ReactElement } from 'react';
import { pluginRecord } from '@kelpi/protocol';
import type { KelpiRuntime } from '../state';
import { pluginRequest } from './client';

interface ServiceInfo {
    id: string;
    title: string;
    version: number;
    selectedProviderID: string | null;
    activeProviderID: string | null;
    providers: Array<{ id: string; title: string; status: 'available' | 'disabled' | 'failed'; error?: string }>;
}

export function PluginProviders(props: { runtime: KelpiRuntime }): ReactElement | null {
    const [services, setServices] = useState<ServiceInfo[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        let active = true, generation = 0;
        const refresh = (): void => {
            const requested = ++generation;
            void pluginRequest(props.runtime, 'services').then(result => {
                if (!active || requested !== generation) return;
                setServices(Array.isArray(result) ? result as unknown as ServiceInfo[] : []);
                setError(null);
            }, error => { if (active && requested === generation) setError(String(error.message)); });
        };
        refresh();
        const off = props.runtime.connection.on('message', message => {
            if (message['type'] === 'plugins-changed' || (message['type'] === 'plugin-event' && pluginRecord(message['event']) && message['event']['name'] === 'services.changed')) refresh();
        });
        const status = props.runtime.connection.on('status', status => { if (status === 'connected') refresh(); });
        return () => { active = false; off(); status(); };
    }, [props.runtime]);
    const select = async (service: ServiceInfo, provider: string): Promise<void> => {
        setBusy(true); setError(null);
        try {
            await pluginRequest(props.runtime, 'service-select', { service: service.id, version: service.version, provider: provider || null });
            const result = await pluginRequest(props.runtime, 'services');
            setServices(Array.isArray(result) ? result as unknown as ServiceInfo[] : []);
        } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
        finally { setBusy(false); }
    };
    const choices = services.filter(service => service.providers.some(provider => provider.id !== `${service.id}.bundled`) || service.selectedProviderID);
    if (!choices.length && !error) return null;
    return <section className="flex flex-col gap-3" data-testid="plugin-providers">
        <strong>Service providers</strong>
        {error ? <p role="alert">{error}</p> : null}
        {choices.map(service => {
            const savedMissing = service.selectedProviderID && !service.providers.some(provider => provider.id === service.selectedProviderID);
            const active = service.providers.find(provider => provider.id === service.activeProviderID);
            return <div key={`${service.id}@${service.version}`} className="flex flex-col gap-1">
                <label className="flex items-center justify-between gap-3">{service.title} v{service.version}
                    <select aria-label={`Provider for ${service.title} v${service.version}`} value={service.selectedProviderID ?? ''} disabled={busy}
                        onChange={event => void select(service, event.target.value)}>
                        <option value="">Default</option>
                        {savedMissing ? <option value={service.selectedProviderID!} disabled>{service.selectedProviderID} (unavailable)</option> : null}
                        {service.providers.map(provider => <option key={provider.id} value={provider.id} disabled={provider.status !== 'available'}>{provider.title}{provider.status === 'available' ? '' : ` (${provider.status})`}</option>)}
                    </select>
                </label>
                {service.selectedProviderID !== service.activeProviderID ? <p>Active: {active?.title ?? 'No provider selected'}.</p> : null}
            </div>;
        })}
    </section>;
}
