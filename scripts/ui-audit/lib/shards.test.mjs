import { describe, expect, it } from 'vitest';

import { CANONICAL_ORDER, STEP_MANIFEST, expandChains, manifestEntry } from './shards.mjs';

/**
 * `--only` against the chains the manifest already declares (#203).
 *
 * The audit's spine is one continuous session, and `chain` is the field that records which
 * accumulated value binds each step to it. `--only` ignored that, so `--only web-batch-pickup`
 * ran a step the manifest describes as "reads state.webPane" with nothing having written it: the
 * step spent its single assertion on "a web pane exists" and returned, which is why the one
 * failing step in the suite was the one that could not be re-run alone.
 *
 * What is pinned here is the rule, not the list: the expansion is WRITERS ONLY (a reader adds
 * nothing a later reader needs), it never reaches forwards, and it is stable under re-application
 * because a shard parent hands its children the expanded list and every child parses it again.
 */
describe('expandChains', () => {
    const index = (id) => CANONICAL_ORDER.indexOf(id);

    it('runs the step that opens the web pane before a step declared to read it', () => {
        expect(manifestEntry('web-batch-pickup').chain).toBe('webPane');
        expect(expandChains(['web-batch-pickup'])).toEqual(['web-pane', 'web-batch-pickup']);
        expect(expandChains(['web-batch-internals'])).toEqual(['web-pane', 'web-batch-internals']);
    });

    it('adds the chain\'s writers and not the readers sitting between them', () => {
        const expanded = expandChains(['web-batch-pickup']);
        // Both of these are `chain: 'webPane'` and both only read it, so neither is a prerequisite.
        expect(expanded).not.toContain('web-find');
        expect(expanded).not.toContain('web-url-bar-shortcut');
    });

    it('takes every writer a composite chain names, in canonical order, with the asked-for step last', () => {
        expect(manifestEntry('external-editor').chain).toBe('openedByDialog+mdPane');
        const expanded = expandChains(['external-editor']);
        expect(expanded).toContain('open-file-dialog');
        expect(expanded).toContain('markdown-pane');
        expect(expanded).toContain('content-pane-keybindings');
        expect(expanded.at(-1)).toBe('external-editor');
        expect(expanded.map(index)).toEqual([...expanded.map(index)].sort((a, b) => a - b));
    });

    it('never reaches forwards: a prerequisite always runs before the step that asked for it', () => {
        for (const id of ['web-batch-pickup', 'external-editor', 'repo-autodetect', 'agent-notification']) {
            for (const added of expandChains([id])) expect(index(added)).toBeLessThanOrEqual(index(id));
        }
    });

    it('leaves a self-provisioning step, an empty list and an unknown id exactly as they came', () => {
        expect(manifestEntry('phone-form-factor').chain).toBe(null);
        expect(expandChains(['phone-form-factor'])).toEqual(['phone-form-factor']);
        expect(expandChains([])).toEqual([]);
        expect(expandChains(['not-a-step'])).toEqual(['not-a-step']);
    });

    it('is stable under re-application, because a shard child re-parses the list its parent expanded', () => {
        for (const ids of [['web-batch-pickup'], ['external-editor'], ['fresh-boot', 'terminal-ls'], ['mac-chrome']]) {
            expect(expandChains(expandChains(ids))).toEqual(expandChains(ids));
        }
    });

    /**
     * The expansion reads the manifest's own prose ("writes state.X"), so this is the guard that
     * keeps that reading honest: a re-worded `reason` that drops the declaration fails here
     * instead of silently un-teaching `--only` the dependency it was taught.
     */
    it('finds a declared writer at or before every step that declares a chain', () => {
        const written = new Map();
        const orphans = [];
        for (const entry of STEP_MANIFEST) {
            for (const variable of entry.chain === null ? [] : entry.chain.split('+')) {
                const writesItself = /\bwrites state\.(\w+)/.test(entry.reason) && entry.reason.includes(`writes state.${variable}`);
                if (!written.has(variable) && !writesItself) orphans.push(`${entry.id} reads state.${variable}`);
            }
            for (const match of entry.reason.matchAll(/\bwrites state\.(\w+)/g)) written.set(match[1], entry.id);
        }
        expect(orphans).toEqual([]);
    });
});
