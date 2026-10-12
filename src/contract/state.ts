/**
 * Query, selection, focus and view state.
 *
 * Sort and filter models use the common server-side grid wire format, the same one saved views store, so they pass through the server adapter and the view endpoints untouched.
 */
import type { ColumnGroupState, ColumnState } from './columns';
import type { RowId } from './rows';

export type SortDirection = 'asc' | 'desc';

/** One entry of the multi-column sort. Array order is sort priority and is sent to the backend as is. */
export type SortModelItem = {
    colId: string;
    sort: SortDirection;
};

export type SortModel = SortModelItem[];

export type TextFilterOperator =
    | 'contains'
    | 'notContains'
    | 'equals'
    | 'notEqual'
    | 'startsWith'
    | 'endsWith'
    | 'blank'
    | 'notBlank';

export type ComparisonFilterOperator =
    | 'equals'
    | 'notEqual'
    | 'lessThan'
    | 'lessThanOrEqual'
    | 'greaterThan'
    | 'greaterThanOrEqual'
    | 'inRange'
    | 'blank'
    | 'notBlank';

export type TextFilter = { filterType: 'text'; type: TextFilterOperator; filter?: string | null };

export type NumberFilter = {
    filterType: 'number';
    type: ComparisonFilterOperator;
    filter?: number | null;
    filterTo?: number | null;
};

/** Dates travel as `YYYY-MM-DD` strings (or `YYYY-MM-DD HH:mm:ss`), never as Date objects. */
export type DateFilter = {
    filterType: 'date';
    type: ComparisonFilterOperator;
    dateFrom?: string | null;
    dateTo?: string | null;
};

/**
 * A set filter keeps the chosen values (`anyOf`, the default) or excludes them (`noneOf`).
 */
export type SetFilter = { filterType: 'set'; type?: 'anyOf' | 'noneOf'; values: (string | null)[] };

export type BooleanFilter = { filterType: 'boolean'; type: 'equals'; filter: boolean | null };

export type CoordinatesFilter = {
    filterType: 'coordinates';
    type: 'withinRadius';
    filter: {
        latitude: number;
        longitude: number;
        radius: { value: number; unit: 'km' | 'mi' | 'm' };
        metadata?: Record<string, unknown>;
    };
};

/** One condition of a single filter kind. */
export type SimpleFilterCondition =
    | TextFilter
    | NumberFilter
    | DateFilter
    | SetFilter
    | BooleanFilter
    | CoordinatesFilter;

/**
 * Several conditions on one column joined by AND or OR, in the common combined model: the server recognises it
 * by `operator` and `conditions` and evaluates one level only,
 * so a nested combined condition is dropped, locally as on the server.
 */
export type CombinedFilter = {
    filterType: SimpleFilterCondition['filterType'];
    operator: 'AND' | 'OR';
    conditions: SimpleFilterCondition[];
};

export type FilterCondition = SimpleFilterCondition | CombinedFilter;

/**
 * A condition for a filter kind the application registers itself (`registry.filters`). Its shape is the
 * kind's business; the server receives it unchanged.
 */
export type CustomFilterCondition = { filterType: string; [key: string]: unknown };

/** Keyed by colId. Entries for columns the grid does not know are kept, never dropped. */
export type FilterModel = Record<string, FilterCondition | CustomFilterCondition>;

/** Relationship and scope filters sent as `filter[key]=value`. Separate from the column filter model. */
export type ExternalFilters = Record<string, string | number | boolean>;

/** Everything that decides which rows a query returns. A change starts a new query generation. */
export type QueryState = {
    sortModel: SortModel;
    filterModel: FilterModel;
    /** Free-text search, sent as `q`. Debouncing is the caller's job. */
    search: string;
    externalFilters: ExternalFilters;
    /** Active row group columns, outermost first. */
    rowGroupColIds: string[];
};

/**
 * Row selection. With a remote model the user can select all rows without loading them, so selection is
 * either an explicit id set or "all matching the current query, except these".
 */
export type RowSelection = { mode: 'ids'; ids: ReadonlySet<RowId> } | { mode: 'all'; excludedIds: ReadonlySet<RowId> };

export type RowSelectionMode = 'none' | 'single' | 'multiple';

/** A cell addressed by identity. Never by DOM element or mounted index. */
export type CellPosition = {
    rowId: RowId;
    colId: string;
};

/**
 * A rectangular range. Anchor and end are logical cells; the rectangle spans every displayed row between
 * them and every displayed column between them, in current display order. Rows or columns that leave the
 * display (filtered, hidden) shrink the range; the range is dropped when an anchor row disappears.
 */
export type CellRange = {
    anchor: CellPosition;
    end: CellPosition;
};

/**
 * Resolved form of a range at one model version, for aggregation, copy and rendering. Rows inside the
 * range that are not loaded are listed in `unloadedIndexes` and left out of `rowIds`; aggregation skips them
 * and copy asks the server to serialize by index range instead.
 */
export type ResolvedCellRange = {
    rowIds: RowId[];
    colIds: string[];
    startIndex: number;
    endIndex: number;
    unloadedIndexes: number[];
};

export type EditingState = {
    cell: CellPosition;
    /** Current draft value. Not written to the row until commit. */
    draft: unknown;
    /** Key that started the edit, when a typed key started it. */
    startKey: string | null;
} | null;

/** Grid state a consumer can control or read. Each member can be controlled on its own. */
export type GridState = {
    columnState: ColumnState[];
    columnGroupState: ColumnGroupState[];
    query: QueryState;
    /** Group rows that are open. Server groups use the id built from their key path. */
    expandedRowIds: ReadonlySet<RowId>;
    selection: RowSelection;
    activeRowId: RowId | null;
    focusedCell: CellPosition | null;
    ranges: CellRange[];
};

/**
 * The saved view payload, as the view endpoints store it today. The compatibility layer converts between
 * this and `GridState`. `groupState` and `pivotState` are carried unchanged.
 */
export type SavedViewState = {
    filterModel: FilterModel | null;
    sortModel: SortModel | null;
    columnState: ColumnState[] | null;
    columnGroupState: ColumnGroupState[] | null;
    groupState?: unknown[] | null;
    pivotState?: unknown[] | null;
    searchQuery: string | null;
    viewSettings?: Record<string, unknown> | null;
};
