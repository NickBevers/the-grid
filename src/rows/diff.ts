/**
 * What changed between two projections, by id. Selection, focus, ranges and editing use this to drop
 * state for rows that disappeared and to keep state for rows that only moved, without looking at the DOM.
 */
import type { GridRow, RowId } from '../contract/rows';

export type ProjectionLike<TData> = {
    getRow(id: RowId): GridRow<TData> | undefined;
    getIndexOf(id: RowId): number | undefined;
};

export type RowChanges = {
    /** Ids that no longer exist in the projection at all. */
    removed: RowId[];
    /** Ids that still exist but are no longer displayed (collapsed parent). */
    hidden: RowId[];
    /** Ids whose displayed index changed. */
    moved: { id: RowId; from: number; to: number }[];
    /** Ids whose row object changed (new data, new expansion state). */
    updated: RowId[];
};

/** Compares the given ids between two projections. Pass the ids you hold state for (selection, focus). */
export function diffRows<TData>(
    ids: Iterable<RowId>,
    previous: ProjectionLike<TData>,
    next: ProjectionLike<TData>
): RowChanges {
    const changes: RowChanges = { removed: [], hidden: [], moved: [], updated: [] };
    for (const id of ids) {
        const before = previous.getRow(id);
        const after = next.getRow(id);
        if (!after) {
            changes.removed.push(id);
            continue;
        }
        const from = previous.getIndexOf(id);
        const to = next.getIndexOf(id);
        if (to === undefined) {
            changes.hidden.push(id);
        } else if (from !== undefined && from !== to) {
            changes.moved.push({ id, from, to });
        }
        if (before && before !== after) {
            changes.updated.push(id);
        }
    }

    return changes;
}
