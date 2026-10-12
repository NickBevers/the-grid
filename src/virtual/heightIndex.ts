/**
 * Row heights with O(log n) index to offset lookups.
 *
 * Unmeasured rows use an estimate. Measured rows keep their measured height until reset. Backed by a
 * Fenwick (binary indexed) tree over the heights, so updating one row and finding the row at an offset are
 * both O(log n), and memory is two Float64Arrays regardless of how many rows are mounted.
 */
export class HeightIndex {
    #count = 0;
    #estimate: number;
    #heights = new Float64Array(0);
    #measured = new Uint8Array(0);
    #tree = new Float64Array(1);
    #highestPowerOfTwo = 1;

    constructor(count: number, estimate: number) {
        this.#estimate = estimate;
        this.setCount(count);
    }

    get count(): number {
        return this.#count;
    }

    get estimate(): number {
        return this.#estimate;
    }

    get total(): number {
        return this.offsetOf(this.#count);
    }

    /** Resizes the index. Heights of rows that remain keep their values. O(n). */
    setCount(count: number): void {
        const heights = new Float64Array(count);
        const measured = new Uint8Array(count);
        const kept = Math.min(count, this.#count);
        heights.set(this.#heights.subarray(0, kept));
        measured.set(this.#measured.subarray(0, kept));
        heights.fill(this.#estimate, kept);

        this.#count = count;
        this.#heights = heights;
        this.#measured = measured;
        this.#rebuild();
    }

    /**
     * Replaces every height at once, e.g. after rows were inserted, removed or reordered and measurements
     * are looked up by row id. `undefined` means unmeasured. O(n).
     */
    load(count: number, heightAt: (index: number) => number | undefined): void {
        this.#count = count;
        this.#heights = new Float64Array(count);
        this.#measured = new Uint8Array(count);
        for (let index = 0; index < count; index++) {
            const height = heightAt(index);
            this.#heights[index] = height ?? this.#estimate;
            this.#measured[index] = height === undefined ? 0 : 1;
        }
        this.#rebuild();
    }

    /** Changes the estimate used for unmeasured rows. O(n). */
    setEstimate(estimate: number): void {
        this.#estimate = estimate;
        for (let index = 0; index < this.#count; index++) {
            if (!this.#measured[index]) {
                this.#heights[index] = estimate;
            }
        }
        this.#rebuild();
    }

    get(index: number): number {
        return this.#heights[index] ?? this.#estimate;
    }

    isMeasured(index: number): boolean {
        return this.#measured[index] === 1;
    }

    /** Records a measured height. Returns the change in pixels (0 when unchanged). */
    set(index: number, height: number): number {
        if (index < 0 || index >= this.#count) {
            return 0;
        }
        this.#measured[index] = 1;
        const delta = height - this.#heights[index]!;
        if (delta === 0) {
            return 0;
        }
        this.#heights[index] = height;
        for (let node = index + 1; node <= this.#count; node += node & -node) {
            this.#tree[node]! += delta;
        }

        return delta;
    }

    /** Forgets measurements so the rows use the estimate again. With no argument, every row. */
    reset(indexes?: Iterable<number>): void {
        if (!indexes) {
            this.#heights.fill(this.#estimate);
            this.#measured.fill(0);
            this.#rebuild();
            return;
        }
        for (const index of indexes) {
            if (index >= 0 && index < this.#count) {
                this.set(index, this.#estimate);
                this.#measured[index] = 0;
            }
        }
    }

    /** Sum of heights of rows before `index`. `offsetOf(count)` is the total height. */
    offsetOf(index: number): number {
        let sum = 0;
        for (let node = Math.min(Math.max(index, 0), this.#count); node > 0; node -= node & -node) {
            sum += this.#tree[node]!;
        }

        return sum;
    }

    /**
     * The row containing `offset`: the largest index whose start is at or before it. Offsets past the end
     * return the last row. Returns -1 when there are no rows.
     */
    indexAt(offset: number): number {
        if (this.#count === 0) {
            return -1;
        }
        if (offset <= 0) {
            return 0;
        }
        let position = 0;
        let remaining = offset;
        for (let step = this.#highestPowerOfTwo; step > 0; step >>= 1) {
            const next = position + step;
            if (next <= this.#count && this.#tree[next]! <= remaining) {
                position = next;
                remaining -= this.#tree[next]!;
            }
        }

        return Math.min(position, this.#count - 1);
    }

    #rebuild(): void {
        const tree = new Float64Array(this.#count + 1);
        for (let index = 0; index < this.#count; index++) {
            const node = index + 1;
            tree[node]! += this.#heights[index]!;
            const parent = node + (node & -node);
            if (parent <= this.#count) {
                tree[parent]! += tree[node]!;
            }
        }
        this.#tree = tree;
        let power = 1;
        while (power * 2 <= this.#count) {
            power *= 2;
        }
        this.#highestPowerOfTwo = power;
    }
}
