/**
 * One window, one settings surface: the single authority over routing, drafts and writes.
 *
 * Before this module those authorities were spread across the tabs. `GeneralTab` coerced a port
 * inline, `controls.tsx`'s `TextField` held a draft until blur, `ProfilesTab` kept a draft store
 * with an echo signature, and `plugins/settings.ts` kept the only real write queue - fences,
 * `inFlight`/`desired`, reconciliation against the daemon's own event. Four answers to one
 * question, and a draft living inside whatever happened to be painting it, which is exactly the
 * thing a REPLACEABLE painter cannot be trusted with: a presenter that crashes, a section change
 * or a reload must change only who draws, never what the user has typed.
 *
 * So the shape is `interaction/surface.ts`'s shape:
 *
 *   - the vocabulary is `contract.ts` and the catalog data is `sections.ts`; this is behaviour;
 *   - the presenter (or the bundled panel) sends an ID, never a key, never a closure;
 *   - every mutating call re-resolves that id against a FRESH read of the catalog, so a field that
 *     vanished, went disabled or never existed refuses the write instead of performing it;
 *   - the config is an INDIRECTION over the latest render's `WsSettingsSnapshot` and
 *     `SettingsActions`, so the surface is created once and never rebuilt when a callback changes
 *     identity (`use-interaction.ts` explains why that matters, and the settings hook mirrors it).
 *
 * What does NOT live here: any JSX, any `data-testid`, any socket. The verbs arrive as
 * `SettingsActions`, which is what assembly already binds to `set-general-setting` and
 * `set-ghostty-setting`; the daemon's allowlist is still the outer layer, and it is the one this
 * module cannot talk its way past.
 *
 * ── One write path ──────────────────────────────────────────────────────────────────
 *
 * `commitField` is the ONLY writer. General and Workspaces render from descriptors and commit
 * through it, so there is no second entry point for a control to slip a verb through and no
 * per-tab coercion left to disagree with the catalog. The two behaviours that used to live inside
 * the TCP port control are per-FIELD DATA in `sections.ts` rather than branches here:
 *
 *   `commitsUnchanged` - the row writes even when the value has not moved (the port row always
 *                        has; SET-099's "commit only if changed" is the default for everything else).
 *   `fallbackToDefault` - a draft that will not parse commits the field's shipped default (SET-020),
 *                        where every other field keeps the draft and reports why.
 *
 * The captions work the same way. A host does not hand this module a formatted sentence: it hands
 * over `SettingsTransportStatus`, three states with nowhere to put an OS bind error, and the
 * surface writes the row's copy. The raw `listen EADDRINUSE …` stays in the host's own native
 * `tcp-bind-error` row, which is not projected.
 */

import type { WsSettingsSnapshot } from '@kelpi/protocol';

import { DEFAULT_SETTINGS_TAB } from './catalog';
import {
    SETTINGS_LIMITS,
    isSettingsSectionID,
    settingsFieldDescriptor,
    validateSettingsDraft,
    validateSettingsWrite,
    type SettingsDraftValue,
    type SettingsFieldDescriptor,
    type SettingsFieldValue,
    type SettingsGroupDescriptor,
    type SettingsSectionDescriptor,
    type SettingsSectionID,
    type SettingsTransportStatus
} from './contract';
import {
    SETTINGS_FIELD_DEFINITIONS,
    SETTINGS_SECTIONS,
    describeSettingsField,
    encodeSettingsFieldValue,
    isNativeSettingsSection,
    isVisible,
    settingsFieldDefinition,
    settingsFieldsInSection,
    settingsGroupsInSection,
    settingsSectionHasNative,
    settingsTransportCaption,
    type SettingsFieldDefinition
} from './sections';
import type { SettingsActions } from './types';

/**
 * Where the routed section is stored.
 *
 * `App` keeps owning `settingsTab` (the deep links, the `initialTab` re-application and PR #181's
 * focus rule are all host-side and stay there); the surface becomes its only VALIDATOR, through
 * these two accessors. Omit the arm and the surface holds the section itself, which is what a
 * fixture or a unit test wants.
 */
export interface SettingsSectionRouting {
    get(): SettingsSectionID | null;
    set(id: SettingsSectionID): void;
}

export interface SettingsSurfaceConfig {
    /** The latest render's daemon snapshot. Identity may change every render; content is what counts. */
    settings(): WsSettingsSnapshot;
    /** The latest render's verb table. */
    actions(): SettingsActions;
    readonly section?: SettingsSectionRouting | undefined;
    /**
     * What the daemon's TCP listener actually did, for the one row whose caption depends on it.
     *
     * Flags, not prose: the host maps `welcome.transport` down to `SettingsTransportStatus` and the
     * SURFACE writes the sentence (`settingsTransportCaption`). A `(fieldID, text) => string` arm
     * would have been shorter and would also have been the hole `tcp.error`'s
     * `listen EADDRINUSE: address already in use 127.0.0.1:19400` walked through into a frame.
     *
     * `null` means the daemon has not said - an older daemon, or not connected yet - which is a
     * different sentence from "it has no listener".
     */
    readonly transport?: (() => SettingsTransportStatus | null) | undefined;
    /** Fields the host is refusing writes for. A disabled field REFUSES a commit, it does not queue one. */
    readonly disabled?: ((fieldID: string) => boolean) | undefined;
}

export interface SettingsSurfaceSnapshot {
    /** Every section, including the native ones: the rail comes from the host, never the presenter. */
    readonly sections: readonly SettingsSectionDescriptor[];
    readonly sectionID: SettingsSectionID;
    /**
     * True => the bundled panel draws this section, or the hand-built remainder of it.
     *
     * A fully native section carries `native: true` with no fields and no groups; a partly
     * projected one (Appearance) carries `native: true` BESIDE its projected fields.
     */
    readonly native: boolean;
    readonly groups: readonly SettingsGroupDescriptor[];
    /** Only for the routed section, and only when it is a fields section. */
    readonly fields: readonly SettingsFieldDescriptor[];
    /** Fields holding an uncommitted or unacknowledged draft. */
    readonly dirty: number;
}

export interface SettingsSurface {
    getSnapshot(): SettingsSurfaceSnapshot;
    subscribe(listener: () => void): () => void;
    getSection(): SettingsSectionID;
    /** Validated against the catalog: an unknown id throws and routes nowhere. */
    setSection(id: string): void;
    /** Parse-and-hold. Never writes; an invalid draft keeps the text and reports the reason. */
    setDraft(fieldID: string, raw: SettingsDraftValue): void;
    /** While a control has the caret, a daemon broadcast must not replace what is being typed. */
    setEditing(fieldID: string, editing: boolean): void;
    /**
     * Re-resolve, re-validate and dispatch AT MOST ONCE.
     *
     * `raw` is for the controls that have no draft phase (a switch, a picker, a slider); omit it
     * and the field's held draft is what commits.
     */
    commitField(fieldID: string, raw?: SettingsDraftValue): void;
    /**
     * Discard the draft and its error. It does NOT write the shipped default.
     *
     * Re-resolved against a fresh catalog read like the two writers, so an unknown, native,
     * off-screen or disabled id is refused rather than silently accepted.
     */
    resetField(fieldID: string): void;
    /** The `settings-changed` hook: reconcile drafts and pending writes against the new snapshot. */
    settingsChanged(): void;
    dispose(): void;
}

interface PendingWrite {
    inFlight: boolean;
    /** The value the dispatched write asked for, so the broadcast can be recognised. */
    value: SettingsFieldValue | null;
    /** The edit serial the dispatched write belongs to - the fence a late acknowledgement loses to. */
    edit: number;
    desired: { value: SettingsFieldValue; edit: number } | null;
    timer: ReturnType<typeof setTimeout> | null;
}

const draftText = (value: SettingsFieldValue): string =>
    typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);

export function createSettingsSurface(config: SettingsSurfaceConfig): SettingsSurface {
    const listeners = new Set<() => void>();
    const state = {
        serial: 0,
        revision: 0,
        disposed: false,
        seen: null as WsSettingsSnapshot | null,
        section: DEFAULT_SETTINGS_TAB as SettingsSectionID,
        values: new Map<string, SettingsFieldValue>(),
        drafts: new Map<string, string>(),
        errors: new Map<string, string>(),
        editing: new Set<string>(),
        /** The newest edit serial per field. A write older than this cannot clear its draft. */
        edits: new Map<string, number>(),
        writes: new Map<string, PendingWrite>()
    };
    let cachedKey: string | null = null;
    let cached: SettingsSurfaceSnapshot | null = null;

    const touch = (): void => {
        state.revision += 1;
    };
    const notify = (): void => {
        for (const listener of listeners) listener();
    };

    // ── reconciliation ──────────────────────────────────────────────────────────────

    /**
     * Fold a new snapshot in: adopt every value, settle the writes it acknowledges, and drop the
     * drafts it makes stale.
     *
     * A draft survives only while the user is in the field, while it carries an error worth
     * reading, or while its own write is still out. Anything else is a value somebody else
     * changed - another window, a hand-edit of the config file - and the daemon is the authority
     * (`controls.tsx`'s whole debounce rule is this same sentence for one control).
     */
    const reconcile = (settings: WsSettingsSnapshot): void => {
        state.seen = settings;
        for (const definition of catalog()) {
            const id = definition.id;
            const next = definition.read(settings);
            const previous = state.values.get(id);
            const changed = previous === undefined || !Object.is(previous, next);
            if (changed) {
                state.values.set(id, next);
                touch();
            }
            const write = state.writes.get(id);
            if (write !== undefined && write.inFlight && write.value !== null && Object.is(next, write.value)) {
                release(id, write);
                continue;
            }
            if (write === undefined && changed && !state.editing.has(id) && !state.errors.has(id))
                state.drafts.delete(id);
        }
    };

    /**
     * The snapshot to reason about right now, reconciling first if the host handed us a new one.
     *
     * `getSnapshot` goes through here, which is a READ and may run inside a React render, so the
     * reconciliation it performs must not send a verb: anything the release frees up is drained on
     * a microtask instead. `settingsChanged` is a host call and drains straight away.
     */
    const fresh = (): WsSettingsSnapshot => {
        const settings = config.settings();
        if (settings !== state.seen) {
            reconcile(settings);
            scheduleDrain();
        }
        return settings;
    };

    let drainScheduled = false;
    const scheduleDrain = (): void => {
        if (drainScheduled || state.disposed) return;
        if (![...state.writes.values()].some((write) => !write.inFlight && write.desired !== null)) return;
        drainScheduled = true;
        queueMicrotask(() => {
            drainScheduled = false;
            if (state.disposed) return;
            if (drain()) notify();
        });
    };

    /** Send whatever the last release freed up. One write per field, newest value only. */
    const drain = (): boolean => {
        let dispatched = false;
        for (const [id, write] of [...state.writes]) {
            if (write.inFlight || write.desired === null) continue;
            const desired = write.desired;
            dispatch(id, write, desired.value, desired.edit);
            dispatched = true;
        }
        return dispatched;
    };

    // ── the write queue (fences and `inFlight`/`desired`, from `plugins/settings.ts`) ─

    const dispatch = (id: string, write: PendingWrite, value: SettingsFieldValue, edit: number): void => {
        const definition = settingsFieldDefinition(id);
        if (definition === undefined) return;
        const encoded = encodeSettingsFieldValue(definition, value);
        const actions = config.actions();
        if (definition.target.file === 'ghostty') actions.setGhosttySetting(definition.target.key, encoded);
        else if (encoded !== null) actions.setGeneralSetting(definition.target.key, encoded);
        write.inFlight = true;
        write.value = value;
        write.edit = edit;
        // Whatever was queued behind this field is superseded: `value` IS the newest ask.
        write.desired = null;
        if (write.timer !== null) clearTimeout(write.timer);
        // Nothing acknowledges a settings verb except the broadcast that follows it, so the queue
        // stops waiting after the budget rather than pinning a field as busy for the session.
        write.timer = setTimeout(() => {
            write.timer = null;
            if (state.disposed) return;
            release(id, write);
            drain();
            notify();
        }, SETTINGS_LIMITS.writeSettleMs);
        state.writes.set(id, write);
        touch();
    };

    /**
     * The write is no longer out: either its value arrived on a broadcast, or the budget expired.
     *
     * Releasing does not send. The fence decides what may be cleared - a late acknowledgement of an
     * older edit cannot clear a newer draft - and anything queued behind it is sent by `drain`.
     */
    const release = (id: string, write: PendingWrite): void => {
        if (write.timer !== null) clearTimeout(write.timer);
        write.timer = null;
        write.inFlight = false;
        if (state.edits.get(id) === write.edit) {
            state.errors.delete(id);
            if (!state.editing.has(id)) state.drafts.delete(id);
        }
        if (write.desired === null) state.writes.delete(id);
        touch();
    };

    const queue = (id: string, value: SettingsFieldValue): void => {
        const write = state.writes.get(id) ?? { inFlight: false, value: null, edit: 0, desired: null, timer: null };
        // "At most once": asking again for the value already out (or already queued behind it) is
        // the same ask, and a presenter repeating itself must not become two config-file writes.
        if (write.inFlight && write.desired === null && Object.is(write.value, value)) return;
        if (write.desired !== null && Object.is(write.desired.value, value)) return;
        const edit = (state.serial += 1);
        state.edits.set(id, edit);
        if (write.inFlight) {
            write.desired = { value, edit };
            state.writes.set(id, write);
            touch();
            return;
        }
        dispatch(id, write, value, edit);
    };

    // ── the catalog seam ────────────────────────────────────────────────────────────

    /*
     * Reconciliation walks EVERY definition, on screen or not: the port row's value still moves
     * while the listener is switched off, and a draft that is not tracked while its row is hidden
     * is a draft that reappears stale when the row comes back.
     */
    const catalog = (): readonly SettingsFieldDefinition[] => SETTINGS_FIELD_DEFINITIONS;

    /**
     * Resolve an id the way every mutating call must: against a FRESH catalog read.
     *
     * Unknown, native-section, off-screen and disabled all THROW rather than write - the caller is
     * replaceable and the config file is not (`features/palette-source.ts`'s `execute` refuses a
     * stale target on the same grounds).
     */
    const resolve = (fieldID: string, settings: WsSettingsSnapshot): SettingsFieldDefinition => {
        const definition = settingsFieldDefinition(fieldID);
        if (definition === undefined) throw new Error(`Unknown settings field: ${fieldID}`);
        if (isNativeSettingsSection(definition.sectionID))
            throw new Error(`Settings section ${definition.sectionID} is drawn natively.`);
        if (!isVisible(definition, settings)) throw new Error(`Settings field ${fieldID} is not on screen.`);
        if (config.disabled?.(fieldID) === true)
            throw new Error(`Settings field ${fieldID} cannot be changed right now.`);
        return definition;
    };

    /** The caption for a row the catalog cannot caption on its own. Host FLAGS in, our sentence out. */
    const caption = (definition: SettingsFieldDefinition, settings: WsSettingsSnapshot): string =>
        definition.captionFrom === 'transport'
            ? settingsTransportCaption(settings, config.transport?.() ?? null)
            : definition.detail;

    const describe = (
        definition: SettingsFieldDefinition,
        settings: WsSettingsSnapshot
    ): SettingsFieldDescriptor => {
        const id = definition.id;
        const write = state.writes.get(id);
        return describeSettingsField(definition, settings, {
            detail: caption(definition, settings),
            ...(config.disabled?.(id) === true ? { disabled: true } : {}),
            ...(write?.inFlight === true ? { busy: true } : {}),
            ...(state.errors.has(id) ? { error: state.errors.get(id) } : {}),
            ...(state.drafts.has(id) ? { draft: state.drafts.get(id) } : {})
        });
    };

    // ── routing ─────────────────────────────────────────────────────────────────────

    const currentSection = (): SettingsSectionID => {
        const held = config.section?.get() ?? null;
        if (held !== null && isSettingsSectionID(held)) return held;
        return config.section === undefined ? state.section : DEFAULT_SETTINGS_TAB;
    };

    // ── the snapshot ────────────────────────────────────────────────────────────────

    const build = (settings: WsSettingsSnapshot, sectionID: SettingsSectionID): SettingsSurfaceSnapshot => {
        /*
         * Two questions, two answers, and Appearance is where they differ.
         *
         * `projected` is the WRITE question - has this section descriptors at all - and it is what
         * decides whether there are fields and cards to publish. `native` is the PAINT question:
         * true when the bundled panel draws the section, or the hand-built remainder of it, which
         * is what a presenter has to know so it leaves room rather than drawing over it.
         */
        const projected = !isNativeSettingsSection(sectionID);
        const fields = projected
            ? settingsFieldsInSection(sectionID, settings)
                  .slice(0, SETTINGS_LIMITS.fieldsPerSection)
                  // Two projections, deliberately: `describe` assembles, `settingsFieldDescriptor`
                  // copies named fields only. The second is the one that cannot be widened by
                  // accident, and it is what `redaction.test.ts` walks.
                  .map((definition) => settingsFieldDescriptor(describe(definition, settings)))
            : [];
        return Object.freeze({
            sections: SETTINGS_SECTIONS,
            sectionID,
            native: settingsSectionHasNative(sectionID),
            groups: projected ? settingsGroupsInSection(sectionID) : [],
            fields: Object.freeze(fields),
            dirty: state.drafts.size
        });
    };

    return {
        getSnapshot(): SettingsSurfaceSnapshot {
            const settings = fresh();
            const sectionID = currentSection();
            /*
             * The key covers what the frame is built from that the revision counter cannot see,
             * because both are read through `config` and neither can `touch()`: the captions (a
             * bind that failed after the last render changes a row without changing a setting) and
             * the host's disabled bits (a latched presenter disables a field, values untouched).
             */
            const host = isNativeSettingsSection(sectionID)
                ? ''
                : settingsFieldsInSection(sectionID, settings)
                      .map(
                          (definition) =>
                              `${config.disabled?.(definition.id) === true ? '!' : '.'}${caption(definition, settings)}`
                      )
                      .join('|');
            const key = `${sectionID}|${String(state.revision)}|${host}`;
            if (cached !== null && cachedKey === key) return cached;
            cached = build(settings, sectionID);
            cachedKey = key;
            return cached;
        },

        subscribe(listener: () => void): () => void {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },

        getSection(): SettingsSectionID {
            return currentSection();
        },

        setSection(id: string): void {
            if (!isSettingsSectionID(id)) throw new Error(`Unknown settings section: ${id}`);
            if (state.disposed) return;
            if (config.section === undefined) state.section = id;
            else config.section.set(id);
            touch();
            notify();
        },

        setDraft(fieldID: string, raw: SettingsDraftValue): void {
            if (state.disposed) return;
            const settings = fresh();
            const definition = resolve(fieldID, settings);
            const descriptor = describe(definition, settings);
            const text = typeof raw === 'boolean' ? draftText(raw) : raw;
            state.drafts.set(fieldID, text);
            state.edits.set(fieldID, (state.serial += 1));
            try {
                validateSettingsDraft(descriptor, raw);
                state.errors.delete(fieldID);
            } catch (error) {
                // The draft STAYS: "-", "1e" and an empty port are values on their way somewhere.
                state.errors.set(fieldID, error instanceof Error ? error.message : String(error));
            }
            touch();
            notify();
        },

        setEditing(fieldID: string, editing: boolean): void {
            if (state.disposed) return;
            if (editing) state.editing.add(fieldID);
            else state.editing.delete(fieldID);
            touch();
            notify();
        },

        commitField(fieldID: string, raw?: SettingsDraftValue): void {
            if (state.disposed) return;
            const settings = fresh();
            const definition = resolve(fieldID, settings);
            const descriptor = describe(definition, settings);
            const held = state.drafts.get(fieldID);
            const source: SettingsDraftValue | undefined = raw ?? held;
            if (source === undefined) return;
            let value: SettingsFieldValue;
            try {
                value = validateSettingsWrite(descriptor, validateSettingsDraft(descriptor, source));
            } catch (error) {
                if (definition.fallbackToDefault !== true) {
                    // Refused by a rule, not by the daemon: keep the draft, say why, send nothing.
                    state.drafts.set(fieldID, typeof source === 'boolean' ? draftText(source) : source);
                    state.errors.set(fieldID, error instanceof Error ? error.message : String(error));
                    touch();
                    notify();
                    return;
                }
                // SET-020: this row would rather write its shipped default than leave the user
                // looking at a control that did nothing. `seventy` and `0x1F90` both land here.
                value = validateSettingsWrite(descriptor, definition.default);
            }
            state.errors.delete(fieldID);
            const current = definition.read(settings);
            if (Object.is(current, value) && !state.writes.has(fieldID) && definition.commitsUnchanged !== true) {
                // SET-099's rule, generalised: committing the value the file already holds is not
                // a write. The draft has nowhere left to be, so it goes. A row that says
                // `commitsUnchanged` opts out - the TCP port always writes.
                if (!state.editing.has(fieldID)) state.drafts.delete(fieldID);
                touch();
                notify();
                return;
            }
            state.drafts.set(fieldID, draftText(value));
            queue(fieldID, value);
            notify();
        },

        resetField(fieldID: string): void {
            if (state.disposed) return;
            // Through the same door as every other mutator: unknown, native-section, off-screen and
            // disabled all THROW rather than quietly clearing state for a field the caller has no
            // business naming. Discarding a draft is a smaller act than writing one, but the id is
            // the same id and the authority over it is the same authority.
            resolve(fieldID, fresh());
            state.drafts.delete(fieldID);
            state.errors.delete(fieldID);
            state.edits.set(fieldID, (state.serial += 1));
            touch();
            notify();
        },

        settingsChanged(): void {
            if (state.disposed) return;
            reconcile(config.settings());
            // A host call, not a render: what the broadcast freed up goes out now.
            drain();
            touch();
            notify();
        },

        dispose(): void {
            state.disposed = true;
            for (const write of state.writes.values()) if (write.timer !== null) clearTimeout(write.timer);
            state.writes.clear();
            state.drafts.clear();
            state.errors.clear();
            state.editing.clear();
            listeners.clear();
        }
    };
}
