/**
 * Persisting cell writes. Every write the grid makes (an edit, a range edit, paste, fill, clear, or
 * `api.writeCells`) is applied locally first, so the grid updates at once, then handed to `persist` as one
 * batch. The result decides what stays:
 *
 * - rejected cells roll back (only while the write is still the newest one for the cell) and show the
 *   error on the cell;
 * - server rows returned replace the local rows by id, unless a newer write to that row is still pending
 *   (the newest operation owns reconciliation; older successes only become rollback baselines);
 * - a thrown error rejects the whole batch.
 */
import type { DataRow, RowId } from './rows';
import type { CellPosition } from './state';

export type WriteSource = 'edit' | 'paste' | 'fill' | 'clear' | 'api';

export type CellWriteRequest<TData> = {
    cell: CellPosition;
    /** The value written (already parsed). */
    value: unknown;
    oldValue: unknown;
    /** The text it came from, for paste, fill and clear. */
    text: string;
    row: DataRow<TData>;
    /**
     * Set for writes the grid derived from another one: the same value across a range edit (`range`) or a
     * sibling row from `propagateWrite` (`sibling`). The backend may apply those itself.
     */
    derived?: 'range' | 'sibling';
};

export type WriteBatch<TData> = {
    source: WriteSource;
    writes: CellWriteRequest<TData>[];
};

export type WriteResult<TData> = {
    rejected?: { cell: CellPosition; error: string }[];
    /** Authoritative rows from the server, matched by row id. */
    rows?: TData[];
};

/** Fired once a batch settles, for toasts and logging. */
export type WritesSettledEvent = {
    source: WriteSource;
    written: number;
    rejected: { cell: CellPosition; error: string }[];
    /** Rows replaced by server rows. */
    reconciledRowIds: RowId[];
};

/**
 * Derives writes on other rows from a committed edit (sibling propagation): for example every row of the
 * same order taking a shared field. Derived writes apply locally with the edit and are sent in the
 * same batch, marked `derived: 'sibling'`.
 */
export type PropagateWrite<TData> = (
    write: { cell: CellPosition; row: DataRow<TData>; oldValue: unknown; newValue: unknown },
    context: { forEachRow: (visit: (row: DataRow<TData>) => void) => void }
) => { cell: CellPosition; value: unknown }[];
