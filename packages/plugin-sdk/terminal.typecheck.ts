import type { BackendAPI, TerminalAction, TerminalFrame, TerminalSession, ViewAPI } from './index.js';

declare const view: ViewAPI;
declare const backend: BackendAPI;

async function renderer(): Promise<void> {
    const session: TerminalSession = await view.terminal.attach({
        cols: 80,
        rows: 24,
        async onFrame(frame: TerminalFrame) {
            switch (frame.type) {
                case 'output': case 'replay': { const bytes: Uint8Array = frame.data; void bytes; break; }
                case 'resync': { const reason: string = frame.reason; void reason; break; }
                case 'modes': { const flags: number = frame.modes.kittyKeyboardFlags; void flags; break; }
                case 'exit': { const exit: number | null = frame.exitCode; void exit; break; }
                case 'presentation': { const visible: boolean = frame.value.visible; void visible; break; }
            }
        },
        async onAction(action: TerminalAction) {
            if (action.type === 'selection') return 'selected text';
            if (action.type === 'dispatchKey') { const location: number | undefined = action.key.location; void location; return false; }
            if (action.type === 'paste') { const text: string = action.text; void text; return true; }
            if (action.type === 'modifiers') { const ctrl: boolean = action.ctrl; void ctrl; }
            return null;
        },
    });
    session.write('hello'); session.write(new Uint8Array([27]));
    session.writeDirect('\x1b[0n'); session.resize(120, 40); session.setCellHeight(16.5);
    session.writeDirect('\x1b[0n', { response: true });
    // Existing terminal commands are available alongside the renderer contract.
    const captured: string = await view.terminal.capture('pane');
    void captured;
    session.dispose();
    // @ts-expect-error Only a browser terminal replacement can attach a renderer.
    await backend.terminal.attach({ cols: 80, rows: 24, onFrame() {} });
    // @ts-expect-error The SDK cannot acknowledge output without a consumer.
    await view.terminal.attach({ cols: 80, rows: 24 });
    // @ts-expect-error Initial geometry is required.
    await view.terminal.attach({ onFrame() {} });
    // @ts-expect-error Output is binary and does not cross the generic JSON transport.
    session.write([1, 2, 3]);
    // @ts-expect-error The renderer cannot grant arbitrary native output credit.
    session.ack(100);
    // @ts-expect-error Device response intent is an explicit boolean.
    session.writeDirect('\x1b[0n', { response: 'true' });
    // @ts-expect-error Sessions have immutable identifiers.
    session.id = 'other';
}
void renderer;
