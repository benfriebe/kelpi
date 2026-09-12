/**
 * The window's Settings dialog, as the SELECTED presenter for `settings.window` sees it.
 *
 * A view that declares `settings.window` can be chosen as the Settings presenter in Settings,
 * Plugins, Workbench views. The placement appears in `ui.getWorkbench().slots` for discovery, but
 * `ui.selectView` REFUSES it: Settings is where a broken presenter is recovered from, so the
 * choice stays the user's and cannot be taken programmatically.
 *
 * The presenter draws the rail and the panel INSIDE the host's dialog. The host keeps the dialog
 * frame and backdrop, modal presence, Escape and Close, the Tab trap, focus capture and release,
 * and the reopen focus rule. A presenter routes and edits; it never opens or closes the window
 * except through `closeSettings`, which is the dialog's own Close.
 *
 * The bundled panel is the recovery floor and cannot be selected away. It takes the placement back
 * for the rest of the window session when the selected presenter fails, and redraws the SAME
 * section with every draft and error intact, so a failure never loses an edit and never writes
 * one. `kelpi.window.openSettings`, `openPlugins`, `openPalette`, `openHelp` and `restartUI`, the
 * native menu and their shortcuts stay available whatever is selected.
 *
 * Native sections: some sections are drawn by the bundled panel whatever is selected. Plugins in
 * full (Versions, Restore bundled views, Retry presenter, enable and disable, providers,
 * shortcuts, plugin schema fields), Remote, Profiles, Repositories, Labels, Keybindings, Web. A
 * frame routed to one of them reports `native: true` and no fields, which is the structural
 * sibling of `prompt: null` for a password input. A partly projected section reports `native:
 * true` alongside its projected fields: the host draws the hand-built remainder below them. Every
 * projected section has such a remainder in this release (General, Workspaces and Appearance), so
 * `native: true` with a non-empty `fields` is the normal case: draw what `fields` lists and leave
 * the space below it to the host.
 *
 * Destructive actions stay native buttons the host draws, and a presenter cannot invoke them.
 *
 * Settings presenters are desktop-only in this release. A phone window keeps the bundled sheet,
 * because that sheet owns the software-keyboard inset and the two-screen push navigation, which a
 * presenter cannot read. No presenter is ever granted on a phone, so a frame you receive always
 * reports `formFactor: 'desktop'`.
 */

export type SettingsPlacement = 'settings.window';

/** One rail entry. Every section is listed, native ones included; a presenter routes, it never edits the rail. */
export interface SettingsSectionSummary {
    readonly id: string;
    readonly title: string;
    /** An SF Symbol name. The presenter supplies its own drawing. */
    readonly icon: string;
    /** The bundled panel draws this section, or the remainder of it, whatever is selected. */
    readonly native: boolean;
}

/** One card inside a section. Fields name the group they belong to. */
export interface SettingsGroupSnapshot {
    readonly id: string;
    readonly title: string;
    readonly detail?: string;
}

export interface SettingsChoice {
    readonly value: string;
    readonly label: string;
}

/** Common to every control kind. No write target, no config key, no verb, no closure. */
interface SettingsFieldBase {
    /** Stable and window-local, and deliberately NOT the config key the host writes. */
    readonly id: string;
    readonly sectionID: string;
    readonly groupID: string;
    readonly label: string;
    /** The row's caption, already a sentence. */
    readonly detail: string;
    /** The uncommitted draft as text, or absent. Drafts live in the host, keyed to the field. */
    readonly draft?: string;
    /** The last refusal for this field, already a sentence. */
    readonly error?: string;
    /** A write is dispatched and the daemon broadcast has not arrived yet. */
    readonly busy?: boolean;
    /** The host refuses writes for this field. Draw it, do not edit it. */
    readonly disabled?: boolean;
}

export interface SettingsToggleField extends SettingsFieldBase {
    readonly kind: 'toggle';
    readonly value: boolean;
}

export interface SettingsTextField extends SettingsFieldBase {
    readonly kind: 'text';
    readonly value: string;
    readonly maxLength: number;
}

export interface SettingsNumberField extends SettingsFieldBase {
    readonly kind: 'number';
    readonly value: number;
    readonly min: number;
    readonly max: number;
    readonly step?: number;
}

export interface SettingsSelectField extends SettingsFieldBase {
    readonly kind: 'select';
    readonly value: string;
    readonly choices: readonly SettingsChoice[];
}

export interface SettingsSegmentedField extends SettingsFieldBase {
    readonly kind: 'segmented';
    readonly value: string;
    readonly choices: readonly SettingsChoice[];
}

export interface SettingsSliderField extends SettingsFieldBase {
    readonly kind: 'slider';
    readonly value: number;
    readonly min: number;
    readonly max: number;
    readonly step: number;
}

export interface SettingsColorField extends SettingsFieldBase {
    readonly kind: 'color';
    /** A `#rrggbb` colour. The host's own picker stays native. */
    readonly value: string;
}

export type SettingsFieldSnapshot =
    | SettingsToggleField
    | SettingsTextField
    | SettingsNumberField
    | SettingsSelectField
    | SettingsSegmentedField
    | SettingsSliderField
    | SettingsColorField;

export interface SettingsPresenterSnapshot {
    readonly placement: SettingsPlacement;
    /**
     * Always `'desktop'` in a frame a presenter receives: presenters are desktop-only in this
     * release and a phone window never selects one. The field is stated rather than assumed so
     * the contract does not have to change when that does.
     */
    readonly formFactor: 'desktop' | 'phone';
    /** The dialog is open and this presenter is painted. False means present nothing. */
    readonly visible: boolean;
    /** Every section, in rail order, native ones included. */
    readonly sections: readonly SettingsSectionSummary[];
    /** Where the host is routed right now. */
    readonly sectionID: string;
    /**
     * The bundled panel draws this section, or the remainder below the projected fields. It is
     * true for a fully native section (`fields` is then empty) and for a partly projected one.
     */
    readonly native: boolean;
    /** The cards of the current section. Empty when the section is fully native. */
    readonly groups: readonly SettingsGroupSnapshot[];
    /** The projected fields of the current section. Empty when the section is fully native. */
    readonly fields: readonly SettingsFieldSnapshot[];
    /** Fields with an uncommitted draft, across every section. */
    readonly dirty: number;
}

/**
 * Every presenter method, on `kelpi.ui`. Each call is checked against the placement this view was
 * selected into, and every field id is re-resolved against the published projection: a field the
 * current frame did not publish, or one that is native, disabled or gone, is refused and writes
 * nothing. `reportPresenterReady` is shared with the interaction presenters.
 */
export interface WindowSettingsAPI {
    getSettingsPresentation(): Promise<SettingsPresenterSnapshot>;
    /** Initial/latest frames with bounded acknowledged delivery, as onInteraction.
     * A frame exceeding 256 KiB calls onError, or reports a view error if omitted. */
    onSettingsPresentation(
        listener: (value: SettingsPresenterSnapshot) => void | Promise<void>,
        onError?: (error: Error) => void | Promise<void>
    ): () => void;
    /** Confirms this presenter has painted. Required within 5 seconds of the first frame. A frame
     * that routes to a different section, changes the set of projected fields (a row appearing or
     * disappearing), or is the first frame after the dialog opens, must then be acknowledged
     * within 5 seconds, or the placement falls back to the bundled panel. A frame that only
     * restates the same fields (a new value, draft, error or busy flag) arms nothing. */
    reportPresenterReady(): Promise<void>;
    /** Routes the host's dialog. Refused for a section the catalog does not list. */
    setSettingsSection(id: string): Promise<void>;
    /** Holds an uncommitted value. Nothing is written until it is committed. */
    setSettingsDraft(fieldID: string, text: string): Promise<void>;
    /** Re-resolved host-side against a fresh catalog read, validated again, and dispatched once. */
    commitSettingsField(fieldID: string): Promise<void>;
    /** Drops the draft and its error. The committed value is untouched. */
    resetSettingsField(fieldID: string): Promise<void>;
    /** The dialog's own Close. There is no open: opening Settings stays a window gesture. */
    closeSettings(): Promise<void>;
}
