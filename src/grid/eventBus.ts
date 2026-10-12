/**
 * Typed event bus implementing the dispatch rules in `contract/events.ts`:
 * - listeners run synchronously in the order they were added,
 * - a listener added or removed during a dispatch takes effect from the next dispatch,
 * - an error in one listener does not stop the others (it is reported after they ran),
 * - after `destroy`, `on` and `emit` are no-ops and removing a listener is always safe.
 */
export class EventBus<TMap extends Record<string, unknown>> {
    #listeners = new Map<keyof TMap, Set<(event: never) => void>>();
    #destroyed = false;

    on<TName extends keyof TMap>(name: TName, listener: (event: TMap[TName]) => void): () => void {
        if (this.#destroyed) {
            return () => {};
        }
        let set = this.#listeners.get(name);
        if (!set) {
            set = new Set();
            this.#listeners.set(name, set);
        }
        // Copy on write, so a dispatch in progress keeps iterating the set it started with.
        const next = new Set(set);
        next.add(listener as (event: never) => void);
        this.#listeners.set(name, next);

        return () => this.off(name, listener);
    }

    off<TName extends keyof TMap>(name: TName, listener: (event: TMap[TName]) => void): void {
        const set = this.#listeners.get(name);
        if (!set?.has(listener as (event: never) => void)) {
            return;
        }
        const next = new Set(set);
        next.delete(listener as (event: never) => void);
        this.#listeners.set(name, next);
    }

    emit<TName extends keyof TMap>(name: TName, event: TMap[TName]): void {
        if (this.#destroyed) {
            return;
        }
        const set = this.#listeners.get(name);
        if (!set || set.size === 0) {
            return;
        }
        const errors: unknown[] = [];
        for (const listener of set) {
            try {
                (listener as (event: TMap[TName]) => void)(event);
            } catch (error) {
                errors.push(error);
            }
        }
        if (errors.length === 1) {
            throw errors[0];
        }
        if (errors.length > 1) {
            throw new AggregateError(errors, `${errors.length} listeners for "${String(name)}" failed`);
        }
    }

    listenerCount(name: keyof TMap): number {
        return this.#listeners.get(name)?.size ?? 0;
    }

    destroy(): void {
        this.#destroyed = true;
        this.#listeners.clear();
    }

    get destroyed(): boolean {
        return this.#destroyed;
    }
}
