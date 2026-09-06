/**
 * The one place the shell constructs an Electron `Notification` (#67).
 *
 * WHY IT EXISTS. `KELPI_HARNESS_SOCKET` (#65) can count `app.dock.bounce` and
 * `dialog.showMessageBox` because both are properties on live objects the shell reaches by
 * property every time (`app.dock`, `dialog`), so the channel replaces the property and the call
 * sites are none the wiser. `new Notification(...)` is neither: it is a CLASS reached through an
 * ESM import binding, which no module outside `status.ts` and `main.ts` can reassign. That was
 * the one hole in `scripts/ui-audit/README.md`'s "Where this stops" — a scenario could not
 * assert that a notification was shown, with what, or what clicking it does, which is most of
 * agent-lifecycle.md §7.
 *
 * So the construction is behind a module-level function every site calls, and the function is
 * indirected through a swappable presenter. This is the same split as `./harness.ts` ▸
 * `./harness-protocol.ts` and `./status.ts` ▸ `./agents.ts`: what has the Electron side effect
 * is thin and lives here, what DECIDES anything is pure and lives in `./notify.ts` (the request
 * and category shapes) and `./harness-protocol.ts` (the recording rules), where it is tested.
 *
 * WHAT IT COSTS A USER. Nothing observable. `electronPresenter` builds exactly the options
 * object each call site built before: a key it is not given is not passed, so the two `main.ts`
 * notices still construct `{ title, body }` and nothing else, and a handler the caller did not
 * supply is still not registered. With the channel off, `presentNotification` is one extra
 * function call into a module-level constant. `notify-present.test.ts` pins both halves.
 */

import { Notification } from 'electron';

import type {
    KelpiNotificationHandle,
    KelpiNotificationHandlers,
    KelpiNotificationRequest,
    NotificationPresenter
} from './notify.js';

/**
 * `Notification.isSupported()` is the Electron shell's whole notification gate (§7.5: the
 * browser client is the half that has to ask permission). Here so a call site needs one import
 * for the seam rather than one for the seam and one for the class it was meant to stop naming.
 */
export function notificationsSupported(): boolean {
    return Notification.isSupported();
}

/**
 * The real thing: an Electron `Notification`, with only the options the caller actually asked
 * for and only the listeners the caller actually supplied.
 */
const electronPresenter: NotificationPresenter = (request, handlers): KelpiNotificationHandle => {
    const notification = new Notification({
        title: request.title,
        body: request.body,
        ...(request.silent === undefined ? {} : { silent: request.silent }),
        // Electron's `NotificationAction[]` is mutable; the category's array is not, by design.
        ...(request.actions === undefined
            ? {}
            : { actions: request.actions.map((action) => ({ type: action.type, text: action.text })) })
    });
    const { onClick, onAction, onClose } = handlers;
    if (onClick !== undefined) notification.on('click', () => onClick());
    // Electron reports the chosen action by its INDEX; `notificationActionID` is what names it.
    if (onAction !== undefined) notification.on('action', (_event, index) => onAction(index));
    if (onClose !== undefined) notification.on('close', () => onClose());
    return {
        show: () => notification.show(),
        close: () => notification.close()
    };
};

let presenter: NotificationPresenter = electronPresenter;

/**
 * Post a notification. The one call every site makes, and the seam the harness wraps.
 *
 * `handlers` defaults to none, which is what the shell's own notices (a CLI that could not be
 * linked, a transparency change that needs a relaunch) want: they say something and are not
 * clickable.
 */
export function presentNotification(
    request: KelpiNotificationRequest,
    handlers: KelpiNotificationHandlers = {}
): KelpiNotificationHandle {
    return presenter(request, handlers);
}

/**
 * Swap the presenter and hand back the one that was there, so the caller can put it back.
 *
 * The only caller is `./harness.ts`, and only under `KELPI_HARNESS_SOCKET`; `stopHarness()`
 * restores by calling this with what it got. Deliberately not a "reset to default": the
 * wrappers in `harness.ts` restore the previous value rather than assume they were first, which
 * is the same discipline `wrapDock` and `wrapDialog` follow.
 */
export function setNotificationPresenter(next: NotificationPresenter): NotificationPresenter {
    const previous = presenter;
    presenter = next;
    return previous;
}

/** The shipped presenter, for a test that wants to assert nothing else is installed. */
export const SHIPPED_NOTIFICATION_PRESENTER = electronPresenter;
