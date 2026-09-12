/**
 * What a SELECTED Settings presenter is told, and what it is allowed to do about it.
 *
 * The sibling of `interaction/presenter.ts`, one placement instead of two: a view selected for
 * `settings.window` draws the rail and the panel INSIDE the host's Settings dialog, and the host
 * keeps everything that makes the dialog a dialog - the frame and the backdrop, the modal presence,
 * Escape and Close, the Tab trap, the focus capture and release, PR #181's reopen rule, and the
 * native-section carve-out.
 *
 * ── What is withheld, and how ───────────────────────────────────────────────────────
 *
 *   - **Write targets.** A field id goes out and a field id comes back; the config key, the file it
 *     lives in and the verb that writes it stay in `sections.ts`, which is the only module that
 *     holds them. A leaked key would be a bypass of `WS_WRITABLE_GENERAL_KEYS`.
 *   - **Test ids.** `settingsFieldDescriptor` keeps `testID`/`rowTestID` because the BUNDLED panel
 *     draws the rows the audit reaches for; a presenter draws its own controls and has no use for
 *     another renderer's selectors, so the projection here drops both. It is also the one pair of
 *     key-shaped strings in a descriptor (`tcp-port`, `clipboard-write-toggle`), and dropping them
 *     is what lets `redaction.test.ts` check the presenter frame with no exemptions at all.
 *   - **The permanently native sections.** Plugins, Remote, Profiles, the two key recorders, the
 *     Labels colour picker and every destructive confirmation are drawn by the bundled panel
 *     whatever is selected: those sections report `native: true` with `fields: []`, which is the
 *     structural sibling of `prompt: null` for a password input. The sections are still LISTED, so
 *     a presenter can draw the rail entry that routes back to Plugins - the route to switching a
 *     presenter off must never depend on the presenter.
 *   - **Everything else by construction.** The top level of every frame is copied FIELD BY FIELD,
 *     never by spread, so a field added to the surface snapshot later cannot leak by omission; and
 *     `pluginJSON` round-trips the result, so a presenter never holds a host object at all.
 *
 * ── Two layers, independently ───────────────────────────────────────────────────────
 *
 * Every rule below is enforced here BEFORE the surface is touched, and the surface re-validates on
 * its own account (`commitField` re-resolves the id against a FRESH catalog read and runs both
 * validation funnels). The daemon's allowlist is the third. A bug in one layer is then not a hole.
 */

import { pluginJSON, type JsonObject } from '@kelpi/protocol';

import {
    SETTINGS_LIMITS,
    type SettingsChoice,
    type SettingsFieldDescriptor
} from './contract';
import type { SettingsSurface } from './surface';

/**
 * The one placement. It is a WINDOW placement (the Settings dialog), not a slot in the workbench
 * layout: `Workbench.tsx` lists it for discovery and `ui.selectView` refuses it, exactly as it
 * refuses the two interaction placements, because the choice of who draws Settings is the user's
 * and is made in Settings.
 */
export const SETTINGS_PLACEMENT = 'settings.window';
export type SettingsPlacement = typeof SETTINGS_PLACEMENT;
export const SETTINGS_PLACEMENTS: readonly SettingsPlacement[] = Object.freeze([SETTINGS_PLACEMENT]);

/**
 * The seven `ui.*` methods a granted Settings presenter may send.
 *
 * `ui.getSettingsPresentation` is a READ, answered by `getSettingsPresentation()`; the other six are
 * calls, answered by `call()`. `ui.reportPresenterReady` is shared with the interaction placements
 * verbatim - a presenter reports that it has painted in one vocabulary, whatever it presents.
 */
export const SETTINGS_UI_METHODS = [
    'ui.getSettingsPresentation',
    'ui.reportPresenterReady',
    'ui.setSettingsSection',
    'ui.setSettingsDraft',
    'ui.commitSettingsField',
    'ui.resetSettingsField',
    'ui.closeSettings'
] as const;

// ── the DTOs ────────────────────────────────────────────────────────────────────────
//
// The host's own declaration of the presenter-facing shapes. `packages/plugin-sdk/settings.d.ts`
// declares the same shapes for plugin authors, exactly as `interaction.d.ts` does, and the two are
// kept in step by the SDK's typecheck file and its feed tests.

/** One rail entry. No order field: the array IS the order. */
export interface SettingsSectionSummary {
    readonly id: string;
    readonly title: string;
    /** The SF Symbol name the bundled rail maps to a drawing; a presenter may map it or ignore it. */
    readonly icon: string;
    /** True => the bundled panel draws this section, or the remainder of it. */
    readonly native: boolean;
}

/** One card inside a projected section. `detail` is the card's hint, when it has one. */
export interface SettingsGroupSnapshot {
    readonly id: string;
    readonly title: string;
    readonly detail?: string;
}

interface SettingsFieldSnapshotBase {
    /** Window-local, and deliberately NOT the config key it writes. */
    readonly id: string;
    readonly sectionID: string;
    readonly groupID: string;
    readonly label: string;
    readonly detail: string;
    readonly disabled?: boolean;
    readonly busy?: boolean;
    readonly error?: string;
    readonly draft?: string;
}

export type SettingsFieldSnapshot = SettingsFieldSnapshotBase &
    (
        | { readonly kind: 'toggle'; readonly value: boolean }
        | { readonly kind: 'text'; readonly value: string; readonly maxLength: number }
        | {
              readonly kind: 'number';
              readonly value: number;
              readonly min: number;
              readonly max: number;
              readonly step?: number;
          }
        | { readonly kind: 'select'; readonly value: string; readonly choices: readonly SettingsChoice[] }
        | { readonly kind: 'segmented'; readonly value: string; readonly choices: readonly SettingsChoice[] }
        | {
              readonly kind: 'slider';
              readonly value: number;
              readonly min: number;
              readonly max: number;
              readonly step: number;
          }
        | { readonly kind: 'color'; readonly value: string }
    );

export interface SettingsPresenterSnapshot {
    readonly placement: SettingsPlacement;
    /** Plugin presenters are desktop-only in this release; a phone window keeps the bundled sheet. */
    readonly formFactor: 'desktop' | 'phone';
    /** The dialog is open and this presenter is painted. False means present nothing. */
    readonly visible: boolean;
    /** Every section, native ones included: the rail comes from the host, never the presenter. */
    readonly sections: readonly SettingsSectionSummary[];
    /** Where the host is routed right now. */
    readonly sectionID: string;
    /** True => the bundled panel draws this section, or the remainder of it. */
    readonly native: boolean;
    readonly groups: readonly SettingsGroupSnapshot[];
    /** The projected fields of the current section; empty when the section is fully native. */
    readonly fields: readonly SettingsFieldSnapshot[];
    /** Fields holding an uncommitted draft. */
    readonly dirty: number;
}

// ── the host model ──────────────────────────────────────────────────────────────────

export interface SettingsPresenterHost {
    readonly placement: SettingsPlacement;
    /** The current frame: frozen, `pluginJSON`-checked and bounded at 256 KiB. */
    getSettingsPresentation(): SettingsPresenterSnapshot;
    subscribe(
        listener: (value: SettingsPresenterSnapshot) => void,
        onError?: (error: Error) => void
    ): () => void;
    /** The six mutating methods. `ui.getSettingsPresentation` is read through the getter above. */
    call(method: string, args: JsonObject): void | Promise<void>;
    /** The feed's ack, so the watchdog can tell a live presenter from a wedged one. */
    noteAcknowledged(): void;
    /**
     * Re-read the host's own paint decision and republish if the frame moved. The surface's
     * subscription covers everything the surface owns; `visible` and `formFactor` are the host's,
     * and they move on a React render nothing in the surface hears about.
     */
    refresh(): void;
    dispose(): void;
}

export interface SettingsPresenterHostOptions {
    readonly surface: SettingsSurface;
    readonly placement: SettingsPlacement;
    readonly formFactor: () => 'desktop' | 'phone';
    /** The host's paint decision, read afresh on every frame. */
    readonly visible: () => boolean;
    /**
     * The dialog's own Close.
     *
     * Allowed, and the only window verb that is: it dismisses the surface the presenter is drawing
     * inside, which the Escape the host relays already does. There is no `open` - a presenter that
     * could raise the Settings window could raise it over anything.
     */
    readonly close: () => void;
    /** A presenter that cannot be trusted with the surface any more (a runaway call loop). */
    readonly fail: (detail: string) => void;
    /**
     * A frame left for the presenter. `awaitsAcknowledgement` marks a frame the user is waiting to
     * see redrawn - the first painted one, a move to a different section, or a section whose set of
     * fields has changed shape - which are the frames whose acknowledgement the watchdog waits for.
     */
    readonly onFrame?: ((awaitsAcknowledgement: boolean) => void) | undefined;
    readonly onAcknowledged?: (() => void) | undefined;
    readonly onReady?: (() => void) | undefined;
}

/** Declared keys per call, so an unknown or missing argument is refused before anything runs. */
const CALL_ARGUMENTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
    'ui.reportPresenterReady': [],
    'ui.setSettingsSection': ['id'],
    'ui.setSettingsDraft': ['fieldID', 'text'],
    'ui.commitSettingsField': ['fieldID'],
    'ui.resetSettingsField': ['fieldID'],
    'ui.closeSettings': []
});

const PLACEMENT_METHODS: Readonly<Record<SettingsPlacement, readonly string[]>> = Object.freeze({
    'settings.window': [...SETTINGS_UI_METHODS]
});

function freeze<T>(value: T): T {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    return value;
}

/**
 * One descriptor, projected.
 *
 * Field by field, and NOT a spread of the descriptor: `settingsFieldDescriptor` already copies
 * named fields, and this is the second copy that drops the two a presenter must not be handed
 * (`testID`, `rowTestID`) and the three the bundled panel formats for itself (`default`,
 * `placeholder`, `valueLabel`). A field added to a descriptor has to be a deliberate line here.
 */
function fieldSnapshot(field: SettingsFieldDescriptor): SettingsFieldSnapshot {
    const base = {
        id: field.id,
        sectionID: field.sectionID,
        groupID: field.groupID,
        label: field.label,
        detail: field.detail,
        ...(field.disabled === undefined ? {} : { disabled: field.disabled }),
        ...(field.busy === undefined ? {} : { busy: field.busy }),
        ...(field.error === undefined ? {} : { error: field.error }),
        ...(field.draft === undefined ? {} : { draft: field.draft })
    };
    switch (field.kind) {
        case 'toggle':
            return { ...base, kind: 'toggle', value: field.value };
        case 'text':
            return { ...base, kind: 'text', value: field.value, maxLength: field.maxLength };
        case 'number':
            return {
                ...base,
                kind: 'number',
                value: field.value,
                min: field.min,
                max: field.max,
                ...(field.step === undefined ? {} : { step: field.step })
            };
        case 'select':
        case 'segmented':
            return {
                ...base,
                kind: field.kind,
                value: field.value,
                choices: field.choices.map((choice: SettingsChoice) => ({
                    value: choice.value,
                    label: choice.label
                }))
            };
        case 'slider':
            return {
                ...base,
                kind: 'slider',
                value: field.value,
                min: field.min,
                max: field.max,
                step: field.step
            };
        default:
            return { ...base, kind: 'color', value: field.value };
    }
}

// ── the window's failure latch ──────────────────────────────────────────────────────
//
// A module-level store rather than a context or component state, for the reason
// `interaction/presenter.ts` gives: the two readers are in different trees. The slot that mounts a
// presenter is inside the Settings dialog, and the row that reports the failure and offers Retry is
// inside the Plugins tab of that same dialog - which the presenter is not drawing, because Plugins
// is permanently native. One store per page is one store per window.

/** Which generation failed, and why. `generation` is `viewID:revision:instanceID`. */
export interface SettingsPresenterFailure {
    readonly generation: string;
    readonly detail: string;
}

type Failures = Readonly<Partial<Record<SettingsPlacement, SettingsPresenterFailure>>>;

let failures: Failures = Object.freeze({});
const failureListeners = new Set<() => void>();

function publishFailures(next: Failures): void {
    failures = Object.freeze(next);
    for (const listener of [...failureListeners]) listener();
}

/** Stable between changes, so a `useSyncExternalStore` reader cannot spin on it. */
export function settingsPresenterFailures(): Failures {
    return failures;
}

export function noteSettingsPresenterFailure(
    placement: SettingsPlacement,
    generation: string,
    detail: string
): void {
    const current = failures[placement];
    if (current?.generation === generation) return;
    publishFailures({ ...failures, [placement]: Object.freeze({ generation, detail }) });
}

/** The explicit Retry, and the reload/rollback/selection paths that supersede a latch. */
export function clearSettingsPresenterFailure(placement: SettingsPlacement): void {
    if (failures[placement] === undefined) return;
    const next: Record<string, SettingsPresenterFailure> = { ...failures };
    delete next[placement];
    publishFailures(next);
}

export function subscribeSettingsPresenters(listener: () => void): () => void {
    failureListeners.add(listener);
    return () => {
        failureListeners.delete(listener);
    };
}

/** Test seam: one page is one window, so a suite has to be able to start from a clean one. */
export function resetSettingsPresenterFailures(): void {
    publishFailures({});
}

export function createSettingsPresenterHost(
    options: SettingsPresenterHostOptions
): SettingsPresenterHost {
    const { surface, placement } = options;
    type Delivery = { value: SettingsPresenterSnapshot } | { error: Error };
    type Entry = {
        listener: (value: SettingsPresenterSnapshot) => void;
        onError?: (error: Error) => void;
    };

    const listeners = new Set<Entry>();
    const calls: number[] = [];
    let disposed = false;
    let queued = false;
    let lastKey: string | undefined;
    let delivered: { key: string | null; visible: boolean } = { key: null, visible: false };

    /** Field by field, every arm, so nothing new can ride along unnoticed. */
    const project = (): SettingsPresenterSnapshot => {
        const snapshot = surface.getSnapshot();
        return {
            placement,
            formFactor: options.formFactor(),
            visible: options.visible(),
            sections: snapshot.sections.map((section) => ({
                id: section.id,
                title: section.title,
                icon: section.icon,
                // The PAINT question, section by section: a fully native section, and a projected
                // one whose hand-built remainder the host draws below the frame, both answer yes.
                native: section.kind !== 'fields' || section.remainder === true
            })),
            sectionID: snapshot.sectionID,
            native: snapshot.native,
            groups: snapshot.groups.map((group) => ({
                id: group.id,
                title: group.title,
                ...(group.hint === null ? {} : { detail: group.hint })
            })),
            fields: snapshot.fields.map(fieldSnapshot),
            dirty: snapshot.dirty
        };
    };

    const read = (): Delivery => {
        try {
            const value = (
                pluginJSON({
                    type: 'settings',
                    sequence: Number.MAX_SAFE_INTEGER,
                    value: project()
                }) as unknown as { value: SettingsPresenterSnapshot }
            ).value;
            return { value: freeze(value) };
        } catch {
            return { error: new Error('Window settings snapshot is invalid or exceeds 256 KiB.') };
        }
    };

    const key = (next: Delivery): string =>
        'value' in next ? JSON.stringify(next.value) : `error:${next.error.message}`;

    const deliver = (entry: Entry, next: Delivery): void => {
        try {
            if ('value' in next) entry.listener(next.value);
            else entry.onError?.(next.error);
        } catch {
            /* A failed consumer cannot stop another listener, or the watchdog, seeing this frame. */
        }
    };

    const note = (next: Delivery): void => {
        if (!('value' in next)) {
            /*
             * An undeliverable frame is not something a watchdog can save: the SDK acknowledges an
             * error exactly as it acknowledges a frame, so arming the acknowledgement timer here
             * would be cleared by the presenter's own ack while the dialog sat empty. So the
             * placement fails NOW, which is what hands the dialog back to the bundled panel with
             * every draft still in the surface.
             */
            if (options.visible()) options.fail(next.error.message);
            else options.onFrame?.(false);
            return;
        }
        /*
         * What the user is WAITING to see redrawn, as one identity: the routed section, and the set
         * of fields in it. The section covers a move along the rail; the field set covers a frame
         * whose SHAPE moved without it - the port row appearing when the TCP listener goes on, the
         * three graph rows appearing when system stats do. A value changing inside an unchanged set
         * is not that: it is a broadcast catching a control up, and holding a presenter to a 5 s
         * deadline for one would fail a working presenter for being idle.
         *
         * The ids only, joined: cheap next to the JSON the frame is already serialised to for the
         * change check, and it is the SHAPE that a presenter has to repaint.
         */
        const key = next.value.visible
            ? `${next.value.sectionID}|${next.value.fields.map((field) => field.id).join(',')}`
            : null;
        const awaits = key !== null && (key !== delivered.key || !delivered.visible);
        delivered = { key, visible: next.value.visible };
        options.onFrame?.(awaits);
    };

    const update = (): void => {
        if (disposed || queued || listeners.size === 0) return;
        queued = true;
        queueMicrotask(() => {
            queued = false;
            if (disposed || listeners.size === 0) return;
            const next = read();
            const nextKey = key(next);
            if (nextKey === lastKey) return;
            lastKey = nextKey;
            for (const entry of [...listeners]) deliver(entry, next);
            note(next);
        });
    };

    const unsubscribeSurface = surface.subscribe(update);

    /**
     * 240 calls per rolling second, the interaction budget verbatim. A breach FAILS the presenter as
     * well as rejecting the call: a call loop is not a recoverable error, and the bundled panel has
     * to be able to take the dialog back from it.
     */
    const charge = (): void => {
        const now = Date.now();
        while (calls.length > 0 && now - calls[0]! >= SETTINGS_LIMITS.presenterCallWindowMs) calls.shift();
        calls.push(now);
        if (calls.length <= SETTINGS_LIMITS.presenterCalls) return;
        const message = 'This presenter exceeded its window settings call budget.';
        options.fail(message);
        throw new Error(message);
    };

    /**
     * A mutating call is only meaningful while this presenter is actually drawing the dialog.
     *
     * A frame that says `visible: false` is "present nothing": the dialog is closed, or the bundled
     * panel has the section. A write arriving then is a presenter acting on a window the user is not
     * looking at, so it is refused here rather than re-validated further down.
     */
    const painted = (): SettingsPresenterSnapshot => {
        const current = project();
        if (!current.visible) throw new Error('The Settings window is not presented right now.');
        return current;
    };

    /** A field the CURRENT frame published, and one the host is not refusing writes for. */
    const field = (value: unknown, current: SettingsPresenterSnapshot): string => {
        if (typeof value !== 'string' || value.length > 160)
            throw new Error('That settings field is not in the current section.');
        const found = current.fields.find((one) => one.id === value);
        // Unknown, native-section, off-screen and another section's all land here: the frame only
        // ever carries the routed section's visible fields.
        if (found === undefined) throw new Error('That settings field is not in the current section.');
        if (found.disabled === true) throw new Error('That settings field cannot be changed right now.');
        return value;
    };

    return {
        placement,
        getSettingsPresentation() {
            if (disposed) throw new Error('Settings presentation is unavailable after disposal.');
            charge();
            const next = read();
            if ('error' in next) throw next.error;
            return next.value;
        },
        subscribe(listener, onError) {
            if (disposed) throw new Error('Settings presentation is unavailable after disposal.');
            const entry: Entry = { listener, ...(onError ? { onError } : {}) };
            listeners.add(entry);
            const next = read();
            if (listeners.size === 1) lastKey = key(next);
            deliver(entry, next);
            note(next);
            return () => {
                listeners.delete(entry);
            };
        },
        call(method, args) {
            const keys = CALL_ARGUMENTS[method];
            if (keys === undefined) throw new Error('Unknown window settings method.');
            if (
                args === null ||
                typeof args !== 'object' ||
                Array.isArray(args) ||
                Object.keys(args).length !== keys.length ||
                keys.some((name) => !(name in args))
            )
                throw new Error('Invalid settings arguments.');
            if (new TextEncoder().encode(JSON.stringify(args)).length > SETTINGS_LIMITS.payloadBytes)
                throw new Error('Settings arguments exceed 256 KiB.');
            if (!PLACEMENT_METHODS[placement].includes(method))
                throw new Error('This method belongs to another placement.');
            if (disposed) throw new Error('Settings presentation is unavailable after disposal.');
            charge();

            if (method === 'ui.reportPresenterReady') {
                options.onReady?.();
                return;
            }
            if (method === 'ui.closeSettings') {
                painted();
                options.close();
                return;
            }
            if (method === 'ui.setSettingsSection') {
                const current = painted();
                const id = args['id'];
                // Against the PUBLISHED rail, native sections included: routing to Plugins is how a
                // user reaches the row that switches the presenter off, so it cannot be refused.
                if (typeof id !== 'string' || !current.sections.some((section) => section.id === id))
                    throw new Error('That settings section does not exist.');
                // `surface.setSection` validates the id against the catalog on its own account.
                surface.setSection(id);
                return;
            }
            if (method === 'ui.setSettingsDraft') {
                const current = painted();
                const fieldID = field(args['fieldID'], current);
                const text = args['text'];
                if (typeof text !== 'string' || text.length > SETTINGS_LIMITS.valueChars)
                    throw new Error(
                        `A settings draft must be a string of at most ${String(SETTINGS_LIMITS.valueChars)} characters.`
                    );
                // Parse-and-hold. An invalid draft keeps the text and reports the reason; nothing
                // is written, here or anywhere, until a commit asks for it.
                surface.setDraft(fieldID, text);
                return;
            }
            if (method === 'ui.commitSettingsField') {
                const current = painted();
                // `surface.commitField` is the authority: a FRESH catalog read, both validation
                // funnels, and one dispatch at most.
                surface.commitField(field(args['fieldID'], current));
                return;
            }
            const current = painted();
            surface.resetField(field(args['fieldID'], current));
            return;
        },
        noteAcknowledged() {
            if (disposed) return;
            options.onAcknowledged?.();
        },
        refresh: update,
        dispose() {
            if (disposed) return;
            disposed = true;
            unsubscribeSurface();
            listeners.clear();
        }
    };
}
