import type { TerminalAPI } from './domain.js';

/** Terminal modes negotiated by the application running in the existing pane. */
export interface TerminalModes {
    readonly applicationCursorKeys: boolean;
    readonly bracketedPaste: boolean;
    readonly mouseTracking: 'none' | 'x10' | 'vt200' | 'drag' | 'any';
    readonly mouseFormat: 'x10' | 'utf8' | 'sgr' | 'urxvt' | 'sgr-pixels';
    readonly kittyKeyboardFlags: number;
}

/** Current presentation of this pane in its hosting window. */
export interface TerminalPresentation {
    readonly focused: boolean;
    readonly visible: boolean;
    readonly theme?: Readonly<Record<string, string>>;
    readonly fontFamily?: string;
    readonly fontSize?: number;
    readonly paddingX?: number;
    readonly paddingY?: number;
    readonly background?: string;
    readonly allowTransparency?: boolean;
    readonly accessibilityName?: string;
    readonly reveal?: { readonly linesFromBottom: number; readonly col: number; readonly length: number; readonly seq: number } | null;
}

export type TerminalFrame =
    /** Replay replaces the renderer's screen; output appends bytes to its parser. */
    | { readonly type: 'replay' | 'output'; readonly data: Uint8Array }
    /** The next replay is authoritative. Reset parser state before consuming it. */
    | { readonly type: 'resync'; readonly reason: string }
    | { readonly type: 'modes'; readonly modes: TerminalModes }
    | { readonly type: 'exit'; readonly exitCode: number | null; readonly signal?: string }
    | { readonly type: 'presentation'; readonly value: TerminalPresentation };

export interface TerminalKey {
    readonly key: string;
    readonly code?: string;
    readonly location?: number;
    readonly shiftKey?: boolean;
    readonly ctrlKey?: boolean;
    readonly altKey?: boolean;
    readonly metaKey?: boolean;
    readonly repeat?: boolean;
    readonly type?: 'keydown' | 'keyup';
}

/** Actions originating outside the iframe, including menus and the phone keyboard bar. */
export type TerminalAction =
    | { readonly type: 'selection' }
    | { readonly type: 'dispatchKey'; readonly key: TerminalKey }
    | { readonly type: 'paste'; readonly text: string }
    | { readonly type: 'focus' | 'blur' | 'showKeyboard' | 'hideKeyboard' }
    | { readonly type: 'modifiers'; readonly ctrl: boolean; readonly alt: boolean };

export interface TerminalAttachOptions {
    /** Measured initial grid. Both dimensions must be integers from 1 through 65535. */
    readonly cols: number;
    readonly rows: number;
    /**
     * Frames are ordered, with at most one callback running. Resolve only after the renderer
     * consumes the frame: this grants native output credit. Throwing fails the view so the
     * host can restore its bundled renderer. A callback must not await attach() itself.
     */
    readonly onFrame: (frame: TerminalFrame) => void | Promise<void>;
    /**
     * Return selected text (at most 256 KiB UTF-8) for selection; a handled boolean for
     * dispatchKey/paste; null or undefined for other actions. Missing handlers use '', false,
     * or null respectively. Rejections fail the individual action without failing the view.
     */
    readonly onAction?: (action: TerminalAction) => unknown | Promise<unknown>;
}

export interface TerminalSession {
    readonly id: string;
    /** Send keyboard/paste bytes, including terminal sync siblings. At most 128 KiB per call. */
    write(data: string | Uint8Array): void;
    /**
     * Send mouse reports or key releases to this pane only. Hidden panes ignore ordinary
     * input. For parser-generated device replies, pass { response: true } while consuming
     * a replay/output frame: the host binds the reply to that frame and permits it while
     * hidden. An in-flight output callback may still answer its application's query after
     * visual supersession, without granting stale output credit. Superseded replay replies
     * are ignored; responses after the callback completes throw.
     * Never mark keyboard, paste or mouse input as a response. At most 128 KiB per call.
     */
    writeDirect(data: string | Uint8Array, options?: { readonly response?: boolean }): void;
    /** Set the measured grid; the host retains native PTY size ownership. */
    resize(cols: number, rows: number): void;
    /** Report the rendered cell height in CSS pixels (finite, greater than zero, at most 512). */
    setCellHeight(height: number): void;
    /** Detach this renderer without stopping the process. Idempotent; later writes throw. */
    dispose(): void;
}

/** Available only in a terminal replacement view; all existing terminal commands remain. */
export interface ViewTerminalAPI extends TerminalAPI {
    /** Attach to this view's native terminal. One active or attaching session per iframe. */
    attach(options: TerminalAttachOptions): Promise<TerminalSession>;
}
