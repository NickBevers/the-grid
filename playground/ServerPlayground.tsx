/**
 * Playground for the full grid on server rows. 100,000 people from a fake backend with latency,
 * through `createHttpDataSource` and a fetch that answers locally, so the request path is the real one.
 *
 *   ?fixture=server[&paged=1][&noQuery=1]
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import '../src/styles/grid.css';
import './themes/app-theme.css';
import {
    applyViewState,
    captureViewState,
    DEFAULT_CONTEXT_MENU,
    getExportQuery,
    createHttpDataSource,
    Grid,
    httpSetChoices,
    queryFromUrl,
    staticSetChoices,
    useGridSearch,
    type ColumnDefinition,
    type GridApi,
    type GridViewState,
    type QueryState,
} from '../src';
import { FilterBar, type FilterBarColumn } from './FilterBar';
import { backend, CITIES, fakeGetRows, runExport, TEAMS, type Person, type RequestLogEntry } from './serverFixture';

const params = new URLSearchParams(location.search);
const PAGED = params.get('paged') === '1';
const NO_QUERY = params.get('noQuery') === '1';
const NO_ERROR_OVERLAY = params.get('errorOverlay') === 'off';
const GROUP_DISPLAY = params.get('groupDisplay') === 'column' ? 'column' : 'fullWidthRow';

const columns: ColumnDefinition<Person>[] = [
    { field: 'id', headerName: 'ID', width: 90, pinned: 'left', filter: 'number' },
    { field: 'name', headerName: 'Name', width: 220, pinned: 'left', filter: 'text' },
    {
        field: 'team',
        headerName: 'Team',
        width: 140,
        enableRowGroup: true,
        filter: 'set',
        filterParams: { values: TEAMS },
    },
    { field: 'city', headerName: 'City', width: 140, filter: 'set', filterParams: { values: CITIES } },
    { field: 'fee', headerName: 'Fee', width: 120, cellClass: 'ig-number', filter: 'number' },
    { field: 'joined', headerName: 'Joined', width: 140, filter: 'date' },
];

declare global {
    interface Window {
        __srv?: {
            api: GridApi<Person> | null;
            log: RequestLogEntry[];
            choiceLog: string[];
            backend: typeof backend;
            query: QueryState;
            lastExport: { query: ReturnType<typeof getExportQuery>; csv: string } | null;
            lastState: GridViewState | null;
            lastStateSaves: number;
            applyView: (view: GridViewState) => void;
            captureView: () => GridViewState | null;
        };
    }
}

/** A fetch that answers from the fake backend, so the data source's URL building and parsing run for real. */
const localFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const query = new URL(url, location.origin).searchParams;
    if (url.startsWith('/api/grids/teams')) {
        return answerTeams(url, query);
    }
    const request = {
        startRow: Number(query.get('startRow')),
        endRow: Number(query.get('endRow')),
        sortModel: JSON.parse(query.get('sortModel') ?? '[]'),
        filterModel: JSON.parse(query.get('filterModel') ?? '{}'),
        groupKeys: JSON.parse(query.get('groupKeys') ?? '[]'),
        rowGroupCols: JSON.parse(query.get('rowGroupCols') ?? '[]'),
        q: query.get('q') ?? '',
        externalFilters: Object.fromEntries(
            [...query].filter(([key]) => key.startsWith('filter[')).map(([key, value]) => [key.slice(7, -1), value])
        ),
        signal: init!.signal!,
    };
    const body = await fakeGetRows(request, url);

    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

/** A small grid endpoint for searched set choices: teams by name, or by id through a set filter. */
const choiceLog: string[] = [];
async function answerTeams(url: string, query: URLSearchParams): Promise<Response> {
    choiceLog.push(url);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const teams = TEAMS.map((name) => ({ id: name, name }));
    const ids = (JSON.parse(query.get('filterModel') ?? '{}') as { id?: { values: string[] } }).id?.values;
    const q = (query.get('q') ?? '').toLowerCase();
    const data = ids
        ? teams.filter((team) => ids.includes(team.id))
        : teams.filter((team) => team.name.toLowerCase().includes(q));

    return new Response(JSON.stringify({ data: data.slice(0, Number(query.get('endRow'))) }), { status: 200 });
}

const EMPTY_QUERY: QueryState = { sortModel: [], filterModel: {}, search: '', externalFilters: {}, rowGroupColIds: [] };

const filterColumns: FilterBarColumn[] = [
    {
        colId: 'name',
        label: 'Name',
        kind: 'text',
        filterParams: { filterOptions: ['contains', 'equals', 'blank', 'notBlank'] },
    },
    {
        colId: 'team',
        label: 'Team',
        kind: 'set',
        choices: httpSetChoices({ url: '/api/grids/teams', labelField: 'name', fetch: localFetch }),
    },
    { colId: 'city', label: 'City', kind: 'set', choices: staticSetChoices(CITIES) },
    { colId: 'fee', label: 'Fee', kind: 'number' },
    { colId: 'joined', label: 'Joined', kind: 'date' },
];

export function ServerPlayground() {
    const apiRef = useRef<GridApi<Person> | null>(null);
    const [api, setApi] = useState<GridApi<Person> | null>(null);
    // A controlled query, seeded from the URL (`?q=` and `filter[colId]=`).
    const [query, setQuery] = useState<QueryState>(() => ({ ...EMPTY_QUERY, ...queryFromUrl(params) }));
    const [savedView, setSavedView] = useState<string | null>(null);
    // Auto-saves the last state 1 s after the view last changed, as an application would.
    const autoSave = useRef<ReturnType<typeof setTimeout> | null>(null);
    const onViewStateChanged = useCallback(() => {
        if (autoSave.current) {
            clearTimeout(autoSave.current);
        }
        autoSave.current = setTimeout(() => {
            if (window.__srv && apiRef.current) {
                window.__srv.lastState = captureViewState(apiRef.current);
                window.__srv.lastStateSaves++;
            }
        }, 1000);
    }, []);
    const search = useGridSearch(api, { initial: query.search });
    const [grouped, setGrouped] = useState(false);
    const [requests, setRequests] = useState(0);
    const [pagination, setPagination] = useState<ReturnType<GridApi<Person>['getPagination']>>(null);
    const data = useMemo(
        () =>
            createHttpDataSource<Person>({
                url: '/api/grids/people',
                fetch: localFetch,
                getRowId: (person) => String(person.id),
                blockSize: 100,
                ...(NO_QUERY ? { loadWithoutQuery: false } : {}),
            }),
        []
    );

    useEffect(() => {
        window.__srv = {
            get api() {
                return apiRef.current;
            },
            log: backend.log,
            choiceLog,
            backend,
            query: EMPTY_QUERY,
            lastExport: null,
            lastState: null,
            lastStateSaves: 0,
            applyView: (view: GridViewState) => apiRef.current && applyViewState(apiRef.current, view),
            captureView: () => (apiRef.current ? captureViewState(apiRef.current) : null),
        };
        setApi(apiRef.current);
        const timer = setInterval(() => {
            setRequests(backend.log.length);
            setPagination(apiRef.current?.getPagination() ?? null);
        }, 200);

        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        if (window.__srv) {
            window.__srv.query = query;
        }
    }, [query]);
    const onQueryChange = useCallback((next: QueryState) => setQuery(next), []);

    return (
        <div className="ig-page">
            <div className="ig-bar" data-test="server-bar">
                <label>
                    Search
                    <input
                        data-test="search"
                        value={search.value}
                        onChange={(event) => search.setValue(event.target.value)}
                        onKeyDown={(event) => event.key === 'Enter' && search.applyNow()}
                        placeholder="name, team or city"
                    />
                </label>
                <button
                    type="button"
                    data-test="filter-fee"
                    onClick={() =>
                        apiRef.current?.setColumnFilter('fee', {
                            filterType: 'number',
                            type: 'greaterThan',
                            filter: 4000,
                        })
                    }
                >
                    Fee over 4,000
                </button>
                <button type="button" data-test="filter-clear" onClick={() => apiRef.current?.setFilterModel({})}>
                    Clear filters
                </button>
                <label>
                    <input
                        type="checkbox"
                        data-test="group-team"
                        checked={grouped}
                        onChange={(event) => {
                            setGrouped(event.target.checked);
                            apiRef.current?.setRowGroupColumns(event.target.checked ? ['team'] : []);
                        }}
                    />
                    Group by team
                </label>
                <button type="button" data-test="fail-next" onClick={() => (backend.failNext = 1)}>
                    Fail next request
                </button>
                <button type="button" data-test="refresh" onClick={() => apiRef.current?.refresh({ purge: false })}>
                    Refresh
                </button>
                <button
                    type="button"
                    data-test="save-view"
                    onClick={() => apiRef.current && setSavedView(JSON.stringify(captureViewState(apiRef.current)))}
                >
                    Save view
                </button>
                <button
                    type="button"
                    data-test="restore-view"
                    disabled={!savedView}
                    onClick={() => {
                        const restored = JSON.parse(savedView!) as GridViewState;
                        applyViewState(apiRef.current!, restored);
                        search.setValue(restored.searchQuery ?? '');
                    }}
                >
                    Restore view
                </button>
                <span data-test="request-count">{requests} requests</span>
            </div>
            <FilterBar api={api} columns={filterColumns} filterModel={query.filterModel} />
            <div className="ig-frame">
                <Grid<Person>
                    {...(NO_ERROR_OVERLAY ? { errorOverlay: false as const } : {})}
                    className="ig app-theme"
                    data={data}
                    columns={columns}
                    apiRef={apiRef}
                    query={query}
                    onQueryChange={onQueryChange}
                    on={{ viewStateChanged: onViewStateChanged }}
                    getContextMenuItems={() => [
                        ...DEFAULT_CONTEXT_MENU,
                        'separator',
                        {
                            id: 'export',
                            label: 'Export CSV',
                            onSelect: () => {
                                const exportQuery = getExportQuery(apiRef.current!);
                                const headers = Object.fromEntries(
                                    columns.map((column) => [
                                        'field' in column ? column.field! : '',
                                        'headerName' in column ? String(column.headerName) : '',
                                    ])
                                );
                                window.__srv!.lastExport = { query: exportQuery, csv: runExport(exportQuery, headers) };
                            },
                        },
                    ]}
                    ariaLabel="People"
                    rowSelection="multiple"
                    enableRanges
                    pagination={PAGED ? { pageSize: 100 } : false}
                    groupDisplay={GROUP_DISPLAY}
                    footer={
                        pagination ? (
                            <div data-test="pager">
                                <button
                                    type="button"
                                    data-test="page-prev"
                                    onClick={() => apiRef.current?.setPage(pagination.page - 1)}
                                >
                                    Previous
                                </button>{' '}
                                Page {pagination.page + 1} of {pagination.pageCount ?? '?'}{' '}
                                <button
                                    type="button"
                                    data-test="page-next"
                                    onClick={() => apiRef.current?.setPage(pagination.page + 1)}
                                >
                                    Next
                                </button>
                            </div>
                        ) : (
                            <div data-test="footer">Server rows, 100 per block</div>
                        )
                    }
                />
            </div>
        </div>
    );
}
