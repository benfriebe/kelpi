/**
 * The injected page scripts (web-pane.md §7) and the evaluation wrappers that call into them.
 *
 * In the Swift app these were `WKUserScript`s registered per tab. Here they are installed once
 * per tab with CDP `Page.addScriptToEvaluateOnNewDocument`, which — unlike WebKit's per-frame
 * `injectionTime` + `forMainFrameOnly` pair — runs the source in **every frame**. So every
 * script that WebKit scoped to the main frame carries the guard the spec's port notes pin:
 *
 *     if (window !== window.top) return;
 *
 * They also keep their `__nexXInstalled` idempotency guards: CDP re-runs the source on every
 * document (including bfcache restores and same-document rebuilds), and a second install would
 * drop an armed picker's listeners on the floor.
 *
 * Authoring shape: each script is a **real TypeScript function** in this file, serialised with
 * `Function.prototype.toString()` and wrapped in an IIFE. That keeps the page code typechecked
 * and diffable instead of living in a string literal, at the cost of one rule — a script may
 * only reference what it defines itself, because module scope does not exist in the page.
 *
 * Deliberately NOT injected:
 *   - the **console** script (§7.1). The port takes the spec's CDP branch instead
 *     (`./console-format.ts`), and installing both would double-report every line.
 */

/** The CDP binding the injected scripts post through (`Runtime.addBinding`). */
export const BINDING_NAME = 'nexPost';
/** Channel names, kept identical to the Swift app's `WKScriptMessageHandler` names. */
export const INSPECT_CHANNEL = 'nexInspect';
export const FIND_CHANNEL = 'nexWebFind';
/** §7.3 batch "element pickup": badge clicks, popover comment edits, dismiss and remove. */
export const BATCH_MARKER_CHANNEL = 'nexBatchMarker';

const BINDING_PLACEHOLDER = '__NEX_BINDING__';

type PageGlobal = Record<string, any>;

/**
 * One script function → the source string CDP injects.
 *
 * The authoring rule (module header) is that a script may only reference what it defines itself,
 * because module scope does not exist in the page. **The bundler can break that rule for us**:
 * esbuild's `keepNames` (on in `scripts/bundle.mjs`, for readable stack traces) rewrites every
 * function it emits as `__name(fn, "fn")`, and `Function.prototype.toString()` carries those
 * calls into the page while the module-scope `__name` helper stays behind — every injected script
 * then dies at install time with `ReferenceError: __name is not defined` (measured against a real
 * Chromium, and invisible to a unit test that only reads the string).
 *
 * So the wrapper defines an identity `__name` in the scope the source is evaluated in. That is
 * bundler-agnostic: unbundled (vitest, tsx) the shim is simply unused. `./scripts.test.ts` guards
 * the rule by rejecting any *other* helper identifier that reaches the page.
 */
function serialize(fn: () => void): string {
    return `(function(){var __name=function(target){return target;};return (${fn.toString()});})()();`;
}

// ── the host↔page bridge ────────────────────────────────────────────────────────────

/**
 * `window.__nexPost(channel, body)` — the one-way channel every other script posts through,
 * plus the `webkit.messageHandlers` shim the spec's port notes suggest so page-side code reads
 * the same as the Swift original. Both resolve the binding lazily: `Runtime.addBinding` installs
 * it on context creation, but a page that clobbers globals must not take the picker down with it.
 */
function bridgeMain(): void {
    const w = window as unknown as PageGlobal;
    if (w.__nexBridgeInstalled) return;
    w.__nexBridgeInstalled = true;

    const post = function (channel: string, body: unknown): void {
        try {
            // The literal below is rewritten to the real binding name when this function is
            // serialised — it must stay a string literal, not a reference to a module const,
            // because module scope does not exist in the page.
            const binding = (window as unknown as PageGlobal)['__NEX_BINDING__'];
            if (typeof binding !== 'function') return;
            binding(JSON.stringify({ channel: channel, body: body }));
        } catch {
            // A page that broke JSON.stringify is not worth crashing the picker over.
        }
    };
    w.__nexPost = post;

    if (w.webkit === undefined) {
        const handlers: PageGlobal = {};
        for (const name of ['nexConsole', 'nexInspect', 'nexBatchMarker', 'nexWebFind']) {
            handlers[name] = {
                postMessage: function (body: unknown): void {
                    post(name, body);
                }
            };
        }
        w.webkit = { messageHandlers: handlers };
    }
}

// ── §7.4 actuator ───────────────────────────────────────────────────────────────────

/* eslint-disable */
function actuatorMain(): void {
    if (window !== window.top) return;
    const w = window as unknown as PageGlobal;
    if (w.__nexActInstalled) return;
    w.__nexActInstalled = true;

    const doc = document;
    const encoder = new TextEncoder();

    function clipToBytes(raw: string, maxBytes: number): { value: string; truncated: boolean } {
        const total = encoder.encode(raw).length;
        if (total <= maxBytes) return { value: raw, truncated: false };
        let out = '';
        let used = 0;
        for (const char of raw) {
            const size = encoder.encode(char).length;
            if (used + size > maxBytes) break;
            out += char;
            used += size;
        }
        return { value: out, truncated: true };
    }

    function fail(error: string): PageGlobal {
        return { ok: false, error: error };
    }

    /** `/pattern/flags` → a RegExp, anything else → null. Bad regex throws. */
    function regexLiteral(raw: string): RegExp | null {
        if (raw.length < 2 || raw.charAt(0) !== '/') return null;
        const end = raw.lastIndexOf('/');
        if (end <= 0) return null;
        return new RegExp(raw.slice(1, end), raw.slice(end + 1));
    }

    function testRegex(re: RegExp, value: string): boolean {
        re.lastIndex = 0; // stateful /g//y flags would skip alternate candidates
        return re.test(value);
    }

    // Deliberately minimal, allowlist-only (§7.4) so `role:textbox` cannot hit a password field.
    function implicitRole(el: Element): string | null {
        const tag = el.tagName.toLowerCase();
        if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
        if (tag === 'button') return 'button';
        if (tag === 'nav') return 'navigation';
        if (tag === 'main') return 'main';
        if (tag === 'header') return 'banner';
        if (tag === 'footer') return 'contentinfo';
        if (tag === 'aside') return 'complementary';
        if (tag === 'article') return 'article';
        if (tag === 'section') return 'region';
        if (tag === 'dialog') return 'dialog';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'select') return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
        if (tag !== 'input') return null;
        const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
        if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image' || type === 'file') {
            return 'button';
        }
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (type === 'search') return 'searchbox';
        if (type === 'number') return 'spinbutton';
        if (type === 'text' || type === 'email' || type === 'tel' || type === 'url') return 'textbox';
        return null;
    }

    function roleOf(el: Element): string | null {
        const explicit = el.getAttribute('role');
        if (explicit !== null && explicit.trim() !== '') return explicit.trim().toLowerCase();
        return implicitRole(el);
    }

    /** Fallback chain, not full AccName (§7.4). */
    function accessibleName(el: Element): string {
        const label = el.getAttribute('aria-label');
        if (label !== null && label.trim() !== '') return label.trim();
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy !== null && labelledBy.trim() !== '') {
            const parts: string[] = [];
            for (const id of labelledBy.trim().split(/\s+/)) {
                const target = doc.getElementById(id);
                if (target !== null) parts.push((target.textContent ?? '').trim());
            }
            const joined = parts.join(' ').trim();
            if (joined !== '') return joined;
        }
        const id = el.getAttribute('id');
        if (id !== null && id !== '') {
            const forLabel = doc.querySelector('label[for="' + (window.CSS ? CSS.escape(id) : id) + '"]');
            if (forLabel !== null) {
                const text = (forLabel.textContent ?? '').trim();
                if (text !== '') return text;
            }
        }
        const alt = el.getAttribute('alt');
        if (alt !== null && alt.trim() !== '') return alt.trim();
        const title = el.getAttribute('title');
        if (title !== null && title.trim() !== '') return title.trim();
        return (el.textContent ?? '').trim();
    }

    interface Parsed {
        kind: 'css' | 'text' | 'role';
        value: string;
        regex: RegExp | null;
        role: string;
        name: string | null;
        error?: string;
    }

    function parseSelector(rawInput: string): Parsed {
        const raw = String(rawInput ?? '').replace(/^\s+/, '');
        const base: Parsed = { kind: 'css', value: raw, regex: null, role: '', name: null };
        if (raw.indexOf('css:') === 0) return { ...base, kind: 'css', value: raw.slice(4) };
        if (raw.indexOf('text:') === 0) {
            const body = raw.slice(5);
            try {
                const re = regexLiteral(body);
                return { ...base, kind: 'text', value: body, regex: re };
            } catch (error: any) {
                return { ...base, kind: 'text', value: body, error: 'bad regex: ' + String(error?.message ?? error) };
            }
        }
        if (raw.indexOf('role:') === 0) {
            const body = raw.slice(5);
            const marker = body.indexOf(':name=');
            if (marker >= 0) {
                return {
                    ...base,
                    kind: 'role',
                    value: body,
                    role: body.slice(0, marker).trim().toLowerCase(),
                    name: body.slice(marker + 6)
                };
            }
            return { ...base, kind: 'role', value: body, role: body.trim().toLowerCase() };
        }
        const head = raw.charAt(0);
        if (head === '.' || head === '#' || head === '[' || head === '>' || head === '*' || head === ':') {
            return base;
        }
        return { ...base, kind: 'text', value: raw };
    }

    function matchesParsed(el: Element, parsed: Parsed): boolean {
        if (parsed.kind === 'text') {
            const text = (el.textContent ?? '').trim();
            if (parsed.regex !== null) return testRegex(parsed.regex, text);
            return text === parsed.value;
        }
        if (roleOf(el) !== parsed.role) return false;
        if (parsed.name === null) return true;
        return accessibleName(el) === parsed.name;
    }

    /** TreeWalker that rejects script/style/template subtrees (§7.4). */
    function walker(): TreeWalker {
        return doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_ELEMENT, {
            acceptNode: function (node: Node): number {
                const tag = (node as Element).tagName.toLowerCase();
                if (tag === 'script' || tag === 'style' || tag === 'template') return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });
    }

    /** Every match, minus any match that encloses another (the smallest-enclosing rule). */
    function collect(parsed: Parsed): Element[] {
        const found: Element[] = [];
        const tw = walker();
        let node = tw.nextNode();
        while (node !== null) {
            if (matchesParsed(node as Element, parsed)) found.push(node as Element);
            node = tw.nextNode();
        }
        return found.filter(function (candidate) {
            return !found.some(function (other) {
                return other !== candidate && candidate.contains(other);
            });
        });
    }

    /** First hit, no descendant check — `exists`'s cheaper walk. */
    function firstHit(parsed: Parsed): Element | null {
        const tw = walker();
        let node = tw.nextNode();
        while (node !== null) {
            if (matchesParsed(node as Element, parsed)) return node as Element;
            node = tw.nextNode();
        }
        return null;
    }

    function findAll(selector: string): Element[] {
        const parsed = parseSelector(selector);
        if (parsed.error !== undefined) throw new Error(parsed.error);
        if (parsed.kind === 'css') {
            return Array.prototype.slice.call(doc.querySelectorAll(parsed.value)) as Element[];
        }
        return collect(parsed);
    }

    function find(selector: string): Element | null {
        const parsed = parseSelector(selector);
        if (parsed.error !== undefined) throw new Error(parsed.error);
        if (parsed.kind === 'css') return doc.querySelector(parsed.value);
        const all = collect(parsed);
        return all.length > 0 ? (all[0] as Element) : null;
    }

    function requireOne(selector: string): Element | PageGlobal {
        let el: Element | null = null;
        try {
            el = find(selector);
        } catch (error: any) {
            return fail(String(error?.message ?? error));
        }
        if (el === null) return fail('no match for selector: ' + selector);
        return el;
    }

    function isFailure(value: unknown): boolean {
        return typeof value === 'object' && value !== null && (value as PageGlobal).ok === false;
    }

    function centerOf(el: Element, at: PageGlobal | null): { x: number; y: number } {
        const rect = el.getBoundingClientRect();
        if (at !== null && typeof at.x === 'number' && typeof at.y === 'number') {
            return { x: rect.left + at.x, y: rect.top + at.y };
        }
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }

    function mouseInit(point: { x: number; y: number }, button: number): PageGlobal {
        return {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            clientX: point.x,
            clientY: point.y,
            button: button,
            buttons: button === 2 ? 2 : 1
        };
    }

    function dispatchPointerSequence(el: Element, point: { x: number; y: number }, button: number): void {
        const init = mouseInit(point, button);
        try {
            el.dispatchEvent(new PointerEvent('pointerdown', init as PointerEventInit));
        } catch {
            /* PointerEvent unsupported: the mouse events below still land. */
        }
        el.dispatchEvent(new MouseEvent('mousedown', init as MouseEventInit));
        try {
            el.dispatchEvent(new PointerEvent('pointerup', init as PointerEventInit));
        } catch {
            /* see above */
        }
        el.dispatchEvent(new MouseEvent('mouseup', init as MouseEventInit));
    }

    function isTypable(el: Element): boolean {
        if ((el as HTMLElement).isContentEditable) return true;
        const tag = el.tagName.toLowerCase();
        if (tag === 'textarea') return true;
        if (tag !== 'input') return false;
        const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
        return (
            [
                'text',
                'search',
                'email',
                'tel',
                'url',
                'password',
                'number',
                'date',
                'datetime-local',
                'time',
                'month',
                'week'
            ].indexOf(type) >= 0
        );
    }

    /** Write through the prototype setter so React/Vue/Svelte controlled inputs accept it. */
    function setValue(el: Element, value: string): void {
        const proto = el.tagName.toLowerCase() === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        if (descriptor !== undefined && typeof descriptor.set === 'function') descriptor.set.call(el, value);
        else (el as HTMLInputElement).value = value;
    }

    const KEYS: PageGlobal = {
        enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
        return: { key: 'Enter', code: 'Enter', keyCode: 13 },
        tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
        escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
        esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
        space: { key: ' ', code: 'Space', keyCode: 32 },
        backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
        delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
        arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
        arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
        arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
        arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
        up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
        down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
        left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
        right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
        home: { key: 'Home', code: 'Home', keyCode: 36 },
        end: { key: 'End', code: 'End', keyCode: 35 },
        pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
        pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 }
    };

    function sendKey(target: Element, entry: PageGlobal): void {
        const init: PageGlobal = {
            key: entry.key,
            code: entry.code,
            keyCode: entry.keyCode,
            which: entry.keyCode,
            bubbles: true,
            cancelable: true,
            composed: true
        };
        target.dispatchEvent(new KeyboardEvent('keydown', init as KeyboardEventInit));
        target.dispatchEvent(new KeyboardEvent('keyup', init as KeyboardEventInit));
    }

    function visible(el: Element): boolean {
        if (!el.isConnected) return false;
        if (el.getClientRects().length === 0) return false;
        return getComputedStyle(el).visibility !== 'hidden';
    }

    const nexAct: PageGlobal = {
        find: find,
        findAll: findAll,

        click: function (selector: string, options?: PageGlobal): PageGlobal {
            const el = requireOne(selector);
            if (isFailure(el)) return el as PageGlobal;
            const element = el as Element;
            const opts = options ?? {};
            const at = opts.at ?? null;
            const point = centerOf(element, at);
            const button = opts.right === true ? 2 : 0;
            dispatchPointerSequence(element, point, button);
            if (opts.right === true) {
                element.dispatchEvent(new MouseEvent('contextmenu', mouseInit(point, 2) as MouseEventInit));
            } else if (at !== null) {
                // Canvas UIs need clientX/Y; the trade-off is documented in §7.4 — no native click.
                element.dispatchEvent(new MouseEvent('click', mouseInit(point, 0) as MouseEventInit));
            } else {
                (element as HTMLElement).click();
                if (opts.double === true) {
                    element.dispatchEvent(new MouseEvent('dblclick', mouseInit(point, 0) as MouseEventInit));
                }
            }
            return { ok: true, matched: true, text: (element.textContent ?? '').trim() };
        },

        type: function (selector: string, text: string, options?: PageGlobal): PageGlobal {
            const el = requireOne(selector);
            if (isFailure(el)) return el as PageGlobal;
            const element = el as HTMLElement;
            const opts = options ?? {};
            const replace = opts.replace !== false;
            if (!isTypable(element)) {
                const type = (element as HTMLInputElement).type ?? '';
                return fail('element is not typable (tag=' + element.tagName.toLowerCase() + ', type=' + type + ')');
            }
            element.focus();
            const value = String(text ?? '');
            if (element.isContentEditable) {
                element.textContent = replace ? value : (element.textContent ?? '') + value;
                element.dispatchEvent(new InputEvent('input', { bubbles: true }));
                if (opts.submit === true) sendKey(element, KEYS.enter);
                return { ok: true, value: element.textContent ?? '' };
            }
            const input = element as HTMLInputElement;
            setValue(input, replace ? value : (input.value ?? '') + value);
            input.dispatchEvent(new InputEvent('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            if (opts.submit === true) {
                sendKey(input, KEYS.enter);
                const form = input.form;
                if (form !== null && typeof form.requestSubmit === 'function') form.requestSubmit();
            }
            return { ok: true, value: input.value };
        },

        text: function (selector: string, options?: PageGlobal): PageGlobal {
            const el = requireOne(selector);
            if (isFailure(el)) return el as PageGlobal;
            const element = el as HTMLElement;
            const maxBytes = typeof options?.maxBytes === 'number' ? options.maxBytes : 1000000;
            const raw = typeof element.innerText === 'string' ? element.innerText : (element.textContent ?? '');
            const clipped = clipToBytes(raw, maxBytes);
            return { ok: true, text: clipped.value, truncated: clipped.truncated };
        },

        attr: function (selector: string, name: string): PageGlobal {
            if (typeof name !== 'string' || name === '') return fail('attribute name is required');
            const el = requireOne(selector);
            if (isFailure(el)) return el as PageGlobal;
            const element = el as Element;
            const present = element.hasAttribute(name);
            const raw = element.getAttribute(name);
            if (!present || raw === null) {
                return { ok: true, name: name, value: null, present: present, truncated: false };
            }
            const clipped = clipToBytes(raw, 65536);
            return { ok: true, name: name, value: clipped.value, present: true, truncated: clipped.truncated };
        },

        count: function (selector: string): PageGlobal {
            try {
                return { ok: true, count: findAll(selector).length };
            } catch (error: any) {
                return fail(String(error?.message ?? error));
            }
        },

        exists: function (selector: string): PageGlobal {
            try {
                const parsed = parseSelector(selector);
                if (parsed.error !== undefined) return { ok: true, found: false };
                if (parsed.kind === 'css') return { ok: true, found: doc.querySelector(parsed.value) !== null };
                return { ok: true, found: firstHit(parsed) !== null };
            } catch {
                return { ok: true, found: false };
            }
        },

        dom: function (selector: string, options?: PageGlobal): PageGlobal {
            const el = requireOne(selector);
            if (isFailure(el)) return el as PageGlobal;
            const maxBytes = typeof options?.maxBytes === 'number' ? options.maxBytes : 16384;
            const clipped = clipToBytes((el as Element).outerHTML, maxBytes);
            return { ok: true, outer_html: clipped.value, truncated: clipped.truncated };
        },

        select: function (selector: string, needle: string): PageGlobal {
            const el = requireOne(selector);
            if (isFailure(el)) return el as PageGlobal;
            const element = el as Element;
            if (element.tagName.toLowerCase() !== 'select') {
                return fail('element is not a <select> (tag=' + element.tagName.toLowerCase() + ')');
            }
            const select = element as HTMLSelectElement;
            const wanted = String(needle ?? '');
            let chosen: HTMLOptionElement | null = null;
            for (const option of Array.prototype.slice.call(select.options) as HTMLOptionElement[]) {
                if (option.value === wanted) {
                    chosen = option;
                    break;
                }
            }
            if (chosen === null) {
                for (const option of Array.prototype.slice.call(select.options) as HTMLOptionElement[]) {
                    if ((option.textContent ?? '').trim() === wanted) {
                        chosen = option;
                        break;
                    }
                }
            }
            if (chosen === null) return fail('no option with value or label: ' + wanted);
            select.focus();
            const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
            if (descriptor !== undefined && typeof descriptor.set === 'function') {
                descriptor.set.call(select, chosen.value);
            } else {
                select.value = chosen.value;
            }
            select.dispatchEvent(new InputEvent('input', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, value: chosen.value, label: (chosen.textContent ?? '').trim() };
        },

        scroll: function (selector: string, options?: PageGlobal): PageGlobal {
            const el = requireOne(selector);
            if (isFailure(el)) return el as PageGlobal;
            const element = el as Element;
            const block = typeof options?.block === 'string' ? options.block : 'center';
            const behavior = typeof options?.behavior === 'string' ? options.behavior : 'instant';
            try {
                element.scrollIntoView({ block: block, behavior: behavior } as ScrollIntoViewOptions);
            } catch {
                element.scrollIntoView();
            }
            if (behavior === 'smooth') return { ok: true, behavior: behavior };
            const rect = element.getBoundingClientRect();
            return {
                ok: true,
                behavior: behavior,
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            };
        },

        hover: function (selector: string): PageGlobal {
            const el = requireOne(selector);
            if (isFailure(el)) return el as PageGlobal;
            const element = el as Element;
            const point = centerOf(element, null);
            const bubbling = { ...mouseInit(point, 0), buttons: 0 };
            const direct = { ...bubbling, bubbles: false };
            try {
                element.dispatchEvent(new PointerEvent('pointerover', bubbling as PointerEventInit));
                element.dispatchEvent(new PointerEvent('pointerenter', direct as PointerEventInit));
            } catch {
                /* PointerEvent unsupported */
            }
            element.dispatchEvent(new MouseEvent('mouseover', bubbling as MouseEventInit));
            element.dispatchEvent(new MouseEvent('mouseenter', direct as MouseEventInit));
            return { ok: true, matched: true };
        },

        key: function (name: string, options?: PageGlobal): PageGlobal {
            const entry = KEYS[String(name ?? '').toLowerCase()];
            if (entry === undefined) return fail('unknown key: ' + String(name));
            let target: Element | null = null;
            const selector = options?.selector;
            if (typeof selector === 'string' && selector !== '') {
                const el = requireOne(selector);
                if (isFailure(el)) return el as PageGlobal;
                target = el as Element;
                (target as HTMLElement).focus();
            } else {
                target = doc.activeElement ?? doc.body;
            }
            if (target === null) return fail('no target for key: ' + String(name));
            sendKey(target, entry);
            return { ok: true, key: entry.key, code: entry.code };
        },

        wait: function (options?: PageGlobal): Promise<PageGlobal> {
            const opts = options ?? {};
            const started = Date.now();
            const timeout = typeof opts.timeout === 'number' && opts.timeout > 0 ? opts.timeout : 10000;
            const selector = typeof opts.selector === 'string' ? opts.selector : null;
            const urlMatch = typeof opts.urlMatch === 'string' ? opts.urlMatch : null;
            const condition = typeof opts.for === 'string' && opts.for !== '' ? opts.for : urlMatch !== null ? 'url-match' : 'exists';

            const needsSelector = condition !== 'url-match';
            if (needsSelector && selector === null) {
                return Promise.resolve(fail('condition ' + condition + ' requires a selector'));
            }
            if (condition === 'url-match' && urlMatch === null) {
                return Promise.resolve(fail('condition url-match requires --url-match'));
            }

            let countTarget = -1;
            if (condition.indexOf('count=') === 0) {
                countTarget = parseInt(condition.slice(6), 10);
                if (!(countTarget >= 0)) return Promise.resolve(fail('bad count in condition: ' + condition));
            }
            let textNeedle: string | null = null;
            let textRegex: RegExp | null = null;
            if (condition.indexOf('text=') === 0) {
                textNeedle = condition.slice(5);
                try {
                    textRegex = regexLiteral(textNeedle);
                } catch (error: any) {
                    return Promise.resolve(fail('bad regex: ' + String(error?.message ?? error)));
                }
            }
            let urlRegex: RegExp | null = null;
            if (urlMatch !== null) {
                try {
                    urlRegex = regexLiteral(urlMatch);
                } catch (error: any) {
                    return Promise.resolve(fail('bad regex: ' + String(error?.message ?? error)));
                }
            }

            const check = function (): boolean {
                if (condition === 'url-match') {
                    const href = location.href;
                    if (urlRegex !== null) return testRegex(urlRegex, href);
                    return href.indexOf(urlMatch as string) >= 0;
                }
                const target = selector as string;
                if (condition === 'visible') {
                    const el = find(target);
                    return el !== null && visible(el);
                }
                if (condition === 'hidden') {
                    const el = find(target);
                    return el === null || !visible(el);
                }
                if (condition === 'exists') {
                    const parsed = parseSelector(target);
                    if (parsed.kind === 'css') return doc.querySelector(parsed.value) !== null;
                    return firstHit(parsed) !== null;
                }
                if (countTarget >= 0) return findAll(target).length === countTarget;
                if (textNeedle !== null) {
                    const el = find(target);
                    if (el === null) return false;
                    const text = (el.textContent ?? '').trim();
                    if (textRegex !== null) return testRegex(textRegex, text);
                    return text === textNeedle;
                }
                return false;
            };

            if (countTarget < 0 && textNeedle === null) {
                const known = ['visible', 'hidden', 'exists', 'url-match'];
                if (known.indexOf(condition) < 0) {
                    return Promise.resolve(fail('unknown wait condition: ' + condition));
                }
            }

            return new Promise(function (resolve) {
                const settle = function (ok: boolean): void {
                    clearInterval(timer);
                    const waited = Date.now() - started;
                    if (ok) resolve({ ok: true, condition: condition, waited_ms: waited });
                    else resolve({ ok: false, error: 'timeout', condition: condition, waited_ms: waited });
                };
                const tick = function (): void {
                    let passed = false;
                    try {
                        passed = check();
                    } catch {
                        passed = false;
                    }
                    if (passed) settle(true);
                    else if (Date.now() - started >= timeout) settle(false);
                };
                const timer = setInterval(tick, 100);
                tick();
            });
        },

        _parseSelector: parseSelector,
        _implicitRole: implicitRole,
        _accessibleName: accessibleName,
        _clipToBytes: clipToBytes
    };

    w.__nexAct = nexAct;
}

// ── §7.2 element picker ─────────────────────────────────────────────────────────────

function inspectorMain(): void {
    if (window !== window.top) return;
    const w = window as unknown as PageGlobal;
    if (w.__nexInspectorInstalled) return;
    w.__nexInspectorInstalled = true;

    const doc = document;
    const OVERLAY_ATTRS = ['data-nex-overlay', 'data-nex-batch-marker', 'data-nex-batch-markers', 'data-nex-batch-popover', 'data-nex-batch-focus-ring'];
    let armed = false;
    let nonce: string | null = null;
    let sticky = false;
    let overlay: HTMLElement | null = null;
    let previousCursor: string | null = null;

    function post(body: PageGlobal): void {
        const poster = w.__nexPost;
        if (typeof poster === 'function') poster('nexInspect', body);
    }

    function isOverlay(node: EventTarget | null): boolean {
        let el = node as Element | null;
        while (el !== null && el.nodeType === 1) {
            for (const attribute of OVERLAY_ATTRS) {
                if (el.hasAttribute(attribute)) return true;
            }
            el = el.parentElement;
        }
        return false;
    }

    function ensureOverlay(): HTMLElement {
        if (overlay !== null && overlay.isConnected) return overlay;
        const node = doc.createElement('div');
        node.setAttribute('data-nex-overlay', '1');
        node.style.cssText = [
            'position:fixed',
            'pointer-events:none',
            'z-index:2147483647',
            'border:2px solid #007AFF',
            'background:rgba(0,122,255,0.18)',
            'transition:all 60ms ease-out',
            'display:none'
        ].join(';');
        (doc.body ?? doc.documentElement).appendChild(node);
        overlay = node;
        return node;
    }

    function drawOverlay(el: Element): void {
        const node = ensureOverlay();
        const rect = el.getBoundingClientRect();
        node.style.display = 'block';
        node.style.left = String(rect.left) + 'px';
        node.style.top = String(rect.top) + 'px';
        node.style.width = String(rect.width) + 'px';
        node.style.height = String(rect.height) + 'px';
    }

    function hideOverlay(): void {
        if (overlay !== null) overlay.style.display = 'none';
    }

    function cssEscape(value: string): string {
        return window.CSS !== undefined && typeof CSS.escape === 'function' ? CSS.escape(value) : value;
    }

    function selectorFor(el: Element): string {
        if (el.id !== '') return '#' + cssEscape(el.id);
        const testid = el.getAttribute('data-testid');
        if (testid !== null && testid !== '') return '[data-testid="' + testid + '"]';
        const test = el.getAttribute('data-test');
        if (test !== null && test !== '') return '[data-test="' + test + '"]';
        const name = el.getAttribute('name');
        if (name !== null && name !== '') return el.tagName.toLowerCase() + '[name="' + name + '"]';

        const parts: string[] = [];
        let current: Element | null = el;
        let depth = 0;
        while (current !== null && depth < 6) {
            const tag = current.tagName.toLowerCase();
            if (current.id !== '') {
                parts.unshift(tag + '#' + cssEscape(current.id));
                break;
            }
            const classes = Array.prototype.slice
                .call(current.classList)
                .slice(0, 2)
                .map(function (name: string) {
                    return '.' + cssEscape(name);
                })
                .join('');
            const node: Element = current;
            const parent: Element | null = node.parentElement;
            let index = 1;
            if (parent !== null) {
                const siblings = (Array.prototype.slice.call(parent.children) as Element[]).filter(
                    function (sibling) {
                        return sibling.tagName === node.tagName;
                    }
                );
                index = siblings.indexOf(node) + 1;
            }
            parts.unshift(tag + classes + ':nth-of-type(' + String(index) + ')');
            current = parent;
            depth += 1;
        }
        return parts.join(' > ');
    }

    function xpathFor(el: Element): string {
        if (el.id !== '') return '//*[@id="' + el.id + '"]';
        const parts: string[] = [];
        let current: Element | null = el;
        while (current !== null && current.nodeType === 1) {
            const node: Element = current;
            const tag = node.tagName.toLowerCase();
            const parent: Element | null = node.parentElement;
            if (parent === null) {
                parts.unshift('/' + tag);
                break;
            }
            const siblings = (Array.prototype.slice.call(parent.children) as Element[]).filter(
                function (sibling) {
                    return sibling.tagName === node.tagName;
                }
            );
            parts.unshift('/' + tag + '[' + String(siblings.indexOf(node) + 1) + ']');
            current = parent;
        }
        return parts.join('');
    }

    function payloadFor(el: Element): PageGlobal {
        const rect = el.getBoundingClientRect();
        const attributes: PageGlobal = {};
        for (const attribute of Array.prototype.slice.call(el.attributes) as Attr[]) {
            attributes[attribute.name] = attribute.value;
        }
        const rawText = (el.textContent ?? '').trim();
        const text = rawText.length > 200 ? rawText.slice(0, 200) + '…' : rawText;
        const parent = el.parentElement;
        const context = parent === null ? '' : parent.outerHTML;
        return {
            nonce: nonce,
            selector: selectorFor(el),
            xpath: xpathFor(el),
            tag: el.tagName.toLowerCase(),
            element_id: el.id ?? '',
            outer_html: el.outerHTML.slice(0, 16384),
            attributes: attributes,
            rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
            text: text,
            context_html: context.slice(0, 4096),
            url: location.href,
            captured_at: new Date().toISOString()
        };
    }

    function onMove(event: MouseEvent): void {
        if (!armed) return;
        if (w.__nexBatchHasOpenPopover === true) {
            hideOverlay();
            return;
        }
        const target = event.target as Element | null;
        if (target === null || isOverlay(target)) return;
        drawOverlay(target);
    }

    function onClick(event: MouseEvent): void {
        if (!armed) return;
        if (isOverlay(event.target)) return;
        if (w.__nexBatchHasOpenPopover === true) return;
        const target = event.target as Element | null;
        if (target === null) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const payload = payloadFor(target);
        if (!sticky) disable();
        post(payload);
    }

    function onKeyDown(event: KeyboardEvent): void {
        if (!armed || event.key !== 'Escape') return;
        if (w.__nexBatchHasOpenPopover === true) return;
        // Snapshot before disable() clears it, or the host drops the cancel.
        const current = nonce;
        disable();
        post({ nonce: current, cancelled: true });
    }

    function enable(nextNonce: string, nextSticky: boolean): boolean {
        if (armed) disable();
        armed = true;
        nonce = String(nextNonce ?? '');
        sticky = nextSticky === true;
        const root = doc.documentElement;
        previousCursor = root.style.cursor;
        root.style.cursor = 'crosshair';
        doc.addEventListener('mousemove', onMove, true);
        doc.addEventListener('click', onClick, true);
        doc.addEventListener('keydown', onKeyDown, true);
        return true;
    }

    function disable(): boolean {
        if (!armed) return true;
        armed = false;
        nonce = null;
        sticky = false;
        doc.removeEventListener('mousemove', onMove, true);
        doc.removeEventListener('click', onClick, true);
        doc.removeEventListener('keydown', onKeyDown, true);
        if (previousCursor !== null) doc.documentElement.style.cursor = previousCursor;
        previousCursor = null;
        hideOverlay();
        return true;
    }

    w.__nexInspectorEnable = enable;
    w.__nexInspectorDisable = disable;
    w.__nexInspectorArmed = function (): boolean {
        return armed;
    };
}

// ── §7.3 batch markers ──────────────────────────────────────────────────────────────

/**
 * The page half of the batch "element pickup" session (WEB-137…WEB-143).
 *
 * A faithful port of `WebPaneBatchMarkerScript.swift`. Four surfaces, all `position:fixed` and
 * all carrying a `data-nex-batch-*` attribute so the picker's `isOverlay()` walk refuses to treat
 * a click on them as a pick:
 *
 *   - **numbered badges**, positioned from a LIVE re-query of each item's selector on every
 *     scroll/resize, so they follow React and responsive reflows rather than a stale rect, and
 *     hidden (not clamped) when the element is collapsed or fully off-screen (WEB-137);
 *   - a **focus ring** around the focused item's element, plus a 320 ms badge scale pulse
 *     (WEB-139);
 *   - a **comment popover**: viewport-centred, below the element when there is room else above,
 *     clamped 8 px from every edge, user-resizable from its bottom-right corner (WEB-140). Its
 *     edits stream out on every `input`, and an external edit is only written back when the
 *     textarea is NOT focused, so neither side clobbers the other's cursor (WEB-141);
 *   - `window.__nexBatchHasOpenPopover`, the cross-script flag the picker reads to suspend
 *     itself while the popover owns the keyboard and the pointer (WEB-143).
 *
 * `setMarkers` is a diff-rebuild that preserves `focusedID` rather than a `clearAll`, and a
 * `highlight` that arrives before its marker exists is parked in `pendingFocusID` and applied on
 * the next sync — without which the ring vanished on every second pick (WEB-138).
 */
function batchMarkerMain(): void {
    if (window !== window.top) return;
    const w = window as unknown as PageGlobal;
    if (w.__nexBatchMarkersInstalled) return;
    w.__nexBatchMarkersInstalled = true;

    const doc = document;
    let markers: PageGlobal = {};
    let container: HTMLElement | null = null;
    let focusRing: HTMLElement | null = null;
    let focusedID: string | null = null;
    let pendingFocusID: string | null = null;
    let popover: HTMLElement | null = null;
    let popoverTextarea: HTMLTextAreaElement | null = null;
    let popoverLabel: HTMLElement | null = null;

    function post(body: PageGlobal): void {
        const poster = w.__nexPost;
        if (typeof poster === 'function') poster('nexBatchMarker', body);
    }

    function queryElement(selector: string): Element | null {
        if (!selector) return null;
        try {
            return doc.querySelector(selector);
        } catch {
            return null;
        }
    }

    function ensureContainer(): HTMLElement {
        if (container !== null && container.isConnected) return container;
        const node = doc.createElement('div');
        node.setAttribute('data-nex-batch-markers', '1');
        node.style.cssText = [
            'position:fixed',
            'top:0',
            'left:0',
            'width:100%',
            'height:100%',
            'pointer-events:none',
            'z-index:2147483646'
        ].join(';');
        (doc.body ?? doc.documentElement).appendChild(node);
        container = node;
        return node;
    }

    function hidePopover(): void {
        if (popover !== null) popover.style.display = 'none';
        w.__nexBatchHasOpenPopover = false;
    }

    function clearFocusRing(): void {
        focusedID = null;
        pendingFocusID = null;
        if (focusRing !== null) {
            focusRing.style.display = 'none';
            focusRing.style.opacity = '0';
        }
    }

    function ensureFocusRing(): HTMLElement {
        if (focusRing !== null && focusRing.isConnected) return focusRing;
        const node = doc.createElement('div');
        node.setAttribute('data-nex-batch-focus-ring', '1');
        node.style.cssText = [
            'position:fixed',
            'pointer-events:none',
            'z-index:2147483645',
            'border:2px solid #007AFF',
            'border-radius:3px',
            'background:rgba(0,122,255,0.12)',
            'box-shadow:0 0 0 1px rgba(255,255,255,0.6), 0 0 12px rgba(0,122,255,0.5)',
            'box-sizing:border-box',
            'transition:left 80ms linear, top 80ms linear, width 80ms linear, height 80ms linear, opacity 120ms linear',
            'display:none',
            'opacity:0'
        ].join(';');
        ensureContainer().appendChild(node);
        focusRing = node;
        return node;
    }

    /** Collapsed (display:none) or entirely outside the viewport: the surfaces hide, never clamp. */
    function offscreen(rect: DOMRect): boolean {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        if (rect.width === 0 && rect.height === 0) return true;
        return rect.bottom <= 0 || rect.right <= 0 || rect.top >= vh || rect.left >= vw;
    }

    function positionFocusRing(): void {
        if (focusedID === null) return;
        const marker = markers[focusedID];
        if (marker === undefined) {
            clearFocusRing();
            return;
        }
        const el = queryElement(marker.selector);
        if (el === null) {
            clearFocusRing();
            return;
        }
        const rect = el.getBoundingClientRect();
        if (offscreen(rect)) {
            if (focusRing !== null) {
                focusRing.style.display = 'none';
                focusRing.style.opacity = '0';
            }
            return;
        }
        const ring = ensureFocusRing();
        ring.style.display = 'block';
        ring.style.opacity = '1';
        ring.style.left = String(rect.left - 3) + 'px';
        ring.style.top = String(rect.top - 3) + 'px';
        ring.style.width = String(rect.width + 6) + 'px';
        ring.style.height = String(rect.height + 6) + 'px';
    }

    function makePopoverButton(label: string, background: string, color: string, border: string): HTMLElement {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.textContent = label;
        btn.style.cssText = [
            'background:' + background,
            'color:' + color,
            'border:' + border,
            'border-radius:4px',
            'padding:3px 10px',
            'font:600 11px -apple-system,system-ui,sans-serif',
            'cursor:pointer',
            'min-width:60px'
        ].join(';');
        btn.addEventListener('mousedown', function (event: Event): void {
            event.stopPropagation();
        });
        return btn;
    }

    function ensurePopover(): HTMLElement {
        if (popover !== null && popover.isConnected) return popover;
        const node = doc.createElement('div');
        node.setAttribute('data-nex-batch-popover', '1');
        node.style.cssText = [
            'position:fixed',
            'display:none',
            'flex-direction:column',
            'box-sizing:border-box',
            'width:280px',
            'min-width:220px',
            'min-height:130px',
            'max-width:90vw',
            'max-height:80vh',
            'resize:both',
            'overflow:hidden',
            'background:#1c1c1e',
            'color:#fff',
            'border:1px solid rgba(255,255,255,0.18)',
            'border-radius:6px',
            'box-shadow:0 6px 24px rgba(0,0,0,0.4)',
            'padding:8px 8px 15px',
            'font:11px -apple-system,system-ui,sans-serif',
            'pointer-events:auto',
            'z-index:2147483647',
            // The picker sets `cursor:crosshair` on documentElement while armed; the popover is
            // a form, so it forces the pointer back.
            'cursor:default'
        ].join(';');

        const label = doc.createElement('div');
        label.style.cssText = [
            'flex:0 0 auto',
            'color:#5AC8FA',
            'font:600 10px/14px ui-monospace,SFMono-Regular,Menlo,monospace',
            'margin-bottom:4px',
            'white-space:nowrap',
            'overflow:hidden',
            'text-overflow:ellipsis'
        ].join(';');
        popoverLabel = label;

        const textarea = doc.createElement('textarea');
        textarea.setAttribute('rows', '3');
        textarea.setAttribute('placeholder', 'Add a comment…');
        textarea.setAttribute('data-nex-batch-comment', '1');
        textarea.style.cssText = [
            'width:100%',
            'box-sizing:border-box',
            'flex:1 1 auto',
            'resize:none',
            'background:rgba(255,255,255,0.06)',
            'color:#fff',
            'border:1px solid rgba(255,255,255,0.18)',
            'border-radius:4px',
            'padding:4px 6px',
            'font:12px -apple-system,system-ui,sans-serif',
            'min-height:48px',
            'outline:none'
        ].join(';');
        textarea.addEventListener('input', function (): void {
            if (focusedID === null) return;
            const marker = markers[focusedID];
            if (marker !== undefined) marker.comment = textarea.value;
            post({ commentChanged: { id: focusedID, comment: textarea.value } });
        });
        textarea.addEventListener('keydown', function (event: KeyboardEvent): void {
            const isEsc = event.key === 'Escape';
            // ⌘-Return is suppressed while an IME is composing, so a CJK candidate is not
            // committed (and truncated) mid-composition.
            const isCmdEnter =
                event.isComposing !== true && event.metaKey && (event.key === 'Enter' || event.key === 'Return');
            if (!isEsc && !isCmdEnter) return;
            event.preventDefault();
            event.stopPropagation();
            if (focusedID !== null) post({ dismiss: { id: focusedID } });
        });
        textarea.addEventListener('click', function (event: Event): void {
            event.stopPropagation();
        });
        textarea.addEventListener('mousedown', function (event: Event): void {
            event.stopPropagation();
        });
        popoverTextarea = textarea;

        const footer = doc.createElement('div');
        footer.style.cssText = [
            'flex:0 0 auto',
            'display:flex',
            'align-items:center',
            'justify-content:space-between',
            'gap:6px',
            'margin-top:6px'
        ].join(';');

        const removeBtn = makePopoverButton('Remove', 'transparent', '#FF6B6B', '1px solid rgba(255,107,107,0.4)');
        removeBtn.addEventListener('click', function (event: Event): void {
            event.preventDefault();
            event.stopPropagation();
            if (focusedID !== null) post({ remove: { id: focusedID } });
        });
        const doneBtn = makePopoverButton('Done', '#007AFF', '#fff', '1px solid #007AFF');
        doneBtn.addEventListener('click', function (event: Event): void {
            event.preventDefault();
            event.stopPropagation();
            if (focusedID !== null) post({ dismiss: { id: focusedID } });
        });

        footer.appendChild(removeBtn);
        footer.appendChild(doneBtn);
        node.appendChild(label);
        node.appendChild(textarea);
        node.appendChild(footer);
        ensureContainer().appendChild(node);
        popover = node;
        return node;
    }

    function positionPopover(): void {
        if (focusedID === null) {
            hidePopover();
            return;
        }
        const marker = markers[focusedID];
        if (marker === undefined) {
            hidePopover();
            return;
        }
        const el = queryElement(marker.selector);
        if (el === null) {
            hidePopover();
            return;
        }
        const rect = el.getBoundingClientRect();
        if (offscreen(rect)) {
            hidePopover();
            return;
        }
        const pop = ensurePopover();
        pop.style.display = 'flex';
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        // Measure LIVE, so a user-resized dialog stays centred and clamped.
        const popWidth = pop.offsetWidth || 280;
        const popHeight = pop.offsetHeight || 120;
        const roomBelow = vh - rect.bottom;
        const roomAbove = rect.top;
        let top = roomBelow >= popHeight + 16 || roomBelow >= roomAbove ? rect.bottom + 8 : rect.top - popHeight - 8;
        if (top + popHeight > vh - 8) top = vh - popHeight - 8;
        if (top < 8) top = 8;
        let left = Math.round((vw - popWidth) / 2);
        if (left < 8) left = 8;
        if (left + popWidth > vw - 8) left = vw - popWidth - 8;
        pop.style.left = String(left) + 'px';
        pop.style.top = String(top) + 'px';
        w.__nexBatchHasOpenPopover = true;
    }

    function syncPopoverContent(): void {
        if (focusedID === null || popover === null) return;
        const marker = markers[focusedID];
        if (marker === undefined) return;
        if (popoverLabel !== null) {
            const prefix = marker.label !== undefined && marker.label !== null ? '#' + String(marker.label) + ' ' : '';
            popoverLabel.textContent = prefix + String(marker.selector || '');
        }
        if (popoverTextarea !== null && doc.activeElement !== popoverTextarea) {
            popoverTextarea.value = String(marker.comment || '');
        }
    }

    function positionBadge(marker: PageGlobal): void {
        const badge = marker.badgeEl as HTMLElement | null;
        if (badge === null || badge === undefined) return;
        const el = queryElement(marker.selector);
        if (el === null) {
            badge.style.display = 'none';
            return;
        }
        const rect = el.getBoundingClientRect();
        if (offscreen(rect)) {
            badge.style.display = 'none';
            return;
        }
        badge.style.display = 'flex';
        // Slightly outside the element's top-left, and NOT clamped: a partially visible element
        // shows its badge beside it rather than pinned to a corner it does not own.
        badge.style.left = String(rect.left - 6) + 'px';
        badge.style.top = String(rect.top - 6) + 'px';
    }

    function refreshAll(): void {
        for (const id of Object.keys(markers)) positionBadge(markers[id]);
        positionFocusRing();
        positionPopover();
    }

    function createBadge(marker: PageGlobal): HTMLElement {
        const el = doc.createElement('div');
        el.setAttribute('data-nex-batch-marker', '1');
        el.style.cssText = [
            'position:fixed',
            'min-width:18px',
            'height:18px',
            'padding:0 5px',
            'border-radius:9px',
            'background:#007AFF',
            'color:white',
            'font:600 11px/18px -apple-system,system-ui,sans-serif',
            'text-align:center',
            'box-sizing:content-box',
            'border:2px solid white',
            'box-shadow:0 1px 4px rgba(0,0,0,0.35)',
            'cursor:pointer',
            'pointer-events:auto',
            'z-index:2147483646',
            'user-select:none',
            'transition:transform 180ms ease',
            'display:flex',
            'align-items:center',
            'justify-content:center'
        ].join(';');
        el.textContent = String(marker.label);
        el.addEventListener('click', function (event: Event): void {
            event.preventDefault();
            event.stopPropagation();
            post({ id: marker.id });
        });
        return el;
    }

    function setMarkers(items: PageGlobal[]): boolean {
        // Diff-rebuild, NOT clearAll: `focusedID` has to survive, or the ring and the popover
        // would blink away on every new pick and every comment keystroke.
        for (const id of Object.keys(markers)) {
            const badge = markers[id].badgeEl as HTMLElement | null;
            if (badge !== null && badge !== undefined) badge.remove();
        }
        markers = {};
        if (items === undefined || items === null || items.length === 0) {
            clearFocusRing();
            hidePopover();
            if (container !== null) {
                container.remove();
                container = null;
            }
            return true;
        }
        const root = ensureContainer();
        for (let index = 0; index < items.length; index += 1) {
            const item = items[index];
            if (item === undefined || item === null || !item.selector) continue;
            if (queryElement(item.selector) === null) continue;
            const marker: PageGlobal = {
                id: String(item.id || ''),
                selector: String(item.selector),
                label: String(item.label !== undefined && item.label !== null ? item.label : index + 1),
                comment: String(item.comment || ''),
                badgeEl: null
            };
            const badge = createBadge(marker);
            root.appendChild(badge);
            marker.badgeEl = badge;
            markers[marker.id] = marker;
            positionBadge(marker);
        }
        if (pendingFocusID !== null && markers[pendingFocusID] !== undefined) {
            focusedID = pendingFocusID;
            pendingFocusID = null;
        }
        if (focusedID !== null && markers[focusedID] === undefined) {
            clearFocusRing();
            hidePopover();
        } else if (focusedID !== null) {
            syncPopoverContent();
            positionFocusRing();
            positionPopover();
        }
        return true;
    }

    function clearAll(): boolean {
        setMarkers([]);
        popover = null;
        popoverTextarea = null;
        popoverLabel = null;
        focusRing = null;
        w.__nexBatchHasOpenPopover = false;
        return true;
    }

    function highlight(id: string, scrollIntoView: boolean): boolean {
        const key = String(id);
        const marker = markers[key];
        if (marker === undefined) {
            // The highlight beat its own sync (they are dispatched together): park it.
            pendingFocusID = key;
            return true;
        }
        pendingFocusID = null;
        focusedID = key;
        const shouldScroll = scrollIntoView !== false;
        const el = queryElement(marker.selector);
        if (el !== null && shouldScroll) {
            try {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } catch {
                el.scrollIntoView();
            }
        }
        const badge = marker.badgeEl as HTMLElement | null;
        if (badge !== null && badge !== undefined) {
            badge.style.transform = 'scale(1.6)';
            setTimeout(function (): void {
                badge.style.transform = 'scale(1)';
            }, 320);
        }
        syncPopoverContent();
        positionFocusRing();
        positionPopover();
        // Re-anchor once the smooth scroll has settled.
        if (shouldScroll) setTimeout(refreshAll, 400);
        return true;
    }

    function unfocus(): boolean {
        clearFocusRing();
        hidePopover();
        return true;
    }

    function updateExternalComment(id: string, comment: string): boolean {
        const key = String(id);
        const marker = markers[key];
        if (marker === undefined) return false;
        marker.comment = comment || '';
        // Only write back when the user is NOT in the textarea (WEB-141).
        if (focusedID === key && popoverTextarea !== null && doc.activeElement !== popoverTextarea) {
            popoverTextarea.value = marker.comment;
        }
        return true;
    }

    window.addEventListener('scroll', refreshAll, true);
    window.addEventListener('resize', refreshAll, true);

    w.__nexBatchSetMarkers = setMarkers;
    w.__nexBatchClearMarkers = clearAll;
    w.__nexBatchHighlight = highlight;
    w.__nexBatchUnfocus = unfocus;
    w.__nexBatchUpdateComment = updateExternalComment;
}

// ── §7.5 find-in-page ───────────────────────────────────────────────────────────────

function findMain(): void {
    if (window !== window.top) return;
    const w = window as unknown as PageGlobal;
    if (w.__nexWebFind !== undefined) return;

    const doc = document;
    const MARK_CLASS = 'nex-webfind-match';
    let marks: HTMLElement[] = [];
    let current = -1;

    function post(total: number, index: number): PageGlobal {
        const body = { total: total, current: index };
        const poster = w.__nexPost;
        if (typeof poster === 'function') poster('nexWebFind', body);
        return body;
    }

    function ensureStyle(): void {
        if (doc.getElementById('nex-webfind-style') !== null) return;
        if (doc.head === null) {
            requestAnimationFrame(ensureStyle);
            return;
        }
        const style = doc.createElement('style');
        style.id = 'nex-webfind-style';
        style.textContent =
            'mark.' +
            MARK_CLASS +
            '{background:#F2D027;color:#000;border-radius:2px}' +
            'mark.' +
            MARK_CLASS +
            '.nex-webfind-current{background:#FF7A00;color:#000}';
        doc.head.appendChild(style);
    }

    function clearMarks(): void {
        for (const mark of marks) {
            const parent = mark.parentNode;
            if (parent === null) continue;
            while (mark.firstChild !== null) parent.insertBefore(mark.firstChild, mark);
            parent.removeChild(mark);
            (parent as Element).normalize();
        }
        marks = [];
        current = -1;
    }

    function escapeRegex(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function highlight(index: number): void {
        for (let i = 0; i < marks.length; i += 1) {
            const mark = marks[i];
            if (mark === undefined) continue;
            if (i === index) mark.classList.add('nex-webfind-current');
            else mark.classList.remove('nex-webfind-current');
        }
        const active = marks[index];
        if (active !== undefined) active.scrollIntoView({ block: 'center' });
    }

    function search(rawNeedle: string): PageGlobal {
        ensureStyle();
        clearMarks();
        const needle = String(rawNeedle ?? '');
        if (needle === '' || doc.body === null) return post(0, -1);

        const pattern = new RegExp(escapeRegex(needle), 'gi');
        const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
            acceptNode: function (node: Node): number {
                const parent = node.parentElement;
                if (parent === null) return NodeFilter.FILTER_REJECT;
                const tag = parent.tagName.toLowerCase();
                if (tag === 'script' || tag === 'style' || tag === 'noscript') return NodeFilter.FILTER_REJECT;
                if (parent.classList.contains(MARK_CLASS)) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        const targets: Text[] = [];
        let node = walker.nextNode();
        while (node !== null) {
            targets.push(node as Text);
            node = walker.nextNode();
        }

        for (const target of targets) {
            const text = target.data;
            pattern.lastIndex = 0;
            let match = pattern.exec(text);
            if (match === null) continue;
            const fragment = doc.createDocumentFragment();
            let cursor = 0;
            while (match !== null) {
                if (match[0].length === 0) {
                    pattern.lastIndex += 1;
                    match = pattern.exec(text);
                    continue;
                }
                if (match.index > cursor) {
                    fragment.appendChild(doc.createTextNode(text.slice(cursor, match.index)));
                }
                const mark = doc.createElement('mark');
                mark.className = MARK_CLASS;
                mark.textContent = match[0];
                fragment.appendChild(mark);
                marks.push(mark);
                cursor = match.index + match[0].length;
                match = pattern.exec(text);
            }
            if (cursor < text.length) fragment.appendChild(doc.createTextNode(text.slice(cursor)));
            target.parentNode?.replaceChild(fragment, target);
        }

        if (marks.length === 0) return post(0, -1);
        current = 0;
        highlight(current);
        return post(marks.length, current);
    }

    function step(offset: number): PageGlobal {
        if (marks.length === 0) return post(0, -1);
        current = (current + offset + marks.length) % marks.length;
        highlight(current);
        return post(marks.length, current);
    }

    w.__nexWebFind = {
        search: search,
        next: function (): PageGlobal {
            return step(1);
        },
        prev: function (): PageGlobal {
            return step(-1);
        },
        clear: function (): PageGlobal {
            clearMarks();
            return post(0, -1);
        }
    };
}
/* eslint-enable */

// ── the sources, and the expressions that drive them ────────────────────────────────

export function bridgeScript(): string {
    return serialize(bridgeMain).split(BINDING_PLACEHOLDER).join(BINDING_NAME);
}

export function actuatorScript(): string {
    return serialize(actuatorMain);
}

export function inspectorScript(): string {
    return serialize(inspectorMain);
}

export function findScript(): string {
    return serialize(findMain);
}

export function batchMarkerScript(): string {
    return serialize(batchMarkerMain);
}

/** Injection order matters: the bridge must exist before anything tries to post through it. */
export function injectedScriptSources(): readonly string[] {
    return [bridgeScript(), actuatorScript(), inspectorScript(), findScript(), batchMarkerScript()];
}

// ── evaluation wrappers (§8.2 actuator dispatch, §8.5 exec) ─────────────────────────

/**
 * `__nexAct.<method>(<json args>)`, wrapped exactly as §8.2 describes: the result is
 * JSON-stringified inside the page so the host parses one envelope, and a missing actuator is
 * reported as the spec's own string rather than as an evaluation failure.
 *
 * Evaluated with CDP `Runtime.evaluate {awaitPromise:true}` — `wait` returns a Promise, and a
 * plain evaluation would serialise the pending Promise as `{}` (the spec's "same bug class").
 */
export function buildActuatorCall(method: string, args: readonly unknown[]): string {
    const literals = args.map((arg) => JSON.stringify(arg === undefined ? null : arg)).join(', ');
    return [
        '(async () => {',
        "  try { if (!window.__nexAct) return JSON.stringify({ok:false,error:'actuator not installed'});",
        `    var r = await window.__nexAct[${JSON.stringify(method)}](${literals});`,
        '    return JSON.stringify(r === undefined ? null : r);',
        '  } catch (e) { return JSON.stringify({ok:false, error: (e && e.message) ? e.message : String(e)}); }',
        '})()'
    ].join('\n');
}

/**
 * §8.5 statement-vs-expression detection: a keyword at line start or right after `;` means the
 * author wrote a statement body, so it is used verbatim; anything else is a single expression
 * and gets an implicit `return`.
 */
export const EXEC_STATEMENT_PATTERN = /(?:^\s*|;\s*)(return|throw|if|for|while|switch|try|do|let|const|var)\b/m;

/** `WebPaneExecWrapper.wrap` (§8.5): `$` / `$$` / `nex` aliases, awaited, JSON enveloped. */
export function wrapExecScript(script: string): string {
    const trimmed = script.trim();
    const body = EXEC_STATEMENT_PATTERN.test(trimmed)
        ? trimmed
        : `return (${trimmed.replace(/;$/, '')});`;
    return [
        '(async () => {',
        "  if (!window.__nexAct) return JSON.stringify({ok:false,error:'actuator not installed'});",
        '  try {',
        '    var result = await (async ($, $$, nex) => {',
        body,
        '    })(window.__nexAct.find, window.__nexAct.findAll, window.__nexAct);',
        '    return JSON.stringify({ok:true, result: result === undefined ? null : result});',
        '  } catch (e) {',
        '    return JSON.stringify({ok:false, error: (e && e.message) ? e.message : String(e),',
        '      js_error: {name: (e && e.name) ? e.name : "Error", message: (e && e.message) ? e.message : String(e),',
        '        line: (e && e.lineNumber) ? e.lineNumber : 0, column: (e && e.columnNumber) ? e.columnNumber : 0}});',
        '  }',
        '})()'
    ].join('\n');
}

/** Arm/disarm the in-page picker with the daemon-minted nonce (§11.1). */
export function buildInspectArm(nonce: string, sticky: boolean): string {
    return `(() => { if (!window.__nexInspectorEnable) return false; return window.__nexInspectorEnable(${JSON.stringify(nonce)}, ${String(sticky)}) !== false; })()`;
}

export function buildInspectDisarm(): string {
    return '(() => { if (!window.__nexInspectorDisable) return false; return window.__nexInspectorDisable() !== false; })()';
}

export type FindAction = 'search' | 'next' | 'prev' | 'clear';

/** §10: drive `__nexWebFind` and read `{total, current}` straight back off the evaluation. */
export function buildFindCall(action: FindAction, needle: string): string {
    const call =
        action === 'search'
            ? `window.__nexWebFind.search(${JSON.stringify(needle)})`
            : `window.__nexWebFind.${action}()`;
    return `(() => { if (!window.__nexWebFind) return null; return ${call}; })()`;
}

// ── §7.3 batch markers: the daemon → page calls ─────────────────────────────────────

/**
 * One numbered marker as the daemon describes it. `selector` is re-queried live in the page on
 * every reposition, so a React re-render that swaps the node keeps its badge (WEB-137).
 */
export interface BatchMarkerInput {
    readonly id: string;
    readonly selector: string;
    readonly label: string;
    readonly comment: string;
}

/** Replace the marker set (the diff-rebuild of WEB-138). An empty list tears the surfaces down. */
export function buildBatchSetMarkers(items: readonly BatchMarkerInput[]): string {
    return `(() => { if (!window.__nexBatchSetMarkers) return false; return window.__nexBatchSetMarkers(${JSON.stringify(items)}) !== false; })()`;
}

export function buildBatchClearMarkers(): string {
    return '(() => { if (!window.__nexBatchClearMarkers) return false; return window.__nexBatchClearMarkers() !== false; })()';
}

/** Focus one item: ring, badge pulse, popover — and, for a panel-origin focus, a smooth scroll. */
export function buildBatchHighlight(itemID: string, scrollIntoView: boolean): string {
    return `(() => { if (!window.__nexBatchHighlight) return false; return window.__nexBatchHighlight(${JSON.stringify(itemID)}, ${String(scrollIntoView)}) !== false; })()`;
}

export function buildBatchUnfocus(): string {
    return '(() => { if (!window.__nexBatchUnfocus) return false; return window.__nexBatchUnfocus() !== false; })()';
}

/** A panel-side comment edit pushed into the popover (never over a focused textarea, WEB-141). */
export function buildBatchUpdateComment(itemID: string, comment: string): string {
    return `(() => { if (!window.__nexBatchUpdateComment) return false; return window.__nexBatchUpdateComment(${JSON.stringify(itemID)}, ${JSON.stringify(comment)}) !== false; })()`;
}

/** §8.4 capture reads, kept here so the page expressions live in one place. */
export const CAPTURE_TEXT_EXPRESSION = "document.body ? document.body.innerText : ''";
export const CAPTURE_DOM_EXPRESSION =
    "document.documentElement ? document.documentElement.outerHTML : ''";
