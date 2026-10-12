/**
 * Props of the `<Grid>` component.
 *
 * Every piece of state can be uncontrolled (`default*`), or controlled (value plus `on*Change`).
 */
import type { ComponentType, CSSProperties, ReactNode, Ref } from 'react';

import type { GridApi } from './api';
import type { ColumnDef, ColumnDefinition, ColumnGroupState, ColumnState } from './columns';
import type { DataSource } from './data-source';
import type { GridEventMap } from './events';
import type {
    ContextMenuParams,
    FullWidthRowRendererProps,
    GridMenuRenderProps,
    GridPopupRenderProps,
    GridRegistry,
    FilterEditorProps,
    GridColumnChooserRenderProps,
    GridFilterPanelRenderProps,
    GroupCellRendererProps,
    GroupRowRendererProps,
    MenuItem,
} from './renderers';
import type { GridRow, RowId } from './rows';
import type { CellPosition, CellRange, QueryState, RowSelection, RowSelectionMode } from './state';
import type { PropagateWrite, WriteBatch, WriteResult } from './writes';

/**
 * `virtual` renders only rows and columns near the viewport and needs a bounded height.
 * `content` renders every row and sizes to content (compact form and participation grids). It refuses row
 * counts above `contentModeRowLimit` and logs an error, rather than silently becoming slow.
 */
export type LayoutMode = 'virtual' | 'content';

/** A fixed height for every row, 'measure' to size every row to its content, or a per-row choice. */
export type RowHeight<TData> = number | 'measure' | ((row: GridRow<TData>) => number | 'measure');

export type ClipboardHooks<TData> = {
    /** Serializes a range for copy. Default: TSV plus HTML table from formatted values. */
    serialize?: (range: { rowIds: RowId[]; colIds: string[] }) => Promise<{ text: string; html?: string }>;
    /** Applies pasted cells. Return rejected cells to show errors; the grid rolls those cells back. */
    paste?: (
        cells: { cell: CellPosition; text: string }[]
    ) => Promise<{ rejected: { cell: CellPosition; error: string }[] }>;
    /**
     * Permission beyond the column's own `editable`, for edits, paste, fill, clear and `writeCells` (for
     * example locked rows). A cell is writable when the column is editable and this allows it.
     */
    canWrite?: (cell: CellPosition, row: GridRow<TData>) => boolean;
    /** The text a copy puts on the clipboard for a cell. Default: the formatted value. */
    format?: (value: unknown, context: { cell: CellPosition; row: GridRow<TData>; formatted: string }) => string;
    /**
     * Turns pasted text into a cell's value, before the column editor's parser. Return undefined to fall
     * back to it; return an error to reject the cell.
     */
    parse?: (
        text: string,
        context: { cell: CellPosition; row: GridRow<TData> }
    ) => { ok: true; value: unknown } | { ok: false; error: string } | undefined;
};

export type GridProps<TData> = {
    data: DataSource<TData>;
    columns: ColumnDefinition<TData>[];
    /** Defaults merged under every column, before its data type. */
    defaultColumn?: Partial<ColumnDef<TData>>;
    registry?: GridRegistry<TData>;
    apiRef?: Ref<GridApi<TData> | null>;
    layout?: LayoutMode;
    contentModeRowLimit?: number;

    /** Spacing preset. `compact` suits forms; it lowers the default row and header heights and the cell padding tokens. */
    density?: 'comfortable' | 'compact';
    /** Default theme colours. `system` follows the operating system. Default `light`. App themes may ignore it. */
    colorScheme?: 'light' | 'dark' | 'system';
    rowHeight?: RowHeight<TData>;
    headerHeight?: number;
    /** Extra rows and columns mounted beyond the viewport. */
    overscan?: { rows?: number; columns?: number };

    isFullWidthRow?: (row: GridRow<TData>) => boolean;
    fullWidthRowRenderer?: ComponentType<FullWidthRowRendererProps<TData>>;
    /**
     * How groups display. `column`: one group column holds the tree (the default). `fullWidthRow`: each group
     * is a full-width row rendered by `groupRowRenderer`. `custom`: the app renders group rows through
     * `isFullWidthRow` and `fullWidthRowRenderer`.
     */
    groupDisplay?: 'column' | 'fullWidthRow' | 'custom';
    /** The generated group column. */
    groupColumn?: Partial<ColumnDef<TData>> & {
        /** Replaces the whole group cell. */
        renderer?: ComponentType<GroupCellRendererProps<TData>>;
        /** Replaces only the label; the grid keeps its indent, toggle and count. */
        labelRenderer?: ComponentType<GroupCellRendererProps<TData>>;
        /** Shows the child count after the label. Default true. */
        showCount?: boolean;
    };
    groupRowRenderer?: ComponentType<GroupRowRendererProps<TData>>;
    detailRenderer?: ComponentType<FullWidthRowRendererProps<TData>>;
    isRowMaster?: (row: GridRow<TData>) => boolean;

    /** Row click selects (`row` mode, cell focus off) or cells are focusable and rangeable (`cell` mode). */
    interaction?: 'row' | 'cell';
    rowSelection?: RowSelectionMode;
    /** Select rows on pointer clicks in row interaction mode. Default true. */
    enableClickSelection?: boolean;
    /** Shift-click adds a column to the sort order. Default true. */
    enableMultiSort?: boolean;
    /** Space toggles the focused row's selection. Default true; turn it off when the app drives selection keys itself. */
    spaceTogglesSelection?: boolean;
    isRowSelectable?: (row: GridRow<TData>) => boolean;
    enableRanges?: boolean;
    enableFill?: boolean;
    /** Extend the selected range without writing values; the application handles the fill. */
    fillMode?: 'fill' | 'range';
    clipboard?: ClipboardHooks<TData> | false;
    rowDrag?: boolean;
    /** Text shown while dragging rows. */
    rowDragLabel?: (rows: GridRow<TData>[]) => string;
    /** Whether a single click on an editable cell starts editing. Default false (double click, Enter, F2 or typing). */
    editOnClick?: boolean;
    /**
     * Escape in an editor cancels the edit. `stop` (default) keeps the key inside the grid; `propagate` lets
     * it reach the page as well, so an enclosing panel or dialog can close on the same key.
     */
    editorEscape?: 'stop' | 'propagate';
    /** Enter behaviour outside an editor. `edit` starts editing; `moveDown` moves focus. */
    enterKey?: 'edit' | 'moveDown';
    /** Shift-click adds a sort column instead of replacing the sort. Default true. */
    multiSort?: boolean;
    /** Rows pinned above and below the body (totals, summary rows). Not part of displayed indexes. */
    pinnedRows?: { top?: readonly TData[]; bottom?: readonly TData[] };
    /** Cap a pinned bottom section and scroll its rows together, independent of the body. */
    pinnedBottomMaxHeight?: number;
    /**
     * Open group rows stay below the header while their rows scroll beneath them, nested groups stacked,
     * and the next group pushes the stuck one out. Default false.
     */
    stickyGroupRows?: boolean;
    /** Server resource grids page at 100 rows today. `false` scrolls continuously through all blocks. */
    pagination?: { pageSize: number; paginateChildren?: boolean } | false;

    defaultColumnState?: ColumnState[];
    columnState?: ColumnState[];
    onColumnStateChange?: (state: ColumnState[]) => void;
    defaultColumnGroupState?: ColumnGroupState[];
    columnGroupState?: ColumnGroupState[];
    onColumnGroupStateChange?: (state: ColumnGroupState[]) => void;
    defaultQuery?: Partial<QueryState>;
    query?: QueryState;
    onQueryChange?: (query: QueryState) => void;
    defaultSelection?: RowSelection;
    selection?: RowSelection;
    onSelectionChange?: (selection: RowSelection) => void;
    activeRowId?: RowId | null;
    onActiveRowChange?: (rowId: RowId | null) => void;
    ranges?: CellRange[];
    onRangesChange?: (ranges: CellRange[]) => void;

    getContextMenuItems?: (params: ContextMenuParams<TData>) => MenuItem[];
    getHeaderMenuItems?: (params: ContextMenuParams<TData>) => MenuItem[];
    /** Renders the open menu. Default: a native popover list. The app passes its Dropdown family here. */
    renderMenu?: (props: GridMenuRenderProps) => ReactNode;
    /** Renders popup editors at their anchor. Default: a native popover below the cell. */
    renderPopup?: (props: GridPopupRenderProps) => ReactNode;
    /**
     * Persists every write (edits, range edits, paste, fill, clear, `api.writeCells`), applied locally
     * first. Rejected cells roll back and show their error; returned rows replace local rows by id.
     */
    persist?: (batch: WriteBatch<TData>) => Promise<WriteResult<TData> | void>;
    /** An edit inside a range spanning several rows writes the value to every row of the range in that column. */
    rangeEdit?: boolean;
    /** Derives sibling writes from a committed edit (rows sharing a field), applied and persisted with it. */
    propagateWrite?: PropagateWrite<TData>;
    /** Shows a menu button in each header cell that opens the header menu. */
    headerMenuButton?: boolean;
    /**
     * When filterable columns show their filter button: only while a filter is active (default), or always,
     * so the filter panel opens from the header without the menu.
     */
    headerFilterButton?: 'active' | 'always';
    /** Replaces the grid's built-in glyphs. Each defaults to a neutral glyph. */
    icons?: GridIcons;
    /** Renders the column chooser (`api.showColumnChooser`). Default: a popover with a checkbox per column. */
    renderColumnChooser?: (props: GridColumnChooserRenderProps<TData>) => ReactNode;
    /** Renders the filter panel (from the header menu or the filter indicator). Default: a popover. */
    renderFilterPanel?: (props: GridFilterPanelRenderProps<TData>) => ReactNode;
    /** Filter editors per kind, over the built-in ones (text, number, date, set, boolean). */
    filterEditors?: Record<string, ComponentType<FilterEditorProps<TData>>>;
    /** Paste rule: range paste (`range`, default) or row paste (`rows`). */
    pasteStrategy?: 'range' | 'rows';

    /** Semantic classes added to the row part. */
    rowClassName?: (row: GridRow<TData>) => string | string[] | undefined;
    /** Inline styles for the row part (a row's own background, for example). Prefer `rowClassName`. */
    rowStyle?: (row: GridRow<TData>) => CSSProperties | undefined;
    className?: string;

    loadingOverlay?: ReactNode;
    emptyOverlay?: (reason: 'noQuery' | 'noResults') => ReactNode;
    /** What shows when a load fails. `false` shows no overlay, only the failed rows. */
    errorOverlay?: ((error: unknown, retry: () => void) => ReactNode) | false;
    /** Rendered below the body, inside the grid frame (pagination, totals, selection bar). */
    footer?: ReactNode;
    /** Element popups and editors portal into. Default: document.body. */
    popupContainer?: HTMLElement | null;

    context?: unknown;
    /** Event listeners. Same events as `api.on`. */
    on?: { [TName in keyof GridEventMap<TData>]?: (event: GridEventMap<TData>[TName]) => void };
    ariaLabel?: string;
};

/** Icons the grid draws itself. Each is rendered inside its button or indicator part. */
export type GridIcons = {
    sortAscending?: ReactNode;
    sortDescending?: ReactNode;
    /** Group header toggle while the group is open (it collapses on click). */
    columnGroupOpen?: ReactNode;
    /** Group header toggle while the group is closed (it expands on click). */
    columnGroupClosed?: ReactNode;
    headerMenu?: ReactNode;
    headerFilter?: ReactNode;
    /** Group and tree row toggle while the row is open. */
    rowExpanded?: ReactNode;
    /** Group and tree row toggle while the row is closed. */
    rowCollapsed?: ReactNode;
};
