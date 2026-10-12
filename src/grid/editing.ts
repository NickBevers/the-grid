/**
 * The editor lifecycle. One edit at a time; the controller owns the draft, so an editor component can
 * unmount and remount (scroll, refresh, popup portal) without losing input. Every way an edit ends goes
 * through `stop(commit, reason)`: keyboard, blur, api, a removed row, or a refresh that changed the row.
 *
 * Commit runs the editor's `parse` (sync or async). A rejected parse keeps the editor open with the error.
 * While an async parse runs, the session is `validating`; a second stop while validating returns the same
 * promise, and a newer edit makes the older result obsolete. The value is written with the column's
 * setter only after a successful parse, so nothing commits silently.
 */
import type {
    CellEditorComponent,
    CellPosition,
    DataRow,
    EditorKeyPolicy,
    EditStopReason,
    ResolvedColumn,
    RowId,
} from '../contract';

export type EditSession = {
    cell: CellPosition;
    initialValue: unknown;
    draft: unknown;
    /** The printable key that started the edit. Cleared on the first draft change, so a remount does not apply it twice. */
    startKey: string | null;
    error: string | null;
    status: 'editing' | 'validating';
    /** Increments per edit; async results for an older edit are dropped. */
    generation: number;
};

export type EditControllerDeps<TData> = {
    getRow(rowId: RowId): DataRow<TData> | undefined;
    getColumn(colId: string): ResolvedColumn<TData> | undefined;
    /** Whether the column is displayed. A hidden column cannot be edited. Default: always. */
    isColumnDisplayed?(colId: string): boolean;
    /** Called after every session change, including the end of an edit (null). */
    onChange(session: EditSession | null): void;
    onStarted?(event: { cell: CellPosition; row: DataRow<TData>; startKey: string | null }): void;
    onStopped?(event: {
        cell: CellPosition;
        row: DataRow<TData> | undefined;
        committed: boolean;
        reason: EditStopReason;
    }): void;
    onValueChanged?(event: { cell: CellPosition; row: DataRow<TData>; oldValue: unknown; newValue: unknown }): void;
    /** Permission beyond the column's own `editable` (locked rows, backend rules). Default: allowed. */
    canEditCell?(cell: CellPosition, row: DataRow<TData>): boolean;
};

export const DEFAULT_KEY_POLICY: EditorKeyPolicy = {
    enter: 'commitAndMoveDown',
    tab: 'commitAndMove',
    arrowsNavigateGrid: false,
};

/** The key policy of an editor, with defaults for what it leaves out. */
export function keyPolicyOf<TData>(editor: CellEditorComponent<TData> | undefined): EditorKeyPolicy {
    return { ...DEFAULT_KEY_POLICY, ...editor?.keyPolicy };
}

/** Whether a key starts editing when typed on a focused cell: one printable character without Ctrl, Cmd or Alt. */
export function isStartKey(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
    return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}

export class EditController<TData> {
    #session: EditSession | null = null;
    #generation = 0;
    #pending: Promise<boolean> | null = null;
    /** The edited row as it was at start, so the stop event can still name a row that was removed. */
    #row: DataRow<TData> | undefined;

    constructor(private readonly deps: EditControllerDeps<TData>) {}

    get session(): EditSession | null {
        return this.#session;
    }

    /** Whether a cell can be edited right now: a loaded data row, a displayed editable column with a setter. */
    canEdit(cell: CellPosition): boolean {
        const row = this.deps.getRow(cell.rowId);
        const column = this.deps.getColumn(cell.colId);

        return Boolean(
            row &&
            column &&
            column.setValue &&
            column.isEditable(row) &&
            (this.deps.canEditCell?.(cell, row) ?? true) &&
            (this.deps.isColumnDisplayed?.(cell.colId) ?? true)
        );
    }

    /**
     * Starts editing a cell. An edit already in progress is committed first; when that commit is rejected
     * or still validating, the new edit does not start. Returns whether editing started.
     *
     * Synchronous whenever nothing has to wait for an async commit, so the editor mounts before the next
     * key event and fast typing is never routed to the grid instead of the editor.
     */
    start(cell: CellPosition, options: { startKey?: string | null } = {}): boolean | Promise<boolean> {
        if (this.#session) {
            if (sameCell(this.#session.cell, cell)) {
                return true;
            }
            const committed = this.stop(true, 'api');
            const afterCommit = (ok: boolean): boolean => (!ok || this.#session ? false : this.#begin(cell, options));

            return committed instanceof Promise ? committed.then(afterCommit) : afterCommit(committed);
        }

        return this.#begin(cell, options);
    }

    #begin(cell: CellPosition, options: { startKey?: string | null }): boolean {
        if (!this.canEdit(cell)) {
            return false;
        }
        const row = this.deps.getRow(cell.rowId)!;
        const column = this.deps.getColumn(cell.colId)!;
        this.#row = row;
        const initialValue = column.getValue(row);
        const startKey = options.startKey ?? null;
        this.#session = {
            cell,
            initialValue,
            draft: initialValue,
            startKey,
            error: null,
            status: 'editing',
            generation: ++this.#generation,
        };
        this.deps.onStarted?.({ cell, row, startKey });
        this.deps.onChange(this.#session);

        return true;
    }

    setDraft(draft: unknown): void {
        if (!this.#session) {
            return;
        }
        this.#session = { ...this.#session, draft, startKey: null, error: null };
        this.deps.onChange(this.#session);
    }

    /**
     * Ends the edit. With `commit`, parses and validates the draft and writes it; a rejected parse keeps
     * the edit open with its error and returns false. Without `commit`, the draft is discarded. Returns
     * true when the edit ended (or there was none). The result is a promise only while an async parse runs.
     */
    stop(commit: boolean, reason: EditStopReason): boolean | Promise<boolean> {
        const session = this.#session;
        if (!session) {
            return true;
        }
        if (this.#pending) {
            // A second stop while validating: a cancel wins, anything else waits for the running commit.
            if (!commit) {
                this.#end(session, false, reason);

                return true;
            }

            return this.#pending;
        }
        if (!commit) {
            this.#end(session, false, reason);

            return true;
        }
        const row = this.deps.getRow(session.cell.rowId);
        const column = this.deps.getColumn(session.cell.colId);
        if (!row || !column) {
            this.#end(session, false, 'rowRemoved');

            return true;
        }
        const parse = column.editor?.parse;
        const result = parse ? parse(session.draft, { row, column }) : { ok: true as const, value: session.draft };
        if (!(result instanceof Promise)) {
            return this.#finish(session, result, reason);
        }
        this.#session = { ...session, status: 'validating', error: null };
        this.deps.onChange(this.#session);
        const pending = result.then(
            (outcome) => this.#finish(session, outcome, reason),
            (error: unknown) => this.#finish(session, { ok: false, error: errorMessage(error) }, reason)
        );
        this.#pending = pending;
        void pending.finally(() => {
            if (this.#pending === pending) {
                this.#pending = null;
            }
        });

        return pending;
    }

    /**
     * Tells the controller that rows changed (refresh, transaction, server block). When the edited row is
     * gone the edit ends with `rowRemoved`; the draft is kept on screen otherwise, even if the row's data
     * changed underneath it, and the commit writes over the new data.
     */
    rowsChanged(): void {
        const session = this.#session;
        if (session && !this.deps.getRow(session.cell.rowId)) {
            this.#end(session, false, 'rowRemoved');
        }
    }

    /** Ends any edit without committing, for grid destroy. */
    destroy(): void {
        if (this.#session) {
            this.#end(this.#session, false, 'api');
        }
    }

    #finish(
        session: EditSession,
        outcome: { ok: true; value: unknown } | { ok: false; error: string },
        reason: EditStopReason
    ): boolean {
        if (this.#session?.generation !== session.generation) {
            // A newer edit or a cancel took over while validating.
            return this.#session === null;
        }
        if (!outcome.ok) {
            this.#session = { ...this.#session, status: 'editing', error: outcome.error };
            this.deps.onChange(this.#session);

            return false;
        }
        const row = this.deps.getRow(session.cell.rowId);
        const column = this.deps.getColumn(session.cell.colId);
        if (!row || !column?.setValue) {
            this.#end(session, false, 'rowRemoved');

            return true;
        }
        const oldValue = column.getValue(row);
        const changed = !Object.is(oldValue, outcome.value) && column.setValue(row, outcome.value);
        this.#end(session, true, reason);
        if (changed) {
            this.deps.onValueChanged?.({ cell: session.cell, row, oldValue, newValue: column.getValue(row) });
        }

        return true;
    }

    #end(session: EditSession, committed: boolean, reason: EditStopReason): void {
        this.#session = null;
        this.#pending = null;
        const row = this.deps.getRow(session.cell.rowId) ?? this.#row;
        this.#row = undefined;
        this.deps.onStopped?.({ cell: session.cell, row, committed, reason });
        this.deps.onChange(null);
    }
}

function sameCell(a: CellPosition, b: CellPosition): boolean {
    return a.rowId === b.rowId && a.colId === b.colId;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : typeof error === 'string' ? error : 'Validation failed.';
}
