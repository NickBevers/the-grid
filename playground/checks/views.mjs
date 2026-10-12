#!/usr/bin/env node
import { chromium, firefox, webkit } from 'playwright';
import { build, preview } from 'vite';

/**
 * Saved view and export browser checks on the server fixture: a saved view restores columns (order, width,
 * hidden, pinned), sort, filters and search and sends the same request; a view saved before the migration applies;
 * the last state auto-saves once per burst of changes; the export query follows the grid and the exported
 * rows and columns match it. Writes playground/results/views-results[-browser].json.
 *
 * Usage: node playground/checks/views.mjs [--browser=chromium|firefox|webkit]
 *
 * Its setup follows the server checks in server.mjs.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const port = 5185;
const browserName = process.argv.find((arg) => arg.startsWith('--browser='))?.split('=')[1] ?? 'chromium';
const results = { date: new Date().toISOString(), environment: {}, checks: [] };

function record(name, pass, details = {}) {
    results.checks.push({ name, pass, ...details });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(details)}`);
}

const settle = (page) =>
    page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

/** Waits until no request is in flight and no loading row is mounted. */
async function idle(page, timeout = 8000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        const busy = await page.evaluate(() => {
            const inFlight = window.__srv.log.filter((entry) => !entry.done && !entry.aborted).length;

            return inFlight > 0 || document.querySelectorAll('[data-row-kind="loading"]').length > 0;
        });
        if (!busy) {
            await settle(page);

            return true;
        }
        await page.waitForTimeout(50);
    }

    return false;
}

const view = (page) =>
    page.evaluate(() => ({
        requests: window.__srv.log.length,
        aborted: window.__srv.log.filter((entry) => entry.aborted).length,
        rows: [...document.querySelectorAll('[data-grid-part="body"] [data-grid-part="row"]')].map(
            (row) => row.dataset.rowId
        ),
        count: window.__srv.api.rows.getRowCount(),
        scrollTop: window.__srv.api.geometry.getScroll().top,
        overlay: document.querySelector('[data-grid-part="overlay"]')?.dataset.overlay ?? null,
        reason: document.querySelector('[data-grid-part="overlay"]')?.dataset.overlayReason ?? null,
    }));

async function open(page, query = '') {
    await page.goto(`http://localhost:${port}/?fixture=server${query}`);
    await page.waitForFunction(() => window.__srv?.api);
}

const columnsShown = (page) =>
    page.evaluate(() =>
        [...document.querySelectorAll('[data-grid-part="header-row"] [data-grid-part="header-cell"]')].map((cell) => ({
            colId: cell.dataset.colId,
            width: Math.round(cell.getBoundingClientRect().width),
            pinned: Boolean(cell.closest('[data-grid-part="pinned-left"]')),
        }))
    );
const lastUrl = (page) => page.evaluate(() => window.__srv.log.at(-1).url);

async function checks(page) {
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await open(page);
    await page.waitForSelector('[data-row-id="0"]');
    await idle(page);

    // Shape a view through the UI and the api: resize, move, hide, pin, sort, filter, search.
    const handle = page.locator(
        '[data-grid-part="header-cell"][data-col-id="city"] [data-grid-part="resize-handle"][data-edge="end"]'
    );
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 62, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    await page.evaluate(() => {
        const api = window.__srv.api;
        api.applyColumnState([{ colId: 'fee', pinned: 'left' }]);
        api.setColumnsVisible(['joined'], false);
    });
    await page.locator('[data-grid-part="header-cell"][data-col-id="fee"] [data-grid-part="header-content"]').click();
    await page.evaluate(() =>
        window.__srv.api.setColumnFilter('team', { filterType: 'set', type: 'noneOf', values: ['Legal'] })
    );
    await page.locator('[data-test="search"]').fill('ada');
    await page.locator('[data-test="search"]').press('Enter');
    await idle(page);
    const shaped = await columnsShown(page);
    const shapedUrl = await lastUrl(page);
    await page.locator('[data-test="save-view"]').click();
    const saved = await page.evaluate(() => window.__srv.captureView());

    // Change everything, then restore.
    await page.evaluate(() => {
        const api = window.__srv.api;
        api.resetColumnState();
        api.setFilterModel({});
        api.setSortModel([{ colId: 'name', sort: 'asc' }]);
    });
    await page.locator('[data-test="search"]').fill('');
    await page.locator('[data-test="search"]').press('Enter');
    await idle(page);
    const changed = await columnsShown(page);
    await page.locator('[data-test="restore-view"]').click();
    await idle(page);
    await page.waitForTimeout(700);
    await idle(page);
    const restored = await columnsShown(page);
    const restoredUrl = await lastUrl(page);
    record(
        'a saved view restores column order, widths, hiding and pinning, sort, filters and search, and sends the same request',
        JSON.stringify(restored) === JSON.stringify(shaped) &&
            JSON.stringify(changed) !== JSON.stringify(shaped) &&
            restoredUrl === shapedUrl &&
            saved.filterModel.team.type === 'noneOf' &&
            saved.searchQuery === 'ada' &&
            saved.sortModel[0].colId === 'fee',
        {
            shaped: shaped.map((column) => `${column.colId}:${column.width}${column.pinned ? ':L' : ''}`),
            restoredSame: restoredUrl === shapedUrl,
        }
    );

    // A view as the previous grid saved it: raw column state with that grid's own ids, anyOf without a type, noneOf with one.
    await page.evaluate(() =>
        window.__srv.applyView({
            filterModel: {
                team: { filterType: 'set', values: ['Admin', 'Design'] },
                city: { filterType: 'set', type: 'noneOf', values: ['Paris'] },
            },
            sortModel: [{ colId: 'joined', sort: 'desc' }],
            columnState: [
                {
                    colId: 'legacy-selection-column',
                    width: 50,
                    hide: false,
                    pinned: 'left',
                    sort: null,
                    sortIndex: null,
                    rowGroup: false,
                    rowGroupIndex: null,
                    flex: null,
                },
                {
                    colId: 'name',
                    width: 240,
                    hide: false,
                    pinned: 'left',
                    sort: null,
                    sortIndex: null,
                    rowGroup: false,
                    rowGroupIndex: null,
                    flex: null,
                },
                {
                    colId: 'joined',
                    width: 150,
                    hide: false,
                    pinned: null,
                    sort: 'desc',
                    sortIndex: 0,
                    rowGroup: false,
                    rowGroupIndex: null,
                    flex: null,
                },
                {
                    colId: 'team',
                    width: 130,
                    hide: false,
                    pinned: null,
                    sort: null,
                    sortIndex: null,
                    rowGroup: false,
                    rowGroupIndex: null,
                    flex: null,
                },
                {
                    colId: 'city',
                    width: 130,
                    hide: false,
                    pinned: null,
                    sort: null,
                    sortIndex: null,
                    rowGroup: false,
                    rowGroupIndex: null,
                    flex: null,
                },
                {
                    colId: 'id',
                    width: 90,
                    hide: true,
                    pinned: null,
                    sort: null,
                    sortIndex: null,
                    rowGroup: false,
                    rowGroupIndex: null,
                    flex: null,
                },
                {
                    colId: 'fee',
                    width: 120,
                    hide: false,
                    pinned: null,
                    sort: null,
                    sortIndex: null,
                    rowGroup: false,
                    rowGroupIndex: null,
                    flex: null,
                },
            ],
            columnGroupState: [],
            searchQuery: null,
            viewSettings: null,
        })
    );
    await idle(page);
    const agColumns = await columnsShown(page);
    const agUrl = new URL(await lastUrl(page), 'http://x');
    const teams = [
        ...new Set(
            await page.evaluate(() =>
                [...document.querySelectorAll('[data-grid-part="body"] [data-col-id="team"]')].map(
                    (cell) => cell.textContent
                )
            )
        ),
    ];
    record(
        'a view saved before the migration applies: its columns, sort and filters, ignoring unknown columns',
        agColumns.map((column) => `${column.colId}:${column.width}${column.pinned ? ':L' : ''}`).join() ===
            'name:240:L,joined:150,team:130,city:130,fee:120' &&
            JSON.parse(agUrl.searchParams.get('filterModel')).city.type === 'noneOf' &&
            JSON.parse(agUrl.searchParams.get('sortModel'))[0].colId === 'joined' &&
            teams.every((team) => team === 'Admin' || team === 'Design'),
        {
            agColumns: agColumns.map((column) => `${column.colId}:${column.width}${column.pinned ? ':L' : ''}`),
            teams,
            filterModel: agUrl.searchParams.get('filterModel'),
        }
    );

    // Auto-save: one save per burst of changes, a second after the next change; it holds the current view.
    const savesBefore = await page.evaluate(() => window.__srv.lastStateSaves);
    await page.evaluate(() => {
        const api = window.__srv.api;
        api.setSortModel([{ colId: 'fee', sort: 'asc' }]);
        api.setColumnsVisible(['city'], false);
        api.setColumnFilter('fee', { filterType: 'number', type: 'greaterThan', filter: 100 });
    });
    await page.waitForTimeout(1400);
    const afterBurst = await page.evaluate(() => ({
        saves: window.__srv.lastStateSaves,
        state: window.__srv.lastState,
        current: window.__srv.captureView(),
    }));
    record(
        'the last state auto-saves once per burst of changes, holding the current view',
        afterBurst.saves === savesBefore + 1 &&
            JSON.stringify(afterBurst.state) === JSON.stringify(afterBurst.current) &&
            afterBurst.state.columnState.find((column) => column.colId === 'city').hide === true,
        { saves: afterBurst.saves - savesBefore }
    );
    await idle(page);

    // Export: the query follows the grid, and the exported rows and columns match it.
    await page.locator('[data-row-kind="data"] [data-col-id="name"]').first().click({ button: 'right' });
    await page.locator('[data-menu-item="export"]').click();
    await page.waitForTimeout(200);
    const exported = await page.evaluate(() => window.__srv.lastExport);
    if (!exported) {
        throw new Error(`no export; page errors: ${errors.join(' | ')}`);
    }
    const shownColumns = (await columnsShown(page)).map((column) => column.colId);
    const headerNames = await page.evaluate(() =>
        [
            ...document.querySelectorAll(
                '[data-grid-part="header-row"] [data-grid-part="header-cell"] [data-grid-part="header-label"]'
            ),
        ].map((label) => label.textContent.trim())
    );
    const lines = exported.csv.split('\n');
    const gridRows = await page.evaluate(
        (colIds) =>
            [...document.querySelectorAll('[data-grid-part="body"] [data-row-kind="data"]')]
                .slice(0, 12)
                .map((row) =>
                    colIds.map((colId) => row.querySelector(`[data-col-id="${colId}"]`)?.textContent ?? '').join(',')
                ),
        exported.query.columns.map((column) => column.colId)
    );
    const count = await page.evaluate(() => window.__srv.api.rows.getRowCount());
    record(
        'the export query sends the displayed columns in order with the grid query, and the export matches the grid',
        exported.query.columns.map((column) => column.colId).join() === shownColumns.join() &&
            lines[0] === headerNames.join(',') &&
            JSON.stringify(lines.slice(1, 1 + gridRows.length)) === JSON.stringify(gridRows) &&
            lines.length - 1 === count &&
            exported.query.filterModel.city.type === 'noneOf' &&
            exported.query.sortModel[0].colId === 'fee',
        {
            columns: exported.query.columns.map((column) => column.colId),
            shownColumns,
            header: lines[0],
            headerNames,
            rows: lines.length - 1,
            count,
            csv: lines.slice(1, 5),
            grid: gridRows.slice(0, 4),
        }
    );

    record('no page errors', errors.length === 0, { errors: errors.slice(0, 3) });
}

const configFile = join(root, 'playground/vite.config.ts');
await build({ configFile, logLevel: 'warn' });
const server = await preview({ configFile, preview: { port, strictPort: true }, logLevel: 'warn' });
const browserType = { chromium, firefox, webkit }[browserName];
const browser = await browserType.launch();
results.environment = { browser: `${browserName} ${browser.version()}`, platform: process.platform };
try {
    const context = await browser.newContext({ viewport: { width: 1300, height: 760 } });
    await checks(await context.newPage());
} catch (error) {
    record('checks ran to completion', false, { error: String(error?.stack ?? error).slice(0, 600) });
} finally {
    await browser.close();
    server.httpServer.close();
}

const suffix = browserName === 'chromium' ? '' : `-${browserName}`;
mkdirSync(join(root, 'playground/results'), { recursive: true });
writeFileSync(join(root, `playground/results/views-results${suffix}.json`), JSON.stringify(results, null, 2));
const failed = results.checks.filter((check) => !check.pass).length;
console.log(`${results.checks.length - failed}/${results.checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
