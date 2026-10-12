/**
 * Builds the grid's `GeometryApi` from the two virtualizers and emits the viewport events
 * (`scroll`, `visibleRangeChanged`) after each render that moved the viewport.
 */
import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react';

import type { GeometryApi, GridEventMap, RowId, VisibleRange } from '../contract';
import { EventBus } from '../grid/eventBus';
import { createGeometry, elementViewport } from '../grid/geometry';
import type { StuckRow } from '../grid/stickyRows';
import type { RowSource } from '../virtual/verticalLayout';
import type { HorizontalVirtualizer } from './useHorizontalVirtualizer';
import type { VerticalVirtualizer } from './useVerticalVirtualizer';

export type GridGeometryOptions<TData> = {
    scrollRef: RefObject<HTMLElement | null>;
    vertical: VerticalVirtualizer<TData>;
    horizontal: HorizontalVirtualizer;
    source: RowSource<TData>;
    headerHeight: number;
    pinnedTop?: readonly { id: RowId; height: number }[];
    pinnedBottom?: readonly { id: RowId; height: number }[];
    pinnedBottomHeight?: number;
    pinnedBottomScrollTop?: () => number;
    isFullWidth?: (rowId: RowId) => boolean;
    stickyRowsAt?: (scrollTop: number) => readonly StuckRow[];
    /** The grid's event bus; one is created when omitted. */
    events?: EventBus<GridEventMap<TData>>;
};

export function useGridGeometry<TData>(options: GridGeometryOptions<TData>): {
    geometry: GeometryApi;
    events: EventBus<GridEventMap<TData>>;
} {
    // Geometry reads the latest options through a ref, so the api object stays stable across renders.
    const latest = useRef(options);
    latest.current = options;
    const ownBus = useMemo(() => new EventBus<GridEventMap<TData>>(), []);
    const events = options.events ?? ownBus;

    const geometry = useMemo(
        () =>
            createGeometry<TData>({
                vertical: options.vertical.layout,
                columns: options.horizontal.layout,
                source: () => latest.current.source,
                viewport: elementViewport(() => latest.current.scrollRef.current),
                headerHeight: () => latest.current.headerHeight,
                pinnedTop: () => latest.current.pinnedTop ?? [],
                pinnedBottom: () => latest.current.pinnedBottom ?? [],
                pinnedBottomHeight: () =>
                    latest.current.pinnedBottomHeight ??
                    (latest.current.pinnedBottom ?? []).reduce((sum, row) => sum + row.height, 0),
                pinnedBottomScrollTop: () => latest.current.pinnedBottomScrollTop?.() ?? 0,
                isFullWidth: (rowId) => latest.current.isFullWidth?.(rowId) ?? false,
                stickyRowsAt: (scrollTop) => latest.current.stickyRowsAt?.(scrollTop) ?? [],
                mountedRows: () => {
                    const runs = latest.current.vertical.window.runs;
                    const window = latest.current.vertical.window;
                    const main = runs.find((run) => run.start <= window.firstVisible && run.end >= window.firstVisible);

                    return { first: main?.start ?? -1, last: main?.end ?? -1 };
                },
                resetRowHeights: (rowIds) => latest.current.vertical.resetHeights(rowIds),
            }),
        [options.vertical.layout, options.horizontal.layout]
    );

    const previous = useRef<{ range: VisibleRange | null; top: number; left: number }>({
        range: null,
        top: Number.NaN,
        left: Number.NaN,
    });
    useLayoutEffect(() => {
        const scroll = geometry.getScroll();
        if (scroll.top !== previous.current.top || scroll.left !== previous.current.left) {
            previous.current.top = scroll.top;
            previous.current.left = scroll.left;
            events.emit('scroll', { top: scroll.top, left: scroll.left, source: 'user' });
        }
        const range = geometry.getVisibleRange();
        if (!sameRange(range, previous.current.range)) {
            previous.current.range = range;
            events.emit('visibleRangeChanged', { range });
        }
    });

    return { geometry, events };
}

function sameRange(a: VisibleRange, b: VisibleRange | null): boolean {
    return (
        b !== null &&
        a.firstRow === b.firstRow &&
        a.lastRow === b.lastRow &&
        a.firstMountedRow === b.firstMountedRow &&
        a.lastMountedRow === b.lastMountedRow &&
        a.firstColumn === b.firstColumn &&
        a.lastColumn === b.lastColumn &&
        a.firstMountedColumn === b.firstMountedColumn &&
        a.lastMountedColumn === b.lastMountedColumn
    );
}
