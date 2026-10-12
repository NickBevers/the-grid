/**
 * A `ServerDataSource` over HTTP GET, in a common server-side row request and response shape
 * as Laravel backends commonly serve it:
 *
 *   GET {url}?startRow=0&endRow=100&sortModel=[...]&filterModel={...}&groupKeys=[...]&rowGroupCols=[...]
 *       &q=text&filter[key]=value
 *   → { data: TData[], metadata: { found: number } }
 *
 * Parameters are added in that order, and only when present. `extraParams`, `parseResponse` and `fetch`
 * adapt it to other backends.
 */
import type { FilterModel, ServerDataSource, ServerRowsRequest, ServerRowsResponse } from '../contract';

export type HttpDataSourceOptions<TData> = Omit<ServerDataSource<TData>, 'type' | 'getRows'> & {
    /** The endpoint, or a function of the request for endpoints that vary. */
    url: string | ((request: ServerRowsRequest) => string);
    /** Extra query parameters appended last (for example `fields` or `highlights`). */
    extraParams?: (request: ServerRowsRequest) => Record<string, string | number | boolean | undefined>;
    /** Turns the response body into rows and a count. Default: `{ data, metadata: { found } }`. */
    parseResponse?: (body: unknown) => ServerRowsResponse<TData>;
    fetch?: typeof fetch;
    init?: RequestInit;
};

/** The query string for one block request, in the backend's order. */
export function serverRequestParams(request: ServerRowsRequest): URLSearchParams {
    const params = new URLSearchParams();
    params.append('startRow', String(request.startRow));
    params.append('endRow', String(request.endRow));
    if (request.sortModel.length > 0) {
        params.append('sortModel', JSON.stringify(request.sortModel.map(({ colId, sort }) => ({ colId, sort }))));
    }
    if (Object.keys(request.filterModel).length > 0) {
        params.append('filterModel', JSON.stringify(wireFilterModel(request.filterModel)));
    }
    if (request.groupKeys.length > 0) {
        params.append('groupKeys', JSON.stringify(request.groupKeys));
    }
    if (request.rowGroupCols.length > 0) {
        params.append('rowGroupCols', JSON.stringify(request.rowGroupCols));
    }
    if (request.q.trim() !== '') {
        params.append('q', request.q.trim());
    }
    for (const [key, value] of Object.entries(request.externalFilters)) {
        params.append(`filter[${key}]`, String(value));
    }

    return params;
}

/** The default response shape: `{ data, metadata: { found } }`. */
export function parseLaravelGridResponse<TData>(body: unknown): ServerRowsResponse<TData> {
    const record = (body ?? {}) as { data?: TData[]; metadata?: { found?: number | null } };
    const found = record.metadata?.found;

    return { rows: Array.isArray(record.data) ? record.data : [], rowCount: typeof found === 'number' ? found : null };
}

export function createHttpDataSource<TData>(options: HttpDataSourceOptions<TData>): ServerDataSource<TData> {
    const { url, extraParams, parseResponse = parseLaravelGridResponse, fetch: fetcher, init, ...rest } = options;

    return {
        ...rest,
        type: 'server',
        async getRows(request) {
            const params = serverRequestParams(request);
            for (const [key, value] of Object.entries(extraParams?.(request) ?? {})) {
                if (value !== undefined) {
                    params.append(key, String(value));
                }
            }
            const endpoint = typeof url === 'function' ? url(request) : url;
            const response = await (fetcher ?? fetch)(
                `${endpoint}${endpoint.includes('?') ? '&' : '?'}${params.toString()}`,
                {
                    ...init,
                    headers: { Accept: 'application/json', ...init?.headers },
                    signal: request.signal,
                }
            );
            if (!response.ok) {
                throw new Error(`Grid request failed: ${response.status} ${response.statusText}`);
            }

            return parseResponse(await response.json());
        },
    };
}

/**
 * The filter model in its wire form: a set condition carries `type` only for `noneOf`, since `anyOf` is
 * the default the backend assumes. Everything else is sent unchanged.
 */
export function wireFilterModel(model: FilterModel): FilterModel {
    const wire = (condition: FilterModel[string]): FilterModel[string] => {
        if (Array.isArray((condition as { conditions?: unknown }).conditions)) {
            const combined = condition as { conditions: FilterModel[string][] };

            return { ...condition, conditions: combined.conditions.map(wire) } as FilterModel[string];
        }
        if (condition.filterType === 'set' && (condition as { type?: string }).type === 'anyOf') {
            const { type: _type, ...rest } = condition as { type?: string };

            return rest as FilterModel[string];
        }

        return condition;
    };

    return Object.fromEntries(Object.entries(model).map(([colId, condition]) => [colId, wire(condition)]));
}
