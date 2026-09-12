import type { TerminalPaneProps } from '../terminal/TerminalPane';
import { registerTerminalPane } from '../terminal/pane-registry';
import { resolveTerminalTheme } from '../terminal/renderer';
import type { TerminalPresentation, TerminalScope } from './terminal';

/** Only presentation crosses the frame boundary; native callbacks and transport stay here. */
export function terminalPresentation(props: TerminalPaneProps): TerminalPresentation {
    return Object.fromEntries(Object.entries({
        focused: props.focused, visible: props.visible,
        // #166: omitted means yes, the same answer the bundled pane and the take-size-control
        // chip give: no known owner is a single-window session, which sizes its own PTY.
        ownsSize: props.ownsSize !== false,
        theme: props.theme ?? resolveTerminalTheme(document.documentElement),
        fontFamily: props.fontFamily, fontSize: props.fontSize, paddingX: props.paddingX,
        paddingY: props.paddingY, background: props.background, allowTransparency: props.allowTransparency,
        accessibilityName: props.accessibilityName, reveal: props.reveal ?? null
    }).filter(([, value]) => value !== undefined)) as unknown as TerminalPresentation;
}

export function registerPluginTerminal(paneID: string, scope: TerminalScope, root: () => HTMLIFrameElement | null,
    current: () => TerminalPaneProps | undefined): () => void {
    const action = (value: Parameters<TerminalScope['action']>[0]): boolean => {
        if (!scope.attached || !current()?.visible) return false;
        void scope.action(value).catch(() => {}); return true;
    };
    return registerTerminalPane(paneID, {
        selection: () => '',
        readSelection: async () => {
            const value = await scope.action({ type: 'selection' });
            return typeof value === 'string' ? value : '';
        },
        write: data => scope.write(data),
        root,
        dispatchKey: key => action({ type: 'dispatchKey', key }),
        pasteText: text => action({ type: 'paste', text }),
        showKeyboard: () => { root()?.focus(); action({ type: 'showKeyboard' }); },
        hideKeyboard: () => { action({ type: 'hideKeyboard' }); root()?.blur(); },
        setModifiers: modifiers => { action({ type: 'modifiers', ...modifiers }); },
        cellHeight: () => scope.cellHeight,
        focusedOnScreen: () => scope.attached && current()?.visible === true && current()?.focused === true
    });
}
