#!/usr/bin/env node
import { chromium, firefox, webkit } from 'playwright';
import { build, preview } from 'vite';

/**
 * Filter browser checks: filtering and search on the server fixture through the example filter bar,
 * which uses only the package's headless filter helpers. Writes playground/results/filters-results[-browser].json.
 *
 * Usage: node playground/checks/filters.mjs [--browser=chromium|firefox|webkit]
 *
 * Its setup follows the server checks in server.mjs.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const port = 5188;
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

const lastRequest = (page) => page.evaluate(() => window.__srv.log.at(-1));
const filterModelOf = (url) => JSON.parse(new URL(url, 'http://x').searchParams.get('filterModel') ?? '{}');

async function checks(page) {
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));

    await open(page);
    await page.waitForSelector('[data-row-id="0"]');
    await idle(page);

    // Search: typing waits 500 ms after the last key, then sends one request.
    const before = (await view(page)).requests;
    await page.locator('[data-test="search"]').pressSequentially('lena', { delay: 60 });
    await page.waitForTimeout(250);
    const whileTyping = (await view(page)).requests - before;
    await idle(page);
    await page.waitForTimeout(700);
    await idle(page);
    const afterSearch = await page.evaluate((from) => window.__srv.log.slice(from).map((entry) => entry.q), before);
    const names = await page.evaluate(() =>
        [...document.querySelectorAll('[data-grid-part="body"] [data-col-id="name"]')].map((cell) => cell.textContent)
    );
    record(
        'search waits 500 ms after typing and sends one request for the whole word',
        whileTyping === 0 &&
            afterSearch[0] === 'lena' &&
            afterSearch.every((q) => q === 'lena') &&
            names.every((name) => name.toLowerCase().includes('lena')),
        { whileTyping, queries: afterSearch, sample: names.slice(0, 2) }
    );
    await page.locator('[data-test="search"]').fill('');
    await page.locator('[data-test="search"]').press('Enter');
    await idle(page);

    // An incomplete pill sends nothing; completing it applies it.
    const beforePill = (await view(page)).requests;
    await page.locator('[data-test="add-filter"]').selectOption('fee');
    await page.locator('[data-test="pill-fee-operator"]').selectOption('inRange');
    await page.locator('[data-test="pill-fee-filter"]').fill('4990');
    await page.waitForTimeout(400);
    const incompleteRequests = (await view(page)).requests - beforePill;
    await page.locator('[data-test="pill-fee-filterTo"]').fill('4995');
    await idle(page);
    const feeModel = filterModelOf((await lastRequest(page)).url);
    const fees = await page.evaluate(() =>
        [...document.querySelectorAll('[data-grid-part="body"] [data-col-id="fee"]')].map((cell) =>
            Number(cell.textContent)
        )
    );
    record(
        'a pill being filled in sends nothing; the complete range filters the rows',
        incompleteRequests === 0 &&
            JSON.stringify(feeModel.fee) ===
                JSON.stringify({ filterType: 'number', type: 'inRange', filter: 4990, filterTo: 4995 }) &&
            fees.length > 0 &&
            fees.every((fee) => fee >= 4990 && fee <= 4995),
        { incompleteRequests, fee: feeModel.fee, sample: fees.slice(0, 4) }
    );
    await page.locator('[data-test="pill-fee-remove"]').click();
    await idle(page);

    // Searched set choices: typing in the choice search asks the endpoint once, debounced.
    await page.locator('[data-test="add-filter"]').selectOption('team');
    await page.waitForSelector('[data-test="pill-team-choices"] [data-value="Finance"]');
    const choicesBefore = await page.evaluate(() => window.__srv.choiceLog.length);
    await page.locator('[data-test="pill-team-search"]').pressSequentially('fin', { delay: 40 });
    await page.waitForFunction(
        () => document.querySelectorAll('[data-test="pill-team-choices"] [data-test="choice"]').length === 1
    );
    const choiceRequests = await page.evaluate((from) => window.__srv.choiceLog.slice(from), choicesBefore);
    record(
        'a searched set asks its endpoint once per pause in typing, in the backend request shape',
        choiceRequests.length === 1 &&
            choiceRequests[0] === '/api/grids/teams?startRow=0&endRow=20&fields=id%2Cname&q=fin',
        { choiceRequests }
    );
    await page.locator('[data-test="pill-team-choices"] [data-value="Finance"] input').check();
    await idle(page);
    const anyOf = filterModelOf((await lastRequest(page)).url).team;
    // Clearing the search keeps the selection first, with its label.
    await page.locator('[data-test="pill-team-search"]').fill('');
    await page.waitForFunction(
        () => document.querySelectorAll('[data-test="pill-team-choices"] [data-test="choice"]').length === 6
    );
    const firstChoice = await page
        .locator('[data-test="pill-team-choices"] [data-test="choice"]')
        .first()
        .getAttribute('data-value');
    await page.locator('[data-test="pill-team-operator"]').selectOption('noneOf');
    await idle(page);
    const noneOf = filterModelOf((await lastRequest(page)).url).team;
    const teams = await page.evaluate(() => [
        ...new Set(
            [...document.querySelectorAll('[data-grid-part="body"] [data-col-id="team"]')].map(
                (cell) => cell.textContent
            )
        ),
    ]);
    record(
        'anyOf is sent without a type and noneOf with one; noneOf excludes the team; selected choices come first',
        JSON.stringify(anyOf) === JSON.stringify({ filterType: 'set', values: ['Finance'] }) &&
            JSON.stringify(noneOf) === JSON.stringify({ filterType: 'set', type: 'noneOf', values: ['Finance'] }) &&
            teams.length > 0 &&
            !teams.includes('Finance') &&
            firstChoice === 'Finance',
        { anyOf, noneOf, teams, firstChoice }
    );

    // A date filter in the backend format.
    await page.locator('[data-test="add-filter"]').selectOption('joined');
    await page.locator('[data-test="pill-joined-operator"]').selectOption('lessThan');
    await page.locator('[data-test="pill-joined-dateFrom"]').fill('2011-01-01');
    await idle(page);
    const dateModel = filterModelOf((await lastRequest(page)).url).joined;
    const joined = await page.evaluate(() =>
        [...document.querySelectorAll('[data-grid-part="body"] [data-col-id="joined"]')].map((cell) => cell.textContent)
    );
    record(
        'a date filter sends YYYY-MM-DD 00:00:00 and filters the rows',
        JSON.stringify(dateModel) ===
            JSON.stringify({ filterType: 'date', type: 'lessThan', dateFrom: '2011-01-01 00:00:00', dateTo: null }) &&
            joined.length > 0 &&
            joined.every((date) => date < '2011-01-01'),
        { dateModel, sample: joined.slice(0, 3) }
    );

    // Save the view, change everything, restore: the same request goes out and the bar shows the pills.
    await page.locator('[data-grid-part="header-cell"][data-col-id="fee"]').click();
    await idle(page);
    await page.locator('[data-test="search"]').fill('ada');
    await page.locator('[data-test="search"]').press('Enter');
    await idle(page);
    const savedUrl = (await lastRequest(page)).url;
    await page.locator('[data-test="save-view"]').click();
    await page.locator('[data-test="pill-team-remove"]').click();
    await page.locator('[data-test="pill-joined-remove"]').click();
    await page.locator('[data-test="search"]').fill('');
    await page.locator('[data-test="search"]').press('Enter');
    await idle(page);
    const changedUrl = (await lastRequest(page)).url;
    await page.locator('[data-test="restore-view"]').click();
    await idle(page);
    await page.waitForTimeout(700);
    await idle(page);
    const restoredUrl = (await lastRequest(page)).url;
    const pills = await page.evaluate(() =>
        [...document.querySelectorAll('[data-test^="pill-"][data-applied]')].map((pill) => pill.dataset.test)
    );
    const searchBox = await page.locator('[data-test="search"]').inputValue();
    record(
        'a restored view sends the same request as when it was saved, and the bar and search show it',
        restoredUrl === savedUrl &&
            changedUrl !== savedUrl &&
            pills.join() === 'pill-team,pill-joined' &&
            searchBox === 'ada',
        { savedUrl: decodeURIComponent(savedUrl), restoredSame: restoredUrl === savedUrl, pills, searchBox }
    );

    // Filters and search from the URL go out with the first request.
    await open(page, '&q=ada&filter[city]=ams');
    await page.waitForSelector('[data-row-kind="data"]');
    await idle(page);
    const first = await page.evaluate(() => window.__srv.log[0]);
    const firstModel = filterModelOf(first.url);
    const cities = await page.evaluate(() => [
        ...new Set(
            [...document.querySelectorAll('[data-grid-part="body"] [data-col-id="city"]')].map(
                (cell) => cell.textContent
            )
        ),
    ]);
    record(
        'URL filters and search are in the first request',
        (await page.evaluate(() => window.__srv.log.length)) >= 1 &&
            first.q === 'ada' &&
            JSON.stringify(firstModel.city) ===
                JSON.stringify({ filterType: 'text', type: 'contains', filter: 'ams' }) &&
            cities.join() === 'Amsterdam',
        { q: first.q, city: firstModel.city, cities }
    );

    {
        // Header menu: sort and filter from a right-click on a column header (local rows).
        await page.goto(`http://localhost:${port}/?fixture=groups&mode=rows`);
        await page.waitForSelector('[data-grid-part="body"] [data-grid-part="row"]');
        await settle(page);
        await page.evaluate(() => window.__grp.api.setRowGroupColumns([]));
        await settle(page);
        const headerMenu = async (colId) => {
            await page.locator(`[data-grid-part="header-cell"][data-col-id="${colId}"]`).click({ button: 'right' });
            await page.waitForSelector('[data-grid-part="menu"]');

            return page.evaluate(() =>
                [...document.querySelectorAll('[data-menu-item]')].map(
                    (item) =>
                        `${item.dataset.menuItem}${item.disabled ? ':off' : ''}${item.dataset.checked !== undefined ? ':on' : ''}`
                )
            );
        };
        const column = (colId) =>
            page.evaluate(
                (c) =>
                    [...document.querySelectorAll(`[data-grid-part="body"] [data-col-id="${c}"]`)]
                        .slice(0, 8)
                        .map((cell) => cell.textContent),
                colId
            );
        const menuBefore = await headerMenu('fee');
        await page.locator('[data-menu-item="sortDescending"]').click();
        await settle(page);
        const descending = (await column('fee')).map(Number);
        const sortedMenu = await headerMenu('fee');
        await page.locator('[data-menu-item="clearSort"]').click();
        await settle(page);
        const cleared = await page.evaluate(() => window.__grp.api.getSortModel().length);
        record(
            'right-clicking a header offers sorting and filtering; sorting from it sorts, marks the direction and clears',
            menuBefore.join() === 'sortAscending,sortDescending,clearSort:off,filter,clearFilter:off' &&
                descending.every((fee, index) => index === 0 || descending[index - 1] >= fee) &&
                descending[0] === 4999 &&
                sortedMenu.includes('sortDescending:on') &&
                sortedMenu.includes('clearSort') &&
                cleared === 0,
            { menuBefore, descending: descending.slice(0, 3), sortedMenu }
        );
        await page.keyboard.press('Escape');

        // Filter panel: a number filter with two conditions joined by OR.
        await headerMenu('fee');
        await page.locator('[data-menu-item="filter"]').click();
        await page.waitForSelector('[data-grid-part="filter-panel"]');
        const conditions = page.locator('[data-grid-part="filter-panel"] [data-grid-part="filter-condition"]');
        await conditions.nth(0).locator('[data-grid-part="filter-operator"]').selectOption('lessThan');
        await conditions.nth(0).locator('[data-grid-part="filter-input"]').fill('10');
        await page.waitForSelector('[data-grid-part="filter-panel"] [data-grid-part="filter-condition"] >> nth=1');
        await conditions.nth(1).locator('[data-grid-part="filter-join"] input').nth(1).check();
        await conditions.nth(1).locator('[data-grid-part="filter-operator"]').selectOption('greaterThan');
        await conditions.nth(1).locator('[data-grid-part="filter-input"]').fill('4990');
        await page.waitForFunction(() => (window.__grp.api.getFilterModel().fee?.conditions ?? []).length === 2);
        await settle(page);
        const feeModel = await page.evaluate(() => window.__grp.api.getFilterModel().fee);
        const fees = (await column('fee')).map(Number);
        await page.keyboard.press('Escape');
        await settle(page);
        const indicator = await page
            .locator('[data-grid-part="header-cell"][data-col-id="fee"] [data-grid-part="header-filter-button"]')
            .count();
        record(
            'the filter panel builds two conditions joined by OR, filters live, and the header shows the filter',
            feeModel?.operator === 'OR' &&
                feeModel.conditions[0].type === 'lessThan' &&
                feeModel.conditions[1].filter === 4990 &&
                fees.length > 0 &&
                fees.every((fee) => fee < 10 || fee > 4990) &&
                indicator === 1,
            { feeModel, sample: fees.slice(0, 4), indicator }
        );

        // Reopening shows the applied filter; Clear filter from the menu removes it.
        await page.locator('[data-grid-part="header-filter-button"]').click();
        await page.waitForSelector('[data-grid-part="filter-panel"]');
        const reopened = await page.evaluate(() =>
            [...document.querySelectorAll('[data-grid-part="filter-panel"] [data-grid-part="filter-input"]')].map(
                (input) => input.value
            )
        );
        await page.keyboard.press('Escape');
        await headerMenu('fee');
        await page.locator('[data-menu-item="clearFilter"]').click();
        await settle(page);
        const afterClear = await page.evaluate(() => Object.keys(window.__grp.api.getFilterModel()));
        record(
            'reopening the panel shows the applied conditions, and Clear filter in the menu removes them',
            reopened.slice(0, 2).join() === '10,4990' && afterClear.length === 0,
            { reopened, afterClear }
        );

        // Set filter over the column's local values, with search and noneOf.
        await headerMenu('city');
        await page.locator('[data-menu-item="filter"]').click();
        await page.waitForSelector(
            '[data-grid-part="filter-panel"] [data-grid-part="filter-choice"][data-value="Paris"]'
        );
        const cityChoices = await page.evaluate(() =>
            [...document.querySelectorAll('[data-grid-part="filter-choice"]:not([data-select-all])')].map(
                (choice) => choice.dataset.value
            )
        );
        await page.locator('[data-grid-part="filter-search"]').fill('par');
        await page.waitForFunction(
            () => document.querySelectorAll('[data-grid-part="filter-choice"]:not([data-select-all])').length === 1
        );
        await page.locator('[data-grid-part="filter-choice"][data-value="Paris"] input').check();
        await page.locator('[data-grid-part="filter-panel"] [data-grid-part="filter-operator"]').selectOption('noneOf');
        await page.waitForFunction(() => window.__grp.api.getFilterModel().city?.type === 'noneOf');
        await settle(page);
        const cities = [...new Set(await column('city'))];
        await page.keyboard.press('Escape');
        record(
            'a set filter lists the column values, searches them, and filters none-of',
            cityChoices.join() === 'Amsterdam,Berlin,Ghent,Paris' && cities.length > 0 && !cities.includes('Paris'),
            { cityChoices, cities }
        );
        await page.evaluate(() => window.__grp.api.setFilterModel({}));

        // Server rows: the header filter goes into the request.
        await page.goto(`http://localhost:${port}/?fixture=server`);
        await page.waitForSelector('[data-row-id="0"]');
        await idle(page);
        await page.locator('[data-grid-part="header-cell"][data-col-id="team"]').click({ button: 'right' });
        await page.locator('[data-menu-item="filter"]').click();
        await page.locator('[data-grid-part="filter-choice"][data-value="Legal"] input').check();
        await page.waitForFunction(() => window.__srv.log.at(-1).url.includes('filterModel'));
        await idle(page);
        const serverModel = filterModelOf((await lastRequest(page)).url).team;
        const serverTeams = [
            ...new Set(
                await page.evaluate(() =>
                    [...document.querySelectorAll('[data-grid-part="body"] [data-col-id="team"]')].map(
                        (cell) => cell.textContent
                    )
                )
            ),
        ];
        await page.keyboard.press('Escape');
        record(
            'a header filter on server rows sends the backend model and shows its rows',
            JSON.stringify(serverModel) === JSON.stringify({ filterType: 'set', values: ['Legal'] }) &&
                serverTeams.join() === 'Legal',
            { serverModel, serverTeams }
        );

        // Resize zone: 5px either side of the column line; dragging the next column's start resizes this column.
        await page.goto(`http://localhost:${port}/?fixture=groups&mode=group`);
        await page.waitForSelector('[data-grid-part="header-cell"][data-col-id="name"]');
        const header = await page.locator('[data-grid-part="header-cell"][data-col-id="name"]').boundingBox();
        const line = Math.round(header.x + header.width) - 1;
        const y = header.y + header.height / 2;
        const zone = await page.evaluate(
            ({ line, y }) =>
                [-6, -4, 0, 4, 6].map(
                    (dx) => getComputedStyle(document.elementFromPoint(line + dx + 0.5, y)).cursor === 'col-resize'
                ),
            { line, y }
        );
        await page.mouse.move(line + 3.5, y);
        await page.mouse.down();
        await page.mouse.move(line + 63.5, y, { steps: 4 });
        await page.mouse.up();
        await settle(page);
        const resized = await page.locator('[data-grid-part="header-cell"][data-col-id="name"]').boundingBox();
        record(
            'the resize zone straddles the column line, and its far side resizes the column before it',
            zone.join() === 'false,true,true,true,false' && Math.abs(resized.width - header.width - 60) <= 1,
            { zone, before: header.width, after: resized.width }
        );
    }

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
writeFileSync(join(root, `playground/results/filters-results${suffix}.json`), JSON.stringify(results, null, 2));
const failed = results.checks.filter((check) => !check.pass).length;
console.log(`${results.checks.length - failed}/${results.checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
