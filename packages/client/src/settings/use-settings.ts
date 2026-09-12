import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { SettingsSectionID } from './contract';
import {
    createSettingsSurface,
    type SettingsSurface,
    type SettingsSurfaceConfig,
    type SettingsSurfaceSnapshot
} from './surface';

/**
 * The window's one settings surface, held across renders and disposed on the real unmount.
 *
 * The sibling of `interaction/use-interaction.ts`, line for line, because it answers the same two
 * hazards the same way:
 *
 *   1. **StrictMode's effect rehearsal.** React mounts, unmounts and remounts every effect in
 *      development. Disposing on the rehearsal's cleanup would drop every draft and cancel every
 *      in-flight write before the window had finished mounting, so disposal is deferred by one
 *      microtask and declines if the component came back.
 *
 *   2. **Callbacks that change identity every render.** `App` builds its accessors inline, so the
 *      surface is created ONCE against an indirection that reads the latest render's config. The
 *      alternative - recreating the surface when a callback changed - would throw away the draft
 *      the user is typing on an unrelated re-render, which is the one thing the whole draft store
 *      exists to prevent.
 *
 * Each optional arm is installed only when the FIRST render supplied it, so a surface created
 * without section routing keeps holding the section itself rather than being handed an arm that
 * answers null.
 */
export function useSettingsSurface(config: SettingsSurfaceConfig): SettingsSurface {
    const latest = useRef(config);
    latest.current = config;

    const [surface] = useState((): SettingsSurface => {
        const first = latest.current;
        return createSettingsSurface({
            settings: () => latest.current.settings(),
            actions: () => latest.current.actions(),
            ...(first.section === undefined
                ? {}
                : {
                      section: {
                          get: () => latest.current.section?.get() ?? null,
                          set: (id: SettingsSectionID) => {
                              latest.current.section?.set(id);
                          }
                      }
                  }),
            ...(first.transport === undefined
                ? {}
                : { transport: () => latest.current.transport?.() ?? null }),
            ...(first.disabled === undefined
                ? {}
                : { disabled: (fieldID: string) => latest.current.disabled?.(fieldID) ?? false })
        });
    });

    const mounted = useRef(false);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            queueMicrotask(() => {
                if (!mounted.current) surface.dispose();
            });
        };
    }, [surface]);

    return surface;
}

/**
 * The routed section, as a value a component re-renders on.
 *
 * `null` when there is no surface, which is what the Settings window falls back to its own state
 * for: the overlay renders from a fixture in half its tests and from `App`'s surface in the app,
 * and a hook cannot be called conditionally, so the absence is a value rather than a branch.
 *
 * The section is a string, so there is no snapshot identity to keep stable here - the whole reason
 * `getSnapshot` caches is the object it builds, and nothing in this hook reads it.
 */
export function useSettingsSection(surface: SettingsSurface | null): SettingsSectionID | null {
    const subscribe = useCallback(
        (listener: () => void): (() => void) => (surface === null ? () => {} : surface.subscribe(listener)),
        [surface]
    );
    const read = useCallback(
        (): SettingsSectionID | null => (surface === null ? null : surface.getSection()),
        [surface]
    );
    return useSyncExternalStore(subscribe, read, read);
}

/**
 * The routed section's projection, as a value a component re-renders on.
 *
 * The surface caches the object it builds (keyed by section, revision and the captions the host
 * computes), which is what `useSyncExternalStore` requires: a getter that returned a fresh object
 * every call would re-render forever. Reading it is also what folds a new daemon snapshot in, so a
 * tab drawn from this hook cannot be showing a value the surface has already superseded.
 */
export function useSettingsSnapshot(surface: SettingsSurface): SettingsSurfaceSnapshot {
    const subscribe = useCallback(
        (listener: () => void): (() => void) => surface.subscribe(listener),
        [surface]
    );
    const read = useCallback((): SettingsSurfaceSnapshot => surface.getSnapshot(), [surface]);
    return useSyncExternalStore(subscribe, read, read);
}

/**
 * A surface pinned to ONE section: the tab's own, for when the host has not given it one.
 *
 * Every fields tab renders from a fixture in its tests (`settings` + `actions` and nothing else)
 * and from `App`'s window-wide surface in the app. Both have to write through the same funnel, so
 * the fallback is a real surface rather than a second write path: the only thing it does
 * differently is hold its section still, because a tab drawn on its own is not navigating.
 *
 * The hook is called unconditionally, as hooks must be, so a tab that WAS given a surface builds
 * one it never reads. That costs an object: a surface starts no timer and subscribes to nothing
 * until something is written through it.
 */
export function useSectionSurface(input: {
    readonly sectionID: SettingsSectionID;
    readonly surface?: SettingsSurface | undefined;
    readonly config: Omit<SettingsSurfaceConfig, 'section'>;
}): SettingsSurface {
    const own = useSettingsSurface({
        ...input.config,
        section: { get: () => input.sectionID, set: () => {} }
    });
    return input.surface ?? own;
}
