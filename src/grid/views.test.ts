import { describe, expect, it } from 'vitest';

import type { ColumnDefinition, GridApi } from '../contract';
import { createGridApi } from '../react/gridApi';
import { GridStore } from './store';
import { applyViewState, captureViewState, isViewStateEqual, mergeSavedColumnState, type GridViewState } from './views';

type Person = { id: number; name: string; team: string; city: string; fee: number };

const columns: ColumnDefinition<Person>[] = [
    { field: 'id', width: 80 },
    { field: 'name', width: 200, filter: 'text' },
    {
        groupId: 'location',
        headerName: 'Location',
        children: [
            { field: 'team', width: 120, filter: 'set' },
            { field: 'city', width: 120, filter: 'set', showWhen: 'open' },
        ],
    },
    { field: 'fee', width: 100, filter: 'number' },
];

function setup() {
    const store = new GridStore<Person>({
        columns,
        rows: [
            { id: 1, name: 'Ada', team: 'red', city: 'Paris', fee: 10 },
            { id: 2, name: 'Bo', team: 'blue', city: 'Ghent', fee: 20 },
        ],
        getRowId: (row) => String(row.id),
    });
    const api: GridApi<Person> = createGridApi({
        store,
        geometry: {} as never,
        dataSource: () => ({ type: 'local', rows: [] }),
        whenSettled: async () => undefined,
        setQuickFilter: () => undefined,
        getLaidOutColumn: () => undefined,
    });

    return { store, api };
}

const displayed = (store: GridStore<Person>) => store.columns.getDisplayedLeaves().map((leaf) => leaf.colId);

/** A view saved by an earlier grid: raw column state, that grid's own ids, noneOf with its type. */
const legacyView: GridViewState = {
    filterModel: {
        team: { filterType: 'set', values: ['red'] },
        city: { filterType: 'set', type: 'noneOf', values: ['Ghent'] },
        fee: { filterType: 'number', type: 'greaterThan', filter: 5 },
    },
    sortModel: [
        { colId: 'fee', sort: 'desc' },
        { colId: 'name', sort: 'asc' },
    ],
    columnState: [
        {
            colId: 'legacy-selection-column',
            width: 50,
            hide: false,
            pinned: 'left',
            sort: null,
            sortIndex: null,
            rowGroup: false,
            rowGroupIndex: null,
            flex: null,
        },
        {
            colId: 'fee',
            width: 140,
            hide: false,
            pinned: 'left',
            sort: 'desc',
            sortIndex: 0,
            rowGroup: false,
            rowGroupIndex: null,
            flex: null,
        },
        {
            colId: 'name',
            width: 260,
            hide: false,
            pinned: null,
            sort: 'asc',
            sortIndex: 1,
            rowGroup: false,
            rowGroupIndex: null,
            flex: null,
        },
        {
            colId: 'team',
            width: 120,
            hide: false,
            pinned: null,
            sort: null,
            sortIndex: null,
            rowGroup: false,
            rowGroupIndex: null,
            flex: null,
        },
        {
            colId: 'city',
            width: 120,
            hide: false,
            pinned: null,
            sort: null,
            sortIndex: null,
            rowGroup: false,
            rowGroupIndex: null,
            flex: null,
        },
        {
            colId: 'id',
            width: 80,
            hide: true,
            pinned: null,
            sort: null,
            sortIndex: null,
            rowGroup: false,
            rowGroupIndex: null,
            flex: null,
        },
    ],
    columnGroupState: [{ groupId: 'location', open: true }],
    searchQuery: 'ada',
    viewSettings: null,
};

describe('saved views', () => {
    it('exposes current local rows in source order independently of the displayed query', () => {
        const { api } = setup();
        api.setSortModel([{ colId: 'name', sort: 'desc' }]);
        api.setFilterModel({ team: { filterType: 'set', values: ['blue'] } });

        expect(api.getSourceRows()?.map((row) => row.id)).toEqual([1, 2]);
        api.patchRows([{ id: '1', data: { id: 1, name: 'Updated Ada', team: 'red', city: 'Paris', fee: 10 } }]);
        api.applyTransaction({
            add: { rows: [{ id: 3, name: 'Cy', team: 'red', city: 'Rome', fee: 30 }] },
            remove: ['2'],
        });

        expect(api.getSourceRows()?.map((row) => [row.id, row.name])).toEqual([
            [1, 'Updated Ada'],
            [3, 'Cy'],
        ]);
    });

    it('applies a view saved before the migration: order, widths, hiding, pinning, sort, filters, search and groups', () => {
        const { store, api } = setup();
        applyViewState(api, legacyView);

        expect(displayed(store)).toEqual(['fee', 'name', 'team', 'city']);
        expect(store.columns.getColumnState().find((state) => state.colId === 'name')?.width).toBe(260);
        expect(api.getSortModel()).toEqual([
            { colId: 'fee', sort: 'desc' },
            { colId: 'name', sort: 'asc' },
        ]);
        expect(api.getFilterModel()).toEqual(legacyView.filterModel);
        expect(api.getSearch()).toBe('ada');
        expect(api.getColumnGroupState()).toEqual([{ groupId: 'location', open: true }]);
    });

    it('captures every field in the stored shape and round-trips a view without changing its meaning', () => {
        const { api } = setup();
        applyViewState(api, legacyView);
        const captured = captureViewState(api);

        expect(Object.keys(captured).sort()).toEqual([
            'columnGroupState',
            'columnState',
            'filterModel',
            'searchQuery',
            'sortModel',
            'viewSettings',
        ]);
        expect(captured.filterModel).toEqual(legacyView.filterModel);
        // Ids this grid does not know (an earlier grid's selection column) are kept, after the grid's own columns, so a
        // save does not drop them; everything else reads back as saved.
        const unknown = legacyView.columnState!.filter((state) => state.colId === 'legacy-selection-column');
        const known = legacyView.columnState!.filter((state) => state.colId !== 'legacy-selection-column');
        expect(captured.columnState!.at(-1)).toMatchObject(unknown[0]!);
        expect(isViewStateEqual({ ...legacyView, columnState: [...known, ...unknown] }, captured)).toBe(true);
    });

    it('slots columns added since the view was saved in at their defined position', () => {
        // Each missing column goes in at its defined index, in definition order.
        expect(
            mergeSavedColumnState(['id', 'name', 'team', 'fee'], [{ colId: 'fee' }, { colId: 'name' }]).map(
                (state) => state.colId
            )
        ).toEqual(['id', 'fee', 'team', 'name']);
        const { store, api } = setup();
        applyViewState(api, { columnState: [{ colId: 'fee' }, { colId: 'name' }] });

        expect(displayed(store)).toEqual(['id', 'fee', 'team', 'name']);
    });

    it('an empty view resets columns, filters, sort, search and group state', () => {
        const { store, api } = setup();
        applyViewState(api, legacyView);
        applyViewState(api, {
            filterModel: null,
            sortModel: null,
            columnState: null,
            columnGroupState: null,
            searchQuery: null,
        });

        expect(displayed(store)).toEqual(['id', 'name', 'team', 'fee']);
        expect([api.getFilterModel(), api.getSortModel(), api.getSearch()]).toEqual([{}, [], '']);
    });

    it('compares views: widths ignored, empty values and falsy flags equal', () => {
        const base: GridViewState = {
            filterModel: null,
            sortModel: [],
            columnState: [{ colId: 'a', width: 100, hide: false, flex: 0 }],
            columnGroupState: null,
            searchQuery: '',
        };

        expect(
            isViewStateEqual(base, {
                ...base,
                columnState: [{ colId: 'a', width: 300 }],
                sortModel: null,
                searchQuery: null,
                filterModel: {},
            })
        ).toBe(true);
        expect(isViewStateEqual(base, { ...base, columnState: [{ colId: 'a', hide: true }] })).toBe(false);
        expect(isViewStateEqual(base, { ...base, searchQuery: 'x' })).toBe(false);
    });

    it('signals view changes for auto-save: query and finished column changes, not an unfinished resize', () => {
        const { store, api } = setup();
        const reasons: string[] = [];
        store.events.on('viewStateChanged', (event) => reasons.push(event.reason));
        api.setColumnFilter('fee', { filterType: 'number', type: 'equals', filter: 10 });
        api.setSortModel([{ colId: 'name', sort: 'asc' }]);
        api.setSearch('bo');
        store.moveColumn('fee', 0);
        store.resizeColumn('name', 220, false);
        store.resizeColumn('name', 230, true);
        api.setColumnsVisible(['id'], false);

        expect(reasons).toEqual(['query', 'query', 'query', 'columns', 'columns', 'columns']);
    });
});
