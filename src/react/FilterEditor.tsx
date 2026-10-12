/**
 * The default filter editor inside the filter panel: one editor per built-in kind, on the headless helpers
 * in `filters/ui.ts`. Text, number and date take up to `filterParams.maxNumConditions` conditions (default
 * 2) joined by AND or OR. Set filters choose values from a searchable list, `anyOf` or
 * `noneOf`. Booleans choose yes or no. An application replaces the editor per kind (`filterEditors`) or
 * the whole panel (`renderFilterPanel`).
 */
import { useState } from 'react';

import type { FilterEditorProps } from '../contract';
import {
    defaultCondition,
    filterOperators,
    formatFilterDate,
    isConditionApplicable,
    parseFilterDate,
} from '../filters/ui';
import { useSetFilterChoices } from './filterHooks';

type Condition = Record<string, unknown> & { filterType: string; type?: string };

export function DefaultFilterEditor<TData>(props: FilterEditorProps<TData>) {
    if (props.kind === 'set') {
        return <SetFilterEditor {...props} />;
    }
    if (props.kind === 'boolean') {
        return <BooleanFilterEditor {...props} />;
    }

    return <ConditionsFilterEditor {...props} />;
}

/** Text, number and date: conditions joined by AND or OR. */
function ConditionsFilterEditor<TData>({ column, kind, condition, onChange }: FilterEditorProps<TData>) {
    const filterParams = (column.def.filterParams ?? {}) as Record<string, unknown>;
    const max = Math.max(1, Number(filterParams.maxNumConditions ?? 2));
    const fresh = () => defaultCondition(kind, filterParams) as Condition;
    const [state, setState] = useState<{ join: 'AND' | 'OR'; conditions: Condition[] }>(() => {
        const children = (condition as { conditions?: Condition[]; operator?: 'AND' | 'OR' } | null)?.conditions;
        if (Array.isArray(children)) {
            return { join: (condition as { operator: 'AND' | 'OR' }).operator, conditions: children.slice(0, max) };
        }

        return { join: 'AND', conditions: [condition ? (condition as Condition) : fresh()] };
    });
    const operators = filterOperators(kind, filterParams);

    const update = (next: { join: 'AND' | 'OR'; conditions: Condition[] }) => {
        setState(next);
        const applicable = next.conditions.filter((entry) => isConditionApplicable(entry as never, filterParams));
        onChange(
            applicable.length === 0
                ? null
                : applicable.length === 1
                  ? applicable[0]!
                  : { filterType: kind, operator: next.join, conditions: applicable }
        );
    };
    const setAt = (index: number, entry: Condition) =>
        update({ ...state, conditions: state.conditions.map((existing, at) => (at === index ? entry : existing)) });
    // A further condition is offered once the last one applies, up to the maximum.
    const shown =
        state.conditions.length < max && isConditionApplicable(state.conditions.at(-1) as never, filterParams)
            ? [...state.conditions, fresh()]
            : state.conditions;

    return (
        <div data-grid-part="filter-editor" data-filter-kind={kind}>
            {shown.map((entry, index) => (
                <div key={index} data-grid-part="filter-condition">
                    {index > 0 ? (
                        <div data-grid-part="filter-join" role="radiogroup" aria-label="Join conditions">
                            {(['AND', 'OR'] as const).map((join) => (
                                <label key={join}>
                                    <input
                                        type="radio"
                                        name={`join-${column.colId}`}
                                        checked={state.join === join}
                                        onChange={() => update({ ...state, join })}
                                    />
                                    {join === 'AND' ? 'And' : 'Or'}
                                </label>
                            ))}
                        </div>
                    ) : null}
                    <ConditionRow
                        kind={kind}
                        condition={entry}
                        operators={operators}
                        onChange={(next) =>
                            index < state.conditions.length
                                ? setAt(index, next)
                                : update({ ...state, conditions: [...state.conditions, next] })
                        }
                    />
                </div>
            ))}
            <ClearButton onClear={() => update({ join: 'AND', conditions: [fresh()] })} />
        </div>
    );
}

function ConditionRow({
    kind,
    condition,
    operators,
    onChange,
}: {
    kind: string;
    condition: Condition;
    operators: ReturnType<typeof filterOperators>;
    onChange: (condition: Condition) => void;
}) {
    const operator = operators.find((entry) => entry.key === condition.type) ?? operators[0];
    const inputs = operator?.inputs ?? 1;
    const keys = kind === 'date' ? (['dateFrom', 'dateTo'] as const) : (['filter', 'filterTo'] as const);

    return (
        <>
            <select
                data-grid-part="filter-operator"
                aria-label="Operator"
                value={operator?.key}
                onChange={(event) => onChange({ ...condition, type: event.target.value })}
            >
                {operators.map((entry) => (
                    <option key={entry.key} value={entry.key}>
                        {entry.label}
                    </option>
                ))}
            </select>
            {keys.slice(0, inputs).map((key, index) => (
                <input
                    key={key}
                    data-grid-part="filter-input"
                    aria-label={index === 0 ? (inputs === 2 ? 'From' : 'Value') : 'To'}
                    placeholder={index === 0 ? (inputs === 2 ? 'From' : 'Filter…') : 'To'}
                    type={kind === 'number' ? 'number' : kind === 'date' ? 'date' : 'text'}
                    value={inputValue(kind, condition[key])}
                    onChange={(event) => onChange({ ...condition, [key]: parseInput(kind, event.target.value) })}
                />
            ))}
        </>
    );
}

function inputValue(kind: string, value: unknown): string {
    if (value === null || value === undefined) {
        return '';
    }

    return kind === 'date' ? String(value).slice(0, 10) : String(value);
}

function parseInput(kind: string, text: string): unknown {
    if (text === '') {
        return null;
    }
    if (kind === 'number') {
        const number = Number(text);

        return Number.isFinite(number) ? number : null;
    }
    if (kind === 'date') {
        const date = parseFilterDate(text);

        return date ? formatFilterDate(date) : null;
    }

    return text;
}

/** Set filters: search, select all of the visible choices, choose values; any of or none of them. */
function SetFilterEditor<TData>({ column, condition, onChange, choices }: FilterEditorProps<TData>) {
    const [type, setType] = useState<'anyOf' | 'noneOf'>(
        (condition as { type?: 'anyOf' | 'noneOf' } | null)?.type ?? 'anyOf'
    );
    const [values, setValues] = useState<(string | null)[]>(
        ((condition as { values?: (string | null)[] } | null)?.values ?? []).slice()
    );
    const [text, setText] = useState('');
    const source = choices ?? EMPTY_CHOICES;
    const { choices: list, loading } = useSetFilterChoices(source, text, values);
    const operators = filterOperators('set', (column.def.filterParams ?? {}) as Record<string, unknown>);

    const update = (nextType: 'anyOf' | 'noneOf', nextValues: (string | null)[]) => {
        setType(nextType);
        setValues(nextValues);
        onChange(nextValues.length === 0 ? null : { filterType: 'set', type: nextType, values: nextValues });
    };
    const visible = list.map((choice) => choice.value);
    const allVisibleChosen = visible.length > 0 && visible.every((value) => values.includes(value));

    return (
        <div data-grid-part="filter-editor" data-filter-kind="set">
            <select
                data-grid-part="filter-operator"
                aria-label="Operator"
                value={type}
                onChange={(event) => update(event.target.value as 'anyOf' | 'noneOf', values)}
            >
                {operators.map((entry) => (
                    <option key={entry.key} value={entry.key}>
                        {entry.label}
                    </option>
                ))}
            </select>
            <input
                data-grid-part="filter-search"
                aria-label="Search values"
                placeholder="Search…"
                value={text}
                onChange={(event) => setText(event.target.value)}
            />
            <div data-grid-part="filter-choices" data-loading={loading || undefined} role="group">
                {visible.length > 0 ? (
                    <label data-grid-part="filter-choice" data-select-all="">
                        <input
                            type="checkbox"
                            checked={allVisibleChosen}
                            onChange={() =>
                                update(
                                    type,
                                    allVisibleChosen
                                        ? values.filter((value) => !visible.includes(value))
                                        : [...values, ...visible.filter((value) => !values.includes(value))]
                                )
                            }
                        />
                        (Select all)
                    </label>
                ) : (
                    <span data-grid-part="filter-empty">{loading ? 'Loading…' : 'No values'}</span>
                )}
                {list.map((choice) => (
                    <label key={String(choice.value)} data-grid-part="filter-choice" data-value={choice.value ?? ''}>
                        <input
                            type="checkbox"
                            checked={values.includes(choice.value)}
                            onChange={(event) =>
                                update(
                                    type,
                                    event.target.checked
                                        ? [...values, choice.value]
                                        : values.filter((value) => value !== choice.value)
                                )
                            }
                        />
                        {choice.label}
                    </label>
                ))}
            </div>
            <ClearButton onClear={() => update(type, [])} />
        </div>
    );
}

const EMPTY_CHOICES = { search: async () => [] };

function BooleanFilterEditor<TData>({ condition, onChange }: FilterEditorProps<TData>) {
    const current = (condition as { filter?: boolean | null } | null)?.filter;
    const [value, setValue] = useState<string>(current === true ? 'true' : current === false ? 'false' : '');

    return (
        <div data-grid-part="filter-editor" data-filter-kind="boolean">
            <select
                data-grid-part="filter-operator"
                aria-label="Value"
                value={value}
                onChange={(event) => {
                    setValue(event.target.value);
                    onChange(
                        event.target.value === ''
                            ? null
                            : { filterType: 'boolean', type: 'equals', filter: event.target.value === 'true' }
                    );
                }}
            >
                <option value="">Any</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
            </select>
        </div>
    );
}

function ClearButton({ onClear }: { onClear: () => void }) {
    return (
        <button type="button" data-grid-part="filter-clear" onClick={onClear}>
            Clear
        </button>
    );
}
