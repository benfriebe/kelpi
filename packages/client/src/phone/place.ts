/**
 * Where the phone was when it was last put down (B7, owner request 2026-09-08 after driving the
 * B1 shell on a real Android phone: "a landing page to pick a host, with local state ... the last
 * host and workspace, so a reopen lands where the person was").
 *
 * **An owner-directed divergence from the shipped Swift app**, like every phone rule in this
 * program (there is no Swift phone UI; `chrome/form-factor.ts` says so once for all of it).
 *
 * One `{host, workspaceID}` pair in `localStorage`, beside the phone's host list
 * (`kelpi.phone.hosts`) and its view mode (`kelpi.phone.view-mode`), and written through the SAME
 * storage seam as the host list, because the value NAMES a host in that list: two facts that
 * reference each other belong in one store, or a test that fakes one and not the other reads a
 * place whose host cannot exist.
 *
 * Two rules, both stated here because they are the whole of the feature:
 *
 *   1. **A remembered place means "open a workspace"; nothing remembered means "open the landing
 *      page".** That is the first-open experience the owner asked for, and it is why going BACK to
 *      the landing page clears the value (`phone/view.ts`): the landing page is a place too, so
 *      leaving the phone there and reopening it has to land there again.
 *   2. **The place decides the SCREEN, never the daemon.** For a remote host the pair is a
 *      client-local selection and restoring it moves nothing anywhere. For the origin the pair only
 *      says "the person was on the origin": the shell then shows the origin's own active workspace,
 *      whatever the daemon says that is now, and sends no `workspace-activate`. The origin's active
 *      workspace has ONE owner (the daemon) for the same reason the shown pane does
 *      (MOBILE-PLAN.md §7), and a phone that re-activated its remembered workspace on every reopen
 *      would move the Mac's sidebar under the owner's hands from a pocket.
 */

import { defaultStorage, type StorageLike } from '../app/config';

/** Where the last place is remembered. */
export const PHONE_PLACE_KEY = 'kelpi.phone.last-place';

export interface PhonePlace {
    /** A host key from `phone/model.ts`: `origin`, `configured:<name>` or `phone:<id>`. */
    readonly host: string;
    /** The workspace on screen at the time; the origin's is advisory (see the header). */
    readonly workspaceID: string;
}

export function isPhonePlace(value: unknown): value is PhonePlace {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    return typeof record['host'] === 'string' && record['host'].length > 0 && typeof record['workspaceID'] === 'string';
}

/** The remembered place, or null when nothing is remembered or the store is blocked. */
export function readStoredPlace(storage: StorageLike | null = defaultStorage()): PhonePlace | null {
    try {
        const raw = storage?.getItem(PHONE_PLACE_KEY);
        if (raw === null || raw === undefined || raw.length === 0) return null;
        const parsed: unknown = JSON.parse(raw);
        return isPhonePlace(parsed) ? { host: parsed.host, workspaceID: parsed.workspaceID } : null;
    } catch {
        return null;
    }
}

/** Remember a place, or forget it (null) - which is what "show the landing page next time" is. */
export function writeStoredPlace(place: PhonePlace | null, storage: StorageLike | null = defaultStorage()): void {
    try {
        if (place === null) storage?.removeItem(PHONE_PLACE_KEY);
        else storage?.setItem(PHONE_PLACE_KEY, JSON.stringify(place));
    } catch {
        // Convenience only; the screen still holds for this page's life.
    }
}
