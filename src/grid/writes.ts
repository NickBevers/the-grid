/**
 * Tracks pending writes per cell, so overlapping writes settle in the right order:
 *
 * - every write is an operation with an increasing id;
 * - a success makes its value the cell's confirmed value, unless a newer operation was already confirmed;
 * - a failure rolls the cell back only when it is the newest operation and its value is still showing.
 *   The cell goes to the newest operation still pending, or else the confirmed value. Older failures
 *   change nothing on screen.
 *
 * The tracker holds values only; the store reads and writes cells.
 */
import type { CellPosition } from '../contract';

type CellEntry = {
    confirmed: unknown;
    confirmedOp: number;
    /** The newest write issued for the cell, settled or not. */
    latest: number;
    pending: { id: number; value: unknown }[];
};

const keyOf = (cell: CellPosition) => `${cell.rowId}\u0000${cell.colId}`;

export class WriteTracker {
    #cells = new Map<string, CellEntry>();
    #rows = new Map<string, number>();
    #next = 1;

    /** Registers a write; `oldValue` is the cell's value before it (its baseline when nothing is pending). */
    begin(cell: CellPosition, oldValue: unknown, value: unknown): number {
        const key = keyOf(cell);
        const entry = this.#cells.get(key) ?? { confirmed: oldValue, confirmedOp: 0, latest: 0, pending: [] };
        const id = this.#next++;
        entry.latest = id;
        entry.pending.push({ id, value });
        this.#cells.set(key, entry);
        this.#rows.set(cell.rowId, (this.#rows.get(cell.rowId) ?? 0) + 1);

        return id;
    }

    /** A write succeeded. `value` is what the server kept (default: the value written). */
    /** Returns whether this write is the newest one issued for the cell (so it settles the cell's state). */
    succeed(cell: CellPosition, id: number, value?: { value: unknown }): boolean {
        const entry = this.#take(cell, id);
        if (!entry) {
            return false;
        }
        if (id > entry.op.confirmedOp) {
            entry.op.confirmed = value ? value.value : entry.value;
            entry.op.confirmedOp = id;
        }
        const newest = id === entry.op.latest;
        this.#tidy(cell, entry.op);

        return newest;
    }

    /**
     * A write failed. Returns the value to put back, or `undefined` when the screen should stay as it is
     * (a newer write is showing, or the cell no longer shows this write's value per `isShowing`).
     */
    fail(
        cell: CellPosition,
        id: number,
        isShowing: (value: unknown) => boolean
    ): { restore?: { value: unknown }; superseded: boolean } {
        const entry = this.#take(cell, id);
        if (!entry) {
            return { superseded: true };
        }
        // The cell's error belongs to the newest write issued; an older failure leaves no mark.
        const superseded = id !== entry.op.latest;
        // The value rolls back unless a newer write is pending or already confirmed (an older failure under a
        // newer failure that already rolled back still has to roll its own value back).
        const outranked = entry.op.pending.some((op) => op.id > id) || entry.op.confirmedOp > id;
        let restore: { value: unknown } | undefined;
        if (!outranked && isShowing(entry.value)) {
            const latest = entry.op.pending.at(-1);
            restore = { value: latest && latest.id > entry.op.confirmedOp ? latest.value : entry.op.confirmed };
        }
        this.#tidy(cell, entry.op);

        return { ...(restore ? { restore } : {}), superseded };
    }

    isPending(cell: CellPosition): boolean {
        return (this.#cells.get(keyOf(cell))?.pending.length ?? 0) > 0;
    }

    /** Whether any write to the row is pending. */
    isRowPending(rowId: string): boolean {
        return (this.#rows.get(rowId) ?? 0) > 0;
    }

    /** Whether a write newer than `id` is pending on the row. */
    hasNewerOnRow(rowId: string, id: number): boolean {
        for (const [key, entry] of this.#cells) {
            if (key.startsWith(`${rowId}\u0000`) && entry.pending.some((op) => op.id > id)) {
                return true;
            }
        }

        return false;
    }

    #take(cell: CellPosition, id: number): { op: CellEntry; value: unknown } | undefined {
        const entry = this.#cells.get(keyOf(cell));
        const index = entry?.pending.findIndex((op) => op.id === id) ?? -1;
        if (!entry || index < 0) {
            return undefined;
        }
        const [op] = entry.pending.splice(index, 1);
        const count = (this.#rows.get(cell.rowId) ?? 1) - 1;
        if (count <= 0) {
            this.#rows.delete(cell.rowId);
        } else {
            this.#rows.set(cell.rowId, count);
        }

        return { op: entry, value: op!.value };
    }

    /**
     * Entries without pending writes are dropped; nothing newer can arrive for a write that settled after
     * them, because operation ids only grow and a new write starts a new entry from the cell's value.
     */
    #tidy(cell: CellPosition, entry: CellEntry): void {
        if (entry.pending.length === 0) {
            this.#cells.delete(keyOf(cell));
        }
    }
}
