import type { BrowserAction, BrowserPresentation } from '../../../plugin-sdk/browser-pane';
import type { GeometryRect } from '../webpane/geometry';

export type { BrowserAction, BrowserPresentation } from '../../../plugin-sdk/browser-pane';
export const BROWSER_SCOPE_LIMITS = { attachments: 128, actions: 16, frameTimeoutMs: 30_000, actionTimeoutMs: 5_000 } as const;

export interface BrowserFrameBounds {
    readonly rect: GeometryRect;
    readonly width: number;
    readonly height: number;
    readonly viewport: { readonly width: number; readonly height: number };
}
export interface BrowserSurfaceState {
    readonly rect: GeometryRect;
    readonly visible: boolean;
    readonly covered: boolean;
}
export interface BrowserScopeOptions {
    readonly presentation: BrowserPresentation;
    readonly frame: () => BrowserFrameBounds | null;
    readonly surface: (state: BrowserSurfaceState | null) => void;
    readonly textFocus: (editing: boolean) => void;
    readonly focusNative: () => void | Promise<unknown>;
    readonly beforeAction: (action: BrowserAction) => void | Promise<unknown>;
    readonly send: (message: Record<string, unknown>) => void;
    readonly fail: (error: Error) => void;
}
export interface BrowserScope {
    attach(args: unknown): { readonly session: string; readonly presentation: BrowserPresentation };
    receive(data: unknown): boolean;
    update(presentation: BrowserPresentation): void;
    measure(): void;
    action(action: BrowserAction): Promise<unknown>;
    readonly attached: boolean;
    dispose(): void;
}

function object(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function readRect(value: unknown): GeometryRect {
    const rect = object(value);
    if (!rect || !['x', 'y', 'w', 'h'].every(key => typeof rect[key] === 'number' && Number.isFinite(rect[key]) && Math.abs(rect[key] as number) <= 1_000_000) || (rect['w'] as number) < 0 || (rect['h'] as number) < 0) throw new Error('Invalid browser surface rectangle.');
    return { x: rect['x'] as number, y: rect['y'] as number, w: rect['w'] as number, h: rect['h'] as number };
}
function intersect(a: GeometryRect, b: GeometryRect): GeometryRect {
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
}

/** Local plugin coordinates can never place a native view outside its granted frame. */
export function browserSurfaceRect(local: GeometryRect, frame: BrowserFrameBounds): GeometryRect | null {
    if (frame.width <= 0 || frame.height <= 0 || frame.rect.w <= 0 || frame.rect.h <= 0) return null;
    const clipped = intersect(local, { x: 0, y: 0, w: frame.width, h: frame.height });
    const scaleX = frame.rect.w / frame.width, scaleY = frame.rect.h / frame.height;
    const global = { x: frame.rect.x + clipped.x * scaleX, y: frame.rect.y + clipped.y * scaleY, w: clipped.w * scaleX, h: clipped.h * scaleY };
    return intersect(intersect(global, frame.rect), { x: 0, y: 0, w: frame.viewport.width, h: frame.viewport.height });
}

/** One selected view controls placement; the existing native host still owns every page. */
export function createBrowserScope(options: BrowserScopeOptions): BrowserScope {
    let disposed = false, session: string | undefined;
    let localRect: GeometryRect | undefined, localVisible = false, covered = false;
    let textEditing = false, textFocus: boolean | undefined;
    let presentation = options.presentation, key = JSON.stringify(presentation);
    let surfaceKey = '', currentSurface: BrowserSurfaceState | null = null, sequence = 0, outstanding: number | undefined, nextAction = 0;
    let latestPresentation: BrowserPresentation | undefined;
    let frameTimer: ReturnType<typeof setTimeout> | undefined;
    const used = new Set<string>();
    const actions = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    const publishTextFocus = (): void => {
        const value = !disposed && session !== undefined && presentation.visible && presentation.focused && textEditing;
        if (value === textFocus) return;
        textFocus = value; options.textFocus(value);
    };
    const cancelActions = (message: string): void => {
        for (const action of actions.values()) { clearTimeout(action.timer); action.reject(new Error(message)); }
        actions.clear();
    };
    const send = (message: Record<string, unknown>): void => { if (!disposed && session) options.send(message); };
    const flush = (): void => {
        if (disposed || !session || outstanding !== undefined || !latestPresentation) return;
        const value = latestPresentation; latestPresentation = undefined;
        outstanding = ++sequence;
        frameTimer = setTimeout(() => { dispose(); options.fail(new Error('Browser presentation was not consumed in time.')); }, BROWSER_SCOPE_LIMITS.frameTimeoutMs);
        send({ type: 'browser-presentation', session, sequence: outstanding, value });
    };
    const measure = (): void => {
        const frame = options.frame();
        const rect = session && localRect && frame ? browserSurfaceRect(localRect, frame) : null;
        const value = rect ? { rect, visible: presentation.visible && localVisible && rect.w > 0 && rect.h > 0, covered } : null;
        currentSurface = value;
        const next = JSON.stringify(value);
        if (next === surfaceKey) return;
        surfaceKey = next; options.surface(value);
    };
    const detach = (): void => {
        session = undefined; localRect = undefined; localVisible = false; covered = false; textEditing = false;
        outstanding = undefined; latestPresentation = undefined; clearTimeout(frameTimer);
        cancelActions('Browser surface was detached.'); publishTextFocus(); measure();
    };
    const dispose = (): void => { if (disposed) return; disposed = true; detach(); };
    return {
        attach(args) {
            const input = object(args);
            if (disposed) throw new Error('Browser view was disposed.');
            if (session) throw new Error('A browser surface is already attached.');
            if (typeof input?.['session'] !== 'string' || input['session'].length === 0 || input['session'].length > 128 || used.has(input['session']) || used.size >= BROWSER_SCOPE_LIMITS.attachments) throw new Error('Invalid or reused browser surface session.');
            const rect = readRect(input['rect']);
            if (typeof input['visible'] !== 'boolean') throw new Error('Browser surface visibility must be boolean.');
            session = input['session']; used.add(session); localRect = rect; localVisible = input['visible'];
            latestPresentation = presentation; publishTextFocus(); measure(); flush();
            return { session, presentation };
        },
        receive(data) {
            const input = object(data);
            if (!input || typeof input['type'] !== 'string' || !input['type'].startsWith('browser-')) return false;
            if (disposed || !session || input['session'] !== session) return true;
            switch (input['type']) {
                case 'browser-geometry':
                    if (typeof input['visible'] !== 'boolean') throw new Error('Browser surface visibility must be boolean.');
                    localRect = readRect(input['rect']); localVisible = input['visible']; measure(); break;
                case 'browser-covered':
                    if (typeof input['covered'] !== 'boolean') throw new Error('Browser surface coverage must be boolean.');
                    covered = input['covered']; measure(); break;
                case 'browser-text-focus':
                    if (typeof input['editing'] !== 'boolean') throw new Error('Browser text focus must be boolean.');
                    textEditing = input['editing']; publishTextFocus(); break;
                case 'browser-focus': {
                    measure();
                    const target = session;
                    if (presentation.available && currentSurface?.visible && !covered) void Promise.resolve(options.focusNative()).catch(error => {
                        if (!disposed && session === target) options.fail(error instanceof Error ? error : new Error(String(error)));
                    });
                    break;
                }
                case 'browser-detach': detach(); break;
                case 'browser-ack':
                    if (input['sequence'] === outstanding) { clearTimeout(frameTimer); outstanding = undefined; flush(); }
                    break;
                case 'browser-action-reply': {
                    const id = typeof input['id'] === 'string' ? input['id'] : '';
                    const action = actions.get(id); if (!action) break;
                    actions.delete(id); clearTimeout(action.timer);
                    if (typeof input['error'] === 'string') action.reject(new Error(input['error'].slice(0, 4096)));
                    else if (input['result'] !== null && input['result'] !== undefined) action.reject(new Error('Invalid browser action result.'));
                    else action.resolve(null);
                    break;
                }
            }
            return true;
        },
        update(value) {
            if (disposed) return;
            presentation = value;
            if (!value.visible) cancelActions('Browser surface is hidden.');
            else if (!value.focused) cancelActions('Browser pane lost focus.');
            publishTextFocus();
            const next = JSON.stringify(value);
            if (key !== next) { key = next; latestPresentation = value; flush(); }
            measure();
        },
        measure,
        action(action) {
            if (disposed || !session || !presentation.visible) return Promise.reject(new Error('Browser surface is unavailable.'));
            if (!presentation.focused) return Promise.reject(new Error('Browser pane is not focused.'));
            if (actions.size >= BROWSER_SCOPE_LIMITS.actions) return Promise.reject(new Error('Too many pending browser actions.'));
            const target = session, id = String(++nextAction);
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => { actions.delete(id); reject(new Error('Browser action timed out.')); }, BROWSER_SCOPE_LIMITS.actionTimeoutMs);
                actions.set(id, { resolve, reject, timer });
                const current = (): boolean => !disposed && session === target && presentation.visible && presentation.focused && actions.has(id);
                void Promise.resolve().then(() => { if (current()) return options.beforeAction(action); }).then(() => {
                    if (current()) send({ type: 'browser-action', session: target, id, action });
                }, error => {
                    if (!actions.delete(id)) return;
                    clearTimeout(timer); reject(error);
                });
            });
        },
        get attached() { return session !== undefined; },
        dispose
    };
}
