/**
 * Vertical layout: which rows to mount, the spacer sizes that place them in normal flow, and the scroll
 * corrections that keep the view still while heights and rows change.
 *
 * Framework-free. The React layer feeds it scroll positions, viewport size, row sources and measured
 * heights, and applies the `scrollTop` it returns. Heights are stored by row id, so a measured row keeps
 * its height when rows above it are inserted, removed, collapsed or reloaded.
 *
 * Anchoring keeps the first visible row at the same distance from the viewport top:
 * - when rows above it change height (measurement, `resetHeights`),
 * - when the row list changes (expand, collapse, sort, refresh), by finding the anchor row by id; if it
 *   disappeared, the next surviving row below it is used, then the one above.
 */
import type { GridRow, RowHeight, RowId } from '../contract';
import { HeightIndex } from './heightIndex';
import { createScrollMapping, DEFAULT_MAX_PHYSICAL_HEIGHT, type ScrollMapping } from './scrollMapping';
import { computeWindow, type IndexRun, type LayoutItem } from './window';

/** What the layout needs from a projection (local or server). */
export type RowSource<TData> = {
    readonly count: number;
    rowAt(index: number): GridRow<TData> | undefined;
    indexOf(id: RowId): number | undefined;
    /** Rows whose height the rule can decide without measuring: every displayed row locally, loaded rows remotely. */
    forEachKnown(callback: (row: GridRow<TData>, index: number) => void): void;
};

export type VerticalLayoutOptions<TData> = {
    /** Height used for rows that are not measured yet. */
    estimatedRowHeight: number;
    /** Fixed height for all rows, a fixed height per row, or 'measure' to use the rendered height. */
    rowHeight?: RowHeight<TData>;
    /** Extra pixels mounted above and below the viewport. */
    overscan?: number;
    maxPhysicalHeight?: number;
};

export type VerticalWindow = {
    items: LayoutItem[];
    runs: IndexRun[];
    firstVisible: number;
    lastVisible: number;
    /** Physical scroll height of the rows (spacers plus rows). */
    totalHeight: number;
};

export type ScrollCorrection = { scrollTop: number } | null;

/** How far to look for surviving neighbours of the anchor, and how many to keep. */
const NEIGHBOUR_SCAN = 200;
const NEIGHBOUR_KEEP = 50;

function isLoaded<TData>(row: GridRow<TData> | undefined): boolean {
    return row !== undefined && row.kind !== 'loading' && row.kind !== 'failed';
}

type ResolvedOptions<TData> = {
    estimatedRowHeight: number;
    rowHeight: RowHeight<TData>;
    overscan: number;
    maxPhysicalHeight: number;
};

type Anchor = { id: RowId; offsetInViewport: number; followers: RowId[]; leaders: RowId[] };

export class VerticalLayout<TData> {
    readonly #options: ResolvedOptions<TData>;
    readonly #heights: HeightIndex;
    readonly #measured = new Map<RowId, number>();
    #source: RowSource<TData> = { count: 0, rowAt: () => undefined, indexOf: () => undefined, forEachKnown: () => {} };
    #scrollTop = 0;
    #viewportHeight = 0;
    #retained = new Set<RowId>();
    #mapping: ScrollMapping;
    /**
     * The anchor as of the last consistent state. Captured after every change, not when the next change
     * arrives: a mutable source (the server projection) may already hold the new rows by then.
     */
    #anchor: Anchor | null = null;

    constructor(options: VerticalLayoutOptions<TData>) {
        this.#options = {
            estimatedRowHeight: options.estimatedRowHeight,
            rowHeight: options.rowHeight ?? 'measure',
            overscan: options.overscan ?? 400,
            maxPhysicalHeight: options.maxPhysicalHeight ?? DEFAULT_MAX_PHYSICAL_HEIGHT,
        };
        this.#heights = new HeightIndex(0, options.estimatedRowHeight);
        this.#mapping = createScrollMapping(0, 0, this.#options.maxPhysicalHeight);
    }

    get scrollTop(): number {
        return this.#scrollTop;
    }

    get viewportHeight(): number {
        return this.#viewportHeight;
    }

    get mapping(): ScrollMapping {
        return this.#mapping;
    }

    /** Whether rows of this kind are measured in the DOM (the rule returned 'measure'). */
    shouldMeasure(row: GridRow<TData>): boolean {
        return this.#fixedHeight(row) === null;
    }

    /** The physical scroll position and the visible body height (viewport minus sticky header and footer). */
    setViewport(scrollTop: number, viewportHeight: number): void {
        this.#scrollTop = scrollTop;
        if (viewportHeight !== this.#viewportHeight) {
            this.#viewportHeight = viewportHeight;
            this.#remap();
        }
        this.#anchor = this.#captureAnchor();
    }

    /** Rows kept mounted outside the window: the focused row and the row being edited. */
    setRetained(ids: Iterable<RowId>): void {
        this.#retained = new Set(ids);
    }

    /**
     * Replaces the row source after the displayed rows changed. Rebuilds the height index from stored
     * measurements and returns the scroll position that keeps the anchor row in place.
     */
    setSource(source: RowSource<TData>): ScrollCorrection {
        const anchor = this.#anchor;
        this.#source = source;
        this.#rebuild();
        const correction = this.#restoreAnchor(anchor);
        this.#anchor = this.#captureAnchor();

        return correction;
    }

    /**
     * Stores rendered heights. Returns the scroll position that keeps the view still when rows above the
     * first visible row changed height, or null when no correction is needed.
     */
    recordHeights(entries: Iterable<{ id: RowId; height: number }>): ScrollCorrection {
        const anchorIndex = this.#firstVisibleIndex();
        const virtualTopBefore = this.#mapping.toVirtual(this.#scrollTop);
        // Elastic overscroll at the top (negative scrollTop) belongs to the browser. Past the bottom it does
        // not: the new range clamps the position anyway, so the anchor must decide where it lands.
        const elasticTop = this.#scrollTop < 0;
        let deltaAbove = 0;
        let changed = false;
        for (const { id, height } of entries) {
            if (!(height > 0)) {
                continue;
            }
            this.#measured.set(id, height);
            const index = this.#source.indexOf(id);
            if (index === undefined) {
                continue;
            }
            const row = this.#source.rowAt(index);
            if (row && !this.shouldMeasure(row)) {
                continue;
            }
            const delta = this.#heights.set(index, height);
            if (delta !== 0) {
                changed = true;
                if (index < anchorIndex) {
                    deltaAbove += delta;
                }
            }
        }
        if (!changed) {
            return null;
        }
        this.#remap();
        // Nothing above the anchor moved: unscaled nothing needs to move, and during top overscroll the browser
        // owns the position.
        if (deltaAbove === 0 && (elasticTop || !this.#mapping.scaled)) {
            this.#anchor = this.#captureAnchor();

            return null;
        }
        // Keep the same virtual row under the viewport top. Scaled, a change anywhere rescales the mapping,
        // so this can move scrollTop even when nothing above the anchor changed.
        const target = this.#clampScroll(this.#mapping.toPhysical(virtualTopBefore + deltaAbove));
        const moved = Math.abs(target - this.#scrollTop) > 1e-6;
        this.#scrollTop = target;
        this.#anchor = this.#captureAnchor();

        return moved ? { scrollTop: target } : null;
    }

    /** Forgets measurements (all, or some rows) so they are measured again, keeping the anchor row in place. */
    resetHeights(ids?: Iterable<RowId>): ScrollCorrection {
        const anchor = this.#anchor ?? this.#captureAnchor();
        if (ids) {
            for (const id of ids) {
                this.#measured.delete(id);
            }
        } else {
            this.#measured.clear();
        }
        this.#rebuild();
        const correction = this.#restoreAnchor(anchor);
        this.#anchor = this.#captureAnchor();

        return correction;
    }

    /** Rows to mount and the spacers around them, for the current scroll position. */
    getWindow(): VerticalWindow {
        const retained: number[] = [];
        for (const id of this.#retained) {
            const index = this.#source.indexOf(id);
            if (index !== undefined) {
                retained.push(index);
            }
        }
        const result = computeWindow({
            sizes: this.#heights,
            mapping: this.#mapping,
            scroll: this.#scrollTop,
            viewportSize: this.#viewportHeight,
            overscan: this.#options.overscan,
            retained,
        });

        return {
            items: result.items,
            runs: result.runs,
            firstVisible: result.firstVisible,
            lastVisible: result.lastVisible,
            totalHeight: this.#mapping.physicalTotal,
        };
    }

    /** Row bounds in virtual content coordinates (top of the first row is 0), independent of mounting. */
    getRowBounds(index: number): { top: number; height: number } | undefined {
        if (index < 0 || index >= this.#heights.count) {
            return undefined;
        }

        return { top: this.#heights.offsetOf(index), height: this.#heights.get(index) };
    }

    /** Row index at a virtual content offset. */
    getIndexAtOffset(offset: number): number | undefined {
        const index = this.#heights.indexAt(offset);

        return index < 0 ? undefined : index;
    }

    /** Virtual offset of the viewport top. */
    getVirtualScrollTop(): number {
        return this.#mapping.toVirtual(this.#scrollTop);
    }

    /**
     * The physical scrollTop that shows the row at `index`. 'auto' scrolls only when the row is not fully
     * visible, by the smallest distance. Returns the current scrollTop when no scroll is needed.
     */
    scrollTopForIndex(index: number, align: 'auto' | 'start' | 'center' | 'end' = 'auto'): number {
        const bounds = this.getRowBounds(Math.min(Math.max(index, 0), this.#heights.count - 1));
        if (!bounds) {
            return this.#scrollTop;
        }
        const viewTop = this.#mapping.toVirtual(this.#scrollTop);
        const viewHeight = this.#viewportHeight;
        const bottom = bounds.top + bounds.height;
        let target: number;
        switch (align) {
            case 'start':
                target = bounds.top;
                break;
            case 'end':
                target = bottom - viewHeight;
                break;
            case 'center':
                target = bounds.top - (viewHeight - bounds.height) / 2;
                break;
            default:
                if (bounds.top < viewTop) {
                    target = bounds.top;
                } else if (bottom > viewTop + viewHeight) {
                    target = Math.min(bounds.top, bottom - viewHeight);
                } else {
                    return this.#scrollTop;
                }
        }

        return this.#mapping.toPhysical(Math.max(0, target));
    }

    // Internals

    #fixedHeight(row: GridRow<TData>): number | null {
        const rule = this.#options.rowHeight;
        if (typeof rule === 'number') {
            return rule;
        }
        if (rule === 'measure') {
            return null;
        }
        const value = rule(row);

        return value === 'measure' ? null : value;
    }

    #rebuild(): void {
        const count = this.#source.count;
        if (typeof this.#options.rowHeight === 'number') {
            // Uniform fixed height: nothing about individual rows matters, only how many there are. This
            // keeps block arrivals on a million-row source from walking every row.
            if (this.#heights.count !== count || this.#heights.estimate !== this.#options.rowHeight) {
                this.#heights.setEstimate(this.#options.rowHeight);
                this.#heights.setCount(count);
            }
            this.#remap();
            return;
        }
        const heights = new Float64Array(count).fill(Number.NaN);
        {
            this.#source.forEachKnown((row, index) => {
                if (index < 0 || index >= count) {
                    return;
                }
                const fixed = this.#fixedHeight(row);
                if (fixed !== null) {
                    heights[index] = fixed;
                    return;
                }
                const measured = this.#measured.get(row.id);
                if (measured !== undefined) {
                    heights[index] = measured;
                }
            });
        }
        this.#heights.load(count, (index) => {
            const value = heights[index]!;

            return Number.isNaN(value) ? undefined : value;
        });
        this.#remap();
    }

    #remap(): void {
        this.#mapping = createScrollMapping(this.#heights.total, this.#viewportHeight, this.#options.maxPhysicalHeight);
        // Only the upper bound: content may have shrunk. A negative position is elastic overscroll (Safari)
        // and is left to the browser.
        this.#scrollTop = Math.min(this.#scrollTop, Math.max(0, this.#mapping.physicalTotal - this.#viewportHeight));
    }

    #clampScroll(top: number): number {
        return Math.min(Math.max(top, 0), Math.max(0, this.#mapping.physicalTotal - this.#viewportHeight));
    }

    #firstVisibleIndex(): number {
        return this.#heights.count === 0 ? 0 : this.#heights.indexAt(this.#mapping.toVirtual(this.#scrollTop));
    }

    /**
     * The anchor is the first loaded row inside the viewport. Placeholders are skipped: their ids change when
     * data arrives, so they cannot be found again. Neighbour lists are bounded so capturing stays cheap on a
     * million sparse rows.
     */
    #captureAnchor(): Anchor | null {
        if (this.#heights.count === 0 || this.#scrollTop <= 0) {
            // At the very top the natural anchor is the top itself: new rows above should push content down.
            return null;
        }
        const virtualTop = this.#mapping.toVirtual(this.#scrollTop);
        const first = this.#heights.indexAt(virtualTop);
        const last = Math.min(this.#heights.indexAt(virtualTop + this.#viewportHeight), this.#source.count - 1);
        let index = -1;
        for (let candidate = first; candidate <= last; candidate++) {
            if (isLoaded(this.#source.rowAt(candidate))) {
                index = candidate;
                break;
            }
        }
        if (index < 0) {
            return null;
        }
        const neighbours = (from: number, step: 1 | -1): RowId[] => {
            const ids: RowId[] = [];
            for (
                let i = from + step, scanned = 0;
                i >= 0 && i < this.#source.count && scanned < NEIGHBOUR_SCAN && ids.length < NEIGHBOUR_KEEP;
                i += step, scanned++
            ) {
                const neighbour = this.#source.rowAt(i);
                if (isLoaded(neighbour)) {
                    ids.push(neighbour!.id);
                }
            }

            return ids;
        };

        return {
            id: this.#source.rowAt(index)!.id,
            offsetInViewport: this.#heights.offsetOf(index) - virtualTop,
            followers: neighbours(index, 1),
            leaders: neighbours(index, -1),
        };
    }

    #restoreAnchor(anchor: Anchor | null): ScrollCorrection {
        if (!anchor) {
            return null;
        }
        let index = this.#source.indexOf(anchor.id);
        let offset = anchor.offsetInViewport;
        if (index === undefined) {
            // The anchor row is gone (removed or collapsed away). Keep the next surviving row where the anchor
            // was; failing that, the nearest survivor above it, placed just above the viewport top.
            for (const id of anchor.followers) {
                index = this.#source.indexOf(id);
                if (index !== undefined) {
                    break;
                }
            }
            if (index === undefined) {
                for (const id of anchor.leaders) {
                    index = this.#source.indexOf(id);
                    if (index !== undefined) {
                        offset = -this.#heights.get(index);
                        break;
                    }
                }
            }
        }
        if (index === undefined) {
            return null;
        }
        this.#scrollTop = this.#clampScroll(
            this.#mapping.toPhysical(Math.max(0, this.#heights.offsetOf(index) - offset))
        );

        return { scrollTop: this.#scrollTop };
    }
}
