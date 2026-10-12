/**
 * React hooks for filter UIs, on the headless helpers in `filters/ui.ts`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { GridApi } from '../contract/api';
import { selectedFirst, type SetChoice, type SetChoicesSource } from '../filters/ui';

export type SetFilterChoicesState = {
    /** Selected choices first (with their labels resolved), then the matches for the text. */
    choices: SetChoice[];
    loading: boolean;
    error: unknown;
};

/**
 * A set filter's choices for the typed `text`: searched `debounceMs` after typing stops (200 ms by
 * default; the first search runs at once), with the previous search cancelled. Selected values a search
 * did not return are resolved once through `source.resolve` and remembered, so their labels always show.
 */
export function useSetFilterChoices(
    source: SetChoicesSource,
    text: string,
    selected: readonly (string | null)[],
    options: { debounceMs?: number } = {}
): SetFilterChoicesState {
    const debounceMs = options.debounceMs ?? 200;
    const [results, setResults] = useState<SetChoice[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<unknown>(null);
    const known = useRef(new Map<string | null, SetChoice>());
    const [knownVersion, setKnownVersion] = useState(0);
    const first = useRef(true);

    useEffect(() => {
        const controller = new AbortController();
        const run = () => {
            setLoading(true);
            source.search(text, controller.signal).then(
                (choices) => {
                    if (controller.signal.aborted) {
                        return;
                    }
                    for (const choice of choices) {
                        known.current.set(choice.value, choice);
                    }
                    setResults(choices);
                    setError(null);
                    setLoading(false);
                },
                (reason: unknown) => {
                    if (!controller.signal.aborted) {
                        setError(reason);
                        setLoading(false);
                    }
                }
            );
        };
        const delay = first.current ? 0 : debounceMs;
        first.current = false;
        const timer = setTimeout(run, delay);

        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [source, text, debounceMs]);

    const selectedKey = selected.map(String).join('\u0000');
    useEffect(() => {
        const missing = selected.filter((value): value is string => value !== null && !known.current.has(value));
        if (missing.length === 0 || !source.resolve) {
            return;
        }
        const controller = new AbortController();
        source.resolve(missing, controller.signal).then(
            (choices) => {
                if (controller.signal.aborted) {
                    return;
                }
                for (const choice of choices) {
                    known.current.set(choice.value, choice);
                }
                // Values the source no longer knows still show, as themselves.
                for (const value of missing) {
                    if (!known.current.has(value)) {
                        known.current.set(value, { value, label: value });
                    }
                }
                setKnownVersion((version) => version + 1);
            },
            () => undefined
        );

        return () => controller.abort();
    }, [source, selectedKey]);

    void knownVersion;
    const selectedChoices = selected
        .map((value) => known.current.get(value))
        .filter((choice): choice is SetChoice => Boolean(choice));
    const merged = [...selectedChoices, ...results.filter((choice) => !selected.includes(choice.value))];

    return { choices: selectedFirst(merged, selected), loading, error };
}

export type GridSearchState = {
    /** The text as typed. */
    value: string;
    setValue(value: string): void;
    /** Applies the typed text now, skipping the wait (for Enter). */
    applyNow(): void;
};

/**
 * A search box for the grid: the typed text reaches `api.setSearch` `delayMs` after typing stops (500 ms
 * by default), or at once with `applyNow`.
 */
export function useGridSearch<TData>(
    api: GridApi<TData> | null,
    options: { delayMs?: number; initial?: string } = {}
): GridSearchState {
    const delayMs = options.delayMs ?? 500;
    const [value, setValueState] = useState(options.initial ?? '');
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const latest = useRef(value);
    const apiRef = useRef(api);
    apiRef.current = api;

    const clear = () => {
        if (timer.current !== null) {
            clearTimeout(timer.current);
            timer.current = null;
        }
    };
    useEffect(() => clear, []);

    const setValue = useCallback(
        (next: string) => {
            latest.current = next;
            setValueState(next);
            clear();
            timer.current = setTimeout(() => {
                timer.current = null;
                apiRef.current?.setSearch(latest.current);
            }, delayMs);
        },
        [delayMs]
    );
    const applyNow = useCallback(() => {
        clear();
        apiRef.current?.setSearch(latest.current);
    }, []);

    return { value, setValue, applyNow };
}
