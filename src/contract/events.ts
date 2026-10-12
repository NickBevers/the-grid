/**
 * Grid events.
 *
 * Ordering rule: state changes are applied first, then events fire synchronously in the order listed here
 * for one change, then the grid re-renders. A listener always sees the new state through the api.
 * Listeners added or removed during dispatch take effect on the next dispatch. Removing a listener after
 * the grid is destroyed is a no-op.
 */
import type { ColumnGroupState, ColumnState, DisplayedColumn } from './columns';
import type { RowModelStatus } from './data-source';
import type { VisibleRange } from './geometry';
import type { GridRow, RowId } from './rows';
import type { CellPosition, CellRange, FilterModel, QueryState, RowSelection, SortModel } from './state';

export type ChangeSource = 'user' | 'api' | 'state' | 'data';

type CellEvent<TData> = {
    cell: CellPosition;
    row: GridRow<TData>;
    value: unknown;
    /** The originating DOM event, for modifier keys and `isInteractiveTarget` checks. */
    domEvent: MouseEvent | KeyboardEvent | null;
};

type RowEvent<TData> = {
    row: GridRow<TData>;
    domEvent: MouseEvent | KeyboardEvent | null;
    /** True when the event started on an element marked `data-grid-interactive` (buttons, inputs). */
    fromInteractiveTarget: boolean;
};

export type GridEventMap<TData> = {
    /** The grid mounted and its api is usable. Fires once. Replaces `gridReady`. */
    ready: Record<string, never>;
    /** First time rows were painted after data arrived. Replaces `firstDataRendered`. */
    firstRowsRendered: Record<string, never>;

    /**
     * Displayed projection changed (data, sort, filter, group, expand, or a server block arriving). Replaces
     * `modelUpdated` and `rowDataUpdated`. A block load fires `blockLoaded` first, then this.
     */
    rowsChanged: { version: number; source: ChangeSource };
    /** Remote load status changed. Replaces `storeRefreshed` and overlay bookkeeping. */
    statusChanged: { status: RowModelStatus };
    /** A server block finished loading. For map marker sync. */
    blockLoaded: { route: (string | null)[]; startRow: number; endRow: number };
    pinnedRowsChanged: { section: 'top' | 'bottom' };

    queryChanged: { query: QueryState; previous: QueryState; source: ChangeSource };
    sortChanged: { sortModel: SortModel; source: ChangeSource };
    filterChanged: { filterModel: FilterModel; source: ChangeSource };

    /** Any column state change: move, resize, hide, pin, sort, group. Carries the colIds touched. */
    columnStateChanged: {
        columnState: ColumnState[];
        colIds: string[];
        kind: 'moved' | 'resized' | 'visible' | 'pinned' | 'sorted' | 'rowGroup' | 'definitions';
        /** Resize fires with `finished: false` while dragging and once with `true` at the end. */
        finished: boolean;
        source: ChangeSource;
    };
    columnGroupStateChanged: { columnGroupState: ColumnGroupState[]; groupId: string; source: ChangeSource };
    /** Displayed leaf columns changed (visibility, order, pinning). Replaces `displayedColumnsChanged`. */
    displayedColumnsChanged: { columns: DisplayedColumn<TData>[] };

    /** Mounted rows or columns changed after scroll or resize. Replaces `viewportChanged`, `virtualColumnsChanged`. */
    visibleRangeChanged: { range: VisibleRange };
    /** Any scroll of the body. Coordinates are in the one grid scroll space. Replaces `bodyScroll`. */
    scroll: { top: number; left: number; source: ChangeSource };

    selectionChanged: { selection: RowSelection; source: ChangeSource };
    activeRowChanged: { rowId: RowId | null; source: ChangeSource };
    focusChanged: { cell: CellPosition | null; source: ChangeSource };
    rangesChanged: { ranges: CellRange[]; finished: boolean; source: ChangeSource };

    cellClicked: CellEvent<TData>;
    cellDoubleClicked: CellEvent<TData>;
    cellContextMenu: CellEvent<TData>;
    rowClicked: RowEvent<TData>;
    rowDoubleClicked: RowEvent<TData>;

    editStarted: { cell: CellPosition; row: GridRow<TData>; startKey: string | null };
    /** Fires for commit and cancel. `committed` is false for cancel. */
    editStopped: { cell: CellPosition; row: GridRow<TData>; committed: boolean; reason: EditStopReason };
    /** A committed edit changed a value. Fires after `editStopped`. Paste and fill fire one per cell. */
    /** A paste is about to write its cells. */
    pasteStarted: Record<string, never>;
    /** A paste wrote its cells locally (persisting may still be in flight). */
    pasteEnded: { written: number; rejected: number };
    cellValueChanged: {
        cell: CellPosition;
        row: GridRow<TData>;
        oldValue: unknown;
        newValue: unknown;
        source: 'edit' | 'paste' | 'fill' | 'clear' | 'api';
    };
    /**
     * Something a saved view stores changed (filters, sort, search, row groups, column order, visibility,
     * pinning, a finished resize, column group open state): the signal to auto-save the last state.
     */
    viewStateChanged: { reason: 'query' | 'columns'; source: ChangeSource };
    /** A batch of writes finished persisting (see `persist`). */
    writesSettled: import('./writes').WritesSettledEvent;

    pageChanged: { page: number; source: ChangeSource };

    /**
     * A row drag finished. The grid does not reorder rows itself; the consumer updates its data (local
     * `applyTransaction` or new `rows`), which keeps form state the single source of truth.
     */
    /**
     * `rowIds` in display order; `overRowId` and `position` name the row the drop landed on;
     * `targetIndex` is the displayed index, counted before the dragged rows are taken out, where they go.
     * `moveRows` applies this to an array of row data.
     */
    rowDragEnded: { rowIds: RowId[]; targetIndex: number; overRowId: RowId | null; position: 'before' | 'after' };
    rowHeightChanged: { rowId: RowId; height: number };

    destroyed: Record<string, never>;
};

export type EditStopReason = 'enter' | 'tab' | 'escape' | 'blur' | 'api' | 'scrollAway' | 'rowRemoved' | 'refresh';

export type GridEventName = keyof GridEventMap<unknown>;

export type GridEventListener<TData, TName extends GridEventName> = (event: GridEventMap<TData>[TName]) => void;
