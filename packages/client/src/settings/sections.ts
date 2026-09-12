/**
 * The Settings catalog as DATA: every section, and every field of the two sections that are a
 * list of fields.
 *
 * Two things live here and nowhere else:
 *
 *   1. **The field table.** One entry per control, carrying its label, its caption, its
 *      constraints, its existing `data-testid` and how to READ its value out of the daemon's
 *      snapshot. Phase 1 covers General and Workspaces, which are the two value-and-verb tabs
 *      (`WorkspacesTab.tsx` has no local state at all, and `GeneralTab.tsx` has one coercion).
 *      Appearance and the six hand-built tabs are `kind: 'native'`: described, so the rail and the
 *      routing are complete, never projected.
 *   2. **The write target, privately.** `target` names the config file and the key, and it is the
 *      one field `settingsFieldDescriptor` does not copy. A presenter sends a field id; the surface
 *      does the mapping. A leaked key would be a bypass of `WS_WRITABLE_GENERAL_KEYS`, so the
 *      targets are typed against that allowlist and `sections.test.ts` asserts every one of them is
 *      in it - the sibling of `catalog.test.ts` asserting the action table covers `KELPI_ACTIONS`
 *      exactly once.
 *
 * The copy is the tabs' copy, verbatim: same labels, same captions, same order, same test ids. A
 * descriptor that reworded a row would be a fidelity regression wearing a refactor's clothes.
 */

import type { WsSettingsSnapshot, WsWritableGeneralKey, WsWritableGhosttyKey } from '@kelpi/protocol';

import { SETTINGS_TABS } from './catalog';
import {
    settingsGroupDescriptor,
    settingsSectionDescriptor,
    type SettingsChoice,
    type SettingsFieldDescriptor,
    type SettingsFieldValue,
    type SettingsGroupDescriptor,
    type SettingsSectionDescriptor,
    type SettingsSectionID,
    type SettingsTransportStatus
} from './contract';

// ── the two sections that are a list of fields ──────────────────────────────────────

const FIELD_SECTIONS: readonly SettingsSectionID[] = ['general', 'workspaces'];

export const SETTINGS_SECTIONS: readonly SettingsSectionDescriptor[] = Object.freeze(
    SETTINGS_TABS.map((tab, order) =>
        settingsSectionDescriptor({
            id: tab.id,
            title: tab.label,
            icon: tab.icon,
            order,
            kind: FIELD_SECTIONS.includes(tab.id) ? 'fields' : 'native'
        })
    )
);

export function settingsSection(id: SettingsSectionID): SettingsSectionDescriptor | undefined {
    return SETTINGS_SECTIONS.find((section) => section.id === id);
}

export function isNativeSettingsSection(id: SettingsSectionID): boolean {
    return settingsSection(id)?.kind !== 'fields';
}

// ── the cards ───────────────────────────────────────────────────────────────────────

export const SETTINGS_GROUPS: readonly SettingsGroupDescriptor[] = Object.freeze(
    (
        [
            {
                id: 'general-worktrees',
                sectionID: 'general',
                title: 'Worktrees',
                hint: "Worktrees are created at <base path>/<name>. Use <repo> in the base path to substitute the repository: at the start it resolves to the full repo path (e.g. <repo>/.claude/worktrees), elsewhere it resolves to the repository's directory name (e.g. ~/kelpi/worktrees/<repo>).",
                testID: 'general-worktrees'
            },
            {
                id: 'general-repositories',
                sectionID: 'general',
                title: 'Repositories',
                hint: null,
                testID: 'general-repositories'
            },
            {
                id: 'general-workspaces',
                sectionID: 'general',
                title: 'Workspaces',
                hint: null,
                testID: 'general-workspaces'
            },
            {
                id: 'general-network',
                sectionID: 'general',
                title: 'Network',
                hint: "The control socket's optional TCP listener on 127.0.0.1, for dev containers and SSH tunnels. A change here re-binds the listener straight away; the Unix socket and its clients are unaffected.",
                testID: 'general-network'
            },
            {
                id: 'workspaces-section',
                sectionID: 'workspaces',
                title: 'Workspaces',
                hint: null,
                testID: 'workspaces-section'
            },
            {
                id: 'panes-section',
                sectionID: 'workspaces',
                title: 'Panes',
                hint: null,
                testID: 'panes-section'
            }
        ] satisfies readonly SettingsGroupDescriptor[]
    ).map(settingsGroupDescriptor)
);

export function settingsGroupsInSection(sectionID: SettingsSectionID): readonly SettingsGroupDescriptor[] {
    return SETTINGS_GROUPS.filter((group) => group.sectionID === sectionID);
}

// ── the write targets (private: never copied into a descriptor) ─────────────────────

/**
 * Where a field's value is written.
 *
 * Typed against the protocol's two allowlists rather than as a bare string, so a field pointed at
 * a key the daemon refuses does not compile - and `sections.test.ts` asserts the same thing at
 * runtime, because a cast would otherwise be enough to get past the type.
 */
export type SettingsWriteTarget =
    | { readonly file: 'kelpi'; readonly key: WsWritableGeneralKey }
    | { readonly file: 'ghostty'; readonly key: WsWritableGhosttyKey };

// ── the field table ─────────────────────────────────────────────────────────────────

interface DefinitionBase {
    readonly id: string;
    readonly sectionID: SettingsSectionID;
    readonly groupID: string;
    readonly label: string;
    readonly detail: string;
    readonly testID: string;
    readonly rowTestID?: string | undefined;
    /** PRIVATE. The surface reads it; `settingsFieldDescriptor` does not copy it. */
    readonly target: SettingsWriteTarget;
    /**
     * Whether the row is on screen at all under the given settings (the port field appears only
     * while the listener is on, the focus delay only while focus-follows-mouse is on).
     *
     * A hidden field is not projected and cannot be committed: `commitField` re-reads this against
     * a FRESH snapshot, so a row that vanished while a presenter held its id refuses the write
     * rather than writing to a control the user can no longer see.
     */
    readonly visible?: ((settings: WsSettingsSnapshot) => boolean) | undefined;
    /**
     * This row writes even when the value has not changed.
     *
     * The default is SET-099's rule - committing the value the file already holds is not a write -
     * but the TCP port row has always written unconditionally, and two `GeneralTab` tests encode
     * that: junk input falls back to the default port, and when the live port already IS that
     * default the write still has to go out. A control whose Apply visibly does nothing is worse
     * than one redundant line rewritten in the config file.
     */
    readonly commitsUnchanged?: boolean | undefined;
    /**
     * A draft that will not parse commits the field's shipped DEFAULT rather than being kept.
     *
     * SET-020, the same row: `Number.parseInt('seventy', 10)` is NaN and the shipped tab wrote
     * `DEFAULT_TCP_PORT` rather than a value the config parser would silently ignore. Every other
     * field keeps the draft and reports the reason instead.
     */
    readonly fallbackToDefault?: boolean | undefined;
    /**
     * The caption is composed by the surface from host status rather than read from `detail`.
     *
     * `transport` is the only source: what the daemon's listener actually did. The raw bind error
     * cannot travel with it, because `SettingsTransportStatus` has nowhere to put one.
     */
    readonly captionFrom?: 'transport' | undefined;
}

type ToggleDefinition = DefinitionBase & {
    readonly kind: 'toggle';
    readonly default: boolean;
    read(settings: WsSettingsSnapshot): boolean;
    encode(value: boolean): string | null;
};

type TextDefinition = DefinitionBase & {
    readonly kind: 'text';
    readonly default: string;
    readonly placeholder?: string | undefined;
    readonly maxLength: number;
    read(settings: WsSettingsSnapshot): string;
    encode(value: string): string | null;
};

type NumberDefinition = DefinitionBase & {
    readonly kind: 'number';
    readonly default: number;
    readonly min: number;
    readonly max: number;
    readonly step?: number | undefined;
    read(settings: WsSettingsSnapshot): number;
    encode(value: number): string | null;
};

type ChoiceDefinition = DefinitionBase & {
    readonly kind: 'select' | 'segmented';
    readonly default: string;
    readonly choices: readonly SettingsChoice[];
    read(settings: WsSettingsSnapshot): string;
    encode(value: string): string | null;
};

type SliderDefinition = DefinitionBase & {
    readonly kind: 'slider';
    readonly default: number;
    readonly min: number;
    readonly max: number;
    readonly step: number;
    readonly format: (value: number) => string;
    read(settings: WsSettingsSnapshot): number;
    encode(value: number): string | null;
};

type ColorDefinition = DefinitionBase & {
    readonly kind: 'color';
    readonly default: string;
    read(settings: WsSettingsSnapshot): string;
    encode(value: string): string | null;
};

export type SettingsFieldDefinition =
    | ToggleDefinition
    | TextDefinition
    | NumberDefinition
    | ChoiceDefinition
    | SliderDefinition
    | ColorDefinition;

const BOOLEAN = (value: boolean): string => (value ? 'true' : 'false');

/**
 * The port the Network toggle seeds when it is switched on (SET-019).
 *
 * The same number `GeneralTab.tsx` exports as `DEFAULT_TCP_PORT`, restated here so this module
 * stays free of React; `sections.test.ts` asserts the two cannot drift.
 */
export const SETTINGS_DEFAULT_TCP_PORT = 19400;

/** §10's slider range, the same numbers `WorkspacesTab.tsx` exports. Asserted in the tests. */
export const SETTINGS_FOCUS_DELAY_STEP = 25;
export const SETTINGS_FOCUS_DELAY_MAX = 500;

const PLACEMENT_CHOICES: readonly SettingsChoice[] = Object.freeze([
    Object.freeze({ value: 'near-selection', label: 'Next to selection' }),
    Object.freeze({ value: 'end-of-list', label: 'End of list' })
]);

/**
 * Every field, in the order its tab renders it.
 *
 * Ids are window-local and deliberately NOT the config keys beside them: the key is the thing a
 * presenter must never learn, and an id that WAS the key would hand it over by spelling.
 */
export const SETTINGS_FIELD_DEFINITIONS: readonly SettingsFieldDefinition[] = Object.freeze([
    // ── General ─────────────────────────────────────────────────────────────────────
    {
        id: 'general.worktreeBasePath',
        sectionID: 'general',
        groupID: 'general-worktrees',
        kind: 'text',
        label: 'Base path',
        detail: '',
        testID: 'worktree-base-path',
        target: { file: 'kelpi', key: 'worktree-base-path' },
        default: '~/kelpi/worktrees/<repo>',
        placeholder: '~/kelpi/worktrees/<repo>',
        maxLength: 1024,
        read: (settings) => settings.general.worktreeBasePath,
        // A blank field means "the default"; the parser treats an empty value that way too, so
        // the two ends agree without a special case here (`GeneralTab.tsx`'s comment, verbatim).
        encode: (value) => value.trim()
    },
    {
        id: 'general.autoDetectRepos',
        sectionID: 'general',
        groupID: 'general-repositories',
        kind: 'toggle',
        label: 'Auto-detect from pane directories',
        detail: "When a pane's working directory is inside a Git repository, associate that repo (or worktree) with the workspace. Removed a few seconds after no pane remains in it; manually added repos are never auto-removed.",
        testID: 'auto-detect-repos-toggle',
        rowTestID: 'auto-detect-repos-row',
        target: { file: 'kelpi', key: 'auto-detect-repos' },
        default: true,
        read: (settings) => settings.general.autoDetectRepos,
        encode: BOOLEAN
    },
    {
        id: 'general.inheritGroupOnNewWorkspace',
        sectionID: 'general',
        groupID: 'general-workspaces',
        kind: 'toggle',
        label: 'Inherit group when creating a new workspace',
        detail: 'When the active workspace belongs to a group, new workspaces are created inside that same group. Disable to always create at the top level.',
        testID: 'inherit-group-toggle',
        rowTestID: 'inherit-group-row',
        target: { file: 'kelpi', key: 'inherit-group-on-new-workspace' },
        default: true,
        read: (settings) => settings.general.inheritGroupOnNewWorkspace,
        encode: BOOLEAN
    },
    {
        id: 'general.newWorkspacePlacement',
        sectionID: 'general',
        groupID: 'general-workspaces',
        kind: 'select',
        label: 'New workspace placement',
        detail: "Where a newly created workspace is inserted. “Next to selection” places it immediately after the active workspace's slot; “End of list” always appends.",
        testID: 'new-workspace-placement',
        target: { file: 'kelpi', key: 'new-workspace-placement' },
        default: 'end-of-list',
        choices: PLACEMENT_CHOICES,
        read: (settings) => settings.general.newWorkspacePlacement,
        encode: (value) => value
    },
    {
        id: 'general.newGroupPlacement',
        sectionID: 'general',
        groupID: 'general-workspaces',
        kind: 'select',
        label: 'New group placement',
        detail: 'The same choice for a newly created group.',
        testID: 'new-group-placement',
        target: { file: 'kelpi', key: 'new-group-placement' },
        default: 'end-of-list',
        choices: PLACEMENT_CHOICES,
        read: (settings) => settings.general.newGroupPlacement,
        encode: (value) => value
    },
    {
        /*
         * The one derived row in the table: the switch reports whether a port is configured and
         * writes the same key the port field writes, seeding SET-019's default when it goes on
         * and 0 when it goes off. Its caption is the only one the snapshot cannot supply on its
         * own (`welcome.transport` says what the listener actually DID), which is what the
         * surface's `detail` indirection is for.
         */
        id: 'general.tcpListener',
        sectionID: 'general',
        groupID: 'general-network',
        kind: 'toggle',
        label: 'TCP listener',
        detail: 'Disabled - the Unix control socket is the only transport.',
        testID: 'tcp-listener-toggle',
        rowTestID: 'tcp-listener-row',
        target: { file: 'kelpi', key: 'tcp-port' },
        captionFrom: 'transport',
        default: false,
        read: (settings) => settings.general.tcpPort > 0,
        encode: (value) => (value ? String(SETTINGS_DEFAULT_TCP_PORT) : '0')
    },
    {
        id: 'general.tcpPort',
        sectionID: 'general',
        groupID: 'general-network',
        kind: 'number',
        label: 'Port',
        detail: '',
        testID: 'tcp-port',
        target: { file: 'kelpi', key: 'tcp-port' },
        default: SETTINGS_DEFAULT_TCP_PORT,
        min: 1,
        max: 65535,
        step: 1,
        // SET-020's two rules, as data rather than as a coercion inside a control: junk commits
        // the default port, and the write goes out even when the value has not moved.
        commitsUnchanged: true,
        fallbackToDefault: true,
        visible: (settings) => settings.general.tcpPort > 0,
        read: (settings) => settings.general.tcpPort,
        encode: (value) => String(Math.trunc(value))
    },

    // ── Workspaces ──────────────────────────────────────────────────────────────────
    {
        id: 'workspaces.confirmWorkspaceDelete',
        sectionID: 'workspaces',
        groupID: 'workspaces-section',
        kind: 'toggle',
        label: 'Confirm before deleting a workspace with active agents',
        detail: 'Applies to this window and every other client. kelpi workspace delete --force bypasses it regardless.',
        testID: 'confirm-delete-toggle',
        rowTestID: 'confirm-delete-row',
        target: { file: 'kelpi', key: 'confirm-workspace-delete' },
        default: true,
        read: (settings) => settings.general.confirmWorkspaceDeleteWhenActive,
        encode: BOOLEAN
    },
    {
        id: 'workspaces.expandGroupOnDrop',
        sectionID: 'workspaces',
        groupID: 'workspaces-section',
        kind: 'toggle',
        label: 'Expand group when a workspace is dropped into it',
        detail: 'Dropping a workspace onto a collapsed group opens the group so you can see where the row landed. Off leaves it collapsed.',
        testID: 'expand-group-on-drop-toggle',
        rowTestID: 'expand-group-on-drop-row',
        target: { file: 'kelpi', key: 'expand-group-on-workspace-drop' },
        default: true,
        read: (settings) => settings.general.expandGroupOnWorkspaceDrop,
        encode: BOOLEAN
    },
    {
        id: 'workspaces.confirmQuit',
        sectionID: 'workspaces',
        groupID: 'workspaces-section',
        kind: 'toggle',
        label: 'Confirm before quitting with active agents',
        detail: "Desktop app only: ⌘Q asks first while agents are running. The dialog's “Don't ask again” checkbox writes this same setting.",
        testID: 'confirm-quit-toggle',
        rowTestID: 'confirm-quit-row',
        target: { file: 'kelpi', key: 'confirm-quit-when-active' },
        default: true,
        read: (settings) => settings.general.confirmQuitWhenActive,
        encode: BOOLEAN
    },
    {
        id: 'workspaces.focusFollowsMouse',
        sectionID: 'workspaces',
        groupID: 'panes-section',
        kind: 'toggle',
        label: 'Focus follows mouse',
        detail: 'Hovering a pane focuses it after the delay below.',
        testID: 'focus-follows-mouse-toggle',
        rowTestID: 'focus-follows-mouse-row',
        target: { file: 'kelpi', key: 'focus-follows-mouse' },
        default: false,
        read: (settings) => settings.general.focusFollowsMouse,
        encode: BOOLEAN
    },
    {
        id: 'workspaces.focusDelay',
        sectionID: 'workspaces',
        groupID: 'panes-section',
        kind: 'slider',
        label: 'Focus delay',
        detail: 'Moving across several panes within the delay focuses only the last one.',
        testID: 'focus-delay-slider',
        rowTestID: 'focus-delay-row',
        target: { file: 'kelpi', key: 'focus-follows-mouse-delay' },
        default: 100,
        min: 0,
        max: SETTINGS_FOCUS_DELAY_MAX,
        step: SETTINGS_FOCUS_DELAY_STEP,
        format: (value) => `${String(value)} ms`,
        visible: (settings) => settings.general.focusFollowsMouse,
        // The track is clamped the way the tab clamps it; the READOUT is the raw value, which is
        // what `focus-delay-value` has always shown (a hand-edited 900 ms reads as 900 ms).
        read: (settings) => settings.general.focusFollowsMouseDelay,
        encode: (value) => String(Math.trunc(value))
    },
    {
        id: 'workspaces.clipboardWrite',
        sectionID: 'workspaces',
        groupID: 'panes-section',
        kind: 'toggle',
        label: 'Let programs write the clipboard',
        detail: 'A program in a terminal pane can put text on your clipboard with OSC 52 - how tmux, vim and remote shells copy. Off by default. Programs can never READ your clipboard: Kelpi refuses those requests whatever this is set to.',
        testID: 'clipboard-write-toggle',
        rowTestID: 'clipboard-write-row',
        target: { file: 'kelpi', key: 'clipboard-write' },
        default: false,
        read: (settings) => settings.general.clipboardWrite,
        encode: BOOLEAN
    }
] satisfies readonly SettingsFieldDefinition[]);

const BY_ID: ReadonlyMap<string, SettingsFieldDefinition> = new Map(
    SETTINGS_FIELD_DEFINITIONS.map((definition) => [definition.id, definition])
);

/** The definition for a field id, or undefined. Host-only: it carries the write target. */
export function settingsFieldDefinition(id: string): SettingsFieldDefinition | undefined {
    return BY_ID.get(id);
}

/** The fields of one section that are on screen under these settings, in table order. */
export function settingsFieldsInSection(
    sectionID: SettingsSectionID,
    settings: WsSettingsSnapshot
): readonly SettingsFieldDefinition[] {
    return SETTINGS_FIELD_DEFINITIONS.filter(
        (definition) => definition.sectionID === sectionID && isVisible(definition, settings)
    );
}

export function isVisible(definition: SettingsFieldDefinition, settings: WsSettingsSnapshot): boolean {
    return definition.visible === undefined || definition.visible(settings);
}

/** The value a field currently holds, read out of the daemon's snapshot. */
export function settingsFieldValue(
    definition: SettingsFieldDefinition,
    settings: WsSettingsSnapshot
): SettingsFieldValue {
    return definition.read(settings);
}

/** The config-file text a value becomes. `null` REMOVES the key (ghostty's `set-ghostty-setting`). */
export function encodeSettingsFieldValue(
    definition: SettingsFieldDefinition,
    value: SettingsFieldValue
): string | null {
    switch (definition.kind) {
        case 'toggle':
            if (typeof value !== 'boolean') throw new Error(`${definition.label} is a switch.`);
            return definition.encode(value);
        case 'number':
        case 'slider':
            if (typeof value !== 'number') throw new Error(`${definition.label} takes a number.`);
            return definition.encode(value);
        default:
            if (typeof value !== 'string') throw new Error(`${definition.label} takes text.`);
            return definition.encode(value);
    }
}

/**
 * The TCP listener row's caption: what the config file ASKED for, against what the daemon DID.
 *
 * `GeneralTab.tsx`'s `tcpListenerDetail` in every branch but one, and the exception is the point of
 * moving it here: the failed-bind sentence drops the OS text. The shipped row read `Port 19400
 * unavailable: listen EADDRINUSE: address already in use 127.0.0.1:19400. Unix-socket clients are
 * unaffected.`, and that error belongs to the host's own `tcp-bind-error` row, which still prints
 * it in full under the section. A caption is projected; that row is not.
 */
export function settingsTransportCaption(
    settings: WsSettingsSnapshot,
    status: SettingsTransportStatus | null
): string {
    const configured = settings.general.tcpPort;
    if (status !== null && status.state === 'listening')
        // What the listener DID outranks what the file asks for: a daemon started with an explicit
        // port is genuinely listening even when this config file says nothing, and the row says so.
        return configured > 0
            ? `Listening on ${status.host}:${String(status.port)}.`
            : `Listening on ${status.host}:${String(status.port)} - this daemon was started with an explicit port, not from this config file.`;
    if (status !== null && status.state === 'failed')
        return `Port ${String(status.port)} is unavailable. Unix-socket clients are unaffected.`;
    if (configured <= 0) return 'Disabled - the Unix control socket is the only transport.';
    if (status === null) return `Listening on 127.0.0.1:${String(configured)} (as of daemon start).`;
    // The daemon spoke and has no TCP listener at all: the config changed after it started.
    return `Port ${String(configured)} takes effect on the next daemon start - this daemon started with no TCP listener.`;
}

/** What the surface overlays onto the catalog data: the live edit state for one field. */
export interface SettingsFieldState {
    readonly detail?: string | undefined;
    readonly disabled?: boolean | undefined;
    readonly busy?: boolean | undefined;
    readonly error?: string | undefined;
    readonly draft?: string | undefined;
}

/**
 * Definition plus snapshot plus edit state, as the descriptor a renderer sees.
 *
 * The write target is not among the fields copied, here or in `settingsFieldDescriptor`: this
 * builder is where the two halves meet, and it is deliberately the narrow place to audit.
 */
export function describeSettingsField(
    definition: SettingsFieldDefinition,
    settings: WsSettingsSnapshot,
    state: SettingsFieldState = {}
): SettingsFieldDescriptor {
    const base = {
        id: definition.id,
        sectionID: definition.sectionID,
        groupID: definition.groupID,
        label: definition.label,
        detail: state.detail ?? definition.detail,
        testID: definition.testID,
        ...(definition.rowTestID === undefined ? {} : { rowTestID: definition.rowTestID }),
        ...(state.disabled === undefined ? {} : { disabled: state.disabled }),
        ...(state.busy === undefined ? {} : { busy: state.busy }),
        ...(state.error === undefined ? {} : { error: state.error }),
        ...(state.draft === undefined ? {} : { draft: state.draft })
    };
    switch (definition.kind) {
        case 'toggle':
            return Object.freeze({
                ...base,
                kind: 'toggle' as const,
                value: definition.read(settings),
                default: definition.default
            });
        case 'text':
            return Object.freeze({
                ...base,
                kind: 'text' as const,
                value: definition.read(settings),
                default: definition.default,
                maxLength: definition.maxLength,
                ...(definition.placeholder === undefined ? {} : { placeholder: definition.placeholder })
            });
        case 'number':
            return Object.freeze({
                ...base,
                kind: 'number' as const,
                value: definition.read(settings),
                default: definition.default,
                min: definition.min,
                max: definition.max,
                ...(definition.step === undefined ? {} : { step: definition.step })
            });
        case 'select':
        case 'segmented':
            return Object.freeze({
                ...base,
                kind: definition.kind,
                value: definition.read(settings),
                default: definition.default,
                choices: definition.choices
            });
        case 'slider': {
            const value = definition.read(settings);
            return Object.freeze({
                ...base,
                kind: 'slider' as const,
                value,
                default: definition.default,
                min: definition.min,
                max: definition.max,
                step: definition.step,
                valueLabel: definition.format(value)
            });
        }
        default:
            return Object.freeze({
                ...base,
                kind: 'color' as const,
                value: definition.read(settings),
                default: definition.default
            });
    }
}
