/**
 * Notifications on this phone (agent-lifecycle.md §7.8, phone-ui.md "Notifications"): turn push
 * on or off, see which hosts will push here, and ask each for a test.
 *
 * It says what to do when push cannot work here rather than hiding: on an iPhone the answer is
 * almost always "add Kelpi to the Home Screen first", and a missing row would leave the person
 * looking for a setting that does not exist yet.
 */

import { useEffect, useState, type ReactElement } from 'react';

import { tokens } from '../chrome/tokens';
import type { PushDeviceState } from '../pwa/push';
import type { PhoneHostModel } from './model';
import type { PushHostStatus, PushTestOutcome } from './push-hosts';
import { phoneStyle } from './style';
import { PHONE_ROW_MIN_PX, PhoneSheet, PhoneSheetHeader } from './ui';

export interface PhoneNotificationsSheetProps {
    readonly open: boolean;
    readonly state: PushDeviceState;
    readonly hosts: readonly PhoneHostModel[];
    readonly statuses: ReadonlyMap<string, PushHostStatus>;
    readonly onEnable: () => void;
    readonly onDisable: () => void;
    readonly onTest: () => Promise<readonly PushTestOutcome[]>;
    readonly onClose: () => void;
}

const DANGER = '#E5484D';

/** Why push cannot work here, in words that say what to do. */
function unavailableText(availability: PushDeviceState['availability']): string | null {
    switch (availability) {
        case 'install-first':
            return 'On an iPhone, notifications need Kelpi on your Home Screen. In Safari, tap Share, then Add to Home Screen. Open Kelpi from the Home Screen and come back here.';
        case 'insecure':
            return 'Notifications need a secure connection. Open Kelpi at its https:// address (kelpid url --tailnet prints it).';
        case 'unsupported':
            return "This browser can't receive push notifications.";
        case 'available':
            return null;
    }
}

function statusText(status: PushHostStatus | undefined): { text: string; color: string } {
    switch (status?.state) {
        case 'on':
            return { text: 'On', color: tokens.statusRunning };
        case 'registering':
            return { text: 'Setting up…', color: tokens.textSecondary };
        case 'waiting':
        case undefined:
            return { text: 'Waiting to connect', color: tokens.textSecondary };
        case 'error':
            return { text: status.message, color: DANGER };
        case 'off':
            return { text: 'Off', color: tokens.textSecondary };
    }
}

function Paragraph(props: { readonly testID: string; readonly color?: string; readonly children: string }): ReactElement {
    return (
        <p data-testid={props.testID} className="px-4 py-2 text-[14px] leading-snug" style={{ color: props.color ?? tokens.textSecondary }}>
            {props.children}
        </p>
    );
}

export function PhoneNotificationsSheet(props: PhoneNotificationsSheetProps): ReactElement | null {
    const { state } = props;
    const [tests, setTests] = useState<ReadonlyMap<string, PushTestOutcome> | null>(null);
    const [testing, setTesting] = useState(false);

    // A fresh look every time the sheet opens: last time's "Sent" says nothing about now.
    useEffect(() => {
        if (props.open) setTests(null);
    }, [props.open]);

    const unavailable = unavailableText(state.availability);
    const on = state.wanted && state.registration !== null;
    const anyHostOn = props.hosts.some((host) => props.statuses.get(host.key)?.state === 'on');

    const test = (): void => {
        setTesting(true);
        props.onTest().then(
            (outcomes) => {
                setTests(new Map(outcomes.map((outcome) => [outcome.hostKey, outcome] as const)));
                setTesting(false);
            },
            () => setTesting(false)
        );
    };

    return (
        <PhoneSheet open={props.open} side="bottom" label="Notifications" testID="phone-notifications" onClose={props.onClose}>
            <PhoneSheetHeader title="Notifications" testID="phone-notifications-header" onClose={props.onClose} />
            <div className="flex min-h-0 flex-col overflow-y-auto overscroll-contain pb-2">
                <Paragraph testID="phone-notifications-intro">
                    Get a notification on this phone when an agent on one of your hosts needs you, while Kelpi is closed or in the background.
                </Paragraph>
                {unavailable !== null ? (
                    <Paragraph testID="phone-notifications-unavailable" color={tokens.textPrimary}>
                        {unavailable}
                    </Paragraph>
                ) : null}
                {state.error !== null ? (
                    <Paragraph testID="phone-notifications-error" color={DANGER}>
                        {state.error}
                    </Paragraph>
                ) : null}
                {unavailable === null && !on ? (
                    <div className="px-4 py-2">
                        <button
                            type="button"
                            data-testid="phone-notifications-enable"
                            disabled={state.busy}
                            className="flex h-[52px] w-full items-center justify-center rounded-[14px] text-[15px] font-semibold"
                            style={{ background: phoneStyle.accentFill, color: phoneStyle.onAccent, opacity: state.busy ? 0.6 : 1 }}
                            // Straight from the tap: the permission prompt only shows inside it.
                            onClick={props.onEnable}
                        >
                            {state.busy ? 'Turning on…' : 'Turn on notifications'}
                        </button>
                    </div>
                ) : null}
                {on ? (
                    <>
                        <div className="px-4 pt-2 text-[12px] font-semibold uppercase tracking-wide" style={{ color: tokens.textTertiary }}>
                            Hosts
                        </div>
                        {props.hosts.map((host) => {
                            const status = statusText(props.statuses.get(host.key));
                            const result = tests?.get(host.key);
                            return (
                                <div
                                    key={host.key}
                                    data-testid="phone-notifications-host"
                                    data-host-key={host.key}
                                    data-push-state={props.statuses.get(host.key)?.state ?? 'waiting'}
                                    className="flex items-center gap-3 px-4 text-[15px]"
                                    style={{ minHeight: `${String(PHONE_ROW_MIN_PX)}px` }}
                                >
                                    <span className="min-w-0 flex-1 truncate">{host.name}</span>
                                    <span className="max-w-[60%] text-right text-[13px]" style={{ color: result !== undefined ? (result.ok ? tokens.statusRunning : DANGER) : status.color }}>
                                        {result !== undefined ? (result.ok ? 'Test sent' : result.message) : status.text}
                                    </span>
                                </div>
                            );
                        })}
                        <div className="flex flex-col gap-2 px-4 pt-3">
                            <button
                                type="button"
                                data-testid="phone-notifications-test"
                                disabled={!anyHostOn || testing}
                                className="flex h-[48px] w-full items-center justify-center rounded-[14px] border text-[15px] font-medium"
                                style={{ background: phoneStyle.card, borderColor: phoneStyle.raisedBorder, color: tokens.textPrimary, opacity: !anyHostOn || testing ? 0.5 : 1 }}
                                onClick={test}
                            >
                                {testing ? 'Sending…' : 'Send a test notification'}
                            </button>
                            <button
                                type="button"
                                data-testid="phone-notifications-disable"
                                disabled={state.busy}
                                className="flex h-[48px] w-full items-center justify-center rounded-[14px] text-[15px]"
                                style={{ color: DANGER, opacity: state.busy ? 0.5 : 1 }}
                                onClick={props.onDisable}
                            >
                                Turn off notifications
                            </button>
                        </div>
                    </>
                ) : null}
            </div>
        </PhoneSheet>
    );
}
