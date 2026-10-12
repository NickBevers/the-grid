/**
 * One width model for header, body and pinned rows.
 *
 * Columns split into left pinned, center and right pinned sections. Pinned sections are always mounted and
 * stick with `position: sticky`. Only the center section is virtualized.
 */
import { identityMapping } from './identityMapping';
import { computeWindow, type LayoutItem, type Sizes, type WindowResult } from './window';

export type LayoutColumn = { colId: string; width: number; pinned?: 'left' | 'right' | null };

export type ColumnSections = {
    left: LayoutColumn[];
    center: LayoutColumn[];
    right: LayoutColumn[];
    leftWidth: number;
    centerWidth: number;
    rightWidth: number;
    totalWidth: number;
    centerSizes: Sizes;
};

export function createColumnSections(columns: LayoutColumn[]): ColumnSections {
    const left = columns.filter((column) => column.pinned === 'left');
    const right = columns.filter((column) => column.pinned === 'right');
    const center = columns.filter((column) => column.pinned !== 'left' && column.pinned !== 'right');
    const offsets = new Float64Array(center.length + 1);
    center.forEach((column, index) => {
        offsets[index + 1] = offsets[index]! + column.width;
    });
    const sum = (list: LayoutColumn[]) => list.reduce((total, column) => total + column.width, 0);
    const leftWidth = sum(left);
    const rightWidth = sum(right);
    const centerWidth = offsets[center.length]!;

    const centerSizes: Sizes = {
        count: center.length,
        offsetOf: (index) => offsets[Math.min(Math.max(index, 0), center.length)]!,
        indexAt: (offset) => {
            if (center.length === 0) {
                return -1;
            }
            let low = 0;
            let high = center.length - 1;
            while (low < high) {
                const middle = (low + high + 1) >> 1;
                if (offsets[middle]! <= offset) {
                    low = middle;
                } else {
                    high = middle - 1;
                }
            }

            return low;
        },
    };

    return {
        left,
        center,
        right,
        leftWidth,
        centerWidth,
        rightWidth,
        totalWidth: leftWidth + centerWidth + rightWidth,
        centerSizes,
    };
}

export type ColumnWindow = WindowResult & { items: LayoutItem[] };

/**
 * Center columns to mount for a horizontal scroll offset. The visible center area is the viewport minus the
 * sticky pinned sections.
 */
export function computeColumnWindow(
    sections: ColumnSections,
    scrollLeft: number,
    viewportWidth: number,
    overscan: number,
    retained?: Iterable<number>
): ColumnWindow {
    const centerViewport = Math.max(viewportWidth - sections.leftWidth - sections.rightWidth, 0);

    return computeWindow({
        sizes: sections.centerSizes,
        mapping: identityMapping(sections.centerWidth),
        scroll: scrollLeft,
        viewportSize: centerViewport,
        overscan,
        ...(retained ? { retained } : {}),
    });
}
