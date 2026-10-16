/**
 * The build-time variables the client reads from `import.meta.env`, typed so a misspelt name
 * is a compile error instead of an `any` that quietly reads as undefined.
 */
interface ImportMetaEnv {
    /** `xterm` selects the fallback terminal engine; anything else is ghostty-web (README.md). */
    readonly VITE_TERMINAL_ENGINE?: string;
}
