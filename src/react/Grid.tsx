/**
 * The `<Grid>` component: renders the store with both virtualizers in normal document flow and forwards
 * keyboard, pointer and clipboard input to it.
 *
 * Focus stays on the viewport element; the focused cell is marked with `data-focused` and announced with
 * `aria-activedescendant`, so focus never depends on which cells are mounted. Editors take real focus
 * while they are open and hand it back when they close.
 */
import {
    Fragment,
    memo,
    useCallback,
    useEffect,
    useId,
    useImperativeHandle,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
    type ClipboardEvent,
    type DragEvent,
    type FocusEvent,
    type KeyboardEvent,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
    type ReactNode,
} from 'react';

import type {
    AnchorRect,
    FilterCondition,
    RowHeight,
    CellEditorProps,
    ColumnDef,
    CellPosition,
    CellRendererProps,
    DataRow,
    GridApi,
    GridEventMap,
    GridMenuRenderProps,
    GridIcons,
    GridProps,
    GridRow,
    LocalDataSource,
    ResolvedColumn,
    RowWithData,
} from '../contract';
import { hasData } from '../contract';
import { isConditionApplicable, staticSetChoices, type SetChoice, type SetChoicesSource } from '../filters/ui';
import { isStartKey, keyPolicyOf } from '../grid/editing';
import { pointAnchor } from '../grid/menus';
import { FULL_WIDTH_COLUMN, keyToNavigation, type NavigationKey } from '../grid/navigation';
import { stickyGroupRows } from '../grid/stickyRows';
import { GridStore, type GridStoreOptions } from '../grid/store';
import type { LaidOutColumn } from '../virtual/horizontalLayout';
import { HeaderRows, RowCells, rowLineStyle, type CellAttributes } from './ColumnCells';
import { DefaultColumnChooser, DefaultFilterPanel, DefaultMenu, DefaultPopup, TextCellEditor } from './defaults';
import { DefaultFilterEditor } from './FilterEditor';
import { createGridApi } from './gridApi';
import { useGridGeometry } from './useGridGeometry';
import { useHorizontalVirtualizer } from './useHorizontalVirtualizer';
import { useVerticalVirtualizer } from './useVerticalVirtualizer';
import { VirtualRows } from './VirtualRows';

/** Default row and header heights per density. The stylesheet's density tokens match these. */
const DEFAULT_HEIGHTS = { comfortable: { row: 32, header: 32 }, compact: { row: 28, header: 28 } } as const;
const DEFAULT_ROW_HEIGHT = DEFAULT_HEIGHTS.comfortable.row;
/** Distance from a body edge, in pixels, where a drag starts scrolling. */
const AUTOSCROLL_EDGE = 32;
/** Autoscroll speed at the body edge, in pixels per second. Up to three times this past the edge. */
const AUTOSCROLL_SPEED = 700;
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

type DragState = { x: number; y: number; frame: number };

const EMPTY_ROWS: readonly never[] = [];

/**
 * Callbacks and objects whose identity the store compares: kept stable across renders so an inline prop
 * does not rebuild rows or columns on every render.
 */
type StableOptions<TData> = {
    isMaster: ((data: TData) => boolean) | undefined;
    groupColumn: Partial<ColumnDef<TData>> | undefined;
    persist: GridStoreOptions<TData>['persist'];
    propagateWrite: GridStoreOptions<TData>['propagateWrite'];
};

function storeOptions<TData>(
    props: GridProps<TData>,
    quickFilter: string | undefined,
    stable: StableOptions<TData>
): GridStoreOptions<TData> {
    const server = props.data.type === 'server' ? props.data : undefined;
    const data = (server ? { type: 'local', rows: EMPTY_ROWS } : props.data) as LocalDataSource<TData>;
    const clipboard = props.clipboard === false ? undefined : props.clipboard;

    return {
        rows: data.rows,
        ...(server
            ? {
                  serverSource: server,
                  pageSize: props.pagination ? props.pagination.pageSize : null,
                  ...(props.pagination && props.pagination.paginateChildren !== undefined
                      ? { paginateChildren: props.pagination.paginateChildren }
                      : {}),
              }
            : {}),
        ...(props.query || props.defaultQuery ? { initialQuery: props.query ?? props.defaultQuery } : {}),
        ...(data.getRowId ? { getRowId: data.getRowId } : {}),
        ...(data.getDataPath ? { getDataPath: data.getDataPath } : {}),
        ...(data.sortRows ? { sortRows: data.sortRows } : {}),
        ...(data.expandedByDefault !== undefined ? { expandedByDefault: data.expandedByDefault } : {}),
        ...(stable.isMaster ? { isMaster: stable.isMaster } : {}),
        ...(props.groupDisplay ? { groupDisplay: props.groupDisplay } : {}),
        ...(stable.groupColumn ? { groupColumn: stable.groupColumn } : {}),
        columns: props.columns,
        ...(props.registry ? { registry: props.registry } : {}),
        interaction: props.interaction ?? 'cell',
        ...(props.activeRowId !== undefined ? { activeRowControlled: true } : {}),
        rowSelection: props.rowSelection ?? 'none',
        ...(props.isRowSelectable ? { isRowSelectable: props.isRowSelectable } : {}),
        enableRanges: props.enableRanges ?? false,
        enableFill: props.enableFill ?? false,
        ...(props.fillMode ? { fillMode: props.fillMode } : {}),
        ...(props.pasteStrategy ? { pasteStrategy: props.pasteStrategy } : {}),
        ...(clipboard?.canWrite ? { canWrite: clipboard.canWrite } : {}),
        ...(clipboard?.format ? { clipboardFormat: clipboard.format } : {}),
        ...(clipboard?.parse ? { clipboardParse: clipboard.parse } : {}),
        ...(stable.persist ? { persist: stable.persist } : {}),
        ...(props.rangeEdit ? { rangeEdit: true } : {}),
        ...(stable.propagateWrite ? { propagateWrite: stable.propagateWrite } : {}),
        ...(props.isFullWidthRow ? { isFullWidthRow: props.isFullWidthRow } : {}),
        ...(props.getContextMenuItems ? { getContextMenuItems: props.getContextMenuItems } : {}),
        ...(props.getHeaderMenuItems ? { getHeaderMenuItems: props.getHeaderMenuItems } : {}),
        multiSort: props.multiSort ?? true,
        ...((quickFilter ?? data.quickFilter) ? { quickFilter: quickFilter ?? data.quickFilter } : {}),
        mac: IS_MAC,
    };
}

/**
 * Every grid event, forwarded to the `on` prop. A record rather than a list so the type checker fails when an
 * event is added to the contract and not here.
 */
const EVENT_NAMES: Record<keyof GridEventMap<unknown>, true> = {
    ready: true,
    firstRowsRendered: true,
    rowsChanged: true,
    statusChanged: true,
    blockLoaded: true,
    pinnedRowsChanged: true,
    pasteStarted: true,
    pasteEnded: true,
    queryChanged: true,
    sortChanged: true,
    filterChanged: true,
    columnStateChanged: true,
    columnGroupStateChanged: true,
    displayedColumnsChanged: true,
    visibleRangeChanged: true,
    scroll: true,
    selectionChanged: true,
    activeRowChanged: true,
    focusChanged: true,
    rangesChanged: true,
    cellClicked: true,
    cellDoubleClicked: true,
    cellContextMenu: true,
    rowClicked: true,
    rowDoubleClicked: true,
    editStarted: true,
    editStopped: true,
    cellValueChanged: true,
    writesSettled: true,
    viewStateChanged: true,
    pageChanged: true,
    rowDragEnded: true,
    rowHeightChanged: true,
    destroyed: true,
};

/** A DOM id for a cell, unique per grid, for `aria-activedescendant`. */
function cellDomId(gridId: string, cell: CellPosition): string {
    return `${gridId}-${encodeURIComponent(cell.rowId)}-${encodeURIComponent(cell.colId)}`.replace(/[^\w-]/g, '_');
}

function closestCell(target: EventTarget | null): { cell: CellPosition; element: HTMLElement } | null {
    const element = (target as Element | null)?.closest?.<HTMLElement>(
        '[data-grid-part="cell"], [data-grid-part="full-width-row"]'
    );
    const rowElement = element?.closest<HTMLElement>('[data-row-id]');
    // Pinned rows are read only: pointer interaction never reaches them.
    if (!element || !rowElement || rowElement.dataset.rowPinned) {
        return null;
    }
    const colId = element.dataset.gridPart === 'full-width-row' ? FULL_WIDTH_COLUMN : element.dataset.colId;

    return colId ? { cell: { rowId: rowElement.dataset.rowId!, colId }, element } : null;
}

/** Targets inside these keep their own pointer and key handling. */
function isOwnInteractive(target: EventTarget | null): boolean {
    return Boolean(
        (target as Element | null)?.closest?.(
            '[data-grid-editor], [data-grid-part="resize-handle"], [data-grid-part="row-drag-handle"], [data-grid-part="menu"], [data-grid-part="popup"]'
        )
    );
}

/** A single-line text input whose caret Home and End should move. Number inputs have no selection api. */
function isTextInput(target: EventTarget | null): boolean {
    return (
        target instanceof HTMLInputElement &&
        ['text', 'search', 'url', 'tel', 'email', 'password', ''].includes(target.type)
    );
}

/** Clicks on these do not select rows: links, buttons, form controls and anything marked as interactive. */
function isInteractiveRowTarget(target: EventTarget | null): boolean {
    return Boolean(
        (target as Element | null)?.closest?.(
            'a, button, input, select, textarea, label, [contenteditable="true"], [data-suppress-row-select]'
        )
    );
}

/**
 * Renders a row only when something it shows changed: `deps` holds a per-row state signature plus the
 * identities it cannot be reduced to (row object, edit session, column window, props). A range drag or an
 * arrow key then re-renders the few rows involved instead of every mounted cell.
 */
const MemoRow = memo(
    function MemoRow({ render }: { render: () => ReactNode; deps: readonly unknown[] }) {
        return render();
    },
    (previous, next) =>
        previous.deps.length === next.deps.length &&
        previous.deps.every((dep, index) => Object.is(dep, next.deps[index]))
);

export function Grid<TData>(props: GridProps<TData>): ReactNode {
    const gridId = useId().replace(/:/g, '');
    const scrollRef = useRef<HTMLDivElement>(null);
    const [quickFilter, setQuickFilter] = useState<string | undefined>(undefined);
    const propsRef = useRef(props);
    propsRef.current = props;
    const isMaster = useCallback(
        (rowData: TData) =>
            propsRef.current.isRowMaster?.({
                kind: 'data',
                id: '',
                section: 'body',
                level: 0,
                parentId: null,
                data: rowData,
            } as GridRow<TData>) ?? false,
        []
    );
    const groupColumn = useShallowStable(groupColumnDef(props.groupColumn));
    // `persist` reads the latest props, so an inline callback never goes stale. `clipboard.paste` still
    // persists paste, fill and clear when no `persist` is given.
    const persist = useCallback<NonNullable<GridStoreOptions<TData>['persist']>>(async (batch) => {
        const current = propsRef.current;
        if (current.persist) {
            return current.persist(batch);
        }
        const paste = current.clipboard ? current.clipboard.paste : undefined;
        if (paste && batch.source !== 'edit' && batch.source !== 'api') {
            return paste(batch.writes.map(({ cell, text }) => ({ cell, text })));
        }

        return undefined;
    }, []);
    const propagateWrite = useCallback<NonNullable<GridStoreOptions<TData>['propagateWrite']>>(
        (write, context) => propsRef.current.propagateWrite?.(write, context) ?? [],
        []
    );
    const options = storeOptions(props, quickFilter, {
        isMaster: props.isRowMaster ? isMaster : undefined,
        groupColumn,
        persist: props.persist || (props.clipboard && props.clipboard.paste) ? persist : undefined,
        propagateWrite: props.propagateWrite ? propagateWrite : undefined,
    });
    const [store] = useState(() => {
        const created = new GridStore<TData>(options);
        if (props.defaultColumnState) {
            created.applyColumnState(props.defaultColumnState, { applyOrder: true }, 'state');
        }
        if (props.defaultColumnGroupState) {
            created.setColumnGroupState(props.defaultColumnGroupState, 'state');
        }
        if (props.defaultSelection) {
            created.setSelection(props.defaultSelection, 'state');
        }

        return created;
    });
    useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
    const latestProps = useRef(props);
    latestProps.current = props;

    // Options and controlled state flow into the store before paint.
    const optionsKey = useRef(options);
    useLayoutEffect(() => {
        const previous = optionsKey.current;
        optionsKey.current = options;
        const changed = (Object.keys(options) as (keyof GridStoreOptions<TData>)[]).some(
            (key) => options[key] !== previous[key]
        );
        if (changed || Object.keys(options).length !== Object.keys(previous).length) {
            store.setOptions(options);
        }
    });
    // A controlled query: prop changes flow into the store; `onQueryChange` reports the user's changes.
    useLayoutEffect(() => {
        const query = props.query;
        if (!query) {
            return;
        }
        const current = store.query;
        const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
        if (!same(query.sortModel, current.sortModel)) {
            store.setSortModel(query.sortModel, 'state');
        }
        if (!same(query.rowGroupColIds, current.rowGroupColIds)) {
            store.setRowGroupColumns(query.rowGroupColIds, 'state');
        }
        store.setFilterModel(query.filterModel, 'state');
        store.setSearch(query.search, 'state');
        if (!same(query.externalFilters, current.externalFilters)) {
            store.setExternalFilters(query.externalFilters, 'state');
        }
    }, [store, props.query]);
    useLayoutEffect(() => {
        if (props.selection) {
            store.setSelection(props.selection, 'state');
        }
    }, [store, props.selection]);
    useLayoutEffect(() => {
        if (props.activeRowId !== undefined) {
            store.setActiveRow(props.activeRowId, 'state');
        }
    }, [store, props.activeRowId]);
    useLayoutEffect(() => {
        if (props.ranges) {
            store.setRanges(props.ranges, 'state');
        }
    }, [store, props.ranges]);
    useLayoutEffect(() => {
        if (props.columnState) {
            store.applyColumnState(props.columnState, { applyOrder: true }, 'state');
        }
    }, [store, props.columnState]);
    useLayoutEffect(() => {
        if (props.columnGroupState) {
            store.setColumnGroupState(props.columnGroupState, 'state');
        }
    }, [store, props.columnGroupState]);

    // Layout.
    const density = props.density ?? 'comfortable';
    const baseRowHeight = props.rowHeight ?? DEFAULT_HEIGHTS[density].row;
    // Detail rows are measured, never assumed: their content decides their height, and it may change.
    const hasDetail = Boolean(props.isRowMaster);
    const rowHeight = useMemo<RowHeight<TData>>(
        () =>
            hasDetail && typeof baseRowHeight === 'number'
                ? (row: GridRow<TData>) => (row.kind === 'detail' ? 'measure' : baseRowHeight)
                : baseRowHeight,
        [hasDetail, baseRowHeight]
    );
    const headerRowHeight = props.headerHeight ?? DEFAULT_HEIGHTS[density].header;
    const editSession = store.editSession;
    const focused = store.focusedCell;
    const retainedColIds = [focused?.colId, editSession?.cell.colId].filter(
        (colId): colId is string => colId !== undefined && colId !== FULL_WIDTH_COLUMN
    );
    const retainedIds = [focused?.rowId, editSession?.cell.rowId].filter(
        (rowId): rowId is string => rowId !== undefined
    );
    const columnsVersion = store.columnsVersion;
    const specs = useMemo(() => store.columns.getColumnSpecs(), [store, columnsVersion]);
    const horizontal = useHorizontalVirtualizer({
        scrollRef,
        columns: specs,
        columnsVersion,
        retainedColIds,
        ...(props.overscan?.columns !== undefined ? { overscan: props.overscan.columns } : {}),
    });
    const pinnedBottomRef = useRef<HTMLDivElement>(null);
    const pinnedRowHeight = typeof baseRowHeight === 'number' ? baseRowHeight : DEFAULT_ROW_HEIGHT;
    const pinnedTop = store.getPinnedRows('top');
    const pinnedBottom = store.getPinnedRows('bottom');
    const pinnedHeight = (row: GridRow<TData>): number => {
        const height = typeof baseRowHeight === 'function' ? baseRowHeight(row) : baseRowHeight;
        return typeof height === 'number' ? height : pinnedRowHeight;
    };
    const pinnedBottomTotalHeight = pinnedBottom.reduce((sum, row) => sum + pinnedHeight(row), 0);
    const hasPinnedBottom = pinnedBottom.length > 0;
    useLayoutEffect(() => {
        if (pinnedBottomRef.current && props.pinnedBottomMaxHeight !== undefined) {
            pinnedBottomRef.current.scrollLeft = scrollRef.current?.scrollLeft ?? 0;
        }
    });
    useEffect(() => {
        const section = pinnedBottomRef.current;
        if (!section || props.pinnedBottomMaxHeight === undefined) {
            return;
        }
        const wheel = (event: WheelEvent) => {
            const horizontalDelta = event.deltaX || (event.shiftKey ? event.deltaY : 0);
            if (horizontalDelta !== 0) {
                event.preventDefault();
                const scroller = scrollRef.current;
                if (scroller) {
                    scroller.scrollLeft += horizontalDelta;
                    section.scrollLeft = scroller.scrollLeft;
                }
            }
            event.stopPropagation();
        };
        section.addEventListener('wheel', wheel, { passive: false });
        return () => section.removeEventListener('wheel', wheel);
    }, [hasPinnedBottom, props.pinnedBottomMaxHeight]);
    const pinnedBottomHeight = Math.min(
        pinnedBottomTotalHeight,
        props.pinnedBottomMaxHeight ?? Number.POSITIVE_INFINITY
    );
    // Pinned top rows sit in the sticky header block, so they count as header for the row window and for
    // scrolling a cell into view.
    const headerHeight =
        (horizontal.layout.groupDepth + 1) * headerRowHeight +
        pinnedTop.reduce((sum, row) => sum + pinnedHeight(row), 0);
    const rowsVersion = store.rowsVersion;
    // A new row source object whenever the displayed rows change; rowsVersion changes with it.
    const source = store.rowSource;
    const vertical = useVerticalVirtualizer<TData>({
        scrollRef,
        source,
        sourceVersion: rowsVersion,
        estimatedRowHeight: typeof baseRowHeight === 'number' ? baseRowHeight : DEFAULT_ROW_HEIGHT,
        rowHeight,
        insetTop: headerHeight,
        insetBottom: pinnedBottomHeight,
        retainedIds,
        ...(props.overscan?.rows !== undefined ? { overscan: props.overscan.rows } : {}),
    });
    const stickyRowsAt = (scrollTop: number) =>
        stickyGroupRows({
            scrollTop,
            count: source.count,
            rowAt: (index) => source.rowAt(index),
            indexOf: (id) => source.indexOf(id),
            indexAtOffset: (offset) => vertical.layout.getIndexAtOffset(offset),
            rowBounds: (index) => vertical.layout.getRowBounds(index),
        });
    const { geometry } = useGridGeometry<TData>({
        scrollRef,
        vertical,
        horizontal,
        source,
        headerHeight: (horizontal.layout.groupDepth + 1) * headerRowHeight,
        pinnedTop: pinnedTop.map((row) => ({ id: row.id, height: pinnedHeight(row) })),
        pinnedBottom: pinnedBottom.map((row) => ({ id: row.id, height: pinnedHeight(row) })),
        pinnedBottomHeight,
        pinnedBottomScrollTop: () => pinnedBottomRef.current?.scrollTop ?? 0,
        events: store.events,
        isFullWidth: (rowId) => {
            const row = store.getRow(rowId);

            return row ? store.isFullWidth(row) : false;
        },
        ...(props.stickyGroupRows ? { stickyRowsAt } : {}),
    });
    const stuckRows = props.stickyGroupRows ? stickyRowsAt(vertical.layout.getVirtualScrollTop()) : [];
    const stuckIds = new Set(stuckRows.map((row) => row.id));
    const viewportHeight = scrollRef.current?.clientHeight ?? 0;
    store.setPageSize(
        Math.max(
            1,
            Math.floor(
                (viewportHeight - headerHeight) /
                    (typeof baseRowHeight === 'number' ? baseRowHeight : DEFAULT_ROW_HEIGHT)
            ) - 1
        )
    );

    // Api.
    // Set after the layout exists; the api calls through these so it can be created first.
    const autoSizeRef = useRef<(colIds?: string[]) => void>(() => undefined);
    const showChooserRef = useRef<(anchor?: AnchorRect) => void>(() => undefined);
    const api = useMemo<GridApi<TData>>(
        () =>
            createGridApi<TData>({
                store,
                geometry,
                dataSource: () => latestProps.current.data,
                setQuickFilter: (text) => setQuickFilter(text),
                getLaidOutColumn: (colId) => horizontal.layout.getColumn(colId),
                autoSizeColumns: (colIds) => autoSizeRef.current(colIds),
                showColumnChooser: (anchor) => showChooserRef.current(anchor),
                whenSettled: () =>
                    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
            }),
        // The layout object is stable for the grid's life.
        [store, geometry, horizontal.layout]
    );
    useImperativeHandle(props.apiRef, () => api, [api]);

    // Pinned rows from props. Each section is set only when its array changes.
    const pinnedTopProp = props.pinnedRows?.top;
    const pinnedBottomProp = props.pinnedRows?.bottom;
    useEffect(() => {
        if ((pinnedTopProp?.length ?? 0) > 0 || store.getPinnedRows('top').length > 0) {
            store.setPinnedRows('top', pinnedTopProp ?? []);
        }
    }, [store, pinnedTopProp]);
    useEffect(() => {
        if ((pinnedBottomProp?.length ?? 0) > 0 || store.getPinnedRows('bottom').length > 0) {
            store.setPinnedRows('bottom', pinnedBottomProp ?? []);
        }
    }, [store, pinnedBottomProp]);

    // Events to callbacks.
    const readyEmitted = useRef(false);
    useEffect(() => {
        const call = <TName extends keyof GridEventMap<TData>>(name: TName, event: GridEventMap<TData>[TName]) => {
            const listener = latestProps.current.on?.[name] as
                | ((event: GridEventMap<TData>[TName]) => void)
                | undefined;
            listener?.(event);
        };
        const names = Object.keys(EVENT_NAMES) as (keyof GridEventMap<TData>)[];
        const offs = names.map((name) => store.events.on(name, (event) => call(name, event as never)));
        offs.push(
            store.events.on(
                'selectionChanged',
                (event) => event.source !== 'state' && latestProps.current.onSelectionChange?.(event.selection)
            ),
            store.events.on(
                'activeRowChanged',
                (event) => event.source !== 'state' && latestProps.current.onActiveRowChange?.(event.rowId)
            ),
            store.events.on(
                'rangesChanged',
                (event) =>
                    event.finished && event.source !== 'state' && latestProps.current.onRangesChange?.(event.ranges)
            ),
            store.events.on(
                'columnStateChanged',
                (event) =>
                    event.finished &&
                    event.source !== 'state' &&
                    latestProps.current.onColumnStateChange?.(event.columnState)
            ),
            store.events.on(
                'columnGroupStateChanged',
                (event) =>
                    event.source !== 'state' && latestProps.current.onColumnGroupStateChange?.(event.columnGroupState)
            ),
            store.events.on(
                'queryChanged',
                (event) => event.source !== 'state' && latestProps.current.onQueryChange?.(event.query)
            )
        );
        // Once per grid, also when StrictMode runs effects twice.
        if (!readyEmitted.current) {
            readyEmitted.current = true;
            store.events.emit('ready', {});
        }

        return () => offs.forEach((off) => off());
    }, [store]);
    useEffect(() => () => store.destroy(), [store]);

    // firstRowsRendered: once, after the first commit that shows rows (listeners are wired above).
    const firstRowsEmitted = useRef(false);
    useEffect(() => {
        if (!firstRowsEmitted.current && (store.rowModel.getRowCount() ?? 0) > 0) {
            firstRowsEmitted.current = true;
            store.events.emit('firstRowsRendered', {});
        }
    });

    // The store records every resize in the column state, so the layout's own memory of resized widths is
    // only needed during a drag. Any other column state change (an applied view, a reset) takes over.
    useEffect(
        () =>
            store.events.on('columnStateChanged', (event) => {
                if (event.kind !== 'resized') {
                    horizontal.layout.resetWidths();
                }
            }),
        [store, horizontal.layout]
    );

    // Server rows: ask the model for the blocks the viewport mounts (the main run; a retained focused or
    // editing row far away stays loaded on its own). Runs after every render; the model skips loaded blocks.
    useEffect(() => {
        const { runs, firstVisible } = vertical.window;
        const run =
            runs.find((candidate) => candidate.start <= firstVisible && candidate.end >= firstVisible) ?? runs[0];
        if (run) {
            store.rowModel.ensureRange(run.start, run.end);
        }
    });

    // A new page starts at the top, and so does a new server query (sort, filter, search, grouping): the rows
    // under the old scroll position are unrelated to the new result.
    useEffect(() => {
        const offPage = store.events.on('pageChanged', () => geometry.setScroll({ top: 0 }));
        const offQuery = store.events.on('rowsChanged', (event) => {
            if (event.source === 'state' && store.rowModel.kind === 'server') {
                geometry.setScroll({ top: 0 });
            }
        });

        return () => {
            offPage();
            offQuery();
        };
    }, [store, geometry]);

    // Keyboard.
    // The grid returning focus to itself (after a menu, panel or edit) never focuses a cell on its own; only
    // a user tabbing in does.
    const restoringFocus = useRef(false);
    const focusViewport = () => {
        restoringFocus.current = true;
        scrollRef.current?.focus({ preventScroll: true });
        restoringFocus.current = false;
    };
    const reveal = (cell: CellPosition | null) => {
        if (!cell) {
            return;
        }
        if (cell.colId === FULL_WIDTH_COLUMN) {
            const index = store.rowModel.getIndexOf(cell.rowId);
            if (index !== undefined) {
                geometry.ensureIndexVisible(index);
            }

            return;
        }
        geometry.ensureCellVisible(cell);
    };
    const navigate = (key: NavigationKey, extend: boolean): CellPosition | null => {
        const next = store.navigate(key, { extend });
        if (extend) {
            const range = store.ranges[store.ranges.length - 1];
            reveal(range?.end ?? null);
        } else {
            reveal(next);
        }

        return next;
    };
    const editCell = (cell: CellPosition, startKey: string | null = null) => {
        reveal(cell);
        void store.startEditing(cell, { startKey });
    };

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (isOwnInteractive(event.target) || event.nativeEvent.isComposing) {
            return;
        }
        const props = latestProps.current;
        const cell = store.focusedCell;
        const modifier = event.ctrlKey || event.metaKey;
        const navigation = keyToNavigation(event);
        if (navigation) {
            const next = navigate(navigation, false);
            if (next !== null || (navigation !== 'next' && navigation !== 'previous')) {
                event.preventDefault();
            }

            return;
        }
        if (event.shiftKey && !event.altKey && props.enableRanges) {
            const extendKey = keyToNavigation({ ...event, key: event.key, shiftKey: false });
            if (extendKey && extendKey !== 'next' && extendKey !== 'previous') {
                event.preventDefault();
                navigate(extendKey, true);

                return;
            }
        }
        if (!cell) {
            return;
        }
        switch (event.key) {
            case 'Enter':
                event.preventDefault();
                if (props.enterKey === 'moveDown') {
                    navigate(event.shiftKey ? 'up' : 'down', false);
                } else if (cell.colId === FULL_WIDTH_COLUMN || cell.colId === store.groupColumnId) {
                    // Enter on a group row, or on the group column, opens or closes the row.
                    const row = store.getRow(cell.rowId);
                    if (row && (row.kind === 'group' || (row.kind === 'data' && row.expandable))) {
                        store.setExpanded(row.id, !store.rowModel.isExpanded(row.id));
                    }
                } else {
                    editCell(cell);
                }

                return;
            case 'F2':
                event.preventDefault();
                editCell(cell);

                return;
            case 'Escape':
                if (store.ranges.length > 0) {
                    event.preventDefault();
                    store.setRanges([], 'user');
                }

                return;
            case 'Delete':
            case 'Backspace':
                if (props.clipboard !== false && cell.colId !== FULL_WIDTH_COLUMN) {
                    event.preventDefault();
                    void store.clear();
                }

                return;
            case 'ContextMenu':
            case 'F10':
                if (event.key === 'ContextMenu' || event.shiftKey) {
                    event.preventDefault();
                    const anchor = geometry.getCellAnchor(cell) ?? pointAnchor(0, 0);
                    store.openMenu('context', { rowId: cell.rowId, colId: cell.colId }, anchor, api, 'keyboard');
                }

                return;
        }
        if (modifier && event.key.toLowerCase() === 'a' && props.enableRanges) {
            event.preventDefault();
            store.selectAllCells();

            return;
        }
        if (
            event.key === ' ' &&
            props.rowSelection &&
            props.rowSelection !== 'none' &&
            props.spaceTogglesSelection !== false
        ) {
            event.preventDefault();
            store.setSelected([cell.rowId], !store.isRowSelected(cell.rowId));

            return;
        }
        if (isStartKey(event) && store.editing.canEdit(cell)) {
            event.preventDefault();
            editCell(cell, event.key);
        }
    };

    const onFocus = (event: FocusEvent<HTMLDivElement>) => {
        if (
            event.target === event.currentTarget &&
            !pointerFocus.current &&
            !restoringFocus.current &&
            !store.focusedCell &&
            props.interaction !== 'row'
        ) {
            navigate('next', false);
        }
    };

    // Clipboard.
    const onCopy = (event: ClipboardEvent<HTMLDivElement>) => {
        if (isOwnInteractive(event.target) || props.clipboard === false) {
            return;
        }
        const copied = store.copy();
        if (copied) {
            event.preventDefault();
            event.clipboardData.setData('text/plain', copied.text);
            if (copied.html) {
                event.clipboardData.setData('text/html', copied.html);
            }
        }
    };
    const onCut = (event: ClipboardEvent<HTMLDivElement>) => {
        if (isOwnInteractive(event.target) || props.clipboard === false) {
            return;
        }
        const copied = store.cut();
        if (copied) {
            event.preventDefault();
            event.clipboardData.setData('text/plain', copied.text);
            if (copied.html) {
                event.clipboardData.setData('text/html', copied.html);
            }
        }
    };
    const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
        if (isOwnInteractive(event.target) || props.clipboard === false) {
            return;
        }
        event.preventDefault();
        void store.paste(event.clipboardData.getData('text/plain'));
    };

    // Row drag (native drag and drop: the browser draws the drag image).
    const onRowDragOver = (event: DragEvent<HTMLDivElement>) => {
        if (!store.rowDrag) {
            return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const rowElement = (event.target as Element).closest?.<HTMLElement>('[data-grid-part="row"]');
        if (rowElement?.dataset.rowId) {
            const box = rowElement.getBoundingClientRect();
            store.rowDragOver(rowElement.dataset.rowId, event.clientY < box.top + box.height / 2 ? 'before' : 'after');
        }
        // Drag over fires repeatedly while the pointer rests, so a step per event autoscrolls near the edges.
        const proximity = geometry.edgeProximity(event.clientX, event.clientY);
        if (proximity.top < AUTOSCROLL_EDGE) {
            geometry.scrollBy({ top: -(AUTOSCROLL_EDGE - Math.max(0, proximity.top)) });
        } else if (proximity.bottom < AUTOSCROLL_EDGE) {
            geometry.scrollBy({ top: AUTOSCROLL_EDGE - Math.max(0, proximity.bottom) });
        }
    };

    // Pointer.
    const pointerFocus = useRef(false);
    const drag = useRef<DragState | null>(null);
    const startDragTracking = (x: number, y: number, horizontalScroll = true) => {
        const state: DragState = { x, y, frame: 0 };
        drag.current = state;
        /**
         * Hit tests the pointer clamped into the body, so the range keeps following while the pointer is
         * outside the grid (over the header, the footer or past an edge) and autoscroll runs.
         */
        const hitClamped = () => {
            const element = scrollRef.current;
            if (!element) {
                return;
            }
            const box = element.getBoundingClientRect();
            const clampedX = Math.min(Math.max(state.x, box.left + 1), box.left + element.clientWidth - 2);
            const clampedY = Math.min(
                Math.max(state.y, box.top + headerHeight + 1),
                box.top + element.clientHeight - 2
            );
            const hit = geometry.hitTest(clampedX, clampedY);
            if (hit.area === 'cell') {
                store.dragOverCell(hit.cell);
            }
        };
        const onMove = (event: PointerEvent) => {
            state.x = event.clientX;
            state.y = event.clientY;
            hitClamped();
        };
        let last = performance.now();
        const tick = (now: number) => {
            if (drag.current !== state) {
                return;
            }
            // Speed in pixels per second, so it is the same at 60 and 120 Hz: up to AUTOSCROLL_SPEED at the edge,
            // faster the further the pointer goes past it.
            const seconds = Math.min(0.05, Math.max(0, (now - last) / 1000));
            last = now;
            const proximity = geometry.edgeProximity(state.x, state.y);
            const speed = (distance: number) =>
                distance < AUTOSCROLL_EDGE
                    ? Math.min(3, (AUTOSCROLL_EDGE - distance) / AUTOSCROLL_EDGE) * AUTOSCROLL_SPEED * seconds
                    : 0;
            const top = speed(proximity.bottom) - speed(proximity.top);
            const left = horizontalScroll ? speed(proximity.right) - speed(proximity.left) : 0;
            if (Math.abs(top) >= 0.5 || Math.abs(left) >= 0.5) {
                geometry.scrollBy({ top: Math.round(top), left: Math.round(left) });
                hitClamped();
            }
            state.frame = requestAnimationFrame(tick);
        };
        const onUp = () => {
            cancelAnimationFrame(state.frame);
            drag.current = null;
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.removeEventListener('pointercancel', onUp);
            store.pointerUp();
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onUp);
        state.frame = requestAnimationFrame(tick);
    };

    const onPointerDownCapture = () => {
        // Any press (header, empty space, a cell) focuses the viewport through the browser's own default
        // action, after this handler. That focus is a pointer focus, not keyboard entry, so it must not
        // focus the first cell; the flag clears once the browser has applied it.
        pointerFocus.current = true;
        window.setTimeout(() => {
            pointerFocus.current = false;
        }, 0);
    };

    const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || isOwnInteractive(event.target)) {
            return;
        }
        const target = event.target as Element;
        if (target.closest('[data-grid-part="fill-handle"]')) {
            event.preventDefault();
            focusViewport();
            store.startFill();
            // Fill extends rows only; the corner handle must not scroll its own column out of view.
            startDragTracking(event.clientX, event.clientY, false);

            return;
        }
        const hit = closestCell(event.target);
        if (!hit) {
            return;
        }
        if (!isInteractiveRowTarget(event.target)) {
            focusViewport();
        }
        if (props.interaction === 'row') {
            store.focusCell(hit.cell);

            return;
        }
        if (props.enableRanges && !isInteractiveRowTarget(event.target)) {
            // A press on a cell starts a range, not a text selection. Controls inside cells keep their own
            // behaviour. Focus was moved to the viewport above, since a prevented press does not move it.
            event.preventDefault();
        }
        store.pointerDownCell(hit.cell, { shift: event.shiftKey, toggle: event.ctrlKey || event.metaKey });
        if (props.enableRanges && hit.cell.colId !== FULL_WIDTH_COLUMN) {
            startDragTracking(event.clientX, event.clientY);
        }
    };

    /** The contract's cell and row event payloads for a pointer event on a cell. */
    const pointerEvents = (hit: { cell: CellPosition }, event: ReactMouseEvent) => {
        const row = store.getRow(hit.cell.rowId)!;
        const column = hit.cell.colId === FULL_WIDTH_COLUMN ? undefined : store.columns.getResolved(hit.cell.colId);
        const value = column && hasData(row) ? column.getValue(row) : undefined;

        return {
            cell: { cell: hit.cell, row, value, domEvent: event.nativeEvent },
            row: { row, domEvent: event.nativeEvent, fromInteractiveTarget: isInteractiveRowTarget(event.target) },
        };
    };
    const onClick = (event: ReactMouseEvent<HTMLDivElement>) => {
        if (isOwnInteractive(event.target)) {
            return;
        }
        const hit = closestCell(event.target);
        if (!hit || !store.getRow(hit.cell.rowId)) {
            return;
        }
        const payloads = pointerEvents(hit, event);
        store.events.emit('cellClicked', payloads.cell);
        store.events.emit('rowClicked', payloads.row);
        const selectionMode = props.rowSelection ?? 'none';
        if (
            selectionMode !== 'none' &&
            props.enableClickSelection !== false &&
            props.interaction === 'row' &&
            !isInteractiveRowTarget(event.target)
        ) {
            store.clickRow(hit.cell.rowId, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey });
        } else if (props.interaction === 'row') {
            store.setActiveRow(hit.cell.rowId, 'user');
        }
        if (props.editOnClick && hit.cell.colId !== FULL_WIDTH_COLUMN && store.editing.canEdit(hit.cell)) {
            editCell(hit.cell);
        }
    };
    const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
        if (isOwnInteractive(event.target)) {
            return;
        }
        const hit = closestCell(event.target);
        if (!hit || !store.getRow(hit.cell.rowId)) {
            return;
        }
        const payloads = pointerEvents(hit, event);
        store.events.emit('cellDoubleClicked', payloads.cell);
        store.events.emit('rowDoubleClicked', payloads.row);
        if (hit.cell.colId !== FULL_WIDTH_COLUMN && store.editing.canEdit(hit.cell)) {
            editCell(hit.cell);
        }
    };
    const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
        if (isOwnInteractive(event.target)) {
            return;
        }
        const anchor = pointAnchor(event.clientX, event.clientY);
        const header = (event.target as Element).closest<HTMLElement>('[data-grid-part="header-cell"]');
        if (header) {
            if (store.openMenu('header', { rowId: null, colId: header.dataset.colId ?? null }, anchor, api)) {
                event.preventDefault();
            }

            return;
        }
        const hit = closestCell(event.target);
        if (!hit) {
            return;
        }
        focusViewport();
        store.events.emit('cellContextMenu', pointerEvents(hit, event).cell);
        if (store.openMenu('context', { rowId: hit.cell.rowId, colId: hit.cell.colId }, anchor, api)) {
            event.preventDefault();
        }
    };

    // Autosize: header label and mounted cells, measured from the DOM.
    autoSizeRef.current = (colIds) => {
        const root = scrollRef.current;
        if (!root) {
            return;
        }
        const ids = colIds ?? store.snapshot.columns.map((column) => column.colId);
        for (const colId of ids) {
            const resolved = store.columns.getResolved(colId);
            if (!resolved || resolved.def.resizable === false) {
                continue;
            }
            const escaped = CSS.escape(colId);
            let width = 0;
            const header = root.querySelector<HTMLElement>(
                `[data-grid-part="header-cell"][data-col-id="${escaped}"] [data-grid-part="header-content"]`
            );
            if (header) {
                width = header.scrollWidth + 2;
            }
            for (const cell of root.querySelectorAll<HTMLElement>(
                `[data-grid-part="body"] [data-grid-part="cell"][data-col-id="${escaped}"]`
            )) {
                const style = getComputedStyle(cell);
                const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
                const content = cell.firstElementChild as HTMLElement | null;
                width = Math.max(width, (content ? content.scrollWidth : cell.scrollWidth) + padding + 2);
            }
            if (width > 0) {
                store.resizeColumn(colId, horizontal.resize(colId, Math.ceil(width)), true);
            }
        }
    };

    // Column chooser.
    const [chooserAnchor, setChooserAnchor] = useState<AnchorRect | null>(null);
    showChooserRef.current = (anchor) => {
        if (anchor) {
            setChooserAnchor(anchor);

            return;
        }
        const header = scrollRef.current?.querySelector<HTMLElement>('[data-grid-part="header"]');
        const rect = header?.getBoundingClientRect();
        setChooserAnchor(
            rect
                ? { top: rect.top, left: rect.left, width: 0, height: rect.height, visible: true }
                : { top: 0, left: 0, width: 0, height: 0, visible: false }
        );
    };
    const closeChooser = () => {
        setChooserAnchor(null);
        focusViewport();
    };
    const columnChooser = chooserAnchor
        ? (() => {
              const state = new Map(store.columns.getColumnState().map((entry) => [entry.colId, entry]));
              const chooserProps = {
                  anchor: chooserAnchor,
                  columns: store.columns
                      .getAllLeaves()
                      .slice()
                      .sort((a, b) => a.definitionIndex - b.definitionIndex)
                      .map((leaf) => ({
                          colId: leaf.colId,
                          label: store.columns.getResolved(leaf.colId)?.headerName ?? leaf.colId,
                          visible: !state.get(leaf.colId)?.hide,
                          locked: Boolean(leaf.def.lockVisible),
                      })),
                  setVisible: (colId: string, visible: boolean) => store.setColumnsVisible([colId], visible, 'user'),
                  onClose: closeChooser,
                  api,
              };

              return props.renderColumnChooser ? (
                  props.renderColumnChooser(chooserProps)
              ) : (
                  <DefaultColumnChooser {...chooserProps} />
              );
          })()
        : null;

    // Menus.
    /** Opens the filter panel below a column's header cell. */
    const openFilterPanel = (colId: string) => {
        const header = scrollRef.current?.querySelector<HTMLElement>(
            `[data-grid-part="header-cell"][data-col-id="${CSS.escape(colId)}"]`
        );
        const rect = header?.getBoundingClientRect();
        store.openFilterPanel(
            colId,
            rect
                ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height, visible: true }
                : { top: 0, left: 0, width: 0, height: 0, visible: false }
        );
    };
    const runMenuItem: GridMenuRenderProps['onSelect'] = (item) => {
        const headerColId = store.menu?.kind === 'header' ? store.menu.target.colId : null;
        store.closeMenu();
        focusViewport();
        if (item.builtin === 'copy' || item.builtin === 'copyWithHeaders' || item.builtin === 'cut') {
            const copied =
                item.builtin === 'cut'
                    ? store.cut()
                    : store.copy({ includeHeaders: item.builtin === 'copyWithHeaders' });
            if (copied) {
                void writeClipboard(copied);
            }
        } else if (item.builtin === 'paste') {
            void navigator.clipboard?.readText().then((text) => store.paste(text));
        } else if (headerColId && (item.builtin === 'sortAscending' || item.builtin === 'sortDescending')) {
            store.setSortModel(
                [{ colId: headerColId, sort: item.builtin === 'sortAscending' ? 'asc' : 'desc' }],
                'user'
            );
        } else if (headerColId && item.builtin === 'clearSort') {
            store.setSortModel(
                store.columns.getSortModel().filter((entry) => entry.colId !== headerColId),
                'user'
            );
        } else if (headerColId && item.builtin === 'filter') {
            openFilterPanel(headerColId);
        } else if (headerColId && item.builtin === 'clearFilter') {
            api.setColumnFilter(headerColId, null);
        } else {
            item.onSelect?.();
        }
    };
    const panelState = store.filterPanel;
    const panelColumn = panelState ? store.columns.getResolved(panelState.colId) : undefined;
    const panelKind = panelState ? store.filterKindOf(panelState.colId) : null;
    const closeFilterPanel = () => {
        store.closeFilterPanel();
        focusViewport();
    };
    const filterPanel =
        panelState && panelColumn && panelKind ? (
            <FilterPanelHost
                key={panelState.colId}
                store={store}
                api={api}
                colId={panelState.colId}
                kind={panelKind}
                anchor={panelState.anchor}
                column={panelColumn}
                editors={props.filterEditors}
                render={props.renderFilterPanel}
                onClose={closeFilterPanel}
            />
        ) : null;
    const menu = store.menu;
    const menuProps: GridMenuRenderProps | null = menu
        ? {
              kind: menu.kind,
              anchor: menu.anchor,
              items: menu.items,
              trigger: menu.trigger,
              onSelect: runMenuItem,
              onClose: () => {
                  store.closeMenu();
                  focusViewport();
              },
          }
        : null;

    // Rendering.
    const selectionMode = props.rowSelection ?? 'none';
    const fillTarget = store.fillTarget;
    const lastRange = store.resolvedRanges[store.resolvedRanges.length - 1];
    const fillCorner =
        props.enableFill && lastRange && store.resolvedRanges.length === 1 && !store.isDragging
            ? {
                  rowId: lastRange.rowIds[lastRange.rowIds.length - 1],
                  colId: lastRange.colIds[lastRange.colIds.length - 1],
              }
            : null;

    const rectangles = store.rangeRectangles;
    const hasErrors = store.cellErrorsVersion > 0;
    /** Range membership and edges of one cell, from the rectangles computed once per render. */
    const rangeEdgesAt = (rowIndex: number, columnIndex: number | undefined) => {
        if (columnIndex === undefined || rectangles.length === 0) {
            return null;
        }
        let count = 0;
        let top = false;
        let bottom = false;
        let left = false;
        let right = false;
        for (const rectangle of rectangles) {
            if (
                rowIndex < rectangle.top ||
                rowIndex > rectangle.bottom ||
                columnIndex < rectangle.left ||
                columnIndex > rectangle.right
            ) {
                continue;
            }
            count++;
            top ||= rowIndex === rectangle.top;
            bottom ||= rowIndex === rectangle.bottom;
            left ||= columnIndex === rectangle.left;
            right ||= columnIndex === rectangle.right;
        }

        return count === 0 ? null : { count, top, bottom, left, right };
    };
    /** What a row shows of the ranges: each rectangle crossing it, as a short string. */
    const rangeSignature = (rowIndex: number) =>
        rectangles
            .filter((rectangle) => rowIndex >= rectangle.top && rowIndex <= rectangle.bottom)
            .map(
                (rectangle) =>
                    `${rectangle.left}-${rectangle.right}${rowIndex === rectangle.top ? 't' : ''}${rowIndex === rectangle.bottom ? 'b' : ''}`
            )
            .join(',');

    /**
     * Which of a cell's own lines (right, bottom) a higher state draws: focus, an invalid value, or a range
     * edge. A hover ring next to such a cell must leave that line alone.
     */
    const strongLinesAt = (rowIndex: number, columnIndex: number): { right: boolean; bottom: boolean } | null => {
        const rowAt = store.rowModel.getRowAtIndex(rowIndex)?.row;
        const colId = store.snapshot.columns[columnIndex]?.colId;
        if (!rowAt || colId === undefined) {
            return null;
        }
        if (
            (focused?.rowId === rowAt.id && focused.colId === colId) ||
            (hasErrors && store.cellError({ rowId: rowAt.id, colId }) !== undefined)
        ) {
            return { right: true, bottom: true };
        }
        const edges = rangeEdgesAt(rowIndex, columnIndex);

        return edges && (edges.right || edges.bottom) ? { right: edges.right, bottom: edges.bottom } : null;
    };

    /**
     * Hover guards: a hover ring reaches over the top and left grid lines, which belong to the neighbours.
     * Where a neighbour draws that line in a higher state (focus, invalid, range edge, the end of a selected
     * row run), the hover leaves it, so focus and selection always stay on top.
     */
    const hoverGuards = (row: GridRow<TData>, rowIndex: number, columnIndex: number) => {
        const above = rowIndex > 0 ? strongLinesAt(rowIndex - 1, columnIndex) : null;
        const left = columnIndex > 0 ? strongLinesAt(rowIndex, columnIndex - 1) : null;
        const diagonal = rowIndex > 0 && columnIndex > 0 ? strongLinesAt(rowIndex - 1, columnIndex - 1) : null;
        const rowAbove = rowIndex > 0 ? store.rowModel.getRowAtIndex(rowIndex - 1)?.row : undefined;
        const highlighted = (candidate: GridRow<TData> | undefined) =>
            candidate !== undefined && (store.isRowSelected(candidate.id) || store.activeRowId === candidate.id);
        const top = Boolean(above?.bottom) || (highlighted(rowAbove) && !highlighted(row));
        const leftGuard = Boolean(left?.right);
        const corner = top || leftGuard || Boolean(diagonal) || Boolean(above) || Boolean(left);

        return { top, left: leftGuard, corner };
    };

    const resolvedEditable = (row: GridRow<TData>, colId: string) => {
        const resolved = store.columns.getResolved(colId);

        return resolved?.setValue && resolved.isEditable(row);
    };

    const hasPending = store.pendingVersion > 0;
    const cellAttributes = (row: GridRow<TData>, rowIndex: number, column: LaidOutColumn): CellAttributes => {
        const cell = { rowId: row.id, colId: column.colId };
        const isFocused = focused?.rowId === row.id && focused.colId === column.colId;
        const columnIndex = store.snapshot.columnIndexOf(column.colId);
        const edges = rangeEdgesAt(rowIndex, columnIndex);
        const editable = Boolean(resolvedEditable(row, column.colId));
        const guards =
            editable && !isFocused && !edges && columnIndex !== undefined
                ? hoverGuards(row, rowIndex, columnIndex)
                : null;
        const resolved = store.columns.getResolved(column.colId);
        const classes = resolved && hasData(row) ? resolved.cellClasses(row, resolved.getValue(row)) : [];
        const error = hasErrors ? store.cellError(cell) : undefined;
        const inFill = fillTarget && fillTarget.colIds.includes(column.colId) && fillTarget.rowIds.includes(row.id);

        return {
            'id': cellDomId(gridId, cell),
            'role': 'gridcell',
            'className': classes.length > 0 ? classes.join(' ') : undefined,
            'aria-colindex': (store.snapshot.columnIndexOf(column.colId) ?? 0) + 1,
            'aria-selected': edges ? true : undefined,
            'data-focused': isFocused || undefined,
            'data-editing':
                (editSession?.cell.rowId === row.id && editSession.cell.colId === column.colId) || undefined,
            'data-editable': editable || undefined,
            'data-hover-guard': guards
                ? [guards.top ? 'top' : '', guards.left ? 'left' : '', guards.corner ? 'corner' : '']
                      .filter(Boolean)
                      .join(' ') || undefined
                : undefined,
            'data-range': edges ? edges.count : undefined,
            'data-section-start':
                (column.index === 0 && (column.section === 'left' || column.section === 'center')) || undefined,
            'data-range-top': edges?.top || undefined,
            'data-range-bottom': edges?.bottom || undefined,
            'data-range-left': edges?.left || undefined,
            'data-range-right': edges?.right || undefined,
            'data-fill-target': inFill || undefined,
            'data-invalid': error ? true : undefined,
            'data-pending': hasPending && store.isCellPending(cell) ? true : undefined,
            'title': error,
            'style': resolved?.def.cellStyle,
        };
    };

    // The column that shows the row drag handle: one marked `rowDrag`, else the first displayed data column.
    const dragColId = props.rowDrag
        ? (store.snapshot.columns.find((column) => store.columns.getResolved(column.colId)?.def.rowDrag)?.colId ??
          store.snapshot.columns.find((column) => !store.columns.getResolved(column.colId)?.def.checkboxSelection)
              ?.colId)
        : undefined;
    const onRowDragStart = (event: DragEvent<HTMLSpanElement>, rowId: string) => {
        const rowIds = store.startRowDrag(rowId);
        const rows = rowIds.map((id) => store.getRow(id)).filter((row): row is GridRow<TData> => row !== undefined);
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('application/x-the-grid-rows', JSON.stringify(rowIds));
        event.dataTransfer.setData(
            'text/plain',
            props.rowDragLabel?.(rows) ?? `${rowIds.length} row${rowIds.length === 1 ? '' : 's'}`
        );
        const rowElement = event.currentTarget.closest<HTMLElement>('[data-grid-part="row"]');
        if (rowElement) {
            const box = rowElement.getBoundingClientRect();
            event.dataTransfer.setDragImage(rowElement, event.clientX - box.left, event.clientY - box.top);
        }
    };

    const renderCellContent = (row: GridRow<TData>, column: LaidOutColumn): ReactNode => {
        const resolved = store.columns.getResolved(column.colId);
        if (!resolved) {
            return null;
        }
        const pinned = row.section === 'top' || row.section === 'bottom';
        const editing = editSession && editSession.cell.rowId === row.id && editSession.cell.colId === column.colId;
        const corner = !pinned && fillCorner && fillCorner.rowId === row.id && fillCorner.colId === column.colId;
        let content: ReactNode = null;
        if (column.colId === groupColumnId) {
            content = renderGroupCell(row, resolved);
        } else if (resolved.def.checkboxSelection && selectionMode !== 'none' && row.kind === 'data' && !pinned) {
            content = (
                <input
                    type="checkbox"
                    data-grid-part="row-checkbox"
                    aria-label="Select row"
                    checked={store.isRowSelected(row.id)}
                    onChange={() => store.clickRow(row.id, { toggle: true, range: false })}
                />
            );
        } else if (editing && hasData(row)) {
            content = (
                <EditorHost
                    store={store}
                    api={api}
                    row={row as DataRow<TData>}
                    column={resolved}
                    anchor={geometry.getCellAnchor(editSession.cell)}
                    renderPopup={props.renderPopup}
                    onClosed={focusViewport}
                    escape={props.editorEscape ?? 'stop'}
                />
            );
        } else if (hasData(row)) {
            const value = resolved.getValue(row);
            const formattedValue = resolved.formatValue(row, value);
            const Renderer = resolved.renderer;
            content = Renderer ? (
                <Renderer
                    row={row}
                    data={row.data}
                    column={resolved}
                    value={value}
                    formattedValue={formattedValue}
                    api={api}
                    params={resolved.def.cellRendererParams ?? {}}
                    context={props.context}
                />
            ) : (
                <span data-grid-part="cell-value">{formattedValue}</span>
            );
        } else if (row.kind === 'loading') {
            content = <span data-grid-part="cell-loading" />;
        }

        if (dragColId === column.colId && row.kind === 'data' && !pinned) {
            content = (
                <span data-grid-part="cell-content">
                    <span
                        data-grid-part="row-drag-handle"
                        draggable
                        role="button"
                        aria-label="Drag to reorder"
                        onDragStart={(event) => onRowDragStart(event, row.id)}
                        onDragEnd={() => store.rowDrag && store.endRowDrag(false)}
                    />
                    {content}
                </span>
            );
        }

        return (
            <>
                {content}
                {corner ? <span data-grid-part="fill-handle" aria-hidden="true" /> : null}
            </>
        );
    };

    type RowRenderProps = Parameters<Parameters<typeof VirtualRows<TData>>[0]['renderRow']>[2];
    const rowsVersionNow = store.rowsVersion;
    const viewportWidth = scrollRef.current?.clientWidth ?? 0;
    const renderRow = (row: GridRow<TData>, index: number, rowProps: RowRenderProps) => {
        const highlighted = (candidate: GridRow<TData> | undefined) =>
            candidate !== undefined && (store.isRowSelected(candidate.id) || store.activeRowId === candidate.id);
        const isHighlighted = highlighted(row);
        const editingHere = editSession?.cell.rowId === row.id ? editSession : null;
        const fillHere = fillTarget && fillTarget.rowIds.includes(row.id) ? fillTarget.colIds.join(',') : '';
        const signature = [
            isHighlighted ? 'h' : '',
            store.isRowSelected(row.id) ? 's' : '',
            store.activeRowId === row.id ? 'a' : '',
            isHighlighted && !highlighted(store.rowModel.getRowAtIndex(index - 1)?.row) ? '^' : '',
            isHighlighted && !highlighted(store.rowModel.getRowAtIndex(index + 1)?.row) ? 'v' : '',
            focused?.rowId === row.id ? `f:${focused.colId}` : '',
            // Hover guards read the row above: its focus, range edges and highlight.
            focused && focused.rowId === store.rowModel.getRowAtIndex(index - 1)?.row.id ? `F:${focused.colId}` : '',
            highlighted(store.rowModel.getRowAtIndex(index - 1)?.row) ? 'u' : '',
            rangeSignature(index),
            rangeSignature(index - 1),
            fillHere,
            fillCorner?.rowId === row.id ? `c:${fillCorner.colId}` : '',
            store.rowDrag?.rowIds.includes(row.id) ? 'd' : '',
            store.rowDrag?.over?.rowId === row.id ? `o:${store.rowDrag.over.position}` : '',
            dragColId ?? '',
            selectionMode,
        ].join('|');
        const deps = [
            row,
            index,
            signature,
            editingHere,
            rowsVersionNow,
            store.rowVersion(row.id),
            store.columnsVersion,
            horizontal.window,
            props,
            store.cellErrorsVersion,
            store.pendingVersion,
            rowProps.style?.height,
            rowProps.ref,
            store.isFullWidth(row) ? viewportWidth : 0,
        ];

        return <MemoRow deps={deps} render={() => renderRowContent(row, index, rowProps)} />;
    };

    const groupColumnId = store.groupColumnId;
    const toggleRow = (rowId: string) => store.setExpanded(rowId, !store.rowModel.isExpanded(rowId));

    /**
     * The group column's cell: group rows show their label and count; tree rows show their path key (or the
     * group column's own field); master rows get a toggle; leaves are indented under their group.
     */
    const renderGroupCell = (row: GridRow<TData>, column: ResolvedColumn<TData>): ReactNode => {
        const isGroup = row.kind === 'group';
        if (!isGroup && row.kind !== 'data') {
            return null;
        }
        const expandable = isGroup ? row.childCount !== 0 : row.expandable !== undefined;
        const expanded = isGroup ? row.expanded : (row.expandable?.expanded ?? false);
        let label = '';
        if (isGroup) {
            label = groupLabel(row);
        } else if (column.def.field || column.def.valueGetter) {
            label = column.formatValue(row, column.getValue(row));
        } else if (props.data.type === 'local' && props.data.getDataPath) {
            label = props.data.getDataPath(row.data).at(-1) ?? '';
        }
        const childCount = isGroup ? row.childCount : null;
        const toggle = () => toggleRow(row.id);
        const Renderer = props.groupColumn?.renderer;
        if (Renderer) {
            return (
                <Renderer
                    row={row}
                    label={label}
                    childCount={childCount}
                    expanded={expanded}
                    expandable={expandable}
                    toggle={toggle}
                    level={row.level}
                    api={api}
                    context={props.context}
                />
            );
        }

        const LabelRenderer = props.groupColumn?.labelRenderer;

        return (
            <GroupContent
                part="group-cell-content"
                label={
                    LabelRenderer ? (
                        <LabelRenderer
                            row={row}
                            label={label}
                            childCount={childCount}
                            expanded={expanded}
                            expandable={expandable}
                            toggle={toggle}
                            level={row.level}
                            api={api}
                            context={props.context}
                        />
                    ) : (
                        label
                    )
                }
                level={row.level}
                childCount={props.groupColumn?.showCount === false ? null : childCount}
                expanded={expanded}
                expandable={expandable}
                toggle={toggle}
                icons={props.icons}
            />
        );
    };

    /** A group's label: its key formatted through the grouped column, or "(Blank)". */
    const groupLabel = (row: Extract<GridRow<TData>, { kind: 'group' }>) => {
        if (row.key === null || row.key === '') {
            return '(Blank)';
        }
        const column = store.columns.getResolved(row.groupColId);
        if (column && typeof column.def.valueFormatter === 'function' && row.data !== null) {
            return column.formatValue(
                { kind: 'data', id: row.id, level: row.level, parentId: null, data: row.data } as never,
                row.key
            );
        }

        return row.key;
    };

    const renderRowContent = (row: GridRow<TData>, index: number, rowProps: RowRenderProps) => {
        const selected = store.isRowSelected(row.id);
        // Selected and active rows form highlight blocks. Their edges come from the row model, never from
        // DOM order, so a theme can outline a run of rows as one block.
        const highlighted = (candidate: GridRow<TData> | undefined) =>
            candidate !== undefined && (store.isRowSelected(candidate.id) || store.activeRowId === candidate.id);
        const isHighlighted = highlighted(row);
        const rowClass = props.rowClassName?.(row);
        const className = Array.isArray(rowClass) ? rowClass.join(' ') : rowClass;
        const common = {
            ...rowProps,
            'role': 'row',
            'aria-rowindex': index + 2,
            'aria-selected': selectionMode !== 'none' ? selected : undefined,
            'data-grid-part': 'row',
            'data-row-kind': row.kind,
            'data-first-row': index === 0 || undefined,
            'data-selected': selected || undefined,
            'data-active': store.activeRowId === row.id || undefined,
            'data-row-dragging': store.rowDrag?.rowIds.includes(row.id) || undefined,
            'data-drop-position': store.rowDrag?.over?.rowId === row.id ? store.rowDrag.over.position : undefined,
            'data-highlight-start':
                (isHighlighted && !highlighted(store.rowModel.getRowAtIndex(index - 1)?.row)) || undefined,
            'data-highlight-end':
                (isHighlighted && !highlighted(store.rowModel.getRowAtIndex(index + 1)?.row)) || undefined,
            'className': className,
        };
        if (store.isFullWidth(row)) {
            const Renderer = row.kind === 'detail' ? props.detailRenderer : props.fullWidthRowRenderer;
            const isFocused = focused?.rowId === row.id && focused.colId === FULL_WIDTH_COLUMN;

            return (
                <div {...common} style={{ ...rowProps.style, ...rowLineStyle(horizontal.window) }}>
                    <div
                        id={cellDomId(gridId, { rowId: row.id, colId: FULL_WIDTH_COLUMN })}
                        role="gridcell"
                        aria-colspan={store.snapshot.columns.length}
                        data-grid-part="full-width-row"
                        data-focused={isFocused || undefined}
                        style={{
                            position: 'sticky',
                            left: 0,
                            width: scrollRef.current?.clientWidth ?? '100%',
                            flex: 'none',
                        }}
                    >
                        {row.kind === 'group' ? (
                            props.groupRowRenderer ? (
                                <props.groupRowRenderer
                                    row={row}
                                    api={api}
                                    toggle={() => toggleRow(row.id)}
                                    context={props.context}
                                />
                            ) : (
                                <GroupContent
                                    part="group-row-content"
                                    icons={props.icons}
                                    label={groupLabel(row)}
                                    level={row.level}
                                    childCount={row.childCount}
                                    expanded={row.expanded}
                                    expandable={row.childCount !== 0}
                                    toggle={() => toggleRow(row.id)}
                                />
                            )
                        ) : Renderer ? (
                            <Renderer row={row as never} api={api} context={props.context} />
                        ) : hasData(row) ? (
                            String((row as RowWithData<TData>).data)
                        ) : null}
                    </div>
                </div>
            );
        }

        return (
            <div
                {...common}
                style={{ ...rowProps.style, ...rowLineStyle(horizontal.window), ...props.rowStyle?.(row) }}
            >
                <RowCells
                    horizontal={horizontal}
                    renderCell={(column) => renderCellContent(row, column)}
                    cellAttributes={(column) => cellAttributes(row, index, column)}
                />
            </div>
        );
    };

    /**
     * A pinned row (totals above or below the body): the columns' renderers and formatters, read only. It has
     * no displayed index, so focus, ranges, editing, selection and dragging never reach it.
     */
    const renderPinnedRow = (row: GridRow<TData>): ReactNode => {
        const rowClass = props.rowClassName?.(row);
        if (store.isFullWidth(row)) {
            const Renderer = props.fullWidthRowRenderer;
            return (
                <div
                    key={row.id}
                    role="row"
                    data-grid-part="row"
                    data-row-id={row.id}
                    data-row-kind={row.kind}
                    data-row-pinned={row.section}
                    className={Array.isArray(rowClass) ? rowClass.join(' ') : rowClass}
                    style={{ height: pinnedHeight(row), ...rowLineStyle(horizontal.window), ...props.rowStyle?.(row) }}
                >
                    <div
                        role="gridcell"
                        data-grid-part="full-width-row"
                        style={{
                            position: 'sticky',
                            left: 0,
                            width: scrollRef.current?.clientWidth ?? '100%',
                            flex: 'none',
                        }}
                    >
                        {Renderer ? <Renderer row={row as never} api={api} context={props.context} /> : null}
                    </div>
                </div>
            );
        }

        return (
            <div
                key={row.id}
                role="row"
                data-grid-part="row"
                data-row-id={row.id}
                data-row-kind={row.kind}
                data-row-pinned={row.section}
                className={Array.isArray(rowClass) ? rowClass.join(' ') : rowClass}
                style={{ height: pinnedHeight(row), ...rowLineStyle(horizontal.window), ...props.rowStyle?.(row) }}
            >
                <RowCells
                    horizontal={horizontal}
                    renderCell={(column) => renderCellContent(row, column)}
                    cellAttributes={(column) => {
                        const resolved = store.columns.getResolved(column.colId);
                        const classes =
                            resolved && hasData(row) ? resolved.cellClasses(row, resolved.getValue(row)) : [];

                        return {
                            'role': 'gridcell',
                            'className': classes.length > 0 ? classes.join(' ') : undefined,
                            'aria-colindex': (store.snapshot.columnIndexOf(column.colId) ?? 0) + 1,
                            'data-section-start':
                                (column.index === 0 && (column.section === 'left' || column.section === 'center')) ||
                                undefined,
                            'style': resolved?.def.cellStyle,
                        };
                    }}
                />
            </div>
        );
    };

    const renderHeaderCell = (column: LaidOutColumn): ReactNode => {
        const resolved = store.columns.getResolved(column.colId);
        if (!resolved) {
            return null;
        }
        const sortModel = store.columns.getSortModel();
        const sortIndex = sortModel.findIndex((item) => item.colId === column.colId);
        const sort = sortIndex >= 0 ? sortModel[sortIndex]!.sort : null;
        const sortable = resolved.def.sortable !== false;
        const toggleSort = (multi: boolean) => store.toggleSort(column.colId, multi && props.enableMultiSort !== false);
        // The resize zone straddles the column line: the next column's start also resizes this one.
        const previousLaidOut =
            column.index > 0
                ? horizontal.layout
                      .getColumns()
                      .find((candidate) => candidate.section === column.section && candidate.index === column.index - 1)
                : undefined;
        const previousColumn =
            previousLaidOut && store.columns.getResolved(previousLaidOut.colId)?.def.resizable !== false
                ? previousLaidOut
                : undefined;
        const Header = typeof resolved.def.headerRenderer === 'function' ? resolved.def.headerRenderer : null;
        if (resolved.def.headerCheckboxSelection && selectionMode === 'multiple') {
            const state = store.headerSelectionState();

            return (
                <div data-grid-part="header-content">
                    <input
                        // Mixed while only some rows are selected; a click then selects them all.
                        ref={(input) => {
                            if (input) {
                                input.indeterminate = state === 'some';
                            }
                        }}
                        type="checkbox"
                        data-grid-part="header-checkbox"
                        aria-label="Select all rows"
                        checked={state === 'all'}
                        onChange={() => (state === 'all' ? store.deselectAllRows() : store.selectAllRows())}
                    />
                </div>
            );
        }

        return (
            <div
                data-grid-part="header-content"
                data-sortable={sortable || undefined}
                onClick={(event) => {
                    if (sortable && !(event.target as Element).closest('[data-grid-part="resize-handle"]')) {
                        toggleSort(event.shiftKey);
                    }
                }}
            >
                {previousColumn ? (
                    <ResizeHandle
                        colId={previousColumn.colId}
                        edge="start"
                        width={previousColumn.width}
                        onResize={(width, finished) =>
                            store.resizeColumn(
                                previousColumn.colId,
                                horizontal.resize(previousColumn.colId, width),
                                finished
                            )
                        }
                    />
                ) : null}
                {Header ? (
                    <Header
                        column={resolved}
                        groupId={null}
                        displayName={resolved.headerName}
                        api={api}
                        params={resolved.def.headerRendererParams ?? {}}
                        sort={sort}
                        toggleSort={toggleSort}
                    />
                ) : (
                    <span data-grid-part="header-label">{resolved.headerName}</span>
                )}
                {store.filterKindOf(column.colId) !== null &&
                (column.colId in store.query.filterModel ||
                    (props.headerFilterButton === 'always' && !resolved.def.suppressHeaderFilterButton)) ? (
                    <button
                        type="button"
                        data-grid-part="header-filter-button"
                        data-active={column.colId in store.query.filterModel || undefined}
                        aria-label={`Filter ${resolved.headerName}${column.colId in store.query.filterModel ? ' (active)' : ''}`}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            openFilterPanel(column.colId);
                        }}
                    >
                        {props.icons?.headerFilter ?? (
                            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                                <path d="M2 3h12l-4.5 5.5V13l-3 1.5V8.5z" fill="currentColor" />
                            </svg>
                        )}
                    </button>
                ) : null}
                {sort ? (
                    <span data-grid-part="sort-indicator" data-sort={sort}>
                        {sort === 'asc' ? (props.icons?.sortAscending ?? '↑') : (props.icons?.sortDescending ?? '↓')}
                        {sortModel.length > 1 ? sortIndex + 1 : null}
                    </span>
                ) : null}
                {props.headerMenuButton && !resolved.def.suppressHeaderMenuButton ? (
                    <button
                        type="button"
                        data-grid-part="header-menu-button"
                        aria-label={`${resolved.headerName} column menu`}
                        aria-haspopup="menu"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            const rect = event.currentTarget.getBoundingClientRect();
                            store.openMenu(
                                'header',
                                { rowId: null, colId: column.colId },
                                {
                                    top: rect.top,
                                    left: rect.left,
                                    width: rect.width,
                                    height: rect.height,
                                    visible: true,
                                },
                                api
                            );
                        }}
                    >
                        {props.icons?.headerMenu ?? (
                            <svg viewBox="0 0 4 16" width="4" height="14" aria-hidden="true">
                                <circle cx="2" cy="3" r="1.5" fill="currentColor" />
                                <circle cx="2" cy="8" r="1.5" fill="currentColor" />
                                <circle cx="2" cy="13" r="1.5" fill="currentColor" />
                            </svg>
                        )}
                    </button>
                ) : null}
                {resolved.def.resizable !== false ? (
                    <ResizeHandle
                        colId={column.colId}
                        edge="end"
                        width={column.width}
                        onResize={(width, finished) =>
                            store.resizeColumn(column.colId, horizontal.resize(column.colId, width), finished)
                        }
                    />
                ) : null}
            </div>
        );
    };

    const overlay = store.overlay;
    const overlayContent =
        overlay?.kind === 'loading'
            ? (props.loadingOverlay ?? 'Loading…')
            : overlay?.kind === 'empty'
              ? (props.emptyOverlay?.(overlay.reason) ??
                (overlay.reason === 'noQuery' ? 'Search or filter to show rows' : 'No rows to show'))
              : overlay?.kind === 'error' && props.errorOverlay === false
                ? null
                : overlay?.kind === 'error'
                  ? ((typeof props.errorOverlay === 'function'
                        ? props.errorOverlay(overlay.error, () => store.refresh({ purge: true }))
                        : undefined) ?? (
                        <span>
                            The rows could not be loaded.{' '}
                            <button
                                type="button"
                                data-grid-part="overlay-retry"
                                onClick={() => store.refresh({ purge: true })}
                            >
                                Try again
                            </button>
                        </span>
                    ))
                  : null;
    const totalColumns = store.snapshot.columns.length;
    // Scroll edges, for themes that shade the pinned sections and the header while content sits under them.
    const viewportElement = scrollRef.current;
    const scrolledLeft = (viewportElement?.scrollLeft ?? 0) > 0;
    const scrolledRight =
        viewportElement !== null &&
        viewportElement.scrollLeft + viewportElement.clientWidth < viewportElement.scrollWidth - 1;
    const scrolledTop = (viewportElement?.scrollTop ?? 0) > 0;

    return (
        <div
            className={props.className}
            data-grid-part="root"
            data-density={density}
            data-color-scheme={props.colorScheme ?? 'light'}
            data-scrolled-left={scrolledLeft || undefined}
            data-scrolled-right={scrolledRight || undefined}
            data-scrolled-top={scrolledTop || undefined}
            style={{
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
                height: props.layout === 'content' ? undefined : '100%',
            }}
        >
            <div
                ref={scrollRef}
                role="grid"
                tabIndex={0}
                aria-label={props.ariaLabel}
                aria-rowcount={(store.rowModel.getRowCount() ?? -2) + 1}
                aria-colcount={totalColumns}
                aria-multiselectable={selectionMode === 'multiple' || props.enableRanges ? true : undefined}
                aria-activedescendant={focused ? cellDomId(gridId, focused) : undefined}
                data-grid-part="viewport"
                data-dragging={store.isDragging || undefined}
                data-menu-open={menuProps ? true : undefined}
                style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', outline: 'none' }}
                onKeyDown={onKeyDown}
                onFocus={onFocus}
                onMouseDownCapture={onPointerDownCapture}
                onPointerDownCapture={onPointerDownCapture}
                onPointerDown={onPointerDown}
                onClick={onClick}
                onDoubleClick={onDoubleClick}
                onContextMenu={onContextMenu}
                onCopy={onCopy}
                onCut={onCut}
                onPaste={onPaste}
                onDragOver={onRowDragOver}
                onDrop={(event) => {
                    if (store.rowDrag) {
                        event.preventDefault();
                        store.endRowDrag(true);
                    }
                }}
            >
                <div
                    role="rowgroup"
                    data-grid-part="header"
                    style={{
                        position: 'sticky',
                        top: 0,
                        zIndex: 2,
                        width: horizontal.window.totalWidth,
                        minWidth: '100%',
                    }}
                >
                    <HeaderRows
                        horizontal={horizontal}
                        rowHeight={headerRowHeight}
                        headerCellAttributes={(column) => {
                            const sort = store.columns.getSortModel().find((item) => item.colId === column.colId)?.sort;
                            const headerClass = store.columns.getResolved(column.colId)?.def.headerClass;

                            return {
                                'role': 'columnheader',
                                'className': headerClass,
                                'aria-sort': sort === 'asc' ? 'ascending' : sort === 'desc' ? 'descending' : undefined,
                            };
                        }}
                        renderGroupCell={(cell) => {
                            const expandable = cell.groupId ? store.columns.isGroupExpandable(cell.groupId) : false;
                            const open = cell.groupId
                                ? store.columns.getColumnGroupState().find((entry) => entry.groupId === cell.groupId)
                                      ?.open
                                : false;

                            const group = cell.groupId ? store.columns.getGroup(cell.groupId) : undefined;
                            const Header = typeof group?.headerRenderer === 'function' ? group.headerRenderer : null;
                            const displayName = cell.groupId ? store.columns.getGroupLabel(cell.groupId) : '';
                            return (
                                <div data-grid-part="group-header-content" className={group?.headerClass}>
                                    <span
                                        data-grid-part="group-header-label"
                                        style={{ position: 'sticky', left: horizontal.window.leftWidth }}
                                    >
                                        {Header ? (
                                            <Header
                                                column={null}
                                                groupId={cell.groupId}
                                                displayName={displayName}
                                                api={api}
                                                params={group?.headerRendererParams ?? {}}
                                                sort={null}
                                                toggleSort={() => undefined}
                                            />
                                        ) : (
                                            displayName
                                        )}
                                        {expandable ? (
                                            <button
                                                type="button"
                                                data-grid-part="group-toggle"
                                                aria-expanded={open}
                                                aria-label={`${open ? 'Collapse' : 'Expand'} ${store.columns.getGroupLabel(cell.groupId!)}`}
                                                onClick={() =>
                                                    store.setColumnGroupState(
                                                        [{ groupId: cell.groupId!, open: !open }],
                                                        'user'
                                                    )
                                                }
                                            >
                                                {open
                                                    ? (props.icons?.columnGroupOpen ?? '−')
                                                    : (props.icons?.columnGroupClosed ?? '+')}
                                            </button>
                                        ) : null}
                                    </span>
                                </div>
                            );
                        }}
                        renderHeaderCell={renderHeaderCell}
                    />
                    {pinnedTop.length > 0 ? (
                        <div data-grid-part="pinned-top">{pinnedTop.map((row) => renderPinnedRow(row))}</div>
                    ) : null}
                    {stuckRows.length > 0 ? (
                        // No height of its own, so nothing below moves: the stuck rows hang over the body, and
                        // a row being pushed out is clipped at the header instead of covering it.
                        <div
                            data-grid-part="sticky-rows"
                            style={{ height: 0, clipPath: 'inset(0 -100vw -100vh -100vw)' }}
                        >
                            {stuckRows.map((stuck, position) => {
                                const row = source.rowAt(stuck.index);
                                const previous = stuckRows[position - 1];
                                const above = previous ? previous.top + previous.height : 0;

                                return row ? (
                                    <Fragment key={stuck.id}>
                                        {renderRow(row, stuck.index, {
                                            'data-row-id': row.id,
                                            'data-row-index': stuck.index,
                                            'ref': undefined,
                                            'style': { height: stuck.height, marginTop: stuck.top - above },
                                        })}
                                    </Fragment>
                                ) : null;
                            })}
                        </div>
                    ) : null}
                </div>
                {overlayContent !== null ? (
                    <div
                        data-grid-part="overlay"
                        data-overlay={overlay?.kind}
                        data-overlay-reason={overlay?.kind === 'empty' ? overlay.reason : undefined}
                        role="status"
                        style={{ position: 'sticky', left: 0, width: '100%' }}
                    >
                        {overlayContent}
                    </div>
                ) : null}
                <div role="rowgroup" data-grid-part="body">
                    <VirtualRows
                        virtualizer={vertical}
                        renderRow={(row, index, rowProps) =>
                            // A stuck row is drawn below the header; its own place keeps only its height.
                            stuckIds.has(row.id) ? (
                                <div
                                    {...rowProps}
                                    aria-hidden="true"
                                    data-grid-part="row-spacer"
                                    style={{ height: vertical.layout.getRowBounds(index)?.height }}
                                />
                            ) : (
                                renderRow(row, index, rowProps)
                            )
                        }
                    />
                </div>
                {pinnedBottom.length > 0 ? (
                    <div
                        role="rowgroup"
                        data-grid-part="pinned-bottom"
                        ref={pinnedBottomRef}
                        style={{
                            position: 'sticky',
                            bottom: 0,
                            maxHeight: props.pinnedBottomMaxHeight,
                            overflowY: props.pinnedBottomMaxHeight !== undefined ? 'auto' : undefined,
                            overflowX: props.pinnedBottomMaxHeight !== undefined ? 'hidden' : undefined,
                            left: props.pinnedBottomMaxHeight !== undefined ? 0 : undefined,
                            overscrollBehaviorY: 'contain',
                            zIndex: 2,
                            width:
                                props.pinnedBottomMaxHeight !== undefined
                                    ? (scrollRef.current?.clientWidth ?? '100%')
                                    : horizontal.window.totalWidth,
                            minWidth: '100%',
                        }}
                    >
                        {pinnedBottom.map((row) => renderPinnedRow(row))}
                    </div>
                ) : null}
            </div>
            {props.footer ? <div data-grid-part="footer">{props.footer}</div> : null}
            {menuProps ? props.renderMenu ? props.renderMenu(menuProps) : <DefaultMenu {...menuProps} /> : null}
            {filterPanel}
            {columnChooser}
        </div>
    );
}

/**
 * Hosts the filter panel for a column: picks the editor for the kind, gives it the current condition and
 * set choices, and applies what it reports to the grid shortly after the last change (only applicable
 * conditions; an incomplete one clears the column's filter).
 */
function FilterPanelHost<TData>({
    store,
    api,
    colId,
    kind,
    anchor,
    column,
    editors,
    render,
    onClose,
}: {
    store: GridStore<TData>;
    api: GridApi<TData>;
    colId: string;
    kind: string;
    anchor: AnchorRect;
    column: ResolvedColumn<TData>;
    editors: GridProps<TData>['filterEditors'];
    render: GridProps<TData>['renderFilterPanel'];
    onClose: () => void;
}) {
    const [condition] = useState(() => (store.query.filterModel[colId] as Record<string, unknown> | undefined) ?? null);
    const choices = useMemo(() => {
        const params = (column.def.filterParams ?? {}) as { choices?: SetChoicesSource; values?: unknown[] };
        if (params.choices) {
            return params.choices;
        }
        if (Array.isArray(params.values)) {
            return staticSetChoices(params.values as (string | { id: string | number | null; label: string })[]);
        }
        const list = store.distinctValues(colId);

        return list.length > 0 ? listSetChoices(list) : null;
    }, [store, colId, column]);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const latest = useRef<Record<string, unknown> | null>(condition);
    const flush = () => {
        if (timer.current !== null) {
            clearTimeout(timer.current);
            timer.current = null;
        }
        const next = latest.current;
        const params = (column.def.filterParams ?? {}) as Record<string, unknown>;
        api.setColumnFilter(
            colId,
            next && isConditionApplicable(next as never, params) ? (next as FilterCondition) : null
        );
    };
    useEffect(
        () => () => {
            if (timer.current !== null) {
                flush();
            }
        },
        []
    );
    const onChange = (next: Record<string, unknown> | null) => {
        latest.current = next;
        if (timer.current !== null) {
            clearTimeout(timer.current);
        }
        timer.current = setTimeout(flush, FILTER_APPLY_DELAY);
    };
    const Editor = editors?.[kind] ?? DefaultFilterEditor;
    const children = (
        <Editor
            column={column}
            kind={kind}
            condition={condition}
            onChange={onChange}
            choices={choices}
            api={api}
            close={onClose}
        />
    );
    const props = { anchor, colId, children, onClose, column };

    return render ? render(props) : <DefaultFilterPanel {...props} />;
}

/** How long the filter panel waits after the last change before filtering. */
const FILTER_APPLY_DELAY = 250;

/** Set choices from a fixed list of value and label pairs; search matches labels, ignoring case. */
function listSetChoices(list: SetChoice[]): SetChoicesSource {
    return {
        search: async (text) => {
            const needle = text.trim().toLowerCase();

            return needle === '' ? list : list.filter((choice) => choice.label.toLowerCase().includes(needle));
        },
        resolve: async (values) => list.filter((choice) => choice.value !== null && values.includes(choice.value)),
    };
}

/** The group column's definition without its React renderer (the store keeps definitions only). */
function groupColumnDef<TData>(groupColumn: GridProps<TData>['groupColumn']): Partial<ColumnDef<TData>> | undefined {
    if (!groupColumn) {
        return undefined;
    }
    const { renderer: _renderer, ...def } = groupColumn;

    return def;
}

/** The previous object while the new one has the same keys and values. */
function useShallowStable<T extends object | undefined>(value: T): T {
    const ref = useRef(value);
    const previous = ref.current;
    const same =
        previous === value ||
        (previous !== undefined &&
            value !== undefined &&
            Object.keys(previous).length === Object.keys(value).length &&
            Object.entries(value).every(([key, entry]) =>
                Object.is((previous as Record<string, unknown>)[key], entry)
            ));
    if (!same) {
        ref.current = value;
    }

    return ref.current;
}

/** Default group content, for group rows and group column cells: a toggle, the label and the count, indented by level. */
function GroupContent({
    part,
    label,
    level,
    childCount,
    expanded,
    expandable,
    toggle,
    icons,
}: {
    part: 'group-row-content' | 'group-cell-content';
    label: ReactNode;
    icons: GridIcons | undefined;
    level: number;
    childCount: number | null;
    expanded: boolean;
    expandable: boolean;
    toggle: () => void;
}) {
    return (
        <span data-grid-part={part} style={{ paddingInlineStart: `calc(${level} * var(--the-grid-group-indent))` }}>
            {expandable ? (
                <button
                    type="button"
                    tabIndex={-1}
                    data-grid-part="row-expand-toggle"
                    aria-expanded={expanded}
                    aria-label={expanded ? 'Collapse' : 'Expand'}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                        event.stopPropagation();
                        toggle();
                    }}
                >
                    {expanded ? (icons?.rowExpanded ?? '▾') : (icons?.rowCollapsed ?? '▸')}
                </button>
            ) : (
                <span data-grid-part="row-expand-spacer" />
            )}
            <span data-grid-part="row-group-label">{label}</span>
            {childCount !== null && childCount > 0 ? (
                <span data-grid-part="row-group-count">({childCount})</span>
            ) : null}
        </span>
    );
}

async function writeClipboard(copied: { text: string; html: string }): Promise<void> {
    if (!copied.html) {
        await navigator.clipboard?.writeText(copied.text);

        return;
    }
    try {
        await navigator.clipboard.write([
            new ClipboardItem({
                'text/plain': new Blob([copied.text], { type: 'text/plain' }),
                'text/html': new Blob([copied.html], { type: 'text/html' }),
            }),
        ]);
    } catch {
        await navigator.clipboard?.writeText(copied.text);
    }
}

function ResizeHandle({
    colId,
    width,
    edge,
    onResize,
}: {
    colId: string;
    /** `end`: at the column's own right edge; `start`: at the next column's left edge, resizing this column. */
    edge: 'start' | 'end';
    width: number;
    onResize: (width: number, finished: boolean) => void;
}) {
    const onPointerDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
        event.preventDefault();
        event.stopPropagation();
        const startX = event.clientX;
        const target = event.currentTarget;
        target.setPointerCapture(event.pointerId);
        const move = (moveEvent: PointerEvent) => onResize(width + moveEvent.clientX - startX, false);
        const up = (upEvent: PointerEvent) => {
            target.removeEventListener('pointermove', move);
            target.removeEventListener('pointerup', up);
            onResize(width + upEvent.clientX - startX, true);
        };
        target.addEventListener('pointermove', move);
        target.addEventListener('pointerup', up);
    };

    return (
        <span
            data-grid-part="resize-handle"
            data-resize={colId}
            data-edge={edge}
            onPointerDown={onPointerDown}
            onClick={(event) => event.stopPropagation()}
        />
    );
}

type EditorHostProps<TData> = {
    store: GridStore<TData>;
    api: GridApi<TData>;
    row: DataRow<TData>;
    column: ResolvedColumn<TData>;
    anchor: AnchorRect | undefined;
    renderPopup: GridProps<TData>['renderPopup'];
    onClosed: () => void;
    escape: 'stop' | 'propagate';
};

/**
 * Hosts the active editor: inline in the cell or in a popup at the cell's anchor. Applies the editor's key
 * policy and commits on blur, all through the store's single stop path.
 */
function EditorHost<TData>({ store, api, row, column, anchor, renderPopup, onClosed, escape }: EditorHostProps<TData>) {
    const session = store.editSession!;
    const Editor = (column.editor ?? TextCellEditor) as NonNullable<ResolvedColumn<TData>['editor']>;
    const policy = keyPolicyOf(column.editor);
    const presentation = column.editor?.presentation ?? 'inline';
    const stop = (commit: boolean, reason: 'enter' | 'tab' | 'escape' | 'blur' | 'api', then?: NavigationKey) => {
        const done = (stopped: boolean) => {
            if (stopped && !store.editSession) {
                onClosed();
            }
        };
        const result = store.stopEditing(commit, reason, then);
        if (result instanceof Promise) {
            void result.then(done);
        } else {
            done(result);
        }
    };
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (escape === 'propagate' && event.key === 'Escape' && !event.nativeEvent.isComposing) {
            // The grid's own handler skips keys from inside an editor; the page still gets this one.
            stop(false, 'escape');

            return;
        }
        event.stopPropagation();
        if (event.nativeEvent.isComposing) {
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            stop(false, 'escape');
        } else if (event.key === 'Enter' && policy.enter !== 'newline' && !event.altKey) {
            event.preventDefault();
            stop(true, 'enter', policy.enter === 'commitAndMoveDown' ? (event.shiftKey ? 'up' : 'down') : undefined);
        } else if (event.key === 'Tab' && policy.tab === 'commitAndMove') {
            event.preventDefault();
            stop(true, 'tab', event.shiftKey ? 'previous' : 'next');
        } else if (IS_MAC && (event.key === 'Home' || event.key === 'End') && isTextInput(event.target)) {
            // macOS scrolls the nearest scroll container on Home and End in a text field, which would move
            // the grid away from its own editor. Move the caret instead, as other platforms do.
            event.preventDefault();
            const input = event.target as HTMLInputElement;
            const position = event.key === 'Home' ? 0 : input.value.length;
            const anchor =
                input.selectionDirection === 'backward'
                    ? (input.selectionEnd ?? position)
                    : (input.selectionStart ?? position);
            if (event.shiftKey) {
                input.setSelectionRange(
                    Math.min(anchor, position),
                    Math.max(anchor, position),
                    position < anchor ? 'backward' : 'forward'
                );
            } else {
                input.setSelectionRange(position, position);
            }
        } else if (policy.arrowsNavigateGrid && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
            event.preventDefault();
            stop(true, 'enter', event.key === 'ArrowUp' ? 'up' : 'down');
        }
    };
    // Safari does not focus a clicked button, so a click inside a popup editor would blur the editor to the
    // body and commit before the click lands. Keep focus inside instead, as other browsers do.
    const onMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
        const control = (event.target as Element).closest<HTMLElement>('button, [role="option"], [role="menuitem"]');
        if (control && event.currentTarget.contains(control) && document.activeElement !== control) {
            event.preventDefault();
            control.focus({ preventScroll: true });
        }
    };
    const onBlur = (event: FocusEvent<HTMLDivElement>) => {
        const next = event.relatedTarget as Element | null;
        if (
            next &&
            (event.currentTarget.contains(next) || next.closest('[data-grid-editor-popup], [data-grid-editor]'))
        ) {
            return;
        }
        if (store.editSession?.generation === session.generation) {
            stop(true, 'blur');
        }
    };
    const editorProps: CellEditorProps<TData> = {
        row,
        data: row.data,
        column,
        initialValue: session.initialValue,
        draft: session.draft,
        setDraft: (value) => store.editing.setDraft(value),
        startKey: session.startKey,
        stop: (commit) => stop(commit, 'api'),
        error: session.error,
        anchor: anchor ?? pointAnchor(0, 0),
        api,
        params: column.def.cellEditorParams ?? {},
    };
    const editor = (
        <div
            data-grid-editor=""
            data-validating={session.status === 'validating' || undefined}
            data-invalid={session.error ? true : undefined}
            onKeyDown={onKeyDown}
            onBlur={onBlur}
            onMouseDown={onMouseDown}
        >
            <Editor {...editorProps} />
            {session.error ? (
                <span data-grid-part="editor-error" role="alert">
                    {session.error}
                </span>
            ) : null}
        </div>
    );
    if (presentation === 'popup') {
        const Popup = renderPopup ?? ((popupProps) => <DefaultPopup {...popupProps} />);

        return (
            <>
                <span data-grid-part="cell-value">{column.formatValue(row, column.getValue(row))}</span>
                {Popup({ anchor: editorProps.anchor, children: editor, onDismiss: () => stop(true, 'blur') })}
            </>
        );
    }

    return editor;
}

export type { CellRendererProps };
