/**
 * #286: a release's notes, drawn in the update sheet.
 *
 * The notes are the release's markdown. The daemon renders them with the markdown panes' own
 * renderer in its release-notes mode (`daemon/src/content/markdown.ts` ▸ `renderReleaseNotes`: raw
 * HTML escaped, images reduced to alt text, only http(s)/mailto links) and sends the HTML as
 * `notesHTML` beside the markdown. The page is not a preview frame, though: this is the app's own
 * document, so that HTML is NOT put in with `innerHTML`. It is parsed into an inert document
 * (`DOMParser` runs no script and loads nothing) and rebuilt as React elements from an allowlist
 * of tags, with every attribute dropped except a link's href (re-checked) and a list's start. So
 * the daemon's escaping and this rebuild are two independent defences, and a note can never add a
 * script, a handler, a style or a remote load to the app page.
 *
 * Links open in the system browser (`content/bridge.ts` ▸ `openExternalLink`, which the shell
 * routes to `shell.openExternal`), never in the Kelpi window. With no HTML (an older daemon, or a
 * render that failed) the markdown is shown as plain text, which is always safe.
 */

import { Fragment, createElement, type ReactElement, type ReactNode } from 'react';

import { openExternalLink } from '../content/bridge';
import { tokens } from './tokens';

/** Only these schemes become a clickable link; anything else keeps its text. */
const LINK_SCHEME = /^(?:https?:\/\/|mailto:)/i;

/** Tags drawn as themselves, with the classes that give them the sheet's typography. */
const BLOCK_CLASSES: Readonly<Record<string, string>> = {
    h1: 'mt-3 mb-1 text-[13px] font-semibold first:mt-0',
    h2: 'mt-3 mb-1 text-[13px] font-semibold first:mt-0',
    h3: 'mt-2.5 mb-1 text-[12px] font-semibold first:mt-0',
    h4: 'mt-2 mb-1 text-[12px] font-semibold first:mt-0',
    h5: 'mt-2 mb-1 text-[12px] font-semibold first:mt-0',
    h6: 'mt-2 mb-1 text-[12px] font-semibold first:mt-0',
    p: 'my-1.5',
    ul: 'my-1.5 list-disc pl-5',
    ol: 'my-1.5 list-decimal pl-5',
    li: 'my-0.5 [&>p]:my-0',
    blockquote: 'my-1.5 border-l-2 pl-3',
    pre: 'my-1.5 overflow-x-auto rounded px-2.5 py-2 font-mono text-[11px] leading-[1.5]',
    table: 'my-1.5 border-collapse text-[11px]',
    thead: '',
    tbody: '',
    tr: '',
    th: 'border px-2 py-1 text-left font-semibold',
    td: 'border px-2 py-1',
    strong: 'font-semibold',
    em: 'italic',
    del: 'line-through',
    hr: 'my-3 border-0 border-t'
};

export interface ReleaseNotesProps {
    readonly markdown: string;
    readonly html?: string | undefined;
    /** Test seam: how a link is opened (defaults to the system browser). */
    readonly openLink?: ((href: string) => void) | undefined;
}

export function ReleaseNotes(props: ReleaseNotesProps): ReactElement {
    const rebuilt = props.html === undefined ? null : rebuildNotes(props.html, props.openLink);
    return (
        <div data-testid="update-notes" className="text-[12px] leading-[1.55]" style={{ color: tokens.textPrimary }}>
            {rebuilt ?? <div className="whitespace-pre-wrap">{props.markdown}</div>}
        </div>
    );
}

/** The notes HTML as React elements, or null when it cannot be parsed here. */
export function rebuildNotes(html: string, openLink?: ((href: string) => void) | undefined): ReactNode[] | null {
    const Parser = (globalThis as { DOMParser?: typeof DOMParser }).DOMParser;
    if (Parser === undefined) return null;
    let body: HTMLElement | null;
    try {
        body = new Parser().parseFromString(html, 'text/html').body;
    } catch {
        return null;
    }
    if (body === null) return null;
    return children(body, openLink);
}

function children(parent: Node, openLink: ((href: string) => void) | undefined): ReactNode[] {
    const out: ReactNode[] = [];
    parent.childNodes.forEach((child, index) => {
        const node = convert(child, index, openLink);
        if (node !== null) out.push(node);
    });
    return out;
}

function convert(node: Node, key: number, openLink: ((href: string) => void) | undefined): ReactNode {
    // Node.TEXT_NODE / Node.ELEMENT_NODE; comments, processing instructions and the rest vanish.
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return null;
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    const inner = children(element, openLink);
    if (tag === 'a') {
        const href = element.getAttribute('href') ?? '';
        if (!LINK_SCHEME.test(href)) return <Fragment key={key}>{inner}</Fragment>;
        return (
            <a
                key={key}
                href={href}
                title={href}
                className="underline-offset-2 hover:underline"
                style={{ color: tokens.accent }}
                onClick={(event) => {
                    // Never navigate the Kelpi window: the system browser opens it.
                    event.preventDefault();
                    if (openLink !== undefined) openLink(href);
                    else openExternalLink(href);
                }}
            >
                {inner}
            </a>
        );
    }
    if (tag === 'code') {
        // Inside a <pre> the block carries the styling; inline code gets a chip.
        const inBlock = element.parentElement?.tagName.toLowerCase() === 'pre';
        return inBlock ? (
            <code key={key}>{inner}</code>
        ) : (
            <code
                key={key}
                className="rounded px-1 py-px font-mono text-[11px]"
                style={{ background: 'rgba(128,128,128,0.16)' }}
            >
                {inner}
            </code>
        );
    }
    if (tag === 'br') return <br key={key} />;
    if (tag === 'input') {
        // A GFM task item's checkbox: drawn as a glyph, never as a control.
        return (
            <span key={key} aria-hidden="true" className="mr-1">
                {element.hasAttribute('checked') ? '☑' : '☐'}
            </span>
        );
    }
    const classes = BLOCK_CLASSES[tag];
    if (classes === undefined) return <Fragment key={key}>{inner}</Fragment>;
    const style =
        tag === 'pre'
            ? { background: 'rgba(128,128,128,0.12)' }
            : tag === 'blockquote'
              ? { borderColor: tokens.divider, color: tokens.textSecondary }
              : tag === 'th' || tag === 'td' || tag === 'hr'
                ? { borderColor: tokens.divider }
                : undefined;
    if (tag === 'hr') return <hr key={key} className={classes} style={style} />;
    if (tag === 'ol') {
        const start = Number.parseInt(element.getAttribute('start') ?? '', 10);
        return (
            <ol key={key} className={classes} {...(Number.isFinite(start) ? { start } : {})}>
                {inner}
            </ol>
        );
    }
    // `tag` is one of `BLOCK_CLASSES`' keys, so only an allowlisted element is ever created.
    return createElement(tag, { key, className: classes === '' ? undefined : classes, style }, ...inner);
}
