/**
 * Playground for the `<Grid>` component with editing, validation, popup editors,
 * ranges, fill, clipboard, row selection, menus, column groups, full-width rows and overlays.
 *
 *   ?fixture=interactive
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import '../src/styles/grid.css';
import './themes/app-theme.css';
import {
    DEFAULT_HEADER_MENU,
    Grid,
    type CellEditorComponent,
    type CellEditorProps,
    type CellRendererComponent,
    type ColumnDefinition,
    type GridApi,
    type GridEventMap,
    type GridRow,
    type MenuItem,
    moveRows,
} from '../src';

type Deal = {
    id: number;
    kind: 'deal' | 'section';
    name: string;
    fee: number | null;
    code: string;
    currency: string;
    notes: string;
    status: 'open' | 'closed';
    [metric: `m${number}`]: number;
};

const params = new URLSearchParams(location.search);
const ROWS = Number(params.get('rows') ?? 2000);
/** `?pinned=1`: a totals row pinned below the body and a summary row pinned above it. */
const PINNED = params.get('pinned') === '1';
/** `?escape=propagate`: Escape in an editor also reaches the page. */
const EDITOR_ESCAPE = params.get('escape') === 'propagate' ? ('propagate' as const) : undefined;
/** `?header=app`: the filter button on every filterable column and app-supplied icons. */
const APP_HEADER = params.get('header') === 'app';
const APP_ICONS = {
    sortAscending: <span data-test="icon-asc">▲</span>,
    sortDescending: <span data-test="icon-desc">▼</span>,
    columnGroupOpen: <span data-test="icon-group-open">‹</span>,
    columnGroupClosed: <span data-test="icon-group-closed">›</span>,
};
const METRICS = 30;
const CURRENCIES = ['GBP', 'EUR', 'USD'];

function makeRows(): Deal[] {
    return Array.from({ length: ROWS }, (_, id) => {
        const deal: Deal = {
            id,
            kind: id > 0 && id % 50 === 0 ? 'section' : 'deal',
            name: `Deal ${id}`,
            fee: id % 7 === 0 ? null : (id * 37) % 1000,
            code: `C${id}`,
            currency: CURRENCIES[id % 3]!,
            notes: `Note ${id}`,
            status: id % 4 === 0 ? 'closed' : 'open',
        };
        for (let metric = 1; metric <= METRICS; metric++) {
            deal[`m${metric}`] = (id * metric) % 97;
        }

        return deal;
    });
}

/** Number editor: rejects negatives and text, synchronously. */
const FeeEditor: CellEditorComponent<Deal> = Object.assign(
    ({ draft, setDraft, startKey }: CellEditorProps<Deal>) => {
        const ref = useRef<HTMLInputElement>(null);
        useEffect(() => {
            if (startKey !== null) {
                setDraft(startKey);
            }
            ref.current?.focus();
            ref.current?.select();
        }, []);

        return (
            <input
                ref={ref}
                data-test="fee-editor"
                inputMode="decimal"
                value={draft === null || draft === undefined ? '' : String(draft)}
                onChange={(event) => setDraft(event.target.value)}
            />
        );
    },
    {
        parse: (draft: unknown) => {
            const text = String(draft ?? '').trim();
            if (text === '') {
                return { ok: true as const, value: null };
            }
            const value = Number(text);
            if (!Number.isFinite(value)) {
                return { ok: false as const, error: 'Enter a number.' };
            }

            return value < 0
                ? { ok: false as const, error: 'The fee cannot be negative.' }
                : { ok: true as const, value };
        },
    }
);

/** Text editor with server validation: "taken" is rejected after a delay. */
const CodeEditor: CellEditorComponent<Deal> = Object.assign(
    ({ draft, setDraft }: CellEditorProps<Deal>) => {
        const ref = useRef<HTMLInputElement>(null);
        useEffect(() => ref.current?.focus(), []);

        return (
            <input
                ref={ref}
                data-test="code-editor"
                value={String(draft ?? '')}
                onChange={(event) => setDraft(event.target.value)}
            />
        );
    },
    {
        parse: (draft: unknown) =>
            new Promise<{ ok: true; value: unknown } | { ok: false; error: string }>((resolve) =>
                setTimeout(
                    () =>
                        resolve(
                            draft === 'taken' ? { ok: false, error: 'That code is taken.' } : { ok: true, value: draft }
                        ),
                    150
                )
            ),
    }
);

/** Popup editor: a list of currencies in a popover anchored to the cell. */
const CurrencyEditor: CellEditorComponent<Deal> = Object.assign(
    ({ draft, setDraft, stop }: CellEditorProps<Deal>) => {
        const ref = useRef<HTMLDivElement>(null);
        useEffect(() => ref.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus(), []);

        return (
            <div ref={ref} data-test="currency-editor" role="listbox">
                {CURRENCIES.map((currency) => (
                    <button
                        key={currency}
                        type="button"
                        data-test={`currency-${currency}`}
                        aria-pressed={draft === currency}
                        onClick={() => {
                            setDraft(currency);
                            // The draft is applied before the stop runs: stop reads the latest session.
                            queueMicrotask(() => stop(true));
                        }}
                    >
                        {currency}
                    </button>
                ))}
            </div>
        );
    },
    { presentation: 'popup' as const }
);

const StatusRenderer: CellRendererComponent<Deal> = ({ value }) => (
    <span data-test="status" data-status={String(value)}>
        {value === 'open' ? 'Open' : 'Closed'}
    </span>
);

const columns: ColumnDefinition<Deal>[] = [
    {
        colId: 'select',
        width: 44,
        pinned: 'left',
        checkboxSelection: true,
        headerCheckboxSelection: true,
        focusable: false,
        sortable: false,
        resizable: false,
        headerName: '',
    },
    { field: 'id', headerName: 'ID', width: 70, pinned: 'left', cellClass: 'non-editable-cell' },
    { field: 'name', headerName: 'Name', width: 160, pinned: 'left', editable: true, filter: 'text' },
    {
        groupId: 'deal',
        headerName: 'Deal',
        children: [
            {
                field: 'fee',
                headerName: 'Fee',
                filter: 'number',
                width: 110,
                editable: true,
                cellEditor: FeeEditor,
                cellClass: 'ig-number',
            },
            { field: 'code', headerName: 'Code', width: 110, editable: true, cellEditor: CodeEditor },
            {
                field: 'currency',
                headerName: 'Currency',
                width: 110,
                editable: true,
                cellEditor: CurrencyEditor,
                filter: 'set',
                suppressHeaderFilterButton: true,
            },
            { field: 'notes', headerName: 'Notes', width: 200, editable: true, showWhen: 'open' },
        ],
    },
    {
        groupId: 'metrics',
        headerName: 'Metrics',
        children: Array.from({ length: METRICS }, (_, index) => ({
            field: `m${index + 1}`,
            headerName: `Metric ${index + 1}`,
            width: 100,
            editable: true,
        })),
    },
    { field: 'status', headerName: 'Status', width: 100, pinned: 'right', cellRenderer: StatusRenderer },
];

declare global {
    interface Window {
        __ig?: {
            api: GridApi<Deal> | null;
            rows: Deal[];
            currentOrder: () => number[];
            replaceRows: (change: (rows: Deal[]) => Deal[]) => void;
            events: { name: string; detail: unknown }[];
            menuLog: string[];
            pasteCalls: { cell: { rowId: string; colId: string }; text: string }[][];
            setPasteRejects: (texts: string[]) => void;
        };
    }
}

export function InteractivePlayground() {
    // `initialRows` keeps every row object by id (index === id) for the checks; `rows` is the current order.
    const [initialRows] = useState(makeRows);
    const [rows, setRows] = useState(initialRows);
    const apiRef = useRef<GridApi<Deal> | null>(null);
    const events = useRef<{ name: string; detail: unknown }[]>([]);
    const menuLog = useRef<string[]>([]);
    const pasteCalls = useRef<{ cell: { rowId: string; colId: string }; text: string }[][]>([]);
    const pasteRejects = useRef<string[]>(['reject']);
    const data = useMemo(() => ({ type: 'local' as const, rows, getRowId: (deal: Deal) => String(deal.id) }), [rows]);
    const pinnedRows = useMemo(() => {
        if (!PINNED) {
            return undefined;
        }
        const total = rows.reduce((sum, deal) => sum + (deal.fee ?? 0), 0);
        const row = (id: number, name: string, fee: number): Deal =>
            ({ ...rows[0]!, id, kind: 'deal', name, fee, code: '', notes: '' }) as Deal;

        return { top: [row(-1, 'Summary', rows.length)], bottom: [row(-2, 'Total', total)] };
    }, [rows]);

    useEffect(() => {
        window.__ig = {
            get api() {
                return apiRef.current;
            },
            rows: initialRows,
            currentOrder: () => rows.map((row) => row.id),
            replaceRows: (change) => setRows((current) => change(current)),
            events: events.current,
            menuLog: menuLog.current,
            pasteCalls: pasteCalls.current,
            setPasteRejects: (texts) => {
                pasteRejects.current = texts;
            },
        };
    });

    const log =
        <TName extends keyof GridEventMap<Deal>>(name: TName) =>
        (detail: GridEventMap<Deal>[TName]) =>
            events.current.push({
                name,
                detail:
                    name === 'cellValueChanged' ||
                    name === 'editStopped' ||
                    name === 'focusChanged' ||
                    name === 'rangesChanged' ||
                    name === 'rowDragEnded'
                        ? JSON.parse(JSON.stringify({ ...detail, row: undefined }))
                        : null,
            });

    const getContextMenuItems = ({
        row,
        withinSelection,
    }: {
        row: { id: string } | null;
        withinSelection: boolean;
    }): MenuItem[] => [
        'copy',
        'copyWithHeaders',
        'paste',
        'separator',
        {
            id: 'open',
            label: withinSelection ? 'Open selected' : 'Open',
            onSelect: () => menuLog.current.push(`open ${row?.id}`),
        },
        // Permission-dependent: the first five deals are locked.
        {
            id: 'delete',
            label: 'Delete',
            destructive: true,
            disabled: Number(row?.id) < 5,
            onSelect: () => menuLog.current.push(`delete ${row?.id}`),
        },
        {
            id: 'more',
            label: 'More',
            children: [{ id: 'log', label: 'Log row', onSelect: () => menuLog.current.push(`log ${row?.id}`) }],
        },
    ];

    const [theme, setTheme] = useState(() => params.get('theme') ?? 'neutral');
    const [scheme, setScheme] = useState(() => params.get('scheme') ?? 'light');
    const [density, setDensity] = useState<'comfortable' | 'compact'>(() =>
        params.get('density') === 'compact' ? 'compact' : 'comfortable'
    );
    const choose = (key: string, value: string, set: (value: never) => void) => {
        params.set(key, value);
        history.replaceState(null, '', `?${params}`);
        set(value as never);
    };

    return (
        <div className="ig-page" style={{ colorScheme: scheme === 'system' ? 'light dark' : scheme }}>
            <div className="ig-bar" data-test="theme-bar">
                <label>
                    Theme
                    <select
                        data-test="theme"
                        value={theme}
                        onChange={(event) => choose('theme', event.target.value, setTheme)}
                    >
                        <option value="neutral">Neutral (package default)</option>
                        <option value="app">Example brand theme</option>
                    </select>
                </label>
                <label>
                    Colour scheme
                    <select
                        data-test="scheme"
                        value={scheme}
                        onChange={(event) => choose('scheme', event.target.value, setScheme)}
                    >
                        <option value="light">Light</option>
                        <option value="dark">Dark</option>
                        <option value="system">System</option>
                    </select>
                </label>
                <label>
                    Density
                    <select
                        data-test="density"
                        value={density}
                        onChange={(event) => choose('density', event.target.value, setDensity)}
                    >
                        <option value="comfortable">Comfortable</option>
                        <option value="compact">Compact</option>
                    </select>
                </label>
            </div>
            <div className="ig-frame">
                <Grid<Deal>
                    {...(APP_HEADER ? { headerFilterButton: 'always' as const, icons: APP_ICONS } : {})}
                    {...(EDITOR_ESCAPE ? { editorEscape: EDITOR_ESCAPE } : {})}
                    {...(pinnedRows
                        ? {
                              pinnedRows,
                              rowStyle: (row: GridRow<Deal>) =>
                                  row.section === 'bottom' ? { background: 'rgb(1, 2, 3)' } : undefined,
                          }
                        : {})}
                    key={density}
                    density={density}
                    colorScheme={scheme as 'light' | 'dark' | 'system'}
                    className={theme === 'app' ? 'ig app-theme' : 'ig'}
                    data={data}
                    columns={columns}
                    apiRef={apiRef}
                    ariaLabel="Deals"
                    rowDrag
                    rowDragLabel={(dragged) => `${dragged.length} deal${dragged.length === 1 ? '' : 's'}`}
                    rowSelection="multiple"
                    enableRanges
                    enableFill
                    rowClassName={(row) =>
                        ((row as { data?: Deal }).data?.id ?? 1) % 9 === 0 ? 'muted-row' : undefined
                    }
                    isFullWidthRow={(row) => (row as { data?: Deal }).data?.kind === 'section'}
                    fullWidthRowRenderer={({ row }) => (
                        <div data-test="section">Section {(row as { data: Deal }).data.id}</div>
                    )}
                    clipboard={{
                        paste: async (cells) => {
                            pasteCalls.current.push(cells);
                            await new Promise((resolve) => setTimeout(resolve, 30));

                            return {
                                rejected: cells
                                    .filter((cell) => pasteRejects.current.includes(cell.text))
                                    .map((cell) => ({ cell: cell.cell, error: 'Rejected by the server.' })),
                            };
                        },
                    }}
                    getContextMenuItems={getContextMenuItems as never}
                    getHeaderMenuItems={({ column }) => [
                        ...DEFAULT_HEADER_MENU,
                        'separator',
                        {
                            id: 'hide',
                            label: `Hide ${column?.headerName ?? ''}`,
                            onSelect: () => column && apiRef.current?.setColumnsVisible([column.colId], false),
                        },
                    ]}
                    footer={<div data-test="footer">{rows.length} deals</div>}
                    emptyOverlay={() => <div data-test="empty">No deals match</div>}
                    on={{
                        rowDragEnded: (event) => {
                            log('rowDragEnded')(event);
                            setRows((current) => moveRows(current, event, (deal) => String(deal.id)));
                        },
                        cellValueChanged: log('cellValueChanged'),
                        editStarted: log('editStarted'),
                        editStopped: log('editStopped'),
                        selectionChanged: log('selectionChanged'),
                        focusChanged: log('focusChanged'),
                        rangesChanged: log('rangesChanged'),
                        columnStateChanged: log('columnStateChanged'),
                        ready: log('ready'),
                        firstRowsRendered: log('firstRowsRendered'),
                    }}
                />
            </div>
        </div>
    );
}
