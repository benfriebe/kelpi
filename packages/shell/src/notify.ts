/**
 * The `kelpi-agent` desktop-notification category, as far as Electron has one (§AGNT-073).
 *
 * The Swift registers a `UNNotificationCategory` once at launch — identifier `kelpi-agent`, two
 * actions, "Open" (`.foreground`) and "Dismiss" (`.destructive`) — and every agent notification
 * carries `content.categoryIdentifier = "kelpi-agent"`, which is what makes the two buttons a SET:
 * one registration, every notification, the same two choices in the same order.
 *
 * Electron has no category registry. `new Notification({ actions })` attaches the buttons to the
 * notification itself, so "registered once as a set" becomes "built once, here, and used by
 * every post" — this module is the registration. `status.ts` never spells the actions out; it
 * asks for the spec, and the `action` event's INDEX is resolved back to a named action by
 * `notificationActionID`, so the two halves cannot drift out of order.
 *
 * Pure on purpose (`vitest.config.mts`: anything importing `electron` cannot be unit-tested
 * under plain Node), and structurally typed so the spec drops straight into Electron's
 * `NotificationConstructorOptions`.
 *
 * Divergences from the Swift, recorded rather than hidden:
 *   - **No destructive styling.** `UNNotificationActionOptions.destructive` paints "Dismiss"
 *     red; an Electron `NotificationAction` has `type` and `text` and nothing else.
 *   - **macOS shows the first action as a button** and puts the rest behind the notification's
 *     "more" affordance, and shows none at all when the user's notification style for the app is
 *     Banner rather than Alert. That is the same OS rule the Swift category lives under — the
 *     ORDER is what the app controls, which is why "Open" is first in both.
 *   - **No permission request.** `UNUserNotificationCenter.requestAuthorization` has no Electron
 *     equivalent (`Notification.isSupported()` is the whole gate); the browser client asks from
 *     a user gesture instead (the first `pointerdown` in the window, `client/src/App.tsx`,
 *     through `client/src/state/notifications.ts`'s `request()`; agent-lifecycle.md §7.5), a
 *     deliberate constraint.
 */

/** The Swift's `NotificationService.categoryID`, kept verbatim. */
export const KELPI_AGENT_CATEGORY = 'kelpi-agent';

/** The Swift's action identifiers, in the order the category registers them. */
export const KELPI_AGENT_ACTION_IDS = ['open', 'dismiss'] as const;
export type KelpiNotificationActionID = (typeof KELPI_AGENT_ACTION_IDS)[number];

/** Structurally Electron's `NotificationAction`, without importing `electron`. */
export interface KelpiNotificationAction {
    readonly type: 'button';
    readonly text: string;
}

/**
 * The category's two actions. Index is identity here — macOS reports a chosen action by its
 * position, so this array's order IS the protocol between `agentNotificationSpec` and
 * `notificationActionID`.
 */
export const KELPI_AGENT_ACTIONS: readonly KelpiNotificationAction[] = [
    { type: 'button', text: 'Open' },
    { type: 'button', text: 'Dismiss' }
];

export interface AgentNotificationSpec {
    readonly title: string;
    readonly body: string;
    /** The Swift sets `content.sound = .default`; `silent: false` is the same statement. */
    readonly silent: false;
    readonly actions: readonly KelpiNotificationAction[];
}

export interface AgentNotificationInput {
    readonly title?: string | undefined;
    readonly body?: string | undefined;
}

/**
 * Every agent notification the shell posts, built the same way.
 *
 * The defaults match the Swift's: a missing title falls back to the app name, a missing body to
 * empty (the daemon always sends one, but a hand-written `kelpi event notification` need not).
 */
export function agentNotificationSpec(input: AgentNotificationInput): AgentNotificationSpec {
    const title = input.title !== undefined && input.title.length > 0 ? input.title : 'Kelpi';
    return {
        title,
        body: input.body ?? '',
        silent: false,
        actions: KELPI_AGENT_ACTIONS
    };
}

/**
 * Which action the user chose, from the index Electron reports on the `action` event.
 *
 * Out-of-range is `null` rather than a guess: a future macOS that reports something unexpected
 * must not be read as "Open" and raise a window nobody asked for.
 */
export function notificationActionID(index: number): KelpiNotificationActionID | null {
    if (!Number.isInteger(index) || index < 0 || index >= KELPI_AGENT_ACTION_IDS.length) return null;
    return KELPI_AGENT_ACTION_IDS[index] ?? null;
}

// ── the seam every notification goes through (#67) ──────────────────────────────────

/**
 * What the shell asks for when it posts a notification, as data.
 *
 * Every `new Notification(...)` the shell had was its own call to an Electron CLASS, which is
 * why the harness channel could count `app.dock.bounce` and `dialog.showMessageBox` (property
 * replacements on live objects) but not a single notification: there is no object to replace a
 * property on, and an ESM import binding cannot be reassigned from outside the module. So the
 * construction moved behind one function, `./notify-present.ts` ▸ `presentNotification`, and
 * this is its argument. `optional` means "do not pass the key to Electron at all": a request
 * that omits `silent` and `actions` builds the same options object the two `main.ts` notices
 * built before the seam existed, which is what makes a user's shell byte-identical.
 *
 * `paneID` and `key` are carried for the harness's benefit and are never given to Electron:
 * they are what makes agent-lifecycle.md §7.5's identifier (`kelpi-<paneID>`, "a newer
 * notification for the same pane replaces the older one") assertable from a scenario.
 */
export interface KelpiNotificationRequest {
    readonly title: string;
    readonly body: string;
    /** §7.5: `content.sound = .default` is `silent: false`. Omitted = Electron's own default. */
    readonly silent?: boolean | undefined;
    /** The `kelpi-agent` category's buttons, for the notifications that carry them (§AGNT-073). */
    readonly actions?: readonly KelpiNotificationAction[] | undefined;
    /** The pane this belongs to; null for the shell's own notices (the CLI and relaunch ones). */
    readonly paneID?: string | null | undefined;
    /** §7.5's dedupe identifier, where the caller has one. */
    readonly key?: string | null | undefined;
}

/**
 * The three things the OS can do to a posted notification, declared up front.
 *
 * Up front rather than `notification.on('click', …)` afterwards on purpose: the seam then has
 * every handler in hand at construction, so the harness can fire the exact function the OS
 * would have fired (`notification-click`, `notification-close`) without owning an event
 * emitter of its own or guessing at event names. §7.5 is what these mean: the body tap and the
 * "Open" action are the same behaviour, "Dismiss" only dismisses, and a close is a withdrawal.
 */
export interface KelpiNotificationHandlers {
    /** The body tap. */
    readonly onClick?: (() => void) | undefined;
    /** An action button, by the INDEX macOS reports; `notificationActionID` names it. */
    readonly onAction?: ((index: number) => void) | undefined;
    /** The notification went away, whoever withdrew it. */
    readonly onClose?: (() => void) | undefined;
}

/** What the caller holds afterwards: post it, and withdraw it (§7.5's replace-on-repost). */
export interface KelpiNotificationHandle {
    show(): void;
    close(): void;
}

/**
 * The seam's type. `./notify-present.ts` holds the real one; `./harness.ts` swaps in a
 * recording wrapper around it, and only ever while `KELPI_HARNESS_SOCKET` is set.
 */
export type NotificationPresenter = (
    request: KelpiNotificationRequest,
    handlers: KelpiNotificationHandlers
) => KelpiNotificationHandle;

/**
 * The one-line shape `status.ts` logs when it posts, so the smoke and the audit can assert that
 * a REAL `Notification` was constructed with the category's actions — the buttons themselves
 * live in the OS's notification centre, where no screenshot can reach them.
 */
export function notificationLogLine(key: string, spec: AgentNotificationSpec): string {
    return `notification posted: ${key} category=${KELPI_AGENT_CATEGORY} actions=${spec.actions
        .map((action) => action.text)
        .join(',')}`;
}
