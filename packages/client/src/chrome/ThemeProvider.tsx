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

    const vars = useMemo(() => chromeThemeCssVars(value.theme), [value.theme]);

    useEffect(() => {
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
