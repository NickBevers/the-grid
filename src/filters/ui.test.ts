import { describe, expect, it, vi } from 'vitest';

import type { FilterModel, QueryState, ServerRowsRequest } from '../contract';
import { GridStore } from '../grid/store';
import { serverRequestParams, wireFilterModel } from '../models/httpDataSource';
import {
    defaultCondition,
    filterOperators,
    formatFilterDate,
    httpSetChoices,
    isConditionApplicable,
    mergeFilterModel,
    parseFilterDate,
    partitionFilterModel,
    queryFromUrl,
    sameFilterModel,
    selectedFirst,
    staticSetChoices,
} from './ui';

const signal = () => new AbortController().signal;

describe('filter operators and fresh conditions', () => {
    it('offers the kind operators, or filterOptions in order with custom operators and labels', () => {
        expect(filterOperators('set').map((operator) => operator.key)).toEqual(['anyOf', 'noneOf']);
        expect(filterOperators('number').find((operator) => operator.key === 'inRange')?.inputs).toBe(2);
        const operators = filterOperators(
            'date',
            {
                filterOptions: [
                    'lessThan',
                    'blank',
                    { displayKey: 'thisWeek', displayName: 'This week', numberOfInputs: 0, predicate: () => true },
                ],
            },
            { 'date.lessThan': 'Is before' }
        );

        expect(operators).toEqual([
            { key: 'lessThan', label: 'Is before', inputs: 1 },
            { key: 'blank', label: 'Blank', inputs: 0 },
            { key: 'thisWeek', label: 'This week', inputs: 0 },
        ]);
    });

    it('starts a condition on the default option or the first operator, inactive until filled in', () => {
        expect(defaultCondition('text', { filterOptions: ['equals', 'contains'], defaultOption: 'contains' })).toEqual({
            filterType: 'text',
            type: 'contains',
            filter: null,
        });
        expect(defaultCondition('set')).toEqual({ filterType: 'set', type: 'anyOf', values: [] });
        expect(defaultCondition('number')).toMatchObject({ filterType: 'number', type: 'equals' });
        expect(mergeFilterModel({ team: defaultCondition('set') }, {})).toEqual({});
        expect(isConditionApplicable({ filterType: 'number', type: 'inRange', filter: 1, filterTo: null })).toBe(false);
        expect(
            isConditionApplicable({ filterType: 'date', type: 'inRange', dateFrom: '2024-01-01', dateTo: '2024-02-01' })
        ).toBe(true);
    });
});

describe('filter bar models', () => {
    it('applies complete owned conditions over the others and leaves incomplete ones out', () => {
        const model: FilterModel = {
            name: { filterType: 'text', type: 'contains', filter: 'ada' },
            location: {
                filterType: 'coordinates',
                type: 'withinRadius',
                filter: { latitude: 1, longitude: 2, radius: { value: 5, unit: 'km' } },
            },
        };
        const { owned, others } = partitionFilterModel(model, (colId) => colId !== 'location');
        expect(Object.keys(owned)).toEqual(['name']);
        expect(Object.keys(others)).toEqual(['location']);
        const merged = mergeFilterModel(
            {
                name: { filterType: 'text', type: 'contains', filter: '' },
                fee: { filterType: 'number', type: 'inRange', filter: 1, filterTo: 5 },
                team: { filterType: 'set', type: 'noneOf', values: ['red', null] },
                due: { filterType: 'date', type: 'blank' },
                joined: {
                    filterType: 'date',
                    operator: 'OR',
                    conditions: [
                        { filterType: 'date', type: 'lessThan', dateFrom: '2024-01-01 00:00:00' },
                        { filterType: 'date', type: 'blank' },
                    ],
                },
            },
            { ...others, name: model.name! }
        );

        expect(Object.keys(merged).sort()).toEqual(['due', 'fee', 'joined', 'location', 'team']);
        expect(sameFilterModel(merged, JSON.parse(JSON.stringify(merged)))).toBe(true);
        expect(
            sameFilterModel(
                { a: { filterType: 'text', type: 'equals', filter: 'x' } },
                { a: { type: 'equals', filter: 'x', filterType: 'text' } }
            )
        ).toBe(true);
        expect(
            sameFilterModel(
                { a: { filterType: 'set', values: ['x', 'y'] } },
                { a: { filterType: 'set', values: ['y', 'x'] } }
            )
        ).toBe(false);
    });

    it('formats and parses dates in the backend format, from the local calendar day', () => {
        expect(formatFilterDate(new Date(2024, 1, 29, 23, 59))).toBe('2024-02-29 00:00:00');
        expect(parseFilterDate('2024-02-29 00:00:00')?.getDate()).toBe(29);
        expect(parseFilterDate('2024-02-30')).toBeNull();
        expect(parseFilterDate('soon')).toBeNull();
    });

    it('reads search and filters from the URL', () => {
        const query = queryFromUrl(new URLSearchParams('q=ada&filter[name]=lov&filter[tags]=a&filter[tags]=b&page=2'));

        expect(query).toEqual({
            search: 'ada',
            filterModel: {
                name: { filterType: 'text', type: 'contains', filter: 'lov' },
                tags: { filterType: 'text', type: 'contains', filter: ['a', 'b'] },
            },
        });
        expect(queryFromUrl(new URLSearchParams('filter[x]=1'), { toCondition: () => null })).toEqual({});
    });
});

describe('set choices', () => {
    it('lists static choices with a blank first, searches labels and resolves values', async () => {
        const source = staticSetChoices(['Red', { id: 7, label: 'Blue' }, { id: null, label: 'Nothing' }]);

        expect(await source.search('', signal())).toEqual([
            { value: null, label: '(Blank)' },
            { value: 'Red', label: 'Red' },
            { value: '7', label: 'Blue' },
        ]);
        expect(await source.search('BL', signal())).toEqual([
            { value: null, label: '(Blank)' },
            { value: '7', label: 'Blue' },
        ]);
        expect(await source.resolve!(['7'], signal())).toEqual([{ value: '7', label: 'Blue' }]);
        expect(await staticSetChoices(['a'], { blankLabel: false }).search('', signal())).toEqual([
            { value: 'a', label: 'a' },
        ]);
    });

    it('searches and resolves on a grid endpoint with the server request shape', async () => {
        const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ data: [{ id: 3, name: 'Lovelace' }] }),
        }));
        const source = httpSetChoices({ url: '/api/grids/clients', labelField: 'name', fetch: fetcher as never });

        expect(await source.search(' lov ', signal())).toEqual([{ value: '3', label: 'Lovelace' }]);
        expect(fetcher.mock.calls[0]![0]).toBe('/api/grids/clients?startRow=0&endRow=20&fields=id%2Cname&q=lov');
        await source.resolve!(['3', '9'], signal());
        const resolveUrl = new URL(fetcher.mock.calls[1]![0], 'http://x');
        expect(resolveUrl.searchParams.get('endRow')).toBe('2');
        expect(JSON.parse(resolveUrl.searchParams.get('filterModel')!)).toEqual({
            id: { filterType: 'set', values: ['3', '9'] },
        });
    });

    it('puts selected choices first in selection order', () => {
        const choices = [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
            { value: null, label: '(Blank)' },
        ];

        expect(selectedFirst(choices, [null, 'b']).map((choice) => choice.value)).toEqual([null, 'b', 'a']);
    });
});

describe('filters through saved views and requests', () => {
    const full: FilterModel = {
        name: { filterType: 'text', type: 'contains', filter: 'ada' },
        fee: { filterType: 'number', type: 'inRange', filter: 10, filterTo: 20 },
        joined: { filterType: 'date', type: 'lessThan', dateFrom: '2024-01-31 00:00:00' },
        team: { filterType: 'set', type: 'anyOf', values: ['red', null] },
        city: { filterType: 'set', type: 'noneOf', values: ['Paris'] },
        active: { filterType: 'set', values: ['true'] },
        location: {
            filterType: 'coordinates',
            type: 'withinRadius',
            filter: { latitude: 51.2, longitude: 4.4, radius: { value: 25, unit: 'km' } },
        },
        due: {
            filterType: 'date',
            operator: 'OR',
            conditions: [
                { filterType: 'date', type: 'blank' },
                { filterType: 'set', type: 'anyOf', values: ['x'] } as never,
            ],
        },
    };

    it('sends anyOf without a type and noneOf with one, as the baseline requests did', () => {
        const wire = wireFilterModel(full);

        expect(wire.team).toEqual({ filterType: 'set', values: ['red', null] });
        expect(wire.city).toEqual(full.city);
        expect((wire.due as { conditions: unknown[] }).conditions[1]).toEqual({ filterType: 'set', values: ['x'] });
        expect(wire.location).toBe(full.location);
    });

    it('restores a saved query into a new grid that sends the same request', () => {
        const columns = ['name', 'fee', 'joined', 'team', 'city', 'active', 'location', 'due'].map((field) => ({
            field,
        }));
        const first = new GridStore<Record<string, unknown>>({ columns, rows: [], getRowId: (row) => String(row.id) });
        first.setFilterModel(full);
        first.setSearch('lovelace');
        first.setSortModel([{ colId: 'fee', sort: 'desc' }]);
        first.setExternalFilters({ 'client.id': 7 });
        const saved = JSON.parse(JSON.stringify(first.query)) as QueryState;
        const restored = new GridStore<Record<string, unknown>>({
            columns,
            rows: [],
            getRowId: (row) => String(row.id),
            initialQuery: saved,
        });
        const request = (query: QueryState): ServerRowsRequest => ({
            startRow: 0,
            endRow: 100,
            sortModel: query.sortModel,
            filterModel: query.filterModel,
            groupKeys: [],
            rowGroupCols: [],
            q: query.search,
            externalFilters: query.externalFilters,
            signal: signal(),
        });

        expect(restored.query).toEqual(first.query);
        expect(serverRequestParams(request(restored.query)).toString()).toBe(
            serverRequestParams(request(first.query)).toString()
        );
    });

    it('reports sort and grouping changes as query changes', () => {
        const store = new GridStore<{ id: number; team: string }>({
            columns: [{ field: 'id' }, { field: 'team' }],
            rows: [{ id: 1, team: 'a' }],
            getRowId: (row) => String(row.id),
        });
        const changes: QueryState[] = [];
        store.events.on('queryChanged', (event) => changes.push(event.query));
        store.setSortModel([{ colId: 'team', sort: 'asc' }]);
        store.setRowGroupColumns(['team']);
        store.setRowGroupColumns(['team']);

        expect(changes.map((query) => [query.sortModel.length, query.rowGroupColIds.join()])).toEqual([
            [1, ''],
            [1, 'team'],
        ]);
    });
});

describe('static set choices with a blank in the values', () => {
    it('treats a null value as the blank choice, not a second entry', async () => {
        expect(await staticSetChoices([null, 'a']).search('', new AbortController().signal)).toEqual([
            { value: null, label: '(Blank)' },
            { value: 'a', label: 'a' },
        ]);
    });
});
