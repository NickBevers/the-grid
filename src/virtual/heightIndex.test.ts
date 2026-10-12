import { describe, expect, it } from 'vitest';

import { HeightIndex } from './heightIndex';

function seededRandom(seed: number): () => number {
    let state = seed;

    return () => {
        state = (state * 1664525 + 1013904223) % 4294967296;

        return state / 4294967296;
    };
}

describe('HeightIndex', () => {
    it('uses the estimate for unmeasured rows', () => {
        const index = new HeightIndex(1000, 32);

        expect(index.total).toBe(32_000);
        expect(index.offsetOf(10)).toBe(320);
        expect(index.indexAt(319)).toBe(9);
        expect(index.indexAt(320)).toBe(10);
        expect(index.isMeasured(10)).toBe(false);
    });

    it('matches brute force sums after random measurements', () => {
        const random = seededRandom(7);
        const count = 5000;
        const index = new HeightIndex(count, 30);
        const heights = new Array<number>(count).fill(30);

        for (let i = 0; i < 3000; i++) {
            const row = Math.floor(random() * count);
            const height = 20 + Math.floor(random() * 200);
            index.set(row, height);
            heights[row] = height;
        }

        let offset = 0;
        for (let row = 0; row < count; row++) {
            expect(index.offsetOf(row)).toBe(offset);
            expect(index.indexAt(offset)).toBe(row);
            expect(index.indexAt(offset + heights[row]! - 0.5)).toBe(row);
            offset += heights[row]!;
        }
        expect(index.total).toBe(offset);
    });

    it('clamps offsets outside the content', () => {
        const index = new HeightIndex(10, 10);

        expect(index.indexAt(-50)).toBe(0);
        expect(index.indexAt(10_000)).toBe(9);
        expect(new HeightIndex(0, 10).indexAt(5)).toBe(-1);
    });

    it('returns the delta when a measurement changes', () => {
        const index = new HeightIndex(3, 20);

        expect(index.set(1, 50)).toBe(30);
        expect(index.set(1, 50)).toBe(0);
        expect(index.set(1, 40)).toBe(-10);
        expect(index.total).toBe(80);
    });

    it('keeps measurements when the count changes', () => {
        const index = new HeightIndex(5, 10);
        index.set(2, 100);
        index.setCount(8);

        expect(index.get(2)).toBe(100);
        expect(index.get(7)).toBe(10);
        expect(index.total).toBe(170);

        index.setCount(2);
        expect(index.total).toBe(20);
    });

    it('resets rows to the estimate', () => {
        const index = new HeightIndex(4, 10);
        index.set(0, 50);
        index.set(3, 70);
        index.reset([0]);

        expect(index.get(0)).toBe(10);
        expect(index.isMeasured(0)).toBe(false);
        expect(index.total).toBe(100);

        index.reset();
        expect(index.total).toBe(40);
    });

    it('loads heights looked up by row id after a structural change', () => {
        const index = new HeightIndex(3, 10);
        const measuredById = new Map([
            ['b', 40],
            ['d', 70],
        ]);
        const ids = ['a', 'b', 'c', 'd'];
        index.load(ids.length, (row) => measuredById.get(ids[row]!));

        expect(index.count).toBe(4);
        expect(index.total).toBe(10 + 40 + 10 + 70);
        expect(index.isMeasured(1)).toBe(true);
        expect(index.isMeasured(2)).toBe(false);
        expect(index.indexAt(60)).toBe(3);
    });

    it('handles a million rows', () => {
        const index = new HeightIndex(1_000_000, 32);
        index.set(999_999, 64);

        expect(index.total).toBe(32_000_032);
        expect(index.indexAt(31_999_968)).toBe(999_999);
    });
});
