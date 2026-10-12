#!/usr/bin/env node
import { chromium, firefox, webkit } from 'playwright';
import { build, preview } from 'vite';

/**
 * Row model browser checks on the local row model (?fixture=interactive): row drag reordering (one row and a
 * selection), transactions, the filter model, quick filter and search, and rows replaced by the parent
 * while an edit is open. Writes playground/results/rows-results[-browser].json; exits non-zero on failure.
 *
 * Usage: node playground/checks/rows.mjs [--browser=chromium|firefox|webkit]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const port = 5198;
const browserName = process.argv.find((arg) => arg.startsWith('--browser='))?.split('=')[1] ?? 'chromium';
const results = { date: new Date().toISOString(), environment: {}, checks: [] };

function record(name, pass, details = {}) {
    results.checks.push({ name, pass, ...details });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(details)}`);
}

const settle = (page) =>
    page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const displayed = (page) =>
    page.evaluate(() =>
        [...document.querySelectorAll('[data-grid-part="body"] [data-grid-part="row"]')].map((row) => row.dataset.rowId)
    );
const handle = (rowId) => `[data-row-id="${rowId}"] [data-grid-part="row-drag-handle"]`;

/** A native drag: press on the handle, move in steps, release over a point in the target row. */
async function dragRow(page, fromRowId, toRowId, half) {
    const from = await page.locator(handle(fromRowId)).boundingBox();
    const to = await page.locator(`[data-row-id="${toRowId}"][data-grid-part="row"]`).boundingBox();
    const y = to.y + (half === 'top' ? to.height * 0.25 : to.height * 0.75);
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 40, (from.y + y) / 2, { steps: 5 });
    await page.mouse.move(to.x + 200, y, { steps: 5 });
    const indicator = await page.evaluate(
        (id) => document.querySelector(`[data-row-id="${id}"][data-grid-part="row"]`)?.dataset.dropPosition ?? null,
        toRowId
    );
    const dragging = await page.locator('[data-grid-part="row"][data-row-dragging]').count();
    await page.mouse.up();
    await settle(page);

    return { indicator, dragging };
}

async function checks(page) {
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`http://localhost:${port}/?fixture=interactive`);
    await page.waitForSelector('[data-row-id="1"]');
    await settle(page);

    // Row drag.
    const single = await dragRow(page, '3', '1', 'top');
    const afterSingle = await page.evaluate(() => window.__ig.currentOrder().slice(0, 5));
    const dropEvent = await page.evaluate(
        () => window.__ig.events.filter((event) => event.name === 'rowDragEnded').at(-1)?.detail
    );
    record(
        'dragging a row shows the drop position and reports the drop; the parent reorders with moveRows',
        single.indicator === 'before' &&
            single.dragging === 1 &&
            JSON.stringify(afterSingle) === JSON.stringify([0, 3, 1, 2, 4]) &&
            dropEvent?.overRowId === '1' &&
            dropEvent?.position === 'before' &&
            dropEvent?.targetIndex === 1,
        { single, afterSingle, dropEvent }
    );
    const domOrder = (await displayed(page)).slice(0, 5);
    record('the grid shows the new order', JSON.stringify(domOrder) === JSON.stringify(['0', '3', '1', '2', '4']), {
        domOrder,
    });

    await page.locator('[data-row-id="5"] [data-grid-part="row-checkbox"]').click();
    await page.locator('[data-row-id="7"] [data-grid-part="row-checkbox"]').click();
    const multi = await dragRow(page, '7', '9', 'bottom');
    const afterMulti = await page.evaluate(() => window.__ig.currentOrder().slice(0, 11));
    record(
        'dragging a selected row moves the whole selection, in display order',
        multi.dragging === 2 &&
            multi.indicator === 'after' &&
            JSON.stringify(afterMulti) === JSON.stringify([0, 3, 1, 2, 4, 6, 8, 9, 5, 7, 10]),
        { multi, afterMulti }
    );
    await page.evaluate(() => window.__ig.api.deselectAll());

    // Transactions through the api.
    await page.evaluate(() => {
        const api = window.__ig.api;
        api.setFocusedCell({ rowId: '2', colId: 'name' }, { scroll: false });
        const template = { ...window.__ig.rows[1], id: 5000, name: 'Inserted deal' };
        api.applyTransaction({
            add: { rows: [template], index: 0 },
            remove: ['2'],
            update: [{ ...window.__ig.rows[0], name: 'Updated deal' }],
        });
    });
    await settle(page);
    const transaction = await page.evaluate(() => ({
        first: document.querySelector('[data-grid-part="body"] [data-row-id]')?.dataset.rowId,
        removed: document.querySelectorAll('[data-row-id="2"]').length,
        updated: document.querySelector('[data-row-id="0"] [data-col-id="name"]')?.textContent,
        focus: window.__ig.api.getFocusedCell(),
    }));
    record(
        'transactions add, update and remove rows by id, and focus moves off a removed row',
        transaction.first === '5000' &&
            transaction.removed === 0 &&
            transaction.updated === 'Updated deal' &&
            transaction.focus?.rowId !== '2' &&
            transaction.focus?.colId === 'name',
        transaction
    );

    // Filter model, quick filter and search.
    await page.evaluate(() =>
        window.__ig.api.setFilterModel({ fee: { filterType: 'number', type: 'greaterThan', filter: 990 } })
    );
    await settle(page);
    const filtered = await page.evaluate(() => {
        const ids = [...document.querySelectorAll('[data-grid-part="body"] [data-grid-part="row"]')].map((row) =>
            Number(row.dataset.rowId)
        );
        const fees = ids.map((id) => window.__ig.rows[id]?.fee ?? null);

        return {
            count: window.__ig.api.rows.getRowCount(),
            fees: fees.slice(0, 5),
            allAbove: fees.every((fee) => fee !== null && fee > 990),
        };
    });
    record(
        'the filter model filters local rows with the server semantics',
        filtered.count > 0 && filtered.count < 100 && filtered.allAbove,
        filtered
    );

    await page.evaluate(() =>
        window.__ig.api.setFilterModel({ fee: { filterType: 'number', type: 'greaterThan', filter: 99999 } })
    );
    await page.waitForSelector('[data-grid-part="overlay"][data-overlay="empty"]');
    const status = await page.evaluate(() => window.__ig.api.getStatus());
    await page.evaluate(() => window.__ig.api.setFilterModel({}));
    await page.waitForSelector('[data-row-id="1"]');
    record(
        'no matching rows shows the empty overlay and status',
        status.state === 'empty' && status.reason === 'noResults',
        { status }
    );

    await page.evaluate(() => window.__ig.api.setQuickFilter('deal 12 gbp'));
    await settle(page);
    const quick = await displayed(page);
    await page.evaluate(() => window.__ig.api.setQuickFilter(''));
    await page.evaluate(() => window.__ig.api.setSearch('C1999'));
    await settle(page);
    const searched = await displayed(page);
    await page.evaluate(() => window.__ig.api.setSearch(''));
    await settle(page);
    record(
        'quick filter needs every word in some displayed column (currency GBP is every third deal); search filters local rows too',
        quick.length > 0 &&
            quick.includes('12') &&
            quick.every((id) => Number(id) % 3 === 0) &&
            JSON.stringify(searched) === JSON.stringify(['1999']),
        { quick: quick.slice(0, 6), searched }
    );

    // The parent replaces rows while an edit is open (form values).
    await page.evaluate(() => {
        window.__ig.api.geometry.setScroll({ top: 0 });
        window.__ig.api.setFocusedCell({ rowId: '4', colId: 'name' }, { scroll: true });
    });
    await page.locator('[data-grid-part="viewport"]').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Draft kept');
    await page.evaluate(() =>
        window.__ig.replaceRows((rows) => rows.map((row) => (row.id === 6 ? { ...row, code: 'From parent' } : row)))
    );
    await settle(page);
    const form = await page.evaluate(() => ({
        draft: document.querySelector('[data-grid-editor] input')?.value,
        editing: window.__ig.api.getEditingCell(),
        replaced: document.querySelector('[data-row-id="6"] [data-col-id="code"]')?.textContent,
    }));
    await page.keyboard.press('Enter');
    await settle(page);
    record(
        'rows replaced by the parent keep an open edit and its draft, and show the new values',
        form.draft === 'Draft kept' &&
            form.editing?.rowId === '4' &&
            form.replaced === 'From parent' &&
            (await page.evaluate(() => window.__ig.rows[4].name)) === 'Draft kept',
        form
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
    const context = await browser.newContext({ viewport: { width: 1400, height: 800 } });
    await checks(await context.newPage());
} catch (error) {
    record('checks ran to completion', false, { error: String(error?.stack ?? error).slice(0, 600) });
} finally {
    await browser.close();
    server.httpServer.close();
}

const suffix = browserName === 'chromium' ? '' : `-${browserName}`;
mkdirSync(join(root, 'playground/results'), { recursive: true });
writeFileSync(join(root, `playground/results/rows-results${suffix}.json`), JSON.stringify(results, null, 2));
const failed = results.checks.filter((check) => !check.pass).length;
console.log(`${results.checks.length - failed}/${results.checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
