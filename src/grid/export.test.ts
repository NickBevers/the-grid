import { describe, expect, it } from 'vitest';

import type { ColumnDefinition, GridApi } from '../contract';
import { createGridApi } from '../react/gridApi';
import { getExportQuery } from './export';
import { GridStore } from './store';

type Row = { id: number; name: string; team: string; fee: number; client: { name: string } };

const columns: ColumnDefinition<Row>[] = [
    { colId: 'select', checkboxSelection: true, width: 40 },
    { field: 'id' },
    { field: 'name', filter: 'text' },
    { field: 'team', filter: 'set' },
    { field: 'fee', filter: 'number' },
    { colId: 'clientName', valueGetter: ({ data }) => data?.client.name },
];

function setup() {
    const store = new GridStore<Row>({ columns, rows: [], getRowId: (row) => String(row.id) });
    const api: GridApi<Row> = createGridApi({
        store,
        geometry: {} as never,
        dataSource: () => ({ type: 'local', rows: [] }),
        whenSettled: async () => undefined,
        setQuickFilter: () => undefined,
        getLaidOutColumn: () => undefined,
    });

    return { store, api };
}

describe('export query', () => {
    it('sends the displayed columns in display order, without checkbox columns, with field or colId', () => {
        const { store, api } = setup();
        store.moveColumn('fee', 1);
        api.setColumnsVisible(['team'], false);
        api.applyColumnState([{ colId: 'name', pinned: 'left' }]);

        expect(getExportQuery(api).columns).toEqual([
            { colId: 'name', field: 'name' },
            { colId: 'fee', field: 'fee' },
            { colId: 'id', field: 'id' },
            { colId: 'clientName', field: 'clientName' },
        ]);
        expect(
            getExportQuery(api, { exclude: (column) => column.colId === 'id' }).columns.map((column) => column.colId)
        ).toEqual(['name', 'fee', 'clientName']);
    });

    it('sends search, wire filters, sort in priority order and relationship filters, leaving empty parts out', () => {
        const { api } = setup();
        expect(getExportQuery(api)).toEqual({ columns: expect.any(Array) });
        api.setSearch('  ada ');
        api.setFilterModel({
            team: { filterType: 'set', type: 'anyOf', values: ['red'] },
            name: { filterType: 'set', type: 'noneOf', values: ['Bo'] } as never,
        });
        api.setSortModel([
            { colId: 'fee', sort: 'desc' },
            { colId: 'name', sort: 'asc' },
        ]);
        api.setExternalFilters({ 'client.id': 7 });
        const query = getExportQuery(api, {
            additionalFilters: { fee: { filterType: 'number', type: 'greaterThan', filter: 0 } },
        });

        expect(query).toMatchObject({
            search: 'ada',
            filterModel: {
                team: { filterType: 'set', values: ['red'] },
                name: { filterType: 'set', type: 'noneOf', values: ['Bo'] },
                fee: { filterType: 'number', type: 'greaterThan', filter: 0 },
            },
            sortModel: [
                { colId: 'fee', sort: 'desc' },
                { colId: 'name', sort: 'asc' },
            ],
            externalFilters: { 'client.id': 7 },
        });
        expect(query.filterModel!.team).not.toHaveProperty('type');
    });

    it('falls back to a default sort when the grid has none', () => {
        const { api } = setup();

        expect(getExportQuery(api, { defaultSort: [{ colId: 'id', sort: 'asc' }] }).sortModel).toEqual([
            { colId: 'id', sort: 'asc' },
        ]);
    });
});
