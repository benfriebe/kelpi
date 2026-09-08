/**
 * A web pane on a phone (B7, owner request 2026-09-08: "all pane types pass through the shell").
 *
 * **An owner-directed divergence from the shipped Swift app**, like every phone rule in this
 * program (there is no Swift phone UI; `chrome/form-factor.ts` says so once for all of it).
 *
 * MOBILE-PLAN.md §9: *"Web panes stay a card on the phone. Say so in the card; do not attempt an
 * in-app browser."* This is that card, and it is the ONE pane type the phone shell draws itself
 * instead of handing to the desktop's `renderPane`. Two reasons, both structural rather than
 * cosmetic:
 *
 *   - **the page is not this client's to draw.** `webpane/WebPane.tsx` renders CHROME around a
 *     measured hole that the Electron shell fills with a native `WebContentsView` composited over
 *     the document. A phone browser has no such shell, so the hole is empty; and inside the
 *     Electron shell under the audit's device emulation the hole is filled by a native view
 *     positioned in the desktop window's coordinates, which is a page laid over the phone layout.
 *     Neither is a web pane on a phone, so the shell answers the question before the component is
 *     reached rather than after.
 *   - **its chrome is not thumb-sized.** The desktop pane's back/forward/reload/tab controls are
 *     22 px boxes, half B5's 44 px floor, on a bar that also holds a URL field. Shrinking them is
 *     a design job for a lane that has a device round to validate it; saying so is honest today.
 *
 * What the card does offer is the page's own address, and a plain link that hands it to the
 * phone's browser. That is not an in-app browser: it is the same tap the person would make from a
 * message, and it leaves Kelpi rather than pretending to host the page.
 */

import type { ReactElement } from 'react';

import type { WorkspaceState } from '@kelpi/daemon/store';

import { ChromeIcon } from '../chrome/icons';
import { tokens } from '../chrome/tokens';
import { PHONE_ROW_MIN_PX } from './ui';

export interface PhoneWebCardTab {
    readonly url: string;
    readonly title: string;
}

/**
 * The tab the card stands in for: the pane's ACTIVE tab, or its first, exactly as `App.tsx`'s
 * `renderPane` picks the tab it hands `WebPane`. Null for a pane with no tabs at all.
 */
export function phoneWebCardTab(workspace: WorkspaceState | null, paneID: string): PhoneWebCardTab | null {
    const web = workspace?.webPanes[paneID];
    if (web === undefined) return null;
    const tab = web.tabs.find((entry) => entry.id === web.activeTabID) ?? web.tabs[0] ?? null;
    if (tab === null) return null;
    return { url: tab.url, title: tab.title };
}

/** Only a real web address is worth handing to the browser; anything else is shown, not linked. */
function browsable(url: string): boolean {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

export interface PhoneWebCardProps {
    readonly paneID: string;
    readonly tab: PhoneWebCardTab | null;
}

export function PhoneWebCard(props: PhoneWebCardProps): ReactElement {
    const url = props.tab?.url ?? '';
    const title = props.tab?.title ?? '';
    return (
        <div
            data-testid={`phone-web-card-${props.paneID}`}
            className="flex h-full w-full items-center justify-center overflow-hidden p-4"
            style={{ background: tokens.windowBackground }}
        >
            <div
                className="flex max-w-full flex-col items-center gap-2 rounded-lg px-5 py-4 text-center"
                style={{ background: tokens.surfaceBackground, border: `1px solid ${tokens.divider}`, color: tokens.textSecondary }}
            >
                <span style={{ color: tokens.textTertiary }}>
                    <ChromeIcon name="globe" size={22} />
                </span>
                <span className="text-[13px] font-medium" style={{ color: tokens.textPrimary }}>
                    {title.length === 0 ? 'Web pane' : title}
                </span>
                {url.length === 0 ? null : (
                    <span className="max-w-[36ch] truncate font-mono text-[11px]" title={url} data-testid={`phone-web-card-url-${props.paneID}`}>
                        {url}
                    </span>
                )}
                <span className="max-w-[36ch] text-[11px]" style={{ color: tokens.textTertiary }}>
                    Kelpi does not host a browser view on a phone. Open this pane on the Mac, or open the page in the phone&apos;s
                    own browser.
                </span>
                {browsable(url) ? (
                    <a
                        data-testid={`phone-web-card-open-${props.paneID}`}
                        href={url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="flex items-center justify-center rounded px-3 text-[15px]"
                        style={{ color: tokens.accent, minHeight: `${String(PHONE_ROW_MIN_PX)}px` }}
                    >
                        Open in a browser tab
                    </a>
                ) : null}
            </div>
        </div>
    );
}
