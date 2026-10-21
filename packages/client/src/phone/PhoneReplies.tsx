/**
 * Quick replies: a waiting agent's question and its answers, wherever the phone shows a wait.
 *
 * One component per job, shared by Home's cards, the Needs-you sheet and the strip under a waiting
 * pane, so a prompt reads and answers the same way in all three. The prompt itself comes from
 * `prompt-capture.ts`, which reads it once per wait and sends an answer only to the screen it read.
 */

import { useEffect, type ReactElement } from 'react';

import { tokens } from '../chrome/tokens';
import type { KelpiRuntime } from '../state';
import { PhoneGlyph } from './glyphs';
import { useWaitClock, waitedFor } from './attention';
import { answerPrompt, requestPrompt, usePhonePrompt, type PhonePromptEntry } from './prompt-capture';
import { cardChoices, type PhonePromptChoice } from './prompts';
import { phoneStyle } from './style';

export interface PhoneReplyTarget {
    /** The attention item's key: `host/pane`. */
    readonly key: string;
    readonly runtime: KelpiRuntime;
    readonly paneID: string;
}

/** "4m": how long this page has seen the item waiting, kept current by the shared clock. */
export function WaitedFor(props: { readonly itemKey: string }): ReactElement {
    const now = useWaitClock();
    return <>{waitedFor(props.itemKey, now)}</>;
}

/** The waiting pane's prompt, asked for on first use and live after. */
export function useWaitingPrompt(target: PhoneReplyTarget | null): PhonePromptEntry | undefined {
    const entry = usePhonePrompt(target?.key ?? '');
    // Asked again whenever the reading is gone: a host that dropped and came back has had its
    // reading forgotten, and a surface still showing the wait should read it afresh.
    const missing = entry === undefined;
    useEffect(() => {
        if (target !== null && missing) requestPrompt(target.key, target.runtime, target.paneID);
    }, [target?.key, target?.runtime, target?.paneID, missing]);
    return target === null ? undefined : entry;
}

/** The question, as the screen asked it; a placeholder while it is being read. */
export function PromptText(props: { readonly entry: PhonePromptEntry | undefined; readonly fallback: string; readonly boxed?: boolean; readonly lines?: number }): ReactElement {
    const full = props.entry?.prompt?.question ?? (props.entry?.state === 'reading' || props.entry === undefined ? 'Reading the prompt…' : props.fallback);
    // The END of a long question is the part that asks ("Do you want to proceed?"), so a card with
    // room for fewer lines keeps the last ones, each on one line, and marks what it left out.
    const max = props.lines ?? 2;
    const rows = full.split('\n');
    const text = rows.length > max ? ['…', ...rows.slice(-(max - 1))].join('\n') : full;
    return (
        <div
            data-testid="phone-prompt-text"
            className={`font-mono text-[12px] leading-[17px] whitespace-pre-line ${props.boxed === true ? 'rounded-[10px] px-[10px] py-2' : ''}`}
            style={{
                color: tokens.textSecondary,
                background: props.boxed === true ? phoneStyle.sunken : undefined,
                display: '-webkit-box',
                WebkitBoxOrient: 'vertical',
                WebkitLineClamp: max,
                overflow: 'hidden'
            }}
        >
            {text}
        </div>
    );
}

function ReplyButton(props: {
    readonly choice: PhonePromptChoice;
    readonly primary: boolean;
    readonly disabled: boolean;
    readonly chip?: boolean;
    /** A full-width row in a stack of answers, rather than a button in a line of them. */
    readonly wide?: boolean;
    readonly testID: string;
    readonly onClick: () => void;
}): ReactElement {
    const { choice } = props;
    const shape = props.wide === true ? 'w-full justify-start' : props.chip === true ? 'max-w-[170px] shrink-0' : 'min-w-[56px] shrink';
    return (
        <button
            type="button"
            data-testid={props.testID}
            disabled={props.disabled}
            className={`flex h-[44px] min-w-0 items-center gap-1 px-[14px] text-[15px] ${shape} ${props.chip === true ? 'rounded-full' : 'rounded-[12px]'}`}
            style={{
                background: props.primary ? phoneStyle.accentFill : 'transparent',
                color: props.primary ? phoneStyle.onAccent : tokens.textPrimary,
                border: props.primary ? 'none' : `1px solid ${phoneStyle.waitingBorder}`,
                fontWeight: props.primary ? 600 : 400,
                opacity: props.disabled ? 0.5 : 1
            }}
            onClick={props.onClick}
        >
            {props.chip === true || props.wide === true || choice.label.length > 12 ? <span className="shrink-0 opacity-70">{`${choice.hint} ·`}</span> : null}
            <span className="truncate">{choice.label}</span>
        </button>
    );
}

/**
 * The answers to a prompt, then Open. `max` keeps a card to the answers that fit; Open is always
 * there, because the screen is the place to answer anything a button cannot.
 */
export function ReplyRow(props: {
    readonly target: PhoneReplyTarget;
    readonly entry: PhonePromptEntry | undefined;
    readonly max: number;
    readonly onOpen: () => void;
    readonly openLabel?: string;
    /** `stack` puts each answer on its own full-width row, for a card with room for the words. */
    readonly layout?: 'row' | 'stack';
    /** Test ids start with this, so two surfaces showing one prompt stay apart. */
    readonly idPrefix?: string;
}): ReactElement {
    const prefix = props.idPrefix ?? 'phone-reply';
    const all = props.entry?.prompt?.choices ?? [];
    // A card with room for fewer than the whole menu shows its first and last answers only.
    const choices = all.length > props.max ? cardChoices(all) : all;
    const stack = props.layout === 'stack';
    // Down while an answer is on its way AND while the prompt is being read again: a button over a
    // prompt that may have changed answers nothing.
    const sending = props.entry?.sending === true || props.entry?.state !== 'ready';
    if (choices.length === 0) {
        return (
            <div className="flex flex-col gap-1">
                {props.entry?.notice ? <Notice text={props.entry.notice} /> : null}
                <button
                    type="button"
                    data-testid={`${prefix}-open-${props.target.paneID}`}
                    className="flex h-[44px] items-center justify-center gap-1 rounded-[12px] text-[15px] font-semibold"
                    style={{ background: phoneStyle.accentFill, color: phoneStyle.onAccent }}
                    onClick={props.onOpen}
                >
                    {props.openLabel ?? 'Open'}
                    <PhoneGlyph name="chevron-right" size={16} weight={2.2} />
                </button>
            </div>
        );
    }
    const buttons = choices.map((choice, index) => (
        <ReplyButton
            key={choice.hint}
            testID={`${prefix}-${props.target.paneID}-${choice.hint}`}
            choice={choice}
            primary={index === 0}
            disabled={sending}
            wide={stack}
            onClick={() => void answerPrompt(props.target.key, props.target.runtime, props.target.paneID, choice)}
        />
    ));
    return (
        <div className="flex flex-col gap-1">
            {props.entry?.notice ? <Notice text={props.entry.notice} /> : null}
            {stack ? <div className="flex flex-col gap-[6px]">{buttons}</div> : null}
            <div className="flex min-w-0 items-center gap-2">
                {stack ? null : buttons}
                <button
                    type="button"
                    data-testid={`${prefix}-open-${props.target.paneID}`}
                    className="ml-auto flex h-[44px] shrink-0 items-center gap-[2px] pr-1 pl-[10px] text-[15px]"
                    style={{ color: tokens.accent }}
                    onClick={props.onOpen}
                >
                    Open
                    <PhoneGlyph name="chevron-right" size={16} weight={2} />
                </button>
            </div>
        </div>
    );
}

function Notice(props: { readonly text: string }): ReactElement {
    return (
        <span role="status" data-testid="phone-reply-notice" className="truncate text-[12px]" style={{ color: phoneStyle.waitingText }}>
            {props.text}
        </span>
    );
}

/** The chips under a waiting pane: its answers, in the strip, without leaving the pane. */
export function ReplyChips(props: { readonly target: PhoneReplyTarget; readonly entry: PhonePromptEntry | undefined }): ReactElement | null {
    const choices = props.entry?.prompt?.choices ?? [];
    if (choices.length === 0) return null;
    // Down while an answer is on its way AND while the prompt is being read again: a button over a
    // prompt that may have changed answers nothing.
    const sending = props.entry?.sending === true || props.entry?.state !== 'ready';
    return (
        <div data-testid="phone-reply-chips" className="flex min-w-0 items-center gap-2 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
            {choices.map((choice, index) => (
                <ReplyButton
                    key={choice.hint}
                    testID={`phone-chip-${props.target.paneID}-${choice.hint}`}
                    choice={choice}
                    primary={index === 0}
                    disabled={sending}
                    chip
                    onClick={() => void answerPrompt(props.target.key, props.target.runtime, props.target.paneID, choice)}
                />
            ))}
        </div>
    );
}
