/**
 * The build-time variables the client reads from `import.meta.env`. Strict, so a misspelt or
 * undeclared name is a compile error instead of Vite's default `Record<string, any>` fallback,
 * which reads as undefined in the bundle without a word (#353 was a read Vite never replaced).
 */
interface ViteTypeOptions {
    strictImportMetaEnv: unknown;
}

interface ImportMetaEnv {
    /** `xterm` selects the fallback terminal engine; anything else is ghostty-web (README.md). */
    readonly VITE_TERMINAL_ENGINE?: string;
}
