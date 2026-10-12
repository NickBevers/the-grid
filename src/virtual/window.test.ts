import { describe, expect, it } from 'vitest';

import { createColumnSections, computeColumnWindow } from './columnLayout';
import { HeightIndex } from './heightIndex';
import { identityMapping } from './identityMapping';
import { createScrollMapping } from './scrollMapping';
import { computeWindow, mergeRuns, type LayoutItem } from './window';

/** Physical start of every mounted index, derived by walking the items like the browser lays them out. */
function layoutPositions(items: LayoutItem[], sizes: HeightIndex): Map<number, number> {
    const positions = new Map<number, number>();
    let cursor = 0;
    for (const item of items) {
        if (item.type === 'spacer') {
            cursor += item.size;
            continue;
        }
        for (let index = item.start; index <= item.end; index++) {
            positions.set(index, cursor);
            cursor += sizes.get(index);
        }
    }

    return positions;
}

function totalSize(items: LayoutItem[], sizes: HeightIndex): number {
    return items.reduce(
        (sum, item) =>
            sum + (item.type === 'spacer' ? item.size : sizes.offsetOf(item.end + 1) - sizes.offsetOf(item.start)),
        0
    );
}

describe('computeWindow', () => {
    it('places every mounted row at its true offset when unscaled', () => {
        const sizes = new HeightIndex(10_000, 30);
        for (let row = 0; row < 10_000; row += 7) {
            sizes.set(row, 90);
        }
        const mapping = createScrollMapping(sizes.total, 600);
        const result = computeWindow({ sizes, mapping, scroll: 123_456, viewportSize: 600, overscan: 200 });

        const positions = layoutPositions(result.items, sizes);
        for (const [row, position] of positions) {
            expect(position).toBe(sizes.offsetOf(row));
        }
        expect(totalSize(result.items, sizes)).toBe(sizes.total);
        expect(result.firstVisible).toBe(sizes.indexAt(123_456));
    });

    it('mounts only the viewport plus overscan', () => {
        const sizes = new HeightIndex(100_000, 32);
        const mapping = createScrollMapping(sizes.total, 640);
        const result = computeWindow({ sizes, mapping, scroll: 1_000_000, viewportSize: 640, overscan: 320 });
        const mounted = result.runs.reduce((sum, run) => sum + run.end - run.start + 1, 0);

        expect(mounted).toBeLessThanOrEqual(Math.ceil((640 + 640) / 32) + 2);
        expect(result.lastVisible - result.firstVisible + 1).toBe(20);
    });

    it('keeps retained rows mounted as a separate run', () => {
        const sizes = new HeightIndex(1000, 20);
        const mapping = createScrollMapping(sizes.total, 400);
        const result = computeWindow({ sizes, mapping, scroll: 10_000, viewportSize: 400, overscan: 0, retained: [3] });

        expect(result.runs[0]).toEqual({ start: 3, end: 3 });
        expect(result.runs).toHaveLength(2);
        const positions = layoutPositions(result.items, sizes);
        expect(positions.get(3)).toBe(60);
        expect(positions.get(500)).toBe(10_000);
        expect(totalSize(result.items, sizes)).toBe(sizes.total);
    });

    it('keeps the scaled total at the physical cap and fills the viewport at both ends', () => {
        const sizes = new HeightIndex(1_000_000, 32);
        const mapping = createScrollMapping(sizes.total, 800, 10_000_000);
        expect(mapping.scaled).toBe(true);

        const top = computeWindow({ sizes, mapping, scroll: 0, viewportSize: 800, overscan: 0 });
        expect(top.firstVisible).toBe(0);
        expect(totalSize(top.items, sizes)).toBe(10_000_000);

        const bottomScroll = 10_000_000 - 800;
        const bottom = computeWindow({ sizes, mapping, scroll: bottomScroll, viewportSize: 800, overscan: 0 });
        expect(bottom.lastVisible).toBe(999_999);
        const positions = layoutPositions(bottom.items, sizes);
        expect(positions.get(999_999)! + 32).toBeCloseTo(10_000_000, 3);
        expect(positions.get(bottom.firstVisible)!).toBeLessThanOrEqual(bottomScroll);
    });

    it('pins the first visible row under the viewport top while scaled', () => {
        const sizes = new HeightIndex(1_000_000, 32);
        const mapping = createScrollMapping(sizes.total, 800, 10_000_000);
        const scroll = 4_321_000;
        const result = computeWindow({ sizes, mapping, scroll, viewportSize: 800, overscan: 400 });
        const positions = layoutPositions(result.items, sizes);
        const virtualTop = mapping.toVirtual(scroll);
        const expected = scroll - (virtualTop - sizes.offsetOf(result.firstVisible));

        expect(positions.get(result.firstVisible)).toBeCloseTo(expected, 6);
    });

    it('returns a single spacer when empty', () => {
        const sizes = new HeightIndex(0, 32);
        const result = computeWindow({ sizes, mapping: identityMapping(0), scroll: 0, viewportSize: 500, overscan: 0 });

        expect(result.runs).toEqual([]);
        expect(result.firstVisible).toBe(-1);
    });
});

describe('mergeRuns', () => {
    it('merges overlapping and adjacent runs', () => {
        expect(
            mergeRuns([
                { start: 10, end: 20 },
                { start: 21, end: 21 },
                { start: 2, end: 2 },
                { start: 15, end: 30 },
            ])
        ).toEqual([
            { start: 2, end: 2 },
            { start: 10, end: 30 },
        ]);
    });
});

describe('computeColumnWindow', () => {
    const columns = Array.from({ length: 100 }, (_, index) => ({
        colId: `c${index}`,
        width: 100 + (index % 5) * 20,
        pinned: index === 0 ? ('left' as const) : index === 99 ? ('right' as const) : null,
    }));
    const sections = createColumnSections(columns);

    it('splits pinned sections and sums widths', () => {
        expect(sections.left).toHaveLength(1);
        expect(sections.right).toHaveLength(1);
        expect(sections.center).toHaveLength(98);
        expect(sections.totalWidth).toBe(columns.reduce((sum, column) => sum + column.width, 0));
    });

    it('mounts only center columns near the viewport', () => {
        const result = computeColumnWindow(sections, 3000, 1200, 200);
        const mounted = result.runs.reduce((sum, run) => sum + run.end - run.start + 1, 0);

        expect(mounted).toBeLessThan(15);
        expect(sections.centerSizes.offsetOf(result.firstVisible)).toBeLessThanOrEqual(3000);
    });

    it('keeps a retained column mounted', () => {
        const result = computeColumnWindow(sections, 5000, 1200, 0, [2]);

        expect(result.runs[0]).toEqual({ start: 2, end: 2 });
    });
});
