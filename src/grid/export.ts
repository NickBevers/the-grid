/**
 * Exports run on the server: large exports never page rows through the browser. The grid's part is the
 * query, built from exactly what the grid shows: the displayed columns in display order (left pinned,
 * center, right pinned), the search, the filters in their wire form (`noneOf` keeps its type), the sort in
 * priority order and the relationship filters. The backend resolves headers and formats values.
 */
import type { ExternalFilters, FilterModel, GridApi, ResolvedColumn, SortModel } from '../contract';
import { wireFilterModel } from '../models/httpDataSource';

export type ExportColumn = { colId: string; field: string };

export type ExportQuery = {
    columns: ExportColumn[];
    search?: string;
    filterModel?: FilterModel;
    sortModel?: SortModel;
    externalFilters?: ExternalFilters;
};

export type ExportQueryOptions<TData> = {
    /** Leaves a displayed column out. Checkbox selection columns are always left out. */
    exclude?: (column: ResolvedColumn<TData>) => boolean;
    /** Filters merged over the grid's own (for example a date range the screen implies). */
    additionalFilters?: FilterModel;
    /** The sort to send when the grid has none. */
    defaultSort?: SortModel;
};

/** The export query for what the grid shows now. Empty parts are left out. */
export function getExportQuery<TData>(api: GridApi<TData>, options: ExportQueryOptions<TData> = {}): ExportQuery {
    const columns = api
        .getDisplayedColumns()
        .map((displayed) => displayed.column)
        .filter((column) => !column.def.checkboxSelection && !(options.exclude?.(column) ?? false))
        .map((column) => ({ colId: column.colId, field: column.def.field ?? column.colId }));
    const filterModel = wireFilterModel({ ...api.getFilterModel(), ...options.additionalFilters });
    const gridSort = api.getSortModel().map(({ colId, sort }) => ({ colId, sort }));
    const sortModel = gridSort.length > 0 ? gridSort : (options.defaultSort ?? []);
    const search = api.getSearch().trim();
    const externalFilters = api.getState().query.externalFilters;

    return {
        columns,
        ...(search !== '' ? { search } : {}),
        ...(Object.keys(filterModel).length > 0 ? { filterModel } : {}),
        ...(sortModel.length > 0 ? { sortModel } : {}),
        ...(Object.keys(externalFilters).length > 0 ? { externalFilters } : {}),
    };
}
