/**
 * Which rows (or columns) to mount, and the spacer sizes that keep them in normal document flow.
 *
 * The output is an ordered list of items: spacers and runs of consecutive indexes. Rendering the items
 * top to bottom as ordinary block elements places every mounted row at its correct offset without absolute
 * positioning or transforms. Retained indexes (the focused or editing row) stay mounted outside the window
 * as their own run between spacers, so DOM focus and editor state survive scrolling away.
 */
import type { ScrollMapping } from './scrollMapping';

export type IndexRun = { start: number; end: number };

export type LayoutItem = { type: 'spacer'; size: number } | { type: 'run'; start: number; end: number };

export type Sizes = {
    readonly count: number;
    offsetOf(index: number): number;
    indexAt(offset: number): number;
};

export type WindowInput = {
    sizes: Sizes;
    mapping: ScrollMapping;
    /** Physical scroll offset along this axis. */
    scroll: number;
    viewportSize: number;
    /** Extra pixels mounted before and after the viewport. */
    overscan: number;
    /** Indexes kept mounted even when outside the window. */
    retained?: Iterable<number>;
};

export type WindowResult = {
    /** First and last index intersecting the viewport. -1 when empty. */
    firstVisible: number;
    lastVisible: number;
    /** Mounted runs, sorted and merged. */
    runs: IndexRun[];
    items: LayoutItem[];
};

export function computeWindow({ sizes, mapping, scroll, viewportSize, overscan, retained }: WindowInput): WindowResult {
    if (sizes.count === 0) {
        return { firstVisible: -1, lastVisible: -1, runs: [], items: [{ type: 'spacer', size: 0 }] };
    }

    const virtualTop = mapping.toVirtual(scroll);
    const virtualBottom = virtualTop + viewportSize;
    const firstVisible = sizes.indexAt(virtualTop);
    const lastVisible = lastIndexBefore(sizes, virtualBottom);
    const heightOf = (start: number, end: number) => sizes.offsetOf(end + 1) - sizes.offsetOf(start);

    // Scaled, rows keep their real heights but the scroll range is compressed, so near the ends there is
    // less physical room than virtual distance. Overscan is limited to the physical room above and below
    // the viewport, otherwise rows would not fit and the visible ones would be pushed off their places.
    const roomAbove = mapping.scaled ? Math.min(overscan, Math.max(scroll, 0)) : overscan;
    const roomBelow = mapping.scaled
        ? Math.min(overscan, Math.max(mapping.physicalTotal - scroll - viewportSize, 0))
        : overscan;
    let firstMounted = sizes.indexAt(virtualTop - roomAbove);
    if (mapping.scaled && firstMounted < firstVisible && sizes.offsetOf(firstMounted) < virtualTop - roomAbove) {
        firstMounted++;
    }
    let lastMounted = lastIndexBefore(sizes, virtualBottom + roomBelow);
    if (mapping.scaled && lastMounted > lastVisible && sizes.offsetOf(lastMounted + 1) > virtualBottom + roomBelow) {
        lastMounted--;
    }

    // Trimming never empties the window: the first visible row always stays mounted.
    firstMounted = Math.min(firstMounted, firstVisible);
    lastMounted = Math.max(lastMounted, firstVisible, firstMounted);
    const main: IndexRun = { start: firstMounted, end: lastMounted };
    const extra = [...(retained ?? [])]
        .filter((index) => index >= 0 && index < sizes.count)
        .map((index) => ({ start: index, end: index }));
    const runs = mergeRuns([main, ...extra]);
    const mainRun = runs.findIndex((run) => run.start <= main.start && run.end >= main.start);

    // The main window is pinned to the viewport: its first row sits where the scaled scroll says it should.
    // Within the physical range it must fit, so it is clamped at the two ends of a scaled range.
    const starts = new Array<number>(runs.length);
    const mainContaining = runs[mainRun]!;
    let mainStart =
        scroll -
        (virtualTop - sizes.offsetOf(main.start)) -
        (sizes.offsetOf(main.start) - sizes.offsetOf(mainContaining.start));
    if (mapping.scaled) {
        mainStart = Math.min(
            Math.max(mainStart, 0),
            mapping.physicalTotal - heightOf(mainContaining.start, mainContaining.end)
        );
    }
    // Other runs (retained rows) sit where the mapping puts them, but never overlap and never leave the
    // physical range. Runs below the main run go after it; only when they would run past the end of the
    // range are they packed back up, moving the main run up as far as needed (possible only at the very
    // end of a scaled range). Runs above the main run are then packed upward from it.
    const mainHeight = heightOf(mainContaining.start, mainContaining.end);
    starts[mainRun] = mainStart;
    let cursor = mainStart + mainHeight;
    for (let index = mainRun + 1; index < runs.length; index++) {
        const run = runs[index]!;
        starts[index] = Math.max(cursor, mapping.toPhysical(sizes.offsetOf(run.start)));
        cursor = starts[index]! + heightOf(run.start, run.end);
    }
    if (cursor > mapping.physicalTotal) {
        let floor = mapping.physicalTotal;
        for (let index = runs.length - 1; index > mainRun; index--) {
            const run = runs[index]!;
            starts[index] = Math.min(starts[index]!, floor - heightOf(run.start, run.end));
            floor = starts[index]!;
        }
        starts[mainRun] = Math.max(Math.min(mainStart, floor - mainHeight), 0);
    }
    let limit = starts[mainRun]!;
    for (let index = mainRun - 1; index >= 0; index--) {
        const run = runs[index]!;
        const height = heightOf(run.start, run.end);
        starts[index] = Math.max(Math.min(mapping.toPhysical(sizes.offsetOf(run.start)), limit - height), 0);
        limit = starts[index]!;
    }

    const items: LayoutItem[] = [];
    let end = 0;
    runs.forEach((run, index) => {
        items.push({ type: 'spacer', size: Math.max(0, starts[index]! - end) });
        items.push({ type: 'run', start: run.start, end: run.end });
        end = Math.max(end, starts[index]!) + heightOf(run.start, run.end);
    });
    items.push({ type: 'spacer', size: Math.max(0, mapping.physicalTotal - end) });

    return { firstVisible, lastVisible, runs, items };
}

/** The last index whose start is before `offset`, so a row that begins exactly at the edge is excluded. */
function lastIndexBefore(sizes: Sizes, offset: number): number {
    const index = sizes.indexAt(offset);

    return index > 0 && sizes.offsetOf(index) >= offset ? index - 1 : index;
}

export function mergeRuns(runs: IndexRun[]): IndexRun[] {
    const sorted = [...runs].sort((a, b) => a.start - b.start);
    const merged: IndexRun[] = [];
    for (const run of sorted) {
        const last = merged[merged.length - 1];
        if (last && run.start <= last.end + 1) {
            last.end = Math.max(last.end, run.end);
        } else {
            merged.push({ ...run });
        }
    }

    return merged;
}
