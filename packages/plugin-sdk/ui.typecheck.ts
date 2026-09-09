import type { WindowUIServices, UIQuickPickOptions, UIDialogOptions } from './ui.js';

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
