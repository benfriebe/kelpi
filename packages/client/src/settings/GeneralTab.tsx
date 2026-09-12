/**
 * Settings ▸ General (SET-002's first tab; SET-008, SET-010, SET-013, SET-014, SET-019…021).
 *
 * The tab was absent through M8 for an honest reason — the Swift General tab is almost entirely
 * `UserDefaults`, and a tab that could only *display* things would have been worse than none.
 * Every control here now has a real config key behind it (`@kelpi/core/config`'s `general.ts`),
 * the daemon reads each one through the settings service on every command rather than at boot,
 * and the write is the same `set-general-setting` verb the rest of Settings uses.
 *
 * ── The rows are DESCRIPTORS now ────────────────────────────────────────────────────
 *
 * The markup, the order and the test ids are unchanged; what moved is where a row is *declared*.
 * `sections.ts` holds the cards and the fields as data (with each field's write target PRIVATE to
 * that module), `FieldRenderer` turns one field into one control, and the surface is the only
 * thing that turns a field id into a config key. Three consequences:
 *
 *   - a presenter can be handed the descriptors without being handed a verb, a key or a closure;
 *   - the daemon's allowlist (`WS_WRITABLE_GENERAL_KEYS`) has exactly one client-side counterpart
 *     to be checked against, rather than a key spelled inline beside each control;
 *   - the tab still renders from a fixture with nothing but `settings` + `actions`, which is what
 *     every test here does.
 *
 * What is NOT a descriptor is what is not a value: the failed-bind line and the compat note report
 * an OUTCOME the daemon sent, and the pointer at the Workspaces tab is prose.
 *
 * One row reports an outcome rather than a value:
 *
 *   - **TCP port**: writing the key re-binds the listener LIVE (config-keybindings.md §12):
 *     the daemon's settings subscriber runs `applyTcpPortSetting` (`daemon/src/boot/compose.ts`),
 *     `stopTCP` then a fresh bind on the control server that owns the port, with the Unix
 *     socket and its connections serving throughout, which is what makes it safe under a
 *     connected CLI. SET-022's Swift order was stop → start → *then* write, so a failed bind
 *     wrote nothing; here the key is written regardless and the failed bind lands on the
 *     listener status instead. The "takes effect on the next daemon start" wording survives
 *     only in `settingsTransportCaption`'s last branch, for a daemon that reports no TCP listener at
 *     all (issue #58 retired the header's claim that a live socket could not be re-bound).
 *
 *     What it no longer does is *guess the outcome*. §SET-021 asked for "Port N is unavailable"
 *     under the Network section, and the daemon now reports what its listener actually did
 *     (`welcome.transport`, backed by `daemon/src/control/server.ts`'s `tcpStatus`), so the row
 *     reads "Listening on 127.0.0.1:19400" or "Port 19400 is unavailable" - the failed-bind
 *     case that used to be a daemon log line nobody saw while every `KELPI_SOCKET=tcp:…` client
 *     timed out against nothing. It is the one caption the catalog cannot carry on its own, so
 *     the tab hands the surface a `SettingsTransportStatus` (three states, no room for an OS
 *     message) and the surface composes the sentence.
 *
 * Panes ▸ focus-follows-mouse and the two confirmation suppressions (workspace delete, quit)
 * live on the Workspaces tab, where this port put them before General existed; the note at the
 * bottom points there rather than duplicating a control in two places (two switches for one
 * value is how they drift).
 */

import type { WsSettingsSnapshot, WsTransportStatus } from '@kelpi/protocol';
import type { ReactElement } from 'react';

import { tokens } from '../chrome';
import type {
    SettingsDraftValue,
    SettingsFieldDescriptor,
    SettingsTransportStatus
} from './contract';
import { FieldRenderer, SETTINGS_DESTRUCTIVE_TONE } from './FieldRenderer';
import { SETTINGS_DEFAULT_TCP_PORT } from './sections';
import type { SettingsSurface } from './surface';
import type { SettingsActions, SettingsPaths } from './types';
import { SettingsFooterNote, SettingsSection } from './ui';
import { useSectionSurface, useSettingsSnapshot } from './use-settings';

export interface GeneralTabProps {
    readonly settings: WsSettingsSnapshot;
    readonly actions: SettingsActions;
    readonly paths: SettingsPaths;
    /**
     * §SET-021: what the daemon's listeners actually did. `null`/absent means it did not say
     * (an older daemon, or not connected yet), which the row renders with the old "as of daemon
     * start" wording rather than claiming a bind either way.
     */
    readonly transport?: WsTransportStatus | null | undefined;
    /**
     * The window's settings surface, when the host has one.
     *
     * Absent (every test below, a fixture, an embedder) the tab builds its own, pinned to this
     * section, so the draft store, the validation funnel and the write queue are the same code on
     * both paths. What the host's surface adds is CONTINUITY: a draft typed here survives leaving
     * the tab and coming back, and phase 2's presenter draws from the same one.
     */
    readonly surface?: SettingsSurface | undefined;
    /**
     * Which half of the tab to draw.
     *
     * `all` (the default) is the bundled panel. `native` is the REMAINDER the host keeps drawing
     * when a `settings.window` presenter has the dialog: the two rows that report an OUTCOME rather
     * than a value (the failed bind, the CLI-compat note), the pointer at the Workspaces tab and the
     * footer naming the config file. None of them is a descriptor, so none of them is in the frame -
     * and the failed-bind line disappearing at the moment a user goes looking for it is exactly the
     * failure this half exists to prevent.
     */
    readonly part?: 'all' | 'native' | undefined;
}

/**
 * §SET-021's Network row, mapped down to the three states a caption may know about.
 *
 * `welcome.transport` carries `tcp.error` - the raw `listen EADDRINUSE: address already in use
 * 127.0.0.1:19400` the bind threw - and a caption is PROJECTED: in phase 2 it reaches a
 * replaceable presenter. So the host maps its status down to `SettingsTransportStatus`, which has
 * nowhere to put an OS message, and the surface writes the sentence from that
 * (`settingsTransportCaption`). The verbatim error keeps its own home: `tcpBindError` below, drawn
 * natively under the section, which no projection copies.
 *
 * `null` is "the daemon has not said" - an older daemon, or not connected yet - which is a
 * different sentence again from "it has no listener".
 */
export function settingsTransportStatus(
    transport: WsTransportStatus | null | undefined
): SettingsTransportStatus | null {
    if (transport === null || transport === undefined) return null;
    const tcp = transport.tcp;
    if (tcp === null || tcp === undefined) return { state: 'none' };
    return tcp.bound === null
        ? { state: 'failed', host: tcp.host, port: tcp.requested }
        : { state: 'listening', host: tcp.host, port: tcp.bound };
}

/**
 * The port the Swift Network toggle seeds when it is switched on (SET-019).
 *
 * The catalog's `SETTINGS_DEFAULT_TCP_PORT` is the same number (it is the one the switch's
 * `encode` writes), and `sections.test.ts` asserts the two cannot drift. This name stays because
 * the tab's own tests and `index.ts` export it.
 */
export const DEFAULT_TCP_PORT = SETTINGS_DEFAULT_TCP_PORT;

/** The failed-bind line, or null when there is nothing to warn about. */
export function tcpBindError(
    _configuredPort: number,
    transport: WsTransportStatus | null | undefined
): string | null {
    const tcp = transport?.tcp;
    // Keyed off the FAILED LISTENER, not off the config value: a listener asked for by
    // `KELPID_TCP_PORT` fails just as loudly as one asked for by the file, and the user who has to
    // fix it is the same user either way.
    if (tcp === null || tcp === undefined || tcp.bound !== null) return null;
    return `Port ${String(tcp.requested)} is unavailable${tcp.error === null ? '' : ` - ${tcp.error}`}`;
}

export function GeneralTab(props: GeneralTabProps): ReactElement {
    const general = props.settings.general;
    const bindError = tcpBindError(general.tcpPort, props.transport);
    /*
     * One surface, one write path.
     *
     * The rows, their order, their captions and their visibility all come from the projection
     * (`sections.ts` is the data, the surface is the authority that folds the daemon's snapshot,
     * the drafts and the errors into it), and a change leaves as a field ID. Nothing in this file
     * names a config key any more, and nothing in it validates a value: both belong to the funnel
     * every writer shares.
     */
    const surface = useSectionSurface({
        sectionID: 'general',
        ...(props.surface === undefined ? {} : { surface: props.surface }),
        config: {
            settings: () => props.settings,
            actions: () => props.actions,
            transport: () => settingsTransportStatus(props.transport)
        }
    });
    const snapshot = useSettingsSnapshot(surface);
    const commit = (field: SettingsFieldDescriptor, value: SettingsDraftValue): void => {
        try {
            // Hand it over as a draft first: if the write is refused the text stays on screen with
            // the reason under it, rather than snapping back to the value the daemon last sent.
            surface.setDraft(field.id, value);
            surface.commitField(field.id, value);
        } catch {
            // The field is gone, native, or the host is refusing it. The surface is the authority
            // on that and it has already declined; there is nothing for the tab to add.
        }
    };

    /*
     * The two rows of the Network section that are not values.
     *
     * An ARRAY rather than a fragment, because `SettingsSection` wraps each child in a padded,
     * hairlined band and counts a fragment as one child: an empty fragment would draw an empty
     * band under the port field on every daemon whose listener bound.
     */
    const networkNotes: ReactElement[] = [];
    if (bindError !== null) {
        networkNotes.push(
            /*
             * §SET-021: the failed bind, in the destructive tone, under the Network section, the
             * one place a user goes looking when `KELPI_SOCKET=tcp:…` stops answering.
             */
            <p
                key="tcp-bind-error"
                data-testid="tcp-bind-error"
                className="text-[11px]"
                style={{ color: SETTINGS_DESTRUCTIVE_TONE }}
            >
                {bindError}
            </p>
        );
    }
    if (props.transport?.compat != null) {
        networkNotes.push(
            /*
             * The routing fix's coexistence state: another Kelpi (the Swift app) owns the shared
             * CLI-compat socket. Not destructive-toned — panes are unaffected (their KELPI_SOCKET
             * is injected at spawn), but the one place a user goes looking when plain-terminal
             * `kelpi` commands answer as the wrong app.
             */
            <p
                key="compat-degraded-note"
                data-testid="compat-degraded-note"
                className="text-[11px]"
                style={{ color: tokens.textTertiary }}
            >
                {`Another Kelpi owns ${props.transport.compat.path}, so plain-terminal kelpi commands reach that app. Panes are unaffected - they route here automatically.`}
            </p>
        );
    }

    const projected = props.part !== 'native';
    const network = snapshot.groups.find((group) => group.id === 'general-network');

    return (
        <div className="flex flex-col gap-4" data-testid="settings-tab-general">
            {projected
                ? snapshot.groups.map((group) => (
                      <SettingsSection
                          key={group.id}
                          title={group.title}
                          testID={group.testID}
                          {...(group.hint === null ? {} : { hint: group.hint })}
                      >
                          {snapshot.fields
                              .filter((field) => field.groupID === group.id)
                              .map((field) => (
                                  <FieldRenderer key={field.id} field={field} onCommit={commit} />
                              ))}
                          {group.id === 'general-network' ? networkNotes : null}
                      </SettingsSection>
                  ))
                : null}

            {/*
              * The native half keeps the notes under the section they belong to: "Port 19400 is
              * unavailable" under Network is where a user goes looking when `KELPI_SOCKET=tcp:…`
              * stops answering, and a bare line with no heading over it is not that.
              */}
            {!projected && networkNotes.length > 0 && network !== undefined ? (
                <SettingsSection title={network.title} testID={network.testID}>
                    {networkNotes}
                </SettingsSection>
            ) : null}

            <p className="text-[11px]" style={{ color: tokens.textTertiary }}>
                Focus-follows-mouse and the two confirmation dialogs (workspace delete, quit) are on the
                Workspaces tab.
            </p>

            <SettingsFooterNote>
                Config: <span className="font-mono">{props.paths.kelpiConfig}</span>. Every value here is a line in
                that file - edit it by hand and this window follows.
            </SettingsFooterNote>
        </div>
    );
}
