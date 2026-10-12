/**
 * Keyboard navigation between cells. Pure functions over a `GridSnapshot`: they map key events
 * to navigation intents, work out the next focused cell and recover focus after data or column changes.
 * Rows are addressed by id and columns by colId; displayed indexes are only read from the snapshot given.
 */
import type { CellPosition } from '../contract';
import type { GridSnapshot } from './snapshot';

/** The colId used when focus is on a full-width row as a whole. */
export const FULL_WIDTH_COLUMN = '__row';

/** A navigation intent, independent of the physical key that produced it. */
export type NavigationKey =
    | 'up'
    | 'down'
    | 'left'
    | 'right'
    | 'next'
    | 'previous'
    | 'rowStart'
    | 'rowEnd'
    | 'columnTop'
    | 'columnBottom'
    | 'gridStart'
    | 'gridEnd'
    | 'pageUp'
    | 'pageDown';

/** The parts of a keyboard event that navigation reads. */
export type NavigationKeyEvent = {
    key: string;
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
};

/** Options for `nextFocus`. */
export type NavigationOptions = {
    /** Rows moved by Page Up and Page Down. Values below 1 count as 1. */
    pageSize: number;
    /**
     * The column focused before focus moved onto a full-width row. Moving up or down off the full-width row
     * returns to it when it is still a focusable column.
     */
    preferredColId?: string;
};

/** Where focus was before a data or column change, for `recoverFocus`. */
export type PreviousFocus = {
    cell: CellPosition;
    /** Displayed row index of the cell in the snapshot it was focused in. */
    index: number;
    /** Displayed column index of the cell in the snapshot it was focused in. */
    columnIndex: number;
};

/**
 * Maps a key event to a navigation intent, or null when the key is not a navigation key.
 *
 * Arrows move one cell; Tab and Shift+Tab are next and previous; Home and End go to the row's ends; Ctrl or
 * Cmd with Home and End go to the grid's first or last cell; Ctrl or Cmd with ArrowUp and ArrowDown go to
 * the first or last row in the same column, and with ArrowLeft and ArrowRight to the row's ends. Shift with any other navigation key is left
 * to range extension, and Alt combinations are left to the browser and editors.
 */
export function keyToNavigation(event: NavigationKeyEvent): NavigationKey | null {
    if (event.altKey) {
        return null;
    }

    const modifier = event.ctrlKey || event.metaKey;

    if (event.key === 'Tab') {
        if (modifier) {
            return null;
        }

        return event.shiftKey ? 'previous' : 'next';
    }

    if (event.shiftKey) {
        return null;
    }

    switch (event.key) {
        case 'ArrowUp':
            return modifier ? 'columnTop' : 'up';
        case 'ArrowDown':
            return modifier ? 'columnBottom' : 'down';
        case 'ArrowLeft':
            return modifier ? 'rowStart' : 'left';
        case 'ArrowRight':
            return modifier ? 'rowEnd' : 'right';
        case 'Home':
            return modifier ? 'gridStart' : 'rowStart';
        case 'End':
            return modifier ? 'gridEnd' : 'rowEnd';
        case 'PageUp':
            return modifier ? null : 'pageUp';
        case 'PageDown':
            return modifier ? null : 'pageDown';
        default:
            return null;
    }
}

/**
 * Works out the cell focus moves to for a navigation intent.
 *
 * Non-focusable columns are skipped. Full-width rows are focused as a whole (`FULL_WIDTH_COLUMN`), and
 * moving off one vertically returns to `options.preferredColId`. Arrows, Home, End and paging stop at the
 * grid's edges and return the current cell. `next` past the last cell of the grid and `previous` before
 * the first return null, meaning focus leaves the grid. From null (or a cell that is no longer in the
 * snapshot), `next` and `down` go to the first cell, `previous` and `up` to the last row, and the grid
 * edge keys to their corner; other keys return null. Returns null for an empty grid or a grid without
 * focusable columns.
 */
export function nextFocus<TData>(
    snapshot: GridSnapshot<TData>,
    from: CellPosition | null,
    key: NavigationKey,
    options: NavigationOptions
): CellPosition | null {
    const focusable = focusableColumns(snapshot);

    if (snapshot.rowCount === 0 || focusable === null) {
        return null;
    }

    const current = locate(snapshot, from);
    const lastRow = snapshot.rowCount - 1;
    const cell = (rowIndex: number, columnIndex: number): CellPosition | null =>
        cellAt(snapshot, rowIndex, columnIndex, focusable);

    if (current === null) {
        switch (key) {
            case 'next':
            case 'down':
            case 'columnTop':
            case 'gridStart':
                return cell(0, focusable.first);
            case 'previous':
            case 'gridEnd':
                return cell(lastRow, focusable.last);
            case 'up':
            case 'columnBottom':
                return cell(lastRow, focusable.first);
            default:
                return null;
        }
    }

    const { rowIndex, columnIndex } = current;
    const stay = cell(rowIndex, columnIndex ?? focusable.first);
    const verticalColumn =
        columnIndex === undefined
            ? preferredColumnIndex(snapshot, options.preferredColId, focusable)
            : nearestFocusable(columnIndex, focusable);
    const pageSize = Math.max(1, Math.floor(options.pageSize) || 1);

    switch (key) {
        case 'up':
            return rowIndex === 0 ? stay : cell(rowIndex - 1, verticalColumn);
        case 'down':
            return rowIndex === lastRow ? stay : cell(rowIndex + 1, verticalColumn);
        case 'pageUp':
            return rowIndex === 0 ? stay : cell(Math.max(0, rowIndex - pageSize), verticalColumn);
        case 'pageDown':
            return rowIndex === lastRow ? stay : cell(Math.min(lastRow, rowIndex + pageSize), verticalColumn);
        case 'left': {
            const target = columnIndex === undefined ? null : previousFocusable(columnIndex, focusable);
            return target === null ? stay : cell(rowIndex, target);
        }
        case 'right': {
            const target = columnIndex === undefined ? null : nextFocusable(columnIndex, focusable);
            return target === null ? stay : cell(rowIndex, target);
        }
        case 'rowStart':
            return columnIndex === undefined ? stay : cell(rowIndex, focusable.first);
        case 'rowEnd':
            return columnIndex === undefined ? stay : cell(rowIndex, focusable.last);
        case 'columnTop':
            return cell(0, verticalColumn);
        case 'columnBottom':
            return cell(lastRow, verticalColumn);
        case 'gridStart':
            return cell(0, focusable.first);
        case 'gridEnd':
            return cell(lastRow, focusable.last);
        case 'next': {
            const target = columnIndex === undefined ? null : nextFocusable(columnIndex, focusable);
            if (target !== null) {
                return cell(rowIndex, target);
            }
            return rowIndex === lastRow ? null : cell(rowIndex + 1, focusable.first);
        }
        case 'previous': {
            const target = columnIndex === undefined ? null : previousFocusable(columnIndex, focusable);
            if (target !== null) {
                return cell(rowIndex, target);
            }
            return rowIndex === 0 ? null : cell(rowIndex - 1, focusable.last);
        }
    }
}

/**
 * Recovers the focused cell after data or column changes.
 *
 * Keeps the row when its id is still displayed, otherwise takes the row now at the previous index, clamped
 * to the grid. Keeps the column when it is still displayed and focusable, otherwise takes the focusable
 * column nearest the previous column index (the one to the right wins a tie). A full-width row is focused
 * as a whole. Returns null when the grid has no rows or no focusable columns.
 */
export function recoverFocus<TData>(snapshot: GridSnapshot<TData>, previous: PreviousFocus): CellPosition | null {
    const focusable = focusableColumns(snapshot);

    if (snapshot.rowCount === 0 || focusable === null) {
        return null;
    }

    const rowIndex = snapshot.indexOf(previous.cell.rowId) ?? clamp(previous.index, 0, snapshot.rowCount - 1);
    const columnIndex = snapshot.columnIndexOf(previous.cell.colId);
    const keepsColumn = columnIndex !== undefined && snapshot.columns[columnIndex]?.focusable === true;

    return cellAt(snapshot, rowIndex, keepsColumn ? columnIndex : previous.columnIndex, focusable);
}

/** Focusable column indexes in visual order. Never empty: a grid without any is represented by null. */
type FocusableColumns = {
    indexes: readonly number[];
    first: number;
    last: number;
};

type Located = {
    rowIndex: number;
    /** Undefined when focus is on a full-width row as a whole. */
    columnIndex: number | undefined;
};

function locate<TData>(snapshot: GridSnapshot<TData>, from: CellPosition | null): Located | null {
    if (from === null) {
        return null;
    }

    const rowIndex = snapshot.indexOf(from.rowId);
    const row = rowIndex === undefined ? undefined : snapshot.rowAt(rowIndex);

    if (rowIndex === undefined || row === undefined) {
        return null;
    }

    if (snapshot.isFullWidth(row)) {
        return { rowIndex, columnIndex: undefined };
    }

    const columnIndex = snapshot.columnIndexOf(from.colId);

    return columnIndex === undefined ? null : { rowIndex, columnIndex };
}

/** Builds the cell at a displayed row, focusing full-width rows as a whole and snapping to a focusable column. */
function cellAt<TData>(
    snapshot: GridSnapshot<TData>,
    rowIndex: number,
    columnIndex: number,
    focusable: FocusableColumns
): CellPosition | null {
    const row = snapshot.rowAt(rowIndex);

    if (row === undefined) {
        return null;
    }

    if (snapshot.isFullWidth(row)) {
        return { rowId: row.id, colId: FULL_WIDTH_COLUMN };
    }

    const column = snapshot.columns[nearestFocusable(columnIndex, focusable)];

    return column === undefined ? null : { rowId: row.id, colId: column.colId };
}

function focusableColumns<TData>(snapshot: GridSnapshot<TData>): FocusableColumns | null {
    const indexes: number[] = [];

    snapshot.columns.forEach((column, index) => {
        if (column.focusable) {
            indexes.push(index);
        }
    });

    const first = indexes[0];
    const last = indexes[indexes.length - 1];

    return first === undefined || last === undefined ? null : { indexes, first, last };
}

function preferredColumnIndex<TData>(
    snapshot: GridSnapshot<TData>,
    preferredColId: string | undefined,
    focusable: FocusableColumns
): number {
    const index = preferredColId === undefined ? undefined : snapshot.columnIndexOf(preferredColId);

    return index !== undefined && snapshot.columns[index]?.focusable === true ? index : focusable.first;
}

/** The focusable column index closest to `index`; on a tie the one to the right wins. */
function nearestFocusable(index: number, focusable: FocusableColumns): number {
    let best = focusable.first;
    let bestDistance = Infinity;

    for (const candidate of focusable.indexes) {
        const distance = Math.abs(candidate - index);
        if (distance < bestDistance || (distance === bestDistance && candidate > best)) {
            best = candidate;
            bestDistance = distance;
        }
    }

    return best;
}

function nextFocusable(index: number, focusable: FocusableColumns): number | null {
    return focusable.indexes.find((candidate) => candidate > index) ?? null;
}

function previousFocusable(index: number, focusable: FocusableColumns): number | null {
    return focusable.indexes.findLast((candidate) => candidate < index) ?? null;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}
