/**
 * The preview↔host bridge: what runs *inside* a content pane's iframe, and how the host reads
 * what it says (content-panes.md §3.10, §3.11, §3.15, port notes 3–5).
 *
 * The rendered document is untrusted: markdown passes raw HTML through (users rely on inline
 * HTML in notes), so it is displayed in an iframe sandboxed to **`allow-scripts` only**. That
 * combination gives the document an opaque origin — it can run the copy-button script but it
 * cannot reach `window.parent`'s DOM, cookies or storage. `allow-scripts` together with
 * `allow-same-origin` would let a note script the app shell, so the two are never both set.
 *
 * Because the frame is cross-origin, everything the host needs travels as `postMessage`:
 *
 *   frame → host   `ready` (document parsed), `scroll` (position tracking), `copy` (a code
 *                  block's raw text), `link` (a click the host must open externally),
 *                  `focus` (a press inside the pane), `toggle-edit` (⌘E inside the preview)
 *   host  → frame  `scroll-to` (restore a saved position)
 *
 * The `copy` hop replaces the Swift app's `copyCodeBlock` webkit message handler; the host
 * writes the text with `navigator.clipboard.writeText`. The button's own 1.5 s `copied` window
 * and `aria-label` swap stay inside the frame, exactly as §3.10 specifies.
 *
 * One trap for later: a `srcdoc` document inherits the EMBEDDER's Content-Security-Policy. The
 * daemon serves the client without one today, so the injected inline script runs; if a CSP is
 * ever added it has to keep inline script legal for these frames (a nonce cannot be shared with
 * an opaque origin), or the copy button and scroll tracking go quiet with no other symptom.
 */

/** Marks a message as coming from a pane document (host → frame uses the other marker). */
export const CONTENT_BRIDGE_SOURCE = 'nex-content';
export const CONTENT_HOST_SOURCE = 'nex-host';

/** §3.10: how long the copy button shows its checkmark. */
export const COPY_FEEDBACK_MS = 1500;

export type ContentBridgeMessage =
    | { readonly kind: 'ready' }
    | { readonly kind: 'focus' }
    | { readonly kind: 'scroll'; readonly top: number; readonly fraction: number }
    | { readonly kind: 'copy'; readonly text: string }
    | { readonly kind: 'link'; readonly href: string }
    | { readonly kind: 'toggle-edit' };

/** Host → frame. `top` wins when both are present (§3.11 same-document reload precedence). */
export interface ContentHostMessage {
    readonly source: typeof CONTENT_HOST_SOURCE;
    readonly kind: 'scroll-to';
    readonly top?: number | undefined;
    readonly fraction?: number | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Decode a `message` event payload. `paneID` must match: one host listens for every pane, and a
 * frame may only speak for itself.
 */
export function parseBridgeMessage(data: unknown, paneID: string): ContentBridgeMessage | null {
    if (!isRecord(data)) return null;
    if (data['source'] !== CONTENT_BRIDGE_SOURCE) return null;
    if (data['paneID'] !== paneID) return null;

    switch (data['kind']) {
        case 'ready':
            return { kind: 'ready' };
        case 'focus':
            return { kind: 'focus' };
        case 'toggle-edit':
            return { kind: 'toggle-edit' };
        case 'scroll':
            return { kind: 'scroll', top: finite(data['top']), fraction: finite(data['fraction']) };
        case 'copy': {
            const text = data['text'];
            return typeof text === 'string' && text.length > 0 ? { kind: 'copy', text } : null;
        }
        case 'link': {
            const href = data['href'];
            return typeof href === 'string' && href.length > 0 ? { kind: 'link', href } : null;
        }
        default:
            return null;
    }
}

// ── document preparation ────────────────────────────────────────────────────────────

export interface PrepareDocumentOptions {
    readonly paneID: string;
    /** `/pane-assets/<paneID>/` — the daemon's sibling-file route (port note 4). */
    readonly assetBase?: string | null | undefined;
}

function escapeAttribute(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function hasBaseTag(html: string): boolean {
    return /<base\s[^>]*href/i.test(html);
}

/**
 * The daemon's rendered document + the bridge script, and a `<base href>` when the document
 * lacks one.
 *
 * The base matters because the frame is loaded through `srcdoc`: without it a relative
 * `<img src="diagram.png">` would resolve against the *client page's* URL rather than the
 * markdown file's directory, and every sibling image in every note would 404 (port note 4).
 * The daemon already emits the tag for markdown panes; this is the belt to that braces (an
 * older daemon, a diff document, a hand-built fixture).
 */
export function prepareContentDocument(html: string, options: PrepareDocumentOptions): string {
    const base = options.assetBase ?? null;
    let document = html;

    if (base !== null && base.length > 0 && !hasBaseTag(document)) {
        const tag = `<base href="${escapeAttribute(base)}">\n`;
        const head = /<head[^>]*>/i.exec(document);
        if (head !== null) {
            const at = head.index + head[0].length;
            document = `${document.slice(0, at)}\n${tag}${document.slice(at)}`;
        } else {
            document = tag + document;
        }
    }

    const script = `<script>\n${contentBridgeScript(options.paneID)}\n</script>\n`;
    // `lastIndexOf`: a note may legitimately contain the literal text `</body>` inside a code
    // block, and the real end tag is the last one.
    const bodyEnd = document.lastIndexOf('</body>');
    return bodyEnd >= 0 ? document.slice(0, bodyEnd) + script + document.slice(bodyEnd) : document + script;
}

/**
 * The injected script (§3.10 copy button verbatim, plus scroll tracking, link interception and
 * the focus/⌘E forwarding the iframe boundary would otherwise swallow).
 *
 * Written as ES5-flavored plain DOM so it runs unchanged in any engine that renders a pane, and
 * guarded by `__nexContentBridge` so a re-injection is a no-op.
 */
export function contentBridgeScript(paneID: string): string {
    const id = JSON.stringify(paneID);
    return `(function () {
  if (window.__nexContentBridge) return;
  window.__nexContentBridge = true;
  var PANE = ${id};
  var post = function (message) {
    message.source = ${JSON.stringify(CONTENT_BRIDGE_SOURCE)};
    message.paneID = PANE;
    try { parent.postMessage(message, '*'); } catch (error) { /* host is gone */ }
  };

  // §3.10 — one delegated listener; the copied window and the aria-label swap stay local.
  document.addEventListener('click', function (event) {
    var target = event.target;
    var button = target && target.closest ? target.closest('.code-copy-btn') : null;
    if (!button) return;
    if (button.classList.contains('copied')) return;
    var wrap = button.parentNode;
    var code = wrap && wrap.querySelector ? wrap.querySelector(':scope > pre > code') : null;
    var text = code ? code.textContent : '';
    if (!text) return;
    post({ kind: 'copy', text: text });
    button.classList.add('copied');
    var original = button.getAttribute('aria-label') || 'Copy code';
    button.setAttribute('aria-label', 'Copied');
    setTimeout(function () {
      button.classList.remove('copied');
      button.setAttribute('aria-label', original);
    }, ${COPY_FEEDBACK_MS});
  });

  // §3.15 — links never navigate the pane; the host opens them.
  document.addEventListener('click', function (event) {
    if (event.defaultPrevented) return;
    var target = event.target;
    var anchor = target && target.closest ? target.closest('a[href]') : null;
    if (!anchor) return;
    var href = anchor.getAttribute('href') || '';
    if (href.charAt(0) === '#') return;
    event.preventDefault();
    post({ kind: 'link', href: anchor.href || href });
  });

  // §4.3 — a press inside the frame focuses the pane (the host never sees the event).
  document.addEventListener('mousedown', function () { post({ kind: 'focus' }); }, true);

  // ⌘E / ctrl+E inside the preview: the host's key interceptor cannot see it either.
  document.addEventListener('keydown', function (event) {
    if ((event.metaKey || event.ctrlKey) && (event.key === 'e' || event.key === 'E')) {
      event.preventDefault();
      post({ kind: 'toggle-edit' });
    }
  });

  // §3.11 / §9 — continuous position reporting, coalesced to one frame.
  var pending = false;
  var report = function () {
    pending = false;
    var height = document.documentElement ? document.documentElement.scrollHeight : 0;
    var max = Math.max(0, height - window.innerHeight);
    post({ kind: 'scroll', top: window.scrollY, fraction: max > 0 ? window.scrollY / max : 0 });
  };
  window.addEventListener('scroll', function () {
    if (pending) return;
    pending = true;
    if (window.requestAnimationFrame) window.requestAnimationFrame(report);
    else setTimeout(report, 16);
  }, { passive: true });

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.source !== ${JSON.stringify(CONTENT_HOST_SOURCE)}) return;
    if (data.kind !== 'scroll-to') return;
    var height = document.documentElement ? document.documentElement.scrollHeight : 0;
    var max = Math.max(0, height - window.innerHeight);
    var top = typeof data.top === 'number' && data.top > 0
      ? data.top
      : (typeof data.fraction === 'number' ? data.fraction * max : 0);
    window.scrollTo(0, top);
  });

  post({ kind: 'ready' });
})();`;
}

// ── host-side effects ───────────────────────────────────────────────────────────────

/** Schemes a pane document may ask the host to open. `javascript:` is the reason this exists. */
const OPENABLE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);

export interface LinkOpener {
    (href: string): void;
}

/**
 * §3.15: a link click opens outside the pane. The href comes from untrusted content, so the
 * scheme is checked *before* it reaches `window.open` — the host page is the daemon's own
 * origin, and `window.open('javascript:…')` there would execute in it.
 */
export function openExternalLink(href: string, open?: LinkOpener | undefined): boolean {
    let url: URL;
    try {
        url = new URL(href, globalThis.location?.href ?? 'http://localhost/');
    } catch {
        return false;
    }
    if (!OPENABLE_PROTOCOLS.has(url.protocol)) return false;
    if (open !== undefined) {
        open(url.toString());
        return true;
    }
    globalThis.open?.(url.toString(), '_blank', 'noopener,noreferrer');
    return true;
}

export interface ClipboardWriter {
    (text: string): void | Promise<unknown>;
}

/** The host half of the copy button (port note 5). An empty string is ignored (§3.10). */
export function writeClipboardText(text: string, write?: ClipboardWriter | undefined): boolean {
    if (text.length === 0) return false;
    const writer =
        write ??
        ((value: string) => (globalThis.navigator as Navigator | undefined)?.clipboard?.writeText(value));
    try {
        const result = writer(text);
        if (result instanceof Promise) result.catch(() => undefined);
        return true;
    } catch {
        return false;
    }
}
