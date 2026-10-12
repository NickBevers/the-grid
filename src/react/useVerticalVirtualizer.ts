/**
 * React binding for `VerticalLayout`: listens to the scroll element, measures rows, and applies scroll
 * corrections before the browser paints, so height changes and row changes never show as a jump.
 *
 * The scroll element is the grid viewport (`overflow: auto`, `overflow-anchor: none`). Rows render in
 * normal flow between spacer divs; nothing is absolutely positioned or translated.
 */
import { useCallback, useLayoutEffect, useReducer, useRef, type RefObject } from 'react';
import { flushSync } from 'react-dom';

import type { GridRow, RowHeight, RowId } from '../contract';
import { VerticalLayout, type RowSource, type ScrollCorrection, type VerticalWindow } from '../virtual/verticalLayout';

export type VerticalVirtualizerOptions<TData> = {
    scrollRef: RefObject<HTMLElement | null>;
    source: RowSource<TData>;
    /** Changes whenever the displayed rows change (a projection version). */
    sourceVersion: unknown;
    estimatedRowHeight: number;
    rowHeight?: RowHeight<TData>;
    overscan?: number;
    /** Pixels at the top and bottom of the scroll element covered by sticky parts (header, pinned rows). */
    insetTop?: number;
    insetBottom?: number;
    /** Rows kept mounted while scrolled away: the focused row and the row being edited. */
    retainedIds?: readonly RowId[];
};

export type VerticalVirtualizer<TData> = {
    layout: VerticalLayout<TData>;
    /** Forgets measured heights (all, or some rows), measures the mounted rows again, and keeps the view still. */
    resetHeights: (ids?: readonly RowId[]) => void;
    window: VerticalWindow;
    rowAt: (index: number) => GridRow<TData> | undefined;
    /** Ref callback for rows that are measured. Rows with a fixed height get `fixedHeight` instead. */
    measureRef: (element: HTMLElement | null) => (() => void) | undefined;
    fixedHeight: (row: GridRow<TData>) => number | undefined;
    scrollToIndex: (index: number, align?: 'auto' | 'start' | 'center' | 'end') => void;
};

export function useVerticalVirtualizer<TData>(options: VerticalVirtualizerOptions<TData>): VerticalVirtualizer<TData> {
    const { scrollRef, source, sourceVersion, insetTop = 0, insetBottom = 0 } = options;
    const [, rerender] = useReducer((value: number) => value + 1, 0);
    const layoutRef = useRef<VerticalLayout<TData> | null>(null);
    layoutRef.current ??= new VerticalLayout<TData>({
        estimatedRowHeight: options.estimatedRowHeight,
        ...(options.rowHeight !== undefined ? { rowHeight: options.rowHeight } : {}),
        ...(options.overscan !== undefined ? { overscan: options.overscan } : {}),
    });
    const layout = layoutRef.current;
    const pendingCorrection = useRef<ScrollCorrection>(null);
    /**
     * A scroll-to request is re-applied while the rows around it are measured, so 'end' really ends at
     * the last row once estimated heights become real. User input or a settled position ends it.
     */
    const scrollTarget = useRef<{
        index: number;
        align: 'auto' | 'start' | 'center' | 'end';
        until: number;
    } | null>(null);
    const versionRef = useRef<{ version: unknown } | null>(null);
    /**
     * The exact scrollTop last assigned by us. Some engines (WebKit) round scrollTop to whole pixels; the
     * scroll event then reports the rounded value, and correcting from that would add up the rounding.
     */
    const assignedTop = useRef<number | null>(null);
    const assignScrollTop = (element: HTMLElement, top: number) => {
        assignedTop.current = top;
        element.scrollTop = top;
    };

    // The row list changed: rebuild during render so this render already uses the new rows; the scroll
    // correction is applied to the DOM in the layout effect below, before paint.
    if (versionRef.current === null || versionRef.current.version !== sourceVersion) {
        versionRef.current = { version: sourceVersion };
        // A programmatic scroll's event has not fired yet when rows change in the same task: anchor to where
        // the element is now, not to the last scroll event, or the correction would undo that scroll.
        const element = scrollRef.current;
        const assigned = assignedTop.current;
        if (
            element &&
            Math.abs(element.scrollTop - layout.scrollTop) >= 1 &&
            (assigned === null || Math.abs(element.scrollTop - assigned) >= 1)
        ) {
            layout.setViewport(element.scrollTop, layout.viewportHeight);
        }
        pendingCorrection.current = layout.setSource(source) ?? pendingCorrection.current;
    }
    layout.setRetained(options.retainedIds ?? []);

    useLayoutEffect(() => {
        const correction = pendingCorrection.current;
        pendingCorrection.current = null;
        const element = scrollRef.current;
        if (correction && element && Math.abs(element.scrollTop - correction.scrollTop) >= 0.5) {
            assignScrollTop(element, correction.scrollTop);
        }
    });

    // Scroll position and viewport size.
    useLayoutEffect(() => {
        const element = scrollRef.current;
        if (!element) {
            return;
        }
        let first = true;
        // `fromEvent` is false for the initial sync inside this effect, where React does not allow flushSync.
        const sync = (fromEvent = true) => {
            const actual = element.scrollTop;
            const assigned = assignedTop.current;
            // Keep our exact value when the element only rounded it; any real movement replaces it.
            const top = assigned !== null && Math.abs(actual - assigned) < 1 ? assigned : actual;
            if (assigned !== null && top === actual) {
                assignedTop.current = null;
            }
            const height = Math.max(element.clientHeight - insetTop - insetBottom, 0);
            // A horizontal scroll fires the same event; the horizontal virtualizer renders for that one.
            if (!first && top === layout.scrollTop && height === layout.viewportHeight) {
                return;
            }
            first = false;
            layout.setViewport(top, height);
            // Render inside the scroll event, like a React onScroll handler would: a default-priority update
            // lands a frame late and doubles frame time in some engines.
            if (fromEvent) {
                flushSync(rerender);
            } else {
                rerender();
            }
        };
        const onScroll = () => sync();
        sync(false);
        const releaseTarget = () => {
            scrollTarget.current = null;
        };
        const userInput = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
        element.addEventListener('scroll', onScroll, { passive: true });
        userInput.forEach((type) => element.addEventListener(type, releaseTarget, { passive: true }));
        const observer = new ResizeObserver(() => sync());
        observer.observe(element);

        return () => {
            element.removeEventListener('scroll', onScroll);
            userInput.forEach((type) => element.removeEventListener(type, releaseTarget));
            observer.disconnect();
        };
    }, [scrollRef, layout, insetTop, insetBottom]);

    // Row measurement.
    const observerRef = useRef<ResizeObserver | null>(null);
    // The observer is created on first use, not in an effect: React attaches ref callbacks during commit,
    // before layout effects run, so rows of the first commit would otherwise never be observed (in
    // production; StrictMode's second mount hid this in development).
    const handleResize = useRef<(entries: ResizeObserverEntry[]) => void>(() => {});
    handleResize.current = (entries) => {
        const element = scrollRef.current;
        const heights: { id: RowId; height: number }[] = [];
        for (const entry of entries) {
            const target = entry.target as HTMLElement;
            const id = target.dataset.rowId;
            if (!target.isConnected || id === undefined) {
                continue;
            }
            heights.push({ id, height: entry.borderBoxSize[0]?.blockSize ?? target.offsetHeight });
        }
        if (!element || heights.length === 0) {
            return;
        }
        const scaled = layout.mapping.scaled;
        const anchoring = layout.recordHeights(heights);
        const target = scrollTarget.current;
        let correction = anchoring;
        if (target) {
            // A pending scroll-to wins over anchoring: aim at the target again with the new heights.
            const top = layout.scrollTopForIndex(target.index, target.align);
            correction = Math.abs(top - element.scrollTop) >= 0.5 ? { scrollTop: top } : null;
            if (!correction || performance.now() > target.until) {
                scrollTarget.current = null;
            }
        }
        if (!scaled && !layout.mapping.scaled) {
            // Unscaled, the DOM is already consistent: grown rows pushed content down by exactly the
            // delta, so moving scrollTop by the same amount keeps the view still. A normal render follows.
            if (correction) {
                assignScrollTop(element, correction.scrollTop);
            }
            rerender();
            return;
        }
        // Scaled, spacer sizes depend on the mapping, so the DOM must update in the same frame.
        flushSync(rerender);
        if (correction) {
            assignScrollTop(element, correction.scrollTop);
        }
    };
    const getObserver = () => (observerRef.current ??= new ResizeObserver((entries) => handleResize.current(entries)));
    useLayoutEffect(
        () => () => {
            observerRef.current?.disconnect();
            observerRef.current = null;
        },
        []
    );

    // Measured row elements that are mounted, so a reset can read them again without waiting for a resize.
    const measuredElements = useRef(new Set<HTMLElement>());
    const measureRef = useCallback((element: HTMLElement | null) => {
        if (!element) {
            return undefined;
        }
        const observer = getObserver();
        observer.observe(element);
        measuredElements.current.add(element);

        return () => {
            observer.unobserve(element);
            measuredElements.current.delete(element);
        };
    }, []);

    const resetHeights = useCallback(
        (ids?: readonly RowId[]) => {
            const element = scrollRef.current;
            const apply = (correction: ScrollCorrection) => {
                if (correction && element) {
                    assignScrollTop(element, correction.scrollTop);
                }
            };
            apply(layout.resetHeights(ids));
            // Mounted rows keep their size, so no resize notification will come: read them now.
            const wanted = ids ? new Set(ids) : null;
            const heights: { id: RowId; height: number }[] = [];
            for (const row of measuredElements.current) {
                const id = row.dataset.rowId;
                if (id !== undefined && row.isConnected && (!wanted || wanted.has(id))) {
                    heights.push({ id, height: row.getBoundingClientRect().height });
                }
            }
            apply(layout.recordHeights(heights));
            rerender();
        },
        [scrollRef, layout]
    );

    const fixedHeight = useCallback(
        (row: GridRow<TData>) =>
            layout.shouldMeasure(row) ? undefined : layout.getRowBounds(source.indexOf(row.id) ?? -1)?.height,
        [layout, source]
    );

    const scrollToIndex = useCallback(
        (index: number, align: 'auto' | 'start' | 'center' | 'end' = 'auto') => {
            const element = scrollRef.current;
            if (element) {
                scrollTarget.current = { index, align, until: performance.now() + 1000 };
                assignScrollTop(element, layout.scrollTopForIndex(index, align));
            }
        },
        [scrollRef, layout]
    );

    return {
        layout,
        resetHeights,
        window: layout.getWindow(),
        rowAt: source.rowAt,
        measureRef,
        fixedHeight,
        scrollToIndex,
    };
}
