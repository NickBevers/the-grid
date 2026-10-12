/**
 * Randomized property tests for `ColumnLayout`.
 *
 * Random operation sequences replace the columns, change the viewport width, resize and reset columns and
 * read windows at random scroll positions. After every operation the layout is checked against properties
 * taken from the doc comments: width bounds and flex filling, resized widths that survive, section order
 * and offsets, the center window (exact spacers, mounted visible, retained and keepMounted columns, a
 * bounded mount count), positions and scroll-to visibility, and header group rows that line up with the
 * columns below them.
 */
import { describe, expect, it } from 'vitest';

import {
    ColumnLayout,
    DEFAULT_COLUMN_WIDTH,
    DEFAULT_MIN_WIDTH,
    type ColumnSpec,
    type GroupHeaderCell,
    type HorizontalWindow,
    type LaidOutColumn,
} from './horizontalLayout';

/** Environment knobs for exploring by hand; the project has no Node types, so read them untyped. */
const env: Record<string, string | undefined> =
    (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
/** The flex rounding bug the fuzz found is fixed, so violations fail by default (FUZZ_STRICT=0 counts them). */
const strict = env.FUZZ_STRICT !== '0';

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

// Input

/** A width-like number: missing, tiny, ordinary, huge or fractional. */
function randomSize(random: Random): number | undefined {
    switch (random.int(0, 6)) {
        case 0:
            return undefined;
        case 1:
            return random.pick([0, 0.5, 1, 3, 19.5]);
        case 2:
            return random.int(20, 400);
        case 3:
            return random.int(1, 400) + random.pick([0.25, 0.5, 0.333, 0.9]);
        case 4:
            return random.pick([1000, 5000, 100_000]);
        default:
            return random.int(40, 250);
    }
}

function randomGroupPath(
    random: Random,
    pool: readonly string[],
    previous: readonly string[] | undefined
): string[] | undefined {
    // Often continue the previous column's path, so groups span several columns; sometimes jump to an
    // id used earlier, so the same group appears again further along.
    if (previous && random.chance(0.5)) {
        const keep = random.int(0, previous.length);

        return random.chance(0.3) && keep < 3
            ? [...previous.slice(0, keep), random.pick(pool)]
            : previous.slice(0, keep);
    }
    const depth = random.int(0, 3);
    if (depth === 0) {
        return random.chance(0.5) ? undefined : [];
    }

    return Array.from({ length: depth }, () => random.pick(pool));
}

/**
 * Mostly mixed columns. A flex heavy profile makes most columns flex with bounds close to their share,
 * so the freeze and rounding paths of the flex distribution actually run.
 */
function randomSpecs(random: Random, ids: { next: number }): ColumnSpec[] {
    const flexHeavy = random.chance(0.3);
    const count = flexHeavy
        ? random.int(1, 8)
        : random.pick([0, 1, 2, random.int(3, 12), random.int(10, 60), random.int(60, 150)]);
    const pool = Array.from({ length: random.int(1, 6) }, (_, index) => `g${index}`);
    const specs: ColumnSpec[] = [];
    let previousPath: string[] | undefined;
    for (let index = 0; index < count; index++) {
        // Reuse low ids often, so resized widths meet the same column again after setColumns.
        const colId = random.chance(0.7) ? `c${index}` : `n${ids.next++}`;
        if (specs.some((spec) => spec.colId === colId)) {
            continue;
        }
        const spec: ColumnSpec = { colId };
        const width = randomSize(random);
        if (width !== undefined) {
            spec.width = width;
        }
        if (random.chance(0.4)) {
            spec.minWidth = flexHeavy
                ? random.int(20, 200) + random.pick([0, 0, 0.5, 0.25])
                : (randomSize(random) ?? 0);
        }
        if (random.chance(flexHeavy ? 0.5 : 0.3)) {
            spec.maxWidth = flexHeavy ? random.int(40, 400) + random.pick([0, 0, 0.5]) : (randomSize(random) ?? 50);
        }
        if (random.chance(flexHeavy ? 0.85 : 0.3)) {
            spec.flex = random.pick([0, 1, 1, 2, 3, 0.5, 0.3, 1.7, -1]);
        }
        const pin = random.next();
        if (pin < 0.1) {
            spec.pinned = 'left';
        } else if (pin < 0.18) {
            spec.pinned = 'right';
        } else if (pin < 0.25) {
            spec.pinned = null;
        }
        const path = randomGroupPath(random, pool, previousPath);
        if (path !== undefined) {
            spec.groupPath = path;
        }
        previousPath = path;
        if (random.chance(0.05)) {
            spec.keepMounted = true;
        }
        specs.push(spec);
    }

    return specs;
}

function randomViewport(random: Random): number {
    return random.pick([0, 1, 7, random.int(100, 800), random.int(800, 2500), random.int(100, 2000) + 0.5, 1_000_000]);
}

function randomScroll(random: Random, layout: ColumnLayout): number {
    const width = layout.centerWidth;

    return random.pick([
        0,
        -50,
        random.next() * width,
        Math.floor(random.next() * width),
        width,
        width + 1000,
        random.next() * width + 0.37,
    ]);
}

// Model and properties

type World = {
    random: Random;
    layout: ColumnLayout;
    specs: ColumnSpec[];
    viewport: number;
    /** Widths the user resized, as the model expects them kept. */
    resized: Map<string, number>;
    log: string[];
    known: KnownBugs;
};

type KnownBugs = { flexRounding: number };

const EPSILON = 1e-6;

function fail(message: string): never {
    throw new Error(message);
}

function near(actual: number, expected: number, scale = 1): boolean {
    return Math.abs(actual - expected) <= EPSILON * Math.max(1, Math.abs(scale), Math.abs(expected));
}

const minOf = (spec: ColumnSpec) => spec.minWidth ?? DEFAULT_MIN_WIDTH;
/** Min wins when it exceeds max. */
// A maxWidth below minWidth wins, so a narrow column can set width and maxWidth 35 under a default
// minWidth of 100.
const maxOf = (spec: ColumnSpec) => spec.maxWidth ?? Infinity;
const clampTo = (value: number, spec: ColumnSpec) => Math.min(Math.max(value, minOf(spec)), maxOf(spec));
const sectionOf = (spec: ColumnSpec) =>
    spec.pinned === 'left' ? 'left' : spec.pinned === 'right' ? 'right' : 'center';
const isFlexing = (world: World, spec: ColumnSpec) =>
    !world.resized.has(spec.colId) && spec.flex !== undefined && spec.flex > 0;

function checkWidths(world: World): void {
    const { layout, specs } = world;
    let fixed = 0;
    const flexing: { spec: ColumnSpec; width: number }[] = [];
    const flexCount = specs.filter((spec) => isFlexing(world, spec)).length;
    for (const spec of specs) {
        const width = layout.getColumn(spec.colId)?.width;
        if (width === undefined) {
            fail(`column ${spec.colId} is missing`);
        }
        const outside = Math.max(Math.min(minOf(spec), maxOf(spec)) - width, width - maxOf(spec), 0);
        if (outside > EPSILON && !strict && isFlexing(world, spec) && outside < flexCount) {
            // Known bug, see the focused tests below: whole pixel rounding of flex shares ignores min and max.
            world.known.flexRounding++;
        } else if (outside > EPSILON) {
            fail(
                `column ${spec.colId} width ${width} is outside [${minOf(spec)}, ${maxOf(spec)}] (${JSON.stringify(spec)})`
            );
        }
        const resized = world.resized.get(spec.colId);
        if (resized !== undefined) {
            if (width !== clampTo(resized, spec)) {
                fail(`resized column ${spec.colId} has width ${width}, expected ${clampTo(resized, spec)}`);
            }
            fixed += width;
        } else if (isFlexing(world, spec)) {
            flexing.push({ spec, width });
        } else {
            const expected = clampTo(spec.width ?? DEFAULT_COLUMN_WIDTH, spec);
            if (width !== expected) {
                fail(`fixed column ${spec.colId} has width ${width}, expected ${expected}`);
            }
            fixed += width;
        }
    }
    if (flexing.length === 0) {
        return;
    }
    // Flex columns frozen at a bound may overflow or underfill the leftover. Once at least one flex column
    // ends strictly inside its bounds, the shared remainder was distributed and must fill it exactly.
    const leftover = Math.max(world.viewport - fixed, 0);
    const flexTotal = flexing.reduce((sum, entry) => sum + entry.width, 0);
    const inside = flexing.some(({ spec, width }) => width > minOf(spec) + EPSILON && width < maxOf(spec) - EPSILON);
    if (inside && !near(flexTotal, leftover, world.viewport)) {
        fail(`flex columns sum to ${flexTotal}, expected the leftover ${leftover}`);
    }
}

function checkSections(world: World): void {
    const { layout, specs } = world;
    const columns = layout.getColumns();
    const expectedOrder = [
        ...specs.filter((spec) => sectionOf(spec) === 'left'),
        ...specs.filter((spec) => sectionOf(spec) === 'center'),
        ...specs.filter((spec) => sectionOf(spec) === 'right'),
    ];
    if (columns.map((column) => column.colId).join(',') !== expectedOrder.map((spec) => spec.colId).join(',')) {
        fail('display order is not left, center, right in definition order');
    }
    const sectionWidths = { left: 0, center: 0, right: 0 };
    const indexes = { left: 0, center: 0, right: 0 };
    for (const column of columns) {
        const spec = specs.find((candidate) => candidate.colId === column.colId)!;
        if (column.section !== sectionOf(spec)) {
            fail(`column ${column.colId} is in section ${column.section}`);
        }
        if (column.index !== indexes[column.section]) {
            fail(`column ${column.colId} has index ${column.index}, expected ${indexes[column.section]}`);
        }
        if (column.left !== sectionWidths[column.section]) {
            fail(
                `column ${column.colId} has left ${column.left}, expected the cumulative ${sectionWidths[column.section]}`
            );
        }
        if (column.groupPath.join('/') !== (spec.groupPath ?? []).join('/')) {
            fail(`column ${column.colId} has the wrong group path`);
        }
        indexes[column.section]++;
        sectionWidths[column.section] += column.width;
    }
    if (
        layout.leftWidth !== sectionWidths.left ||
        layout.centerWidth !== sectionWidths.center ||
        layout.rightWidth !== sectionWidths.right
    ) {
        fail(
            `section widths ${layout.leftWidth}/${layout.centerWidth}/${layout.rightWidth} differ from the column sums`
        );
    }
    if (layout.totalWidth !== layout.leftWidth + layout.centerWidth + layout.rightWidth) {
        fail('totalWidth is not the sum of the sections');
    }
    const depth = Math.max(0, ...specs.map((spec) => spec.groupPath?.length ?? 0));
    if (layout.groupDepth !== depth) {
        fail(`groupDepth ${layout.groupDepth}, expected ${depth}`);
    }
}

function checkPositions(world: World, scrollLeft: number, viewportWidth: number): void {
    const { layout } = world;
    for (const column of layout.getColumns()) {
        const start =
            column.section === 'left'
                ? 0
                : column.section === 'center'
                  ? layout.leftWidth
                  : layout.leftWidth + layout.centerWidth;
        if (layout.getContentLeft(column.colId) !== start + column.left) {
            fail(`getContentLeft(${column.colId}) disagrees with the offsets`);
        }
        const rightStart =
            layout.totalWidth > viewportWidth
                ? viewportWidth - layout.rightWidth
                : layout.leftWidth + layout.centerWidth;
        const expected =
            column.section === 'left'
                ? column.left
                : column.section === 'right'
                  ? rightStart + column.left
                  : layout.leftWidth + column.left - scrollLeft;
        if (layout.getViewportLeft(column.colId, scrollLeft, viewportWidth) !== expected) {
            fail(`getViewportLeft(${column.colId}, ${scrollLeft}, ${viewportWidth}) disagrees with the offsets`);
        }
    }
    if (layout.getContentLeft('unknown') !== undefined || layout.getViewportLeft('unknown', scrollLeft) !== undefined) {
        fail('an unknown column has a position');
    }
}

const mountedCenter = (layout: ColumnLayout, window: HorizontalWindow): LaidOutColumn[] =>
    window.centerRuns.flatMap((run) => layout.centerColumns(run));

function checkWindow(
    world: World,
    scrollLeft: number,
    viewportWidth: number,
    overscan: number,
    retained: string[]
): HorizontalWindow {
    const { layout, specs } = world;
    const window = layout.getWindow(scrollLeft, viewportWidth, overscan, retained);
    const center = layout.getColumns().filter((column) => column.section === 'center');
    if (
        window.leftWidth !== layout.leftWidth ||
        window.centerWidth !== layout.centerWidth ||
        window.rightWidth !== layout.rightWidth ||
        window.totalWidth !== layout.totalWidth
    ) {
        fail('window widths differ from the layout');
    }
    if (
        window.left.map((column) => column.colId).join(',') !==
        layout
            .getColumns()
            .filter((column) => column.section === 'left')
            .map((column) => column.colId)
            .join(',')
    ) {
        fail('window does not mount every left pinned column');
    }
    if (
        window.right.map((column) => column.colId).join(',') !==
        layout
            .getColumns()
            .filter((column) => column.section === 'right')
            .map((column) => column.colId)
            .join(',')
    ) {
        fail('window does not mount every right pinned column');
    }

    // Runs: sorted, disjoint and inside the center section.
    let previousEnd = -2;
    for (const run of window.centerRuns) {
        if (run.start > run.end || run.start < 0 || run.end >= center.length || run.start <= previousEnd + 1) {
            fail(`bad runs ${JSON.stringify(window.centerRuns)} for ${center.length} center columns`);
        }
        previousEnd = run.end;
    }

    // Items alternate spacer and run, every run sits at its true offset and the walk ends at centerWidth.
    let position = 0;
    let runIndex = 0;
    window.centerItems.forEach((item, index) => {
        if ((index % 2 === 0) !== (item.type === 'spacer')) {
            fail('center items do not alternate spacer and run');
        }
        if (item.type === 'spacer') {
            if (item.size < 0) {
                fail('negative spacer');
            }
            position += item.size;

            return;
        }
        const run = window.centerRuns[runIndex++];
        if (!run || run.start !== item.start || run.end !== item.end) {
            fail('center items and runs disagree');
        }
        const columns = layout.centerColumns(item);
        if (!near(position, columns[0]!.left, layout.centerWidth)) {
            fail(
                `run ${item.start}..${item.end} is placed at ${position}, its first column starts at ${columns[0]!.left}`
            );
        }
        position += columns.reduce((sum, column) => sum + column.width, 0);
    });
    if (runIndex !== window.centerRuns.length || window.centerItems[window.centerItems.length - 1]?.type !== 'spacer') {
        fail('center items do not end with a spacer after every run');
    }
    if (!near(position, layout.centerWidth, layout.centerWidth)) {
        fail(`center items sum to ${position}, expected ${layout.centerWidth}`);
    }

    // Visible, retained and keepMounted columns are mounted.
    const mounted = new Set(mountedCenter(layout, window).map((column) => column.colId));
    const visibleWidth = Math.max(viewportWidth - layout.leftWidth - layout.rightWidth, 0);
    for (const column of center) {
        const visible =
            column.left < scrollLeft + visibleWidth - EPSILON && column.left + column.width > scrollLeft + EPSILON;
        const spec = specs.find((candidate) => candidate.colId === column.colId)!;
        if (visible && !mounted.has(column.colId)) {
            fail(`visible column ${column.colId} is not mounted`);
        }
        if ((spec.keepMounted || retained.includes(column.colId)) && !mounted.has(column.colId)) {
            fail(`retained or keepMounted column ${column.colId} is not mounted`);
        }
    }

    // Bounded: the window plus overscan, plus retained and keepMounted columns.
    const narrowest = Math.min(...center.map((column) => column.width));
    if (narrowest > 0) {
        const kept = new Set([
            ...retained.filter((colId) => layout.getColumn(colId)?.section === 'center'),
            ...center
                .filter((column) => specs.find((spec) => spec.colId === column.colId)!.keepMounted)
                .map((column) => column.colId),
        ]);
        const bound = (visibleWidth + 2 * overscan) / narrowest + kept.size + 3;
        if (mounted.size > bound) {
            fail(`mounted ${mounted.size} center columns, bound ${bound}`);
        }
    }

    checkGroupRows(world, window);

    return window;
}

function checkGroupCells(
    cells: GroupHeaderCell[],
    columns: readonly LaidOutColumn[],
    depth: number,
    where: string
): void {
    const covered = cells.flatMap((cell) => cell.colIds);
    if (covered.join(',') !== columns.map((column) => column.colId).join(',')) {
        fail(
            `group row ${depth} ${where}: cells cover [${covered.join(',')}], columns are [${columns.map((column) => column.colId).join(',')}]`
        );
    }
    const byId = new Map(columns.map((column) => [column.colId, column]));
    const outerOf = (column: LaidOutColumn) =>
        Array.from({ length: depth }, (_, level) => column.groupPath[level] ?? '\u0000').join('/');
    let previous: { groupId: string | null; outer: string } | null = null;
    for (const cell of cells) {
        const cellColumns = cell.colIds.map((colId) => byId.get(colId)!);
        if (cell.depth !== depth) {
            fail(`group row ${depth} ${where}: cell has depth ${cell.depth}`);
        }
        if (cell.width !== cellColumns.reduce((sum, column) => sum + column.width, 0)) {
            fail(`group row ${depth} ${where}: cell ${cell.key} width ${cell.width} is not the sum of its columns`);
        }
        const outer = outerOf(cellColumns[0]!);
        for (const column of cellColumns) {
            if ((column.groupPath[depth] ?? null) !== cell.groupId || outerOf(column) !== outer) {
                fail(`group row ${depth} ${where}: column ${column.colId} does not belong to cell ${cell.key}`);
            }
        }
        if (previous && previous.groupId === cell.groupId && previous.outer === outer) {
            fail(`group row ${depth} ${where}: adjacent cells share group ${cell.groupId} and outer path ${outer}`);
        }
        previous = { groupId: cell.groupId, outer };
    }
}

function checkGroupRows(world: World, window: HorizontalWindow): void {
    const { layout } = world;
    const rows = layout.getGroupHeaderRows(window);
    if (rows.length !== layout.groupDepth) {
        fail(`${rows.length} group rows, groupDepth ${layout.groupDepth}`);
    }
    rows.forEach((row, depth) => {
        if (row.depth !== depth) {
            fail('group rows are not outermost first');
        }
        checkGroupCells(row.left, window.left, depth, 'left');
        checkGroupCells(row.right, window.right, depth, 'right');
        if (row.center.length !== window.centerItems.length) {
            fail(`group row ${depth} has ${row.center.length} center sections for ${window.centerItems.length} items`);
        }
        row.center.forEach((section, index) => {
            const item = window.centerItems[index]!;
            if (section.type === 'spacer') {
                if (item.type !== 'spacer' || item.size !== section.size) {
                    fail(`group row ${depth} spacer ${index} differs from the body`);
                }
            } else if (item.type !== 'run') {
                fail(`group row ${depth} has cells where the body has a spacer`);
            } else {
                checkGroupCells(section.cells, layout.centerColumns(item), depth, `run ${item.start}`);
            }
        });
    });
}

function checkScrollTo(world: World, colId: string, scrollLeft: number, viewportWidth: number): void {
    const { layout } = world;
    const column = layout.getColumn(colId);
    const target = layout.scrollLeftForColumn(colId, scrollLeft, viewportWidth);
    if (!column || column.section !== 'center') {
        if (target !== scrollLeft) {
            fail(`scrollLeftForColumn(${colId}) moved for a column that is not in the center`);
        }

        return;
    }
    const visibleWidth = Math.max(viewportWidth - layout.leftWidth - layout.rightWidth, 0);
    if (column.width > visibleWidth) {
        return;
    }
    const left = layout.getViewportLeft(colId, target, viewportWidth)!;
    if (
        left < layout.leftWidth - EPSILON ||
        left + column.width > layout.leftWidth + visibleWidth + EPSILON * Math.max(1, layout.totalWidth)
    ) {
        fail(
            `after scrollLeftForColumn(${colId}) = ${target}, the column is at ${left}..${left + column.width}, visible area ${layout.leftWidth}..${layout.leftWidth + visibleWidth}`
        );
    }
    const window = checkWindow(world, target, viewportWidth, 0, []);
    if (column.width > 0 && !mountedCenter(layout, window).some((mounted) => mounted.colId === colId)) {
        fail(`after scrollLeftForColumn(${colId}) the column is not mounted`);
    }
    // The browser clamps the scroll to its range; the column must stay fully visible there too.
    const clamped = Math.min(Math.max(target, 0), Math.max(layout.centerWidth - visibleWidth, 0));
    const clampedLeft = layout.getViewportLeft(colId, clamped, viewportWidth)!;
    if (
        clampedLeft < layout.leftWidth - EPSILON * Math.max(1, layout.totalWidth) ||
        clampedLeft + column.width > layout.leftWidth + visibleWidth + EPSILON * Math.max(1, layout.totalWidth)
    ) {
        fail(
            `after scrollLeftForColumn(${colId}) clamped to ${clamped}, the column is at ${clampedLeft}..${clampedLeft + column.width}`
        );
    }
}

function checkAll(world: World): void {
    checkWidths(world);
    checkSections(world);
    checkPositions(world, randomScroll(world.random, world.layout), world.viewport);
    checkWindow(world, randomScroll(world.random, world.layout), world.viewport, 300, []);
}

// Operations

function pickColId(world: World): string {
    const { random, specs } = world;
    if (specs.length === 0 || random.chance(0.1)) {
        return random.pick(['unknown', 'c999', 'n-1']);
    }

    return random.pick(specs).colId;
}

function runSequence(seed: number, length: number, known: KnownBugs): number {
    const random = createRandom(seed);
    const ids = { next: 0 };
    const specs = randomSpecs(random, ids);
    const viewport = randomViewport(random);
    const world: World = {
        random,
        layout: new ColumnLayout(specs, viewport),
        specs,
        viewport,
        resized: new Map(),
        known,
        log: [`new ColumnLayout(${JSON.stringify(specs)}, ${viewport})`],
    };
    let operations = 0;
    try {
        checkAll(world);
        for (let step = 0; step < length; step++) {
            const roll = random.int(0, 99);
            if (roll < 15) {
                const next = randomSpecs(random, ids);
                world.log.push(`setColumns(${JSON.stringify(next)})`);
                world.layout.setColumns(next);
                world.specs = next;
                const kept = new Set(next.map((spec) => spec.colId));
                [...world.resized.keys()]
                    .filter((colId) => !kept.has(colId))
                    .forEach((colId) => world.resized.delete(colId));
            } else if (roll < 30) {
                const width = randomViewport(random);
                world.log.push(`setViewportWidth(${width})`);
                world.layout.setViewportWidth(width);
                world.viewport = width;
            } else if (roll < 50) {
                const colId = pickColId(world);
                const spec = world.specs.find((candidate) => candidate.colId === colId);
                const width = random.pick([
                    0,
                    1,
                    5,
                    random.int(20, 600),
                    random.int(20, 600) + 0.5,
                    50_000,
                    spec ? minOf(spec) - 1 : 10,
                    spec?.maxWidth !== undefined ? spec.maxWidth + 10 : 900,
                ]);
                world.log.push(`resize(${JSON.stringify(colId)}, ${width})`);
                const applied = world.layout.resize(colId, width);
                if (spec) {
                    if (applied !== clampTo(width, spec)) {
                        fail(`resize returned ${applied}, expected ${clampTo(width, spec)}`);
                    }
                    world.resized.set(colId, applied);
                } else if (applied !== 0) {
                    fail(`resize of an unknown column returned ${applied}`);
                }
            } else if (roll < 58) {
                if (random.chance(0.4)) {
                    world.log.push('resetWidths()');
                    world.layout.resetWidths();
                    world.resized.clear();
                } else {
                    const colIds = Array.from({ length: random.int(0, 4) }, () => pickColId(world));
                    world.log.push(`resetWidths(${JSON.stringify(colIds)})`);
                    world.layout.resetWidths(colIds);
                    colIds.forEach((colId) => world.resized.delete(colId));
                }
            } else if (roll < 88) {
                const scrollLeft = randomScroll(random, world.layout);
                const viewportWidth = random.chance(0.5) ? world.viewport : randomViewport(random);
                const overscan = random.pick([0, 1, 50, 300, random.int(0, 1000)]);
                const retained = Array.from({ length: random.int(0, 3) }, () => pickColId(world));
                world.log.push(`getWindow(${scrollLeft}, ${viewportWidth}, ${overscan}, ${JSON.stringify(retained)})`);
                checkWindow(world, scrollLeft, viewportWidth, overscan, retained);
                checkPositions(world, scrollLeft, viewportWidth);
            } else {
                const colId = pickColId(world);
                const scrollLeft = randomScroll(random, world.layout);
                const viewportWidth = random.chance(0.6) ? world.viewport : randomViewport(random);
                world.log.push(`scrollLeftForColumn(${JSON.stringify(colId)}, ${scrollLeft}, ${viewportWidth})`);
                checkScrollTo(world, colId, scrollLeft, viewportWidth);
            }
            operations++;
            checkAll(world);
        }
    } catch (error) {
        throw new Error(
            `seed ${seed}: ${(error as Error).message}\n\nafter ${operations} operations:\n${world.log
                .slice(-4)
                .map((line) => (line.length > 600 ? `${line.slice(0, 600)}...` : line))
                .join('\n')}`,
            { cause: error }
        );
    }

    return operations;
}

describe('ColumnLayout property fuzz', () => {
    it(
        'holds over random operation sequences',
        () => {
            const sequences = Number(env.FUZZ_SEQUENCES ?? 300);
            const firstSeed = Number(env.FUZZ_SEED ?? 1);
            const length = Number(env.FUZZ_LENGTH ?? 25);
            const known: KnownBugs = { flexRounding: 0 };
            let operations = 0;
            for (let seed = firstSeed; seed < firstSeed + sequences; seed++) {
                operations += runSequence(seed, length, known);
            }
            expect(operations).toBe(sequences * length);
        },
        10_000 + Number(env.FUZZ_SEQUENCES ?? 0) * 10
    );
});

/**
 * Regression tests: minimal reproductions of the flex rounding bug the fuzz found while the layout was built.
 * Fixed by using exact flex shares.
 */
describe('ColumnLayout known bugs', () => {
    // The final flex pass floors every share and gives the remainder to the last flex column, without
    // checking min or max again. The share 100.67 is within max 101, so the column is not frozen, but it
    // ends up at 102, the rest of 302 after two floored 100s.
    it('keeps the last flex column within its maxWidth after rounding', () => {
        const layout = new ColumnLayout(
            [
                { colId: 'a', flex: 1 },
                { colId: 'b', flex: 1 },
                { colId: 'c', flex: 1, maxWidth: 101 },
            ],
            302
        );

        expect(layout.getColumn('c')!.width).toBeLessThanOrEqual(101);
    });

    // The same pass floors a share of 100.7 to 100, below a fractional minWidth of 100.5.
    it('keeps a flex column within a fractional minWidth after rounding', () => {
        const layout = new ColumnLayout(
            [
                { colId: 'a', flex: 1, minWidth: 100.5 },
                { colId: 'b', flex: 1 },
            ],
            201.4
        );

        expect(layout.getColumn('a')!.width).toBeGreaterThanOrEqual(100.5);
    });
});
