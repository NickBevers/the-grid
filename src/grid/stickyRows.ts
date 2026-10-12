/**
 * Sticky group rows: while the rows of an open group scroll under the header, the group row stays just
 * below it, so the reader always sees which group they are in. Nested groups stack, outermost first. When
 * the next group at the same depth (or shallower) arrives, it pushes the stuck row up and out.
 *
 * Pure: the positions come from the row source and the vertical layout, never from the DOM.
 */
import type { GridRow, RowId } from '../contract';

export type StuckRow = {
    id: RowId;
    /** Displayed index of the group row. */
    index: number;
    /** Distance from the top of the body area to the stuck row's top, after any push. */
    top: number;
    height: number;
};

export type StickyRowsInput<TData> = {
    /** Content offset at the top of the body area (the virtual scroll top). */
    scrollTop: number;
    count: number;
    rowAt(index: number): GridRow<TData> | undefined;
    indexOf(id: RowId): number | undefined;
    indexAtOffset(offset: number): number | undefined;
    rowBounds(index: number): { top: number; height: number } | undefined;
    /** How far past the visible rows to look for the row that pushes a stuck group out. */
    scanLimit?: number;
};

type Candidate = { id: RowId; index: number; level: number; height: number };

/** The open groups that contain the row at content offset `y`, outermost first. */
function groupsAt<TData>(input: StickyRowsInput<TData>, y: number): Candidate[] {
    const index = input.indexAtOffset(y);
    const row = index === undefined ? undefined : input.rowAt(index);
    if (index === undefined || !row) {
        return [];
    }
    const chain: Candidate[] = [];
    const add = (candidate: GridRow<TData>, candidateIndex: number) => {
        const bounds = input.rowBounds(candidateIndex);
        if (bounds) {
            chain.unshift({ id: candidate.id, index: candidateIndex, level: candidate.level, height: bounds.height });
        }
    };
    // A group row already scrolling under the line sticks too, before any of its rows reach it.
    if (row.kind === 'group' && row.expanded && (input.rowBounds(index)?.top ?? y) < y) {
        add(row, index);
    }
    let parentId = row.parentId;
    while (parentId !== null) {
        const parentIndex = input.indexOf(parentId);
        const parent = parentIndex === undefined ? undefined : input.rowAt(parentIndex);
        if (parentIndex === undefined || !parent) {
            break;
        }
        if (parent.kind === 'group') {
            add(parent, parentIndex);
        }
        parentId = parent.parentId;
    }

    return chain;
}

const total = (rows: readonly { height: number }[]) => rows.reduce((sum, row) => sum + row.height, 0);

export function stickyGroupRows<TData>(input: StickyRowsInput<TData>): StuckRow[] {
    if (input.count === 0) {
        return [];
    }
    // The stack covers rows, so the row under its bottom edge decides how deep it goes. A few rounds settle it.
    let stack = groupsAt(input, input.scrollTop);
    for (let round = 0; round < 4; round++) {
        const next = groupsAt(input, input.scrollTop + total(stack));
        if (next.length <= stack.length) {
            break;
        }
        stack = next;
    }

    // Each stuck row is pushed up by the first row after its group, so two groups never overlap.
    const limit = input.scanLimit ?? 500;
    const stuck: StuckRow[] = [];
    let natural = 0;
    let push = 0;
    for (const candidate of stack) {
        let end: number | undefined;
        for (let index = candidate.index + 1; index < input.count && index <= candidate.index + limit; index++) {
            const row = input.rowAt(index);
            if (row && row.level <= candidate.level) {
                end = index;
                break;
            }
        }
        const endTop = end === undefined ? undefined : input.rowBounds(end)?.top;
        if (endTop !== undefined) {
            // The row must end where the next group starts, measured from the top of the body area.
            push = Math.max(push, natural + candidate.height - (endTop - input.scrollTop));
        }
        stuck.push({ id: candidate.id, index: candidate.index, top: natural - push, height: candidate.height });
        natural += candidate.height;
    }

    // A row pushed all the way out no longer covers anything.
    return stuck.filter((row) => row.top + row.height > 0);
}
