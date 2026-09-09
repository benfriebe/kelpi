/** Window UI belongs to the attached browser view; removing it cancels all of its requests. */
export interface UIQuickPickItem {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    readonly disabled?: boolean;
}
export interface UIQuickPickOptions {
    readonly title: string;
    readonly placeholder?: string;
    readonly items: readonly UIQuickPickItem[];
    readonly selectedID?: string;
}
export interface UIInputOptions {
    readonly title: string;
    readonly prompt?: string;
    readonly value?: string;
    readonly placeholder?: string;
    readonly password?: boolean;
    /** 1–16384 characters; defaults to 4096. Initial values must fit this limit. */
    readonly maxLength?: number;
}
export interface UIDialogAction {
    readonly id: string;
    readonly label: string;
    readonly kind?: 'default' | 'primary' | 'danger';
}
export interface UIDialogOptions {
    readonly title: string;
    readonly message: string;
    readonly detail?: string;
    readonly actions: readonly UIDialogAction[];
    /** Initially focuses this action. Escape and backdrop dismissal still return null. */
    readonly cancelID?: string;
}
export interface UINotificationAction {
    readonly id: string;
    readonly label: string;
}
export interface UINotificationOptions {
    readonly message: string;
    readonly detail?: string;
    readonly tone?: 'info' | 'success' | 'warning' | 'error';
    readonly actions?: readonly UINotificationAction[];
}
export interface WindowUIServices {
    /** Selects one enabled item. Escape or dismissal returns null. */
    showQuickPick(options: UIQuickPickOptions): Promise<string | null>;
    /** Returns the entered string, including an empty string; cancellation returns null. */
    showInput(options: UIInputOptions): Promise<string | null>;
    /** Returns an explicitly chosen action ID; cancellation returns null. */
    showDialog(options: UIDialogOptions): Promise<string | null>;
    /** Returns an action ID, or null on dismissal or 10 seconds after entering the visible stack. */
    showNotification(options: UINotificationOptions): Promise<string | null>;
}
