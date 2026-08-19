/**
 * The app chrome (WP3.4 + WP3.5): everything around the pane grid.
 *
 *   `Sidebar.tsx`        — groups + workspace rows, context menus, drag-drop, filter, footer
 *   `TopBar.tsx`         — workspace identity, layout control, sync indicator, connection pill
 *   `StatusFooter.tsx`   — focused-pane context, agent buckets, sparkline slot, clock
 *   `CommandPalette.tsx` — the ⌘P overlay (substring matching, `w:`/`p:` scopes)
 *   `ContextMenu.tsx`    — the portal menu every chrome surface opens
 *   `keys.ts`            — the single keydown interceptor and its action registry
 *   `theme.ts` / `ThemeProvider.tsx` / `tokens.ts` — the palette, resolved and consumed
 *   `favicon.ts`         — the favicon/tab badge (the web port of the menu-bar dot)
 *
 * Nothing here reads the store or opens a socket: state arrives as props and intent leaves as
 * callbacks, so every surface renders from a fixture and the Electron shell can reuse it.
 */

export {
    AUTO_SCROLL_EDGE_PX,
    AUTO_SCROLL_INTERVAL_MS,
    AUTO_SCROLL_STEP_PX,
    SPRING_LOAD_MS,
    Sidebar,
    type SidebarProps
} from './Sidebar';
export { TopBar, identityDotColor, type TopBarProps } from './TopBar';
export {
    StatusFooter,
    SystemSparkline,
    type AgentBucket,
    type AgentCountSummary,
    type StatusBarItem,
    type StatusFooterProps
} from './StatusFooter';
export { CommandPalette, FOCUS_HANDOFF_MS, type CommandPaletteProps } from './CommandPalette';
export { ContextMenu, menuAnchorFromEvent, type ContextMenuProps, type MenuItemSpec } from './ContextMenu';

export {
    CURATED_EMOJI,
    CURATED_SYMBOL_ICONS,
    ChromeIcon,
    GENERIC_ICON_GLYPH,
    ICON_TOKEN_GLYPHS,
    avatarLetter,
    formatIconToken,
    iconGlyph,
    iconIsTintable,
    isSingleGrapheme,
    normalizeEmojiInput,
    type ChromeIconName,
    type ChromeIconProps,
    type IconChoice
} from './icons';

export { useSecondsTicker, tickerListenerCount } from './clock';

export {
    PANE_TYPE_ICONS,
    buildPaletteItems,
    clampSelection,
    matchPaletteQuery,
    paletteNavigationOrder,
    paletteSections,
    parsePaletteQuery,
    type BuildPaletteOptions,
    type PaletteItem,
    type PaletteItemKind,
    type PaletteScope,
    type PaletteSection,
    type ParsedPaletteQuery
} from './palette';

export {
    applyGroupDrop,
    applyWorkspaceDrop,
    buildDropZones,
    buildGroupSpans,
    filteredRows,
    groupCommit,
    isGroupCollapsed,
    locateWorkspace,
    orderModelFromEntries,
    projectEntries,
    renderedRows,
    resolveDropTarget,
    resolveGroupDropIndex,
    visibleOrderFromEntries,
    workspaceCommit,
    workspaceMatchesFilter,
    type CollapseState,
    type DropTarget,
    type DropZone,
    type DropZoneKind,
    type DropZoneLayout,
    type DropZoneOptions,
    type FilteredRow,
    type GroupSpan,
    type GroupSpanLayout,
    type RenderedRow,
    type SidebarOrderModel,
    type SidebarSlot,
    type WorkspaceLocation
} from './sidebar-model';

export {
    WORKSPACE_COLORS,
    type ChromeGroup,
    type ChromeLabelPreset,
    type ChromePane,
    type ChromeSidebarEntry,
    type ChromeWorkspace,
    type GroupMoveRequest,
    type SidebarCallbacks,
    type WorkspaceMoveRequest,
    type WorkspacesMoveRequest
} from './types';

export {
    CHROME_CSS_VARS,
    CHROME_CSS_VAR_ALIASES,
    DARK_CHROME_THEME,
    DEFAULT_SIDEBAR_FILL_STROKE,
    LIGHT_CHROME_THEME,
    OVERRIDABLE_CHROME_KEYS,
    WORKSPACE_COLOR_HEX,
    applyChromeTheme,
    autoTextColor,
    chromeBucket,
    chromeElapsedLabel,
    chromeThemeCssText,
    chromeThemeCssVars,
    clockLabel,
    effectiveOpacity,
    ghosttyBucket,
    homeAbbreviated,
    isDarkBackground,
    middleTruncate,
    normalizeHexColor,
    parseHexColor,
    perceivedLuminance,
    presetChromeTheme,
    resolveChromeTheme,
    resolveLabelStyle,
    withAlpha,
    workspaceColorHex,
    type ChromeAppearance,
    type ChromeBucket,
    type ChromeColorOverrides,
    type ChromeTheme,
    type ChromeThemeInput,
    type ElementStyleTarget,
    type LabelColorLike,
    type LabelPresetLike,
    type OverridableChromeKey,
    type ResolvedLabelStyle,
    type Rgb,
    type SidebarFillStroke
} from './theme';

export {
    ThemeProvider,
    useChromeTheme,
    useSystemDark,
    type ChromeThemeValue,
    type ThemeProviderProps
} from './ThemeProvider';

export { CHROME_TOKEN_FALLBACKS, token, tokens, type ChromeTokenName } from './tokens';

export {
    CODE_TO_KEY_CODE,
    DEFAULT_KEYBINDINGS,
    WIRED_KEY_ACTIONS,
    actionForTrigger,
    applyKeybindOverrides,
    clientKeyBindings,
    createKeyDispatcher,
    installKeyDispatcher,
    isEditableTarget,
    keyBindingsFromOverrideLines,
    modifiersFromEvent,
    shortcutForAction,
    triggerFromEvent,
    workspaceSwitchHandlers,
    workspaceSwitchIndex,
    type KeyActionContext,
    type KeyActionHandler,
    type KeyActionRegistry,
    type KeyDispatcher,
    type KeyDispatcherOptions,
    type KeyEventLike,
    type KeyEventTarget
} from './keys';

export {
    DEFAULT_FAVICON_COLORS,
    createFaviconController,
    drawFavicon,
    faviconBadgeColor,
    titleWithBadge,
    type DrawFaviconOptions,
    type FaviconCanvas,
    type FaviconColors,
    type FaviconContext,
    type FaviconController,
    type FaviconControllerOptions,
    type FaviconDocument,
    type FaviconSummary
} from './favicon';
