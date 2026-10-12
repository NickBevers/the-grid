/**
 * The grid's `GeometryApi`: bounds, anchors, hit testing and scrolling, computed from the vertical layout
 * (row heights) and the column layout (widths), never from the DOM. Rows and columns that are not mounted
 * still have bounds, so range handles, popups, drag and collaboration cursors work anywhere.
 *
 * The only DOM input is a small viewport adapter (the scroll element's client rect, sizes and scroll
 * offsets), injected so the math is testable without a browser. See `contract/geometry.ts` for the
 * coordinate spaces.
 */
import type {
    CellPosition,
    EdgeProximity,
    GeometryApi,
    HitTestResult,
    Rect,
    RowId,
    ScrollAlignment,
    ScrollPosition,
    VisibleRange,
} from '../contract';
import type { ColumnLayout } from '../virtual/horizontalLayout';
import type { RowSource, VerticalLayout } from '../virtual/verticalLayout';
import type { StuckRow } from './stickyRows';

/** What geometry needs from the scroll element. `rect` is the element's client rect (border box). */
export type ViewportAdapter = {
    rect(): { top: number; left: number; width: number; height: number };
    clientWidth(): number;
    clientHeight(): number;
    scrollTop(): number;
    scrollLeft(): number;
    setScrollTop(top: number): void;
    setScrollLeft(left: number): void;
};

export type GeometryOptions<TData> = {
    vertical: VerticalLayout<TData>;
    columns: ColumnLayout;
    source: () => RowSource<TData>;
    viewport: ViewportAdapter;
    /** Height of the sticky header (group rows plus the column header row). */
    headerHeight: () => number;
    /** Pinned bottom rows in display order with their heights, sitting above the bottom edge. */
    pinnedBottom?: () => readonly { id: RowId; height: number }[];
    /** Visible height and scroll offset of a capped pinned bottom section. */
    pinnedBottomHeight?: () => number;
    pinnedBottomScrollTop?: () => number;
    /** Pinned top rows below the header. */
    pinnedTop?: () => readonly { id: RowId; height: number }[];
    /** Whether a row renders as one full-width cell. */
    isFullWidth?: (rowId: RowId) => boolean;
    /** Group rows stuck below the header at a virtual scroll top (sticky group rows), outermost first. */
    stickyRowsAt?: (scrollTop: number) => readonly StuckRow[];
    /** Retained-aware window of mounted rows and columns, for the mounted part of the visible range. */
    mountedRows?: () => { first: number; last: number };
    resetRowHeights?: (rowIds?: RowId[]) => void;
    overscanColumns?: number;
};

export function createGeometry<TData>(options: GeometryOptions<TData>): GeometryApi {
    const { vertical, columns, viewport } = options;
    const virtualScrollTop = () => {
        const actual = viewport.scrollTop();

        // A browser scroll can precede its event; hit testing must already follow the visible rows.
        // Preserve subpixel corrections when the browser rounds the layout's assigned position.
        return Math.abs(actual - vertical.scrollTop) < 1
            ? vertical.getVirtualScrollTop()
            : vertical.mapping.toVirtual(actual);
    };
    const pinnedTop = () => options.pinnedTop?.() ?? [];
    const pinnedBottom = () => options.pinnedBottom?.() ?? [];
    const sum = (rows: readonly { height: number }[]) => rows.reduce((total, row) => total + row.height, 0);
    /** Body area in viewport coordinates (below header and pinned top rows, above pinned bottom rows). */
    const body = () => {
        const top = options.headerHeight() + sum(pinnedTop());
        const bottom = viewport.clientHeight() - (options.pinnedBottomHeight?.() ?? sum(pinnedBottom()));

        return { top, bottom, height: Math.max(bottom - top, 0) };
    };
    const centerArea = () => {
        const width = viewport.clientWidth();
        const right = columns.totalWidth > width ? width - columns.rightWidth : columns.leftWidth + columns.centerWidth;

        return { left: columns.leftWidth, right };
    };

    const rowBoundsAt = (index: number): Rect | undefined => {
        const bounds = vertical.getRowBounds(index);

        return bounds ? { top: bounds.top, left: 0, width: columns.totalWidth, height: bounds.height } : undefined;
    };

    const pinnedBounds = (rowId: RowId): Rect | undefined => {
        for (const [rows, start] of [
            [pinnedTop(), options.headerHeight()],
            [pinnedBottom(), body().bottom - (options.pinnedBottomScrollTop?.() ?? 0)],
        ] as const) {
            let top = start;
            for (const row of rows) {
                if (row.id === rowId) {
                    return {
                        top: top - body().top + virtualScrollTop(),
                        left: 0,
                        width: columns.totalWidth,
                        height: row.height,
                    };
                }
                top += row.height;
            }
        }
        return undefined;
    };

    const columnContentLeft = (colId: string): number | undefined => {
        const column = columns.getColumn(colId);
        if (!column) {
            return undefined;
        }
        const viewLeft = columns.getViewportLeft(colId, viewport.scrollLeft(), viewport.clientWidth())!;

        // Pinned columns are reported where they stick right now; center columns at their natural place.
        return column.section === 'center' ? columns.getContentLeft(colId)! : viewLeft + viewport.scrollLeft();
    };

    const cellBounds = (cell: CellPosition): Rect | undefined => {
        const index = options.source().indexOf(cell.rowId);
        const row = index === undefined ? pinnedBounds(cell.rowId) : rowBoundsAt(index);
        if (!row) {
            return undefined;
        }
        if (options.isFullWidth?.(cell.rowId)) {
            return row;
        }
        const column = columns.getColumn(cell.colId);
        const left = columnContentLeft(cell.colId);
        if (!column || left === undefined) {
            return undefined;
        }

        return { top: row.top, left, width: column.width, height: row.height };
    };

    const columnAtViewportX = (x: number): string | null => {
        const width = viewport.clientWidth();
        const area = centerArea();
        if (x < 0 || x >= Math.min(width, columns.totalWidth)) {
            return null;
        }
        if (x < columns.leftWidth) {
            return (
                columns
                    .getColumns()
                    .find((column) => column.section === 'left' && x >= column.left && x < column.left + column.width)
                    ?.colId ?? null
            );
        }
        if (x >= area.right) {
            const offset = x - area.right;

            return (
                columns
                    .getColumns()
                    .find(
                        (column) =>
                            column.section === 'right' && offset >= column.left && offset < column.left + column.width
                    )?.colId ?? null
            );
        }
        const contentX = x - columns.leftWidth + viewport.scrollLeft();

        return (
            columns
                .getColumns()
                .find(
                    (column) =>
                        column.section === 'center' && contentX >= column.left && contentX < column.left + column.width
                )?.colId ?? null
        );
    };

    const getRowIndexAtOffset = (y: number): number | undefined => {
        const source = options.source();
        if (y < 0 || source.count === 0) {
            return undefined;
        }
        const index = vertical.getIndexAtOffset(y);
        const bounds = index === undefined ? undefined : vertical.getRowBounds(index);

        return bounds && y < bounds.top + bounds.height ? index : undefined;
    };

    const setScroll = (position: Partial<ScrollPosition>) => {
        if (position.top !== undefined) {
            viewport.setScrollTop(vertical.mapping.toPhysical(position.top));
        }
        if (position.left !== undefined) {
            viewport.setScrollLeft(position.left);
        }
    };

    const stuckAt = (scrollTop: number) => options.stickyRowsAt?.(scrollTop) ?? [];
    /** Bottom of the stuck group rows, from the top of the body area; 0 without any. */
    const stackBottom = (rows: readonly StuckRow[], except?: number) =>
        Math.max(0, ...rows.filter((row) => row.index !== except).map((row) => row.top + row.height));

    const ensureVertical = (index: number, align: ScrollAlignment) => {
        let top = vertical.scrollTopForIndex(index, align);
        // A row scrolled to the top must not end up under the group rows stuck there.
        const bounds = vertical.getRowBounds(index);
        if (bounds && options.stickyRowsAt) {
            const virtualTop = vertical.mapping.toVirtual(top);
            const covered = stackBottom(stuckAt(virtualTop), index);
            if (bounds.top - virtualTop < covered) {
                top = vertical.mapping.toPhysical(bounds.top - covered);
            }
        }
        if (Math.abs(top - viewport.scrollTop()) >= 0.5) {
            viewport.setScrollTop(top);
        }
    };

    return {
        getRowBounds(rowId) {
            const index = options.source().indexOf(rowId);

            return index === undefined ? pinnedBounds(rowId) : rowBoundsAt(index);
        },
        getRowBoundsAtIndex: rowBoundsAt,
        getCellBounds: cellBounds,
        getCellAnchor(cell) {
            const bounds = cellBounds(cell);
            if (!bounds) {
                return undefined;
            }
            const rect = viewport.rect();
            const area = body();
            const column = columns.getColumn(cell.colId);
            // A stuck group row is where it sticks; other body rows are hidden while under the stuck rows.
            const stuckRows = stuckAt(virtualScrollTop());
            const stuck = stuckRows.find((row) => row.id === cell.rowId);
            const viewTop = stuck ? area.top + stuck.top : area.top + bounds.top - virtualScrollTop();
            const viewLeft = options.isFullWidth?.(cell.rowId) ? 0 : bounds.left - viewport.scrollLeft();
            const center = centerArea();
            const isPinnedTop = pinnedTop().some((row) => row.id === cell.rowId);
            const isPinnedBottom = pinnedBottom().some((row) => row.id === cell.rowId);
            const visibleTop = isPinnedTop
                ? options.headerHeight()
                : isPinnedBottom
                  ? area.bottom
                  : area.top + (stuck ? 0 : stackBottom(stuckRows));
            const visibleBottom = isPinnedTop ? area.top : isPinnedBottom ? viewport.clientHeight() : area.bottom;
            const verticallyVisible = viewTop + bounds.height > visibleTop && viewTop < visibleBottom;
            const horizontallyVisible =
                column?.section !== 'center' || (viewLeft + bounds.width > center.left && viewLeft < center.right);

            return {
                top: rect.top + viewTop,
                left: rect.left + viewLeft,
                width: bounds.width,
                height: bounds.height,
                visible: verticallyVisible && horizontallyVisible,
            };
        },
        getRowIndexAtOffset,
        hitTest(clientX, clientY): HitTestResult {
            const rect = viewport.rect();
            const x = clientX - rect.left;
            const y = clientY - rect.top;
            if (x < 0 || y < 0 || x >= viewport.clientWidth() || y >= viewport.clientHeight()) {
                return { area: 'outside' };
            }
            const colId = columnAtViewportX(x);
            const header = options.headerHeight();
            if (y < header) {
                return { area: 'header', colId, groupId: null };
            }
            const area = body();
            const pinnedRow = (
                rows: readonly { id: RowId; height: number }[],
                start: number,
                section: 'top' | 'bottom'
            ): HitTestResult | null => {
                let cursor = start;
                for (const row of rows) {
                    if (y >= cursor && y < cursor + row.height) {
                        return { area: 'pinnedRow', rowId: row.id, colId, section };
                    }
                    cursor += row.height;
                }

                return null;
            };
            if (y < area.top) {
                return pinnedRow(pinnedTop(), header, 'top') ?? { area: 'empty' };
            }
            if (y >= area.bottom) {
                return (
                    pinnedRow(pinnedBottom(), area.bottom - (options.pinnedBottomScrollTop?.() ?? 0), 'bottom') ?? {
                        area: 'empty',
                    }
                );
            }
            // A stuck group row covers the rows scrolling beneath it.
            const stuck = stuckAt(virtualScrollTop()).find(
                (candidate) => y - area.top >= candidate.top && y - area.top < candidate.top + candidate.height
            );
            const index = stuck ? stuck.index : getRowIndexAtOffset(virtualScrollTop() + (y - area.top));
            const row = index === undefined ? undefined : options.source().rowAt(index);
            if (index === undefined || !row) {
                return { area: 'empty' };
            }
            if (options.isFullWidth?.(row.id)) {
                return { area: 'fullWidthRow', rowId: row.id, rowIndex: index };
            }
            if (colId === null) {
                return { area: 'empty' };
            }

            return {
                area: 'cell',
                cell: { rowId: row.id, colId },
                rowIndex: index,
                section: columns.getColumn(colId)!.section,
            };
        },
        edgeProximity(clientX, clientY): EdgeProximity {
            const rect = viewport.rect();
            const area = body();
            const center = centerArea();
            const x = clientX - rect.left;
            const y = clientY - rect.top;

            return { top: y - area.top, bottom: area.bottom - y, left: x - center.left, right: center.right - x };
        },
        getScroll(): ScrollPosition {
            return { top: virtualScrollTop(), left: viewport.scrollLeft() };
        },
        setScroll,
        scrollBy(delta) {
            setScroll({
                ...(delta.top !== undefined ? { top: virtualScrollTop() + delta.top } : {}),
                ...(delta.left !== undefined ? { left: viewport.scrollLeft() + delta.left } : {}),
            });
        },
        getVisibleRange(): VisibleRange {
            const window = vertical.getWindow();
            const mainRun = window.runs.find(
                (run) => run.start <= window.firstVisible && run.end >= window.firstVisible
            ) ?? { start: window.firstVisible, end: window.lastVisible };
            const mounted = options.mountedRows?.() ?? { first: mainRun.start, last: mainRun.end };
            const scrollLeft = viewport.scrollLeft();
            const visibleWidth = Math.max(viewport.clientWidth() - columns.leftWidth - columns.rightWidth, 0);
            const centerColumns = columns.getColumns().filter((column) => column.section === 'center');
            const visibleColumns = centerColumns.filter(
                (column) => column.left + column.width > scrollLeft && column.left < scrollLeft + visibleWidth
            );
            const horizontal = columns.getWindow(scrollLeft, viewport.clientWidth(), options.overscanColumns ?? 300);
            const mainColumns = horizontal.centerRuns.find(
                (run) =>
                    visibleColumns.length === 0 ||
                    (run.start <= visibleColumns[0]!.index && run.end >= visibleColumns[0]!.index)
            );

            return {
                firstRow: window.firstVisible,
                lastRow: window.lastVisible,
                firstMountedRow: mounted.first,
                lastMountedRow: mounted.last,
                firstColumn: visibleColumns[0]?.index ?? -1,
                lastColumn: visibleColumns[visibleColumns.length - 1]?.index ?? -1,
                firstMountedColumn: mainColumns?.start ?? -1,
                lastMountedColumn: mainColumns?.end ?? -1,
            };
        },
        getContentSize() {
            return { width: columns.totalWidth, height: vertical.mapping.virtualTotal };
        },
        getViewportSize() {
            return { width: viewport.clientWidth(), height: body().height };
        },
        ensureIndexVisible(index, align = 'auto') {
            ensureVertical(index, align);
        },
        ensureCellVisible(cell, align = 'auto') {
            const index = options.source().indexOf(cell.rowId);
            if (index !== undefined) {
                ensureVertical(index, align);
            }
            const left = columns.scrollLeftForColumn(cell.colId, viewport.scrollLeft(), viewport.clientWidth());
            if (Math.abs(left - viewport.scrollLeft()) >= 0.5) {
                viewport.setScrollLeft(left);
            }
        },
        resetRowHeights(rowIds) {
            options.resetRowHeights?.(rowIds);
        },
    };
}

/** A viewport adapter over a real scroll element. */
export function elementViewport(element: () => HTMLElement | null): ViewportAdapter {
    return {
        rect: () => element()?.getBoundingClientRect() ?? { top: 0, left: 0, width: 0, height: 0 },
        clientWidth: () => element()?.clientWidth ?? 0,
        clientHeight: () => element()?.clientHeight ?? 0,
        scrollTop: () => element()?.scrollTop ?? 0,
        scrollLeft: () => element()?.scrollLeft ?? 0,
        setScrollTop: (top) => {
            const target = element();
            if (target) {
                target.scrollTop = top;
            }
        },
        setScrollLeft: (left) => {
            const target = element();
            if (target) {
                target.scrollLeft = left;
            }
        },
    };
}
