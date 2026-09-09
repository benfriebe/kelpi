import { useEffect, useState } from 'react';
import { isPluginID } from '@kelpi/protocol';
import { keyTriggerConfigString, parseKeyTrigger } from '@kelpi/core/config';
import type { KelpiRuntime } from '../state';
import { usePlugins } from './client';

export type PluginShortcutOverrides = Readonly<Record<string, string | null>>;
const CHANGED = 'kelpi:plugin-shortcuts-changed';

/** Empty means explicitly unbound; undefined means restore the manifest default. */
export function normalizePluginShortcut(value: string): string | null {
    if (!value.trim()) return null;
    const trigger = parseKeyTrigger(value.trim());
    if (!trigger || !trigger.modifiers.some(modifier => modifier !== 'shift')) throw new Error('Use a shortcut with Cmd, Ctrl, or Alt, such as super+shift+b.');
    return keyTriggerConfigString(trigger);
}

function read(key: string): PluginShortcutOverrides {
    try {
        const value: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
        return Object.fromEntries(Object.entries(value).flatMap(([id, shortcut]) => {
            if (!isPluginID(id) || (typeof shortcut !== 'string' && shortcut !== null)) return [];
            try { return [[id, shortcut === null ? null : normalizePluginShortcut(shortcut)]]; } catch { return []; }
        }));
    } catch { return {}; }
}

/** Client preference follows stable daemon identity and updates all mounted command hosts. */
export function usePluginShortcuts(runtime: KelpiRuntime): {
    overrides: PluginShortcutOverrides;
    setShortcut(id: string, value: string | undefined): void;
} {
    const { daemonID } = usePlugins(runtime);
    const key = `kelpi.plugin-shortcuts.v1:${daemonID ?? new URL(runtime.connection.target).host}`;
    const [saved, setSaved] = useState(() => ({ key, overrides: read(key) }));
    useEffect(() => {
        const refresh = (): void => setSaved({ key, overrides: read(key) });
        const storage = (event: StorageEvent): void => { if (event.key === key || event.key === null) refresh(); };
        const local = (event: Event): void => { if ((event as CustomEvent<string>).detail === key) refresh(); };
        refresh();
        window.addEventListener('storage', storage);
        window.addEventListener(CHANGED, local);
        return () => { window.removeEventListener('storage', storage); window.removeEventListener(CHANGED, local); };
    }, [key]);
    return {
        overrides: saved.key === key ? saved.overrides : read(key),
        setShortcut(id, value) {
            if (!isPluginID(id)) throw new Error('invalid plugin command identity');
            const next = { ...read(key) };
            if (value === undefined) delete next[id]; else next[id] = normalizePluginShortcut(value);
            // Report persistence failure to the settings field instead of claiming it was saved.
            localStorage.setItem(key, JSON.stringify(next));
            setSaved({ key, overrides: next });
            window.dispatchEvent(new CustomEvent(CHANGED, { detail: key }));
        }
    };
}
