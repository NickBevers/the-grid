/**
 * Property and differential fuzz test of ServerRowModel, written from the docblocks of serverRowModel.ts,
 * src/rows/serverProjection.ts and the contract in src/contract/data-source.ts.
 *
 * A fake `ServerDataSource` answers block requests from a reference dataset. Its promises stay pending
 * until the test resolves or rejects them, in random order. A seeded PRNG drives random sequences of
 * query changes, range requests, expansion, refreshes, patches, page changes and responses. After every
 * step the test checks the request limits, the displayed rows against the reference answer for the latest
 * query, the agreement of every read method, the status, eviction and `version`. At the end of each case a
 * liveness phase loads everything displayed and compares the whole projection with the reference.
 *
 * Every case is replayable from its config and operation list. On failure the operation list is shrunk
 * to a minimal case, printed in the assertion message.
 */
import { describe, expect, it } from 'vitest';

import type { FilterModel, GridRow, QueryState, ServerDataSource, ServerRowsRequest, SortModel } from '../contract';
import { failedRowId, groupRowId, loadingRowId, type GroupKey } from '../rows/ids';
import { ServerRowModel } from './serverRowModel';

// Seeded PRNG (mulberry32)

function createRandom(seed: number) {
    let state = seed >>> 0;
    const next = (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
    const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)]!;
    const chance = (probability: number): boolean => next() < probability;

    return { next, int, pick, chance };
}

type Random = ReturnType<typeof createRandom>;

// Data

type Item = { id: number; name: string; num: number | null; team: string | null; tier: string; note: string };
type GroupDatum = { _group: true; _groupKey: string | null; _groupField: string; _childCount: number };
type Datum = Partial<Item> & Partial<GroupDatum>;

const NAMES = ['ada', 'bob', 'cara', 'dan', 'eve', 'finn', 'gus', 'hana', 'ivan', 'jo', 'Anna', 'BOB'];
const TEAMS = ['red', 'blue', 'green', 'gold', null];
const TIERS = ['a', 'b', 'c'];

function randomItem(random: Random, id: number): Item {
    return {
        id,
        name: `${random.pick(NAMES)} ${random.int(0, 30)}`,
        num: random.chance(0.2) ? null : random.int(-5, 40),
        team: random.pick(TEAMS),
        tier: random.pick(TIERS),
        note: '',
    };
}

/** The parameters that decide an answer, in the backend's terms. */
type Params = {
    sortModel: SortModel;
    filterModel: FilterModel;
    q: string;
    externalFilters: Record<string, string | number | boolean>;
    groupFields: string[];
};

type Answer =
    | { kind: 'groups'; field: string; items: { key: GroupKey; childCount: number }[] }
    | { kind: 'leaves'; ids: number[] }
    | { kind: 'invalid' };

function groupKeyOf(item: Item, field: string): GroupKey {
    const value = (item as Record<string, unknown>)[field];

    return value === null || value === undefined ? null : String(value);
}

function compareKeys(a: GroupKey, b: GroupKey): number {
    if (a === b) {
        return 0;
    }
    if (a === null) {
        return 1;
    }
    if (b === null) {
        return -1;
    }

    return a < b ? -1 : 1;
}

function compareValues(a: unknown, b: unknown): number {
    if (a === b) {
        return 0;
    }
    if (a === null || a === undefined) {
        return -1;
    }
    if (b === null || b === undefined) {
        return 1;
    }

    return (a as number | string) < (b as number | string) ? -1 : 1;
}

function matchesParams(item: Item, params: Params): boolean {
    if (params.q !== '' && !item.name.toLowerCase().includes(params.q.toLowerCase())) {
        return false;
    }
    for (const condition of Object.values(params.filterModel)) {
        const filter = condition as { filterType: string; filter?: number; values?: string[] };
        if (filter.filterType === 'number') {
            if (item.num === null || !(item.num > filter.filter!)) {
                return false;
            }
        } else if (filter.filterType === 'set') {
            if (filter.values!.length > 0 && (item.team === null || !filter.values!.includes(item.team))) {
                return false;
            }
        }
    }
    for (const [key, value] of Object.entries(params.externalFilters)) {
        if (key === 'tier' && item.tier !== value) {
            return false;
        }
        if (key === 'minId' && item.id < Number(value)) {
            return false;
        }
    }

    return true;
}

/** The reference backend: the dataset, plus memoised answers per query and route. */
class World {
    items: Item[];
    byId = new Map<number, Item>();
    #memo = new Map<string, Answer>();
    #nextId: number;

    constructor(items: Item[]) {
        this.items = items;
        for (const item of items) {
            this.byId.set(item.id, item);
        }
        this.#nextId = items.length + 1;
    }

    answer(params: Params, route: readonly GroupKey[]): Answer {
        const memoKey = JSON.stringify([params, route]);
        const cached = this.#memo.get(memoKey);
        if (cached) {
            return cached;
        }
        const fields = params.groupFields;
        let answer: Answer;
        if (route.length > fields.length) {
            answer = { kind: 'invalid' };
        } else {
            const leaves = this.items.filter(
                (item) =>
                    matchesParams(item, params) && route.every((key, depth) => groupKeyOf(item, fields[depth]!) === key)
            );
            if (route.length < fields.length) {
                const field = fields[route.length]!;
                const counts = new Map<GroupKey, number>();
                for (const item of leaves) {
                    const key = groupKeyOf(item, field);
                    counts.set(key, (counts.get(key) ?? 0) + 1);
                }
                const keys = [...counts.keys()].sort(compareKeys);
                answer = { kind: 'groups', field, items: keys.map((key) => ({ key, childCount: counts.get(key)! })) };
            } else {
                const sorted = [...leaves].sort((a, b) => {
                    for (const entry of params.sortModel) {
                        const result = compareValues(
                            (a as Record<string, unknown>)[entry.colId],
                            (b as Record<string, unknown>)[entry.colId]
                        );
                        if (result !== 0) {
                            return entry.sort === 'desc' ? -result : result;
                        }
                    }

                    return a.id - b.id;
                });
                answer = { kind: 'leaves', ids: sorted.map((item) => item.id) };
            }
        }
        this.#memo.set(memoKey, answer);

        return answer;
    }

    countOf(answer: Answer): number {
        return answer.kind === 'groups' ? answer.items.length : answer.kind === 'leaves' ? answer.ids.length : 0;
    }

    /** Backend rows for positions `start` to `end` of an answer. Group rows are fresh objects each time. */
    rows(answer: Answer, start: number, end: number): Datum[] {
        if (answer.kind === 'groups') {
            return answer.items.slice(start, end).map((group): GroupDatum => ({
                _group: true,
                _groupKey: group.key,
                _groupField: answer.field,
                _childCount: group.childCount,
            }));
        }
        if (answer.kind === 'leaves') {
            return answer.ids.slice(start, end).map((id) => this.byId.get(id)!);
        }

        return [];
    }

    /** Replaces one row's data (a field no query reads, so positions do not move). */
    patch(item: Item): void {
        const index = this.items.findIndex((candidate) => candidate.id === item.id);
        this.items[index] = item;
        this.byId.set(item.id, item);
        this.#memo.clear();
    }

    /** The server data changed: some rows edited, removed and added. */
    mutate(random: Random): void {
        const items = this.items
            .filter(() => !random.chance(0.15))
            .map((item) => (random.chance(0.2) ? { ...randomItem(random, item.id) } : item));
        const added = random.int(0, Math.max(1, Math.floor(this.items.length / 5)));
        for (let index = 0; index < added; index++) {
            items.push(randomItem(random, this.#nextId++));
        }
        this.items = items;
        this.byId = new Map(items.map((item) => [item.id, item]));
        this.#memo.clear();
    }
}

function paramsOfQuery(query: QueryState): Params {
    return {
        sortModel: query.sortModel,
        filterModel: query.filterModel,
        q: query.search.trim(),
        externalFilters: query.externalFilters,
        groupFields: query.rowGroupColIds,
    };
}

function paramsOfRequest(request: ServerRowsRequest): Params {
    return {
        sortModel: request.sortModel,
        filterModel: request.filterModel,
        q: request.q,
        externalFilters: request.externalFilters,
        groupFields: request.rowGroupCols.map((column) => column.field),
    };
}

/** Whether a query makes a `loadWithoutQuery: false` grid load (an empty set filter does not count). */
function triggers(query: QueryState): boolean {
    const filterCounts = Object.values(query.filterModel).some((condition) => {
        const filter = condition as { filterType: string; values?: unknown[] };

        return filter.filterType !== 'set' || (filter.values?.length ?? 0) > 0;
    });

    return (
        query.search.trim() !== '' ||
        filterCounts ||
        Object.keys(query.externalFilters).length > 0 ||
        query.rowGroupColIds.length > 0
    );
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function sameQuery(a: QueryState, b: QueryState): boolean {
    return (
        sameJson(a.sortModel, b.sortModel) &&
        sameJson(a.filterModel, b.filterModel) &&
        a.search.trim() === b.search.trim() &&
        sameJson(a.externalFilters, b.externalFilters) &&
        sameJson(a.rowGroupColIds, b.rowGroupColIds)
    );
}

// Cases

type Config = {
    dataSeed: number;
    rowCount: number;
    blockSize: number;
    maxBlocksInCache?: number;
    maxConcurrentRequests?: number;
    pageSize?: number;
    loadWithoutQuery?: boolean;
    /** Responses carry `rowCount: null`. */
    unknownCounts: boolean;
    /** The fake rejects a request as soon as its signal aborts, as fetch does. */
    honourAbort: boolean;
};

type Operation =
    | { type: 'setQuery'; query: QueryState }
    | { type: 'sameQuery'; pad: boolean }
    | { type: 'ensureRange'; first: number; last: number; mode: 'near' | 'far' | 'huge' | 'all' }
    | { type: 'expand'; pick: number; expanded?: boolean }
    | { type: 'refresh'; purge?: boolean; route: 'root' | 'group' | 'missing'; pick: number; mutate: boolean }
    | { type: 'patch'; pick: number; loaded: boolean }
    | { type: 'setPage'; page: number }
    | { type: 'settle'; pick: number; reject: boolean }
    | { type: 'settleAll'; rejectRate: number };

type Case = { config: Config; operations: Operation[] };

const SEARCHES = ['', '', ' ', 'a', ' an ', 'bob', 'zz', '1', 'E'];
const SORTS: SortModel[] = [
    [],
    [{ colId: 'name', sort: 'asc' }],
    [{ colId: 'num', sort: 'desc' }],
    [
        { colId: 'num', sort: 'asc' },
        { colId: 'name', sort: 'desc' },
    ],
];
const FILTERS: FilterModel[] = [
    {},
    {},
    { num: { filterType: 'number', type: 'greaterThan', filter: 10 } as never },
    { num: { filterType: 'number', type: 'greaterThan', filter: 30 } as never },
    { team: { filterType: 'set', values: [] } },
    { team: { filterType: 'set', values: ['red', 'gold'] } },
];
const EXTERNALS: Record<string, string | number | boolean>[] = [{}, {}, { tier: 'a' }, { minId: 50 }];
const GROUPINGS: string[][] = [[], [], ['team'], ['team', 'tier'], ['tier']];

function randomQuery(random: Random): QueryState {
    return {
        search: random.pick(SEARCHES),
        sortModel: random.pick(SORTS),
        filterModel: random.pick(FILTERS),
        externalFilters: random.pick(EXTERNALS),
        rowGroupColIds: random.pick(GROUPINGS),
    };
}

function randomConfig(random: Random): Config {
    const unknownCounts = random.chance(0.2);
    const blockSize = random.pick(unknownCounts ? [5, 10, 25] : [3, 5, 10, 25, 50, 100]);
    const rowCount = random.chance(0.05)
        ? 0
        : random.chance(0.1)
          ? blockSize * random.int(1, 6)
          : random.int(1, unknownCounts ? 300 : random.chance(0.3) ? 2000 : 400);
    const config: Config = {
        dataSeed: random.int(1, 1e9),
        rowCount,
        blockSize,
        unknownCounts,
        honourAbort: random.chance(0.7),
    };
    const maxBlocks = random.pick([undefined, undefined, 1, 2, 3, 5]);
    if (maxBlocks !== undefined) {
        config.maxBlocksInCache = maxBlocks;
    }
    const concurrency = random.pick([undefined, 1, 2, 3, 5]);
    if (concurrency !== undefined) {
        config.maxConcurrentRequests = concurrency;
    }
    if (random.chance(0.3)) {
        config.pageSize = random.pick([5, 10, 20, 37, 100]);
    }
    const loadWithoutQuery = random.pick([undefined, true, false]);
    if (loadWithoutQuery !== undefined) {
        config.loadWithoutQuery = loadWithoutQuery;
    }

    return config;
}

function randomOperation(random: Random, config: Config): Operation {
    const roll = random.next();
    if (roll < 0.1) {
        return { type: 'setQuery', query: randomQuery(random) };
    }
    if (roll < 0.13) {
        return { type: 'sameQuery', pad: random.chance(0.5) };
    }
    if (roll < 0.38) {
        const mode = random.pick(['near', 'near', 'near', 'far', 'huge', 'all'] as const);
        const first = random.int(-3, 400);

        return { type: 'ensureRange', first, last: first + random.int(-2, 60), mode };
    }
    if (roll < 0.46) {
        const operation: Operation = { type: 'expand', pick: random.next() };
        if (random.chance(0.3)) {
            operation.expanded = random.chance(0.5);
        }

        return operation;
    }
    if (roll < 0.51) {
        const operation: Operation = {
            type: 'refresh',
            route: random.pick(['root', 'root', 'group', 'missing'] as const),
            pick: random.next(),
            mutate: random.chance(0.25),
        };
        const purge = random.pick([undefined, true, false]);
        if (purge !== undefined) {
            operation.purge = purge;
        }

        return operation;
    }
    if (roll < 0.55) {
        return { type: 'patch', pick: random.next(), loaded: random.chance(0.8) };
    }
    if (roll < 0.6 && config.pageSize) {
        return { type: 'setPage', page: random.int(-1, 12) };
    }
    if (roll < 0.93) {
        return { type: 'settle', pick: random.next(), reject: random.chance(0.15) };
    }

    return { type: 'settleAll', rejectRate: random.pick([0, 0, 0.1, 0.3]) };
}

function randomCase(seed: number): Case {
    const random = createRandom(seed);
    const config = randomConfig(random);
    const operations: Operation[] = [{ type: 'setQuery', query: randomQuery(random) }];
    const length = random.int(10, 50);
    for (let index = 0; index < length; index++) {
        operations.push(randomOperation(random, config));
    }

    return { config, operations };
}

// The fake data source

type Pending = {
    request: ServerRowsRequest;
    serial: number;
    settled: boolean;
    aborted: boolean;
    resolve(response: { rows: Datum[]; rowCount: number | null }): void;
    reject(error: unknown): void;
};

/** Node's setImmediate (not in this project's DOM typings): every pending promise callback has run by then. */
const setImmediateTask = (globalThis as unknown as { setImmediate(callback: () => void): void }).setImmediate;
const tick = () => new Promise<void>((resolve) => setImmediateTask(resolve));

const blockKeyOf = (route: readonly GroupKey[], startRow: number): string => `${JSON.stringify(route)}#${startRow}`;

class Violation extends Error {}

/** Runs one case. Returns the first violated property, or null. */
type Stats = {
    cases: number;
    steps: number;
    requests: number;
    loadedAtEnd: number;
    childRowsAtEnd: number;
    paginated: number;
    mutated: number;
    tainted: number;
    bugOne: number;
};

const newStats = (): Stats => ({
    cases: 0,
    steps: 0,
    requests: 0,
    loadedAtEnd: 0,
    childRowsAtEnd: 0,
    paginated: 0,
    mutated: 0,
    tainted: 0,
    bugOne: 0,
});

async function runCase(
    testCase: Case,
    options: { liveness?: boolean; strict?: boolean; stats?: Stats } = {}
): Promise<string | null> {
    const harness = new Harness(testCase.config, options.strict ?? true);
    let mutated = false;
    try {
        for (const [step, operation] of testCase.operations.entries()) {
            harness.step = step;
            await harness.apply(operation);
            mutated ||= harness.mutated;
        }
        if (options.liveness !== false) {
            harness.step = testCase.operations.length;
            await harness.liveness();
        }
        const stats = options.stats;
        if (stats) {
            let loaded = 0;
            let children = 0;
            harness.model.forEachRow((row) => {
                loaded++;
                children += row.level > 0 ? 1 : 0;
            });
            stats.cases++;
            stats.steps += testCase.operations.length;
            stats.requests += harness.requests.length;
            stats.loadedAtEnd += loaded > 0 && !harness.tainted ? 1 : 0;
            stats.childRowsAtEnd += children > 0 && !harness.tainted ? 1 : 0;
            stats.paginated += testCase.config.pageSize ? 1 : 0;
            stats.mutated += mutated ? 1 : 0;
            stats.tainted += harness.taintCount > 0 ? 1 : 0;
            stats.bugOne += harness.bugOneHits > 0 ? 1 : 0;
        }
    } catch (error) {
        if (error instanceof Violation) {
            return `step ${harness.step}: ${error.message}`;
        }

        return `step ${harness.step}: threw ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
    } finally {
        harness.model.destroy();
    }

    return null;
}

type Slot = { route: GroupKey[]; pos: number; row: GridRow<Datum> };

class Harness {
    readonly config: Config;
    readonly world: World;
    readonly random: Random;
    readonly model: ServerRowModel<Datum>;
    readonly limit: number;
    step = 0;
    requests: Pending[] = [];
    query: QueryState | null = null;
    /** Positional checks are off after server data changed under a `purge: false` refresh. */
    mutated = false;
    /** Set when a response hit BUG 2; the counts are wrong from then on, so positional checks stop. */
    tainted = false;
    taintCount = 0;

    get relaxed(): boolean {
        return this.mutated || this.tainted;
    }
    /** Blocks whose current request failed, not to be requested again until a refresh. */
    failed = new Set<string>();
    rootFailed = false;
    rootLoaded = false;
    /** Blocks covering the last ensureRange, with their loaded row counts, while the layout holds. */
    protectedBlocks: Map<string, number> | null = null;
    rejectedSinceProtect = new Set<string>();
    lastVersion = 0;
    issueViolations: string[] = [];
    /**
     * Blocks whose current request settled since the last ensureRange, refresh or query change, and whether
     * it failed. Only BUG 1 requests such a block again (from a stale wanted list); outside strict mode the
     * repeat is answered the same way, so the state is unchanged.
     */
    justSettled = new Map<string, boolean>();
    bugOneHits = 0;
    readonly strict: boolean;

    /** `strict: false` tolerated the (now fixed) bugs below while they were open; runs are strict by default. */
    constructor(config: Config, strict: boolean) {
        this.config = config;
        this.strict = strict;
        const dataRandom = createRandom(config.dataSeed);
        this.world = new World(
            Array.from({ length: config.rowCount }, (_, index) => randomItem(dataRandom, index + 1))
        );
        this.random = createRandom(config.dataSeed ^ 0x5bd1e995);
        this.limit = config.maxConcurrentRequests ?? 2;
        const source: ServerDataSource<Datum> = {
            type: 'server',
            blockSize: config.blockSize,
            getRows: (request) => this.#getRows(request),
        };
        if (config.maxBlocksInCache !== undefined) {
            source.maxBlocksInCache = config.maxBlocksInCache;
        }
        if (config.loadWithoutQuery !== undefined) {
            source.loadWithoutQuery = config.loadWithoutQuery;
        }
        this.model = new ServerRowModel<Datum>({
            source,
            column: () => undefined,
            ...(config.pageSize ? { pageSize: config.pageSize } : {}),
            ...(config.maxConcurrentRequests !== undefined
                ? { maxConcurrentRequests: config.maxConcurrentRequests }
                : {}),
        });
    }

    get live(): Pending[] {
        return this.requests.filter((entry) => !entry.settled && !entry.aborted);
    }

    get unsettled(): Pending[] {
        return this.requests.filter((entry) => !entry.settled);
    }

    get grouped(): boolean {
        return (this.query?.rowGroupColIds.length ?? 0) > 0;
    }

    get expectNoQuery(): boolean {
        return this.query !== null && this.config.loadWithoutQuery === false && !triggers(this.query);
    }

    #getRows(request: ServerRowsRequest): Promise<{ rows: Datum[]; rowCount: number | null }> {
        return new Promise((resolve, reject) => {
            const entry: Pending = {
                request,
                serial: this.requests.length,
                settled: false,
                aborted: request.signal.aborted,
                resolve,
                reject,
            };
            this.#checkIssue(entry);
            this.requests.push(entry);
            const key = blockKeyOf(request.groupKeys, request.startRow);
            const repeated = this.justSettled.get(key);
            if (this.strict && repeated === false && !entry.aborted) {
                this.issueViolations.push(
                    `loaded block requested again without an ensureRange, refresh or query change since (${key})`
                );
            }
            if (!this.strict && !entry.aborted && repeated !== undefined) {
                this.bugOneHits++;
                queueMicrotask(() => this.#settle(entry, repeated));
            }
            request.signal.addEventListener('abort', () => {
                entry.aborted = true;
                if (this.config.honourAbort && !entry.settled) {
                    entry.settled = true;
                    reject(new DOMException('Aborted', 'AbortError'));
                }
            });
        });
    }

    /** Checks a request as it is issued. Recorded, not thrown: the model would turn a throw into a failure. */
    #checkIssue(entry: Pending): void {
        const { request } = entry;
        const fail = (message: string) => this.issueViolations.push(`${message} (${JSON.stringify(summary(request))})`);
        if (this.live.length + 1 > this.limit) {
            fail(`more than ${this.limit} requests in flight`);
        }
        const key = blockKeyOf(request.groupKeys, request.startRow);
        if (this.live.some((other) => blockKeyOf(other.request.groupKeys, other.request.startRow) === key)) {
            fail('two in-flight requests for the same block');
        }
        if (request.endRow - request.startRow !== this.config.blockSize || request.startRow % this.config.blockSize) {
            fail('request is not one block');
        }
        if (this.failed.has(key) && (this.strict || !this.justSettled.has(key))) {
            fail('failed block requested again without a refresh');
        }
        if (this.query === null) {
            fail('request before any query');

            return;
        }
        if (this.expectNoQuery) {
            fail('request while the query does not allow loading (noQuery)');
        }
        const expected = paramsOfQuery(this.query);
        if (!sameJson(paramsOfRequest(request), expected)) {
            fail(`request does not carry the current query ${JSON.stringify(expected)}`);
        }
        if (
            !sameJson(
                request.rowGroupCols.map((column) => column.id),
                this.query.rowGroupColIds
            )
        ) {
            fail('rowGroupCols ids differ from the query');
        }
        if (!this.relaxed && !this.#validRoute(request.groupKeys)) {
            fail('request for a group route the backend never returned');
        }
    }

    #validRoute(route: readonly GroupKey[]): boolean {
        const params = paramsOfQuery(this.query!);
        for (let depth = 0; depth < route.length; depth++) {
            const answer = this.world.answer(params, route.slice(0, depth));
            if (answer.kind !== 'groups' || !answer.items.some((group) => group.key === route[depth])) {
                return false;
            }
        }

        return true;
    }

    fail(message: string): never {
        throw new Violation(message);
    }

    check(condition: boolean, message: () => string): void {
        if (!condition) {
            this.fail(message());
        }
    }

    async flush(): Promise<void> {
        for (let index = 0; index < 4; index++) {
            await tick();
        }
    }

    // Operations

    async apply(operation: Operation): Promise<void> {
        const before = this.snapshot();
        const versionBefore = this.model.version;
        const serialBefore = this.requests.length;
        const liveBefore = this.live;
        let structural = false;
        let rootSettled: 'resolved' | 'rejected' | null = null;
        const rootLoadedBefore = this.rootLoaded;
        switch (operation.type) {
            case 'setQuery':
            case 'sameQuery': {
                const query: QueryState =
                    operation.type === 'setQuery'
                        ? operation.query
                        : this.query
                          ? {
                                ...structuredClone(this.query),
                                search: operation.pad ? ` ${this.query.search} ` : this.query.search,
                            }
                          : randomQuery(this.random);
                const changed = this.query === null || !sameQuery(this.query, query);
                this.query = query;
                if (changed) {
                    this.failed.clear();
                    this.rootFailed = false;
                    this.rootLoaded = false;
                    this.mutated = false;
                    this.tainted = false;
                }
                this.justSettled.clear();
                this.model.setQuery(query);
                if (!changed) {
                    this.check(this.requests.length === serialBefore, () => 'an unchanged query issued requests');
                    this.check(
                        liveBefore.every((entry) => !entry.aborted),
                        () => 'an unchanged query aborted requests'
                    );
                } else {
                    structural = true;
                    this.check(
                        liveBefore.every((entry) => entry.aborted),
                        () => 'a query change left an older request unaborted'
                    );
                    if (!this.expectNoQuery) {
                        this.check(
                            this.live.some(
                                (entry) => entry.request.groupKeys.length === 0 && entry.request.startRow === 0
                            ),
                            () => 'a query change did not request the first block'
                        );
                    }
                }
                break;
            }
            case 'ensureRange': {
                const count = this.model.rowSource.count;
                const [first, last] =
                    operation.mode === 'near'
                        ? [operation.first, operation.last]
                        : operation.mode === 'far'
                          ? [count + operation.first, count + operation.last + 100]
                          : operation.mode === 'huge'
                            ? [operation.first, 1e9]
                            : [0, count - 1];
                this.justSettled.clear();
                this.model.ensureRange(first, last);
                this.#protect(first, last);
                break;
            }
            case 'expand': {
                const groups: GridRow<Datum>[] = [];
                this.model.forEachRow((row) => {
                    if (row.kind === 'group') {
                        groups.push(row);
                    }
                });
                if (groups.length > 0) {
                    const group = groups[Math.floor(operation.pick * groups.length)]!;
                    const expanded = operation.expanded ?? !this.model.isExpanded(group.id);
                    this.model.setExpanded(group.id, expanded);
                    this.check(this.model.isExpanded(group.id) === expanded, () => `setExpanded(${group.id}) ignored`);
                } else {
                    this.model.setExpanded('group:["team"]:["nope"]', true);
                }
                structural = true;
                break;
            }
            case 'refresh': {
                if (!this.strict && this.expectNoQuery) {
                    // BUG 3: a refresh under noQuery loads the unfiltered rows.
                    break;
                }
                let route: GroupKey[] = [];
                if (operation.route === 'group') {
                    const groups: GroupKey[][] = [];
                    this.model.forEachRow((row) => {
                        if (row.kind === 'group') {
                            groups.push(row.keyPath);
                        }
                    });
                    route = groups.length > 0 ? groups[Math.floor(operation.pick * groups.length)]! : [];
                } else if (operation.route === 'missing') {
                    route = ['no such group'];
                }
                if (!this.strict && this.mutated && route.length > 0 && operation.purge !== false) {
                    // BUG 4: a purging refresh of one group forgets that every other level is stale.
                    break;
                }
                const mutate = operation.mutate && route.length === 0 && this.query !== null;
                if (mutate) {
                    this.world.mutate(this.random);
                    if (operation.purge === false) {
                        this.mutated = true;
                    }
                }
                for (const key of this.failed) {
                    const blockRoute = JSON.parse(key.slice(0, key.lastIndexOf('#'))) as GroupKey[];
                    if (route.every((part, depth) => blockRoute[depth] === part)) {
                        this.failed.delete(key);
                    }
                }
                // A refresh that keeps rows on screen may keep the error status until the retried block
                // arrives, so only a purging root refresh resets the failure.
                if (route.length === 0 && operation.purge !== false) {
                    this.rootFailed = false;
                    this.rootLoaded = false;
                    this.tainted = false;
                }
                this.justSettled.clear();
                this.model.refresh({ route, ...(operation.purge !== undefined ? { purge: operation.purge } : {}) });
                structural = true;
                break;
            }
            case 'patch': {
                let id: number | undefined;
                if (operation.loaded) {
                    const ids: number[] = [];
                    this.model.forEachRow((row) => {
                        if (row.kind === 'data' && row.data.id !== undefined) {
                            ids.push(row.data.id);
                        }
                    });
                    id = ids[Math.floor(operation.pick * ids.length)];
                } else if (this.world.items.length > 0) {
                    id = this.world.items[Math.floor(operation.pick * this.world.items.length)]!.id;
                }
                const current = id === undefined ? undefined : this.world.byId.get(id);
                if (current) {
                    const patched: Item = { ...current, note: `note ${this.step}` };
                    this.world.patch(patched);
                    this.model.patchRows([{ id: String(patched.id), data: patched }]);
                }
                break;
            }
            case 'setPage': {
                this.model.setPage(operation.page);
                structural = true;
                break;
            }
            case 'settle':
            case 'settleAll': {
                const targets =
                    operation.type === 'settle'
                        ? this.unsettled.length > 0
                            ? [this.unsettled[Math.floor(operation.pick * this.unsettled.length)]!]
                            : []
                        : this.#shuffle(this.unsettled);
                for (const entry of targets) {
                    const reject =
                        operation.type === 'settle' ? operation.reject : this.random.next() < operation.rejectRate;
                    const outcome = this.#settle(entry, reject);
                    if (outcome && operation.type === 'settle') {
                        rootSettled = outcome;
                    }
                }
                break;
            }
        }
        await this.flush();
        if (structural) {
            this.protectedBlocks = null;
        }
        this.checkAll();
        if (rootSettled === 'rejected' && !rootLoadedBefore) {
            this.check(
                this.model.status.state === 'error',
                () =>
                    `the first root block failed with nothing loaded, but status is ${JSON.stringify(this.model.status)}`
            );
        }
        if (rootSettled === 'resolved' && !this.relaxed) {
            const expected = this.#rootCount() > 0 ? 'ready' : 'empty';
            this.check(
                this.model.status.state === expected,
                () => `a root block arrived, status is ${JSON.stringify(this.model.status)}, expected ${expected}`
            );
        }
        const after = this.snapshot();
        this.check(this.model.version >= versionBefore, () => 'version decreased');
        if (after !== before) {
            this.check(
                this.model.version > versionBefore,
                () => `the projection changed (${operation.type}) but version stayed ${versionBefore}`
            );
        }
    }

    #shuffle<T>(items: T[]): T[] {
        const copy = [...items];
        for (let index = copy.length - 1; index > 0; index--) {
            const other = this.random.int(0, index);
            [copy[index], copy[other]] = [copy[other]!, copy[index]!];
        }

        return copy;
    }

    /** Resolves or rejects one request. Returns how a current root request ended, for the status checks. */
    #settle(entry: Pending, reject: boolean): 'resolved' | 'rejected' | null {
        if (entry.settled) {
            return null;
        }
        entry.settled = true;
        const { request } = entry;
        const current = !request.signal.aborted;
        const key = blockKeyOf(request.groupKeys, request.startRow);
        const root = request.groupKeys.length === 0;
        if (reject) {
            if (current) {
                this.failed.add(key);
                this.justSettled.set(key, true);
                this.rejectedSinceProtect.add(
                    `${JSON.stringify(request.groupKeys)}#${request.startRow / this.config.blockSize}`
                );
                if (root) {
                    this.rootFailed = true;
                }
            }
            entry.reject(new Error(`failed ${key}`));

            return current && root ? 'rejected' : null;
        }
        const answer = this.world.answer(paramsOfRequest(request), request.groupKeys);
        if (current && !this.strict && request.startRow > this.world.countOf(answer)) {
            this.tainted = true;
            this.taintCount++;
        }
        entry.resolve({
            rows: this.world.rows(answer, request.startRow, request.endRow),
            rowCount: this.config.unknownCounts ? null : this.world.countOf(answer),
        });
        if (current) {
            this.justSettled.set(key, false);
        }
        if (current && root) {
            this.rootLoaded = true;

            return 'resolved';
        }

        return null;
    }

    #rootCount(): number {
        return this.world.countOf(this.world.answer(paramsOfQuery(this.query!), []));
    }

    /** Records the blocks covering an ensureRange, which eviction must keep while they stay in view. */
    #protect(first: number, last: number): void {
        this.protectedBlocks = null;
        this.rejectedSinceProtect.clear();
        if (this.config.maxBlocksInCache === undefined || this.relaxed) {
            return;
        }
        const slots = this.walk(false);
        if (!slots) {
            return;
        }
        const from = Math.max(0, first);
        const to = Math.min(last, slots.length - 1);
        const blocks = new Map<string, number>();
        for (let index = from; index <= to; index++) {
            const slot = slots[index]!;
            blocks.set(this.#blockOf(slot), 0);
        }
        const loaded = this.#loadedPerBlock(slots);
        for (const key of blocks.keys()) {
            blocks.set(key, loaded.get(key) ?? 0);
        }
        this.protectedBlocks = blocks;
    }

    #blockOf(slot: Slot): string {
        return `${JSON.stringify(slot.route)}#${Math.floor(slot.pos / this.config.blockSize)}`;
    }

    #loadedPerBlock(slots: Slot[]): Map<string, number> {
        const loaded = new Map<string, number>();
        for (const slot of slots) {
            if (slot.row.kind === 'data' || slot.row.kind === 'group') {
                const key = this.#blockOf(slot);
                loaded.set(key, (loaded.get(key) ?? 0) + 1);
            }
        }

        return loaded;
    }

    // Invariants

    /** A string that changes whenever anything a reader could observe changes. */
    snapshot(): string {
        const model = this.model;
        const parts: string[] = [
            JSON.stringify(model.status, (_, value: unknown) => (value instanceof Error ? value.message : value)),
            String(model.getRowCount()),
            JSON.stringify(model.getPagination()),
        ];
        const count = model.rowSource.count;
        parts.push(String(count));
        for (let index = 0; index < count; index++) {
            const row = model.getRowAtIndex(index)?.row;
            parts.push(
                row === undefined
                    ? 'undefined'
                    : row.kind === 'data' || row.kind === 'group'
                      ? `${row.id}@${identity(row)}`
                      : row.id
            );
        }

        return parts.join('|');
    }

    checkAll(): void {
        if (this.issueViolations.length > 0) {
            this.fail(this.issueViolations[0]!);
        }
        const model = this.model;
        this.check(
            model.pendingRequests <= this.limit,
            () => `model reports ${model.pendingRequests} requests in flight`
        );
        this.check(this.live.length <= this.limit, () => `${this.live.length} live requests in flight`);
        const keys = this.live.map((entry) => blockKeyOf(entry.request.groupKeys, entry.request.startRow));
        this.check(new Set(keys).size === keys.length, () => `duplicate in-flight blocks ${keys.join(', ')}`);
        this.#checkReads();
        this.#checkStatus();
        const slots = this.walk(true);
        if (slots && this.protectedBlocks && !this.relaxed) {
            const loaded = this.#loadedPerBlock(slots);
            for (const [key, count] of this.protectedBlocks) {
                if (this.rejectedSinceProtect.has(key)) {
                    continue;
                }
                const now = loaded.get(key) ?? 0;
                this.check(
                    now >= count,
                    () => `block ${key} covering the last ensureRange lost rows (${count} -> ${now})`
                );
                this.protectedBlocks.set(key, now);
            }
        }
        this.lastVersion = model.version;
    }

    /** Every read method agrees with the others. */
    #checkReads(): void {
        const model = this.model;
        const source = model.rowSource;
        const count = source.count;
        const rowCount = model.getRowCount();
        this.check(
            rowCount === null || rowCount === count,
            () => `getRowCount ${rowCount} but rowSource.count ${count}`
        );
        this.check(model.getRowAtIndex(count) === undefined, () => `a row past the count (${count})`);
        this.check(model.getRowAtIndex(-1) === undefined, () => 'a row at index -1');
        const loaded: [GridRow<Datum>, number][] = [];
        const ids = new Set<string>();
        for (let index = 0; index < count; index++) {
            const displayed = model.getRowAtIndex(index);
            this.check(
                displayed !== undefined && displayed.index === index,
                () => `no row at index ${index} of ${count}`
            );
            const row = displayed!.row;
            this.check(source.rowAt(index)?.id === row.id, () => `rowSource.rowAt(${index}) differs`);
            this.check(!ids.has(row.id), () => `row ${row.id} displayed twice`);
            ids.add(row.id);
            if (row.kind === 'data' || row.kind === 'group') {
                loaded.push([row, index]);
                this.check(
                    model.getIndexOf(row.id) === index,
                    () => `getIndexOf(${row.id}) is ${model.getIndexOf(row.id)}, shown at ${index}`
                );
                this.check(source.indexOf(row.id) === index, () => `rowSource.indexOf(${row.id}) differs`);
                this.check(model.getRow(row.id) === row, () => `getRow(${row.id}) differs from the displayed row`);
                if (row.kind === 'group') {
                    this.check(model.isExpanded(row.id) === row.expanded, () => `isExpanded(${row.id}) differs`);
                }
            }
        }
        const visited: [GridRow<Datum>, number | undefined][] = [];
        model.forEachRow((row, index) => visited.push([row, index]));
        this.check(
            visited.length === loaded.length &&
                visited.every(([row, index], at) => loaded[at]![0] === row && loaded[at]![1] === index),
            () =>
                `forEachRow visits ${visited.map(([row, index]) => `${row.id}@${index}`).join(',')} but loaded rows are ${loaded.map(([row, index]) => `${row.id}@${index}`).join(',')}`
        );
        const known: [GridRow<Datum>, number][] = [];
        source.forEachKnown((row, index) => known.push([row, index]));
        this.check(known.length === loaded.length, () => 'rowSource.forEachKnown disagrees with forEachRow');
        const pageSize = this.config.pageSize;
        const pagination = model.getPagination();
        if (pageSize) {
            this.check(pagination !== null && pagination.pageSize === pageSize, () => 'no pagination');
            this.check(count <= pageSize, () => `page shows ${count} rows, page size ${pageSize}`);
            if (pagination!.rowCount !== null) {
                const expected = Math.max(0, Math.min(pageSize, pagination!.rowCount - pagination!.page * pageSize));
                this.check(
                    count === expected,
                    () => `page ${pagination!.page} shows ${count} rows, expected ${expected}`
                );
            }
        } else {
            this.check(pagination === null, () => 'pagination without a page size');
        }
    }

    #checkStatus(): void {
        const status = this.model.status;
        const describe = () => JSON.stringify(status);
        if (this.query === null) {
            this.check(status.state === 'idle', () => `status ${describe()} before any query`);

            return;
        }
        if (this.expectNoQuery) {
            this.check(
                status.state === 'empty' && status.reason === 'noQuery',
                () => `expected noQuery, got ${describe()}`
            );
            this.check(this.model.rowSource.count === 0, () => 'rows shown under noQuery');
            this.check(this.live.length === 0, () => 'requests in flight under noQuery');
        }
        if (status.state === 'empty' && status.reason === 'noQuery') {
            this.check(this.expectNoQuery, () => 'noQuery although the query may load');
        }
        if (status.state === 'empty' && status.reason === 'noResults') {
            this.check(this.model.rowSource.count === 0, () => 'noResults with rows displayed');
            if (!this.relaxed) {
                this.check(this.#rootCount() === 0, () => `noResults but the query has ${this.#rootCount()} root rows`);
            }
        }
        if (status.state === 'error') {
            this.check(this.rootFailed || this.relaxed, () => 'status error without a failed root block');
        }
        if (status.state === 'ready') {
            this.check(this.rootLoaded, () => 'status ready before any root block arrived');
            if (!this.relaxed) {
                this.check(this.#rootCount() > 0, () => 'status ready for an empty result');
            }
        }
    }

    /**
     * Walks the displayed rows, deriving each row's level route and position from the display order, and
     * compares every row with the reference answer at that position. Returns the slots, or null when the
     * page start's position is unknowable (grouped and paginated).
     */
    walk(compare: boolean, requireComplete = false): Slot[] | null {
        const model = this.model;
        const count = model.rowSource.count;
        const groupColIds = this.query?.rowGroupColIds ?? [];
        // Under noQuery nothing is shown, whatever the backend would answer.
        const params = this.query && !this.expectNoQuery ? paramsOfQuery(this.query) : null;
        const paginated = Boolean(this.config.pageSize);
        if (paginated && groupColIds.length > 0) {
            if (compare && params && !this.relaxed) {
                this.#weakCompare(params, requireComplete);
            }

            return null;
        }
        const offset = paginated ? model.getPagination()!.page * this.config.pageSize! : 0;
        const positional = compare && params !== null && !this.relaxed;
        const countsKnown = model.getRowCount() !== null;
        type Frame = { route: GroupKey[]; pos: number; parentId: string | null };
        const stack: Frame[] = [{ route: [], pos: offset, parentId: null }];
        const slots: Slot[] = [];
        const endFrame = (frame: Frame) => {
            if (positional && countsKnown && !paginated) {
                const expected = this.world.countOf(this.world.answer(params, frame.route));
                this.check(
                    frame.pos === expected,
                    () => `level ${JSON.stringify(frame.route)} shows ${frame.pos} rows, the query has ${expected}`
                );
            }
        };
        for (let index = 0; index < count; index++) {
            const row = model.getRowAtIndex(index)!.row;
            const previous = slots.at(-1);
            if (
                row.level === stack.length &&
                previous &&
                previous.row.level === row.level - 1 &&
                (previous.row.kind === 'loading' || previous.row.kind === 'failed')
            ) {
                // An expanded group whose block was evicted or failed keeps its child level displayed under
                // the placeholder (expansion survives evictions). The level's route comes from the parent id.
                const prefix = `group:${JSON.stringify(groupColIds.slice(0, row.level))}:`;
                const parentId = row.parentId ?? '';
                this.check(
                    parentId.startsWith(prefix),
                    () => `row ${row.id} sits under a placeholder with parent ${parentId}`
                );
                const keyPath = JSON.parse(parentId.slice(prefix.length)) as GroupKey[];
                if (positional) {
                    const answer = this.world.answer(params, previous.route);
                    this.check(
                        answer.kind === 'groups' &&
                            sameJson([...previous.route, answer.items[previous.pos]?.key], keyPath),
                        () => `children of ${parentId} shown below the slot of another group (${previous.row.id})`
                    );
                }
                stack.push({ route: keyPath, pos: 0, parentId });
            }
            this.check(
                row.level < stack.length,
                () => `row ${row.id} at index ${index} is deeper than any expanded parent`
            );
            while (stack.length > row.level + 1) {
                endFrame(stack.pop()!);
            }
            const frame = stack[row.level]!;
            const pos = frame.pos++;
            slots.push({ route: frame.route, pos, row });
            this.check(
                row.parentId === frame.parentId,
                () => `row ${row.id} has parent ${row.parentId}, expected ${frame.parentId}`
            );
            if (row.kind === 'loading' || row.kind === 'failed') {
                const expectedId =
                    row.kind === 'loading' ? loadingRowId(frame.route, pos) : failedRowId(frame.route, pos);
                this.check(
                    row.id === expectedId,
                    () => `placeholder ${row.id} at index ${index}, expected ${expectedId}`
                );
                this.check(
                    !requireComplete,
                    () => `row ${index} (${row.id}) is still ${row.kind} after loading everything`
                );
                continue;
            }
            if (positional) {
                const answer = this.world.answer(params, frame.route);
                const where = `index ${index} (level ${JSON.stringify(frame.route)} position ${pos})`;
                if (answer.kind === 'groups') {
                    const group = answer.items[pos];
                    this.check(
                        group !== undefined,
                        () => `${where}: loaded row ${row.id} past the level's ${answer.items.length} rows`
                    );
                    const keyPath = [...frame.route, group!.key];
                    this.check(
                        row.kind === 'group' &&
                            row.key === group!.key &&
                            sameJson(row.keyPath, keyPath) &&
                            row.id === groupRowId(groupColIds, keyPath) &&
                            row.data?._groupKey === group!.key &&
                            row.data?._childCount === group!.childCount &&
                            row.data?._groupField === answer.field,
                        () =>
                            `${where}: shows ${row.id} ${JSON.stringify(row.data)}, expected group ${JSON.stringify(group)}`
                    );
                } else if (answer.kind === 'leaves') {
                    const id = answer.ids[pos];
                    this.check(
                        id !== undefined,
                        () => `${where}: loaded row ${row.id} past the level's ${answer.ids.length} rows`
                    );
                    this.check(
                        row.kind === 'data' && row.id === String(id) && row.data === this.world.byId.get(id!),
                        () =>
                            `${where}: shows ${row.id} ${JSON.stringify(row.data)}, expected ${JSON.stringify(this.world.byId.get(id!))}`
                    );
                } else {
                    this.fail(`${where}: row ${row.id} on a level the backend does not have`);
                }
            }
            if (row.kind === 'group' && row.expanded) {
                stack.push({ route: row.keyPath, pos: 0, parentId: row.id });
            }
        }
        while (stack.length > 0) {
            endFrame(stack.pop()!);
        }
        if (compare && params && !this.relaxed && paginated) {
            const rowCount = model.getPagination()!.rowCount;
            if (rowCount !== null) {
                this.check(
                    rowCount === this.#rootCount(),
                    () => `pagination rowCount ${rowCount}, the query has ${this.#rootCount()}`
                );
            }
        }

        return slots;
    }

    /** Grouped pages: every loaded row belongs to the current query, without positions. */
    #weakCompare(params: Params, requireComplete: boolean): void {
        this.model.forEachRow((row) => {
            if (row.kind === 'data') {
                const item = this.world.byId.get(Number(row.id));
                this.check(
                    item !== undefined && row.data === item && matchesParams(item, params),
                    () => `row ${row.id} does not belong to the current query`
                );
            } else if (row.kind === 'group') {
                this.check(this.#validRoute(row.keyPath), () => `group ${row.id} does not exist for the current query`);
            }
        });
        if (requireComplete) {
            for (let index = 0; index < this.model.rowSource.count; index++) {
                const row = this.model.getRowAtIndex(index)!.row;
                this.check(row.kind === 'data' || row.kind === 'group', () => `row ${index} is still ${row.kind}`);
            }
        }
    }

    /** Loads everything displayed, then compares the whole projection with the reference. */
    async liveness(): Promise<void> {
        for (let round = 0; round < 3000; round++) {
            let hasFailed = false;
            for (let index = 0; index < this.model.rowSource.count; index++) {
                if (this.model.getRowAtIndex(index)?.row.kind === 'failed') {
                    hasFailed = true;
                    break;
                }
            }
            if (hasFailed) {
                await this.apply({ type: 'refresh', route: 'root', pick: 0, mutate: false, purge: false });
            }
            const serial = this.requests.length;
            await this.apply({ type: 'ensureRange', first: 0, last: 0, mode: 'all' });
            const issued = this.requests.length > serial;
            let drained = false;
            while (this.unsettled.length > 0) {
                drained = true;
                await this.apply({ type: 'settleAll', rejectRate: 0 });
            }
            if (!issued && !drained && !hasFailed) {
                break;
            }
        }
        this.mutated = false;
        this.checkAll();
        if (this.tainted) {
            return;
        }
        this.walk(true, true);
        if (this.query && !this.expectNoQuery) {
            const status = this.model.status;
            const rootCount = this.#rootCount();
            if (!this.config.pageSize || this.model.getPagination()!.page === 0 || this.rootLoaded) {
                this.check(
                    rootCount > 0
                        ? status.state === 'ready'
                        : status.state === 'empty' && status.reason === 'noResults',
                    () => `after loading, status is ${JSON.stringify(status)} for ${rootCount} root rows`
                );
            }
            if (!this.config.pageSize && !this.grouped) {
                this.check(
                    this.model.getRowCount() === rootCount,
                    () => `getRowCount ${this.model.getRowCount()}, expected ${rootCount}`
                );
            }
            if (!this.config.pageSize) {
                this.check(this.model.getRowCount() !== null, () => 'count still unknown after loading everything');
            }
        }
    }
}

const identities = new WeakMap<object, number>();
let identityCounter = 0;

/** A number per object, so a snapshot notices a row replaced by an equal-looking one. */
function identity(row: object): number {
    let id = identities.get(row);
    if (id === undefined) {
        id = ++identityCounter;
        identities.set(row, id);
    }

    return id;
}

function summary(request: ServerRowsRequest) {
    return { startRow: request.startRow, groupKeys: request.groupKeys, q: request.q, aborted: request.signal.aborted };
}

// Shrinking

async function shrink(testCase: Case): Promise<{ testCase: Case; message: string }> {
    let best = testCase;
    let message = (await runCase(best))!;
    const signature = (text: string) => text.replace(/^step \d+: /, '').replace(/[\d(].*$/s, '');
    const wanted = signature(message);
    /** Only candidates that fail the same property count, so shrinking never drifts to another failure. */
    const fails = async (candidate: Case): Promise<string | null> => {
        const result = await runCase(candidate);

        return result && signature(result) === wanted ? result : null;
    };
    let improved = true;
    while (improved) {
        improved = false;
        for (
            let chunk = Math.max(1, Math.floor(best.operations.length / 2));
            chunk >= 1;
            chunk = Math.floor(chunk / 2)
        ) {
            for (let start = 1; start + chunk <= best.operations.length;) {
                const candidate = {
                    config: best.config,
                    operations: [...best.operations.slice(0, start), ...best.operations.slice(start + chunk)],
                };
                const result = await fails(candidate);
                if (result) {
                    best = candidate;
                    message = result;
                    improved = true;
                } else {
                    start += chunk;
                }
            }
            if (chunk === 1) {
                break;
            }
        }
        const simpler: Partial<Config>[] = [
            { rowCount: Math.floor(best.config.rowCount / 2) },
            { rowCount: Math.max(0, best.config.rowCount - 1) },
            { maxBlocksInCache: undefined },
            { maxConcurrentRequests: undefined },
            { pageSize: undefined },
            { loadWithoutQuery: undefined },
            { unknownCounts: false },
            { honourAbort: true },
        ];
        for (const change of simpler) {
            const config = { ...best.config, ...change };
            for (const key of Object.keys(config) as (keyof Config)[]) {
                if (config[key] === undefined) {
                    delete config[key];
                }
            }
            if (sameJson(config, best.config)) {
                continue;
            }
            const result = await fails({ config, operations: best.operations });
            if (result) {
                best = { config, operations: best.operations };
                message = result;
                improved = true;
            }
        }
    }

    return { testCase: best, message };
}

async function fuzz(seeds: number[]): Promise<Stats> {
    const stats = newStats();
    for (const seed of seeds) {
        const testCase = randomCase(seed);
        const failure = await runCase(testCase, { stats });
        if (failure) {
            const shrunk = await shrink(testCase);
            expect.fail(
                `seed ${seed}: ${shrunk.message}\nminimal case: ${JSON.stringify(shrunk.testCase)}\noriginal failure: ${failure}`
            );
        }
    }

    return stats;
}

const SEEDS = Array.from({ length: 3000 }, (_, index) => 0x5eed + index * 7919);

describe('ServerRowModel fuzz', () => {
    it('keeps every property over random operation sequences, and loads the reference answer', async () => {
        const stats = await fuzz(SEEDS);
        expect(stats.cases).toBe(SEEDS.length);
        // The generator reaches the interesting states often enough to mean something.
        expect(stats.loadedAtEnd).toBeGreaterThan(SEEDS.length / 2);
        expect(stats.childRowsAtEnd).toBeGreaterThan(SEEDS.length / 20);
        expect(stats.mutated).toBeGreaterThan(SEEDS.length / 50);
    }, 300_000);

    /**
     * The bugs this fuzz found, each as its minimal case in strict mode. All four are fixed; these stay as
     * regression tests, and the fuzz above now runs strictly too.
     */
    const flat = (partial: Partial<QueryState> = {}): QueryState => ({
        search: '',
        sortModel: [],
        filterModel: {},
        externalFilters: {},
        rowGroupColIds: [],
        ...partial,
    });
    const base: Config = { dataSeed: 1, rowCount: 7, blockSize: 10, unknownCounts: false, honourAbort: true };

    // BUG 1: ensureRange puts blocks that are already in flight into `#wanted` (serverRowModel.ts, ensureRange,
    // lines 273-277), and `#pump` (lines 437-446) never drops entries that have since loaded or failed. When the request
    // settles, its own `finally` pumps the same block again: a loaded block is fetched twice, and a failed
    // block is retried at once, against "a failed block is not retried by scrolling, only by refresh".
    it('BUG 1: does not re-request a block that loaded while ensureRange wanted it', async () => {
        const failure = await runCase(
            {
                config: base,
                operations: [
                    { type: 'setQuery', query: flat() },
                    { type: 'ensureRange', first: 0, last: 5, mode: 'near' },
                    { type: 'settle', pick: 0, reject: false },
                ],
            },
            { strict: true, liveness: false }
        );

        expect(failure).toBeNull();
    });

    it('BUG 1: does not retry a failed block that ensureRange wanted while it was in flight', async () => {
        const failure = await runCase(
            {
                config: base,
                operations: [
                    { type: 'setQuery', query: flat() },
                    { type: 'ensureRange', first: 0, last: 5, mode: 'near' },
                    { type: 'settle', pick: 0, reject: true },
                ],
            },
            { strict: true, liveness: false }
        );

        expect(failure).toBeNull();
    });

    // BUG 2: ServerProjection.setBlock (serverProjection.ts, lines 123-125) sets a level's count to the end of
    // any short block, after ServerRowModel has applied the server's `rowCount` (serverRowModel.ts, line
    // 485). An empty block past the end (a page chosen while the count was unknown, or a stale block after
    // the data shrank) therefore sets the count to that block's start: 7 rows become a count of 110.
    it('BUG 2: keeps the server row count when a block past the end comes back empty', async () => {
        const failure = await runCase(
            {
                config: { ...base, pageSize: 37 },
                operations: [
                    { type: 'setQuery', query: flat() },
                    { type: 'setPage', page: 3 },
                    { type: 'refresh', route: 'root', pick: 0, mutate: false },
                ],
            },
            { strict: true }
        );

        expect(failure).toBeNull();
    });

    // BUG 3: refresh() requests the first block without the `loadWithoutQuery: false` check that setQuery
    // makes (serverRowModel.ts, refresh, lines 307-310), so refreshing an empty "no filters" grid loads the
    // unfiltered rows and sets the status to loading.
    it('BUG 3: a refresh under noQuery requests nothing', async () => {
        const failure = await runCase(
            {
                config: { ...base, loadWithoutQuery: false },
                operations: [
                    { type: 'setQuery', query: flat() },
                    { type: 'refresh', route: 'root', pick: 0, mutate: false },
                ],
            },
            { strict: true }
        );

        expect(failure).toBeNull();
    });

    // BUG 4: refresh({ route, purge: true }) clears `#stale` for every level (serverRowModel.ts, refresh,
    // line 306), not only below the route. After refresh({ purge: false }) marked everything stale, purging
    // one group means the other levels keep their old rows forever: ensureRange never reloads them.
    it('BUG 4: a purging refresh of one group keeps other levels stale until they reload', async () => {
        const failure = await runCase(
            {
                config: { ...base, rowCount: 57, blockSize: 3 },
                operations: [
                    { type: 'setQuery', query: flat({ rowGroupColIds: ['team'] }) },
                    { type: 'settle', pick: 0, reject: false },
                    { type: 'refresh', route: 'root', pick: 0, mutate: true, purge: false },
                    { type: 'refresh', route: 'group', pick: 0, mutate: false },
                ],
            },
            { strict: true }
        );

        expect(failure).toBeNull();
    });
});
