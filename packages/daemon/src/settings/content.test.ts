/**
 * The seam `boot/compose.ts` wires between the settings authority and the content renderer:
 * a ghostty-config change must re-render every open markdown/diff pane against the new
 * background (content-panes.md §3.8 — "the currently loaded content is re-rendered … without
 * re-reading the file").
 *
 * A stub on either side would prove nothing; this runs a real `SettingsService` against a real
 * `ContentService` with the same one-line subscription compose installs.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createContentService, type ContentPaneState } from '../content/index.js';
import { harness, id, NOW, seededState, W1 } from '../store/testing.js';
import { contentAppearanceOf, createSettingsService, type SettingsService } from './service.js';

const MD = id('eeeeeeee', 1);
const SHELL = id('dddddddd', 100);

const roots: string[] = [];
const disposers: (() => void)[] = [];

afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface Fixture {
    readonly settings: SettingsService;
    readonly events: ContentPaneState[];
    /** Rewrite the ghostty config and push it through, exactly as the watcher would. */
    editGhostty(contents: string): void;
    state(): Promise<ContentPaneState>;
}

async function fixture(ghostty: string): Promise<Fixture> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-settings-content-'));
    roots.push(root);
    const ghosttyPath = path.join(root, 'ghostty-config');
    fs.writeFileSync(ghosttyPath, ghostty, 'utf8');
    const notePath = path.join(root, 'note.md');
    fs.writeFileSync(notePath, '# Title\n\nbody\n', 'utf8');

    // `watch: false` keeps the test deterministic: `reload()` is the exact call the watcher's
    // debounced callback makes, so driving it by hand tests the same path without a sleep.
    const settings = createSettingsService({
        configPath: path.join(root, 'kelpi-config'),
        ghosttyPath,
        watch: false
    });
    const store = harness(seededState(W1, SHELL));
    const content = createContentService({
        store: store.store,
        watch: false,
        // Exactly what compose does: seed from the snapshot, then follow it.
        appearance: contentAppearanceOf(settings.snapshot)
    });
    const off = settings.subscribe((snapshot) => {
        content.setAppearance(contentAppearanceOf(snapshot));
    });
    disposers.push(() => {
        off();
        settings.dispose();
        content.dispose();
    });

    store.dispatch({ type: 'open-markdown-pane', workspaceID: W1, paneID: MD, filePath: notePath, now: NOW });

    const events: ContentPaneState[] = [];
    const subscription = await content.subscribe(MD, (state) => events.push(state));
    disposers.push(() => subscription.unsubscribe());

    return {
        settings,
        events,
        editGhostty(contents) {
            fs.writeFileSync(ghosttyPath, contents, 'utf8');
            settings.reload();
        },
        state: () => content.state(MD)
    };
}

describe('settings → content appearance', () => {
    it('renders the first load against the ghostty background', async () => {
        const f = await fixture('background = #ffffff\n');
        const state = await f.state();
        expect(state.isDark).toBe(false);
        expect(state.html).toContain('class="light"');
    });

    it('re-renders every open pane when the ghostty background changes', async () => {
        const f = await fixture('background = #ffffff\n');
        expect((await f.state()).isDark).toBe(false);

        f.editGhostty('background = #1a1b26\n');

        const state = await f.state();
        expect(state.isDark).toBe(true);
        expect(state.html).toContain('class="dark"');
        // The source is untouched: §3.8 re-renders, it does not re-read.
        expect(state.text).toContain('# Title');
    });

    it('pushes the re-render to subscribed clients unasked', async () => {
        const f = await fixture('background = #ffffff\n');
        await f.state();
        const before = f.events.length;

        f.editGhostty('background = #1a1b26\n');

        expect(f.events.length).toBeGreaterThan(before);
        expect(f.events.at(-1)?.isDark).toBe(true);
    });

    it('does nothing when the edit changes no setting the daemon reads', async () => {
        const f = await fixture('background = #ffffff\n');
        await f.state();
        const before = f.events.length;
        f.editGhostty('background = #ffffff\nmouse-hide-while-typing = true\n');
        expect(f.events).toHaveLength(before);
    });
});
