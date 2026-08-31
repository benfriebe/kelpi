/**
 * The app chrome (WP3.4 + WP3.5): everything around the pane grid.
 *
 *   `Sidebar.tsx`        — groups + workspace rows, context menus, drag-drop, filter, footer
 *   `NewWorkspaceSheet.tsx` — the modal New Workspace / New Group sheet every create route raises
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
    NEST_INDENT_PX,
    SPRING_LOAD_MS,
    Sidebar,
    type SidebarProps,
    type SidebarSelectionCommands
} from './Sidebar';
/** §WS-075's create sheet — a modal over the window, no longer a form inside the sidebar. */
export { NewEntrySheet, type NewEntryDraft, type NewEntrySheetProps } from './NewWorkspaceSheet';
export { TopBar, identityDotColor, type TopBarProps } from './TopBar';
export {
    CreateWorktreeSheet,
    DEFAULT_PROFILE_NAME,
    INSPECTOR_WIDTH_PX,
    Inspector,
    InspectorIconButton,
    groupAssociations,
    type InspectorAssociation,
    type InspectorGitStatus,
    type InspectorProps,
    type InspectorRepo,
    type WorktreeRequest
} from './Inspector';
export {
    SIDEBAR_DEFAULT_WIDTH,
    SIDEBAR_MAX_WIDTH,
    SIDEBAR_MIN_WIDTH,
    SIDEBAR_WIDTH_STORAGE_KEY,
    SidebarResizer,
    clampSidebarWidth,
    readStoredSidebarWidth,
    storeSidebarWidth,
    type SidebarResizerProps
} from './SidebarResizer';
export { RepoPicker, type RepoPickerEntry, type RepoPickerProps } from './RepoPicker';
export { sanitizeGitName, worktreePreview, worktreePreviewPath, type WorktreePreview } from './worktree';
export {
    BUCKET_POPOVER_WIDTH_PX,
    StatusFooter,
    SystemSparkline,
    bucketPopoverPlacement,
    fitStatGauges,
    footerGitStats,
    statGaugeWidth,
    type AgentBucket,
    type AgentCountSummary,
    type FooterAssociation,
    type BucketPopoverPlacement,
    type FooterGitStats,
    type StatusBarItem,
    type StatusFooterProps,
    type SystemStatsView
} from './StatusFooter';
export {
    Sparkline,
    SystemStatGauge,
    type SparklineProps,
    type SparklineStyle,
    type SystemStatGaugeProps
} from './SystemStatGauge';
export {
    SYSTEM_STAT_KINDS,
    SYSTEM_STAT_META,
    compactStatLabel,
    detailStatLabel,
    formatBytes,
    formatRate,
    historyFootnote,
    sparklineRange,
    summarizeHistory,
    summaryStatValue,
    systemStatMeta,
    visibleStatKinds,
    type HistorySummary,
    type SystemStatKind,
    type SystemStatMeta
} from './stats';
export {
    BUILT_IN_CHROME_THEMES,
    CHROME_THEME_CODE_PREFIX,
    CHROME_THEME_VERSION,
    ChromeThemeError,
    INVALID_THEME_MESSAGE,
    base64Decode,
    base64Encode,
    builtInStyleTheme,
    chromeThemeFileJson,
    chromeThemeShareCode,
    decodeChromeStyleTheme,
    paletteOverrides,
    parseChromeThemeCode,
    presetAppearance,
    unsupportedVersionMessage,
    type BuiltInChromeTheme,
    type ChromePalette,
    type ChromeStyleTheme
} from './presets';
export { CommandPalette, FOCUS_HANDOFF_MS, type CommandPaletteProps } from './CommandPalette';
export { ContextMenu, menuAnchorFromEvent, type ContextMenuProps, type MenuItemSpec } from './ContextMenu';
export {
    HELP_GITHUB_URL,
    HELP_CLI_ENTRIES,
    HelpOverlay,
    type HelpCliEntry,
    type HelpOverlayProps
} from './HelpOverlay';

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
    parsePaletteQuery,
    type BuildPaletteOptions,
    type PaletteItem,
    type PaletteItemKind,
    type PaletteScope,
    type ParsedPaletteQuery
} from './palette';

export {
    applyGroupDrop,
    applyWorkspaceDrop,
    buildDropZones,
    buildGroupSpans,
    defaultGroupName,
    filteredRows,
    groupCommit,
    isGroupCollapsed,
    locateWorkspace,
    nextCreateColor,
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

// §WS-001 / §APP-066: the show/hide slide's phase machine, shared by the sidebar and the
// inspector. A conditional mount cannot transition, so the phases keep the panel in the tree for
// the length of a close; `SidebarEdge` is the only thing that differs between the two panels.
// §N31 adds `SIDEBAR_PANEL_GROUND`: the colour the reveal itself is made of, so the strip a
// slide sweeps is never the window's ground (or, under a transparent window, the desktop).
export {
    SIDEBAR_PANEL_GROUND,
    SIDEBAR_SLIDE_EASING,
    SIDEBAR_SLIDE_MS,
    isSidebarMounted,
    isSidebarSettledOpen,
    sidebarPhaseAfterSettle,
    sidebarPhaseFor,
    sidebarSettleDelayMs,
    sidebarSlideStyle,
    type SidebarEdge,
    type SidebarPhase,
    type SidebarSlideStyle
} from './sidebar-reveal';

export {
    WORKSPACE_COLORS,
    type ChromeGroup,
    type ChromeRepo,
    type NewWorkspaceExtras,
    type SubmitResult,
    type WorkspaceWorktreeRequest,
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
    DEFAULT_SIDEBAR_TINT,
    LIGHT_CHROME_THEME,
    OVERRIDABLE_CHROME_KEYS,
    SIDEBAR_TINT_VARS,
    WORKSPACE_COLOR_HEX,
    applyChromeTheme,
    autoTextColor,
    chromeBucket,
    chromeElapsedLabel,
    chromeThemeCssText,
    chromeThemeCssVars,
    clockLabel,
    effectiveOpacity,
    flattenOver,
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
    sidebarTintCssVars,
    tintedColor,
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
    type SidebarFillStroke,
    type SidebarTint
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
    isPaneSurface,
    isTerminalSurface,
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
    DESTRUCTIVE_COLOR,
    QUIT_GATE_GLOBAL,
    QUIT_GATE_VERSION,
    QuitConfirmDialog,
    QuitGate,
    installQuitGate,
    normalizeQuitGateSpec,
    type QuitConfirmDialogProps,
    type QuitGateProps,
    type QuitGateSpec,
    type QuitGateVerdict
} from './QuitConfirmDialog';

/**
 * The two contracts every modal/transient surface in the chrome owes (UI-FIDELITY H1 / H15):
 * "park the web pane while I am painted", and "close me on an outside click or Escape".
 */
export {
    measureOverlayRect,
    modalPresenceCount,
    overlayCovers,
    overlayPresenceCount,
    registerModal,
    registerOverlay,
    UNMEASURED_OVERLAY,
    useAnyModalOpen,
    useModalPresence,
    useOverlayPresence,
    useOverlayRects,
    type OverlayHandle,
    type OverlayRect
} from './modal-presence';
export { useDismissable } from './dismissable';
/** …and the hover recipe those same surfaces owe a pointer (H11). */
export { hoverFill, hoverText, useHoverKey, type HoverBinding } from './hover';

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
