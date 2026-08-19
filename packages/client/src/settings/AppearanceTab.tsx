/**
 * Settings ▸ Appearance.
 *
 * Read-only by design, and the reason is a spec rule rather than an omission:
 *
 *   - the pane colors come from `~/.config/ghostty/config` (content-panes.md §3.1/§3.8), which
 *     ghostty owns — the daemon parses it and never writes it;
 *   - `theme` in `~/.config/nex/config` is, per config-keybindings.md §1.3, "NEVER written back
 *     to this file by the app… a read-at-launch input only". The daemon enforces that: the key
 *     is absent from `WS_WRITABLE_GENERAL_KEYS`, so `set-general-setting theme` is refused with
 *     "'theme' is not a writable general setting". A picker here would be a button that always
 *     fails, so the value is shown with the file that owns it instead.
 *
 * What this tab IS, then: the one place a user can see what the client actually resolved —
 * including the daemon's light/dark verdict, which is computed from the background's luminance
 * and drives the chrome bucket, the terminal palette and the daemon-rendered markdown/diff HTML
 * all at once. When those three disagree with expectation, this is the page that says why.
 */

import type { WsSettingsSnapshot } from '@nex/protocol';
import type { ReactElement } from 'react';

import { normalizeHexColor, tokens, withAlpha } from '../chrome';
import type { SettingsPaths } from './types';
import { KeyChip, SettingsFooterNote, SettingsRow, SettingsSection } from './ui';

export interface AppearanceTabProps {
    readonly settings: WsSettingsSnapshot;
    readonly paths: SettingsPaths;
}

function percent(value: number): string {
    return `${String(Math.round(value * 100))}%`;
}

export function AppearanceTab(props: AppearanceTabProps): ReactElement {
    const appearance = props.settings.appearance;
    const swatch = normalizeHexColor(appearance.backgroundColor);
    const fill = withAlpha(appearance.backgroundColor, appearance.backgroundOpacity);

    return (
        <div className="flex flex-col gap-4" data-testid="settings-tab-appearance">
            <SettingsSection
                title="Terminal surface"
                hint="Parsed from the ghostty config; every pane — terminal, markdown, diff, scratchpad — is painted with it."
                testID="appearance-surface"
            >
                <SettingsRow label="Background" detail={appearance.backgroundColor} testID="appearance-background">
                    <span
                        data-testid="appearance-swatch"
                        data-color={swatch}
                        className="h-5 w-9 rounded"
                        style={{ background: fill, border: `1px solid ${tokens.divider}` }}
                        aria-label={`Background ${appearance.backgroundColor}`}
                        role="img"
                    />
                </SettingsRow>
                <SettingsRow
                    label="Background opacity"
                    detail="Blended into every pane fill as rgba(background, opacity)."
                    testID="appearance-opacity"
                >
                    <KeyChip>{percent(appearance.backgroundOpacity)}</KeyChip>
                </SettingsRow>
                <SettingsRow
                    label="Font"
                    detail="Blank means the renderer's own default."
                    testID="appearance-font"
                >
                    <KeyChip>{appearance.fontFamily ?? 'default'}</KeyChip>
                    <KeyChip>{appearance.fontSize === null ? 'default' : `${String(appearance.fontSize)}px`}</KeyChip>
                </SettingsRow>
                <SettingsRow
                    label="Resolved appearance"
                    detail="The daemon's luminance verdict on the background — it, not the OS setting, picks light or dark."
                    testID="appearance-bucket"
                >
                    <KeyChip>{appearance.isDark ? 'dark' : 'light'}</KeyChip>
                </SettingsRow>
                <SettingsRow label="ghostty theme" detail="The theme line in the ghostty config, passed through." testID="appearance-ghostty-theme">
                    <KeyChip>{appearance.theme ?? 'none'}</KeyChip>
                </SettingsRow>
            </SettingsSection>

            <SettingsSection
                title="Terminal theme"
                hint="A built-in theme id, read from the nex config at launch."
                testID="appearance-theme"
            >
                <SettingsRow
                    label="theme"
                    detail="Read-only: the app never writes this key back — edit the config file to change it."
                    testID="appearance-nex-theme"
                >
                    <KeyChip>{props.settings.general.theme ?? 'none'}</KeyChip>
                </SettingsRow>
            </SettingsSection>

            <SettingsFooterNote>
                Colors and fonts: <span className="font-mono">{props.paths.ghosttyConfig}</span>. Theme id:{' '}
                <span className="font-mono">{props.paths.nexConfig}</span>. Both are watched — save the file and
                this window follows.
            </SettingsFooterNote>
        </div>
    );
}
