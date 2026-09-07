import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_KEYBINDINGS } from '@kelpi/core/config';
import { ContentFrame } from './ContentFrame';
import { CONTENT_BRIDGE_SOURCE, prepareContentDocument } from './bridge';
import { createKeyDispatcher, installKeyDispatcher } from '../chrome/keys';
import { sha256 } from './asset-credential';

afterEach(cleanup);

it('puts a hash-only script policy before hostile markup and removes meta refresh', () => {
    const html = '<script>parent.postMessage({evil:true}, "*")</script><meta http-equiv="refresh" content="0;url=https://example.com"><p onclick="alert(1)">hello</p>';
    const prepared = prepareContentDocument(html, { paneID: 'p' });
    const doc = new DOMParser().parseFromString(prepared, 'text/html');
    const policy = doc.head.firstElementChild as HTMLMetaElement;
    expect(policy.httpEquiv).toBe('Content-Security-Policy');
    expect(policy.content).not.toContain("script-src 'unsafe-inline'");
    expect(policy.content).toContain("frame-src 'none'");
    const bridge = [...doc.querySelectorAll('script')].at(-1)!;
    const hash = btoa(String.fromCharCode(...sha256(new TextEncoder().encode(bridge.textContent!))));
    expect(policy.content).toContain(`script-src 'sha256-${hash}'`);
    expect(doc.querySelector('meta[http-equiv="refresh"]')).toBeNull();
    expect(doc.querySelector('p')?.textContent).toBe('hello');
});

it('rejects forged unclaimed shortcuts even when sent by the correct iframe', () => {
    const close = vi.fn(() => true);
    const paste = vi.fn(() => true);
    const off = installKeyDispatcher(window, createKeyDispatcher({ bindings: DEFAULT_KEYBINDINGS, actions: { close_pane: close, paste } }));
    try {
        const view = render(<ContentFrame paneID="p" title="preview" html="<p>note</p>" claimedChords={[]} />);
        const frame = view.container.querySelector('iframe')!;
        for (const code of ['KeyW', 'KeyV']) window.dispatchEvent(new MessageEvent('message', {
            source: frame.contentWindow, origin: 'null',
            data: { source: CONTENT_BRIDGE_SOURCE, paneID: 'p', kind: 'key', code, metaKey: true }
        }));
        expect(close).not.toHaveBeenCalled();
        expect(paste).not.toHaveBeenCalled();
    } finally { off(); }
});
