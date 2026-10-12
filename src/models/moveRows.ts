/**
 * Applies a `rowDragEnded` event to an array of row data: takes the dragged rows out and inserts them, in
 * their display order, where the drop landed. Works on the source array the app owns (form values); for a
 * sorted or filtered grid, the app decides what a drop means.
 */
import type { GetRowId, RowId } from '../contract';
import { defaultGetRowId } from '../rows/getRowId';

export function moveRows<TData>(
    rows: readonly TData[],
    drop: { rowIds: readonly RowId[]; overRowId: RowId | null; position: 'before' | 'after' },
    getRowId: GetRowId<TData> = defaultGetRowId as GetRowId<TData>
): TData[] {
    const idOf = (data: TData) => getRowId(data, { parentId: null, level: 0 });
    const moving = new Set(drop.rowIds);
    const dragged = drop.rowIds
        .map((id) => rows.find((data) => idOf(data) === id))
        .filter((data): data is TData => data !== undefined);
    const rest = rows.filter((data) => !moving.has(idOf(data)));
    if (drop.overRowId === null || moving.has(drop.overRowId)) {
        return [...rows];
    }
    const overIndex = rest.findIndex((data) => idOf(data) === drop.overRowId);
    if (overIndex === -1) {
        return [...rows];
    }
    const insertAt = overIndex + (drop.position === 'after' ? 1 : 0);

    return [...rest.slice(0, insertAt), ...dragged, ...rest.slice(insertAt)];
}
