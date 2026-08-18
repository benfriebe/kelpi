/**
 * The console pipeline's formatting half (web-pane.md §7.1 + the doc's Port notes).
 *
 * The Swift app captured console output with an **injected script** that wrapped
 * `console.*`, `window.onerror`, `unhandledrejection`, subresource `error` events and even
 * `fetch`/`XMLHttpRequest`. The port takes the other branch the spec explicitly offers:
 *
 *   > CDP `Runtime.consoleAPICalled` + `Runtime.exceptionThrown` + `Log.entryAdded` +
 *   > `Network.loadingFailed`/`responseReceived` cover strictly more than the injected wrapper
 *   > (including engine-level network errors the wrapper exists to approximate). […] reimplement
 *   > the same formatting from CDP events and drop the fetch/XHR monkey-patching.
 *
 * So this module is where the *message strings* stay faithful: arguments joined with a single
 * space, `Assertion failed: …`, `Unhandled promise rejection: …`, `fetch 404 Not Found — <url>`,
 * `XHR 404 — GET <url> — Not Found`, `resource load failed: <tag> <url>`. Everything here is
 * pure so it can be unit-tested without a browser.
 *
 * Two consequences of the CDP route worth stating plainly:
 *
 *   - **Deep objects render as Chromium previews**, not as `JSON.stringify` output: a console
 *     argument arrives as a `RemoteObject` with a bounded `preview`, and asking the page to
 *     serialise every argument would cost a round trip per line. `[Circular]` therefore only
 *     appears on the value path (`safeStringify`), which is what the exception/binding paths use.
 *   - **`Log.entryAdded` entries whose source is `network` are dropped**: Chromium logs
 *     "Failed to load resource: …" for exactly the responses the `Network.*` handlers below
 *     already render in the spec's format, and one failure must not become two lines.
 */

/** The levels the daemon's ring buffer knows (`webpane/console.ts`). */
export const CONSOLE_LEVELS = ['log', 'debug', 'info', 'warn', 'error'] as const;
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

/** One line as the host puts it on the wire (`host-event` `console` payload). */
export interface ConsoleLinePayload {
    readonly level: ConsoleLevel;
    readonly message: string;
    readonly url: string;
    readonly line?: number;
    readonly column?: number;
}

export function normalizeConsoleLevel(raw: string): ConsoleLevel {
    const value = raw.toLowerCase();
    if ((CONSOLE_LEVELS as readonly string[]).includes(value)) return value as ConsoleLevel;
    if (value === 'warning') return 'warn';
    if (value === 'verbose' || value === 'trace') return 'debug';
    if (value === 'assert' || value === 'exception') return 'error';
    return 'log';
}

// ── CDP shapes (only the fields this module reads) ──────────────────────────────────

export interface RemoteObject {
    readonly type?: string;
    readonly subtype?: string;
    readonly className?: string;
    readonly value?: unknown;
    readonly unserializableValue?: string;
    readonly description?: string;
    readonly preview?: ObjectPreview;
}

export interface ObjectPreview {
    readonly type?: string;
    readonly subtype?: string;
    readonly description?: string;
    readonly overflow?: boolean;
    readonly properties?: readonly PropertyPreview[];
}

export interface PropertyPreview {
    readonly name: string;
    readonly type?: string;
    readonly subtype?: string;
    readonly value?: string;
    readonly valuePreview?: ObjectPreview;
}

export interface ExceptionDetails {
    readonly text?: string;
    readonly lineNumber?: number;
    readonly columnNumber?: number;
    readonly url?: string;
    readonly exception?: RemoteObject;
}

// ── argument formatting ─────────────────────────────────────────────────────────────

/**
 * `JSON.stringify` with the spec's WeakSet cycle-breaker (`"[Circular]"`) and its
 * `String(v)` → `"[Unserialisable]"` fallback chain.
 */
export function safeStringify(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    const seen = new WeakSet<object>();
    try {
        const json = JSON.stringify(value, (_key: string, entry: unknown) => {
            if (typeof entry === 'object' && entry !== null) {
                if (seen.has(entry)) return '[Circular]';
                seen.add(entry);
            }
            return entry;
        });
        if (json !== undefined) return json;
    } catch {
        // Fall through to the String() attempt.
    }
    try {
        return String(value);
    } catch {
        return '[Unserialisable]';
    }
}

function renderPropertyPreview(property: PropertyPreview): string {
    if (property.valuePreview !== undefined) return renderPreview(property.valuePreview);
    if (property.type === 'string') return JSON.stringify(property.value ?? '');
    return property.value ?? property.type ?? 'undefined';
}

/** Chromium's bounded object preview, rendered JSON-ish so a log line stays readable. */
export function renderPreview(preview: ObjectPreview): string {
    const properties = preview.properties ?? [];
    const overflow = preview.overflow === true ? ', …' : '';
    if (preview.subtype === 'array') {
        return `[${properties.map(renderPropertyPreview).join(', ')}${overflow}]`;
    }
    if (properties.length === 0) return preview.description ?? '{}';
    const body = properties
        .map((property) => `${JSON.stringify(property.name)}:${renderPropertyPreview(property)}`)
        .join(',');
    return `{${body}${overflow}}`;
}

/** One `console.log` argument → its string form (§7.1's per-argument rules). */
export function formatRemoteObject(remote: RemoteObject): string {
    if (remote.type === 'undefined') return 'undefined';
    if (remote.subtype === 'null') return 'null';
    if (remote.type === 'string') return typeof remote.value === 'string' ? remote.value : (remote.description ?? '');
    if (remote.unserializableValue !== undefined) return remote.unserializableValue;
    if (remote.type === 'number' || remote.type === 'boolean' || remote.type === 'bigint') {
        return remote.value === undefined ? (remote.description ?? '') : String(remote.value);
    }
    // Functions stringify to their source, Errors to their stack — both are `description`.
    if (remote.type === 'function' || remote.subtype === 'error') {
        return remote.description ?? String(remote.className ?? 'function');
    }
    if (remote.value !== undefined) return safeStringify(remote.value);
    if (remote.preview !== undefined) return renderPreview(remote.preview);
    return remote.description ?? remote.className ?? remote.type ?? '';
}

/** §7.1: arguments are joined with a single space. */
export function formatConsoleArgs(args: readonly RemoteObject[]): string {
    return args.map(formatRemoteObject).join(' ');
}

// ── event formatters ────────────────────────────────────────────────────────────────

export interface ConsoleApiCall {
    readonly type?: string;
    readonly args?: readonly RemoteObject[];
}

/** `Runtime.consoleAPICalled` → one line. `assert` gets the spec's prefix. */
export function formatConsoleApiCall(event: ConsoleApiCall, url: string): ConsoleLinePayload {
    const joined = formatConsoleArgs(event.args ?? []);
    const type = event.type ?? 'log';
    if (type === 'assert') {
        return {
            level: 'error',
            message: joined === '' ? 'Assertion failed:' : `Assertion failed: ${joined}`,
            url
        };
    }
    return { level: normalizeConsoleLevel(type), message: joined, url };
}

/**
 * `Runtime.exceptionThrown` → one error line. CDP line/column are 0-based; the wire's
 * `line`/`column` mirror the browser's 1-based `window.onerror` numbers.
 */
export function formatExceptionThrown(details: ExceptionDetails, fallbackUrl: string): ConsoleLinePayload {
    const description =
        details.exception?.description ??
        (details.exception === undefined ? undefined : formatRemoteObject(details.exception)) ??
        details.text ??
        'Uncaught error';
    const text = details.text ?? '';
    const rejected = text.includes('(in promise)');
    const url = details.url ?? fallbackUrl;
    const source = details.url ?? '';
    const line = details.lineNumber === undefined ? undefined : details.lineNumber + 1;
    const column = details.columnNumber === undefined ? undefined : details.columnNumber + 1;
    const located =
        source === '' || line === undefined
            ? description
            : `${description} (${source}:${String(line)}:${String(column ?? 0)})`;
    return {
        level: 'error',
        message: rejected ? `Unhandled promise rejection: ${description}` : located,
        url,
        ...(line === undefined ? {} : { line }),
        ...(column === undefined ? {} : { column })
    };
}

export interface LogEntry {
    readonly source?: string;
    readonly level?: string;
    readonly text?: string;
    readonly url?: string;
    readonly lineNumber?: number;
}

/**
 * `Log.entryAdded` → one line, or null when the entry is a duplicate of something the
 * `Network.*` handlers below render in the spec's own format.
 */
export function formatLogEntry(entry: LogEntry, fallbackUrl: string): ConsoleLinePayload | null {
    if (entry.source === 'network') return null;
    const message = entry.text ?? '';
    if (message === '') return null;
    const line = entry.lineNumber === undefined ? undefined : entry.lineNumber + 1;
    return {
        level: normalizeConsoleLevel(entry.level ?? 'log'),
        message,
        url: entry.url ?? fallbackUrl,
        ...(line === undefined ? {} : { line })
    };
}

/** CDP resource types → the tag name §7.1's in-page listener would have reported. */
const RESOURCE_TAGS: Readonly<Record<string, string>> = {
    Image: 'img',
    Script: 'script',
    Stylesheet: 'link',
    Media: 'video',
    Font: 'link',
    Document: 'iframe',
    Manifest: 'link',
    Other: 'resource'
};

export interface NetworkRequestInfo {
    readonly method: string;
    readonly url: string;
    readonly type?: string;
}

function isXhr(type: string | undefined): boolean {
    return type === 'XHR';
}

function isFetchLike(type: string | undefined): boolean {
    return type === 'Fetch' || type === 'XHR';
}

/**
 * A failed load. `Fetch`/`XHR` get §7.1's wrapper strings; every other resource type gets the
 * subresource form. A cancelled request is not a failure (navigating away cancels in flight
 * requests, and the Swift wrapper never saw those either).
 */
export function formatLoadingFailed(
    request: NetworkRequestInfo,
    failure: { readonly errorText?: string; readonly canceled?: boolean; readonly type?: string }
): ConsoleLinePayload | null {
    if (failure.canceled === true) return null;
    const type = failure.type ?? request.type;
    const detail = failure.errorText ?? 'load failed';
    if (isXhr(type)) {
        return { level: 'error', message: `XHR error — ${request.method} ${request.url}`, url: request.url };
    }
    if (type === 'Fetch') {
        return { level: 'error', message: `fetch failed — ${detail} — ${request.url}`, url: request.url };
    }
    const tag = RESOURCE_TAGS[type ?? 'Other'] ?? 'resource';
    return { level: 'error', message: `resource load failed: ${tag} ${request.url}`, url: request.url };
}

/** A response that arrived but carries an error status (only `fetch`/XHR, matching §7.1). */
export function formatErrorResponse(
    request: NetworkRequestInfo,
    response: { readonly status?: number; readonly statusText?: string; readonly type?: string }
): ConsoleLinePayload | null {
    const status = response.status ?? 0;
    if (status < 400) return null;
    const type = response.type ?? request.type;
    if (!isFetchLike(type)) return null;
    const statusText = (response.statusText ?? '').trim();
    if (isXhr(type)) {
        const tail = statusText === '' ? '' : ` — ${statusText}`;
        return {
            level: 'error',
            message: `XHR ${String(status)} — ${request.method} ${request.url}${tail}`,
            url: request.url
        };
    }
    const label = statusText === '' ? String(status) : `${String(status)} ${statusText}`;
    return { level: 'error', message: `fetch ${label} — ${request.url}`, url: request.url };
}
