#!/usr/bin/env node
import { chromium, firefox, webkit } from 'playwright';
import { build, preview } from 'vite';

import { decodePng } from './png.mjs';

/**
 * Browser checks on persisted writes (?fixture=writes): the edit shows before the save finishes
 * and is marked pending, server rows reconcile, a rejected or failed save rolls the cell back with its
 * error, locked rows refuse edits, range edits and sibling propagation save as one batch, overlapping saves
 * settle newest-first, and paste rolls back only its rejected cells.
 * Writes playground/results/writes-results[-browser].json.
 *
 * Usage: node playground/checks/writes.mjs [--browser=chromium|firefox|webkit]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const port = 5186;
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

const cellText = (page, rowId, colId) =>
    page.evaluate(
        ({ r, c }) => document.querySelector(`[data-row-id="${r}"] [data-col-id="${c}"]`)?.textContent ?? null,
        { r: rowId, c: colId }
    );
const cellState = (page, rowId, colId) =>
    page.evaluate(
        ({ r, c }) => {
            const element = document.querySelector(`[data-row-id="${r}"] [data-col-id="${c}"]`);

            return {
                text: element?.textContent,
                pending: element?.hasAttribute('data-pending'),
                invalid: element?.hasAttribute('data-invalid'),
                title: element?.getAttribute('title'),
            };
        },
        { r: rowId, c: colId }
    );
const requests = (page) =>
    page.evaluate(() =>
        window.__wr.server.requests.map((request) => ({
            source: request.source,
            cells: request.cells,
            done: Boolean(request.done),
        }))
    );
const settledCount = (page) => page.evaluate(() => window.__wr.toasts.length);

async function editCell(page, rowId, colId, text) {
    await page.locator(`[data-row-id="${rowId}"] [data-col-id="${colId}"]`).dblclick();
    await page.waitForSelector('[data-grid-part="editor-input"]');
    await page.locator('[data-grid-part="editor-input"]').fill(text);
    await page.keyboard.press('Enter');
}

async function checks(page) {
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`http://localhost:${port}/?fixture=writes`);
    await page.waitForSelector('[data-row-id="1"]');
    await settle(page);

    // An edit shows at once, pending, and settles with the server's row (its revision goes up).
    await page.evaluate(() => window.__wr.server.latency.push(800));
    await editCell(page, '2', 'notes', '  Deliver at 14:00  ');
    await settle(page);
    const during = await cellState(page, '2', 'notes');
    const requestsDuring = await requests(page);
    await page.waitForFunction(() => window.__wr.toasts.length === 1);
    await settle(page);
    const after = await cellState(page, '2', 'notes');
    const revision = await cellText(page, '2', 'revision');
    record(
        'an edit shows before the save finishes, marked pending, then takes the server row',
        during.text.includes('Deliver') &&
            during.pending &&
            requestsDuring.length === 1 &&
            !requestsDuring[0].done &&
            after.text === 'Deliver at 14:00' &&
            !after.pending &&
            revision === '2',
        { during, after, revision }
    );

    // Sibling propagation: the price reaches the order's other lines, in one batch.
    await editCell(page, '4', 'price', '5500');
    await settle(page);
    const siblingsNow = [
        await cellText(page, '4', 'price'),
        await cellText(page, '5', 'price'),
        await cellText(page, '6', 'price'),
        await cellText(page, '7', 'price'),
    ];
    await page.waitForFunction(() => window.__wr.toasts.length === 2);
    const siblingRequest = (await requests(page)).at(-1);
    record(
        'a shared price reaches the order siblings at once and saves with them in one batch',
        siblingsNow.slice(0, 3).every((value) => value === '5500') &&
            siblingsNow[3] !== '5500' &&
            siblingRequest.cells.join() === '4.price,5.price(sibling),6.price(sibling)',
        { siblingsNow, cells: siblingRequest.cells }
    );

    // A rejected value rolls back and shows the server's message on the cell.
    await editCell(page, '1', 'price', '250000');
    await page.waitForFunction(() => window.__wr.toasts.length === 3);
    await settle(page);
    const rejected = await cellState(page, '1', 'price');
    const siblingAfterReject = await cellText(page, '2', 'price');
    const toast = await page.evaluate(() => window.__wr.toasts.at(-1));
    record(
        'a rejected value rolls back, with siblings, and the cell shows the error',
        rejected.text === '1000' &&
            rejected.invalid &&
            rejected.title === 'The price must be at most 100,000.' &&
            toast.rejected.length >= 1 &&
            siblingAfterReject === '1000',
        { rejected, siblingAfterReject, toast }
    );

    // A failed request (network) rolls the batch back.
    await page.locator('[data-test="fail-next"]').click();
    await editCell(page, '8', 'product', 'Sofa');
    await settle(page);
    const optimistic = await cellText(page, '8', 'product');
    await page.waitForFunction(() => window.__wr.toasts.length === 4);
    await settle(page);
    const failed = await cellState(page, '8', 'product');
    record(
        'a save that fails outright rolls the edit back after showing it',
        optimistic === 'Sofa' &&
            failed.text !== 'Sofa' &&
            failed.invalid &&
            failed.title === 'The server could not be reached.',
        { optimistic, failed }
    );

    // Locked rows refuse edits.
    await page.locator('[data-row-id="10"] [data-col-id="notes"]').dblclick();
    await settle(page);
    const lockedEditor = await page.locator('[data-grid-part="editor-input"]').count();
    record('a locked row cannot be edited', lockedEditor === 0, { lockedEditor });
    await page.keyboard.press('Escape');

    // Range edit: an edit inside a three-row range writes all three and saves them together.
    const beforeRange = (await requests(page)).length;
    // As a user would: select the range, then type. The edit opens on the focused cell.
    await page.evaluate(() => {
        window.__wr.api.setFocusedCell({ rowId: '13', colId: 'notes' });
        window.__wr.api.setRanges([{ anchor: { rowId: '13', colId: 'notes' }, end: { rowId: '15', colId: 'notes' } }]);
    });
    await page.locator('[data-grid-part="viewport"]').focus();
    await settle(page);
    await page.keyboard.type('Backordered');
    await page.keyboard.press('Enter');
    await settle(page);
    const rangeNow = [
        await cellText(page, '13', 'notes'),
        await cellText(page, '14', 'notes'),
        await cellText(page, '15', 'notes'),
        await cellText(page, '16', 'notes'),
    ];
    await page.waitForFunction(
        (n) => window.__wr.server.requests.length === n + 1 && window.__wr.server.requests.at(-1).done,
        beforeRange
    );
    const rangeRequest = (await requests(page)).at(-1);
    record(
        'an edit inside a range writes every row of the range and saves them in one batch',
        rangeNow.slice(0, 3).every((value) => value === 'Backordered') &&
            rangeNow[3] === '' &&
            rangeRequest.cells.join() === '13.notes,14.notes(range),15.notes(range)',
        { rangeNow, cells: rangeRequest.cells }
    );
    await page.evaluate(() => window.__wr.api.clearRanges());

    // Overlapping saves: the older save is slow and succeeds, the newer one is fast and fails.
    await page.evaluate(() => {
        window.__wr.server.latency.push(900, 150);
        window.__wr.server.fail.push('ok', 'network');
    });
    const toastsBefore = await settledCount(page);
    await editCell(page, '21', 'notes', 'First');
    await settle(page);
    await editCell(page, '21', 'notes', 'Second');
    await page.waitForFunction((n) => window.__wr.toasts.length === n + 1, toastsBefore);
    await settle(page);
    const afterNewerFailed = await cellText(page, '21', 'notes');
    await page.waitForFunction((n) => window.__wr.toasts.length === n + 2, toastsBefore);
    await settle(page);
    const afterOlderSucceeded = await cellText(page, '21', 'notes');
    record(
        'overlapping saves: a newer failure falls back to the older pending value, which then stands',
        afterNewerFailed === 'First' && afterOlderSucceeded === 'First',
        { afterNewerFailed, afterOlderSucceeded }
    );

    // Paste with one locked target: the locked row is skipped, the others save.
    await page.evaluate(() => window.__wr.api.setFocusedCell({ rowId: '28', colId: 'notes' }));
    await page.locator('[data-grid-part="viewport"]').focus();
    await page.evaluate(() => {
        const text = 'Alpha\nBravo\nCharlie';
        const data = new DataTransfer();
        data.setData('text/plain', text);
        const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
        // Firefox gives the event its own copy of the DataTransfer, without the data.
        if (event.clipboardData.getData('text/plain') !== text) {
            event.clipboardData.setData('text/plain', text);
        }
        document.querySelector('[data-grid-part="viewport"]').dispatchEvent(event);
    });
    await page.waitForFunction(
        () => window.__wr.server.requests.at(-1).source === 'paste' && window.__wr.server.requests.at(-1).done
    );
    await settle(page);
    await settle(page);
    const pasted = [
        await cellText(page, '28', 'notes'),
        await cellText(page, '29', 'notes'),
        await cellText(page, '30', 'notes'),
    ];
    const pasteRequest = (await requests(page)).at(-1);
    record(
        'paste saves the writable cells and leaves the locked row alone',
        pasted[0] === 'Alpha' &&
            pasted[1] === 'Bravo' &&
            pasted[2] === '' &&
            pasteRequest.cells.join() === '28.notes,29.notes',
        { pasted, cells: pasteRequest.cells }
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
writeFileSync(join(root, `playground/results/writes-results${suffix}.json`), JSON.stringify(results, null, 2));
const failed = results.checks.filter((check) => !check.pass).length;
console.log(`${results.checks.length - failed}/${results.checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
