/**
 * React binding for `ColumnLayout`: tracks the scroll element's horizontal scroll and width, and exposes
 * the column window and header group rows for rendering.
 *
 * The window is computed during render from the element's current scrollLeft, so when another hook (the
 * vertical virtualizer) re-renders on the same scroll event, both axes render together in one pass. This
 * hook only triggers a render of its own when the horizontal position or width changed since the last one.
 */
import { useCallback, useLayoutEffect, useReducer, useRef, type RefObject } from 'react';
import { flushSync } from 'react-dom';

import { ColumnLayout, type ColumnSpec, type GroupHeaderRow, type HorizontalWindow } from '../virtual/horizontalLayout';

export type HorizontalVirtualizerOptions = {
    scrollRef: RefObject<HTMLElement | null>;
    columns: readonly ColumnSpec[];
    /** Changes whenever `columns` changes (a definitions version or the array itself). */
    columnsVersion: unknown;
    overscan?: number;
    /** Columns kept mounted while scrolled away: the focused and the editing column. */
    retainedColIds?: readonly string[];
};

export type HorizontalVirtualizer = {
    layout: ColumnLayout;
    window: HorizontalWindow;
    groupRows: GroupHeaderRow[];
    /** Resizes a column (clamped to its min and max) and re-renders. */
    resize: (colId: string, width: number) => number;
    scrollToColumn: (colId: string) => void;
};

export function useHorizontalVirtualizer(options: HorizontalVirtualizerOptions): HorizontalVirtualizer {
    const { scrollRef, columns, columnsVersion, overscan = 300 } = options;
    const [, rerender] = useReducer((value: number) => value + 1, 0);
    const layoutRef = useRef<ColumnLayout | null>(null);
    layoutRef.current ??= new ColumnLayout(columns);
    const layout = layoutRef.current;
    const versionRef = useRef<{ version: unknown } | null>(null);
    if (versionRef.current === null || versionRef.current.version !== columnsVersion) {
        versionRef.current = { version: columnsVersion };
        layout.setColumns(columns);
    }

    const element = scrollRef.current;
    const scrollLeft = element?.scrollLeft ?? 0;
    const viewportWidth = element?.clientWidth ?? 0;
    layout.setViewportWidth(viewportWidth);
    const rendered = useRef({ scrollLeft, viewportWidth });
    rendered.current = { scrollLeft, viewportWidth };

    useLayoutEffect(() => {
        const target = scrollRef.current;
        if (!target) {
            return;
        }
        const changed = () =>
            target.scrollLeft !== rendered.current.scrollLeft || target.clientWidth !== rendered.current.viewportWidth;
        const onScroll = () => {
            if (changed()) {
                flushSync(rerender);
            }
        };
        // Inside this effect React does not allow flushSync; a normal render picks up the real width.
        if (changed()) {
            rerender();
        }
        target.addEventListener('scroll', onScroll, { passive: true });
        const observer = new ResizeObserver(onScroll);
        observer.observe(target);

        return () => {
            target.removeEventListener('scroll', onScroll);
            observer.disconnect();
        };
    }, [scrollRef]);

    const resize = useCallback(
        (colId: string, width: number) => {
            const applied = layout.resize(colId, width);
            flushSync(rerender);

            return applied;
        },
        [layout]
    );

    const scrollToColumn = useCallback(
        (colId: string) => {
            const target = scrollRef.current;
            if (target) {
                target.scrollLeft = layout.scrollLeftForColumn(colId, target.scrollLeft, target.clientWidth);
            }
        },
        [scrollRef, layout]
    );

    const window = layout.getWindow(scrollLeft, viewportWidth, overscan, options.retainedColIds ?? []);

    return { layout, window, groupRows: layout.getGroupHeaderRows(window), resize, scrollToColumn };
}
