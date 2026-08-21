/**
 * InputHandler - Converts browser keyboard events to terminal input
 *
 * Handles:
 * - Keyboard event listening on a container element
 * - Mapping KeyboardEvent.code to USB HID Key codes
 * - Extracting modifier keys (Ctrl, Alt, Shift, Meta)
 * - Encoding keys using Ghostty's KeyEncoder
 * - Emitting data for Terminal to send to PTY
 *
 * Limitations:
 * - Does not handle IME/composition events (CJK input) - to be added later
 * - Captures all keyboard input (preventDefault on everything)
 */

import type { Ghostty } from './ghostty';
import type { KeyEncoder } from './ghostty';
import type { IKeyEvent } from './interfaces';
import { Key, KeyAction, KeyEncoderOption, Mods } from './types';

/**
 * Map KeyboardEvent.code values to USB HID Key enum values
 * Based on: https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/code
 */
const KEY_MAP: Record<string, Key> = {
  // Letters
  KeyA: Key.A,
  KeyB: Key.B,
  KeyC: Key.C,
  KeyD: Key.D,
  KeyE: Key.E,
  KeyF: Key.F,
  KeyG: Key.G,
  KeyH: Key.H,
  KeyI: Key.I,
  KeyJ: Key.J,
  KeyK: Key.K,
  KeyL: Key.L,
  KeyM: Key.M,
  KeyN: Key.N,
  KeyO: Key.O,
  KeyP: Key.P,
  KeyQ: Key.Q,
  KeyR: Key.R,
  KeyS: Key.S,
  KeyT: Key.T,
  KeyU: Key.U,
  KeyV: Key.V,
  KeyW: Key.W,
  KeyX: Key.X,
  KeyY: Key.Y,
  KeyZ: Key.Z,

  // Numbers
  Digit1: Key.ONE,
  Digit2: Key.TWO,
  Digit3: Key.THREE,
  Digit4: Key.FOUR,
  Digit5: Key.FIVE,
  Digit6: Key.SIX,
  Digit7: Key.SEVEN,
  Digit8: Key.EIGHT,
  Digit9: Key.NINE,
  Digit0: Key.ZERO,

  // Special keys
  Enter: Key.ENTER,
  Escape: Key.ESCAPE,
  Backspace: Key.BACKSPACE,
  Tab: Key.TAB,
  Space: Key.SPACE,

  // Punctuation
  Minus: Key.MINUS,
  Equal: Key.EQUAL,
  BracketLeft: Key.BRACKET_LEFT,
  BracketRight: Key.BRACKET_RIGHT,
  Backslash: Key.BACKSLASH,
  Semicolon: Key.SEMICOLON,
  Quote: Key.QUOTE,
  Backquote: Key.GRAVE,
  Comma: Key.COMMA,
  Period: Key.PERIOD,
  Slash: Key.SLASH,

  // Function keys
  CapsLock: Key.CAPS_LOCK,
  F1: Key.F1,
  F2: Key.F2,
  F3: Key.F3,
  F4: Key.F4,
  F5: Key.F5,
  F6: Key.F6,
  F7: Key.F7,
  F8: Key.F8,
  F9: Key.F9,
  F10: Key.F10,
  F11: Key.F11,
  F12: Key.F12,

  // Special function keys
  PrintScreen: Key.PRINT_SCREEN,
  ScrollLock: Key.SCROLL_LOCK,
  Pause: Key.PAUSE,
  Insert: Key.INSERT,
  Home: Key.HOME,
  PageUp: Key.PAGE_UP,
  Delete: Key.DELETE,
  End: Key.END,
  PageDown: Key.PAGE_DOWN,

  // Arrow keys
  ArrowRight: Key.RIGHT,
  ArrowLeft: Key.LEFT,
  ArrowDown: Key.DOWN,
  ArrowUp: Key.UP,

  // Keypad
  NumLock: Key.NUM_LOCK,
  NumpadDivide: Key.KP_DIVIDE,
  NumpadMultiply: Key.KP_MULTIPLY,
  NumpadSubtract: Key.KP_MINUS,
  NumpadAdd: Key.KP_PLUS,
  NumpadEnter: Key.KP_ENTER,
  Numpad1: Key.KP_1,
  Numpad2: Key.KP_2,
  Numpad3: Key.KP_3,
  Numpad4: Key.KP_4,
  Numpad5: Key.KP_5,
  Numpad6: Key.KP_6,
  Numpad7: Key.KP_7,
  Numpad8: Key.KP_8,
  Numpad9: Key.KP_9,
  Numpad0: Key.KP_0,
  NumpadDecimal: Key.KP_PERIOD,

  // International
  IntlBackslash: Key.INTL_BACKSLASH,
  ContextMenu: Key.CONTEXT_MENU,

  // Additional function keys
  F13: Key.F13,
  F14: Key.F14,
  F15: Key.F15,
  F16: Key.F16,
  F17: Key.F17,
  F18: Key.F18,
  F19: Key.F19,
  F20: Key.F20,
  F21: Key.F21,
  F22: Key.F22,
  F23: Key.F23,
  F24: Key.F24,
};

/**
 * InputHandler class
 * Attaches keyboard event listeners to a container and converts
 * keyboard events to terminal input data
 */
export class InputHandler {
  private encoder: KeyEncoder;
  private container: HTMLElement;
  private onDataCallback: (data: string) => void;
  private onBellCallback: () => void;
  private onKeyCallback?: (keyEvent: IKeyEvent) => void;
  private customKeyEventHandler?: (event: KeyboardEvent) => boolean;
  private getModeCallback?: (mode: number) => boolean;
  private keydownListener: ((e: KeyboardEvent) => void) | null = null;
  private keypressListener: ((e: KeyboardEvent) => void) | null = null;
  private pasteListener: ((e: ClipboardEvent) => void) | null = null;
  private compositionStartListener: ((e: CompositionEvent) => void) | null = null;
  private compositionUpdateListener: ((e: CompositionEvent) => void) | null = null;
  private compositionEndListener: ((e: CompositionEvent) => void) | null = null;
  private isComposing = false;
  // VENDOR BRIDGE (0.4.0-nex.1): PR #120 targets a base where InputHandler knows its
  // textarea; v0.4.0 does not, so the minimal member + constructor param are added here.
  private inputElement: HTMLTextAreaElement | null = null;
  private compositionJustEnded = false; // Block keydown briefly after composition ends
  private pendingKeyAfterComposition: string | null = null; // Key to output after composition
  private isDisposed = false;
// VENDOR NOTE (0.4.0-nex.1): upstream PR #159's base carries mouse/paste/beforeinput
  // dedupe fields absent in v0.4.0; only the two fields the encoder path needs are taken.
  // Cache of encoder option values last pushed to the WASM encoder, so
  // keystroke handling can skip the setOption WASM round-trip when nothing
  // changed. `undefined` means "never synced"; any first query on a new
  // handler will emit one setOption per option regardless of mode state.
  private syncedEncoderOptions = new Map<KeyEncoderOption, boolean | number>();
  // Reused across keystrokes to avoid the TextDecoder allocation per call.
  private decoder = new TextDecoder();
  // VENDOR BRIDGE (0.4.0-nex.1): with focus on the hidden textarea (PR #120), inserted text
  // (CDP Input.insertText, autocomplete, some IME finalizations) arrives as beforeinput on the
  // textarea and nothing in v0.4.0 forwards it. This is upstream main's beforeinput+dedupe
  // mechanism, minimally ported: physical keydowns record what they emitted so the echoing
  // beforeinput within 100ms is not double-sent.
  private beforeInputListener: ((e: InputEvent) => void) | null = null;
  private lastKeyDownData: string | null = null;
  private lastKeyDownTime = 0;
  private static readonly BEFORE_INPUT_IGNORE_MS = 100;

  /**
   * Create a new InputHandler
   * @param ghostty - Ghostty instance (for creating KeyEncoder)
   * @param container - DOM element to attach listeners to
   * @param onData - Callback for terminal data (escape sequences to send to PTY)
   * @param onBell - Callback for bell/beep event
   * @param onKey - Optional callback for raw key events
   * @param customKeyEventHandler - Optional custom key event handler
   * @param getMode - Optional callback to query terminal mode state (for application cursor mode)
   */
  constructor(
    ghostty: Ghostty,
    container: HTMLElement,
    onData: (data: string) => void,
    onBell: () => void,
    onKey?: (keyEvent: IKeyEvent) => void,
    customKeyEventHandler?: (event: KeyboardEvent) => boolean,
    getMode?: (mode: number) => boolean,
    inputElement?: HTMLTextAreaElement
  ) {
    this.inputElement = inputElement ?? null;
    this.encoder = ghostty.createKeyEncoder();
    this.container = container;
    this.onDataCallback = onData;
    this.onBellCallback = onBell;
    this.onKeyCallback = onKey;
    this.customKeyEventHandler = customKeyEventHandler;
    this.getModeCallback = getMode;

    // Attach event listeners
    this.attach();
  }

  /**
   * Set custom key event handler (for runtime updates)
   */
  setCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
    this.customKeyEventHandler = handler;
  }

  /**
   * Attach keyboard event listeners to container
   */
  private attach(): void {
    // Make container focusable so it can receive keyboard events (browser only)
    if (
      typeof this.container.hasAttribute === 'function' &&
      typeof this.container.setAttribute === 'function'
    ) {
      if (!this.container.hasAttribute('tabindex')) {
        this.container.setAttribute('tabindex', '0');
      }

      // Add visual focus indication (only if style exists - for browser environments)
      if (this.container.style) {
        this.container.style.outline = 'none'; // Remove default outline
      }
    }

    this.keydownListener = this.handleKeyDown.bind(this);
    this.container.addEventListener('keydown', this.keydownListener);

    this.pasteListener = this.handlePaste.bind(this);
    this.container.addEventListener('paste', this.pasteListener);

    if (this.inputElement) {
      this.beforeInputListener = this.handleBeforeInput.bind(this);
      this.inputElement.addEventListener('beforeinput', this.beforeInputListener);
    }

    // Attach composition events to inputElement (textarea) if available.
    // IME composition events fire on the focused element, and when using a hidden
    // textarea for input (as ghostty-web does), the textarea receives focus,
    // not the container. This fixes Korean/Chinese/Japanese IME input.
    const compositionTarget = this.inputElement || this.container;
    this.compositionStartListener = this.handleCompositionStart.bind(this);
    compositionTarget.addEventListener('compositionstart', this.compositionStartListener);

    this.compositionUpdateListener = this.handleCompositionUpdate.bind(this);
    compositionTarget.addEventListener('compositionupdate', this.compositionUpdateListener);

    this.compositionEndListener = this.handleCompositionEnd.bind(this);
compositionTarget.addEventListener('compositionend', this.compositionEndListener);
    // NOTE(vendor 0.4.0-nex.1): upstream PR #120's context also introduces engine mouse
    // listeners from post-0.4.0 main; deliberately NOT taken — v0.4.0 has none, and the
    // Nex client owns mouse reporting in its own capture-phase interceptor.
  }

  /**
   * Map KeyboardEvent.code to USB HID Key enum value
   * @param code - KeyboardEvent.code value
   * @returns Key enum value or null if unmapped
   */
  private mapKeyCode(code: string): Key | null {
    return KEY_MAP[code] ?? null;
  }

  /**
   * Push an encoder option value to WASM only if it differs from the last
   * value we pushed. Terminal modes rarely change between keystrokes, so
   * this saves two WASM round-trips per keystroke in the steady state.
   */
  private syncEncoderOption(option: KeyEncoderOption, value: boolean | number): void {
    if (this.syncedEncoderOptions.get(option) === value) return;
    this.encoder.setOption(option, value);
    this.syncedEncoderOptions.set(option, value);
  }

  /**
   * Extract modifier flags from KeyboardEvent
   * @param event - KeyboardEvent
   * @returns Mods flags
   */
  private extractModifiers(event: KeyboardEvent): Mods {
    let mods = Mods.NONE;

    if (event.shiftKey) mods |= Mods.SHIFT;
    if (event.ctrlKey) mods |= Mods.CTRL;
    if (event.altKey) mods |= Mods.ALT;
    if (event.metaKey) mods |= Mods.SUPER;

    // Note: CapsLock and NumLock are not in KeyboardEvent modifiers
    // They would need to be tracked separately if needed
    // For now, we don't set CAPSLOCK or NUMLOCK flags

    return mods;
  }

  /**
   * Handle keydown event
   * @param event - KeyboardEvent
   */
  private handleKeyDown(event: KeyboardEvent): void {
    if (this.isDisposed) return;

    // Ignore keydown events during composition
    // Note: Some browsers send keyCode 229 for all keys during composition
    if (event.isComposing || event.keyCode === 229) {
      return;
    }

    // If we're still in composition (our flag) but browser says composition ended,
    // this is the key that ended the composition (space, period, etc.).
    // Queue it to be processed after compositionend to maintain correct order.
    if (this.isComposing) {
      // Store the key to be processed after composition ends
      this.pendingKeyAfterComposition = event.key;
      event.preventDefault();
      return;
    }

    // Block the key that triggered composition end if we just processed a pending key
    if (this.compositionJustEnded) {
      this.compositionJustEnded = false;
      return;
    }

    // Emit onKey event first (before any processing)
    if (this.onKeyCallback) {
      this.onKeyCallback({ key: event.key, domEvent: event });
    }

    // Check custom key event handler
    if (this.customKeyEventHandler) {
      const handled = this.customKeyEventHandler(event);
      if (handled) {
        // Custom handler consumed the event
        event.preventDefault();
        return;
      }
    }

    // Allow Ctrl+V and Cmd+V to trigger paste event (don't preventDefault)
    if ((event.ctrlKey || event.metaKey) && event.code === 'KeyV') {
      // Let the browser's native paste event fire
      return;
    }

    // Allow Cmd+C for copy (on Mac, Cmd+C should copy, not send interrupt)
    // SelectionManager handles the actual copying
    // Note: Ctrl+C on all platforms sends interrupt signal (0x03)
    if (event.metaKey && event.code === 'KeyC') {
      // Let browser/SelectionManager handle copy
      return;
    }

    // Map the physical key code. Events with no corresponding Ghostty Key
    // (media keys, etc.) are dropped silently.
    const key = this.mapKeyCode(event.code);
    if (key === null) {
      // VENDOR FALLBACK (0.4.0-nex.1): synthetic and virtual keyboards (CDP key events
      // without `code`, some mobile IMEs) carry no mappable KeyboardEvent.code. Upstream
      // 0.4.0's printable fast path accepted these; PR #159 would drop them. Rescue plain
      // printable scalars; everything mappable keeps the encoder path.
      if (
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        event.key.length > 0 &&
        event.key !== 'Dead' &&
        event.key !== 'Unidentified'
      ) {
        const cp = event.key.codePointAt(0);
        const scalarLen = cp !== undefined && cp > 0xffff ? 2 : 1;
        if (event.key.length === scalarLen) {
          event.preventDefault();
          this.onDataCallback(event.key);
          this.recordKeyDownData(event.key);
        }
      }
      return;
    }

    const mods = this.extractModifiers(event);

    // Pass event.key as utf8 when it is a single Unicode scalar (a printable
    // character, including non-ASCII and surrogate-pair emoji). Named keys
    // like "Enter", "ArrowUp", "F1", "Dead" are longer strings and produce
    // undefined here, so the encoder relies on the logical key alone.
    //
    // Case is preserved intentionally: the encoder uses the utf8 byte to
    // pick the C0 sequence for Ctrl+letter, and needs the actual shifted
    // character for the text-output path.
    let utf8: string | undefined;
    if (event.key.length > 0 && event.key !== 'Dead' && event.key !== 'Unidentified') {
      const cp = event.key.codePointAt(0);
      const scalarLen = cp !== undefined && cp > 0xffff ? 2 : 1;
      if (event.key.length === scalarLen) utf8 = event.key;
    }

    // Sync encoder options with terminal mode state before every encode.
    // DEC mode 1 (DECCKM) → cursor-key application mode.
    // DEC mode 66 (DECNKM) → keypad application mode.
    // syncEncoderOption skips the WASM round-trip when the value hasn't
    // changed since last keystroke, which is the common case.
    if (this.getModeCallback) {
      this.syncEncoderOption(KeyEncoderOption.CURSOR_KEY_APPLICATION, this.getModeCallback(1));
      this.syncEncoderOption(KeyEncoderOption.KEYPAD_KEY_APPLICATION, this.getModeCallback(66));
    }

    // mapKeyCode succeeded → we own this key. Prevent browser default
    // (search shortcuts, F11 fullscreen, Ctrl+W close tab, etc.) before
    // attempting to encode, so a failed or empty encode drops the
    // keystroke silently rather than letting it trigger a browser action.
    //
    // This is a deliberate divergence from native Ghostty, which returns
    // `.ignored` from keyCallback when the encoder produces no output and
    // lets the apprt decide whether to propagate the key (Surface.zig
    // around line 2670). In a native context that lets OS-level shortcuts
    // and apprt keybinds run; in a browser context "ignored" would mean
    // the browser fires its own default action with no intermediate layer
    // to filter, which is rarely what users typing into a terminal want.
    // Empty-encode mapped keys are also rare in our path: mapKeyCode
    // already filters unmapped keys, and most mapped keys produce non-
    // empty encodings in default mode.
    event.preventDefault();
    event.stopPropagation();

    let data: string;
    try {
      const encoded = this.encoder.encode({
        action: KeyAction.PRESS,
        key,
        mods,
        utf8,
      });
      data = encoded.length === 0 ? '' : this.decoder.decode(encoded);
    } catch (error) {
      console.warn('Failed to encode key:', event.code, error);
      return;
    }

    if (data.length > 0) {
      this.onDataCallback(data);
      this.recordKeyDownData(data);
    }
  }

  /**
   * Handle paste event from clipboard
   * @param event - ClipboardEvent
   */
  private handlePaste(event: ClipboardEvent): void {
    if (this.isDisposed) return;

    // Prevent default paste behavior
    event.preventDefault();
    event.stopPropagation();

    // Get clipboard data
    const clipboardData = event.clipboardData;
    if (!clipboardData) {
      console.warn('No clipboard data available');
      return;
    }

    // Get text from clipboard
    const text = clipboardData.getData('text/plain');
    if (!text) {
      console.warn('No text in clipboard');
      return;
    }

    // Send the text to the terminal
    // Note: For bracketed paste mode, we would wrap this in \x1b[200~ ... \x1b[201~
    // but for now, send raw text
    this.onDataCallback(text);
  }

  /**
   * VENDOR BRIDGE (0.4.0-nex.1): forward textarea-inserted text to the PTY exactly once.
   * insertText only: composition text arrives via compositionend, pastes via the paste
   * listener, and control keys via the keydown encoder.
   */
  private handleBeforeInput(event: InputEvent): void {
    if (this.isDisposed) return;
    // The textarea must never accumulate visible content.
    event.preventDefault();
    if (this.isComposing) return;
    if (event.inputType !== 'insertText') return;
    const data = event.data;
    if (!data) return;
    if (
      this.lastKeyDownData === data &&
      Date.now() - this.lastKeyDownTime < InputHandler.BEFORE_INPUT_IGNORE_MS
    ) {
      return; // the physical keydown already emitted this text
    }
    this.onDataCallback(data);
  }

  private recordKeyDownData(data: string): void {
    this.lastKeyDownData = data;
    this.lastKeyDownTime = Date.now();
  }

  /**
   * Handle compositionstart event
   */
  private handleCompositionStart(_event: CompositionEvent): void {
    if (this.isDisposed) return;
    this.isComposing = true;
  }

  /**
   * Handle compositionupdate event
   */
  private handleCompositionUpdate(_event: CompositionEvent): void {
    if (this.isDisposed) return;
    // We could track the current composition string here if we wanted to
    // display it in a custom way, but for now we rely on the browser's
    // input method editor UI.
  }

  /**
   * Handle compositionend event
   */
  private handleCompositionEnd(event: CompositionEvent): void {
    if (this.isDisposed) return;
    this.isComposing = false;

    const data = event.data;
    if (data && data.length > 0) {
      // NOTE(vendor 0.4.0-nex.1): upstream PR #120's base has shouldIgnoreCompositionEnd();
      // v0.4.0 does not, so that branch is omitted.
      this.onDataCallback(data);
    }

    this.cleanupCompositionTextNodes();

    // Process the key that ended composition (space, period, etc.)
    // This ensures correct order: composed text first, then the terminating key
    this.processPendingKeyAfterComposition();
  }

  /**
   * Process the pending key that was queued during composition
   */
  private processPendingKeyAfterComposition(): void {
    if (this.pendingKeyAfterComposition) {
      const key = this.pendingKeyAfterComposition;
      this.pendingKeyAfterComposition = null;
      // VENDOR HARDENING (0.4.0-nex.1): only replay single-character terminators.
      // A composition ended by a named key (e.g. "Enter") would otherwise write the
      // literal key name to the PTY as text.
      if (key.length === 1) {
        this.onDataCallback(key);
      }
    }
  }

  /**
   * Cleanup text nodes in container after composition
   */
  private cleanupCompositionTextNodes(): void {
    // Cleanup text nodes in container (fix for duplicate text display)
    // When the container is contenteditable, the browser might insert text nodes
    // upon composition end. We need to remove them to prevent duplicate display.
    if (this.container && this.container.childNodes) {
      for (let i = this.container.childNodes.length - 1; i >= 0; i--) {
        const node = this.container.childNodes[i];
        // Node.TEXT_NODE === 3
        if (node.nodeType === 3) {
          this.container.removeChild(node);
        }
      }
    }
  }

  /**
   * Dispose the InputHandler and remove event listeners
   */
  dispose(): void {
    if (this.isDisposed) return;

    if (this.keydownListener) {
      this.container.removeEventListener('keydown', this.keydownListener);
      this.keydownListener = null;
    }

    if (this.keypressListener) {
      this.container.removeEventListener('keypress', this.keypressListener);
      this.keypressListener = null;
    }

    if (this.pasteListener) {
      this.container.removeEventListener('paste', this.pasteListener);
      this.pasteListener = null;
    }

if (this.beforeInputListener && this.inputElement) {
      this.inputElement.removeEventListener('beforeinput', this.beforeInputListener);
      this.beforeInputListener = null;
    }

    // Remove composition listeners from the same element they were attached to
    const compositionTarget = this.inputElement || this.container;
    if (this.compositionStartListener) {
      compositionTarget.removeEventListener('compositionstart', this.compositionStartListener);
      this.compositionStartListener = null;
    }

    if (this.compositionUpdateListener) {
      compositionTarget.removeEventListener('compositionupdate', this.compositionUpdateListener);
      this.compositionUpdateListener = null;
    }

    if (this.compositionEndListener) {
      compositionTarget.removeEventListener('compositionend', this.compositionEndListener);
      this.compositionEndListener = null;
    }

    this.isDisposed = true;
  }

  /**
   * Check if handler is disposed
   */
  isActive(): boolean {
    return !this.isDisposed;
  }
}
