#!/usr/bin/env node
import { chromium, firefox, webkit } from 'playwright';
import { build, preview } from 'vite';

/**
 * Browser checks on the server row model (?fixture=server): the request contract, blocks on
 * demand without request storms, rapid search and filter changes with stale responses dropped, grouped
 * queries, empty and no-query states, errors and retry, refresh without purge, pagination and selection.
 * The fake backend answers with 100 to 300 ms latency. Writes playground/results/server-results[-browser].json.
 *
 * Usage: node playground/checks/server.mjs [--browser=chromium|firefox|webkit]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const port = 5189;
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

async function checks(page) {
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await open(page);
    await page.waitForSelector('[data-row-id="0"]');
    await idle(page);
    const initial = await view(page);
    const firstUrl = await page.evaluate(() => window.__srv.log[0]?.url);
    record(
        'the first load requests one block in the backend contract and shows its rows',
        initial.requests === 1 &&
            firstUrl === '/api/grids/people?startRow=0&endRow=100' &&
            initial.rows[0] === '0' &&
            initial.count === 100000,
        { requests: initial.requests, firstUrl, first: initial.rows[0], count: initial.count }
    );

    // A fast fling: only blocks the viewport reaches are requested, two at a time.
    const box = await page.locator('[data-grid-part="viewport"]').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let index = 0; index < 40; index++) {
        await page.mouse.wheel(0, 3000);
        await page.waitForTimeout(15);
    }
    const settled = await idle(page);
    const fling = await view(page);
    const flungIndex = Number(fling.rows[Math.floor(fling.rows.length / 2)]);
    record(
        'a fast fling loads the rows it lands on without a request storm',
        settled &&
            fling.requests - initial.requests <= 25 &&
            flungIndex > 500 &&
            !fling.rows.some((id) => id.startsWith('loading')),
        { newRequests: fling.requests - initial.requests, landedOn: flungIndex }
    );

    // Rapid search changes: earlier requests are aborted, late responses dropped, the view starts at the top.
    const beforeSearch = await view(page);
    await page.evaluate(() => {
        const api = window.__srv.api;
        api.setSearch('a');
        api.setSearch('ad');
        api.setSearch('ada');
    });
    await idle(page);
    const searched = await view(page);
    const names = await page.evaluate(() =>
        [...document.querySelectorAll('[data-grid-part="body"] [data-col-id="name"]')].map((cell) => cell.textContent)
    );
    const searchUrls = await page.evaluate(
        (from) => window.__srv.log.slice(from).map((entry) => `${entry.q}${entry.aborted ? ' (aborted)' : ''}`),
        beforeSearch.requests
    );
    record(
        'rapid search changes abort earlier requests and show only the latest result, from the top',
        searched.aborted - beforeSearch.aborted >= 2 &&
            names.length > 0 &&
            names.every((name) => name.toLowerCase().includes('ada')) &&
            searched.scrollTop === 0 &&
            searched.count === 8334,
        { searchUrls, count: searched.count, scrollTop: searched.scrollTop, sample: names.slice(0, 3) }
    );

    // Rapid filter changes end on the last one.
    await page.evaluate(() => {
        const api = window.__srv.api;
        api.setSearch('');
        api.setColumnFilter('fee', { filterType: 'number', type: 'greaterThan', filter: 4000 });
        api.setFilterModel({});
        api.setColumnFilter('fee', { filterType: 'number', type: 'greaterThan', filter: 4900 });
    });
    await idle(page);
    const fees = await page.evaluate(() =>
        [...document.querySelectorAll('[data-grid-part="body"] [data-col-id="fee"]')].map((cell) =>
            Number(cell.textContent)
        )
    );
    const filtered = await view(page);
    record(
        'rapid filter changes end on the last filter',
        fees.length > 0 && fees.every((fee) => fee > 4900) && filtered.count > 0 && filtered.count < 3000,
        { count: filtered.count, sample: fees.slice(0, 4) }
    );

    await page.evaluate(() =>
        window.__srv.api.setColumnFilter('fee', { filterType: 'number', type: 'greaterThan', filter: 999999 })
    );
    await idle(page);
    const empty = await view(page);
    record(
        'a query with no matches shows the noResults overlay',
        empty.overlay === 'empty' && empty.reason === 'noResults' && empty.count === 0,
        { overlay: empty.overlay, reason: empty.reason }
    );
    await page.evaluate(() => window.__srv.api.setFilterModel({}));
    await idle(page);

    // A grouped query, then expanding a group loads its children by key path.
    await page.locator('[data-test="group-team"]').check();
    await idle(page);
    const groups = await page.evaluate(() =>
        [...document.querySelectorAll('[data-grid-part="body"] [data-row-kind="group"]')].map((row) => row.textContent)
    );
    await page.locator('[data-grid-part="row-expand-toggle"]').first().click();
    await idle(page);
    const expanded = await page.evaluate(() => ({
        rows: [...document.querySelectorAll('[data-grid-part="body"] [data-grid-part="row"]')]
            .slice(0, 4)
            .map((row) => row.dataset.rowKind),
        lastRequest: window.__srv.log.at(-1).url,
        team: document.querySelector('[data-grid-part="body"] [data-row-kind="data"] [data-col-id="team"]')
            ?.textContent,
    }));
    await page.locator('[data-grid-part="row-expand-toggle"]').first().click();
    await settle(page);
    const collapsed = await page.evaluate(
        () => document.querySelectorAll('[data-grid-part="body"] [data-row-kind="data"]').length
    );
    record(
        'a grouped query shows group rows; expanding one requests its children by group key',
        groups.length === 6 &&
            groups[0].includes('Admin') &&
            groups[0].includes('16667') &&
            expanded.rows[0] === 'group' &&
            expanded.rows[1] === 'data' &&
            expanded.team === 'Admin' &&
            expanded.lastRequest.includes('groupKeys=%5B%22Admin%22%5D') &&
            expanded.lastRequest.includes('rowGroupCols=') &&
            collapsed === 0,
        { groups: groups.slice(0, 2), expanded, collapsed }
    );
    await page.locator('[data-test="group-team"]').uncheck();
    await idle(page);

    // Errors: the overlay offers a retry, which loads.
    await page.evaluate(() => {
        window.__srv.backend.failNext = 1;
        window.__srv.api.refresh({ purge: true });
    });
    await page.waitForSelector('[data-grid-part="overlay"][data-overlay="error"]');
    await page.locator('[data-grid-part="overlay-retry"]').click();
    await idle(page);
    const retried = await view(page);
    record(
        'a failed load shows the error overlay; retry loads the rows',
        retried.overlay === null && retried.rows[0] === '0',
        { overlay: retried.overlay, first: retried.rows[0] }
    );

    // errorOverlay={false}: a failed load shows the failed rows and no overlay.
    await open(page, '&errorOverlay=off');
    await idle(page);
    await page.evaluate(() => {
        window.__srv.backend.failNext = 1;
        window.__srv.api.refresh({ purge: true });
    });
    await page.waitForFunction(() => window.__srv.api.getStatus().state === 'error', null, { timeout: 10_000 });
    await page.waitForTimeout(300);
    const silent = await page.evaluate(() => ({
        overlay: document.querySelector('[data-grid-part="overlay"]')?.textContent ?? null,
        status: JSON.stringify(window.__srv.api.getStatus()),
    }));
    record(
        'errorOverlay false shows no overlay when a load fails',
        silent.overlay === null && silent.status.includes('error'),
        silent
    );
    await open(page);
    await idle(page);

    // Refresh without purge keeps the rows on screen while it reloads.
    const beforeRefresh = await view(page);
    await page.locator('[data-test="refresh"]').click();
    await settle(page);
    const during = await page.evaluate(
        () => document.querySelectorAll('[data-grid-part="body"] [data-row-kind="loading"]').length
    );
    await idle(page);
    const afterRefresh = await view(page);
    record(
        'refresh without purge keeps rows on screen and reloads them',
        during === 0 && afterRefresh.requests > beforeRefresh.requests && afterRefresh.rows[0] === '0',
        { loadingRowsDuring: during, newRequests: afterRefresh.requests - beforeRefresh.requests }
    );

    // Selection on server rows, including select all.
    await page.locator('[data-row-id="2"] [data-col-id="name"]').click();
    await page.evaluate(() => window.__srv.api.setSelected(['2', '5', 'not-loaded'], true));
    const selected = await page.evaluate(() => ({
        rows: window.__srv.api.getSelectedRows().map((row) => row.id),
        mode: window.__srv.api.getSelection().mode,
    }));
    record(
        'selection works on server rows and keeps ids that are not loaded',
        selected.rows.join() === '2,5' && selected.mode === 'ids',
        selected
    );

    // The no-query mode: nothing loads until there is something to ask.
    await open(page, '&noQuery=1');
    await page.waitForSelector('[data-grid-part="overlay"]');
    const noQuery = await view(page);
    await page.fill('[data-test="search"]', 'lena');
    await page.waitForSelector('[data-row-kind="data"]');
    await idle(page);
    const asked = await view(page);
    record(
        'with loadWithoutQuery off, nothing loads until search asks, then rows appear',
        noQuery.requests === 0 &&
            noQuery.overlay === 'empty' &&
            noQuery.reason === 'noQuery' &&
            asked.requests >= 1 &&
            asked.count > 0,
        { noQuery, askedCount: asked.count }
    );

    // Pagination at 100 rows.
    await open(page, '&paged=1');
    await page.waitForSelector('[data-row-id="0"]');
    await idle(page);
    const firstPage = await page.evaluate(() => ({
        pagination: window.__srv.api.getPagination(),
        count: window.__srv.api.rows.getRowCount(),
    }));
    await page.locator('[data-test="page-next"]').click();
    await idle(page);
    const secondPage = await view(page);
    const pageUrl = await page.evaluate(() => window.__srv.log.at(-1).url);
    record(
        'pagination shows 100 rows per page and loads the next page on demand',
        firstPage.pagination?.pageCount === 1000 &&
            firstPage.count === 100 &&
            secondPage.rows[0] === '100' &&
            pageUrl.includes('startRow=100&endRow=200') &&
            secondPage.count === 100,
        { firstPage, secondFirst: secondPage.rows[0], pageUrl }
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
writeFileSync(join(root, `playground/results/server-results${suffix}.json`), JSON.stringify(results, null, 2));
const failed = results.checks.filter((check) => !check.pass).length;
console.log(`${results.checks.length - failed}/${results.checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
