import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { DARK_CHROME_THEME, LIGHT_CHROME_THEME, ThemeProvider, useChromeTheme } from './index';

afterEach(cleanup);

function Probe(): React.ReactElement {
    const { theme, bucket, appearance } = useChromeTheme();
    return (
        <span data-testid="probe" data-bucket={bucket} data-appearance={appearance}>
            {theme.textPrimary}
        </span>
    );
}

describe('ThemeProvider', () => {
    it('writes the resolved palette onto its own container', () => {
        const { container } = render(
            <ThemeProvider appearance="light">
                <span>child</span>
            </ThemeProvider>
        );
        const host = container.firstElementChild as HTMLElement;
        expect(host.style.getPropertyValue('--nex-bg')).toBe(LIGHT_CHROME_THEME.windowBackground);
        expect(host.style.getPropertyValue('--nex-fg')).toBe(LIGHT_CHROME_THEME.textPrimary);
        expect(host.dataset['nexTheme']).toBe('light');
    });

    it('publishes the bucket and palette through context', () => {
        render(
            <ThemeProvider appearance="dark">
                <Probe />
            </ThemeProvider>
        );
        const probe = screen.getByTestId('probe');
        expect(probe.dataset['bucket']).toBe('dark');
        expect(probe.textContent).toBe(DARK_CHROME_THEME.textPrimary);
    });

    it('resolves `system` against the supplied OS scheme', () => {
        const view = render(
            <ThemeProvider appearance="system" systemDark={false}>
                <Probe />
            </ThemeProvider>
        );
        expect(screen.getByTestId('probe').dataset['bucket']).toBe('light');

        view.rerender(
            <ThemeProvider appearance="system" systemDark>
                <Probe />
            </ThemeProvider>
        );
        expect(screen.getByTestId('probe').dataset['bucket']).toBe('dark');
    });

    it('applies user overrides through the provider', () => {
        const { container } = render(
            <ThemeProvider appearance="dark" overrides={{ 'dark:accent': '#FF8800' }}>
                <span>child</span>
            </ThemeProvider>
        );
        const host = container.firstElementChild as HTMLElement;
        expect(host.style.getPropertyValue('--nex-accent')).toBe('#FF8800');
        expect(host.style.getPropertyValue('--nex-selection-stroke')).toBe('#FF8800');
    });

    it('falls back to the dark preset outside any provider', () => {
        render(<Probe />);
        expect(screen.getByTestId('probe').dataset['bucket']).toBe('dark');
    });

    it('mirrors onto documentElement only when asked', () => {
        document.documentElement.style.removeProperty('--nex-bg');
        render(
            <ThemeProvider appearance="light" applyToDocument>
                <span>child</span>
            </ThemeProvider>
        );
        expect(document.documentElement.style.getPropertyValue('--nex-bg')).toBe(
            LIGHT_CHROME_THEME.windowBackground
        );
        expect(document.documentElement.dataset['nexTheme']).toBe('light');
    });
});
