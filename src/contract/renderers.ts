/**
 * Renderer, editor and registry contracts.
 *
 * Renderers are plain React components with stable identity props. Editors hold a draft and end through
 * one path, `stop(commit)`, whatever triggered the end: keyboard, blur, scroll, refresh or unmount.
 */
import type { ComponentType, ReactNode } from 'react';

import type { GridApi } from './api';
import type { ResolvedColumn, ValueFormatter, ValueGetter, ValueSetter } from './columns';
import type { FilterKind } from './filters';
import type { AnchorRect } from './geometry';
import type { DataRow, DetailRow, FullWidthRow, GridRow, GroupRow, RowWithData } from './rows';

export type CellRendererProps<TData, TValue = unknown> = {
    row: RowWithData<TData>;
    data: TData;
    column: ResolvedColumn<TData, TValue>;
    value: TValue;
    formattedValue: string;
    api: GridApi<TData>;
    /** `cellRendererParams` from the column definition. */
    params: Record<string, unknown>;
    context: unknown;
};

export type CellRendererComponent<TData, TValue = unknown> = ComponentType<CellRendererProps<TData, TValue>>;

export type GroupRowRendererProps<TData> = {
    row: GroupRow<TData>;
    api: GridApi<TData>;
    toggle: () => void;
    context: unknown;
};

/** Renders the group column cell (the generated group column) for group rows and, with `groupDisplay: 'column'`, leaves. */
export type GroupCellRendererProps<TData> = {
    row: GridRow<TData>;
    /** Label for the group value, formatted through the grouped column. */
    label: string;
    childCount: number | null;
    expanded: boolean;
    expandable: boolean;
    toggle: () => void;
    level: number;
    api: GridApi<TData>;
    context: unknown;
};

export type FullWidthRowRendererProps<TData> = {
    row: FullWidthRow<TData> | DataRow<TData> | DetailRow<TData>;
    api: GridApi<TData>;
    context: unknown;
};

export type HeaderRendererProps<TData> = {
    column: ResolvedColumn<TData> | null;
    /** Set for header group cells. */
    groupId: string | null;
    displayName: string;
    api: GridApi<TData>;
    params: Record<string, unknown>;
    sort: 'asc' | 'desc' | null;
    toggleSort: (multi: boolean) => void;
};

export type HeaderRendererComponent<TData> = ComponentType<HeaderRendererProps<TData>>;

/**
 * How an editor is presented. `inline` renders inside the cell. `popup` renders in a portal anchored to the
 * cell rect (no absolute positioning in grid code; the portal layer handles placement).
 */
export type EditorPresentation = 'inline' | 'popup';

/** How keys behave while editing. Editors choose; the grid enforces the choice consistently. */
export type EditorKeyPolicy = {
    /** Enter commits and moves down (default), commits and stays, or inserts a newline (rich/large text). */
    enter: 'commitAndMoveDown' | 'commit' | 'newline';
    /** Tab commits and moves to the next editable cell. */
    tab: 'commitAndMove' | 'ignore';
    /** Arrow keys move the caret inside the editor and never navigate the grid. */
    arrowsNavigateGrid: boolean;
};

export type CellEditorProps<TData, TValue = unknown> = {
    row: DataRow<TData>;
    data: TData;
    column: ResolvedColumn<TData, TValue>;
    /** Value when editing started. */
    initialValue: TValue;
    /** Current draft. The grid owns it so it survives re-mounts during scroll or refresh. */
    draft: TValue;
    setDraft: (value: TValue) => void;
    /** Printable key that started the edit, or null for Enter, F2, double-click or api. */
    startKey: string | null;
    /** Ends editing. `true` validates and commits the draft; `false` discards it. */
    stop: (commit: boolean) => void;
    /** Validation message to display, set when a commit was rejected. */
    error: string | null;
    /** Rect of the cell, for popup editors. Updates on scroll and resize. */
    anchor: AnchorRect;
    api: GridApi<TData>;
    params: Record<string, unknown>;
};

export type CellEditorComponent<TData, TValue = unknown> = ComponentType<CellEditorProps<TData, TValue>> & {
    presentation?: EditorPresentation;
    keyPolicy?: Partial<EditorKeyPolicy>;
    /**
     * Converts the draft into the committed value and validates it. Return `{ ok: false, error }` to keep
     * the editor open with a message. May be async (server validation); the editor stays open meanwhile.
     */
    parse?: (
        draft: TValue,
        params: { row: DataRow<TData>; column: ResolvedColumn<TData, TValue> }
    ) =>
        | { ok: true; value: TValue }
        | { ok: false; error: string }
        | Promise<{ ok: true; value: TValue } | { ok: false; error: string }>;
};

/**
 * Named extensions that column definitions refer to by string key (for example definitions sent by a server). One registry per grid, usually built by merging the global
 * app registry with screen-local entries (screen entries win).
 */
export type GridRegistry<TData = any> = {
    renderers?: Record<string, CellRendererComponent<TData>>;
    editors?: Record<string, CellEditorComponent<TData>>;
    headers?: Record<string, HeaderRendererComponent<TData>>;
    fullWidthRenderers?: Record<string, ComponentType<FullWidthRowRendererProps<TData>>>;
    valueGetters?: Record<string, ValueGetter<TData>>;
    valueSetters?: Record<string, ValueSetter<TData>>;
    valueFormatters?: Record<string, ValueFormatter<TData>>;
    keyCreators?: Record<string, (params: { value: unknown }) => string>;
    editablePredicates?: Record<string, (params: { data: TData }) => boolean>;
    cellClassRules?: Record<string, (params: { data: TData; value: unknown }) => string | string[] | undefined>;
    comparators?: Record<string, (a: unknown, b: unknown) => number>;
    /**
     * Filter kinds by `filterType`, merged over the built-ins (text, number, date, set, boolean, coordinates).
     * A column's `filter` names one; an application maps other names its backend sends onto these.
     */
    filters?: Record<string, FilterKind<TData>>;
    /** Named data types. A data type supplies default formatter, editor, comparator and filter kind. */
    dataTypes?: Record<string, DataTypeDefinition<TData>>;
};

export type DataTypeDefinition<TData> = {
    baseType: 'text' | 'number' | 'boolean' | 'date' | 'object';
    valueFormatter?: ValueFormatter<TData>;
    valueParser?: (text: string) => unknown;
    keyCreator?: (params: { value: unknown }) => string;
    editor?: CellEditorComponent<TData>;
    comparator?: (a: unknown, b: unknown) => number;
    filter?: string;
};

/** Thrown (development) or reported (production) when a key has no registry entry. Never silently passed on. */
export type UnresolvedRegistryKey = {
    kind: keyof GridRegistry;
    key: string;
    colId: string | null;
};

/** Menu entries for context and header menus. Built-ins are referenced by name and filtered by permission. */
/** Built-in menu actions the grid runs itself. Header built-ins act on the menu's column. */
export type BuiltinMenuItem =
    | 'copy'
    | 'copyWithHeaders'
    | 'cut'
    | 'paste'
    | 'sortAscending'
    | 'sortDescending'
    | 'clearSort'
    | 'filter'
    | 'clearFilter';

export type MenuItem =
    | 'separator'
    | BuiltinMenuItem
    | {
          id: string;
          label: ReactNode;
          icon?: ReactNode;
          disabled?: boolean;
          destructive?: boolean;
          onSelect?: () => void;
          children?: MenuItem[];
          /**
           * Runs a built-in action under this item's own label (for wording a screen already uses). Its
           * availability comes from the built-in, unless `disabled` is set.
           */
          builtin?: BuiltinMenuItem;
          /** Shortcut label. Defaults to the built-in's shortcut, if any. */
          shortcut?: string;
      };

export type ContextMenuParams<TData> = {
    row: GridRow<TData> | null;
    column: ResolvedColumn<TData> | null;
    /** True when the clicked row is part of the current selection, so actions apply to the selection. */
    withinSelection: boolean;
    api: GridApi<TData>;
};

/** A menu item ready to render: built-ins resolved to labels and availability, separators tidied. */
export type ResolvedMenuItem =
    | { type: 'separator'; id: string }
    | {
          type: 'item';
          id: string;
          label: ReactNode;
          icon?: ReactNode;
          /** Keyboard shortcut label for built-ins, such as "⌘C". */
          shortcut?: string;
          disabled: boolean;
          destructive: boolean;
          /** Built-in action, run by the grid when selected. */
          builtin?: BuiltinMenuItem;
          /** Shows the item as the current choice (the column's sort direction). */
          checked?: boolean;
          onSelect?: () => void;
          children?: ResolvedMenuItem[];
      };

/**
 * What the app receives to render an open menu. The grid owns which menu is open, its items and anchor;
 * the app renders it (the shared Dropdown family) and reports selection and dismissal.
 */
export type GridMenuRenderProps = {
    kind: 'context' | 'header';
    /** Client coordinates: the pointer position (zero size) or the header cell. */
    anchor: AnchorRect;
    items: ResolvedMenuItem[];
    /** Keyboard opening should focus the first item. */
    trigger: 'pointer' | 'keyboard';
    onSelect: (item: ResolvedMenuItem & { type: 'item' }) => void;
    onClose: () => void;
};

/** Props of a filter editor: the UI for one filter kind inside the filter panel. */
export type FilterEditorProps<TData> = {
    column: ResolvedColumn<TData>;
    /** The column's filter kind (`text`, `number`, `date`, `set`, `boolean`, or a registered one). */
    kind: string;
    /** The column's condition in the filter model, or null. */
    condition: Record<string, unknown> | null;
    /**
     * Reports the editor's condition; null clears the column's filter. Incomplete conditions may be
     * reported: the panel applies only applicable ones and keeps the editor's state as it is.
     */
    onChange: (condition: Record<string, unknown> | null) => void;
    /** Set choices for set filters: `filterParams.values`, `filterParams.choices`, or the column's local values. */
    choices: import('../filters/ui').SetChoicesSource | null;
    api: GridApi<TData>;
    close: () => void;
};

/** What the app receives to render the filter panel for a column (from the header menu or indicator). */
export type GridFilterPanelRenderProps<TData> = {
    anchor: AnchorRect;
    colId: string;
    /** The editor for the column's kind, ready to render inside the app's popover. */
    children: ReactNode;
    onClose: () => void;
    column: ResolvedColumn<TData>;
};

/** What the app receives to render the column chooser. */
export type GridColumnChooserRenderProps<TData> = {
    anchor: AnchorRect;
    columns: { colId: string; label: string; visible: boolean; locked: boolean }[];
    setVisible: (colId: string, visible: boolean) => void;
    onClose: () => void;
    api: GridApi<TData>;
};

/** What the app receives to render a popup editor at its cell. */
export type GridPopupRenderProps = {
    anchor: AnchorRect;
    children: ReactNode;
    /** Light dismiss (click outside): the grid commits the edit, as a blur would. */
    onDismiss: () => void;
};
