/**
 * A fake grid backend for the server playground: 100,000 people answered in the request contract
 * (`startRow`, `endRow`, `sortModel`, `filterModel`, `groupKeys`, `rowGroupCols`, `q`, `filter[key]` →
 * `{ data, metadata: { found } }`), with latency, aborts, an error switch and a request log.
 *
 * It filters with the package's own filter kinds, so a filter model means the same here as in the grid.
 */
import { createFilterPredicate, type ServerRowsRequest } from '../src';
import { ColumnModel } from '../src/grid/columns';

export type Person = {
    id: number;
    name: string;
    team: string;
    city: string;
    fee: number | null;
    joined: string;
    _group?: boolean;
    _groupKey?: string;
    _childCount?: number;
};

export const TEAMS = ['Admin', 'Design', 'Finance', 'Legal', 'Marketing', 'Support'];
export const CITIES = ['Amsterdam', 'Antwerp', 'Berlin', 'Ghent', 'Lisbon', 'London', 'Madrid', 'Paris'];
const FIRST = ['Ada', 'Bo', 'Cleo', 'Dani', 'Eli', 'Fien', 'Gus', 'Hana', 'Ivo', 'Juno', 'Kai', 'Lena'];
const LAST = ['Archer', 'Baker', 'Carter', 'Dewit', 'Evans', 'Fox', 'Grant', 'Hale', 'Ito', 'Janssens'];

export const PEOPLE: Person[] = Array.from({ length: 100_000 }, (_, id) => ({
    id,
    name: `${FIRST[id % FIRST.length]} ${LAST[Math.floor(id / FIRST.length) % LAST.length]} ${id}`,
    team: TEAMS[(id * 7) % TEAMS.length]!,
    city: CITIES[(id * 3) % CITIES.length]!,
    fee: id % 9 === 0 ? null : (id * 37) % 5000,
    joined: `20${String(10 + (id % 16)).padStart(2, '0')}-${String(1 + (id % 12)).padStart(2, '0')}-${String(1 + (id % 28)).padStart(2, '0')}`,
}));

const columns = new ColumnModel<Person>([
    { field: 'id' },
    { field: 'name' },
    { field: 'team' },
    { field: 'city' },
    { field: 'fee' },
    { field: 'joined' },
]);

export type RequestLogEntry = {
    url: string;
    startRow: number;
    endRow: number;
    q: string;
    groupKeys: unknown[];
    aborted: boolean;
    done: boolean;
    at: number;
};

export const backend = {
    log: [] as RequestLogEntry[],
    failNext: 0,
    latency: [100, 300] as [number, number],
};

/** The backend's answer for one request, as the URL it would receive (for the log) and the rows. */
export function fakeGetRows(
    request: ServerRowsRequest,
    url: string
): Promise<{ data: Person[]; metadata: { found: number } }> {
    const entry: RequestLogEntry = {
        url,
        startRow: request.startRow,
        endRow: request.endRow,
        q: request.q,
        groupKeys: request.groupKeys,
        aborted: false,
        done: false,
        at: performance.now(),
    };
    backend.log.push(entry);
    const [low, high] = backend.latency;
    const delay = low + Math.random() * (high - low);

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            entry.done = true;
            if (backend.failNext > 0) {
                backend.failNext--;
                reject(new Error('Fake backend error'));

                return;
            }
            resolve(answer(request));
        }, delay);
        request.signal.addEventListener('abort', () => {
            entry.aborted = true;
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
        });
    });
}

/**
 * The fake export job: runs the export query through the same answer as the grid's requests (all rows) and
 * writes CSV with one column per exported column, in order. Headers come from `headers`, as a backend
 * resolves them by colId.
 */
export function runExport(
    query: {
        columns: { colId: string; field: string }[];
        search?: string;
        filterModel?: Record<string, unknown>;
        sortModel?: { colId: string; sort: 'asc' | 'desc' }[];
        externalFilters?: Record<string, string | number | boolean>;
    },
    headers: Record<string, string>
): string {
    const { data } = answer({
        startRow: 0,
        endRow: Number.MAX_SAFE_INTEGER,
        sortModel: query.sortModel ?? [],
        filterModel: (query.filterModel ?? {}) as never,
        groupKeys: [],
        rowGroupCols: [],
        q: query.search ?? '',
        externalFilters: query.externalFilters ?? {},
        signal: new AbortController().signal,
    });
    const escape = (value: unknown) => {
        const text = value === null || value === undefined ? '' : String(value);

        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [query.columns.map((column) => escape(headers[column.colId] ?? column.colId)).join(',')];
    for (const row of data) {
        lines.push(query.columns.map((column) => escape((row as Record<string, unknown>)[column.field])).join(','));
    }

    return lines.join('\n');
}

function answer(request: ServerRowsRequest): { data: Person[]; metadata: { found: number } } {
    let rows = PEOPLE;
    const words = request.q.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length > 0) {
        rows = rows.filter((person) =>
            words.every((word) => `${person.name} ${person.team} ${person.city}`.toLowerCase().includes(word))
        );
    }
    const predicate = createFilterPredicate<Person>(request.filterModel, {
        column: (colId) => columns.getResolved(colId),
    });
    if (predicate) {
        rows = rows.filter((data) =>
            predicate({ kind: 'data', id: String(data.id), level: 0, parentId: null, data } as never)
        );
    }
    for (const [key, value] of Object.entries(request.externalFilters)) {
        rows = rows.filter((person) => String((person as Record<string, unknown>)[key]) === String(value));
    }
    if (request.sortModel.length > 0) {
        rows = [...rows].sort((a, b) => {
            for (const { colId, sort } of request.sortModel) {
                const left = (a as Record<string, unknown>)[colId];
                const right = (b as Record<string, unknown>)[colId];
                const result =
                    left === right
                        ? 0
                        : left === null
                          ? 1
                          : right === null
                            ? -1
                            : (left as number) < (right as number)
                              ? -1
                              : 1;
                if (result !== 0) {
                    return sort === 'desc' ? -result : result;
                }
            }

            return 0;
        });
    }
    // Grouping: the next group column under the given keys returns group rows; past the last, leaves.
    const groupCols = request.rowGroupCols.map((column) => column.field);
    request.groupKeys.forEach((key, depth) => {
        rows = rows.filter((person) => String((person as Record<string, unknown>)[groupCols[depth]!]) === key);
    });
    if (request.groupKeys.length < groupCols.length) {
        const field = groupCols[request.groupKeys.length]!;
        const counts = new Map<string, number>();
        for (const person of rows) {
            const key = String((person as Record<string, unknown>)[field]);
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const groups = [...counts]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, count]) => ({
                id: -1,
                name: key,
                team: '',
                city: '',
                fee: null,
                joined: '',
                _group: true,
                _groupKey: key,
                _childCount: count,
            }));

        return { data: groups.slice(request.startRow, request.endRow), metadata: { found: groups.length } };
    }

    return { data: rows.slice(request.startRow, request.endRow), metadata: { found: rows.length } };
}
