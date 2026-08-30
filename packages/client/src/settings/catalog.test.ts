import { KELPI_ACTIONS } from '@kelpi/core/config';
import { describe, expect, it } from 'vitest';

import {
    ACTION_CATALOG,
    DEFAULT_SETTINGS_TAB,
    SETTINGS_TABS,
    VISIBLE_CATEGORIES,
    actionLabel,
    actionsInCategory,
    isSettingsTabID
} from './catalog';

describe('the action catalog', () => {
    // The point of this test: the table cannot silently lose an action core adds, and cannot
    // keep a display name for one core removed.
    it('covers every bindable action exactly once', () => {
        const catalogued = ACTION_CATALOG.map((entry) => entry.action);
        expect([...catalogued].sort()).toEqual([...KELPI_ACTIONS].sort());
        expect(new Set(catalogued).size).toBe(catalogued.length);
    });

    it('is the 51 actions the spec counts', () => {
        expect(ACTION_CATALOG).toHaveLength(51);
    });

    it('keeps §13.1’s fixed section order and excludes the web-pane category', () => {
        expect([...VISIBLE_CATEGORIES]).toEqual([
            'Pane Management',
            'Navigation',
            'Workspaces',
            'View',
            'Files',
            'Search'
        ]);
        expect(VISIBLE_CATEGORIES).not.toContain('Web Pane');
    });

    it('hides all eleven web-pane actions from the visible sections', () => {
        const visible = VISIBLE_CATEGORIES.flatMap((category) => actionsInCategory(category));
        expect(visible.filter((action) => action.startsWith('web_'))).toEqual([]);
        expect(actionsInCategory('Web Pane')).toHaveLength(11);
        expect(visible).toHaveLength(51 - 11);
    });

    it('uses §4’s display names, including the ones that are not the raw value', () => {
        expect(actionLabel('open_file')).toBe('Preview Markdown');
        expect(actionLabel('create_scratchpad')).toBe('New Scratchpad');
        expect(actionLabel('toggle_sync_input')).toBe('Toggle Synchronise Input');
        expect(actionLabel('switch_to_workspace_7')).toBe('Switch to Workspace 7');
        expect(actionLabel('web_tab_close')).toBe('Web: Close Tab');
    });

    it('numbers the nine workspace switches in order', () => {
        const workspaces = actionsInCategory('Workspaces');
        expect(workspaces.filter((action) => action.startsWith('switch_to_workspace_'))).toEqual([
            'switch_to_workspace_1',
            'switch_to_workspace_2',
            'switch_to_workspace_3',
            'switch_to_workspace_4',
            'switch_to_workspace_5',
            'switch_to_workspace_6',
            'switch_to_workspace_7',
            'switch_to_workspace_8',
            'switch_to_workspace_9'
        ]);
    });
});

describe('the tab list', () => {
    /*
     * H13. `SettingsTab` (`SettingsView.swift:8`) and the `TabView` body (`:18-59`) fix this
     * order, and the port had rearranged it — Repositories and Keybindings above Appearance.
     * The assertion is deliberately the WHOLE array rather than a containment check: order is
     * the claim, and a containment check is what let the rearrangement stand.
     */
    it('is the shipped app’s tab order, with the port-only tab appended', () => {
        expect(SETTINGS_TABS.map((tab) => tab.id)).toEqual([
            'general',
            'appearance',
            'repositories',
            'labels',
            'profiles',
            'keybindings',
            // Joined once favourites grew a daemon home; the URL-bar star deep-links here.
            'web',
            // Port-only: appended so it cannot displace any of the Swift seven.
            'workspaces'
        ]);
    });

    it('is exactly SettingsTab’s seven, in SettingsTab’s order, before the port’s own', () => {
        const swift = ['general', 'appearance', 'repositories', 'labels', 'profiles', 'keybindings', 'web'];
        expect(SETTINGS_TABS.slice(0, swift.length).map((tab) => tab.id)).toEqual(swift);
    });

    // The window opens on General (`SettingsView.swift:13`), not on the 51-row chord table.
    it('opens on General', () => {
        expect(DEFAULT_SETTINGS_TAB).toBe('general');
        expect(SETTINGS_TABS[0]?.id).toBe(DEFAULT_SETTINGS_TAB);
    });

    it('guards a deep-link id', () => {
        expect(isSettingsTabID('labels')).toBe(true);
        expect(isSettingsTabID('downloads')).toBe(false);
    });
});
