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

/**
 * §3.13's highlight palette — the Swift `NexGhosttyDefaults` search colours.
 *
 * These are the DEFAULTS, not the values: SET-219/TERM-021 make all four user-overridable
 * through the nex config (`search-match-color`, `search-match-text-color`,
 * `search-match-current-color`, `search-match-current-text-color`), and `FindPalette` is how
 * an override reaches the injected script. A caller that passes none gets exactly these, which
 * is what the Swift defaults file gave a user who never edited their ghostty config.
 */
export const FIND_MATCH_COLOR = '#F2D027';
export const FIND_MATCH_TEXT_COLOR = '#000000';
export const FIND_CURRENT_COLOR = '#FF7A00';
export const FIND_CURRENT_TEXT_COLOR = '#000000';

/** The four colours the injected find script paints its marks with. */
export interface FindPalette {
    readonly match: string;
    readonly matchText: string;
    readonly current: string;
    readonly currentText: string;
}

export const DEFAULT_FIND_PALETTE: FindPalette = {
    match: FIND_MATCH_COLOR,
    matchText: FIND_MATCH_TEXT_COLOR,
    current: FIND_CURRENT_COLOR,
    currentText: FIND_CURRENT_TEXT_COLOR
};

/**
 * A colour safe to interpolate into the injected stylesheet.
 *
 * The values arrive from a config FILE the daemon parsed, and they are pasted into a `<style>`
 * inside a sandboxed document — so anything that is not a plain `#rrggbb` is replaced by the
 * default rather than escaped. There is no legitimate search colour that needs a `;` in it.
 */
function safeCssColor(value: string | undefined, fallback: string): string {
    if (typeof value !== 'string') return fallback;
    const trimmed = value.trim();
    return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed : fallback;
}

/** The palette with every field validated; unusable entries fall back to the Swift default. */
export function resolveFindPalette(palette?: Partial<FindPalette> | undefined): FindPalette {
    return {
        match: safeCssColor(palette?.match, FIND_MATCH_COLOR),
        matchText: safeCssColor(palette?.matchText, FIND_MATCH_TEXT_COLOR),
        current: safeCssColor(palette?.current, FIND_CURRENT_COLOR),
        currentText: safeCssColor(palette?.currentText, FIND_CURRENT_TEXT_COLOR)
    };
}

/** What the host asks the document's `__nexFind` namespace to do (§3.13). */
export type FindOp = 'search' | 'next' | 'prev' | 'clear';

/** Every operation answers with this; `current` is -1 when there are no matches. */
export interface FindResult {
    readonly total: number;
    readonly current: number;
}

export type ContentBridgeMessage =
    | { readonly kind: 'ready' }
    | { readonly kind: 'focus' }
    | { readonly kind: 'scroll'; readonly top: number; readonly fraction: number }
    | { readonly kind: 'copy'; readonly text: string }
    | { readonly kind: 'link'; readonly href: string }
    | { readonly kind: 'toggle-edit' }
    /** ⌘F inside the preview — the host's key interceptor cannot see through the iframe. */
    | { readonly kind: 'find-open' }
    | { readonly kind: 'find-result'; readonly total: number; readonly current: number }
    /** Right-click inside the preview; the host opens the copy menu at these coordinates. */
    | { readonly kind: 'context-menu'; readonly x: number; readonly y: number }
    /** §3.14 "Copy as Rich Text": the cleaned `#content` HTML plus its flattened text. */
    | { readonly kind: 'rich-text'; readonly token: string; readonly html: string; readonly text: string };

/** Host → frame. `top` wins when both are present (§3.11 same-document reload precedence). */
export type ContentHostMessage =
    | {
          readonly source: typeof CONTENT_HOST_SOURCE;
          readonly kind: 'scroll-to';
          readonly top?: number | undefined;
          readonly fraction?: number | undefined;
      }
    | {
          readonly source: typeof CONTENT_HOST_SOURCE;
          readonly kind: 'find';
          readonly op: FindOp;
          readonly needle?: string | undefined;
      }
    | {
          readonly source: typeof CONTENT_HOST_SOURCE;
          readonly kind: 'collect-rich-text';
          readonly token: string;
      }
    /** Whether a right-click has a host menu to show; false leaves the native menu alone. */
    | {
          readonly source: typeof CONTENT_HOST_SOURCE;
          readonly kind: 'copy-menu';
          readonly enabled: boolean;
      };

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
        case 'find-open':
            return { kind: 'find-open' };
        case 'find-result':
            return { kind: 'find-result', total: finite(data['total']), current: finite(data['current']) };
        case 'context-menu':
            return { kind: 'context-menu', x: finite(data['x']), y: finite(data['y']) };
        case 'rich-text': {
            const token = data['token'];
            const html = data['html'];
            const text = data['text'];
            if (typeof token !== 'string' || typeof html !== 'string') return null;
            return { kind: 'rich-text', token, html, text: typeof text === 'string' ? text : '' };
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
    /**
     * An OPAQUE color painted on the document's own `<html>` (see `frameBaseStyle`). Absent
     * leaves the daemon's transparent document alone, which is only correct for a frame that
     * is not sandboxed into its own process.
     */
    readonly background?: string | null | undefined;
    /** `dark`/`light` for the frame's `color-scheme` (UA widgets, scrollbars, form controls). */
    readonly colorScheme?: 'dark' | 'light' | undefined;
    /** SET-219's overridable find-highlight colours; absent = the Swift defaults. */
    readonly findPalette?: Partial<FindPalette> | undefined;
}

/**
 * The one stylesheet the CLIENT adds to the daemon's document, and the reason it has to exist.
 *
 * content-panes.md §3.8 makes the document transparent and has the **pane container** paint
 * `rgba(ghostty-bg, opacity)` behind it, so a content pane blends with the terminal beside it.
 * That contract is written for a WKWebView, which can be non-opaque. This client shows the
 * document in an iframe sandboxed to `allow-scripts` — an **opaque origin**, which Chromium
 * isolates into its own process. An out-of-process frame composites its own surface and does not
 * inherit the embedder's transparency: it paints over Chromium's **white base background**, and
 * `background: transparent` on the `<iframe>` element cannot reach across the process boundary.
 * The result was a dark-theme document (dark ink, dark table headers) on a white canvas.
 *
 * So the client gives the FRAME a real background instead: the same two colors the pane
 * container composites (`--nex-term-bg` = ghostty background at ghostty opacity, over the window
 * fill), flattened to one opaque value by `chrome/theme.ts`'s `flattenOver` and painted on
 * `<html>`. `body { background-color: transparent }` then propagates it to the canvas, so the
 * daemon's HTML contract is untouched — a client that CAN composite (a future non-sandboxed
 * embedder, another app) simply does not pass a background and gets the transparent document.
 *
 * `color-scheme` rides along because it is the same question asked of the UA: it decides the
 * default canvas, the scrollbars and any form control the document contains.
 */
export function frameBaseStyle(background: string, colorScheme: 'dark' | 'light'): string {
    // `html` rather than `body`: the daemon's stylesheet owns `body`, and a document whose body
    // is shorter than the viewport would leave the rest of the canvas unpainted.
    return `<style data-nex-frame-base="1">html{background-color:${background};color-scheme:${colorScheme};}</style>`;
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

    const background = options.background ?? null;
    if (background !== null && background.length > 0) {
        // AFTER the daemon's `<style>`, so a future rule of the same specificity resolves our
        // way — the frame being opaque is a correctness requirement here, not a preference.
        const style = `${frameBaseStyle(background, options.colorScheme ?? 'dark')}\n`;
        const headEnd = document.search(/<\/head\s*>/i);
        if (headEnd >= 0) document = document.slice(0, headEnd) + style + document.slice(headEnd);
        else document = style + document;
    }

    const script = `<script>\n${contentBridgeScript(options.paneID, options.findPalette)}\n</script>\n`;
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
export function contentBridgeScript(paneID: string, findPalette?: Partial<FindPalette> | undefined): string {
    const id = JSON.stringify(paneID);
    const find = resolveFindPalette(findPalette);
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
  // ⌘F is the same problem for the find bar, and Escape closes it from inside the document.
  document.addEventListener('keydown', function (event) {
    if ((event.metaKey || event.ctrlKey) && (event.key === 'e' || event.key === 'E')) {
      event.preventDefault();
      post({ kind: 'toggle-edit' });
      return;
    }
    if ((event.metaKey || event.ctrlKey) && (event.key === 'f' || event.key === 'F')) {
      event.preventDefault();
      post({ kind: 'find-open' });
    }
  });

  // §3.14 — the two copy commands are also reachable from the preview's context menu; the
  // host owns the menu because the frame has no chrome of its own to draw one in.
  //
  // The suppression is CONDITIONAL on the host actually having a menu to show (it says so
  // with a copy-menu message): a diff pane, or a markdown pane whose load failed, has no copy
  // commands, and taking the browser's own menu away there would leave a right-click doing
  // nothing at all.
  var copyMenuEnabled = false;
  document.addEventListener('contextmenu', function (event) {
    if (!copyMenuEnabled) return;
    event.preventDefault();
    var box = { left: 0, top: 0 };
    try { box = document.documentElement.getBoundingClientRect(); } catch (error) { /* detached */ }
    post({ kind: 'context-menu', x: event.clientX - box.left, y: event.clientY - box.top });
  });

  // §3.14 "Copy as Rich Text": the RENDERED DOM, minus the front-matter table (it breaks the
  // RTF conversion) and the copy buttons (they leak in as a stray glyph). Relative URLs are
  // absolutized against the document's own base so a sibling image survives the paste.
  var collectRichText = function (token) {
    var source = document.getElementById('content') || document.body;
    var clone = source ? source.cloneNode(true) : null;
    if (!clone) { post({ kind: 'rich-text', token: token, html: '', text: '' }); return; }
    var drop = clone.querySelectorAll('.frontmatter, .frontmatter-raw, .frontmatter-nested, .code-copy-btn');
    for (var i = 0; i < drop.length; i += 1) {
      if (drop[i].parentNode) drop[i].parentNode.removeChild(drop[i]);
    }
    var resolve = function (selector, attribute) {
      var nodes = clone.querySelectorAll(selector);
      for (var j = 0; j < nodes.length; j += 1) {
        var raw = nodes[j].getAttribute(attribute);
        if (!raw) continue;
        try { nodes[j].setAttribute(attribute, new URL(raw, document.baseURI).href); }
        catch (error) { /* leave an unresolvable value as-is */ }
      }
    };
    resolve('[src]', 'src');
    resolve('a[href]', 'href');
    post({ kind: 'rich-text', token: token, html: clone.innerHTML, text: clone.textContent || '' });
  };

  // §3.13 — find-in-page. The host owns the overlay and the needle; this owns the marks.
  var findState = { marks: [], current: -1 };
  var FIND_STYLE_ID = '__nex-find-style';
  var ensureFindStyle = function () {
    if (document.getElementById(FIND_STYLE_ID)) return;
    var head = document.head || document.documentElement;
    if (!head) return;
    var style = document.createElement('style');
    style.id = FIND_STYLE_ID;
    style.textContent =
      'mark.nex-find-match{background:${find.match};color:${find.matchText};border-radius:2px;padding:0}' +
      'mark.nex-find-match.nex-find-current{background:${find.current};color:${find.currentText}}';
    head.appendChild(style);
  };
  var clearMarks = function () {
    for (var m = 0; m < findState.marks.length; m += 1) {
      var mark = findState.marks[m];
      var parent = mark.parentNode;
      if (!parent) continue;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      if (parent.normalize) parent.normalize();
    }
    findState.marks = [];
    findState.current = -1;
  };
  var reportFind = function () {
    post({ kind: 'find-result', total: findState.marks.length, current: findState.current });
  };
  var showCurrent = function () {
    for (var i = 0; i < findState.marks.length; i += 1) {
      var mark = findState.marks[i];
      if (i === findState.current) mark.classList.add('nex-find-current');
      else mark.classList.remove('nex-find-current');
    }
    var active = findState.marks[findState.current];
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'center' });
  };
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, MARK: 1 };
  var textNodes = function () {
    var found = [];
    if (!document.body || !document.createTreeWalker) return found;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var node = walker.nextNode();
    while (node) {
      var parent = node.parentNode;
      var skip = false;
      while (parent && parent !== document.body) {
        if (SKIP[parent.nodeName]) { skip = true; break; }
        parent = parent.parentNode;
      }
      if (!skip && node.nodeValue) found.push(node);
      node = walker.nextNode();
    }
    return found;
  };
  var search = function (needle) {
    clearMarks();
    if (!needle) { reportFind(); return; }
    ensureFindStyle();
    // Literal substring with case folding done by the engine: lowercasing the haystack would
    // drift the offsets for characters whose case change alters their length.
    var escaped = needle.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
    var nodes = textNodes();
    for (var n = 0; n < nodes.length; n += 1) {
      var node = nodes[n];
      var value = node.nodeValue || '';
      var pattern = new RegExp(escaped, 'gi');
      var pieces = document.createDocumentFragment();
      var last = 0;
      var match = pattern.exec(value);
      var any = false;
      while (match) {
        if (match[0].length === 0) { pattern.lastIndex += 1; match = pattern.exec(value); continue; }
        any = true;
        if (match.index > last) pieces.appendChild(document.createTextNode(value.slice(last, match.index)));
        var mark = document.createElement('mark');
        mark.className = 'nex-find-match';
        mark.appendChild(document.createTextNode(match[0]));
        pieces.appendChild(mark);
        findState.marks.push(mark);
        last = match.index + match[0].length;
        match = pattern.exec(value);
      }
      if (!any) continue;
      if (last < value.length) pieces.appendChild(document.createTextNode(value.slice(last)));
      if (node.parentNode) node.parentNode.replaceChild(pieces, node);
    }
    findState.current = findState.marks.length > 0 ? 0 : -1;
    showCurrent();
    reportFind();
  };
  var step = function (delta) {
    if (findState.marks.length === 0) { reportFind(); return; }
    findState.current = (findState.current + delta + findState.marks.length) % findState.marks.length;
    showCurrent();
    reportFind();
  };
  window.__nexFind = {
    search: search,
    next: function () { step(1); },
    prev: function () { step(-1); },
    clear: function () { clearMarks(); reportFind(); }
  };

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
    if (data.kind === 'find') {
      if (data.op === 'search') search(typeof data.needle === 'string' ? data.needle : '');
      else if (data.op === 'next') step(1);
      else if (data.op === 'prev') step(-1);
      else if (data.op === 'clear') { clearMarks(); reportFind(); }
      return;
    }
    if (data.kind === 'collect-rich-text') {
      collectRichText(typeof data.token === 'string' ? data.token : '');
      return;
    }
    if (data.kind === 'copy-menu') {
      copyMenuEnabled = data.enabled === true;
      return;
    }
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
