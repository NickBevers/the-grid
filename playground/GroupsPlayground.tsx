/**
 * Playground for group and tree rows.
 *
 *   ?fixture=groups&mode=group    5,000 people grouped by team, then city, in the group column
 *   ?fixture=groups&mode=rows     the same groups as full-width rows with a custom renderer
 *   ?fixture=groups&mode=tree     tasks as a tree from paths, the first level open
 *   ?fixture=groups&mode=detail   master/detail with detail rows that grow
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import '../src/styles/grid.css';
import './themes/app-theme.css';
import {
    Grid,
    type ColumnDefinition,
    type FullWidthRowRendererProps,
    type GridApi,
    type GroupRowRendererProps,
} from '../src';

const params = new URLSearchParams(location.search);
const MODE = params.get('mode') ?? 'group';
/** `?label=custom`: the tree's labels come from a label renderer, without counts, with custom toggle icons. */
const CUSTOM_LABEL = params.get('label') === 'custom';

type Person = { id: number; name: string; team: string; city: string; fee: number };
const TEAMS = ['Admin', 'Design', 'Finance', 'Legal'];
const CITIES = ['Amsterdam', 'Berlin', 'Ghent', 'Paris'];
const PEOPLE: Person[] = Array.from({ length: 5000 }, (_, id) => ({
    id,
    name: `Person ${id}`,
    team: TEAMS[id % TEAMS.length]!,
    city: CITIES[Math.floor(id / TEAMS.length) % CITIES.length]!,
    fee: (id * 37) % 5000,
}));

type Task = { id: string; path: string[]; owner: string; due: string };
const TASKS: Task[] = [];
for (let project = 0; project < 40; project++) {
    TASKS.push({ id: `p${project}`, path: [`Project ${project}`], owner: 'Ada', due: '2026-12-01' });
    for (let phase = 0; phase < 3; phase++) {
        const phasePath = [`Project ${project}`, `Phase ${phase + 1}`];
        // Phases have no row of their own: the tree fills them in.
        for (let task = 0; task < 4; task++) {
            TASKS.push({
                id: `p${project}-${phase}-${task}`,
                path: [...phasePath, `Task ${task + 1}`],
                owner: ['Bo', 'Cleo', 'Dani'][task % 3]!,
                due: `2026-1${phase}-0${task + 1}`,
            });
        }
    }
}

const peopleColumns: ColumnDefinition<Person>[] = [
    { field: 'id', headerName: 'ID', width: 90, filter: 'number' },
    { field: 'name', headerName: 'Name', width: 180, filter: 'text' },
    { field: 'team', headerName: 'Team', width: 140, enableRowGroup: true, filter: 'set' },
    { field: 'city', headerName: 'City', width: 140, enableRowGroup: true, filter: 'set' },
    { field: 'fee', headerName: 'Fee', width: 120, filter: 'number' },
];
const taskColumns: ColumnDefinition<Task>[] = [
    { field: 'owner', headerName: 'Owner', width: 140, filter: 'set' },
    { field: 'due', headerName: 'Due', width: 140, filter: 'date' },
];

declare global {
    interface Window {
        __grp?: { api: GridApi<never> | null };
    }
}

/** A custom full-width group row: label, count and the team's total fee. */
function TeamGroupRow({ row, toggle }: GroupRowRendererProps<Person>) {
    const total = useMemo(
        () =>
            PEOPLE.filter((person) => person[row.groupColId as 'team'] === row.key).reduce(
                (sum, person) => sum + person.fee,
                0
            ),
        [row.groupColId, row.key]
    );

    return (
        <span data-test="custom-group-row" style={{ paddingInlineStart: row.level * 18 }}>
            <button type="button" data-test="custom-group-toggle" onClick={toggle} aria-expanded={row.expanded}>
                {row.expanded ? '−' : '+'}
            </button>{' '}
            <strong>{row.key}</strong> · {row.childCount} people · total fee {total.toLocaleString('en')}
        </span>
    );
}

/** A detail panel whose height changes with its content. */
function PersonDetail({ row }: FullWidthRowRendererProps<Person>) {
    const [lines, setLines] = useState(1);
    const person = row.data as Person;

    return (
        <div data-test={`detail-${person.id}`} style={{ padding: '8px 12px' }}>
            <div>
                Projects for {person.name}{' '}
                <button
                    type="button"
                    data-test={`detail-${person.id}-add`}
                    onClick={() => setLines((count) => count + 1)}
                >
                    Add line
                </button>
            </div>
            <ul style={{ margin: '6px 0 0' }}>
                {Array.from({ length: lines }, (_, index) => (
                    <li key={index}>Project {index + 1}</li>
                ))}
            </ul>
        </div>
    );
}

export function GroupsPlayground() {
    const apiRef = useRef<GridApi<never> | null>(null);
    useEffect(() => {
        window.__grp = {
            get api() {
                return apiRef.current;
            },
        };
    }, []);

    if (MODE === 'tree') {
        return (
            <Frame title="Tasks as a tree (first level open)">
                <Grid<Task>
                    className="ig app-theme"
                    data={{
                        type: 'local',
                        rows: TASKS,
                        getRowId: (task) => task.id,
                        getDataPath: (task) => task.path,
                        expandedByDefault: 1,
                    }}
                    columns={taskColumns}
                    groupColumn={{
                        headerName: 'Task',
                        width: 280,
                        pinned: 'left',
                        ...(CUSTOM_LABEL
                            ? {
                                  showCount: false,
                                  labelRenderer: ({ label }) => <strong data-test="custom-label">{label}</strong>,
                              }
                            : {}),
                    }}
                    {...(CUSTOM_LABEL
                        ? {
                              icons: {
                                  rowExpanded: <span data-test="icon-open">v</span>,
                                  rowCollapsed: <span data-test="icon-closed">&gt;</span>,
                              },
                          }
                        : {})}
                    apiRef={apiRef as never}
                    ariaLabel="Tasks"
                />
            </Frame>
        );
    }
    if (MODE === 'detail') {
        return (
            <Frame title="Master/detail with growing detail rows">
                <Grid<Person>
                    className="ig app-theme"
                    data={{ type: 'local', rows: PEOPLE.slice(0, 500), getRowId: (person) => String(person.id) }}
                    columns={peopleColumns}
                    isRowMaster={() => true}
                    detailRenderer={PersonDetail}
                    groupColumn={{ headerName: '', width: 60 }}
                    apiRef={apiRef as never}
                    ariaLabel="People"
                />
            </Frame>
        );
    }

    return (
        <Frame title={MODE === 'rows' ? 'Groups as full-width rows' : 'Grouped by team, then city'}>
            <Grid<Person>
                className="ig app-theme"
                data={{ type: 'local', rows: PEOPLE, getRowId: (person) => String(person.id) }}
                columns={peopleColumns}
                defaultQuery={{ rowGroupColIds: ['team', 'city'] }}
                groupDisplay={MODE === 'rows' ? 'fullWidthRow' : 'column'}
                groupColumn={{ headerName: 'Team / City', width: 240 }}
                stickyGroupRows
                {...(MODE === 'rows' ? { groupRowRenderer: TeamGroupRow } : {})}
                rowSelection="multiple"
                enableRanges
                apiRef={apiRef as never}
                ariaLabel="People"
            />
        </Frame>
    );
}

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="ig-page">
            <div className="ig-bar">
                <strong>{title}</strong>
                {['group', 'rows', 'tree', 'detail'].map((mode) => (
                    <a
                        key={mode}
                        href={`?fixture=groups&mode=${mode}`}
                        aria-current={mode === MODE ? 'page' : undefined}
                    >
                        {mode}
                    </a>
                ))}
            </div>
            <div className="ig-frame">{children}</div>
        </div>
    );
}
