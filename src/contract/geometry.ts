/**
 * Viewport geometry.
 *
 * One coordinate space covers header, body, pinned columns and pinned rows: "content" coordinates, where
 * (0, 0) is the top left of the first body row at the left edge of the grid content (the first left pinned
 * column, or the first center column when nothing is pinned left), before scrolling. Vertical content
 * coordinates are virtual: on a scaled million-row grid they keep their true row offsets. Viewport
 * coordinates are content coordinates minus the scroll offset. Client coordinates are the browser's.
 * Pinned columns sit at their sticky position: their content x includes the current horizontal scroll.
 *
 * All geometry is computed from the height index and column width model, so rows that are not mounted
 * still have bounds. Consumers never need to query grid DOM.
 */
import type { RowId } from './rows';
import type { CellPosition } from './state';

export type Rect = { top: number; left: number; width: number; height: number };

/** A rect in client coordinates plus the element it is relative to, for portals and popups. */
export type AnchorRect = Rect & {
    /** False when the anchor is scrolled out of view; popups should hide or clamp. */
    visible: boolean;
};

export type VisibleRange = {
    /** First and last displayed row indexes that intersect the viewport, without overscan. */
    firstRow: number;
    lastRow: number;
    /** Same, including overscan. These rows are mounted. */
    firstMountedRow: number;
    lastMountedRow: number;
    /** Center column indexes that intersect the viewport, and the mounted range. Pinned columns are always mounted. */
    firstColumn: number;
    lastColumn: number;
    firstMountedColumn: number;
    lastMountedColumn: number;
};

export type ScrollPosition = { top: number; left: number };

export type ScrollAlignment = 'auto' | 'start' | 'center' | 'end';

export type HitTestResult =
    | { area: 'cell'; cell: CellPosition; rowIndex: number; section: 'left' | 'center' | 'right' }
    | { area: 'fullWidthRow'; rowId: RowId; rowIndex: number }
    | { area: 'header'; colId: string | null; groupId: string | null }
    | { area: 'pinnedRow'; rowId: RowId; colId: string | null; section: 'top' | 'bottom' }
    | { area: 'empty' }
    | { area: 'outside' };

/** Distance-to-edge information for drag autoscroll. */
export type EdgeProximity = { top: number; bottom: number; left: number; right: number };

export type GeometryApi = {
    /** Row bounds in content coordinates. Undefined when the row is not displayed. */
    getRowBounds(rowId: RowId): Rect | undefined;
    getRowBoundsAtIndex(index: number): Rect | undefined;
    /** Cell bounds in content coordinates. Pinned columns report their sticky position at the current scroll. */
    getCellBounds(cell: CellPosition): Rect | undefined;
    /** Cell rect in client coordinates, for anchoring popups, tooltips and collaboration cursors. */
    getCellAnchor(cell: CellPosition): AnchorRect | undefined;
    /** Row index at a content y offset. O(log n) through the height index. */
    getRowIndexAtOffset(y: number): number | undefined;
    hitTest(clientX: number, clientY: number): HitTestResult;
    edgeProximity(clientX: number, clientY: number): EdgeProximity;

    getScroll(): ScrollPosition;
    setScroll(position: Partial<ScrollPosition>): void;
    scrollBy(delta: Partial<ScrollPosition>): void;
    getVisibleRange(): VisibleRange;
    /** Total content size. Height uses measured heights where known and estimates elsewhere. */
    getContentSize(): { width: number; height: number };
    getViewportSize(): { width: number; height: number };

    ensureIndexVisible(index: number, align?: ScrollAlignment): void;
    ensureCellVisible(cell: CellPosition, align?: ScrollAlignment): void;

    /** Drops measured heights so rows are measured again. Scroll anchor is preserved. */
    resetRowHeights(rowIds?: RowId[]): void;
};
