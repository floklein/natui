import type { FC, ReactNode } from 'react';

/**
 * NatUI's typed component API. Each component is a host-element tag (a plain
 * string the reconciler passes through as the node `kind`) cast to a typed FC
 * so JSX gets full prop checking with zero runtime cost.
 */

// ---------------------------------------------------------------------------
// Shared prop shapes
// ---------------------------------------------------------------------------

export type Color = string; // '#RRGGBB' or '#RRGGBBAA'

export interface EdgeInsets {
  top?: number;
  bottom?: number;
  leading?: number;
  trailing?: number;
}

export interface Frame {
  width?: number;
  height?: number;
  minWidth?: number;
  maxWidth?: number | 'infinity';
  minHeight?: number;
  maxHeight?: number | 'infinity';
}

export interface CommonProps {
  padding?: number | EdgeInsets;
  background?: Color;
  cornerRadius?: number;
  frame?: Frame;
  opacity?: number;
  disabled?: boolean;
  hidden?: boolean;
  /** Foreground color. */
  color?: Color;
  /** Tooltip. */
  help?: string;
  /**
   * Stable row identity for selectable containers (List/Table selection).
   * A selectable List reports and receives selection as its rows' tags.
   */
  tag?: string;
  /** Badge shown on Tab items and List rows (counts, short strings). */
  badge?: string | number;
  /** Assistive-tech label (VoiceOver / Narrator). */
  accessibilityLabel?: string;
  /** Assistive-tech hint describing the result of activating the element. */
  accessibilityHint?: string;
  /** Stable identifier for UI automation (AX identifier / AutomationId). */
  accessibilityIdentifier?: string;
  key?: string | number;
}

export interface ContainerProps extends CommonProps {
  children?: ReactNode;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface VStackProps extends ContainerProps {
  spacing?: number;
  alignment?: 'leading' | 'center' | 'trailing';
}

export interface HStackProps extends ContainerProps {
  spacing?: number;
  alignment?: 'top' | 'center' | 'bottom';
}

export type ZStackProps = ContainerProps;

export interface SpacerProps extends CommonProps {
  minLength?: number;
}

export type DividerProps = CommonProps;

export interface ScrollViewProps extends ContainerProps {
  axis?: 'vertical' | 'horizontal';
}

export interface ListProps extends ContainerProps {
  /**
   * Controlled selection: a child row's `tag` (single), an array of tags
   * (multiple), or null for no selection. The presence of this prop (even
   * null) is what makes the list selectable; rows identify themselves via
   * the `tag` common prop.
   */
  value?: string | string[] | null;
  selectionMode?: 'single' | 'multiple';
  /** 'sidebar' renders the platform source-list material (macOS sidebars). */
  style?: 'automatic' | 'sidebar';
  onChange?: (value: string | string[] | null) => void;
}

export interface SectionProps extends ContainerProps {
  header?: string;
  footer?: string;
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export type FontStyle =
  | 'largeTitle'
  | 'title'
  | 'title2'
  | 'title3'
  | 'headline'
  | 'body'
  | 'callout'
  | 'caption';

export interface TextProps extends CommonProps {
  children?: ReactNode;
  font?: FontStyle;
  /** Point size; when set, a system font of this size replaces `font` (weight still applies). */
  size?: number;
  weight?: 'regular' | 'medium' | 'semibold' | 'bold';
  italic?: boolean;
  strikethrough?: boolean;
  monospaced?: boolean;
  lineLimit?: number;
}

export interface ImageProps extends CommonProps {
  /** SF Symbols name on macOS; mapped to Segoe Fluent glyphs on Windows. */
  systemName: string;
  size?: number;
}

export interface ProgressViewProps extends CommonProps {
  /** 0..1. Omit for an indeterminate spinner. */
  value?: number;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export interface ButtonProps extends CommonProps {
  children?: ReactNode;
  onPress?: () => void;
  variant?: 'automatic' | 'bordered' | 'prominent' | 'plain' | 'link';
  role?: 'destructive' | 'cancel';
}

export interface TextFieldProps extends CommonProps {
  value: string;
  placeholder?: string;
  secure?: boolean;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
}

export interface ToggleProps extends CommonProps {
  children?: ReactNode;
  value: boolean;
  /** 'automatic' is the platform default (checkbox on macOS, checkbox on Windows). */
  style?: 'automatic' | 'checkbox' | 'switch';
  onChange?: (value: boolean) => void;
}

export interface SliderProps extends CommonProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange?: (value: number) => void;
}

export interface PickerOption {
  value: string;
  label: string;
}

export interface PickerProps extends CommonProps {
  value: string;
  options: PickerOption[];
  label?: string;
  /** 'automatic' is the platform default (a dropdown menu). */
  style?: 'automatic' | 'menu' | 'segmented' | 'radioGroup';
  onChange?: (value: string) => void;
}

// ---------------------------------------------------------------------------
// Shared data-driven specs (menus, toolbars, alerts, tables)
//
// These trees cross the wire as plain JSON props; hosts build native menu /
// toolbar / dialog / table structures from them. They are data, not children,
// because the native counterparts (NSMenu, NSToolbar, ContentDialog buttons,
// table columns) are not view hierarchies.
// ---------------------------------------------------------------------------

/**
 * Item roles. 'destructive' styles the item; the command roles map to native
 * platform commands (responder-chain selectors on macOS, best-effort clipboard
 * / app commands on Windows) and NEVER emit a select event.
 */
export type MenuItemRole =
  | 'destructive'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'undo'
  | 'redo'
  | 'quit'
  | 'about';

export interface MenuActionSpec {
  id: string;
  label: string;
  /** SF Symbols name on macOS; mapped to Segoe Fluent glyphs on Windows. */
  systemImage?: string;
  role?: MenuItemRole;
  /** Keyboard shortcut, e.g. 'cmd+n', 'cmd+shift+s'. */
  shortcut?: string;
  disabled?: boolean;
  /** Renders a checkmark; flips are prop-driven (re-render with the new value). */
  checked?: boolean;
  /** Present = this item is a submenu; select events fire only on leaves. */
  children?: MenuItemSpec[];
}

export interface MenuDividerSpec {
  divider: true;
}

export type MenuItemSpec = MenuActionSpec | MenuDividerSpec;

/** One top-level menu in the application menu bar. */
export interface MenuSpec {
  id: string;
  label: string;
  items: MenuItemSpec[];
}

export type ToolbarItemSpec =
  | { type: 'spacer' }
  | { type: 'flexibleSpace' }
  | {
      type: 'button';
      id: string;
      label?: string;
      systemImage?: string;
      disabled?: boolean;
    }
  | {
      type: 'toggle';
      id: string;
      label?: string;
      systemImage?: string;
      /** Prop-driven pressed state (not optimistic): echo it from onAction. */
      on?: boolean;
      disabled?: boolean;
    }
  | {
      type: 'menu';
      id: string;
      label?: string;
      systemImage?: string;
      items: MenuItemSpec[];
      disabled?: boolean;
    }
  | { type: 'search'; id: string; placeholder?: string };

export interface AlertButtonSpec {
  id: string;
  label: string;
  role?: 'destructive' | 'cancel';
}

export interface TableColumnSpec {
  key: string;
  label: string;
  width?: number;
  /** Default true; false suppresses sortChange for this column. */
  sortable?: boolean;
}

export interface TableRowSpec {
  id: string;
  /** Column key -> cell text. */
  cells: Record<string, string>;
}

export interface SortDescriptor {
  key: string;
  order: 'asc' | 'desc';
}

// ---------------------------------------------------------------------------
// App shell (window chrome + navigation)
// ---------------------------------------------------------------------------

/**
 * The application menu bar. Non-visual: must be a direct child of the root;
 * hosts hoist it to NSApp.mainMenu / a WinUI MenuBar row. Hosts never emit
 * select for disabled items, dividers, or submenu parents.
 */
export interface MenuBarProps {
  menus: MenuSpec[];
  onSelect?: (id: string) => void;
  key?: string | number;
}

/**
 * The window toolbar (NSToolbar unified style / WinUI CommandBar).
 * Non-visual: must be a direct child of the root. Search items are
 * uncontrolled on the wire: text fires onSearch and is never echoed back.
 */
export interface ToolbarProps {
  items: ToolbarItemSpec[];
  onAction?: (id: string) => void;
  onSearch?: (value: string) => void;
  key?: string | number;
}

/**
 * Two-pane navigation split. Children are routed by kind: the first Sidebar
 * child fills the sidebar column, the first Detail child the detail column
 * (order-independent; extras are ignored with a warning). `value` optionally
 * controls sidebar visibility.
 */
export interface SplitViewProps extends CommonProps {
  children?: ReactNode;
  /**
   * Controlled sidebar visibility. SplitView is always controlled on the
   * wire: there is no host-local visibility state, so an app that omits
   * `value` still receives change events for user collapses, but any later
   * re-render restores the sidebar. Provide `value` + `onChange` to keep it.
   */
  value?: 'all' | 'detailOnly';
  sidebarWidth?: number;
  minSidebarWidth?: number;
  maxSidebarWidth?: number;
  onChange?: (value: 'all' | 'detailOnly') => void;
}

export type SidebarProps = ContainerProps;
export type DetailProps = ContainerProps;

/** Controlled tab container; children are Tab elements. Tab clicks are optimistic. */
export interface TabViewProps extends CommonProps {
  children?: ReactNode;
  /** The selected Tab's `id`. */
  value: string;
  onChange?: (id: string) => void;
}

export interface TabProps extends ContainerProps {
  id: string;
  title: string;
  systemImage?: string;
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

/** A dropdown-menu button; children form the button label. */
export interface MenuProps extends CommonProps {
  children?: ReactNode;
  items: MenuItemSpec[];
  systemImage?: string;
  onSelect?: (id: string) => void;
}

/** Wraps its children as the right-click (context menu) target. */
export interface ContextMenuProps extends ContainerProps {
  items: MenuItemSpec[];
  onSelect?: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Overlays (controlled presentation state over seq/ack)
// ---------------------------------------------------------------------------

/**
 * A modal sheet. `value` controls presentation; host-side dismissal is an
 * optimistic change(false), so an app that keeps `value` true gets
 * prevent-dismissal via the standard corrective update. Children materialize
 * eagerly; gate expensive content with `{open && <Content/>}`.
 */
export interface SheetProps extends ContainerProps {
  value: boolean;
  onChange?: (presented: boolean) => void;
}

/**
 * A native alert dialog, fully data-driven (no children). Button presses
 * emit onSelect(buttonId) FIRST, then the dismissal change(false).
 */
export interface AlertProps extends CommonProps {
  value: boolean;
  title: string;
  message?: string;
  buttons: AlertButtonSpec[];
  onSelect?: (buttonId: string) => void;
  onChange?: (presented: boolean) => void;
}

/**
 * An anchored popover. Ordinary children render inline as the anchor; the
 * single PopoverContent child is the presented content.
 */
export interface PopoverProps extends ContainerProps {
  value: boolean;
  arrowEdge?: 'top' | 'bottom' | 'leading' | 'trailing';
  onChange?: (presented: boolean) => void;
}

export type PopoverContentProps = ContainerProps;

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/**
 * A sortable, selectable table with data-driven columns and string cells.
 * The host never sorts: a header click emits onSortChange (request
 * semantics); the app re-sorts `rows` and echoes the new `sort`.
 */
export interface TableProps extends CommonProps {
  columns: TableColumnSpec[];
  rows: TableRowSpec[];
  /** Controlled selection over row ids; present (even null) = selectable. */
  value?: string | string[] | null;
  selectionMode?: 'single' | 'multiple';
  sort?: SortDescriptor;
  onChange?: (value: string | string[] | null) => void;
  onSortChange?: (sort: SortDescriptor) => void;
}

/** Always-controlled disclosure; `value` is the expanded state. */
export interface DisclosureGroupProps extends ContainerProps {
  label: string;
  value: boolean;
  onChange?: (expanded: boolean) => void;
}

// ---------------------------------------------------------------------------
// Inputs (new controlled kinds)
// ---------------------------------------------------------------------------

export interface SearchFieldProps extends CommonProps {
  value: string;
  placeholder?: string;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
}

/**
 * Date/time input. `value` is a LOCAL ISO string without a zone, shaped by
 * `displayedComponents`: 'YYYY-MM-DD' (date), 'HH:mm' (time), or
 * 'YYYY-MM-DDTHH:mm' (dateTime). Hosts re-serialize canonically so a
 * round-trip is byte-identical.
 */
export interface DatePickerProps extends CommonProps {
  value: string;
  displayedComponents?: 'date' | 'time' | 'dateTime';
  onChange?: (value: string) => void;
}

export interface StepperProps extends CommonProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange?: (value: number) => void;
}

/** Multiline plain-text editor. */
export interface TextEditorProps extends CommonProps {
  value: string;
  onChange?: (value: string) => void;
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

/** Opens `url` in the system browser; children form the link label. */
export interface LinkProps extends CommonProps {
  children?: ReactNode;
  url: string;
  onPress?: () => void;
}

/** Icon + title pair; children form the title. */
export interface LabelProps extends CommonProps {
  children?: ReactNode;
  systemImage: string;
}

// ---------------------------------------------------------------------------
// Host components
// ---------------------------------------------------------------------------

function host<P>(kind: string): FC<P> {
  return kind as unknown as FC<P>;
}

export const VStack = host<VStackProps>('VStack');
export const HStack = host<HStackProps>('HStack');
export const ZStack = host<ZStackProps>('ZStack');
export const Spacer = host<SpacerProps>('Spacer');
export const Divider = host<DividerProps>('Divider');
export const ScrollView = host<ScrollViewProps>('ScrollView');
export const List = host<ListProps>('List');
export const Text = host<TextProps>('Text');
export const Image = host<ImageProps>('Image');
export const ProgressView = host<ProgressViewProps>('ProgressView');
export const Button = host<ButtonProps>('Button');
export const TextField = host<TextFieldProps>('TextField');
export const Toggle = host<ToggleProps>('Toggle');
export const Slider = host<SliderProps>('Slider');
export const Picker = host<PickerProps>('Picker');

// App shell
export const MenuBar = host<MenuBarProps>('MenuBar');
export const Toolbar = host<ToolbarProps>('Toolbar');
export const SplitView = host<SplitViewProps>('SplitView');
export const Sidebar = host<SidebarProps>('Sidebar');
export const Detail = host<DetailProps>('Detail');
export const TabView = host<TabViewProps>('TabView');
export const Tab = host<TabProps>('Tab');

// Menus
export const Menu = host<MenuProps>('Menu');
export const ContextMenu = host<ContextMenuProps>('ContextMenu');

// Overlays
export const Sheet = host<SheetProps>('Sheet');
export const Alert = host<AlertProps>('Alert');
export const Popover = host<PopoverProps>('Popover');
export const PopoverContent = host<PopoverContentProps>('PopoverContent');

// Data
export const Section = host<SectionProps>('Section');
export const Table = host<TableProps>('Table');
export const DisclosureGroup = host<DisclosureGroupProps>('DisclosureGroup');

// Inputs
export const SearchField = host<SearchFieldProps>('SearchField');
export const DatePicker = host<DatePickerProps>('DatePicker');
export const Stepper = host<StepperProps>('Stepper');
export const TextEditor = host<TextEditorProps>('TextEditor');

// Content
export const Link = host<LinkProps>('Link');
export const Label = host<LabelProps>('Label');
