/**
 * What a csv pane's HEADER needs to know that the daemon's pane record does not carry (#324).
 *
 * The pane record has `isEditing` and the persisted `csvHeaderRow`; whether ⌘E's raw text is
 * available (a file over 2 MiB, a read-only file, a scan still running) is csv document state,
 * which only the pane body subscribes to. The body publishes these facts here and the header
 * reads them, so the `edit` control can be disabled with its reason while the grid is on screen
 * and nobody has to subscribe twice. A pane with no body on screen publishes nothing, and its
 * header falls back to the pane record.
 */

import { useSyncExternalStore } from 'react';

export interface CsvChromeFacts {
    readonly rawEditable: boolean;
    /** Why ⌘E is unavailable, as the control's tooltip; null when it is available. */
    readonly rawUnavailableReason: string | null;
    /** The authoritative header-row flag (`CsvPaneState.headerRow`). */
    readonly headerRow: boolean;
    readonly canUndo: boolean;
    readonly canRedo: boolean;
}

const facts = new Map<string, CsvChromeFacts>();
const listeners = new Set<() => void>();

function emit(): void {
    for (const listener of [...listeners]) listener();
}

function same(a: CsvChromeFacts | undefined, b: CsvChromeFacts): boolean {
    return (
        a !== undefined &&
        a.rawEditable === b.rawEditable &&
        a.rawUnavailableReason === b.rawUnavailableReason &&
        a.headerRow === b.headerRow &&
        a.canUndo === b.canUndo &&
        a.canRedo === b.canRedo
    );
}

export function publishCsvChromeFacts(paneID: string, next: CsvChromeFacts | null): void {
    if (next === null) {
        if (!facts.delete(paneID)) return;
        emit();
        return;
    }
    if (same(facts.get(paneID), next)) return;
    facts.set(paneID, next);
    emit();
}

export function csvChromeFacts(paneID: string): CsvChromeFacts | null {
    return facts.get(paneID) ?? null;
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** The facts for a pane, or null (pass null for a pane that is not a csv pane). */
export function useCsvChromeFacts(paneID: string | null): CsvChromeFacts | null {
    return useSyncExternalStore(
        subscribe,
        () => (paneID === null ? null : (facts.get(paneID) ?? null)),
        () => null
    );
}
