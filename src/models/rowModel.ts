/**
 * What the grid store needs from a row model, local or server: the contract's read and write sides plus the
 * layout's row source and a few lifecycle members.
 */
import type { RowId, RowModel, RowModelControl } from '../contract';
import type { RowSource } from '../virtual/verticalLayout';

/** Why the displayed rows changed, so the store can tell the source of change events. */
export type RowsChangeSource = 'data' | 'query' | 'expand' | 'transaction' | 'patch' | 'refresh' | 'load';

export type Pagination = { page: number; pageSize: number; pageCount: number | null; rowCount: number | null };

export type GridRowModel<TData> = RowModel<TData> &
    RowModelControl<TData> & {
        readonly kind: 'local' | 'server';
        /** The layout's view of the displayed rows; a new object whenever they change. */
        readonly rowSource: RowSource<TData>;
        /** Whether a filter, quick filter or search currently hides rows (local) or applies (server). */
        readonly isFiltered: boolean;
        /** Expanded group, tree and master rows. */
        readonly expandedIds: ReadonlySet<RowId>;
        isExpanded(id: RowId): boolean;
        /** Rows changed in place (edits, pastes, fills): drop caches that read row data. */
        markDataChanged(): void;
        /** Null without pagination. */
        getPagination(): Pagination | null;
        setPage(page: number): void;
        destroy(): void;
    };
