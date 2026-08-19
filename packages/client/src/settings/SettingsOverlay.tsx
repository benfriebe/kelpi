/**
 * The Settings window (config-keybindings.md §13, shell-ui.md's focus choreography).
 *
 * A modal overlay rather than a second window: the web client has one document, and everything
 * the Swift Settings window does is a form over daemon state. Behaviors that are contracts
 * rather than styling:
 *
 *   - **Escape closes**, and closing hands focus back to the pane the user came from — the same
 *     §10.4 choreography the command palette follows, because a chrome surface must never leave
 *     the window without keyboard focus. A nested editor that uses Escape for its own cancel
 *     (the recorder, an inline rename field) stops the event, so Escape means "the innermost
 *     thing that is open", never "close everything at once".
 *   - **The overlay owns the keyboard while it is open.** Assembly gates the app's key
 *     dispatcher on it, so ⌘D does not split a pane behind the sheet, and the recorder can
 *     capture any combo the user presses.
 *   - **Focus is trapped**: Tab cycles inside the dialog. The tab rail is a roving-tabindex
 *     `tablist` — ↑/↓ (and ←/→) move between tabs, Home/End jump to the ends.
 *
 * The tabs themselves render from props and push verbs; the only state here is which tab is
 * showing.
 */

import type { WsSettingsSnapshot } from '@nex/protocol';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';

import { clientKeyBindings, tokens, withAlpha, type ChromeBucket } from '../chrome';
import { AppearanceTab } from './AppearanceTab';
import { KeybindingsTab } from './KeybindingsTab';
import { LabelsTab } from './LabelsTab';
import { ProfilesTab } from './ProfilesTab';
import { SETTINGS_TABS, type SettingsTabID } from './catalog';
import { WorkspacesTab } from './WorkspacesTab';
import {
    DEFAULT_SETTINGS_PATHS,
    type SettingsActions,
    type SettingsDomainState,
    type SettingsPaths
} from './types';

export interface SettingsOverlayProps {
    readonly open: boolean;
    readonly settings: WsSettingsSnapshot;
    readonly domain: SettingsDomainState;
    readonly actions: SettingsActions;
    readonly onClose: () => void;
    /** Which tab to show first; also re-applied whenever the overlay is re-opened. */
    readonly initialTab?: SettingsTabID | undefined;
    readonly paths?: SettingsPaths | undefined;
    readonly bucket?: ChromeBucket | undefined;
}

const FOCUSABLE =
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function SettingsOverlay(props: SettingsOverlayProps): ReactElement | null {
    const initial = props.initialTab ?? 'keybindings';
    const [tab, setTab] = useState<SettingsTabID>(initial);
    const dialogRef = useRef<HTMLDivElement | null>(null);
    const tabRefs = useRef(new Map<SettingsTabID, HTMLButtonElement>());
    const paths = props.paths ?? DEFAULT_SETTINGS_PATHS;

    // Re-opening always lands on the requested tab: a deep link ("Manage labels…") must not be
    // overridden by wherever the user happened to be last time.
    useEffect(() => {
        if (props.open) setTab(initial);
    }, [props.open, initial]);

    useEffect(() => {
        if (!props.open) return;
        tabRefs.current.get(tab)?.focus();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- open-edge only: moving focus on
        // every tab change would fight a click inside the panel.
    }, [props.open]);

    const bindings = useMemo(() => clientKeyBindings(props.settings.keybindLines), [props.settings.keybindLines]);

    const moveTab = useCallback(
        (delta: number, absolute?: 'first' | 'last'): void => {
            const ids = SETTINGS_TABS.map((entry) => entry.id);
            const at = ids.indexOf(tab);
            const next =
                absolute === 'first'
                    ? 0
                    : absolute === 'last'
                      ? ids.length - 1
                      : (at + delta + ids.length) % ids.length;
            const id = ids[next];
            if (id === undefined) return;
            setTab(id);
            tabRefs.current.get(id)?.focus();
        },
        [tab]
    );

    if (!props.open) return null;

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            props.onClose();
            return;
        }
        if (event.key !== 'Tab') return;
        // Trap: the dialog is modal, so Tab must not walk into the panes behind it.
        const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
        if (nodes === undefined || nodes.length === 0) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (first === undefined || last === undefined) return;
        const active = document.activeElement;
        if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
            return;
        }
        if (event.shiftKey && active === first) {
            event.preventDefault();
            last.focus();
        }
    };

    return (
        <div
            data-testid="settings-backdrop"
            className="absolute inset-0 z-50 flex items-center justify-center"
            // run-B m6: at 0.35 the panes behind kept their full brightness and the window did
            // not read as modal at all. 0.62 plus a 2px blur pushes the content behind out of
            // focus without hiding which workspace you are in.
            style={{ background: 'rgba(0,0,0,0.62)', backdropFilter: 'blur(2px)' }}
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) props.onClose();
            }}
        >
            <div
                ref={dialogRef}
                data-testid="settings-window"
                role="dialog"
                aria-modal="true"
                aria-label="Settings"
                className="flex h-[min(620px,90%)] w-[min(880px,92%)] overflow-hidden rounded-[10px]"
                style={{
                    background: tokens.surfaceBackground,
                    border: `1px solid ${tokens.divider}`,
                    boxShadow: '0 24px 70px rgba(0,0,0,0.5)',
                    color: tokens.textPrimary
                }}
                onKeyDown={onKeyDown}
            >
                <div
                    role="tablist"
                    aria-label="Settings sections"
                    aria-orientation="vertical"
                    data-testid="settings-tabs"
                    className="flex w-44 shrink-0 flex-col gap-0.5 border-r p-2"
                    style={{ borderColor: tokens.divider, background: tokens.sidebarBackground }}
                    onKeyDown={(event) => {
                        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
                            event.preventDefault();
                            moveTab(1);
                            return;
                        }
                        if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
                            event.preventDefault();
                            moveTab(-1);
                            return;
                        }
                        if (event.key === 'Home') {
                            event.preventDefault();
                            moveTab(0, 'first');
                            return;
                        }
                        if (event.key === 'End') {
                            event.preventDefault();
                            moveTab(0, 'last');
                        }
                    }}
                >
                    <div className="px-2 pb-1 pt-0.5 text-[11px] uppercase tracking-wide" style={{ color: tokens.textTertiary }}>
                        Settings
                    </div>
                    {SETTINGS_TABS.map((entry) => {
                        const selected = entry.id === tab;
                        return (
                            <button
                                key={entry.id}
                                ref={(node) => {
                                    if (node === null) tabRefs.current.delete(entry.id);
                                    else tabRefs.current.set(entry.id, node);
                                }}
                                type="button"
                                role="tab"
                                id={`settings-tab-${entry.id}`}
                                aria-selected={selected}
                                aria-controls={`settings-panel-${entry.id}`}
                                tabIndex={selected ? 0 : -1}
                                data-testid={`settings-tab-button-${entry.id}`}
                                className="rounded px-2 py-1.5 text-left text-[12px]"
                                style={{
                                    background: selected ? withAlpha(tokens.accent, 0.18) : 'transparent',
                                    color: selected ? tokens.textPrimary : tokens.textSecondary
                                }}
                                onClick={() => {
                                    setTab(entry.id);
                                }}
                            >
                                {entry.label}
                            </button>
                        );
                    })}
                    <div className="mt-auto p-1">
                        <button
                            type="button"
                            data-testid="settings-close"
                            className="w-full rounded border px-2 py-1 text-[11px]"
                            style={{ borderColor: tokens.divider, color: tokens.textSecondary }}
                            onClick={props.onClose}
                        >
                            Close
                        </button>
                    </div>
                </div>

                <div
                    role="tabpanel"
                    id={`settings-panel-${tab}`}
                    aria-labelledby={`settings-tab-${tab}`}
                    data-testid="settings-panel"
                    className="min-w-0 flex-1 overflow-y-auto p-4"
                >
                    {tab === 'keybindings' ? (
                        <KeybindingsTab bindings={bindings} actions={props.actions} configPath={paths.nexConfig} />
                    ) : null}
                    {tab === 'appearance' ? <AppearanceTab settings={props.settings} paths={paths} /> : null}
                    {tab === 'labels' ? (
                        <LabelsTab
                            presets={props.domain.labelPresets}
                            workspaces={props.domain.workspaces}
                            actions={props.actions}
                            bucket={props.bucket}
                        />
                    ) : null}
                    {tab === 'profiles' ? (
                        <ProfilesTab profiles={props.settings.profiles} actions={props.actions} paths={paths} />
                    ) : null}
                    {tab === 'workspaces' ? (
                        <WorkspacesTab settings={props.settings} actions={props.actions} paths={paths} />
                    ) : null}
                </div>
            </div>
        </div>
    );
}
