/**
 * The phone's own list of hosts (owner request, 2026-09-08: "the mobile view able to connect to
 * multiple remote hosts").
 *
 * **An owner-directed divergence from the shipped Swift app**, like every phone rule in this
 * program (there is no Swift phone UI; `chrome/form-factor.ts` says so once for all of it).
 *
 * A desktop reaches a second daemon through `remote-daemon = <name>:<url>` lines in the daemon's
 * config (config-keybindings.md §1.7): the list is the DAEMON's, written over `set-remote-daemons`,
 * and every client of that daemon dials the same peers. A phone is a different animal: it is a
 * paired DEVICE, its credential for each host is that host's own pairing URL (Settings ▸ Remote
 * mints it once and never shows it again), and it is a guest everywhere - the remote-access verbs
 * are owner-only (`ws/sync.ts` `remoteCommand`), so it could not write the daemon's list even if
 * that were the right place. So the phone keeps its own list, on the phone, in `localStorage`, the
 * same place `app/config.ts` keeps the origin's token: the pairing URL carries the token
 * (`?token=kd_...`) exactly as `app/remote-daemons.ts` expects it to, and it never leaves the
 * device. The origin daemon - the one that served this page - is always the first host and is not
 * in this list; the daemon's own configured `remote-daemon` peers, already dialled by assembly,
 * appear beside it for free.
 *
 * Adding a host is pasting a pairing URL. The plan's QR flow (D2) draws the URL on the Mac for a
 * phone's camera, which opens it in the browser as the ORIGIN; for a second host the person copies
 * the link instead and pastes it here. Nothing in the daemon changes.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { defaultStorage, type StorageLike } from '../app/config';
import { tokenFromLocation } from '../connection';

export interface PhoneHostEntry {
    /** Stable, client-minted; the runtime is keyed by it so a rename does not redial. */
    readonly id: string;
    readonly name: string;
    /** The pairing URL, token and all. */
    readonly url: string;
}

/** Where the list is remembered. */
export const PHONE_HOSTS_KEY = 'kelpi.phone.hosts';

/** A pasted line's fate. */
export type PairingURLParse =
    | { readonly ok: true; readonly url: string; readonly hostname: string; readonly hasToken: boolean }
    | { readonly ok: false; readonly error: string };

function isEntry(value: unknown): value is PhoneHostEntry {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    return typeof record['id'] === 'string' && typeof record['name'] === 'string' && typeof record['url'] === 'string';
}

export function readStoredHosts(storage: StorageLike | null = defaultStorage()): readonly PhoneHostEntry[] {
    try {
        const raw = storage?.getItem(PHONE_HOSTS_KEY);
        if (raw === null || raw === undefined || raw.length === 0) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isEntry).map((entry) => ({ id: entry.id, name: entry.name, url: entry.url }));
    } catch {
        return [];
    }
}

export function writeStoredHosts(hosts: readonly PhoneHostEntry[], storage: StorageLike | null = defaultStorage()): void {
    try {
        if (hosts.length === 0) storage?.removeItem(PHONE_HOSTS_KEY);
        else storage?.setItem(PHONE_HOSTS_KEY, JSON.stringify(hosts));
    } catch {
        // The list still holds for this page's life.
    }
}

/**
 * What a pasted pairing URL has to be: an absolute http(s) URL. The token is read the way
 * `app/remote-daemons.ts` reads it (`?token=`), and its absence is reported rather than refused:
 * a daemon with no token (an anonymous local one) is reachable without it, and the connection
 * screen for that host says `rejected` if it was not.
 */
export function parsePairingURL(text: string): PairingURLParse {
    const trimmed = text.trim();
    if (trimmed.length === 0) return { ok: false, error: 'paste the pairing URL from Settings ▸ Remote' };
    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        return { ok: false, error: 'that is not a URL' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, error: 'a pairing URL starts with http:// or https://' };
    }
    if (parsed.hostname.length === 0) return { ok: false, error: 'that URL names no host' };
    return {
        ok: true,
        url: parsed.toString(),
        hostname: parsed.hostname,
        hasToken: tokenFromLocation(parsed.search) !== undefined
    };
}

/**
 * The name a host gets when the person typed none: the tailnet machine name
 * (`<machine>.<tailnet>.ts.net` → `machine`), or the hostname as typed, made unique against
 * the names already in the list (`mac`, `mac 2`, `mac 3`).
 */
export function suggestedHostName(hostname: string, existing: readonly string[]): string {
    const base = hostname.split('.')[0] ?? hostname;
    const stem = base.length === 0 ? 'host' : base;
    const taken = new Set(existing.map((name) => name.trim().toLowerCase()));
    if (!taken.has(stem.toLowerCase())) return stem;
    for (let n = 2; ; n += 1) {
        const candidate = `${stem} ${String(n)}`;
        if (!taken.has(candidate.toLowerCase())) return candidate;
    }
}

/**
 * The ORIGIN's name: the host this page was served from, as the tailnet names it. A loopback
 * origin (the Mac's own browser at a phone size, the audit under emulation) is "this Mac".
 */
export function originHostName(location: { readonly hostname: string } | null | undefined): string {
    const hostname = location?.hostname ?? '';
    if (hostname.length === 0 || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
        return 'this Mac';
    }
    return hostname.split('.')[0] ?? hostname;
}

function mintID(): string {
    const random = globalThis.crypto?.randomUUID?.();
    if (random !== undefined) return random;
    return `host-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface PhoneHosts {
    readonly hosts: readonly PhoneHostEntry[];
    add(name: string, url: string): PhoneHostEntry;
    remove(id: string): void;
    rename(id: string, name: string): void;
}

/** The list, live and remembered. */
export function usePhoneHosts(storage: StorageLike | null | undefined = undefined): PhoneHosts {
    const store = storage === undefined ? defaultStorage() : storage;
    const [hosts, setHosts] = useState<readonly PhoneHostEntry[]>(() => readStoredHosts(store));

    useEffect(() => {
        writeStoredHosts(hosts, store);
    }, [hosts, store]);

    const add = useCallback((name: string, url: string): PhoneHostEntry => {
        const entry: PhoneHostEntry = { id: mintID(), name: name.trim(), url };
        setHosts((current) => [...current, entry]);
        return entry;
    }, []);
    const remove = useCallback((id: string): void => {
        setHosts((current) => current.filter((entry) => entry.id !== id));
    }, []);
    const rename = useCallback((id: string, name: string): void => {
        const trimmed = name.trim();
        if (trimmed.length === 0) return;
        setHosts((current) => current.map((entry) => (entry.id === id ? { ...entry, name: trimmed } : entry)));
    }, []);

    return useMemo(() => ({ hosts, add, remove, rename }), [hosts, add, remove, rename]);
}
