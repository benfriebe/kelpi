import type { WindowUIServices, UIQuickPickOptions, UIDialogOptions } from './ui.js';
import type { BackendAPI } from './index.js';

declare const ui: WindowUIServices;
const picker: UIQuickPickOptions = { title: 'Select pane', items: [{ id: 'terminal', label: 'Terminal', description: 'Run commands' }, { id: 'closed', label: 'Closed', disabled: true }] };
const dialog: UIDialogOptions = { title: 'Continue?', message: 'The plugin has work to do.', actions: [{ id: 'cancel', label: 'Cancel', kind: 'default' }, { id: 'continue', label: 'Continue', kind: 'primary' }], cancelID: 'cancel' };
const selected: Promise<string | null> = ui.showQuickPick(picker);
const value: Promise<string | null> = ui.showInput({ title: 'Name', value: '', password: false, maxLength: 120 });
const action: Promise<string | null> = ui.showDialog(dialog);
const notification: Promise<string | null> = ui.showNotification({ message: 'Saved', tone: 'success', actions: [{ id: 'open', label: 'Open' }] });
void [selected, value, action, notification];
// @ts-expect-error Callbacks cannot cross the window UI bridge.
ui.showNotification({ message: 'Saved', actions: [{ id: 'open', label: 'Open', onClick() {} }] });
// @ts-expect-error A picker returns an item ID, not its presentation row.
const wrongResult: Promise<{ id: string } | null> = ui.showQuickPick(picker);
// @ts-expect-error Dialog actions use a bounded set of presentation kinds.
ui.showDialog({ title: 'Dialog', message: 'Choose', actions: [{ id: 'yes', label: 'Yes', kind: 'html' }] });
// @ts-expect-error Rendering code is not a UI option.
ui.showInput({ title: 'Input', render: () => '<input>' });
void wrongResult;

// Backends (#389) take the same options and results, plus an optional window target.
declare const backend: BackendAPI;
const backendAction: Promise<string | null> = backend.ui.showDialog(dialog);
const backendPick: Promise<string | null> = backend.ui.showQuickPick(picker, { windowID: 'window' });
const backendValue: Promise<string | null> = backend.ui.showInput({ title: 'Name' }, {});
const backendNotice: Promise<string | null> = backend.ui.showNotification({ message: 'Done', tone: 'info' });
void [backendAction, backendPick, backendValue, backendNotice, backend.ui.reveal('pane')];
// @ts-expect-error Backend dialogs use the view's option shape.
backend.ui.showDialog({ title: 'Dialog', actions: [] });
// @ts-expect-error A window target is an ID, not a window object.
backend.ui.showInput({ title: 'Input' }, { windowID: 1 });
// @ts-expect-error Window chrome stays view-only.
backend.ui.getInteraction();
// @ts-expect-error A backend prompt resolves with an ID or null.
const wrongBackend: Promise<number> = backend.ui.showInput({ title: 'Name' });
void wrongBackend;
