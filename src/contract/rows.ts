/**
 * Row identity and row kinds.
 *
 * Every displayed row is one of the kinds below. Rows are never encoded as ordinary data rows with magic
 * fields; the server adapter translates the backend's `_group` rows into `GroupRow` at the boundary.
 */

/** Stable row identity. Survives sorting, filtering, refreshes and virtualization. */
export type RowId = string;

export type RowKind = 'data' | 'group' | 'detail' | 'fullWidth' | 'loading' | 'failed';

/** Where a row lives. Pinned rows sit outside the scrolling body and are not part of the displayed index. */
export type RowSection = 'top' | 'body' | 'bottom';

type RowBase = {
    id: RowId;
    section: RowSection;
    /** Nesting depth. 0 for root rows. Group children and tree children are 1 deeper than their parent. */
    level: number;
    /** Parent group or tree row, or null at the root. */
    parentId: RowId | null;
};

/** An ordinary row carrying application data. Also used for local tree rows, which have `childIds`. */
export type DataRow<TData> = RowBase & {
    kind: 'data';
    data: TData;
    /** Present for local tree data and master rows. Undefined for leaves. */
    expandable?: { expanded: boolean };
};

/** A group produced by row grouping (server `rowGroupCols` or local grouping). */
export type GroupRow<TData> = RowBase & {
    kind: 'group';
    /** Column the group was formed on. */
    groupColId: string;
    /** Group value as the backend sent it (`_groupKey`). */
    key: string | null;
    /** Keys of this group and all ancestor groups, root first. This is the server `groupKeys` path. */
    keyPath: (string | null)[];
    /** Total leaf count below this group. Known for server groups (`_childCount`) before children load. */
    childCount: number | null;
    expanded: boolean;
    /** Representative document data the backend may send with a group row. */
    data: TData | null;
};

/** A master/detail child. Its height is measured, never assumed. */
export type DetailRow<TData> = RowBase & {
    kind: 'detail';
    masterId: RowId;
    data: TData;
};

/** A row rendered as one cell spanning all columns (section headers, expanded transaction details). */
export type FullWidthRow<TData> = RowBase & {
    kind: 'fullWidth';
    data: TData;
    /** Renderer key resolved through the registry, or a renderer passed to the grid. */
    renderer?: string;
};

/**
 * A slot whose data has not arrived. Remote models create these for every index inside the known row count
 * that is not in a loaded block. Its id is synthetic and changes when the real row arrives.
 */
export type LoadingRow = RowBase & {
    kind: 'loading';
    /** Displayed index this placeholder stands in for. */
    index: number;
};

/** A slot whose block request failed. Retrying the block turns it back into a `LoadingRow`. */
export type FailedRow = RowBase & {
    kind: 'failed';
    index: number;
    error: unknown;
};

export type GridRow<TData> =
    | DataRow<TData>
    | GroupRow<TData>
    | DetailRow<TData>
    | FullWidthRow<TData>
    | LoadingRow
    | FailedRow;

/** Rows that carry application data. Helpers and renderers usually narrow to this. */
export type RowWithData<TData> = DataRow<TData> | DetailRow<TData> | FullWidthRow<TData>;

/**
 * A row as seen at one moment in the displayed projection. The index is only valid for the model version
 * it was read from; hold on to `row.id`, never to the index.
 */
export type DisplayedRow<TData> = {
    row: GridRow<TData>;
    index: number;
};

/** Returns a stable id for a data row. The default reads `data.id` and fails loudly when it is missing. */
export type GetRowId<TData> = (data: TData, context: { parentId: RowId | null; level: number }) => RowId;

/** Local tree data: the path from the root to this row, e.g. ['Client', 'Agent']. */
export type GetDataPath<TData> = (data: TData) => string[];

export function isDataRow<TData>(row: GridRow<TData>): row is DataRow<TData> {
    return row.kind === 'data';
}

export function isGroupRow<TData>(row: GridRow<TData>): row is GroupRow<TData> {
    return row.kind === 'group';
}

export function hasData<TData>(row: GridRow<TData>): row is RowWithData<TData> {
    return row.kind === 'data' || row.kind === 'detail' || row.kind === 'fullWidth';
}

export function isPlaceholder<TData>(row: GridRow<TData>): row is LoadingRow | FailedRow {
    return row.kind === 'loading' || row.kind === 'failed';
}
