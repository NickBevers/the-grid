import { identityMapping } from './identityMapping';
/**
 * Horizontal layout: one width model for the header, header groups, body rows and pinned rows.
 *
 * Columns split into left pinned, center and right pinned sections. Pinned sections are always mounted
 * and stick with `position: sticky`; only the center section is virtualized, with the same spacer and run
 * items as the vertical layout. Header group rows are derived from the same window, so a group cell is
 * always exactly as wide as the columns below it.
 *
 * Widths follow the common column sizing rules: `width`, `minWidth`, `maxWidth`, and `flex` columns sharing the
 * width left over after fixed columns. A resized column keeps the width the user gave it (and stops
 * flexing) until its definition changes that.
 */
import type { IndexRun, LayoutItem, Sizes } from './window';
import { computeWindow } from './window';

export type PinnedSection = 'left' | 'center' | 'right';

export type ColumnSpec = {
    colId: string;
    width?: number;
    minWidth?: number;
    maxWidth?: number;
    flex?: number;
    pinned?: 'left' | 'right' | null;
    /** Group ids from the outermost header group to the innermost. */
    groupPath?: readonly string[];
    /** The cell takes part in the row height, so it stays mounted while scrolling. */
    keepMounted?: boolean;
};

export const DEFAULT_COLUMN_WIDTH = 200;
export const DEFAULT_MIN_WIDTH = 20;

export type LaidOutColumn = {
    colId: string;
    section: PinnedSection;
    /** Index within its section. */
    index: number;
    width: number;
    /** Offset from the start of its section. */
    left: number;
    groupPath: readonly string[];
};

export type HorizontalWindow = {
    left: LaidOutColumn[];
    right: LaidOutColumn[];
    /** Spacers and runs of center column indexes, in order. */
    centerItems: LayoutItem[];
    centerRuns: IndexRun[];
    leftWidth: number;
    centerWidth: number;
    rightWidth: number;
    totalWidth: number;
};

/** One cell of a header group row. `groupId` null is filler above columns that are not grouped this deep. */
export type GroupHeaderCell = { key: string; groupId: string | null; colIds: string[]; width: number; depth: number };

export type GroupHeaderSection = { type: 'spacer'; size: number } | { type: 'cells'; cells: GroupHeaderCell[] };

export type GroupHeaderRow = {
    depth: number;
    left: GroupHeaderCell[];
    center: GroupHeaderSection[];
    right: GroupHeaderCell[];
};

type Section = { columns: LaidOutColumn[]; offsets: Float64Array; width: number };

export class ColumnLayout {
    #specs: ColumnSpec[] = [];
    #viewportWidth = 0;
    #resized = new Map<string, number>();
    #sections: Record<PinnedSection, Section> = { left: emptySection(), center: emptySection(), right: emptySection() };
    #byId = new Map<string, LaidOutColumn>();
    #maxGroupDepth = 0;

    constructor(specs: readonly ColumnSpec[] = [], viewportWidth = 0) {
        this.#specs = [...specs];
        this.#viewportWidth = viewportWidth;
        this.#layout();
    }

    /** Replaces the columns. Widths the user resized are kept for columns that still exist. */
    setColumns(specs: readonly ColumnSpec[]): void {
        this.#specs = [...specs];
        const ids = new Set(specs.map((spec) => spec.colId));
        for (const colId of [...this.#resized.keys()]) {
            if (!ids.has(colId)) {
                this.#resized.delete(colId);
            }
        }
        this.#layout();
    }

    /** The full width of the grid viewport. Flex columns share what is left after fixed columns. */
    setViewportWidth(width: number): void {
        if (width !== this.#viewportWidth) {
            this.#viewportWidth = width;
            this.#layout();
        }
    }

    /** Sets a column's width as the user resized it, clamped to its min and max. Returns the applied width. */
    resize(colId: string, width: number): number {
        const spec = this.#specs.find((candidate) => candidate.colId === colId);
        if (!spec) {
            return 0;
        }
        const applied = clamp(width, spec.minWidth ?? DEFAULT_MIN_WIDTH, spec.maxWidth ?? Infinity);
        this.#resized.set(colId, applied);
        this.#layout();

        return applied;
    }

    /** Forgets user resizing, back to the definitions (all columns, or the given ones). */
    resetWidths(colIds?: readonly string[]): void {
        if (colIds) {
            colIds.forEach((colId) => this.#resized.delete(colId));
        } else {
            this.#resized.clear();
        }
        this.#layout();
    }

    get leftWidth(): number {
        return this.#sections.left.width;
    }

    get centerWidth(): number {
        return this.#sections.center.width;
    }

    get rightWidth(): number {
        return this.#sections.right.width;
    }

    get totalWidth(): number {
        return this.leftWidth + this.centerWidth + this.rightWidth;
    }

    get groupDepth(): number {
        return this.#maxGroupDepth;
    }

    getColumn(colId: string): LaidOutColumn | undefined {
        return this.#byId.get(colId);
    }

    /** Columns in display order: left pinned, center, right pinned. */
    getColumns(): LaidOutColumn[] {
        return [...this.#sections.left.columns, ...this.#sections.center.columns, ...this.#sections.right.columns];
    }

    /**
     * Column bounds in content coordinates: x from the left edge of the full grid width, as if nothing
     * were scrolled or sticky. Use `getViewportLeft` for where a column appears on screen.
     */
    getContentLeft(colId: string): number | undefined {
        const column = this.#byId.get(colId);
        if (!column) {
            return undefined;
        }
        const sectionStart =
            column.section === 'left'
                ? 0
                : column.section === 'center'
                  ? this.leftWidth
                  : this.leftWidth + this.centerWidth;

        return sectionStart + column.left;
    }

    /** Where a column appears relative to the viewport's left edge at a horizontal scroll position. */
    getViewportLeft(colId: string, scrollLeft: number, viewportWidth = this.#viewportWidth): number | undefined {
        const column = this.#byId.get(colId);
        if (!column) {
            return undefined;
        }
        if (column.section === 'left') {
            return column.left;
        }
        if (column.section === 'right') {
            // Sticky to the viewport's right edge while the grid is wider than the viewport, otherwise it
            // sits right after the center section.
            const rightStart =
                this.totalWidth > viewportWidth ? viewportWidth - this.rightWidth : this.leftWidth + this.centerWidth;

            return rightStart + column.left;
        }

        return this.leftWidth + column.left - scrollLeft;
    }

    /** The scrollLeft that brings a center column fully into view between the pinned sections. */
    scrollLeftForColumn(colId: string, scrollLeft: number, viewportWidth = this.#viewportWidth): number {
        const column = this.#byId.get(colId);
        if (!column || column.section !== 'center') {
            return scrollLeft;
        }
        const visible = Math.max(viewportWidth - this.leftWidth - this.rightWidth, 0);
        if (column.left < scrollLeft) {
            return column.left;
        }
        if (column.left + column.width > scrollLeft + visible) {
            return Math.max(0, Math.min(column.left, column.left + column.width - visible));
        }

        return scrollLeft;
    }

    /**
     * Columns to mount for a horizontal scroll position. Retained columns (focused, editing) and columns
     * marked `keepMounted` stay mounted outside the window.
     */
    getWindow(
        scrollLeft: number,
        viewportWidth = this.#viewportWidth,
        overscan = 300,
        retained: Iterable<string> = []
    ): HorizontalWindow {
        const center = this.#sections.center;
        const keep: number[] = [];
        for (const colId of retained) {
            const column = this.#byId.get(colId);
            if (column?.section === 'center') {
                keep.push(column.index);
            }
        }
        center.columns.forEach((column) => {
            if (this.#specs[this.#specIndex(column.colId)]?.keepMounted) {
                keep.push(column.index);
            }
        });
        const sizes: Sizes = {
            count: center.columns.length,
            offsetOf: (index) => center.offsets[Math.min(Math.max(index, 0), center.columns.length)]!,
            indexAt: (offset) => indexAt(center.offsets, center.columns.length, offset),
        };
        const window = computeWindow({
            sizes,
            mapping: identityMapping(center.width),
            scroll: scrollLeft,
            viewportSize: Math.max(viewportWidth - this.leftWidth - this.rightWidth, 0),
            overscan,
            retained: keep,
        });

        return {
            left: this.#sections.left.columns,
            right: this.#sections.right.columns,
            centerItems: window.items,
            centerRuns: window.runs,
            leftWidth: this.leftWidth,
            centerWidth: center.width,
            rightWidth: this.rightWidth,
            totalWidth: this.totalWidth,
        };
    }

    /** Center columns of a window run, in order. */
    centerColumns(run: IndexRun): LaidOutColumn[] {
        return this.#sections.center.columns.slice(run.start, run.end + 1);
    }

    /**
     * Header group rows for a window, outermost first. Within each section and each mounted run,
     * consecutive columns that share a group at that depth form one cell. Spacers match the body exactly,
     * so group cells always line up with the columns below them.
     */
    getGroupHeaderRows(window: HorizontalWindow): GroupHeaderRow[] {
        const rows: GroupHeaderRow[] = [];
        for (let depth = 0; depth < this.#maxGroupDepth; depth++) {
            const center: GroupHeaderSection[] = window.centerItems.map((item) =>
                item.type === 'spacer'
                    ? { type: 'spacer', size: item.size }
                    : { type: 'cells', cells: groupCells(this.centerColumns(item), depth, `c${item.start}`) }
            );
            rows.push({
                depth,
                left: groupCells(window.left, depth, 'l'),
                center,
                right: groupCells(window.right, depth, 'r'),
            });
        }

        return rows;
    }

    #specIndex(colId: string): number {
        return this.#specs.findIndex((spec) => spec.colId === colId);
    }

    #layout(): void {
        const widths = this.#resolveWidths();
        const build = (section: PinnedSection, specs: ColumnSpec[]): Section => {
            const offsets = new Float64Array(specs.length + 1);
            const columns = specs.map((spec, index) => {
                const width = widths.get(spec.colId)!;
                offsets[index + 1] = offsets[index]! + width;

                return {
                    colId: spec.colId,
                    section,
                    index,
                    width,
                    left: offsets[index]!,
                    groupPath: spec.groupPath ?? [],
                };
            });

            return { columns, offsets, width: offsets[specs.length]! };
        };
        this.#sections = {
            left: build(
                'left',
                this.#specs.filter((spec) => spec.pinned === 'left')
            ),
            center: build(
                'center',
                this.#specs.filter((spec) => spec.pinned !== 'left' && spec.pinned !== 'right')
            ),
            right: build(
                'right',
                this.#specs.filter((spec) => spec.pinned === 'right')
            ),
        };
        this.#byId = new Map(this.getColumns().map((column) => [column.colId, column]));
        this.#maxGroupDepth = Math.max(0, ...this.#specs.map((spec) => spec.groupPath?.length ?? 0));
    }

    /**
     * Fixed widths first; flex columns share the rest by their flex factor. A flex column that hits its
     * min or max is frozen there and the remainder is shared again among the others.
     */
    #resolveWidths(): Map<string, number> {
        const widths = new Map<string, number>();
        const flexing: ColumnSpec[] = [];
        let fixed = 0;
        for (const spec of this.#specs) {
            const min = spec.minWidth ?? DEFAULT_MIN_WIDTH;
            const max = spec.maxWidth ?? Infinity;
            const resized = this.#resized.get(spec.colId);
            if (resized !== undefined) {
                widths.set(spec.colId, clamp(resized, min, max));
            } else if (spec.flex && spec.flex > 0) {
                flexing.push(spec);
                continue;
            } else {
                widths.set(spec.colId, clamp(spec.width ?? DEFAULT_COLUMN_WIDTH, min, max));
            }
            fixed += widths.get(spec.colId)!;
        }
        let remaining = Math.max(this.#viewportWidth - fixed, 0);
        let open = [...flexing];
        while (open.length > 0) {
            const totalFlex = open.reduce((sum, spec) => sum + spec.flex!, 0);
            const frozen: ColumnSpec[] = [];
            for (const spec of open) {
                const share = (remaining * spec.flex!) / totalFlex;
                const min = spec.minWidth ?? DEFAULT_MIN_WIDTH;
                const max = spec.maxWidth ?? Infinity;
                if (share < min || share > max) {
                    widths.set(spec.colId, clamp(share, min, max));
                    frozen.push(spec);
                }
            }
            if (frozen.length === 0) {
                // Exact shares: every open column is inside its bounds at its share, and header, groups and
                // body all use these same values, so they stay aligned without rounding to whole pixels.
                // (Rounding with the remainder on one column could push that column past its max.)
                open.forEach((spec) => widths.set(spec.colId, (remaining * spec.flex!) / totalFlex));
                break;
            }
            remaining = Math.max(remaining - frozen.reduce((sum, spec) => sum + widths.get(spec.colId)!, 0), 0);
            open = open.filter((spec) => !frozen.includes(spec));
        }

        return widths;
    }
}

function emptySection(): Section {
    return { columns: [], offsets: new Float64Array(1), width: 0 };
}

/** `maxWidth` wins when it is below `minWidth` (a narrow fixed column under a wide default minimum). */
function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

function indexAt(offsets: Float64Array, count: number, offset: number): number {
    if (count === 0) {
        return -1;
    }
    let low = 0;
    let high = count - 1;
    while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (offsets[middle]! <= offset) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }

    return low;
}

function groupCells(columns: readonly LaidOutColumn[], depth: number, keyPrefix: string): GroupHeaderCell[] {
    const cells: GroupHeaderCell[] = [];
    for (const column of columns) {
        const groupId = column.groupPath[depth] ?? null;
        const last = cells[cells.length - 1];
        // Merge only with a cell of the same group whose outer groups match too, so a filler (null) never
        // spans across a change of the group above it.
        if (last && last.groupId === groupId && sharesAncestors(last, column, depth, columns)) {
            last.colIds.push(column.colId);
            last.width += column.width;
        } else {
            cells.push({
                key: `${keyPrefix}:${column.colId}`,
                groupId,
                colIds: [column.colId],
                width: column.width,
                depth,
            });
        }
    }

    return cells;
}

/** Two adjacent columns belong to one group cell only when all their outer groups match too. */
function sharesAncestors(
    cell: GroupHeaderCell,
    column: LaidOutColumn,
    depth: number,
    columns: readonly LaidOutColumn[]
): boolean {
    const previous = columns.find((candidate) => candidate.colId === cell.colIds[cell.colIds.length - 1]);
    if (!previous) {
        return false;
    }
    for (let level = 0; level < depth; level++) {
        if ((previous.groupPath[level] ?? null) !== (column.groupPath[level] ?? null)) {
            return false;
        }
    }

    return true;
}
