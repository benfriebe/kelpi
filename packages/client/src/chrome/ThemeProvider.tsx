/**
 * ThemeProvider — resolves the chrome palette and writes it onto a container as `--nex-*`
 * custom properties (shell-ui.md §2, port note "hex colors are canonical").
 *
 * The provider owns a real DOM container rather than `:root` on purpose: assembly may mount
 * the whole app under one, and a preview/settings surface can mount a *second* provider with
 * a different appearance to render a live theme preview without touching the document.
 * Descendants read the palette either as CSS (`var(--nex-fg)`) or, when they need the value
 * itself (canvas favicon, inline SVG), through `useChromeTheme()`.
 */

import {
    createContext,
    useContext,
    useEffect,
    useLayoutEffect,
    useMemo,
    useState,
    type CSSProperties,
    type ReactElement,
    type ReactNode
} from 'react';

import {
    chromeBucket,
    chromeThemeCssVars,
    presetChromeTheme,
    resolveChromeTheme,
    type ChromeAppearance,
    type ChromeBucket,
    type ChromeColorOverrides,
    type ChromeTheme
} from './theme';

export interface ChromeThemeValue {
    readonly theme: ChromeTheme;
    /** The concrete bucket the appearance resolved to (workspace-color lookups need it). */
    readonly bucket: ChromeBucket;
    readonly appearance: ChromeAppearance;
}

const DEFAULT_VALUE: ChromeThemeValue = {
    theme: presetChromeTheme('dark'),
    bucket: 'dark',
    appearance: 'system'
};

const ChromeThemeContext = createContext<ChromeThemeValue>(DEFAULT_VALUE);

/** The resolved palette. Safe outside a provider: falls back to the dark preset. */
export function useChromeTheme(): ChromeThemeValue {
    return useContext(ChromeThemeContext);
}

/**
 * Live OS color scheme. Only consulted when `appearance` is `system`; degrades to `false`
 * where `matchMedia` is missing (jsdom without the shim, older embedders).
 */
export function useSystemDark(enabled = true): boolean {
    const [dark, setDark] = useState(false);
    useEffect(() => {
        if (!enabled) return;
        const media = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
        if (media === undefined) return;
        setDark(media.matches);
        const listener = (event: MediaQueryListEvent): void => {
            setDark(event.matches);
        };
        media.addEventListener?.('change', listener);
        return () => {
            media.removeEventListener?.('change', listener);
        };
    }, [enabled]);
    return dark;
}

export interface ThemeProviderProps {
    readonly appearance?: ChromeAppearance | undefined;
    /** Overrides the OS probe (tests, Electron main pushing the native scheme). */
    readonly systemDark?: boolean | undefined;
    readonly overrides?: ChromeColorOverrides | undefined;
    /** A fully-resolved palette, bypassing `resolveChromeTheme` (theme preview surfaces). */
    readonly theme?: ChromeTheme | undefined;
    readonly className?: string | undefined;
    readonly style?: CSSProperties | undefined;
    /** Mirror the tokens onto `document.documentElement` too (assembly's root provider). */
    readonly applyToDocument?: boolean | undefined;
    /**
     * APP-012 / SET-049 — the ghostty `background-opacity`. Below 1 the window fill
     * (`--nex-bg`) is published with alpha, so a shell window created transparent shows the
     * desktop through the gaps the client does not paint opaquely. 1 (the default) is
     * byte-identical to what this provider always emitted.
     */
    readonly windowOpacity?: number | undefined;
    readonly children?: ReactNode;
}

export function ThemeProvider(props: ThemeProviderProps): ReactElement {
    const appearance = props.appearance ?? 'system';
    const probedDark = useSystemDark(props.systemDark === undefined && appearance === 'system');
    const systemDark = props.systemDark ?? probedDark;

    const value = useMemo<ChromeThemeValue>(() => {
        const bucket = chromeBucket(appearance, systemDark);
        const theme =
            props.theme ?? resolveChromeTheme({ appearance, systemDark, overrides: props.overrides });
        return { theme, bucket, appearance };
    }, [appearance, systemDark, props.theme, props.overrides]);

    const vars = useMemo(
        () => chromeThemeCssVars(value.theme, { windowOpacity: props.windowOpacity }),
        [value.theme, props.windowOpacity]
    );

    /**
     * A LAYOUT effect, and that is load-bearing rather than a micro-optimisation.
     *
     * React flushes every layout effect in a commit (children, then parents) before any passive
     * effect of that same commit. Descendants that must READ this stamp back off the DOM — the
     * terminal palette in `App.tsx` reads `--nex-term-*` off `:root`, because the engines want
     * concrete colors — run in passive effects, so writing here is what guarantees they see the
     * bucket this commit resolved. As a plain `useEffect` the parent wrote AFTER the child read,
     * so the very first light→dark transition left the terminal painted with the light palette
     * (a `#2B2B2E` foreground on a `#0A0A0C` background) for the whole session (run-B L4). It
     * also removes a frame of light chrome before paint.
     */
    useLayoutEffect(() => {
        if (props.applyToDocument !== true) return;
        const root = globalThis.document?.documentElement;
        if (root === undefined || root === null) return;
        for (const [name, cssValue] of Object.entries(vars)) root.style.setProperty(name, cssValue);
        root.dataset['nexTheme'] = value.bucket;
    }, [props.applyToDocument, vars, value.bucket]);

    return (
        <ChromeThemeContext.Provider value={value}>
            <div
                data-nex-theme={value.bucket}
                className={props.className ?? 'contents'}
                style={{ ...(vars as CSSProperties), ...props.style }}
            >
                {props.children}
            </div>
        </ChromeThemeContext.Provider>
    );
}
