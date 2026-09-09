import type { ReactElement } from 'react';
import type { PluginItemTone } from '@kelpi/protocol';
import type { ResolvedContributionItem } from './contributions';

const tones: Record<PluginItemTone, string> = {
    default: 'var(--kelpi-fg-secondary, #9A9AA0)', info: 'var(--kelpi-blue, #6F9BD8)',
    success: 'var(--kelpi-green, #86B78F)', warning: 'var(--kelpi-yellow, #D9BC79)', error: 'var(--kelpi-red, #D98282)'
};
export interface PluginContributionItemsProps {
    readonly items: readonly ResolvedContributionItem[];
    readonly execute: (commandID: string, paneID?: string, itemID?: string) => void;
    readonly paneID?: string | undefined;
    readonly compact?: boolean | undefined;
}
/** Native controls with bounded widths; plugin text is rendered as text, never HTML. */
export function PluginContributionItems({ items, execute, paneID, compact = false }: PluginContributionItemsProps): ReactElement | null {
    if (!items.length) return null;
    return <div data-testid="plugin-contribution-items" role="group" aria-label="Plugin contributions"
        onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
        className="flex min-w-0 max-w-full shrink items-center gap-1 overflow-x-auto">
        {items.map(item => {
            const content = <><span className="min-w-0 truncate">{item.text}</span>{item.badge ? <span className="max-w-16 shrink-0 truncate rounded bg-current/10 px-1 text-[10px]" aria-hidden="true">{item.badge}</span> : null}</>;
            const common = {
                'data-testid': `plugin-item-${item.id}`, 'data-plugin-item': item.id, 'data-tone': item.tone,
                title: item.tooltip || item.text, 'aria-label': [item.text || item.tooltip || 'Plugin contribution', item.badge].filter(Boolean).join(', '),
                className: `inline-flex min-w-0 shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${compact ? 'max-w-32' : 'max-w-56'}`,
                style: { color: tones[item.tone] }
            };
            return item.command ? <button key={item.id} {...common} type="button" disabled={!item.enabled}
                className={`${common.className} disabled:opacity-40 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1`}
                onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
                onClick={event => { event.stopPropagation(); if (item.enabled) execute(item.command!, paneID, item.id); }}>{content}</button>
                : <span key={item.id} {...common} aria-disabled={!item.enabled || undefined}>{content}</span>;
        })}
    </div>;
}
