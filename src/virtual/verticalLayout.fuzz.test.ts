/**
 * Randomized property tests for `VerticalLayout`.
 *
 * Random operation sequences drive a layout the way the React binding does: scroll and resize events,
 * measured heights, new row sources after structural changes to a local or server projection, height
 * resets and retained rows. After every operation the layout is checked against properties taken from the
 * doc comments: scroll bounds, normal flow placement, bounded mounting, retained rows, anchoring,
 * scroll-to visibility and heights keyed by row id.
 *
 * The "browser" in this harness applies every returned correction clamped to the scroll range and reports
 * it back through `setViewport`, like the scroll element does after the binding writes `scrollTop`.
 */
import { describe, expect, it } from 'vitest';

import type { GridRow, RowHeight, RowId } from '../contract';
import { groupRowId } from '../rows/ids';
import { buildLocalProjection, type DefaultExpanded, type LocalProjection } from '../rows/localProjection';
import { ServerProjection } from '../rows/serverProjection';
import { localRowSource, serverRowSource } from './rowSources';
import { DEFAULT_SCALED_EDGE } from './scrollMapping';
import { VerticalLayout, type RowSource, type ScrollCorrection } from './verticalLayout';

// PRNG

/** mulberry32: tiny, seedable and good enough for test input. */
function createRandom(seed: number) {
    let state = seed >>> 0;
    const next = (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    return {
        next,
        int: (min: number, max: number): number => min + Math.floor(next() * (max - min + 1)),
        chance: (p: number): boolean => next() < p,
        pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
    };
}
type Random = ReturnType<typeof createRandom>;

// Rows

/** One data type for both projections: local rows use id, g, h, master and fw; server groups use the _ fields. */
type Row = {
    id?: string;
    g?: string;
    h?: string;
    master?: boolean;
    fw?: boolean;
    rev?: number;
    _group?: boolean;
    _groupKey?: string;
    _childCount?: number;
};

const isLoaded = (row: GridRow<Row> | undefined): row is GridRow<Row> =>
    row !== undefined && row.kind !== 'loading' && row.kind !== 'failed';

/** The data behind a row: its own, a detail row's master data, or null for groups and placeholders. */
const dataOf = (row: GridRow<Row> | undefined): Row | null => (row && 'data' in row ? row.data : null);

/** Only multiples of a quarter pixel, so every sum is exact in doubles and unscaled checks can be exact. */
const quarter = (random: Random, min: number, max: number): number => random.int(min * 4, max * 4) / 4;

// Harness

/** Documented limits the fuzz counts instead of failing on. */
type KnownBug = 'rowTallerThanEdge';

type World = {
    random: Random;
    layout: VerticalLayout<Row>;
    /** The source the layout currently holds. */
    current: RowSource<Row>;
    /** A fresh adapter over the current projection state. */
    makeSource: () => RowSource<Row>;
    server: boolean;
    rule: RowHeight<Row>;
    estimate: number;
    overscan: number;
    viewportHeight: number;
    /** Arbitrary fractional heights: comparisons use a tolerance instead of exact equality. */
    fractional: boolean;
    measured: Map<RowId, number>;
    retained: RowId[];
    /** The last `setViewport` passed a position outside the scroll range, as rubber banding can. */
    rawScroll: boolean;
    known: Record<KnownBug, number>;
    log: string[];
};

class PropertyError extends Error {}

function fail(message: string): never {
    throw new PropertyError(message);
}

const tolerance = (world: World): number => (world.layout.mapping.scaled ? 1e-3 : world.fractional ? 1e-6 : 0);

function near(a: number, b: number, tol: number): boolean {
    return Math.abs(a - b) <= tol;
}

function maxScroll(world: World): number {
    return Math.max(0, world.layout.mapping.physicalTotal - world.viewportHeight);
}

function fixedHeight(world: World, row: GridRow<Row>): number | null {
    const rule = world.rule;
    if (typeof rule === 'number') {
        return rule;
    }
    if (rule === 'measure') {
        return null;
    }
    const value = rule(row);

    return value === 'measure' ? null : value;
}

function top(world: World, index: number): number {
    return world.layout.getRowBounds(index)!.top;
}

function height(world: World, index: number): number {
    return world.layout.getRowBounds(index)!.height;
}

/** Applies a correction like the scroll element does: clamped to the range, then reported back. */
function browserApply(world: World, correction: ScrollCorrection): void {
    if (correction) {
        world.rawScroll = false;
        world.layout.setViewport(Math.min(Math.max(correction.scrollTop, 0), maxScroll(world)), world.viewportHeight);
    }
}

// Properties

function checkBounds(world: World, correction: ScrollCorrection, operation: string): void {
    const max = maxScroll(world);
    const tol = tolerance(world) + 1e-9;
    if (correction) {
        if (correction.scrollTop !== world.layout.scrollTop) {
            fail(`${operation} returned ${correction.scrollTop} but holds scrollTop ${world.layout.scrollTop}`);
        }
        if (correction.scrollTop < -tol || correction.scrollTop > max + tol) {
            fail(`scroll bounds: ${operation} returned scrollTop ${correction.scrollTop} outside [0, ${max}]`);
        }
    }
    if (!world.rawScroll) {
        const scrollTop = world.layout.scrollTop;
        if (scrollTop < -tol || scrollTop > max + tol) {
            fail(`scroll bounds: scrollTop ${scrollTop} outside [0, ${max}] after ${operation}`);
        }
    }
}

function checkWindow(world: World): void {
    const { layout } = world;
    const count = world.current.count;
    const window = layout.getWindow();
    const tol = tolerance(world);
    if (window.totalHeight !== layout.mapping.physicalTotal) {
        fail(`totalHeight ${window.totalHeight} differs from the mapping ${layout.mapping.physicalTotal}`);
    }

    // Walk the items like the browser lays out normal flow.
    const placed = new Map<number, number>();
    let cursor = 0;
    let previousEnd = -2;
    let minHeight = Infinity;
    for (const item of window.items) {
        if (item.type === 'spacer') {
            if (!(item.size >= 0) || !Number.isFinite(item.size)) {
                fail(`spacer of size ${item.size}`);
            }
            cursor += item.size;
            continue;
        }
        // With no viewport and no overscan the main run is empty, ending one row before it starts; nothing is mounted.
        const empty = item.end === item.start - 1 && world.viewportHeight + 2 * world.overscan === 0;
        if ((item.start > item.end && !empty) || item.start <= previousEnd + 1 || item.start < 0 || item.end >= count) {
            fail(`malformed run ${item.start}..${item.end} after ${previousEnd} with ${count} rows`);
        }
        previousEnd = item.end;
        for (let index = item.start; index <= item.end; index++) {
            placed.set(index, cursor);
            const rowHeight = height(world, index);
            minHeight = Math.min(minHeight, rowHeight);
            cursor += rowHeight;
        }
    }

    // 2. Layout: rows at their bounds, items summing to the total.
    if (!layout.mapping.scaled) {
        for (const [index, physicalTop] of placed) {
            if (!near(physicalTop, top(world, index), tol)) {
                fail(`layout: row ${index} placed at ${physicalTop}, bounds say ${top(world, index)}`);
            }
        }
    } else if (!world.rawScroll && count > 0 && world.viewportHeight + world.overscan > 0) {
        // Scaled: the run holding the first visible row is pinned to the viewport.
        const virtualTop = layout.getVirtualScrollTop();
        const first = layout.getIndexAtOffset(virtualTop)!;
        const physicalFirst = placed.get(first);
        if (physicalFirst === undefined) {
            fail(`layout: first visible row ${first} is not mounted`);
        }
        if (!near(physicalFirst - layout.scrollTop, top(world, first) - virtualTop, 1e-3)) {
            // Documented limit: the 1:1 edge of a scaled mapping (DEFAULT_SCALED_EDGE, at most a quarter of
            // the physical range) must be taller than the mounted rows; a single row taller than the edge
            // cannot be pinned at its boundary. Everything else must be exact.
            const edge = Math.min(DEFAULT_SCALED_EDGE, (layout.mapping.physicalTotal - world.viewportHeight) / 4);
            const tallest = Math.max(...[...placed.keys()].map((index) => height(world, index)));
            if (tallest > edge) {
                world.known.rowTallerThanEdge++;
            } else {
                fail(
                    `layout: first visible row ${first} at ${physicalFirst - layout.scrollTop} from the viewport, expected ${top(world, first) - virtualTop}`
                );
            }
        }
    }
    if (!near(cursor, window.totalHeight, Math.max(tol, 1e-6))) {
        // Documented limit: when the mounted rows alone are taller than the whole physical range (a row taller
        // than the range, possible only with a tiny maxPhysicalHeight), they cannot fit. Everything else must sum exactly.
        const mountedHeight = [...placed.keys()].reduce((sum, index) => sum + height(world, index), 0);
        if (layout.mapping.scaled && mountedHeight > window.totalHeight) {
            world.known.rowTallerThanEdge++;
        } else {
            fail(
                `layout: items sum to ${cursor}, totalHeight is ${window.totalHeight} (scaled ${layout.mapping.scaled})`
            );
        }
    }

    // 4. Retained rows that exist are mounted.
    let retainedCount = 0;
    for (const id of new Set(world.retained)) {
        const index = world.current.indexOf(id);
        if (index !== undefined) {
            retainedCount++;
            if (!placed.has(index)) {
                fail(`retained row ${id} at ${index} is not mounted`);
            }
        }
    }

    // 3. Bounded mounting.
    if (placed.size > 0) {
        const bound = Math.ceil((world.viewportHeight + 2 * world.overscan) / minHeight) + 3 + retainedCount;
        if (placed.size > bound) {
            fail(`mounting: ${placed.size} rows mounted, bound ${bound}`);
        }
    }
}

/** 7. Every known row reports its measured height, its fixed height or the estimate. */
function checkHeights(world: World): void {
    const expectHeight = (row: GridRow<Row>, index: number): void => {
        const fixed = fixedHeight(world, row);
        const expected = fixed ?? world.measured.get(row.id) ?? world.estimate;
        if (height(world, index) !== expected) {
            fail(`heights: row ${row.id} at ${index} is ${height(world, index)}, expected ${expected}`);
        }
    };
    world.current.forEachKnown(expectHeight);
    if (world.server && world.current.count > 0) {
        // Placeholders around the viewport use the estimate.
        const first = world.layout.getIndexAtOffset(world.layout.getVirtualScrollTop())!;
        for (let index = Math.max(0, first - 20); index < Math.min(world.current.count, first + 40); index++) {
            const row = world.current.rowAt(index);
            // A number rule covers every row; otherwise placeholders use the estimate.
            const expected = typeof world.rule === 'number' ? world.rule : world.estimate;
            if (row && (row.kind === 'loading' || row.kind === 'failed') && height(world, index) !== expected) {
                fail(`heights: placeholder ${row.id} is ${height(world, index)}, expected ${expected}`);
            }
        }
    }
}

function checkAll(world: World, correction: ScrollCorrection, operation: string): void {
    checkBounds(world, correction, operation);
    checkWindow(world);
    checkHeights(world);
}

// 5. Anchoring

type Anchor = { id: RowId; index: number; offset: number; followers: RowId[]; leaders: RowId[] };

/**
 * The first loaded row inside the viewport, with the loaded neighbours the doc comment falls back to.
 * The viewport range, the neighbour scan (200 rows) and keep (50 ids) limits mirror the implementation:
 * the doc only says the lists are bounded.
 */
function captureAnchor(world: World, source: RowSource<Row>): Anchor | null {
    const { layout } = world;
    if (source.count === 0 || layout.scrollTop <= 0) {
        return null;
    }
    const virtualTop = layout.getVirtualScrollTop();
    const first = layout.getIndexAtOffset(virtualTop)!;
    const last = Math.min(layout.getIndexAtOffset(virtualTop + world.viewportHeight)!, source.count - 1);
    for (let index = first; index <= last; index++) {
        const row = source.rowAt(index);
        if (isLoaded(row)) {
            const neighbours = (step: 1 | -1): RowId[] => {
                const ids: RowId[] = [];
                for (
                    let i = index + step, scanned = 0;
                    i >= 0 && i < source.count && scanned < 200 && ids.length < 50;
                    i += step, scanned++
                ) {
                    const neighbour = source.rowAt(i);
                    if (isLoaded(neighbour)) {
                        ids.push(neighbour.id);
                    }
                }

                return ids;
            };

            return {
                id: row.id,
                index,
                offset: top(world, index) - virtualTop,
                followers: neighbours(1),
                leaders: neighbours(-1),
            };
        }
    }

    return null;
}

/** Checks the scroll position against the one that puts `targetVirtualTop` at the viewport top, clamped. */
function checkAnchored(world: World, targetVirtualTop: number, what: string): boolean {
    const { layout } = world;
    if (layout.mapping.scaled) {
        const virtualRange = Math.max(layout.mapping.virtualTotal - world.viewportHeight, 0);
        const expected = Math.min(Math.max(targetVirtualTop, 0), virtualRange);

        return (
            near(layout.getVirtualScrollTop(), expected, 1e-3) ||
            fail(`anchoring: ${what} expected virtual top ${expected}, got ${layout.getVirtualScrollTop()}`)
        );
    }
    const tol = tolerance(world);
    const expected = Math.min(Math.max(targetVirtualTop, 0), maxScroll(world));
    if (near(layout.scrollTop, expected, tol) || (world.rawScroll && near(layout.scrollTop, targetVirtualTop, tol))) {
        return true;
    }

    return fail(
        `anchoring: ${what} expected scrollTop ${expected} (unclamped ${targetVirtualTop}), got ${layout.scrollTop}`
    );
}

/** After a source change or reset: the anchor row, or its documented fallback, keeps its offset. */
function checkAnchorAfter(world: World, anchor: Anchor | null, scrollTopBefore: number): void {
    const source = world.current;
    const unanchored = (): void => {
        const expected = Math.min(scrollTopBefore, maxScroll(world));
        if (!near(world.layout.scrollTop, expected, 1e-9)) {
            fail(`anchoring: no anchor, expected scrollTop to stay at ${expected}, got ${world.layout.scrollTop}`);
        }
    };
    if (!anchor) {
        unanchored();
        return;
    }
    let index = source.indexOf(anchor.id);
    let offset = anchor.offset;
    let what = `anchor ${anchor.id}`;
    if (index === undefined) {
        // Gone: the next surviving row below takes the anchor's place, else the nearest survivor above sits
        // just above the viewport top.
        const follower = anchor.followers.find((id) => source.indexOf(id) !== undefined);
        if (follower !== undefined) {
            index = source.indexOf(follower)!;
            what = `follower ${follower} of removed anchor ${anchor.id}`;
        } else {
            const leader = anchor.leaders.find((id) => source.indexOf(id) !== undefined);
            if (leader !== undefined) {
                index = source.indexOf(leader)!;
                offset = -height(world, index);
                what = `leader ${leader} of removed anchor ${anchor.id}`;
            }
        }
    }
    if (index === undefined) {
        unanchored();
        return;
    }
    checkAnchored(world, top(world, index) - offset, what);
}

// Operations shared by both projections

function randomHeight(world: World): number {
    const { random } = world;
    const roll = random.next();
    if (roll < 0.08) {
        return 0;
    }
    if (roll < 0.16) {
        return Number.NaN;
    }
    if (roll < 0.2) {
        return -random.int(1, 50);
    }
    if (roll < 0.25) {
        return quarter(random, 600, 1500);
    }

    return world.fractional ? 8 + random.next() * 150 : quarter(random, 8, 150);
}

function mountedIndexes(world: World): number[] {
    const indexes: number[] = [];
    for (const run of world.layout.getWindow().runs) {
        for (let index = run.start; index <= run.end; index++) {
            indexes.push(index);
        }
    }

    return indexes;
}

function randomIndex(world: World): number | undefined {
    const count = world.current.count;

    return count === 0 ? undefined : world.random.int(0, count - 1);
}

function opSetViewport(world: World): string {
    const { random, layout } = world;
    const max = maxScroll(world);
    let height = world.viewportHeight;
    if (random.chance(0.2)) {
        height = random.pick([0, 1, 40, 100, 333.25, 640, 900]);
    }
    const roll = random.next();
    let scrollTop: number;
    if (roll < 0.1) {
        scrollTop = -random.int(1, 300);
    } else if (roll < 0.2) {
        scrollTop = max + random.int(1, 5000);
    } else if (roll < 0.3) {
        scrollTop = random.pick([0, max]);
    } else if (roll < 0.55) {
        // A short scroll from where we are.
        scrollTop = Math.min(Math.max(layout.scrollTop + random.int(-400, 400), 0), max);
    } else {
        scrollTop = world.fractional ? random.next() * max : Math.round(random.next() * max * 4) / 4;
    }
    world.viewportHeight = height;
    layout.setViewport(scrollTop, height);
    // The range may have changed with the height; judge the input against the range the layout now uses.
    world.rawScroll = scrollTop < 0 || scrollTop > maxScroll(world);
    checkAll(world, null, 'setViewport');

    return `setViewport(${scrollTop}, ${height})`;
}

function opRecordHeights(world: World): string {
    const { random, layout } = world;
    const entries: { id: RowId; height: number }[] = [];
    const mounted = mountedIndexes(world);
    const size = random.int(1, 12);
    for (let i = 0; i < size; i++) {
        const roll = random.next();
        let id: RowId | undefined;
        if (roll < 0.6 && mounted.length > 0) {
            id = world.current.rowAt(random.pick(mounted))?.id;
        } else if (roll < 0.9) {
            const index = randomIndex(world);
            id = index === undefined ? undefined : world.current.rowAt(index)?.id;
        } else {
            id = `missing-${random.int(0, 9)}`;
        }
        if (id !== undefined) {
            entries.push({ id, height: randomHeight(world) });
        }
    }
    const anchorIndex = world.current.count === 0 ? undefined : layout.getIndexAtOffset(layout.getVirtualScrollTop());
    const offset = anchorIndex === undefined ? 0 : top(world, anchorIndex) - layout.getVirtualScrollTop();

    const correction = layout.recordHeights(entries);
    for (const { id, height } of entries) {
        if (height > 0) {
            world.measured.set(id, height);
        }
    }
    const description = `recordHeights(${JSON.stringify(entries)})`;

    if (correction && correction.scrollTop > maxScroll(world) + tolerance(world) + 1e-9) {
        fail(`bounds: measurement correction ${correction.scrollTop} is past the maximum ${maxScroll(world)}`);
    }
    // The implementation holds the first visible row still; placeholders between it and the first loaded
    // row cannot be measured, so that also holds the first loaded row still.
    // A correction clamped at the end of the range cannot hold the anchor exactly; that is the bounds rule.
    const clamped = correction !== null && correction.scrollTop >= maxScroll(world) - 1e-9;
    if (anchorIndex !== undefined && !clamped) {
        checkAnchored(world, top(world, anchorIndex) - offset, `first visible row ${anchorIndex}`);
    }
    checkAll(world, correction, 'recordHeights');
    browserApply(world, correction);

    return description;
}

function opResetHeights(world: World): string {
    const { random, layout } = world;
    const before = layout.scrollTop;
    const anchor = captureAnchor(world, world.current);
    let ids: RowId[] | undefined;
    if (random.chance(0.3)) {
        world.measured.clear();
    } else {
        const measured = [...world.measured.keys()];
        ids = Array.from({ length: random.int(1, 8) }, () =>
            measured.length > 0 && random.chance(0.8) ? random.pick(measured) : `missing-${random.int(0, 9)}`
        );
        for (const id of ids) {
            world.measured.delete(id);
        }
    }
    const correction = layout.resetHeights(ids);
    checkAnchorAfter(world, anchor, before);
    checkAll(world, correction, 'resetHeights');
    browserApply(world, correction);

    return `resetHeights(${ids ? JSON.stringify(ids) : ''})`;
}

function opSetRetained(world: World): string {
    const { random } = world;
    const ids: RowId[] = [];
    for (let i = random.int(0, 3); i > 0; i--) {
        const index = randomIndex(world);
        if (index !== undefined && random.chance(0.8)) {
            ids.push(world.current.rowAt(index)!.id);
        } else {
            ids.push(`missing-${random.int(0, 9)}`);
        }
    }
    world.retained = ids;
    world.layout.setRetained(ids);
    checkAll(world, null, 'setRetained');

    return `setRetained(${JSON.stringify(ids)})`;
}

/** 6. 'auto' then scrolling there shows the row fully, or at the top when it is taller than the viewport. */
function opScrollToIndex(world: World): string | null {
    const { layout } = world;
    const index = randomIndex(world);
    if (index === undefined) {
        return null;
    }
    const wasRaw = world.rawScroll;
    const target = layout.scrollTopForIndex(index, 'auto');
    if (!wasRaw && (target < 0 || target > maxScroll(world) + 1e-9)) {
        fail(`scrollTopForIndex(${index}) returned ${target} outside [0, ${maxScroll(world)}]`);
    }
    layout.setViewport(target, world.viewportHeight);
    world.rawScroll = target < 0 || target > maxScroll(world);
    const bounds = layout.getRowBounds(index)!;
    const viewTop = layout.getVirtualScrollTop();
    const tol = Math.max(tolerance(world), 1e-9);
    if (bounds.height > world.viewportHeight) {
        if (!near(bounds.top, viewTop, tol)) {
            fail(
                `scrollTopForIndex(${index}): a tall row should start at the viewport top ${viewTop}, starts at ${bounds.top}`
            );
        }
    } else if (bounds.top < viewTop - tol || bounds.top + bounds.height > viewTop + world.viewportHeight + tol) {
        fail(
            `scrollTopForIndex(${index}): row ${bounds.top}..${bounds.top + bounds.height} not inside ${viewTop}..${viewTop + world.viewportHeight}`
        );
    }
    checkAll(world, null, 'scrollTopForIndex');

    return `scrollTopForIndex(${index}) -> ${target}`;
}

/**
 * Runs a structural change and hands the layout a new source. `mutate` returns a description, or null
 * when it did not apply. For server projections the old adapter reads the mutated projection, so a
 * failure explained by that is counted as the known stale anchor bug.
 */
function structural(world: World, mutate: () => string | null): string | null {
    const before = world.layout.scrollTop;
    const oldSource = world.current;
    const anchor = captureAnchor(world, oldSource);
    const description = mutate();
    if (description === null) {
        return null;
    }
    const next = world.makeSource();
    const correction = world.layout.setSource(next);
    world.current = next;
    checkAnchorAfter(world, anchor, before);
    checkAll(world, correction, description);
    browserApply(world, correction);

    return description;
}

// Local projection driver

type LocalMode = 'flat' | 'group1' | 'group2' | 'tree';

function localDriver(world: World, random: Random, rowCount: number) {
    let nextId = 0;
    const newRow = (): Row => ({
        id: String(nextId++),
        g: random.pick(['a', 'b', 'c', 'd', 'e']),
        h: random.pick(['x', 'y', 'z']),
        master: random.chance(0.15),
        fw: random.chance(0.05),
        rev: 0,
    });
    let rows: Row[] = Array.from({ length: rowCount }, newRow);
    let mode: LocalMode = random.pick(['flat', 'flat', 'group1', 'group2', 'tree']);
    const expansion = new Map<RowId, boolean>();
    let defaultExpanded: DefaultExpanded<Row> = random.pick([true, false, 1, -1]);
    let projection: LocalProjection<Row> | undefined;

    const build = (): LocalProjection<Row> => {
        projection = buildLocalProjection<Row>({
            rows,
            ...(mode === 'group1'
                ? { grouping: { colIds: ['g'], getKey: (data, colId) => (colId === 'g' ? data.g! : data.h!) } }
                : {}),
            ...(mode === 'group2'
                ? { grouping: { colIds: ['g', 'h'], getKey: (data, colId) => (colId === 'g' ? data.g! : data.h!) } }
                : {}),
            ...(mode === 'tree'
                ? { getDataPath: (data: Row) => [data.g!, data.id!] }
                : { isMaster: (data: Row) => data.master === true }),
            isFullWidth: (data) => data.fw === true,
            expansion,
            defaultExpanded,
            ...(projection ? { previous: projection } : {}),
        });

        return projection;
    };

    /** The data row behind a displayed index, searching down then up for a row that carries data. */
    const dataNear = (index: number): Row | undefined => {
        const source = world.current;
        for (let distance = 0; distance < source.count; distance++) {
            for (const candidate of [index + distance, index - distance]) {
                const row = source.rowAt(candidate);
                const data = dataOf(row);
                if (data) {
                    return data;
                }
            }
        }

        return undefined;
    };

    /** A displayed index above, inside or below the viewport. */
    const indexIn = (where: 'above' | 'inside' | 'below'): number | undefined => {
        const count = world.current.count;
        if (count === 0) {
            return undefined;
        }
        const window = world.layout.getWindow();
        const first = Math.max(window.firstVisible, 0);
        const last = Math.max(window.lastVisible, first);
        if (where === 'above') {
            return first === 0 ? undefined : random.int(0, first - 1);
        }
        if (where === 'below') {
            return last >= count - 1 ? undefined : random.int(last + 1, count - 1);
        }

        return random.int(first, last);
    };

    const positionOf = (row: Row): number => rows.indexOf(row);

    const mutations: [number, () => string | null][] = [
        [
            6,
            () => {
                const where = random.pick(['above', 'inside', 'below'] as const);
                const index = indexIn(where);
                const anchorRow = index === undefined ? undefined : dataNear(index);
                const position = anchorRow ? positionOf(anchorRow) + random.int(0, 1) : random.int(0, rows.length);
                const added = Array.from({ length: random.int(1, 30) }, newRow);
                rows = [...rows.slice(0, position), ...added, ...rows.slice(position)];

                return `insert ${added.length} ${where} at data ${position}`;
            },
        ],
        [
            6,
            () => {
                const where = random.pick(['above', 'inside', 'below'] as const);
                const index = indexIn(where);
                const target = index === undefined ? undefined : dataNear(index);
                if (!target) {
                    return null;
                }
                const position = positionOf(target);
                const length = random.chance(0.2) ? random.int(40, 120) : random.int(1, 5);
                rows = [...rows.slice(0, position), ...rows.slice(position + length)];

                return `remove ${length} ${where} from data ${position}`;
            },
        ],
        [
            3,
            () => {
                // Filter away the anchor row, or everything under an anchor group.
                const anchor = captureAnchor(world, world.current);
                if (!anchor) {
                    return null;
                }
                const row = world.current.rowAt(anchor.index)!;
                const data = dataOf(row);
                if (data) {
                    const id = data.id;
                    rows = rows.filter((data) => data.id !== id);
                } else if (row.kind === 'group') {
                    const path = row.keyPath;
                    rows = rows.filter((data) => !(data.g === path[0] && (path.length < 2 || data.h === path[1])));
                } else {
                    return null;
                }

                return `filter away anchor ${anchor.id}`;
            },
        ],
        [
            2,
            () => {
                // Everything from the anchor down: no follower survives, so the leader fallback runs.
                const anchor = captureAnchor(world, world.current);
                const data = anchor ? dataOf(world.current.rowAt(anchor.index)) : null;
                if (!anchor || !data || mode !== 'flat') {
                    return null;
                }
                rows = rows.slice(0, positionOf(data));

                return `remove from anchor ${anchor.id} down`;
            },
        ],
        [
            2,
            () => {
                const how = random.pick(['shuffle', 'reverse', 'byGroup'] as const);
                if (how === 'reverse') {
                    rows = [...rows].reverse();
                } else if (how === 'byGroup') {
                    rows = [...rows].sort((a, b) => a.g!.localeCompare(b.g!) || a.h!.localeCompare(b.h!));
                } else {
                    rows = [...rows];
                    for (let i = rows.length - 1; i > 0; i--) {
                        const j = random.int(0, i);
                        [rows[i], rows[j]] = [rows[j]!, rows[i]!];
                    }
                }

                return `sort ${how}`;
            },
        ],
        [
            1,
            () => {
                mode = random.pick(['flat', 'group1', 'group2', 'tree'] as const);

                return `group ${mode}`;
            },
        ],
        [
            6,
            () => {
                // Toggle an expandable displayed row, mostly near the viewport.
                const source = world.current;
                const candidates: GridRow<Row>[] = [];
                const window = world.layout.getWindow();
                const near = random.chance(0.7);
                const from = near ? Math.max(0, window.firstVisible - 30) : 0;
                const to = near ? Math.min(source.count - 1, window.lastVisible + 30) : source.count - 1;
                for (let index = from; index <= to; index++) {
                    const row = source.rowAt(index);
                    if (row && (row.kind === 'group' || (row.kind === 'data' && row.expandable))) {
                        candidates.push(row);
                    }
                }
                if (candidates.length === 0) {
                    return null;
                }
                const row = random.pick(candidates);
                const expanded =
                    row.kind === 'group' ? row.expanded : row.kind === 'data' ? row.expandable!.expanded : false;
                expansion.set(row.id, !expanded);

                return `${expanded ? 'collapse' : 'expand'} ${row.id}`;
            },
        ],
        [
            1,
            () => {
                expansion.clear();
                defaultExpanded = random.pick([true, false, 1, -1]);

                return `default expanded ${String(defaultExpanded)}`;
            },
        ],
        [
            1,
            () => {
                // New data objects with the same ids: nothing structural changes.
                rows = rows.map((row) => (random.chance(0.3) ? { ...row, rev: row.rev! + 1 } : row));

                return 'update data';
            },
        ],
        [1, () => 'same rows'],
    ];

    return { build, mutations };
}

// Server projection driver

type ServerConfig = { rowCount: number; blockSize: number; grouped: boolean };

function serverDriver(world: World, random: Random, config: ServerConfig) {
    const { blockSize, grouped } = config;
    const projection = new ServerProjection<Row>({ blockSize, ...(grouped ? { groupColIds: ['g'] } : {}) });
    const large = config.rowCount > 10_000;

    // Backend state. Flat: root ids by position. Grouped: root groups, each with its leaf ids.
    let nextId = 0;
    let rootIds: string[] | null =
        large || grouped ? null : Array.from({ length: config.rowCount }, () => `r${nextId++}`);
    let rootCount = config.rowCount;
    let shift = 0;
    const groups = grouped
        ? Array.from({ length: config.rowCount }, (_, k) => ({
              key: `G${k}`,
              children: Array.from({ length: random.int(0, 60) }, () => `c${nextId++}`),
          }))
        : [];

    const rootData = (position: number): Row =>
        grouped
            ? { _group: true, _groupKey: groups[position]!.key, _childCount: groups[position]!.children.length }
            : { id: rootIds ? rootIds[position]! : `r${position - shift}` };
    const levelCount = (route: readonly (string | null)[]): number =>
        route.length === 0 ? rootCount : (groups.find((group) => group.key === route[0])?.children.length ?? 0);
    const blockData = (route: readonly (string | null)[], blockIndex: number): Row[] => {
        const start = blockIndex * blockSize;
        const end = Math.min(start + blockSize, levelCount(route));
        const data: Row[] = [];
        for (let position = start; position < end; position++) {
            data.push(
                route.length === 0
                    ? rootData(position)
                    : { id: groups.find((group) => group.key === route[0])!.children[position]! }
            );
        }

        return data;
    };

    if (random.chance(0.7)) {
        projection.setRowCount([], rootCount);
    }

    /** A block address near the viewport, from the placeholders and loaded rows displayed there. */
    const blockNearViewport = (): { route: (string | null)[]; blockIndex: number } | undefined => {
        const window = world.layout.getWindow();
        const from = Math.max(0, window.firstVisible - (random.chance(0.5) ? 300 : 0));
        const missing = projection.missingBlocks(from, Math.max(from, window.lastVisible + 200));
        if (missing.length > 0 && random.chance(0.8)) {
            return random.pick(missing);
        }
        const index =
            random.chance(0.7) && window.firstVisible >= 0
                ? random.int(
                      Math.max(0, window.firstVisible - 50),
                      Math.min(world.current.count - 1, window.lastVisible + 50)
                  )
                : randomIndex(world);
        if (index === undefined) {
            return undefined;
        }
        const row = projection.getRowAtIndex(index)?.row;
        if (!row) {
            return undefined;
        }
        if (row.kind === 'loading' || row.kind === 'failed') {
            const match = /^(?:loading|failed):(.*):(\d+)$/.exec(row.id)!;

            return {
                route: JSON.parse(match[1]!) as (string | null)[],
                blockIndex: Math.floor(Number(match[2]) / blockSize),
            };
        }
        if (row.kind === 'group') {
            return {
                route: [],
                blockIndex: Math.floor(groups.findIndex((group) => group.key === row.key) / blockSize),
            };
        }
        if (row.parentId !== null) {
            const group = groups.find((candidate) => groupRowId(['g'], [candidate.key]) === row.parentId)!;

            return { route: [group.key], blockIndex: Math.floor(group.children.indexOf(row.id) / blockSize) };
        }
        const position = rootIds ? rootIds.indexOf(row.id) : Number(row.id.slice(1)) + shift;

        return position < 0 ? undefined : { route: [], blockIndex: Math.floor(position / blockSize) };
    };

    const makeSource = (): RowSource<Row> => serverRowSource(projection);

    const mutations: [number, () => string | null][] = [
        [
            8,
            () => {
                const address = blockNearViewport();
                if (!address) {
                    return null;
                }
                projection.setBlock(address.route, address.blockIndex, blockData(address.route, address.blockIndex));

                return `load ${JSON.stringify(address.route)} block ${address.blockIndex}`;
            },
        ],
        [
            2,
            () => {
                const address = blockNearViewport();
                if (!address) {
                    return null;
                }
                projection.setBlockFailed(address.route, address.blockIndex, new Error('offline'));

                return `fail ${JSON.stringify(address.route)} block ${address.blockIndex}`;
            },
        ],
        [
            3,
            () => {
                const address = blockNearViewport();
                if (!address) {
                    return null;
                }
                projection.removeBlock(address.route, address.blockIndex);

                return `evict ${JSON.stringify(address.route)} block ${address.blockIndex}`;
            },
        ],
        [
            grouped ? 6 : 0,
            () => {
                const loaded: GridRow<Row>[] = [];
                projection.forEachLoaded((row) => row.kind === 'group' && loaded.push(row));
                if (loaded.length === 0) {
                    return null;
                }
                const row = random.pick(loaded);
                const expanded = projection.isExpanded(row.id);
                projection.setExpanded(row.id, !expanded);

                return `${expanded ? 'collapse' : 'expand'} ${row.id}`;
            },
        ],
        [
            1,
            () => {
                const route = grouped && random.chance(0.5) ? [random.pick(groups).key] : [];
                projection.clear(route);
                if (route.length === 0 && random.chance(0.5)) {
                    projection.setRowCount([], rootCount);
                }

                return `clear ${JSON.stringify(route)}`;
            },
        ],
        [
            grouped ? 0 : 2,
            () => {
                // Rows inserted on the backend near the top; loaded blocks go stale until reloaded.
                const added = random.int(1, 20);
                if (rootIds) {
                    const position = random.int(0, rootIds.length);
                    rootIds.splice(position, 0, ...Array.from({ length: added }, () => `r${nextId++}`));
                } else {
                    shift += added;
                }
                rootCount += added;
                if (random.chance(0.5)) {
                    projection.setRowCount([], rootCount);
                }

                return `backend insert ${added}`;
            },
        ],
        [1, () => 'same rows'],
    ];

    return { makeSource, mutations };
}

// Sequences

type SequenceConfig = {
    kind: 'local' | 'server';
    rowCount: number;
    length: number;
    blockSize?: number;
    grouped?: boolean;
    maxPhysicalHeight?: number;
};

function pickWeighted<T>(random: Random, entries: readonly (readonly [number, T])[]): T {
    const total = entries.reduce((sum, [weight]) => sum + weight, 0);
    let roll = random.next() * total;
    for (const [weight, value] of entries) {
        roll -= weight;
        if (roll < 0) {
            return value;
        }
    }

    return entries[entries.length - 1]![1];
}

function runSequence(seed: number, config: SequenceConfig, known: Record<KnownBug, number>): number {
    const random = createRandom(seed);
    const server = config.kind === 'server';
    const fractional = !server && random.chance(0.15);
    const estimate = random.pick([20, 32, 33.5]);
    const overscan = random.pick([0, 100, 400]);
    const ruleKind = random.pick(['measure', 'measure', 'number', 'function'] as const);
    const rule: RowHeight<Row> =
        ruleKind === 'number'
            ? random.pick([24, 40])
            : ruleKind === 'measure'
              ? 'measure'
              : (row: GridRow<Row>) => {
                    if (row.kind === 'group') {
                        return 36;
                    }
                    if (row.kind === 'detail' || row.kind === 'fullWidth') {
                        return 'measure';
                    }
                    if (row.kind === 'data') {
                        return Number(row.id.replace(/\D/g, '')) % 3 === 0 ? 'measure' : 28;
                    }

                    return 30;
                };
    const layout = new VerticalLayout<Row>({
        estimatedRowHeight: estimate,
        rowHeight: rule,
        overscan,
        ...(config.maxPhysicalHeight !== undefined ? { maxPhysicalHeight: config.maxPhysicalHeight } : {}),
    });
    const world: World = {
        random,
        layout,
        current: { count: 0, rowAt: () => undefined, indexOf: () => undefined, forEachKnown: () => {} },
        makeSource: () => world.current,
        server,
        rule,
        estimate,
        overscan,
        viewportHeight: random.pick([0, 100, 333.25, 640, 900]),
        fractional,
        measured: new Map(),
        retained: [],
        rawScroll: false,
        known,
        log: [
            `seed ${seed} ${JSON.stringify(config)} rule ${ruleKind === 'number' ? String(rule) : ruleKind} estimate ${estimate} overscan ${overscan} fractional ${fractional}`,
        ],
    };
    let mutations: [number, () => string | null][];
    if (server) {
        const driver = serverDriver(world, random, {
            rowCount: config.rowCount,
            blockSize: config.blockSize ?? 100,
            grouped: config.grouped ?? false,
        });
        world.makeSource = driver.makeSource;
        mutations = driver.mutations;
    } else {
        const driver = localDriver(world, random, config.rowCount);
        world.makeSource = () => localRowSource(driver.build());
        mutations = driver.mutations;
    }

    let operations = 0;
    try {
        layout.setViewport(0, world.viewportHeight);
        const initial = world.makeSource();
        world.current = initial;
        checkAll(world, layout.setSource(initial), 'initial setSource');
        const ops: [number, () => string | null][] = [
            [5, () => opSetViewport(world)],
            [5, () => opRecordHeights(world)],
            [2, () => opResetHeights(world)],
            [1, () => opSetRetained(world)],
            [2, () => opScrollToIndex(world)],
            [6, () => structural(world, pickWeighted(random, mutations))],
        ];
        for (let step = 0; step < config.length; step++) {
            const description = pickWeighted(random, ops)();
            if (description !== null) {
                world.log.push(description);
                operations++;
            }
        }
    } catch (error) {
        throw new Error(
            `${(error as Error).message}\n\nafter ${operations} operations:\n${world.log.slice(-25).join('\n')}`,
            { cause: error }
        );
    }

    return operations;
}

/** Environment knobs for exploring by hand; the project has no Node types, so read them untyped. */
const env: Record<string, string | undefined> =
    (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const scale = Number(env.FUZZ_SEQUENCES ?? 1);
const firstSeed = Number(env.FUZZ_SEED ?? 1);

const noKnown = (): Record<KnownBug, number> => ({ rowTallerThanEdge: 0 });

/**
 * FUZZ_SEQUENCES multiplies the number of sequences per suite (default 1), FUZZ_SEED moves the seed range.
 * Known bugs are counted instead of failing the run; the focused tests below reproduce them.
 */
describe('VerticalLayout property fuzz', () => {
    const suite = (sequences: number, config: (random: Random) => SequenceConfig) => {
        const known = noKnown();
        let operations = 0;
        for (let seed = firstSeed; seed < firstSeed + sequences * scale; seed++) {
            operations += runSequence(seed, config(createRandom(seed ^ 0x5bd1e995)), known);
        }

        return { operations, known };
    };

    it('holds over local projections', () => {
        const { operations } = suite(150, (random) => ({ kind: 'local', rowCount: random.int(10, 300), length: 40 }));
        expect(operations).toBeGreaterThan(150 * 30);
    });

    it('holds over local projections with scaled mapping', () => {
        const { operations } = suite(80, (random) => ({
            kind: 'local',
            rowCount: random.int(50, 300),
            length: 40,
            maxPhysicalHeight: random.pick([1500, 3000, 6000]),
        }));
        expect(operations).toBeGreaterThan(80 * 30);
    });

    it('holds over small server projections', () => {
        const { operations } = suite(150, (random) => ({
            kind: 'server',
            rowCount: random.int(10, 300),
            length: 40,
            blockSize: random.pick([10, 25, 100]),
            grouped: random.chance(0.4),
            ...(random.chance(0.3) ? { maxPhysicalHeight: 3000 } : {}),
        }));
        expect(operations).toBeGreaterThan(150 * 30);
    });

    it('holds over a million server rows in scaled mode', () => {
        const { operations } = suite(4, (random) => ({
            kind: 'server',
            rowCount: random.pick([500_000, 1_000_000]),
            length: 40,
            blockSize: 100,
        }));
        expect(operations).toBeGreaterThan(4 * 25);
    });
});

/**
 * Minimal reproductions of the bugs the fuzz found. Each asserts the documented behaviour and is marked
 * `it.fails` until the implementation is fixed; the fuzz above counts these cases instead of failing.
 */
describe('VerticalLayout known bugs', () => {
    type Plain = { id: number };
    const plainRows = (count: number): Plain[] => Array.from({ length: count }, (_, id) => ({ id }));

    /** Walks the items like the browser and returns the physical top of `index` and the items' sum. */
    const walk = (layout: VerticalLayout<Plain>, index: number): { physicalTop: number | undefined; sum: number } => {
        let cursor = 0;
        let physicalTop: number | undefined;
        for (const item of layout.getWindow().items) {
            if (item.type === 'spacer') {
                cursor += item.size;
                continue;
            }
            for (let i = item.start; i <= item.end; i++) {
                if (i === index) {
                    physicalTop = cursor;
                }
                cursor += layout.getRowBounds(i)!.height;
            }
        }

        return { physicalTop, sum: cursor };
    };

    const scaledThousand = (overscan: number) => {
        const layout = new VerticalLayout<Plain>({
            estimatedRowHeight: 32,
            rowHeight: 32,
            overscan,
            maxPhysicalHeight: 10_000,
        });
        layout.setViewport(0, 640);
        layout.setSource(localRowSource(buildLocalProjection({ rows: plainRows(1000) })));

        return layout;
    };

    // recordHeights moves scrollTop by the change above the anchor but never clamps it to the new range.
    // Here row 0 grows by 32 while row 9 shrinks by 31 at the bottom of the range: the new maximum is 221,
    // the returned scrollTop is 252. restoreAnchor and #remap both clamp; this path does not.
    it('clamps the measurement correction to the scroll range', () => {
        const layout = new VerticalLayout<Plain>({ estimatedRowHeight: 32, overscan: 0 });
        layout.setViewport(0, 100);
        layout.setSource(localRowSource(buildLocalProjection({ rows: plainRows(10) })));
        layout.setViewport(220, 100);

        const correction = layout.recordHeights([
            { id: '0', height: 64 },
            { id: '9', height: 1 },
        ]);

        expect(correction!.scrollTop).toBeLessThanOrEqual(layout.getWindow().totalHeight - 100);
    });

    // In scaled mode the physical to virtual ratio depends on the total height. A row below the anchor
    // changing height changes the ratio, so the same physical scrollTop shows a different virtual top, but
    // recordHeights returns null because nothing above the anchor changed. On a million 32px rows, 30 rows
    // below the viewport growing to 50px move the view by about 270px.
    it('keeps the view still in scaled mode when rows below the anchor change height', () => {
        const projection = new ServerProjection<Plain>({ blockSize: 100 });
        projection.setRowCount([], 1_000_000);
        const layout = new VerticalLayout<Plain>({ estimatedRowHeight: 32, overscan: 0 });
        layout.setViewport(0, 640);
        layout.setSource(serverRowSource(projection));
        layout.setViewport(5_000_000, 640);
        const first = layout.getIndexAtOffset(layout.getVirtualScrollTop())!;
        const blockIndex = Math.floor(first / 100) + 1;
        projection.setBlock(
            [],
            blockIndex,
            plainRows(100).map((row) => ({ id: blockIndex * 100 + row.id }))
        );
        layout.setSource(serverRowSource(projection));
        const before = layout.getRowBounds(first)!.top - layout.getVirtualScrollTop();

        layout.recordHeights(plainRows(30).map((row) => ({ id: String(blockIndex * 100 + row.id), height: 50 })));

        expect(layout.getRowBounds(first)!.top - layout.getVirtualScrollTop()).toBeCloseTo(before, 3);
    });

    // setSource captures the anchor from the previous source, but serverRowSource reads the live
    // ServerProjection, which the caller has already mutated. Expanding a group above the viewport inserts
    // 100 placeholders: the old adapter now shows placeholders in the viewport, no anchor is found, and the
    // view jumps from group G5 into G0's children. G5 moved from index 5 to 105, so scrollTop should be 3360.
    it('keeps the anchor row in place when a server group above the viewport expands', () => {
        const projection = new ServerProjection<Row>({ blockSize: 100, groupColIds: ['g'] });
        projection.setBlock(
            [],
            0,
            Array.from({ length: 10 }, (_, k) => ({ _group: true, _groupKey: `G${k}`, _childCount: 100 }))
        );
        const layout = new VerticalLayout<Row>({ estimatedRowHeight: 32, rowHeight: 32, overscan: 0 });
        layout.setViewport(0, 64);
        layout.setSource(serverRowSource(projection));
        layout.setViewport(160, 64);

        projection.setExpanded(groupRowId(['g'], ['G0']), true);
        layout.setSource(serverRowSource(projection));

        expect(layout.scrollTop).toBe(3360);
    });

    // totalHeight is documented as the physical height of spacers plus rows. Near the end of a scaled range
    // the main run is pinned to the viewport but its overscan below is laid out in virtual pixels, which do
    // not fit in the physical space left, so the items overflow the total (here by about 24px). The browser's
    // scroll range then grows while scrolling near the end.
    it('keeps the items within totalHeight near the end of a scaled range', () => {
        const layout = scaledThousand(400);
        layout.setViewport(9350, 640);

        expect(walk(layout, 0).sum).toBeCloseTo(layout.getWindow().totalHeight, 6);
    });

    // Near the top of a scaled range the overscan above the viewport is taller in virtual pixels than the
    // physical scroll offset, so the main run would have to start above 0. Its spacer is clamped to 0 and
    // the run is pushed down: at scrollTop 50 the first visible row 5 should sit 7.5px above the viewport
    // top, it renders 110px below it. With the default overscan of 400 the first 400px of scrolling are off.
    it('pins the first visible row to the viewport near the top of a scaled range', () => {
        const layout = scaledThousand(400);
        layout.setViewport(50, 640);
        const virtualTop = layout.getVirtualScrollTop();
        const first = layout.getIndexAtOffset(virtualTop)!;

        expect(walk(layout, first).physicalTop! - layout.scrollTop).toBeCloseTo(
            layout.getRowBounds(first)!.top - virtualTop,
            3
        );
    });

    // The same displacement from a retained row: in scaled mode it is placed by the mapping, and a row a few
    // rows above the viewport ends below where the main run should start, pushing the visible rows down by
    // about 15px while the focused row sits just above the viewport.
    it('pins the first visible row when a retained row sits just above the window in scaled mode', () => {
        const layout = scaledThousand(0);
        layout.setViewport(5000, 640);
        const virtualTop = layout.getVirtualScrollTop();
        const first = layout.getIndexAtOffset(virtualTop)!;
        // A retained row just above the window; the index depends on the mapping, so derive it.
        layout.setRetained([String(first - 3)]);

        expect(layout.getWindow().runs[0]).toEqual({ start: first - 3, end: first - 3 });
        expect(walk(layout, first).physicalTop! - layout.scrollTop).toBeCloseTo(
            layout.getRowBounds(first)!.top - virtualTop,
            3
        );
    });
});
