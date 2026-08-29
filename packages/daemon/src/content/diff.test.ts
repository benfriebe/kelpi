import { describe, expect, it } from 'vitest';

import {
    EMPTY_DIFF_HTML,
    chunkDiff,
    classifyDiffLine,
    describeChunk,
    diffStylesheet,
    displayPath,
    gitFailureText,
    renderDiffBody,
    renderDiffDocument
} from './diff.js';

const MODIFIED = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,3 @@',
    ' context',
    '-gone',
    '+added',
    '+also added'
].join('\n');

describe('classifyDiffLine', () => {
    it('classifies file headers before +/- lines', () => {
        expect(classifyDiffLine('diff --git a/x b/x')).toBe('file-header');
        expect(classifyDiffLine('index abc..def 100644')).toBe('file-header');
        expect(classifyDiffLine('--- a/x')).toBe('file-header');
        expect(classifyDiffLine('+++ b/x')).toBe('file-header');
        expect(classifyDiffLine('new file mode 100644')).toBe('file-header');
        expect(classifyDiffLine('deleted file mode 100644')).toBe('file-header');
        expect(classifyDiffLine('similarity index 95%')).toBe('file-header');
        expect(classifyDiffLine('rename from a')).toBe('file-header');
        expect(classifyDiffLine('copy from a')).toBe('file-header');
        expect(classifyDiffLine('Binary files a and b differ')).toBe('file-header');
        expect(classifyDiffLine('old mode 100644')).toBe('file-header');
        expect(classifyDiffLine('new mode 100755')).toBe('file-header');
    });

    it('classifies hunks, adds, dels and context', () => {
        expect(classifyDiffLine('@@ -1 +1 @@')).toBe('hunk');
        expect(classifyDiffLine('+added')).toBe('add');
        expect(classifyDiffLine('-removed')).toBe('del');
        expect(classifyDiffLine(' unchanged')).toBe('context');
        expect(classifyDiffLine('')).toBe('context');
        expect(classifyDiffLine('\\ No newline at end of file')).toBe('context');
    });

    it('does not treat `---`/`+++` without the trailing space as a file header', () => {
        expect(classifyDiffLine('---')).toBe('del');
        expect(classifyDiffLine('+++')).toBe('add');
    });
});

describe('chunkDiff', () => {
    it('starts a chunk at every `diff --git ` line, header included in the body', () => {
        const chunks = chunkDiff(`${MODIFIED}\ndiff --git a/b b/b\n@@ -0,0 +1 @@\n+x`);
        expect(chunks).toHaveLength(2);
        expect(chunks[0]?.headerLine).toBe('diff --git a/src/a.ts b/src/a.ts');
        expect(chunks[0]?.lines[0]).toBe('diff --git a/src/a.ts b/src/a.ts');
        expect(chunks[1]?.headerLine).toBe('diff --git a/b b/b');
    });

    it('keeps pre-first-file lines as a headerless preamble', () => {
        const chunks = chunkDiff(`warning: something\n${MODIFIED}`);
        expect(chunks[0]?.headerLine).toBeNull();
        expect(chunks[0]?.lines).toEqual(['warning: something']);
        expect(chunks[1]?.headerLine).toBe('diff --git a/src/a.ts b/src/a.ts');
    });
});

describe('describeChunk', () => {
    const describeOf = (text: string) => describeChunk(chunkDiff(text)[0]!);

    it('counts additions and deletions, skipping +++/---', () => {
        const info = describeOf(MODIFIED);
        expect(info.status).toBe('modified');
        expect(info.additions).toBe(2);
        expect(info.deletions).toBe(1);
        expect(info.path).toBe('src/a.ts');
    });

    it('detects added / deleted / binary', () => {
        expect(describeOf('diff --git a/x b/x\nnew file mode 100644\n@@ -0,0 +1 @@\n+x').status).toBe(
            'added'
        );
        expect(
            describeOf('diff --git a/x b/x\ndeleted file mode 100644\n@@ -1 +0,0 @@\n-x').status
        ).toBe('deleted');
        expect(describeOf('diff --git a/x b/x\nBinary files a/x and b/x differ').status).toBe(
            'binary'
        );
    });

    it('detects a rename and shows "from → to"', () => {
        const info = describeOf(
            'diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts'
        );
        expect(info.status).toBe('renamed');
        expect(info.path).toBe('old.ts → new.ts');
        expect(info.additions).toBe(0);
        expect(info.deletions).toBe(0);
    });

    it('reports a pure mode change as `mode` and a mode+content change as `modified`', () => {
        expect(describeOf('diff --git a/x b/x\nold mode 100644\nnew mode 100755').status).toBe(
            'mode'
        );
        expect(
            describeOf('diff --git a/x b/x\nold mode 100644\nnew mode 100755\n@@ -1 +1 @@\n-a\n+b')
                .status
        ).toBe('modified');
    });
});

describe('displayPath', () => {
    it('takes everything after the LAST " b/"', () => {
        expect(displayPath('diff --git a/src/a.ts b/src/a.ts')).toBe('src/a.ts');
        expect(displayPath('diff --git a/x b/y b/z')).toBe('z');
    });

    it('falls back to the whole header line when " b/" is absent', () => {
        expect(displayPath('diff --git weird')).toBe('diff --git weird');
    });
});

describe('renderDiffBody', () => {
    it('renders the empty placeholder for an empty or whitespace-only diff', () => {
        expect(renderDiffBody('')).toBe(EMPTY_DIFF_HTML);
        expect(renderDiffBody('\n \n')).toBe(EMPTY_DIFF_HTML);
        expect(EMPTY_DIFF_HTML).toContain('<div class="empty">No changes</div>');
    });

    it('emits one open <details> per file with a sticky summary and hunks wrappers', () => {
        const html = renderDiffBody(MODIFIED);
        expect(html).toContain('<div class="diff">');
        expect(html).toContain('<details class="file" open>');
        expect(html).toContain('<summary class="file-summary">');
        expect(html).toContain('<span class="caret"></span>');
        expect(html).toContain('<span class="file-path">src/a.ts</span>');
        expect(html).toContain('<span class="file-status status-modified">modified</span>');
        expect(html).toContain(
            '<span class="diff-stats"><span class="stat-add">+2</span><span class="stat-del">-1</span></span>'
        );
        expect(html).toContain('<div class="hunks"><div class="hunks-inner">');
    });

    it('includes the `diff --git` line itself as a file-header row (§11)', () => {
        expect(renderDiffBody(MODIFIED)).toContain(
            '<div class="line line-file-header">diff --git a/src/a.ts b/src/a.ts</div>'
        );
    });

    it('classifies every line into line-CLASS divs and escapes them', () => {
        const html = renderDiffBody('diff --git a/x b/x\n@@ -1 +1 @@\n-<a>\n+"b" & c\n ok');
        expect(html).toContain('<div class="line line-hunk">@@ -1 +1 @@</div>');
        expect(html).toContain('<div class="line line-del">-&lt;a&gt;</div>');
        expect(html).toContain('<div class="line line-add">+&quot;b&quot; &amp; c</div>');
        expect(html).toContain('<div class="line line-context"> ok</div>');
    });

    it('omits the stats span for a pure rename', () => {
        const html = renderDiffBody(
            'diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new'
        );
        expect(html).toContain('status-renamed');
        expect(html).not.toContain('diff-stats');
    });

    it('renders preamble lines loose, outside any <details>', () => {
        const html = renderDiffBody(`warning: x\n${MODIFIED}`);
        expect(html.indexOf('<div class="line line-context">warning: x</div>')).toBeLessThan(
            html.indexOf('<details')
        );
    });

    it('renders a git failure as loose text through the normal renderer (§5.1)', () => {
        const html = renderDiffBody(gitFailureText('/repo', 'fatal: not a git repository'));
        expect(html).toContain('<div class="diff">');
        expect(html).toContain('Failed to run git diff in /repo:');
        expect(html).toContain('fatal: not a git repository');
        expect(html).not.toContain('<details');
    });
});

describe('renderDiffDocument', () => {
    it('uses the shared document wrapper with no #content div', () => {
        const html = renderDiffDocument(MODIFIED, { backgroundColor: '#FFFFFF' });
        expect(html.startsWith('<!DOCTYPE html>\n')).toBe(true);
        expect(html).toContain('<html class="light">');
        expect(html).not.toContain('id="content"');
    });

    it('substitutes the base font size', () => {
        expect(diffStylesheet(13)).toContain('font-size: 13px;');
        expect(renderDiffDocument('', { baseFontSize: 17 })).toContain('font-size: 17px;');
    });

    it('carries the sticky-summary and line-class rules', () => {
        const style = diffStylesheet(13);
        for (const rule of [
            'details.file > summary {',
            'position: sticky;',
            '.hunks { overflow-x: auto; }',
            '.hunks-inner { display: inline-block; min-width: 100%; }',
            '.line-add',
            '.line-del',
            '.line-hunk',
            '.line-file-header',
            '.status-renamed',
            'background-color: transparent;'
        ]) {
            expect(style).toContain(rule);
        }
    });
});

/*
 * SPACING-REVIEW S41 — **owner-directed divergence**, and the only one in this stylesheet.
 *
 * `DiffHTMLRenderer.swift:298-315` declares the file header's flex row and nothing else: no
 * `min-width: 0` on `.file-path`, no `text-overflow`, no `flex-shrink` on the badge or the
 * counts. The port transcribed it rule for rule, so the row is parity rather than drift. It is
 * also the wrong rule set in a split, because with nothing able to yield the whole cluster runs
 * off the end and `overflow-x: hidden` cuts it. Measured live before the fix, at the register's
 * own **161 px** summary: `.diff-stats` ended **65 px past** the summary's right edge (gone
 * entirely) and the status badge 20 px past it (`MODIFIED` cut mid-word), while `.file-path` sat
 * at its full 75.86 px having given up nothing. After, at the same 161 px: the badge and the
 * counts are both inside, and the path is what yields.
 *
 * This test exists so that a later parity sweep re-reporting the Swift's own rule set — a path
 * with no `min-width` and a badge with no `flex-shrink` — fails here first.
 */
describe('diffStylesheet — the file header’s fit (S41, owner-directed)', () => {
    it('lets the PATH yield, with an ellipsis, and nothing else', () => {
        const style = diffStylesheet(13);
        expect(style).toContain('min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;');
        // The parity value: a `.file-path` rule that is font declarations only.
        expect(style).not.toContain(
            ".file-path { font-family: 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace; font-weight: 500; }"
        );
    });

    it('pins the status badge and the +N −N counts, which were the first things lost', () => {
        const style = diffStylesheet(13);
        // Two rules, one property each — asserted by count so neither can quietly go.
        expect(style.match(/flex-shrink: 0;/g)?.length).toBe(2);
        const status = style.slice(style.indexOf('.file-status {'), style.indexOf('.status-added'));
        expect(status).toContain('flex-shrink: 0;');
        const stats = style.slice(style.indexOf('.diff-stats {'), style.indexOf('.stat-add'));
        expect(stats).toContain('flex-shrink: 0;');
    });

    it('leaves the row’s own Swift metrics exactly where §5.4 put them', () => {
        const style = diffStylesheet(13);
        expect(style).toContain('padding: 6px 16px;');
        expect(style).toContain('gap: 8px;');
        expect(style).toContain('margin-left: auto;');
        expect(style).toContain('overflow-x: hidden;');
    });
});
