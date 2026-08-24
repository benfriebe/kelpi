/**
 * The whole-document copy commands (content-panes.md §3.14).
 *
 * `stripFrontMatter` is the client's restatement of the daemon's front-matter split, so the
 * cases below are the daemon's rules (`content/markdown.ts` §3.5): a leading `---` fence, a
 * `---` OR `...` closing fence, a tolerated BOM, and "no fence, no change".
 */

import { describe, expect, it, vi } from 'vitest';

import { FRONT_MATTER_BYTE_LIMIT, stripFrontMatter, writeRichText } from './copy';

describe('stripFrontMatter', () => {
    it('drops a fenced YAML block and keeps the body', () => {
        expect(stripFrontMatter('---\ntitle: Doc\n---\n# Heading\n')).toBe('# Heading\n');
    });

    it('accepts the `...` closing fence and a BOM', () => {
        expect(stripFrontMatter('---\na: 1\n...\nbody\n')).toBe('body\n');
        expect(stripFrontMatter('﻿---\na: 1\n---\nbody\n')).toBe('body\n');
    });

    it('handles CRLF and an empty block', () => {
        expect(stripFrontMatter('---\r\na: 1\r\n---\r\nbody\r\n')).toBe('body\r\n');
        expect(stripFrontMatter('---\n---\nbody\n')).toBe('body\n');
    });

    it('leaves a document with no front matter — or an unterminated fence — untouched', () => {
        expect(stripFrontMatter('# Heading\n\n---\n\nrule\n')).toBe('# Heading\n\n---\n\nrule\n');
        expect(stripFrontMatter('---\ntitle: unterminated\n')).toBe('---\ntitle: unterminated\n');
        expect(stripFrontMatter('')).toBe('');
    });

    it('only treats a fence on the FIRST line as front matter', () => {
        const source = 'intro\n---\ntitle: not front matter\n---\n';
        expect(stripFrontMatter(source)).toBe(source);
    });

    /**
     * §L42 — the preview and the copy cannot disagree.
     *
     * The daemon stops scanning at `FRONT_MATTER_BYTE_LIMIT` and renders an over-cap block as
     * ordinary body (`markdown.test.ts` "bails past the 64 KiB scan guard"). The Swift shares one
     * `FrontMatterExtractor` between its renderer and its copy, so the two ALWAYS agree; the port
     * has two implementations and therefore has to be told the same limit. These are the daemon's
     * own cap fixtures, run through the client's copy.
     */
    describe('the 64 KiB cap (§L42)', () => {
        it('leaves an over-cap block in the copied text, exactly as the preview renders it', () => {
            const filler = `${'x'.repeat(1023)}\n`.repeat(Math.ceil(FRONT_MATTER_BYTE_LIMIT / 1024) + 1);
            const source = `---\n${filler}---\nbody`;
            expect(stripFrontMatter(source)).toBe(source);
        });

        it('counts UTF-8 BYTES, not characters, toward the guard', () => {
            // ~60 KiB in bytes but only ~30k characters: under the cap, so still stripped.
            const line = `${'é'.repeat(500)}\n`;
            expect(stripFrontMatter(`---\n${line.repeat(60)}---\nbody`)).toBe('body');
            // Same character count, twice the bytes per char: over the cap, so left alone.
            const wide = `${'😀'.repeat(250)}\n`; // 250 × 4 bytes + newline
            const over = `---\n${wide.repeat(70)}---\nbody`;
            expect(stripFrontMatter(over)).toBe(over);
        });

        it('still strips a block that sits just under the cap', () => {
            const filler = `${'x'.repeat(1023)}\n`.repeat(60); // ~60 KiB
            expect(stripFrontMatter(`---\n${filler}---\nbody`)).toBe('body');
        });
    });
});

describe('writeRichText', () => {
    it('hands both flavors to the injected writer', () => {
        const write = vi.fn();
        expect(writeRichText({ html: '<h1>Doc</h1>', text: 'Doc' }, write)).toBe(true);
        expect(write).toHaveBeenCalledWith({ html: '<h1>Doc</h1>', text: 'Doc' });
    });

    it('refuses an empty payload', () => {
        const write = vi.fn();
        expect(writeRichText({ html: '', text: '' }, write)).toBe(false);
        expect(write).not.toHaveBeenCalled();
    });

    it('falls back to writeText where ClipboardItem does not exist (jsdom, Firefox)', () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        const original = (globalThis as { navigator?: unknown }).navigator;
        Object.defineProperty(globalThis, 'navigator', {
            value: { clipboard: { writeText } },
            configurable: true
        });
        try {
            expect(writeRichText({ html: '<p>x</p>', text: 'x' })).toBe(true);
            expect(writeText).toHaveBeenCalledWith('x');
        } finally {
            Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true });
        }
    });
});
