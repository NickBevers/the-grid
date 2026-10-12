/**
 * Pinned rows sit above or below the scrolling body (form totals, summary rows). They are not
 * part of the displayed index. Their ids carry the section, so a totals row may reuse a body row's id.
 */
import type { DataRow, GetRowId, GridRow, RowId } from '../contract/rows';
import { defaultGetRowId } from './getRowId';
import { assertDataRowId, InvalidRowIdError, pinnedRowId } from './ids';

export function buildPinnedRows<TData>(
    section: 'top' | 'bottom',
    rows: readonly TData[],
    getRowId: GetRowId<TData> = defaultGetRowId as GetRowId<TData>,
    previous: readonly GridRow<TData>[] = []
): GridRow<TData>[] {
    const previousById = new Map(previous.map((row) => [row.id, row]));
    const seen = new Set<RowId>();

    return rows.map((data) => {
        const sourceId = getRowId(data, { parentId: null, level: 0 });
        assertDataRowId(sourceId, `Pinned ${section} rows`);
        const id = pinnedRowId(section, sourceId);
        if (seen.has(id)) {
            throw new InvalidRowIdError(`Pinned ${section} rows: duplicate row id "${sourceId}"`);
        }
        seen.add(id);
        const old = previousById.get(id);
        if (old?.kind === 'data' && old.data === data) {
            return old;
        }
        const row: DataRow<TData> = { kind: 'data', id, section, level: 0, parentId: null, data };

        return row;
    });
}
