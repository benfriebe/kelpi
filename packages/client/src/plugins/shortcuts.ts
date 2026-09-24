import { useEffect, useState } from 'react';
import { isPluginID } from '@kelpi/protocol';
import { canonicalTriggerForPlatform, keyTriggerConfigString, parseKeyTrigger, type KeyTrigger } from '@kelpi/core/config';
import { chordKeysForTrigger } from '../content/bridge';
import type { KelpiRuntime } from '../state';
import { usePlugins } from './client';

export type PluginShortcutOverrides = Readonly<Record<string, string | null>>;
const CHANGED = 'kelpi:plugin-shortcuts-changed';

/** A command as chord resolution sees it: its effective shortcut, and whether it applies right now. */
export interface PluginChordCandidate {
    readonly shortcut?: string | undefined;
    readonly visible: boolean;
    readonly enabled: boolean;
}
export interface ResolvedPluginChord<T> {
    readonly command: T;
    /** The shortcut as this platform fires it, or null when it names nothing that can fire. */
    readonly trigger: KeyTrigger | null;
    /** The chord keys that run this command while it applies. Empty when unbound or taken. */
    readonly keys: readonly string[];
    /** Every key was claimed first: by a native chord (`command` null) or an earlier live command. */
    readonly takenBy: { readonly chord: string; readonly command: T | null } | null;
    /**
     * This command does not apply right now and a later live command holds its chord meanwhile:
     * pressing it runs that command until this one applies again and takes the chord back.
     */
    readonly heldBy: T | null;
}

/**
 * Who a plugin shortcut's chord runs, decided once for the dispatcher and for Help.
 *
 * Native chords are claimed before any plugin, then each command that currently applies claims
 * what is left of its shortcut in plugin and declaration order, so the first available command
 * wins a collision. A command that does not apply claims nothing but is still resolved, and what
 * it is told is what its chord would run the moment it did apply.
 */
export function resolvePluginChords<T extends PluginChordCandidate>(commands: readonly T[], reserved: Iterable<string>, macLike: boolean): ResolvedPluginChord<T>[] {
    const owners = new Map<string, T | null>();
    for (const key of reserved) owners.set(key, null);
    const resolved = commands.map(command => {
        // A manifest shortcut is not normalized at install, so an unparseable or Shift-only one never fires.
        const parsed = command.shortcut ? parseKeyTrigger(command.shortcut) : null;
        const trigger = parsed && parsed.modifiers.some(modifier => modifier !== 'shift') ? canonicalTriggerForPlatform(parsed, macLike) : null;
        const all = trigger ? chordKeysForTrigger(trigger).filter(key => !key.startsWith('0/')) : [];
        const keys = all.filter(key => !owners.has(key));
        if (command.visible && command.enabled) for (const key of keys) owners.set(key, command);
        const first = all[0];
        return { command, trigger: all.length ? trigger : null, keys, takenBy: !keys.length && first !== undefined ? { chord: first, command: owners.get(first) ?? null } : null };
    });
    // Only once every command has claimed can a later one be seen holding an earlier one's chord.
    return resolved.map(entry => {
        const holder = entry.keys.length ? owners.get(entry.keys[0]!) ?? null : null;
        return { ...entry, heldBy: holder === entry.command ? null : holder };
    });
}

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
