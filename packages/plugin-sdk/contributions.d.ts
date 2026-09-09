/** Volatile presentation state owned by one plugin on its daemon. */
export type ContributionContextValue = string | number | boolean;
export type ContributionTone = 'default' | 'info' | 'success' | 'warning' | 'error';
export type ContributionItemPatch = {
    text?: string;
    tooltip?: string;
    badge?: string;
    tone?: ContributionTone;
    visible?: boolean;
    enabled?: boolean;
};
export type ContributionState = {
    context: Record<string, ContributionContextValue>;
    items: Record<string, ContributionItemPatch>;
};
export type ContributionUpdate = {
    /** null removes a key; conditions can match missing keys with null. */
    context?: Record<string, ContributionContextValue | null>;
    /** Item IDs must be declared by this plugin; null restores manifest defaults. */
    items?: Record<string, ContributionItemPatch | null>;
};
export interface ContributionsAPI {
    get(): Promise<ContributionState>;
    /** Merges atomically; resets on reload, disable, failure or removal. */
    update(patch: ContributionUpdate): Promise<ContributionState>;
}
