import { describe, expect, it, vi } from 'vitest';

import type { QueryState, ServerDataSource, ServerRowsRequest } from '../contract';
import { ColumnModel } from '../grid/columns';
import { createHttpDataSource, parseLaravelGridResponse, serverRequestParams } from './httpDataSource';
import { ServerRowModel } from './serverRowModel';

type Row = { id: number; name: string; team?: string; _group?: boolean; _groupKey?: string; _childCount?: number };

type Pending = {
    request: ServerRowsRequest;
    resolve(rows: Row[], rowCount: number | null): void;
    reject(error: unknown): void;
};

/** A source whose responses the test resolves by hand. */
function fakeSource(options: Partial<ServerDataSource<Row>> = {}) {
    const pending: Pending[] = [];
    const source: ServerDataSource<Row> = {
        type: 'server',
        blockSize: 10,
        getRows: (request) =>
            new Promise((resolve, reject) => {
                pending.push({ request, resolve: (rows, rowCount) => resolve({ rows, rowCount }), reject });
            }),
        ...options,
    };

    return { source, pending };
}

const rowsFor = (start: number, count: number, prefix = 'Row'): Row[] =>
    Array.from({ length: count }, (_, index) => ({ id: start + index, name: `${prefix} ${start + index}` }));
const query = (partial: Partial<QueryState> = {}): QueryState => ({
    sortModel: [],
    filterModel: {},
    search: '',
    externalFilters: {},
    rowGroupColIds: [],
    ...partial,
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(
    options: Partial<ServerDataSource<Row>> = {},
    modelOptions: {
        pageSize?: number;
        paginateChildren?: boolean;
        maxConcurrentRequests?: number;
        isMaster?: (data: Row) => boolean;
    } = {}
) {
    const { source, pending } = fakeSource(options);
    const columns = new ColumnModel<Row>([
        { field: 'id' },
        { field: 'name', headerName: 'Name' },
        { field: 'team', headerName: 'Team' },
    ]);
    const changes = vi.fn();
    const loaded = vi.fn();
    const statuses: string[] = [];
    const model = new ServerRowModel<Row>(
        {
            source,
            column: (colId) => columns.getResolved(colId),
            onBlockLoaded: loaded,
            onStatus: (status) => statuses.push(status.state === 'empty' ? `empty:${status.reason}` : status.state),
            ...modelOptions,
        },
        changes
    );

    return { model, pending, changes, loaded, statuses };
}

describe('ServerRowModel loading', () => {
    it('requests the first block for a query and shows its rows and count', async () => {
        const { model, pending, loaded, statuses } = setup();
        model.setQuery(query({ search: '  ada ' }));

        expect(pending).toHaveLength(1);
        expect(pending[0]!.request).toMatchObject({ startRow: 0, endRow: 10, q: 'ada', groupKeys: [] });
        expect(model.getRowAtIndex(0)?.row.kind).toBe('loading');
        pending[0]!.resolve(rowsFor(0, 10), 35);
        await flush();

        expect(model.getRowCount()).toBe(35);
        expect(model.rowSource.count).toBe(35);
        expect(model.getRowAtIndex(3)?.row).toMatchObject({ kind: 'data', id: '3' });
        expect(model.getRowAtIndex(12)?.row.kind).toBe('loading');
        expect(statuses).toEqual(['loading', 'ready']);
        expect(loaded).toHaveBeenCalledWith({ route: [], startRow: 0, endRow: 10 });
    });

    it('requests only missing blocks, at most two at a time, and drops blocks no longer wanted', async () => {
        const { model, pending } = setup();
        model.setQuery(query());
        pending[0]!.resolve(rowsFor(0, 10), 100);
        await flush();
        model.ensureRange(0, 45);
        expect(pending.slice(1).map((entry) => entry.request.startRow)).toEqual([10, 20]);
        // The user scrolled on: blocks 3 and 4 are no longer wanted; 7 and 8 are.
        model.ensureRange(70, 85);
        pending[1]!.resolve(rowsFor(10, 10), 100);
        await flush();

        expect(pending.slice(3).map((entry) => entry.request.startRow)).toEqual([70]);
        pending[2]!.resolve(rowsFor(20, 10), 100);
        await flush();
        expect(pending.slice(4).map((entry) => entry.request.startRow)).toEqual([80]);
        // Asking again for loaded or in-flight blocks requests nothing.
        model.ensureRange(0, 29);
        expect(pending).toHaveLength(5);
    });

    it('aborts in-flight requests on a query change and drops their late responses', async () => {
        const { model, pending } = setup();
        model.setQuery(query({ search: 'a' }));
        const first = pending[0]!;
        model.setQuery(query({ search: 'ab' }));

        expect(first.request.signal.aborted).toBe(true);
        expect(pending[1]!.request.q).toBe('ab');
        first.resolve(rowsFor(0, 10, 'Stale'), 10);
        pending[1]!.resolve(rowsFor(0, 3, 'Fresh'), 3);
        await flush();

        expect((model.getRowAtIndex(0)?.row as { data: Row }).data.name).toBe('Fresh 0');
        expect(model.getRowCount()).toBe(3);
    });

    it('does not reload for an unchanged query', () => {
        const { model, pending } = setup();
        model.setQuery(query({ search: 'a' }));
        model.setQuery(query({ search: 'a ' }));

        expect(pending).toHaveLength(1);
    });

    it('shows noResults for an empty result', async () => {
        const { model, pending, statuses } = setup();
        model.setQuery(query({ search: 'zzz' }));
        pending[0]!.resolve([], 0);
        await flush();

        expect(model.rowSource.count).toBe(0);
        expect(statuses.at(-1)).toBe('empty:noResults');
    });

    it('sends sort, filters, external filters and row group columns', () => {
        const { model, pending } = setup();
        model.setQuery(
            query({
                sortModel: [{ colId: 'name', sort: 'desc' }],
                filterModel: { team: { filterType: 'set', values: ['red'] } },
                externalFilters: { clientId: 7 },
                rowGroupColIds: ['team'],
            })
        );

        expect(pending[0]!.request).toMatchObject({
            sortModel: [{ colId: 'name', sort: 'desc' }],
            filterModel: { team: { filterType: 'set', values: ['red'] } },
            externalFilters: { clientId: 7 },
            rowGroupCols: [{ id: 'team', field: 'team', displayName: 'Team' }],
        });
    });
});

describe('ServerRowModel without a query (loadWithoutQuery: false)', () => {
    it('shows noQuery until search, a filter or an external filter asks for rows', async () => {
        const { model, pending, statuses } = setup({ loadWithoutQuery: false });
        model.setQuery(query());
        model.ensureRange(0, 20);
        expect(pending).toHaveLength(0);
        expect(statuses).toEqual(['empty:noQuery']);
        // An empty set filter does not count (today's rule).
        model.setQuery(query({ filterModel: { team: { filterType: 'set', values: [] } } }));
        expect(pending).toHaveLength(0);
        model.setQuery(query({ externalFilters: { clientId: 1 } }));

        expect(pending).toHaveLength(1);
    });

    it('a sort alone loads only a grid that already shows rows', async () => {
        const { model, pending } = setup({ loadWithoutQuery: false });
        model.setQuery(query());
        model.setQuery(query({ sortModel: [{ colId: 'name', sort: 'asc' }] }));
        expect(pending).toHaveLength(0);
        model.setQuery(query({ search: 'a', sortModel: [{ colId: 'name', sort: 'asc' }] }));
        pending[0]!.resolve(rowsFor(0, 5), 5);
        await flush();
        model.setQuery(query({ search: 'a', sortModel: [{ colId: 'name', sort: 'desc' }] }));

        expect(pending).toHaveLength(2);
        expect(pending[1]!.request.sortModel).toEqual([{ colId: 'name', sort: 'desc' }]);
    });
});

describe('ServerRowModel without server counts', () => {
    it('finds the end in a few requests after a jump past it, never showing a wrong count', async () => {
        const { model, pending } = setup({}, { pageSize: 1000 });
        const answer = async (index: number, total: number) => {
            const { startRow } = pending[index]!.request;
            pending[index]!.resolve(rowsFor(startRow, Math.max(0, Math.min(10, total - startRow))), null);
            await flush();
        };
        // Page 3 chosen before the count is known, then a refresh: block 300 is far past the 25 rows.
        model.setQuery(query());
        model.setPage(3);
        model.refresh();
        let index = 0;
        while (index < pending.length) {
            await answer(index, 25);
            expect([null, 25]).toContain(model.getPagination()!.rowCount);
            index++;
        }

        expect(model.getPagination()!.rowCount).toBe(25);
        // Block 300, then a bisection of blocks 1 to 299.
        expect(pending.length).toBeLessThanOrEqual(12);
    });
});

describe('ServerRowModel errors, refresh and cache', () => {
    it('shows an error, does not retry a failed block on scroll, and retries on refresh', async () => {
        const { model, pending, statuses } = setup();
        model.setQuery(query());
        pending[0]!.reject(new Error('down'));
        await flush();
        expect(statuses.at(-1)).toBe('error');
        expect(model.getRowAtIndex(0)?.row.kind).toBe('failed');
        model.ensureRange(0, 9);
        expect(pending).toHaveLength(1);
        model.refresh();
        expect(pending).toHaveLength(2);
        pending[1]!.resolve(rowsFor(0, 4), 4);
        await flush();

        expect(statuses.at(-1)).toBe('ready');
    });

    it('refresh without purge keeps rows on screen and replaces blocks as they reload', async () => {
        const { model, pending } = setup();
        model.setQuery(query());
        pending[0]!.resolve(rowsFor(0, 10, 'Old'), 10);
        await flush();
        model.refresh({ purge: false });
        expect((model.getRowAtIndex(0)?.row as { data: Row }).data.name).toBe('Old 0');
        model.ensureRange(0, 9);
        expect(pending).toHaveLength(2);
        pending[1]!.resolve(rowsFor(0, 10, 'New'), 10);
        await flush();

        expect((model.getRowAtIndex(0)?.row as { data: Row }).data.name).toBe('New 0');
    });

    it('refresh with purge clears and reloads', async () => {
        const { model, pending } = setup();
        model.setQuery(query());
        pending[0]!.resolve(rowsFor(0, 10), 10);
        await flush();
        model.refresh({ purge: true });

        expect(model.getRowAtIndex(0)?.row.kind).toBe('loading');
        expect(pending).toHaveLength(2);
    });

    it('evicts least recently used blocks beyond maxBlocksInCache, never visible ones', async () => {
        const { model, pending } = setup({ maxBlocksInCache: 2 }, { maxConcurrentRequests: 1 });
        model.setQuery(query());
        pending[0]!.resolve(rowsFor(0, 10), 100);
        await flush();
        for (const [index, start] of [10, 20].entries()) {
            model.ensureRange(start, start + 9);
            pending[index + 1]!.resolve(rowsFor(start, 10), 100);
            await flush();
        }

        expect(model.getRowAtIndex(0)?.row.kind).toBe('loading');
        expect(model.getRowAtIndex(10)?.row.kind).toBe('data');
        expect(model.getRowAtIndex(20)?.row.kind).toBe('data');
    });

    it('patches loaded rows without reloading', async () => {
        const { model, pending } = setup();
        model.setQuery(query());
        pending[0]!.resolve(rowsFor(0, 3), 3);
        await flush();
        model.patchRows([{ id: '1', data: { id: 1, name: 'Patched' } }]);

        expect((model.getRow('1') as { data: Row }).data.name).toBe('Patched');
        expect(pending).toHaveLength(1);
        expect(() => model.applyTransaction()).toThrow(/patchRows/);
    });
});

describe('ServerRowModel groups and pagination', () => {
    it('loads group children by key path when a group expands', async () => {
        const { model, pending } = setup();
        model.setQuery(query({ rowGroupColIds: ['team'] }));
        pending[0]!.resolve(
            [
                { id: 0, name: '', _group: true, _groupKey: 'red', _childCount: 2 },
                { id: 0, name: '', _group: true, _groupKey: 'blue', _childCount: 1 },
            ],
            2
        );
        await flush();
        const red = model.getRowAtIndex(0)!.row;
        expect(red.kind).toBe('group');
        model.setExpanded(red.id, true);
        expect(model.rowSource.count).toBe(4);
        model.ensureRange(0, 3);

        expect(pending[1]!.request).toMatchObject({ groupKeys: ['red'], startRow: 0, rowGroupCols: [{ id: 'team' }] });
        pending[1]!.resolve(
            [
                { id: 10, name: 'Ada', team: 'red' },
                { id: 11, name: 'Bo', team: 'red' },
            ],
            2
        );
        await flush();
        expect(model.getRowAtIndex(1)?.row).toMatchObject({ kind: 'data', id: '10' });
        expect(model.isExpanded(red.id)).toBe(true);
    });

    it('pages over displayed rows with page-relative indexes', async () => {
        const { model, pending } = setup({}, { pageSize: 10 });
        model.setQuery(query());
        pending[0]!.resolve(rowsFor(0, 10), 25);
        await flush();
        expect(model.getPagination()).toEqual({ page: 0, pageSize: 10, rowCount: 25, pageCount: 3 });
        model.setPage(2);
        expect(model.rowSource.count).toBe(5);
        model.ensureRange(0, 4);
        expect(pending[1]!.request.startRow).toBe(20);
        pending[1]!.resolve(rowsFor(20, 5), 25);
        await flush();
        expect(model.getRowAtIndex(0)?.row.id).toBe('20');
        expect(model.getIndexOf('22')).toBe(2);
        expect(model.getIndexOf('3')).toBeUndefined();
        model.setPage(9);
        expect(model.getPagination()?.page).toBe(2);
        // A new query starts at the first page.
        model.setQuery(query({ search: 'x' }));

        expect(model.getPagination()?.page).toBe(0);
    });
});

describe('HTTP data source', () => {
    const request = (partial: Partial<ServerRowsRequest> = {}): ServerRowsRequest => ({
        startRow: 100,
        endRow: 200,
        sortModel: [],
        filterModel: {},
        groupKeys: [],
        rowGroupCols: [],
        q: '',
        externalFilters: {},
        signal: new AbortController().signal,
        ...partial,
    });

    it('builds the backend query string in a fixed order, only with what is present', () => {
        expect(serverRequestParams(request()).toString()).toBe('startRow=100&endRow=200');
        const full = serverRequestParams(
            request({
                sortModel: [{ colId: 'name', sort: 'asc' }],
                filterModel: { team: { filterType: 'text', type: 'equals', filter: 'red' } },
                groupKeys: ['red'],
                rowGroupCols: [{ id: 'team', field: 'team', displayName: 'Team' }],
                q: '  ada ',
                externalFilters: { 'client.id': 7 },
            })
        );

        expect([...full.keys()]).toEqual([
            'startRow',
            'endRow',
            'sortModel',
            'filterModel',
            'groupKeys',
            'rowGroupCols',
            'q',
            'filter[client.id]',
        ]);
        expect(full.get('sortModel')).toBe('[{"colId":"name","sort":"asc"}]');
        expect(full.get('q')).toBe('ada');
        expect(full.get('filter[client.id]')).toBe('7');
    });

    it('fetches, parses { data, metadata.found }, passes the signal and extra params, and throws on errors', async () => {
        const fetcher = vi.fn(async (url: string, _init?: RequestInit) => ({
            ok: !url.includes('fail'),
            status: 500,
            statusText: 'Server Error',
            json: async () => ({ data: [{ id: 1 }], metadata: { found: 42 } }),
        }));
        const source = createHttpDataSource<{ id: number }>({
            url: '/api/grids/people',
            fetch: fetcher as never,
            extraParams: () => ({ highlights: true, skip: undefined }),
        });
        const signal = new AbortController().signal;

        expect(await source.getRows(request({ signal }))).toEqual({ rows: [{ id: 1 }], rowCount: 42 });
        expect(fetcher.mock.calls[0]![0]).toBe('/api/grids/people?startRow=100&endRow=200&highlights=true');
        expect(fetcher.mock.calls[0]![1]?.signal).toBe(signal);
        const failing = createHttpDataSource({ url: '/fail', fetch: fetcher as never });
        await expect(failing.getRows(request())).rejects.toThrow(/500/);
        expect(parseLaravelGridResponse({})).toEqual({ rows: [], rowCount: null });
    });
});

describe('ServerRowModel master/detail', () => {
    it('inserts local detail rows among remote tree children without requesting a child route', async () => {
        const { model, pending } = setup(
            { getTreeKey: (data) => data.team ?? null },
            { isMaster: (data) => data.name.includes('changed') }
        );
        model.setQuery(query());
        pending[0]!.resolve([{ id: 1, name: 'Transaction changed', team: 'transaction' }], 1);
        await flush();
        model.setExpanded('1', true);
        model.ensureRange(0, 2);
        expect(pending[1]!.request.groupKeys).toEqual(['transaction']);
        pending[1]!.resolve(
            [
                { id: 2, name: 'Event changed' },
                { id: 3, name: 'Viewed' },
            ],
            2
        );
        await flush();
        expect(model.getRow('2')).toMatchObject({ expandable: { expanded: false } });
        model.setExpanded('2', true);
        expect(model.getRowCount()).toBe(4);
        expect(model.rowSource.count).toBe(4);
        expect(model.getRowAtIndex(2)?.row).toMatchObject({
            kind: 'detail',
            id: 'detail:2',
            masterId: '2',
            parentId: '2',
            level: 2,
            data: { id: 2 },
        });
        expect(model.getIndexOf('3')).toBe(3);
        const ids: string[] = [];
        model.forEachRow((row) => ids.push(row.id));
        expect(ids).toEqual(['1', '2', 'detail:2', '3']);
        model.ensureRange(2, 3);
        expect(pending).toHaveLength(2);
        expect(model.expandedIds).toEqual(new Set(['1', '2']));
        model.setExpanded('1', false);
        expect(model.getRow('detail:2')).toBeUndefined();
        expect(model.getIndexOf('detail:2')).toBeUndefined();
        model.setExpanded('1', true);
        expect(model.getIndexOf('detail:2')).toBe(2);
        expect(model.isExpanded('2')).toBe(true);
        model.setExpanded('2', false);
        expect(model.getRowCount()).toBe(3);
        expect(model.getIndexOf('3')).toBe(2);
    });

    it('maps viewport blocks and page indexes around expanded details', async () => {
        const { model, pending } = setup({}, { pageSize: 10, isMaster: () => true });
        model.setQuery(query());
        pending[0]!.resolve(rowsFor(0, 10), 20);
        await flush();
        model.setExpanded('0', true);
        model.setExpanded('1', true);
        expect(model.getPagination()).toMatchObject({ rowCount: 22, pageCount: 3 });
        model.setPage(1);
        expect(model.getRowAtIndex(0)?.row.id).toBe('8');
        expect(model.getIndexOf('8')).toBe(0);
        model.ensureRange(0, 9);
        expect(pending[1]!.request).toMatchObject({ startRow: 10, endRow: 20, groupKeys: [] });
        pending[1]!.resolve(rowsFor(10, 10), 20);
        await flush();
        expect(model.getRowAtIndex(9)?.row.id).toBe('17');
        model.setPage(2);
        expect(model.getRowAtIndex(0)?.row.id).toBe('18');
        expect(model.getRowCount()).toBe(2);
    });

    it('reconciles detail data and eligibility on patch, refresh and a changed query', async () => {
        const { model, pending } = setup({}, { isMaster: (data) => data.name !== 'Viewed' });
        model.setQuery(query());
        pending[0]!.resolve([{ id: 1, name: 'Changed' }], 1);
        await flush();
        model.setExpanded('1', true);
        model.patchRows([{ id: '1', data: { id: 1, name: 'Updated' } }]);
        expect(model.getRow('detail:1')).toMatchObject({ data: { name: 'Updated' } });
        model.refresh({ purge: false });
        model.ensureRange(0, 1);
        expect(model.getRow('detail:1')).toBeDefined();
        pending[1]!.resolve([{ id: 1, name: 'Refreshed' }], 1);
        await flush();
        expect(model.getRow('detail:1')).toMatchObject({ data: { name: 'Refreshed' } });
        model.refresh({ purge: true });
        expect(model.getRow('detail:1')).toBeUndefined();
        pending[2]!.resolve([{ id: 1, name: 'Returned' }], 1);
        await flush();
        expect(model.getRow('detail:1')).toBeDefined();
        model.setQuery(query({ search: 'new' }));
        expect(model.getRow('detail:1')).toBeUndefined();
        pending[3]!.resolve([{ id: 1, name: 'Viewed' }], 1);
        await flush();
        expect(model.getRow('1')).not.toHaveProperty('expandable');
        expect(model.getRow('detail:1')).toBeUndefined();
        expect(model.isExpanded('1')).toBe(false);
    });
});

describe('ServerRowModel option changes', () => {
    it('updates tree mode and master eligibility without retaining obsolete child routes', async () => {
        const { source, pending } = fakeSource();
        const initial = { source, column: () => undefined, isMaster: (data: Row) => data.name === 'Changed' };
        const model = new ServerRowModel(initial);
        model.setQuery(query());
        pending[0]!.resolve(
            [
                { id: 1, name: 'Transaction', team: 'transaction' },
                { id: 2, name: 'Changed' },
            ],
            2
        );
        await flush();
        model.setExpanded('2', true);
        expect(model.getRowCount()).toBe(3);
        const treeSource = { ...source, getTreeKey: (data: Row) => data.team ?? null };
        model.setOptions({ ...initial, source: treeSource });
        pending[1]!.resolve([{ id: 1, name: 'Transaction', team: 'transaction' }], 1);
        await flush();
        model.setExpanded('1', true);
        model.ensureRange(0, 2);
        expect(pending[2]!.request.groupKeys).toEqual(['transaction']);
        model.setOptions(initial);
        expect(pending[2]!.request.signal.aborted).toBe(true);
        expect(pending[3]!.request.groupKeys).toEqual([]);
        pending[3]!.resolve([{ id: 2, name: 'Changed' }], 1);
        await flush();
        expect(model.getRow('detail:2')).toBeDefined();
        model.setOptions({ source, column: () => undefined });
        expect(model.getRow('2')).not.toHaveProperty('expandable');
        expect(model.getRow('detail:2')).toBeUndefined();
    });

    it('returns to the last available page when expanded details disappear', async () => {
        const { model, pending } = setup({}, { pageSize: 10, isMaster: () => true });
        model.setQuery(query());
        pending[0]!.resolve(rowsFor(0, 10), 10);
        await flush();
        model.setExpanded('0', true);
        model.setPage(1);
        expect(model.getRowAtIndex(0)?.row.id).toBe('9');
        model.setExpanded('0', false);
        expect(model.getPagination()).toMatchObject({ page: 0, pageCount: 1 });
        expect(model.getRowAtIndex(0)?.row.id).toBe('0');
    });
});

describe('ServerRowModel root pagination', () => {
    it('loads the second child block of a large transaction while details stay on its root page', async () => {
        const { model, pending } = setup(
            { blockSize: 100, getTreeKey: (data) => data.team ?? null },
            { pageSize: 100, paginateChildren: false, isMaster: (data) => data.id === 1000 }
        );
        model.setQuery(query());
        pending[0]!.resolve([{ id: 1, name: 'Transaction', team: 'uuid' }], 1);
        await flush();
        model.setExpanded('1', true);
        model.ensureRange(0, 20);
        pending[1]!.resolve(rowsFor(1000, 100), 112);
        await flush();
        model.setExpanded('1000', true);
        expect(model.getPagination()).toMatchObject({ page: 0, rowCount: 1, pageCount: 1 });
        expect(model.getRowCount()).toBe(114);
        expect(model.rowSource.count).toBe(114);
        expect(model.getRowAtIndex(2)?.row.id).toBe('detail:1000');
        model.ensureRange(110, 113);
        expect(pending[2]!.request).toMatchObject({ startRow: 100, endRow: 200, groupKeys: ['uuid'] });
        pending[2]!.resolve(rowsFor(1100, 12), 112);
        await flush();
        expect(model.getRowAtIndex(113)?.row.id).toBe('1111');
        expect(model.getIndexOf('1111')).toBe(113);
        model.setExpanded('1', false);
        expect(model.getRowCount()).toBe(1);
        model.setExpanded('1', true);
        expect(model.getRowCount()).toBe(114);
        expect(model.getIndexOf('detail:1000')).toBe(2);
        expect(pending).toHaveLength(3);
    });

    it('keeps later root pages aligned when an earlier transaction and detail collapse', async () => {
        const { model, pending } = setup(
            { getTreeKey: (data) => data.team ?? null },
            { pageSize: 1, paginateChildren: false, isMaster: (data) => data.name === 'Changed' }
        );
        model.setQuery(query());
        pending[0]!.resolve(
            [
                { id: 1, name: 'Transaction', team: 'uuid' },
                { id: 200, name: 'Next root' },
            ],
            2
        );
        await flush();
        model.setExpanded('1', true);
        model.ensureRange(0, 2);
        pending[1]!.resolve([{ id: 2, name: 'Changed' }], 1);
        await flush();
        model.setExpanded('2', true);
        expect(model.rowSource.count).toBe(3);
        expect(model.getPagination()).toMatchObject({ rowCount: 2, pageCount: 2 });
        model.setPage(1);
        expect(model.getRowCount()).toBe(1);
        expect(model.getRowAtIndex(0)?.row.id).toBe('200');
        expect(model.getIndexOf('200')).toBe(0);
        expect(model.getIndexOf('detail:2')).toBeUndefined();
        model.setExpanded('1', false);
        expect(model.getRowAtIndex(0)?.row.id).toBe('200');
        model.setExpanded('1', true);
        expect(model.getRowAtIndex(0)?.row.id).toBe('200');
        model.setPage(0);
        expect(model.getRowAtIndex(2)?.row.id).toBe('detail:2');
        model.ensureRange(0, 2);
        expect(pending).toHaveLength(2);
    });
});
