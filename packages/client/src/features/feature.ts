import type { ReactNode } from 'react';
import type { PluginPlacement } from '@kelpi/protocol';
import type { ViewRenderContext } from '../plugins/renderers';

/** A bundled feature shares view identity and placement with installed contributions. */
export interface BundledFeatureDefinition {
    readonly id: string;
    readonly title: string;
    readonly placements: readonly PluginPlacement[];
}

export interface FeatureRenderContext extends ViewRenderContext {
    readonly side?: 'left' | 'right';
    readonly viewPicker?: ReactNode;
}

/** Models and effects live in feature modules; the workbench owns placement and rendering. */
export interface BundledFeatureBinding {
    readonly definition: BundledFeatureDefinition;
    render(context: FeatureRenderContext): ReactNode;
}

export function featureBindings(features: readonly BundledFeatureBinding[]): ReadonlyMap<string, BundledFeatureBinding> {
    const bindings = new Map<string, BundledFeatureBinding>();
    for (const feature of features) {
        if (bindings.has(feature.definition.id)) throw new Error(`Bundled feature is already registered: ${feature.definition.id}`);
        bindings.set(feature.definition.id, feature);
    }
    return bindings;
}
