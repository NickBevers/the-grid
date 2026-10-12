/**
 * A reported 1,000,000-row remote source served in 100-row blocks by a fake server with latency.
 *
 * The block manager requests only missing blocks for the mounted range, never requests a block twice while
 * it is pending, evicts least recently used blocks, and aborts and ignores responses from earlier query
 * generations. Counters let the checks detect request storms.
 */
import type { PrototypeRow } from './types';

export const REMOTE_ROW_COUNT = 1_000_000;
export const BLOCK_SIZE = 100;
const MAX_BLOCKS = 40;

export type RemoteStats = {
    requested: number;
    completed: number;
    aborted: number;
    staleIgnored: number;
    duplicateRequests: number;
    cachedBlocks: number;
};

type Block = { rows: BackendRow[]; lastUsed: number };

export class RemoteBlockSource {
    readonly stats: RemoteStats = {
        requested: 0,
        completed: 0,
        aborted: 0,
        staleIgnored: 0,
        duplicateRequests: 0,
        cachedBlocks: 0,
    };
    readonly requestLog: { generation: number; block: number }[] = [];
    #blocks = new Map<number, Block>();
    #pending = new Map<number, AbortController>();
    #generation = 0;
    #query = '';
    #clock = 0;
    #listeners = new Set<() => void>();

    get generation(): number {
        return this.#generation;
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);

        return () => this.#listeners.delete(listener);
    }

    /** A new query invalidates everything: pending requests are aborted and cached blocks dropped. */
    setQuery(query: string): void {
        this.#query = query;
        this.#generation++;
        for (const controller of this.#pending.values()) {
            controller.abort();
            this.stats.aborted++;
        }
        this.#pending.clear();
        this.#blocks.clear();
        this.stats.cachedBlocks = 0;
        this.#emit();
    }

    getRow(index: number): PrototypeRow {
        const block = this.#blocks.get(Math.floor(index / BLOCK_SIZE));
        const row = block?.rows[index % BLOCK_SIZE];
        if (!block || !row) {
            return { kind: 'loading', id: `loading:${this.#generation}:${index}` };
        }
        block.lastUsed = ++this.#clock;

        return { kind: 'data', id: row.id };
    }

    getLabel(index: number): string | undefined {
        return this.#blocks.get(Math.floor(index / BLOCK_SIZE))?.rows[index % BLOCK_SIZE]?.label;
    }

    /** Requests the blocks covering the mounted range that are neither cached nor pending. */
    ensureRange(first: number, last: number): void {
        const firstBlock = Math.floor(Math.max(first, 0) / BLOCK_SIZE);
        const lastBlock = Math.floor(Math.min(last, REMOTE_ROW_COUNT - 1) / BLOCK_SIZE);
        for (let block = firstBlock; block <= lastBlock; block++) {
            if (this.#blocks.has(block)) {
                this.#blocks.get(block)!.lastUsed = ++this.#clock;
                continue;
            }
            if (this.#pending.has(block)) {
                continue;
            }
            this.#request(block);
        }
        // Blocks far outside the mounted range are no longer needed; abort them to free the connection.
        for (const [block, controller] of this.#pending) {
            if (block < firstBlock - 2 || block > lastBlock + 2) {
                controller.abort();
                this.#pending.delete(block);
                this.stats.aborted++;
            }
        }
    }

    #request(block: number): void {
        const generation = this.#generation;
        const controller = new AbortController();
        this.#pending.set(block, controller);
        this.stats.requested++;
        if (this.requestLog.some((entry) => entry.generation === generation && entry.block === block)) {
            this.stats.duplicateRequests++;
        }
        this.requestLog.push({ generation, block });

        const query = this.#query;
        fakeBackend.fetchRows(block * BLOCK_SIZE, (block + 1) * BLOCK_SIZE, query, controller.signal).then(
            (rows) => {
                if (generation !== this.#generation) {
                    this.stats.staleIgnored++;
                    return;
                }
                this.#pending.delete(block);
                this.#blocks.set(block, { rows, lastUsed: ++this.#clock });
                this.stats.completed++;
                this.#evict();
                this.#emit();
            },
            () => {
                // Aborted. Counted where the abort happened.
            }
        );
    }

    #evict(): void {
        while (this.#blocks.size > MAX_BLOCKS) {
            let oldest: number | null = null;
            let oldestUse = Infinity;
            for (const [block, value] of this.#blocks) {
                if (value.lastUsed < oldestUse) {
                    oldestUse = value.lastUsed;
                    oldest = block;
                }
            }
            this.#blocks.delete(oldest!);
        }
        this.stats.cachedBlocks = this.#blocks.size;
    }

    #emit(): void {
        for (const listener of this.#listeners) {
            listener();
        }
    }
}

export type BackendRow = { id: string; label: string };

/**
 * A fake backend with fixed latency and payload, and one request counter, so request counts compare
 * directly between runs.
 */
export const fakeBackend = {
    requests: 0,
    latency: 120,
    fetchRows(startRow: number, endRow: number, query: string, signal?: AbortSignal): Promise<BackendRow[]> {
        this.requests++;
        const latency = this.latency + (Math.floor(startRow / BLOCK_SIZE) % 3) * 20;

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const end = Math.min(endRow, REMOTE_ROW_COUNT);
                resolve(
                    Array.from({ length: Math.max(end - startRow, 0) }, (_, offset) => ({
                        id: `${query}:${startRow + offset}`,
                        label: `${query ? `${query} ` : ''}Person ${startRow + offset}`,
                    }))
                );
            }, latency);
            signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new DOMException('Aborted', 'AbortError'));
            });
        });
    },
};
