import { describe, expect, it } from 'vitest';

import {
    DEFAULT_MARKDOWN_FONT_SIZE,
    FRONT_MATTER_BYTE_LIMIT,
    autolinkText,
    extractFrontMatter,
    fileLoadErrorMarkdown,
    markdownStylesheet,
    renderFrontMatter,
    renderMarkdownBody,
    renderMarkdownDocument
} from './markdown.js';

// ---------------------------------------------------------------------------
// Front matter (§3.5)
// ---------------------------------------------------------------------------

describe('extractFrontMatter', () => {
    it('splits a fenced block from the body', () => {
        const result = extractFrontMatter('---\ntitle: x\n---\n# Head\n');
        expect(result.yaml).toBe('title: x');
        expect(result.body).toBe('# Head\n');
    });

    it('accepts a `...` closing fence and trailing spaces on both fences', () => {
        const result = extractFrontMatter('---  \na: 1\n...\t\nbody\n');
        expect(result.yaml).toBe('a: 1');
        expect(result.body).toBe('body\n');
    });

    it('strips a leading BOM before checking the opening fence', () => {
        const result = extractFrontMatter('﻿---\na: 1\n---\nbody');
        expect(result.yaml).toBe('a: 1');
        expect(result.body).toBe('body');
    });

    it('keeps the ORIGINAL string (BOM included) as the body when there is no front matter', () => {
        const source = '﻿# Head';
        expect(extractFrontMatter(source)).toEqual({ yaml: null, body: source });
    });

    it('handles CRLF and CR line terminators', () => {
        expect(extractFrontMatter('---\r\na: 1\r\n---\r\nbody').yaml).toBe('a: 1');
        expect(extractFrontMatter('---\ra: 1\r---\rbody').yaml).toBe('a: 1');
        expect(extractFrontMatter('---\r\na: 1\r\n---\r\nbody').body).toBe('body');
    });

    it('never matches an indented fence', () => {
        const source = ' ---\na: 1\n---\nbody';
        expect(extractFrontMatter(source)).toEqual({ yaml: null, body: source });
    });

    it('requires `---` (not `...`) to OPEN', () => {
        const source = '...\na: 1\n---\nbody';
        expect(extractFrontMatter(source).yaml).toBeNull();
    });

    it('treats EOF without a closing fence as no front matter', () => {
        const source = '---\na: 1\n';
        expect(extractFrontMatter(source)).toEqual({ yaml: null, body: source });
    });

    it('yields an empty yaml string and a fence-free body for `---\\n---`', () => {
        const result = extractFrontMatter('---\n---\nbody');
        expect(result.yaml).toBe('');
        expect(result.body).toBe('body');
    });

    it('yields an empty body when the closing fence is the last line', () => {
        expect(extractFrontMatter('---\na: 1\n---\n').body).toBe('');
        expect(extractFrontMatter('---\na: 1\n---').body).toBe('');
    });

    it('bails past the 64 KiB scan guard and treats everything as markdown', () => {
        const filler = `${'x'.repeat(1023)}\n`.repeat(Math.ceil(FRONT_MATTER_BYTE_LIMIT / 1024) + 1);
        const source = `---\n${filler}---\nbody`;
        expect(extractFrontMatter(source)).toEqual({ yaml: null, body: source });
    });

    it('counts UTF-8 BYTES, not characters, toward the guard', () => {
        // Just under the limit in bytes → still extracted.
        const line = `${'é'.repeat(500)}\n`; // 1000 bytes + newline
        const filler = line.repeat(60); // ~60 KiB
        const result = extractFrontMatter(`---\n${filler}---\nbody`);
        expect(result.yaml).not.toBeNull();
        expect(result.body).toBe('body');
    });
});

// ---------------------------------------------------------------------------
// Front-matter rendering (§3.6)
// ---------------------------------------------------------------------------

describe('renderFrontMatter', () => {
    it('renders nothing for blank yaml or an empty mapping', () => {
        expect(renderFrontMatter('')).toBe('');
        expect(renderFrontMatter('   \n')).toBe('');
        expect(renderFrontMatter('{}')).toBe('');
    });

    it('emits the documented two-column table in document order', () => {
        expect(renderFrontMatter('title: Hello\nauthor: Ben')).toBe(
            '<table class="frontmatter">\n' +
                '<tbody>\n' +
                '<tr><th scope="row">title</th><td>Hello</td></tr>\n' +
                '<tr><th scope="row">author</th><td>Ben</td></tr>\n' +
                '</tbody>\n' +
                '</table>\n'
        );
    });

    it('joins an all-single-line-scalar sequence with ", "', () => {
        expect(renderFrontMatter('tags:\n  - a\n  - b')).toContain('<td>a, b</td>');
    });

    it('nests a mapping value in a frontmatter-nested pre', () => {
        const html = renderFrontMatter('nested:\n  x: 1\n  y: 2');
        expect(html).toContain('<td><pre class="frontmatter-nested">x: 1\ny: 2</pre></td>');
    });

    it('nests a multi-line scalar', () => {
        expect(renderFrontMatter('block: |\n  one\n  two')).toContain(
            '<pre class="frontmatter-nested">'
        );
    });

    it('renders an alias as its YAML source form', () => {
        expect(renderFrontMatter('a: &x 1\nb: *x')).toContain('<td>*x</td>');
    });

    it('escapes keys and values', () => {
        expect(renderFrontMatter('"a<b>": "x & \\"y\\""')).toContain(
            '<tr><th scope="row">a&lt;b&gt;</th><td>x &amp; &quot;y&quot;</td></tr>'
        );
    });

    it('falls back to an escaped raw block on malformed YAML', () => {
        const html = renderFrontMatter('a: [1, 2\nb: :');
        expect(html).toBe('<pre class="frontmatter-raw">a: [1, 2\nb: :</pre>\n');
    });

    it('falls back to a raw block when the root is not a mapping', () => {
        expect(renderFrontMatter('- a\n- b')).toBe(
            '<pre class="frontmatter-raw">- a\n- b</pre>\n'
        );
        expect(renderFrontMatter('just a string')).toBe(
            '<pre class="frontmatter-raw">just a string</pre>\n'
        );
    });
});

// ---------------------------------------------------------------------------
// Autolinking (§3.4)
// ---------------------------------------------------------------------------

describe('autolinkText', () => {
    it('links only scheme-prefixed runs', () => {
        expect(autolinkText('see https://example.com/a?b=1 now')).toBe(
            'see <a href="https://example.com/a?b=1">https://example.com/a?b=1</a> now'
        );
        expect(autolinkText('http://x.y and ftp://f.z and file:///tmp/a')).toBe(
            '<a href="http://x.y">http://x.y</a> and ' +
                '<a href="ftp://f.z">ftp://f.z</a> and ' +
                '<a href="file:///tmp/a">file:///tmp/a</a>'
        );
        expect(autolinkText('mail mailto:a@b.c')).toBe(
            'mail <a href="mailto:a@b.c">mailto:a@b.c</a>'
        );
    });

    it('leaves bare domains and bare emails alone (NOT GFM autolink semantics)', () => {
        expect(autolinkText('example.com and foo@example.com')).toBe(
            'example.com and foo@example.com'
        );
        expect(autolinkText('www.example.com')).toBe('www.example.com');
    });

    it('is case-insensitive on the scheme', () => {
        expect(autolinkText('HTTPS://EXAMPLE.COM')).toBe(
            '<a href="HTTPS://EXAMPLE.COM">HTTPS://EXAMPLE.COM</a>'
        );
    });

    it('escapes surrounding text and the URL itself', () => {
        expect(autolinkText('a & b https://x/?q=1&r=2')).toBe(
            'a &amp; b <a href="https://x/?q=1&amp;r=2">https://x/?q=1&amp;r=2</a>'
        );
    });

    it('drops trailing sentence punctuation and unbalanced brackets', () => {
        expect(autolinkText('see https://example.com.')).toBe(
            'see <a href="https://example.com">https://example.com</a>.'
        );
        expect(autolinkText('(https://example.com)')).toBe(
            '(<a href="https://example.com">https://example.com</a>)'
        );
        expect(autolinkText('https://en.wikipedia.org/wiki/A_(b)')).toBe(
            '<a href="https://en.wikipedia.org/wiki/A_(b)">https://en.wikipedia.org/wiki/A_(b)</a>'
        );
    });
});

// ---------------------------------------------------------------------------
// Body emission (§3.3)
// ---------------------------------------------------------------------------

describe('renderMarkdownBody', () => {
    it('emits headings and paragraphs', () => {
        expect(renderMarkdownBody('# One\n\ntext\n')).toBe('<h1>One</h1>\n<p>text</p>\n');
        expect(renderMarkdownBody('### Three\n')).toBe('<h3>Three</h3>\n');
    });

    it('wraps code blocks with the copy button contract', () => {
        expect(renderMarkdownBody('```js\nconst x = 1;\n```\n')).toBe(
            '<div class="code-block"><pre><code class="language-js">const x = 1;\n</code></pre>' +
                '<button class="code-copy-btn" type="button" aria-label="Copy code"></button></div>\n'
        );
    });

    it('omits the language class when the fence has no info string', () => {
        expect(renderMarkdownBody('```\nplain\n```\n')).toContain('<pre><code>plain\n</code></pre>');
    });

    it('escapes code contents and the language', () => {
        const html = renderMarkdownBody('```a<b>\n<script>&\n```\n');
        expect(html).toContain('class="language-a&lt;b&gt;"');
        expect(html).toContain('&lt;script&gt;&amp;');
    });

    it('renders task-list items with a disabled checkbox', () => {
        expect(renderMarkdownBody('- [ ] todo\n- [x] done\n')).toBe(
            '<ul>\n' +
                '<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled> <p>todo</p>\n</li>\n' +
                '<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" checked disabled> <p>done</p>\n</li>\n' +
                '</ul>\n'
        );
    });

    it('leaves a non-task list item plain', () => {
        expect(renderMarkdownBody('- plain\n')).toBe('<ul>\n<li><p>plain</p>\n</li>\n</ul>\n');
    });

    it('emits an ordered list start only when it is not 1', () => {
        expect(renderMarkdownBody('1. a\n')).toContain('<ol>\n');
        expect(renderMarkdownBody('3. a\n')).toContain('<ol start="3">\n');
    });

    it('emits GFM tables with th/td and no alignment attributes', () => {
        expect(renderMarkdownBody('| a | b |\n|:--|--:|\n| 1 | 2 |\n')).toBe(
            '<table>\n<thead>\n<tr><th>a</th><th>b</th></tr>\n</thead>\n' +
                '<tbody>\n<tr><td>1</td><td>2</td></tr>\n</tbody>\n</table>\n'
        );
    });

    it('renders strikethrough as <del> and inline code escaped', () => {
        expect(renderMarkdownBody('~~gone~~ and `a<b>`\n')).toBe(
            '<p><del>gone</del> and <code>a&lt;b&gt;</code></p>\n'
        );
    });

    it('passes raw HTML through unescaped', () => {
        expect(renderMarkdownBody('<div class="x">raw & wild</div>\n')).toBe(
            '<div class="x">raw & wild</div>\n'
        );
        expect(renderMarkdownBody('text <b>bold</b>\n')).toBe('<p>text <b>bold</b></p>\n');
    });

    it('suppresses autolinking inside links and image alt text', () => {
        expect(renderMarkdownBody('[https://example.com](https://other.example)\n')).toBe(
            '<p><a href="https://other.example">https://example.com</a></p>\n'
        );
        expect(renderMarkdownBody('![https://example.com](a.png)\n')).toBe(
            '<p><img src="a.png" alt="https://example.com"></p>\n'
        );
    });

    it('autolinks plain text nodes', () => {
        expect(renderMarkdownBody('go to https://example.com now\n')).toBe(
            '<p>go to <a href="https://example.com">https://example.com</a> now</p>\n'
        );
    });

    it('renders images with an optional title and a missing link destination as href=""', () => {
        expect(renderMarkdownBody('![a](b.png "t")\n')).toBe(
            '<p><img src="b.png" alt="a" title="t"></p>\n'
        );
        expect(renderMarkdownBody('[text]()\n')).toBe('<p><a href="">text</a></p>\n');
    });

    it('renders blockquotes, rules and breaks', () => {
        expect(renderMarkdownBody('> quoted\n')).toBe(
            '<blockquote>\n<p>quoted</p>\n</blockquote>\n'
        );
        expect(renderMarkdownBody('---\n')).toBe('<hr>\n');
        expect(renderMarkdownBody('a\nb\n')).toBe('<p>a\nb</p>\n');
        expect(renderMarkdownBody('a  \nb\n')).toBe('<p>a<br>\nb</p>\n');
    });

    it('escapes text nodes', () => {
        expect(renderMarkdownBody('a < b & "c"\n')).toBe('<p>a &lt; b &amp; &quot;c&quot;</p>\n');
    });
});

// ---------------------------------------------------------------------------
// Document wrapper (§3.7, §3.9)
// ---------------------------------------------------------------------------

describe('renderMarkdownDocument', () => {
    it('picks the dark class from the background luminance', () => {
        expect(renderMarkdownDocument('x', { backgroundColor: '#000000' })).toContain(
            '<html class="dark">'
        );
        expect(renderMarkdownDocument('x', { backgroundColor: '#FFFFFF' })).toContain(
            '<html class="light">'
        );
        // 0.299r + 0.587g + 0.114b: pure blue is dark, pure green is light.
        expect(renderMarkdownDocument('x', { backgroundColor: '#0000FF' })).toContain(
            '<html class="dark">'
        );
        expect(renderMarkdownDocument('x', { backgroundColor: '#00FF00' })).toContain(
            '<html class="light">'
        );
    });

    it('defaults to the daemon background (dark) when none is configured', () => {
        expect(renderMarkdownDocument('x')).toContain('<html class="dark">');
    });

    it('wraps front matter + body in #content', () => {
        const html = renderMarkdownDocument('---\na: 1\n---\n# H\n');
        expect(html).toContain('<div id="content">\n<table class="frontmatter">');
        expect(html).toContain('<h1>H</h1>\n</div>\n');
        expect(html.startsWith('<!DOCTYPE html>\n')).toBe(true);
        expect(html).toContain('<meta charset="utf-8">');
        expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    });

    it('emits a base href for relative assets when asked', () => {
        expect(renderMarkdownDocument('x', { baseHref: '/pane-assets/ID/' })).toContain(
            '<base href="/pane-assets/ID/">'
        );
        expect(renderMarkdownDocument('x')).not.toContain('<base');
    });

    it('substitutes the base font size and the code size (BASE - 1, floor 6)', () => {
        expect(markdownStylesheet(DEFAULT_MARKDOWN_FONT_SIZE)).toContain('font-size: 14px;');
        expect(markdownStylesheet(14)).toContain('font-size: 13px;');
        expect(markdownStylesheet(6)).toContain('font-size: 6px;');
        expect(renderMarkdownDocument('x', { baseFontSize: 20 })).toContain('font-size: 20px;');
    });

    it('carries the class names the client JS and CSS depend on', () => {
        const style = markdownStylesheet(14);
        for (const selector of [
            '.code-block',
            '.code-copy-btn',
            '.code-copy-btn.copied',
            'li.task-list-item',
            'input.task-list-item-checkbox',
            'table.frontmatter',
            'pre.frontmatter-raw',
            'pre.frontmatter-nested',
            'background-color: transparent;'
        ]) {
            expect(style).toContain(selector);
        }
    });
});

describe('fileLoadErrorMarkdown', () => {
    it('renders a read failure as a markdown blockquote (§3.11)', () => {
        const html = renderMarkdownBody(fileLoadErrorMarkdown('/tmp/x.md', 'ENOENT'));
        expect(html).toContain('<blockquote>');
        expect(html).toContain('Failed to load file: /tmp/x.md');
        expect(html).toContain('ENOENT');
    });
});
