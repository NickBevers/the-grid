/**
 * Pure row selection over the contract's `RowSelection`.
 *
 * Selection is either an explicit id set or "all rows matching the current query, except these". Ids of
 * rows that are not loaded (scrolled out of a remote model, filtered away by a search) stay in the set, so a
 * selection survives a search that returns no rows. Only data rows can be selected: group, detail,
 * full-width and placeholder rows never enter a selection through a click.
 */
import { isDataRow, type GridRow, type RowId, type RowSelection } from '../contract';
import type { GridSnapshot } from './snapshot';

/** How many rows a grid lets the user select. A grid with selection `none` never calls these functions. */
export type SelectionMode = 'single' | 'multiple';

/** Options shared by the selection functions. */
export type SelectionOptions = {
    mode: SelectionMode;
    /** Rows the user may select. Defaults to every row. Unselectable ids are ignored when selecting. */
    isSelectable?: (id: RowId) => boolean;
};

/** Options for `select`. */
export type SelectOptions = SelectionOptions & {
    /** Drop every other selected id first. Single mode always clears others when selecting. */
    clearOthers?: boolean;
};

/** Click modifiers. `toggle` is Ctrl or Cmd, `range` is Shift. */
export type ClickModifiers = {
    toggle: boolean;
    range: boolean;
};

/**
 * Click state the Grid keeps between clicks. `anchorId` is where a Shift range starts. `rangeEndId` is the
 * end of the last Shift range from that anchor, so the next Shift click can replace that range. It is
 * optional: without it a new range adds to the previous one instead of replacing it.
 */
export type ClickState = {
    anchorId: RowId | null;
    rangeEndId?: RowId | null;
};

/** Result of a click: the next selection and the next click state. */
export type ClickResult = {
    selection: RowSelection;
    anchorId: RowId | null;
    rangeEndId: RowId | null;
};

/** A selection with nothing selected. */
export function emptySelection(): RowSelection {
    return { mode: 'ids', ids: new Set() };
}

/** Selects every row matching the current query, without loading them. */
export function selectAll(): RowSelection {
    return { mode: 'all', excludedIds: new Set() };
}

/** Clears the selection. */
export function deselectAll(): RowSelection {
    return emptySelection();
}

/**
 * Whether the id is selected. In `all` mode this is true for every id that is not excluded, including
 * rows the caller considers unselectable; combine with the grid's own selectable check when that matters.
 */
export function isSelected(selection: RowSelection, id: RowId): boolean {
    return selection.mode === 'ids' ? selection.ids.has(id) : !selection.excludedIds.has(id);
}

/**
 * Selects or deselects ids. Unselectable ids are ignored when selecting; deselecting always succeeds so a
 * stale id can be removed. Single mode keeps at most one id: the last selectable id passed. Returns the same
 * object when nothing changes.
 */
export function select(
    selection: RowSelection,
    ids: Iterable<RowId>,
    selected: boolean,
    options: SelectOptions
): RowSelection {
    const isSelectable = options.isSelectable ?? ((): boolean => true);
    const requested = [...ids];

    if (!selected) {
        if (options.clearOthers) {
            return isEmpty(selection) ? selection : emptySelection();
        }

        if (selection.mode === 'ids') {
            return withIds(selection, without(selection.ids, requested));
        }

        return withExcluded(selection, union(selection.excludedIds, requested));
    }

    const selectable = requested.filter((id) => isSelectable(id));

    if (options.mode === 'single') {
        const last = selectable.at(-1);

        if (last === undefined) {
            return selection;
        }

        return withIds(selection, new Set([last]));
    }

    if (options.clearOthers) {
        return withIds(selection, new Set(selectable));
    }

    if (selection.mode === 'ids') {
        return withIds(selection, union(selection.ids, selectable));
    }

    return withExcluded(selection, without(selection.excludedIds, selectable));
}

/**
 * Applies a row click, with click selection as the app configures it.
 *
 * - Plain click selects only that row, in both modes.
 * - Toggle (Ctrl or Cmd) adds or removes the row in multiple mode. In single mode it deselects the row when
 *   it is selected and otherwise selects only that row.
 * - Range (Shift) in multiple mode selects every selectable data row between the anchor and the row in
 *   displayed order, keeping other selected rows and replacing the previous range from the same anchor.
 *   Without an anchor in the snapshot it selects the row, keeps the rest and makes the row the anchor. In
 *   single mode it behaves as a plain click.
 *
 * Clicks on rows that are missing, not data rows or not selectable change nothing.
 */
export function clickSelection<TData>(
    selection: RowSelection,
    snapshot: GridSnapshot<TData>,
    rowId: RowId,
    modifiers: ClickModifiers,
    state: ClickState,
    options: SelectionOptions
): ClickResult {
    const unchanged: ClickResult = { selection, anchorId: state.anchorId, rangeEndId: state.rangeEndId ?? null };

    if (!isSelectableDataRow(snapshot, rowId, options)) {
        return unchanged;
    }

    const plain = (): ClickResult => ({
        selection: select(selection, [rowId], true, { ...options, clearOthers: true }),
        anchorId: rowId,
        rangeEndId: null,
    });

    if (options.mode === 'single') {
        if (modifiers.toggle && isSelected(selection, rowId)) {
            return { selection: select(selection, [rowId], false, options), anchorId: rowId, rangeEndId: null };
        }

        return plain();
    }

    if (modifiers.range) {
        const anchorIndex = state.anchorId === null ? undefined : snapshot.indexOf(state.anchorId);

        if (state.anchorId === null || anchorIndex === undefined) {
            return {
                selection: select(selection, [rowId], true, options),
                anchorId: rowId,
                rangeEndId: null,
            };
        }

        const nextRange = rangeIds(snapshot, state.anchorId, rowId, options);
        const previousRange =
            state.rangeEndId === undefined || state.rangeEndId === null
                ? []
                : rangeIds(snapshot, state.anchorId, state.rangeEndId, options);
        const nextRangeSet = new Set(nextRange);
        const dropped = previousRange.filter((id) => !nextRangeSet.has(id));
        const afterDrop = select(selection, dropped, false, options);

        return {
            selection: select(afterDrop, nextRange, true, options),
            anchorId: state.anchorId,
            rangeEndId: rowId,
        };
    }

    if (modifiers.toggle) {
        return {
            selection: select(selection, [rowId], !isSelected(selection, rowId), options),
            anchorId: rowId,
            rangeEndId: null,
        };
    }

    return plain();
}

/**
 * The loaded data rows that are selected, in the order given. Rows without data, group rows and
 * placeholders are left out, as are rows the optional `isSelectable` rejects (relevant in `all` mode).
 */
export function selectedLoadedRows<TData>(
    selection: RowSelection,
    rows: Iterable<GridRow<TData>>,
    options: { isSelectable?: (id: RowId) => boolean } = {}
): GridRow<TData>[] {
    const result: GridRow<TData>[] = [];

    for (const row of rows) {
        if (!isDataRow(row) || !isSelected(selection, row.id)) {
            continue;
        }

        if (options.isSelectable && !options.isSelectable(row.id)) {
            continue;
        }

        result.push(row);
    }

    return result;
}

/**
 * How many rows are selected. In `all` mode it is the total minus the exclusions, or null when the total
 * is unknown (a remote model before its first count).
 */
export function selectionCount(selection: RowSelection, totalRowCount: number | null): number | null {
    if (selection.mode === 'ids') {
        return selection.ids.size;
    }

    if (totalRowCount === null) {
        return null;
    }

    return Math.max(0, totalRowCount - selection.excludedIds.size);
}

/**
 * Drops ids that no longer exist, for local data after rows were deleted. Server grids keep their ids and
 * do not call this. Stale exclusions in `all` mode are dropped too. Returns the same object when nothing
 * changes.
 */
export function pruneSelection(selection: RowSelection, exists: (id: RowId) => boolean): RowSelection {
    if (selection.mode === 'ids') {
        return withIds(selection, new Set([...selection.ids].filter((id) => exists(id))));
    }

    return withExcluded(selection, new Set([...selection.excludedIds].filter((id) => exists(id))));
}

function isSelectableDataRow<TData>(snapshot: GridSnapshot<TData>, id: RowId, options: SelectionOptions): boolean {
    const index = snapshot.indexOf(id);
    const row = index === undefined ? undefined : snapshot.rowAt(index);

    return row !== undefined && isDataRow(row) && (options.isSelectable?.(id) ?? true);
}

/** Selectable data rows between two rows, inclusive, in displayed order. Empty when either row is gone. */
function rangeIds<TData>(
    snapshot: GridSnapshot<TData>,
    fromId: RowId,
    toId: RowId,
    options: SelectionOptions
): RowId[] {
    const fromIndex = snapshot.indexOf(fromId);
    const toIndex = snapshot.indexOf(toId);

    if (fromIndex === undefined || toIndex === undefined) {
        return [];
    }

    const ids: RowId[] = [];

    for (let index = Math.min(fromIndex, toIndex); index <= Math.max(fromIndex, toIndex); index++) {
        const row = snapshot.rowAt(index);

        if (row !== undefined && isDataRow(row) && (options.isSelectable?.(row.id) ?? true)) {
            ids.push(row.id);
        }
    }

    return ids;
}

function isEmpty(selection: RowSelection): boolean {
    return selection.mode === 'ids' && selection.ids.size === 0;
}

function union(set: ReadonlySet<RowId>, ids: readonly RowId[]): Set<RowId> {
    const result = new Set(set);

    for (const id of ids) {
        result.add(id);
    }

    return result;
}

function without(set: ReadonlySet<RowId>, ids: readonly RowId[]): Set<RowId> {
    const result = new Set(set);

    for (const id of ids) {
        result.delete(id);
    }

    return result;
}

function sameSet(left: ReadonlySet<RowId>, right: ReadonlySet<RowId>): boolean {
    if (left.size !== right.size) {
        return false;
    }

    for (const id of left) {
        if (!right.has(id)) {
            return false;
        }
    }

    return true;
}

function withIds(selection: RowSelection, ids: Set<RowId>): RowSelection {
    if (selection.mode === 'ids' && sameSet(selection.ids, ids)) {
        return selection;
    }

    return { mode: 'ids', ids };
}

function withExcluded(selection: RowSelection, excludedIds: Set<RowId>): RowSelection {
    if (selection.mode === 'all' && sameSet(selection.excludedIds, excludedIds)) {
        return selection;
    }

    return { mode: 'all', excludedIds };
}
