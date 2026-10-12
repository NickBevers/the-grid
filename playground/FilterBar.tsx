/**
 * An example filter bar, built only from the package's headless filter helpers. The grid renders no filter
 * UI; an application builds its own like this (the playground uses plain elements; an app uses its design
 * system). One pill per column; pills still being filled in stay out of the grid.
 */
import { useEffect, useMemo, useState } from 'react';

import {
    defaultCondition,
    filterOperators,
    formatFilterDate,
    isConditionApplicable,
    mergeFilterModel,
    parseFilterDate,
    partitionFilterModel,
    sameFilterModel,
    useSetFilterChoices,
    type CustomFilterCondition,
    type FilterCondition,
    type FilterModel,
    type GridApi,
    type SetChoicesSource,
} from '../src';

type AnyCondition = FilterCondition | CustomFilterCondition;

export type FilterBarColumn = {
    colId: string;
    label: string;
    kind: 'text' | 'number' | 'date' | 'set';
    filterParams?: Record<string, unknown>;
    choices?: SetChoicesSource;
};

type Pill = { colId: string; condition: AnyCondition };

export function FilterBar<TData>({
    api,
    columns,
    filterModel,
}: {
    api: GridApi<TData> | null;
    columns: FilterBarColumn[];
    filterModel: FilterModel;
}) {
    const owns = (colId: string) => columns.some((column) => column.colId === colId);
    const [pills, setPills] = useState<Pill[]>(() =>
        Object.entries(partitionFilterModel(filterModel, owns).owned).map(([colId, condition]) => ({
            colId,
            condition,
        }))
    );

    // The grid's model changed elsewhere (a restored view, code): complete pills follow it; pills still
    // being filled in stay.
    useEffect(() => {
        const { owned } = partitionFilterModel(filterModel, owns);
        setPills((current) => {
            const incomplete = current.filter(
                (pill) => !(pill.colId in owned) && !isConditionApplicable(pill.condition)
            );
            const next = [...Object.entries(owned).map(([colId, condition]) => ({ colId, condition })), ...incomplete];

            return sameFilterModel(
                Object.fromEntries(next.map((pill) => [pill.colId, pill.condition])),
                Object.fromEntries(current.map((pill) => [pill.colId, pill.condition]))
            )
                ? current
                : next;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filterModel]);

    const apply = (next: Pill[]) => {
        setPills(next);
        if (!api) {
            return;
        }
        const current = api.getFilterModel();
        const { others } = partitionFilterModel(current, owns);
        const merged = mergeFilterModel(Object.fromEntries(next.map((pill) => [pill.colId, pill.condition])), others);
        if (!sameFilterModel(merged, current)) {
            api.setFilterModel(merged);
        }
    };

    const unused = columns.filter((column) => !pills.some((pill) => pill.colId === column.colId));

    return (
        <div className="fb" data-test="filter-bar">
            {pills.map((pill) => {
                const column = columns.find((entry) => entry.colId === pill.colId)!;

                return (
                    <PillEditor
                        key={pill.colId}
                        column={column}
                        condition={pill.condition}
                        onChange={(condition) =>
                            apply(pills.map((entry) => (entry.colId === pill.colId ? { ...entry, condition } : entry)))
                        }
                        onRemove={() => apply(pills.filter((entry) => entry.colId !== pill.colId))}
                    />
                );
            })}
            {unused.length > 0 ? (
                <select
                    data-test="add-filter"
                    value=""
                    onChange={(event) => {
                        const column = columns.find((entry) => entry.colId === event.target.value)!;
                        apply([
                            ...pills,
                            { colId: column.colId, condition: defaultCondition(column.kind, column.filterParams) },
                        ]);
                    }}
                >
                    <option value="">+ Filter</option>
                    {unused.map((column) => (
                        <option key={column.colId} value={column.colId}>
                            {column.label}
                        </option>
                    ))}
                </select>
            ) : null}
        </div>
    );
}

function PillEditor({
    column,
    condition,
    onChange,
    onRemove,
}: {
    column: FilterBarColumn;
    condition: AnyCondition;
    onChange: (condition: AnyCondition) => void;
    onRemove: () => void;
}) {
    const operators = filterOperators(column.kind, column.filterParams, {
        'date.lessThan': 'Is before',
        'date.greaterThan': 'Is after',
    });
    const value = condition as Record<string, unknown>;
    const operator = operators.find((entry) => entry.key === (value.type ?? 'anyOf'));
    const applied = isConditionApplicable(condition, column.filterParams);

    return (
        <span className="fb-pill" data-test={`pill-${column.colId}`} data-applied={applied || undefined}>
            <strong>{column.label}</strong>
            <select
                data-test={`pill-${column.colId}-operator`}
                value={operator?.key}
                onChange={(event) => onChange({ ...condition, type: event.target.value } as AnyCondition)}
            >
                {operators.map((entry) => (
                    <option key={entry.key} value={entry.key}>
                        {entry.label}
                    </option>
                ))}
            </select>
            {column.kind === 'set' ? (
                <SetEditor
                    column={column}
                    values={(value.values as (string | null)[]) ?? []}
                    onChange={(values) => onChange({ ...condition, values } as AnyCondition)}
                />
            ) : null}
            {column.kind === 'text' && operator?.inputs ? (
                <input
                    data-test={`pill-${column.colId}-input`}
                    value={(value.filter as string) ?? ''}
                    onChange={(event) => onChange({ ...condition, filter: event.target.value } as AnyCondition)}
                />
            ) : null}
            {column.kind === 'number'
                ? (['filter', 'filterTo'] as const).slice(0, operator?.inputs ?? 0).map((key) => (
                      <input
                          key={key}
                          type="number"
                          data-test={`pill-${column.colId}-${key}`}
                          value={value[key] === null || value[key] === undefined ? '' : String(value[key])}
                          onChange={(event) =>
                              onChange({
                                  ...condition,
                                  [key]: event.target.value === '' ? null : Number(event.target.value),
                              } as AnyCondition)
                          }
                      />
                  ))
                : null}
            {column.kind === 'date'
                ? (['dateFrom', 'dateTo'] as const).slice(0, operator?.inputs ?? 0).map((key) => (
                      <input
                          key={key}
                          type="date"
                          data-test={`pill-${column.colId}-${key}`}
                          value={(value[key] as string | null)?.slice(0, 10) ?? ''}
                          onChange={(event) => {
                              const date = parseFilterDate(event.target.value);
                              onChange({ ...condition, [key]: date ? formatFilterDate(date) : null } as AnyCondition);
                          }}
                      />
                  ))
                : null}
            <button
                type="button"
                data-test={`pill-${column.colId}-remove`}
                aria-label={`Remove ${column.label} filter`}
                onClick={onRemove}
            >
                ×
            </button>
        </span>
    );
}

function SetEditor({
    column,
    values,
    onChange,
}: {
    column: FilterBarColumn;
    values: (string | null)[];
    onChange: (values: (string | null)[]) => void;
}) {
    const [text, setText] = useState('');
    const source = useMemo(() => column.choices!, [column.choices]);
    const { choices, loading } = useSetFilterChoices(source, text, values);

    return (
        <span className="fb-set">
            <input
                data-test={`pill-${column.colId}-search`}
                placeholder="Search"
                value={text}
                onChange={(event) => setText(event.target.value)}
            />
            <span className="fb-choices" data-test={`pill-${column.colId}-choices`} data-loading={loading || undefined}>
                {choices.map((choice) => (
                    <label key={String(choice.value)} data-test="choice" data-value={choice.value ?? '__blank__'}>
                        <input
                            type="checkbox"
                            checked={values.includes(choice.value)}
                            onChange={(event) =>
                                onChange(
                                    event.target.checked
                                        ? [...values, choice.value]
                                        : values.filter((entry) => entry !== choice.value)
                                )
                            }
                        />
                        {choice.label}
                    </label>
                ))}
            </span>
        </span>
    );
}
