import { NEX_ACTIONS } from '@nex/core/config';
import { describe, expect, it } from 'vitest';

import {
    ACTION_CATALOG,
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
        expect([...catalogued].sort()).toEqual([...NEX_ACTIONS].sort());
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
    it('names the tabs this port ships, keybindings first', () => {
        expect(SETTINGS_TABS.map((tab) => tab.id)).toEqual([
            'general',
            'repositories',
            'keybindings',
            'appearance',
            'labels',
            'profiles',
            'workspaces',
            // Joined once favourites grew a daemon home; the URL-bar star deep-links here.
            'web'
        ]);
    });

    it('guards a deep-link id', () => {
        expect(isSettingsTabID('labels')).toBe(true);
        expect(isSettingsTabID('downloads')).toBe(false);
    });
});
