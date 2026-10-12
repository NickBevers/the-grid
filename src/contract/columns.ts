/**
 * Column definitions and column state.
 *
 * Field names follow the common server-side column schema where the meaning is the same, so a compatibility
 * layer can pass server definitions through with little translation. Function-valued members may also be
 * registry keys (strings) until `resolveColumns` replaces them.
 */
import type { ComponentType } from 'react';

import type { CellEditorComponent, CellRendererComponent, HeaderRendererComponent } from './renderers';
import type { DataRow, GridRow, RowWithData } from './rows';
import type { SortDirection } from './state';

export type PinnedSide = 'left' | 'right';

/** A registry key that the registry resolves to a function or component. */
export type RegistryKey = string;

export type ValueGetterParams<TData> = {
    row: RowWithData<TData>;
    data: TData;
    column: ResolvedColumn<TData>;
    context: unknown;
};

export type ValueFormatterParams<TData, TValue = unknown> = ValueGetterParams<TData> & { value: TValue };

export type ValueSetterParams<TData, TValue = unknown> = ValueGetterParams<TData> & {
    oldValue: TValue;
    newValue: TValue;
};

export type ValueGetter<TData, TValue = unknown> = (params: ValueGetterParams<TData>) => TValue;
export type ValueFormatter<TData, TValue = unknown> = (params: ValueFormatterParams<TData, TValue>) => string;
/** Writes a new value into `data`. Returns false when nothing changed, which skips the change event. */
export type ValueSetter<TData, TValue = unknown> = (params: ValueSetterParams<TData, TValue>) => boolean;
export type EditablePredicate<TData> = (params: ValueGetterParams<TData>) => boolean;
export type CellClassRule<TData> = (params: ValueFormatterParams<TData>) => string | string[] | undefined;
export type Comparator<TValue = unknown> = (a: TValue, b: TValue) => number;

/** A leaf column. */
export type ColumnDef<TData, TValue = unknown> = {
    /** Stable column id. Defaults to `field`. Required when two columns share a field. */
    colId?: string;
    /** Dotted path into the row data. */
    field?: string;
    headerName?: string;
    headerTooltip?: string;
    headerClass?: string;

    width?: number;
    minWidth?: number;
    maxWidth?: number;
    /** Share of the remaining width. A flex column ignores `width` except as a starting point for resize. */
    flex?: number;
    resizable?: boolean;
    /** Column cannot be dragged to a new position. */
    lockPosition?: boolean | PinnedSide;
    lockVisible?: boolean;
    lockPinned?: boolean;
    movable?: boolean;

    hide?: boolean;
    pinned?: PinnedSide | null;

    sortable?: boolean;
    /** Initial sort. Column state wins once the user has sorted. */
    sort?: SortDirection | null;
    comparator?: Comparator<TValue> | RegistryKey;

    /** Filter kind used by the filter bar and the backend (text, number, date, set, boolean, coordinates). */
    filter?: string | boolean;
    filterParams?: Record<string, unknown>;
    filterValueGetter?: ValueGetter<TData> | RegistryKey;

    editable?: boolean | EditablePredicate<TData> | RegistryKey;
    valueGetter?: ValueGetter<TData, TValue> | RegistryKey;
    valueSetter?: ValueSetter<TData, TValue> | RegistryKey;
    valueFormatter?: ValueFormatter<TData, TValue> | RegistryKey;
    /** Returns the string used for set filters and grouping keys. */
    keyCreator?: ((params: ValueFormatterParams<TData, TValue>) => string) | RegistryKey;
    /** Named data type from the registry (date, person, country, ...). Supplies defaults for the members above. */
    dataType?: RegistryKey | false;

    cellRenderer?: CellRendererComponent<TData, TValue> | RegistryKey;
    cellRendererParams?: Record<string, unknown>;
    cellEditor?: CellEditorComponent<TData, TValue> | RegistryKey;
    cellEditorParams?: Record<string, unknown>;
    headerRenderer?: HeaderRendererComponent<TData> | RegistryKey;
    headerRendererParams?: Record<string, unknown>;
    /** Hides the header menu button for this column (with `headerMenuButton` on). */
    suppressHeaderMenuButton?: boolean;
    /** Hides this column's header filter button (with headerFilterButton "always"). */
    suppressHeaderFilterButton?: boolean;
    tooltipField?: string;
    tooltipRenderer?: ComponentType<{ value: unknown }> | RegistryKey;

    /** Static classes, or a rule. Both are merged onto the cell part. */
    cellClass?: string | string[] | CellClassRule<TData> | RegistryKey;
    cellStyle?: Record<string, string | number>;

    /** Column may be used for row grouping by the group-by UI. */
    enableRowGroup?: boolean;
    /** Column is an active row group, in `rowGroupIndex` order. */
    rowGroup?: boolean;
    rowGroupIndex?: number | null;
    /** Dormant pivot and value fields. Carried through state and requests, no UI. */
    enablePivot?: boolean;
    enableValue?: boolean;
    aggFunc?: string | null;

    /**
     * The cell's content sets the row height. Such columns stay mounted during horizontal
     * scrolling, so a row never changes height because a tall cell scrolled out of view.
     */
    autoHeight?: boolean;

    /** False skips the column in keyboard navigation. Default true. */
    focusable?: boolean;

    checkboxSelection?: boolean;
    /** Shows the row drag handle in this column. Default: the first displayed column, when the grid's `rowDrag` is on. */
    rowDrag?: boolean;
    headerCheckboxSelection?: boolean;

    /** Free-form props the app attaches (for example server-side `context` or `meta`). The grid never reads them. */
    context?: Record<string, unknown>;
};

/** A header group with nested children. Open/closed visibility is per child via `showWhen`. */
export type ColumnGroupDef<TData> = {
    groupId: string;
    headerName?: string;
    headerClass?: string;
    headerRenderer?: HeaderRendererComponent<TData> | RegistryKey;
    headerRendererParams?: Record<string, unknown>;
    /** Whether the group starts open. Column group state wins after the user toggles it. */
    openByDefault?: boolean;
    marryChildren?: boolean;
    children: ColumnDefinition<TData>[];
};

export type ColumnDefinition<TData> = (ColumnDef<TData> & { showWhen?: 'open' | 'closed' }) | ColumnGroupDef<TData>;

export function isColumnGroupDef<TData>(def: ColumnDefinition<TData>): def is ColumnGroupDef<TData> {
    return 'children' in def;
}

/**
 * A leaf column after defaults, data types and registry keys are applied. Every function member is a
 * function here; no strings remain.
 */
export type ResolvedColumn<TData, TValue = unknown> = {
    colId: string;
    def: ColumnDef<TData, TValue>;
    field: string | undefined;
    headerName: string;
    /** Group ids from the outermost header group to the innermost. */
    groupPath: string[];
    getValue: (row: RowWithData<TData>) => TValue;
    formatValue: (row: RowWithData<TData>, value: TValue) => string;
    /** Undefined when the column has no setter and no field to write to. */
    setValue: ((row: DataRow<TData>, value: TValue) => boolean) | undefined;
    isEditable: (row: GridRow<TData>) => boolean;
    cellClasses: (row: RowWithData<TData>, value: TValue) => string[];
    renderer: CellRendererComponent<TData, TValue> | undefined;
    editor: CellEditorComponent<TData, TValue> | undefined;
    comparator: Comparator<TValue>;
};

/**
 * Persisted state for one column. Wire compatible with the `ColumnState` format stored in saved views, so
 * views saved before the migration load unchanged.
 */
export type ColumnState = {
    colId: string;
    hide?: boolean | null;
    width?: number | null;
    flex?: number | null;
    sort?: SortDirection | null;
    sortIndex?: number | null;
    pinned?: PinnedSide | boolean | null;
    rowGroup?: boolean | null;
    rowGroupIndex?: number | null;
    aggFunc?: string | null;
    pivot?: boolean | null;
    pivotIndex?: number | null;
};

/** Persisted open/closed state for one header group. Wire compatible with the stored `columnGroupState` format. */
export type ColumnGroupState = {
    groupId: string;
    open: boolean;
};

export type ApplyColumnStateOptions = {
    /** Reorder columns to match the order of `state`. */
    applyOrder?: boolean;
    /** Values for columns that `state` does not mention. */
    defaultState?: Omit<ColumnState, 'colId'>;
};

/** A column as currently displayed: resolved column plus live width and position. */
export type DisplayedColumn<TData> = {
    column: ResolvedColumn<TData>;
    section: 'left' | 'center' | 'right';
    /** Index among all displayed leaf columns, left pinned first. */
    index: number;
    width: number;
    /** Offset from the start of its section in pixels. */
    left: number;
};
