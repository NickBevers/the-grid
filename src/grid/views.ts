/**
 * Saved views: the grid state a view stores, captured and applied in the common server-side grid shape, so
 * views saved by an earlier grid load unchanged and views saved by this one load the same way.
 *
 * - `columnState` is the stored `ColumnState` format (`colId`, `width`, `hide`, `pinned`, `sort`, `sortIndex`,
 *   `rowGroup`, `rowGroupIndex`, `flex`, ...). Ids the grid does not know are kept for when the column
 *   appears. To read views that stored another library's auto group column, give the group column
 *   that id with `groupColumn.colId`.
 * - `filterModel` is the wire model: a set condition carries `type` only for `noneOf`, as saved views store it.
 * - Applying goes in this order: search, then filters (replaced), then column state
 *   merged with columns the view does not know at their defined position (`applyOrder`), or a reset for an
 *   empty state, then the sort model with every other sort cleared, then column group state or a reset.
 * - `isViewStateEqual`: widths are ignored, empty values are equal,
 *   and falsy column flags are the same.
 */
import type { ColumnState, GridApi, SavedViewState } from '../contract';
import { wireFilterModel } from '../models/httpDataSource';

/** The saved view payload (`SavedViewState`): every field the view endpoints store. */
export type GridViewState = SavedViewState;

/** The grid's current view state. Every field is present (empty ones as null), as the app sends them. */
export function captureViewState<TData>(
    api: GridApi<TData>,
    options: { viewSettings?: Record<string, unknown> | null } = {}
): GridViewState {
    const filterModel = wireFilterModel(api.getFilterModel());
    const sortModel = api.getSortModel();
    const search = api.getSearch();

    return {
        filterModel: Object.keys(filterModel).length > 0 ? filterModel : null,
        sortModel: sortModel.length > 0 ? sortModel.map(({ colId, sort }) => ({ colId, sort })) : null,
        columnState: api.getColumnState(),
        columnGroupState: api.getColumnGroupState(),
        searchQuery: search === '' ? null : search,
        viewSettings: options.viewSettings ?? null,
    };
}

/** Applies a saved view in a fixed order. Missing fields clear what they cover. */
export function applyViewState<TData>(api: GridApi<TData>, view: Partial<GridViewState>): void {
    api.setSearch(view.searchQuery ?? '');
    api.setFilterModel(view.filterModel ?? {});
    const saved = view.columnState ?? [];
    if (saved.length === 0) {
        api.resetColumnState();
    } else {
        const defined = api.getColumns().map((column) => column.colId);
        api.applyColumnState(mergeSavedColumnState(defined, saved), { applyOrder: true });
    }
    // As the app: the sort step runs only when the view has a sort model (an empty one clears sorting).
    if (Array.isArray(view.sortModel)) {
        api.applyColumnState(
            view.sortModel.map((entry, index) => ({ colId: entry.colId, sort: entry.sort, sortIndex: index })),
            { defaultState: { sort: null } }
        );
    }
    if (view.columnGroupState && view.columnGroupState.length > 0) {
        api.setColumnGroupState(view.columnGroupState);
    } else {
        api.resetColumnGroupState();
    }
}

/**
 * The app's `mergeSavedColumnState`: columns the saved state does not mention (added since the view was
 * saved) are slotted in at their defined position, so they appear where they are defined, not at the end.
 */
export function mergeSavedColumnState(
    definedOrder: readonly string[],
    savedState: readonly ColumnState[]
): ColumnState[] {
    const savedIds = new Set(savedState.map((column) => column.colId));
    const merged = [...savedState];
    definedOrder.forEach((colId, definedIndex) => {
        if (!savedIds.has(colId)) {
            merged.splice(Math.min(definedIndex, merged.length), 0, { colId });
        }
    });

    return merged;
}

/** Whether two view states mean the same (widths ignored). */
export function isViewStateEqual(a: Partial<GridViewState>, b: Partial<GridViewState>): boolean {
    return (
        (a.searchQuery || '') === (b.searchQuery || '') &&
        deepEqual(empty(a.viewSettings), empty(b.viewSettings)) &&
        deepEqual(empty(a.sortModel), empty(b.sortModel)) &&
        deepEqual(empty(a.columnGroupState), empty(b.columnGroupState)) &&
        deepEqual(empty(a.filterModel), empty(b.filterModel)) &&
        deepEqual(empty(comparableColumns(a.columnState)), empty(comparableColumns(b.columnState)))
    );
}

function comparableColumns(state: ColumnState[] | null | undefined): Record<string, unknown>[] | null | undefined {
    if (!Array.isArray(state)) {
        return state;
    }

    return state.map((entry) => ({
        colId: entry.colId ?? null,
        hide: entry.hide || null,
        pinned: entry.pinned || null,
        sort: entry.sort ?? null,
        sortIndex: entry.sortIndex ?? null,
        flex: entry.flex || null,
        rowGroup: entry.rowGroup || null,
        rowGroupIndex: entry.rowGroupIndex ?? null,
        aggFunc: entry.aggFunc ?? null,
        pivot: entry.pivot || null,
        pivotIndex: entry.pivotIndex ?? null,
    }));
}

/** lodash `isEmpty` for the values views hold: null, undefined, '' and empty arrays or objects. */
function empty<T>(value: T): T | null {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    if (Array.isArray(value)) {
        return value.length === 0 ? null : value;
    }
    if (typeof value === 'object') {
        return Object.keys(value).length === 0 ? null : value;
    }

    return value;
}

/** Structural equality ignoring object key order (lodash `isEqual` for JSON values). */
function deepEqual(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) {
        return true;
    }
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
        return false;
    }
    if (Array.isArray(a) !== Array.isArray(b)) {
        return false;
    }
    if (Array.isArray(a)) {
        const other = b as unknown[];

        return a.length === other.length && a.every((entry, index) => deepEqual(entry, other[index]));
    }
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);

    return (
        keys.length === Object.keys(right).length &&
        keys.every((key) => key in right && deepEqual(left[key], right[key]))
    );
}
