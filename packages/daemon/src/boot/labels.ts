/**
 * Boot step: the one-shot legacy-label → preset back-fill.
 *
 * Spec: docs/app-state-core.md §6.5 (the gate and what it does), §6.4 (`addLabelPreset`
 * is idempotent by name), §13 note 13 ("the marker must be set on fresh installs too, or a
 * later launch resurrects deleted presets"); docs/persistence.md §6.2 step 9 (where in
 * the restore sequence it runs). Swift: `AppReducer.migrateLabelsToPresets` +
 * `PresetsFeature.applyMigratedLabels` + `LabelPresetsStorage.migratedKey`.
 *
 * Why it exists: labels predate presets. A workspace label applied before presets existed (or
 * by any writer that does not back-fill — the GUI's bulk-apply deliberately does not, §2.8)
 * has no managed preset, so it is invisible in Settings ▸ Labels, cannot be recoloured, and
 * disappears entirely once it is unapplied from its last workspace. The migration gives every
 * such label a gray preset exactly once.
 *
 * Why exactly once: a back-fill that ran on every launch would resurrect a preset the user
 * deleted while its label was still applied to some workspace — undoing their delete AND their
 * colour on the next start. The marker is therefore one-way, and (per §13) is set on a fresh
 * install too, where there is nothing to migrate but a LATER launch would otherwise treat the
 * user's brand-new labels as legacy ones.
 *
 * The Swift app keeps the marker in `UserDefaults`; a daemon has none, so it lives beside the
 * presets themselves in the `appState` table (`kelpid.labelPresetsMigrated`, see `db/codec.ts`).
 */

import type { DaemonState, LabelColor, KelpiStore } from '../store/index.js';

/** The colour every back-filled preset gets (§6.5); the user recolours it in Settings. */
export const MIGRATED_LABEL_PRESET_COLOR: LabelColor = { kind: 'named', color: 'gray' };

/**
 * Every workspace label with no preset, deduped, in first-seen order (workspace order, then
 * label order within a workspace) — the same walk `migrateLabelsToPresets` performs.
 *
 * Empty names are skipped, matching `addLabelPreset`'s own guard: a nameless preset would be
 * un-addressable (the name IS the id) and could never be removed from Settings ▸ Labels.
 */
export function collectMissingLabelPresets(state: DaemonState): readonly string[] {
    const seen = new Set(state.labelPresets.map((preset) => preset.name));
    const missing: string[] = [];
    for (const workspace of state.workspaces) {
        for (const label of workspace.labels) {
            // Names are compared verbatim, exactly as a chip matches a preset: labels are
            // trimmed/clamped when APPLIED, never lowercased, so normalizing here could mint a
            // preset whose name no longer matches the label that asked for it.
            if (label.length === 0 || seen.has(label)) continue;
            seen.add(label);
            missing.push(label);
        }
    }
    return missing;
}

export interface LabelPresetMigrationOutcome {
    /** False when the marker was already set — the walk did not run at all. */
    readonly ran: boolean;
    /** Labels that gained a preset (empty when the migration ran and found nothing to do). */
    readonly backfilled: readonly string[];
}

export interface LabelPresetMigrationDeps {
    /** Seam for tests: lets a spy prove the walk is skipped on the second boot. */
    readonly collect?: (state: DaemonState) => readonly string[];
}

/**
 * Run the migration if the marker is unset, then set the marker. Idempotent by construction:
 * a second call sees the marker and returns without walking anything.
 *
 * Order matters. The presets are added FIRST and the marker LAST, so a crash between the two
 * leaves the migration pending (it re-runs and re-adds, which is free) rather than marked-done
 * with the presets missing. Both dispatches land inside one synchronous drain of the store
 * queue, so the debounced save that follows sees the finished state, not a half-migrated one.
 */
export function runLabelPresetMigration(
    store: KelpiStore,
    deps: LabelPresetMigrationDeps = {}
): LabelPresetMigrationOutcome {
    if (store.getState().labelPresetsMigrated) return { ran: false, backfilled: [] };

    const collect = deps.collect ?? collectMissingLabelPresets;
    const backfilled = collect(store.getState());
    for (const name of backfilled) {
        // The existing reducer case, deliberately: it no-ops on a name that is already a
        // preset, so a user's chosen colour can never be overwritten by this path (§6.4).
        store.dispatch({ type: 'add-label-preset', name, color: MIGRATED_LABEL_PRESET_COLOR });
    }
    store.dispatch({ type: 'set-label-presets-migrated' });
    return { ran: true, backfilled };
}
