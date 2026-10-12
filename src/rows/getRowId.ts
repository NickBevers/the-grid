/**
 * The default row id: `data.id`, converted to a string. Numbers are accepted because the backend sends
 * numeric ids; `1` and `"1"` therefore identify the same row, matching how the app keys rows today.
 * A missing id is an error, never a silent fallback to the index, because an index is not stable across
 * sorting, filtering or refreshes.
 */
import type { GetRowId, RowId } from '../contract/rows';
import { assertDataRowId, InvalidRowIdError } from './ids';

export const defaultGetRowId: GetRowId<unknown> = (data) => {
    const id = (data as { id?: unknown } | null)?.id;
    if (typeof id === 'number' && Number.isFinite(id)) {
        return String(id);
    }
    if (typeof id === 'string' && id !== '') {
        return id;
    }
    throw new InvalidRowIdError(
        `Row has no usable "id" (got ${JSON.stringify(id)}). Pass getRowId for rows without an id field.`
    );
};

/** Wraps a getRowId so every id is validated, and duplicates within one build are reported. */
export function createIdResolver<TData>(getRowId: GetRowId<TData> | undefined, context: string) {
    const resolve = (getRowId ?? defaultGetRowId) as GetRowId<TData>;
    const seen = new Set<RowId>();

    return {
        resolve(data: TData, parentId: RowId | null, level: number): RowId {
            const id = resolve(data, { parentId, level });
            assertDataRowId(id, context);
            if (seen.has(id)) {
                throw new InvalidRowIdError(`${context}: duplicate row id "${id}"`);
            }
            seen.add(id);

            return id;
        },
    };
}
