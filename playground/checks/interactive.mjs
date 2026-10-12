#!/usr/bin/env node
import { chromium, firefox, webkit } from 'playwright';
import { build, preview } from 'vite';

/**
 * Browser checks on the `<Grid>` component (?fixture=interactive), driven with real
 * keyboard and pointer input: focus and navigation, editing and validation, popup editors, row selection,
 * ranges and aggregation, clipboard, fill, menus, column state and overlays.
 * Writes playground/results/interactive-results[-browser].json; exits non-zero on failure.
 *
 * Usage: node playground/checks/interactive.mjs [--browser=chromium|firefox|webkit]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const port = 5196;
const browserName = process.argv.find((arg) => arg.startsWith('--browser='))?.split('=')[1] ?? 'chromium';
const results = { date: new Date().toISOString(), environment: {}, checks: [] };

function record(name, pass, details = {}) {
    results.checks.push({ name, pass, ...details });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(details)}`);
}

const cell = (rowId, colId) => `[data-row-id="${rowId}"] [data-grid-part="cell"][data-col-id="${colId}"]`;
const settle = (page) =>
    page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const focused = (page) => page.evaluate(() => window.__ig.api.getFocusedCell());
const editing = (page) => page.evaluate(() => window.__ig.api.getEditingCell());
const row = (page, id) => page.evaluate((rowId) => window.__ig.rows[rowId], id);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function waitFor(page, predicate, arg, timeout = 3000) {
    try {
        await page.waitForFunction(predicate, arg, { timeout });

        return true;
    } catch {
        return false;
    }
}

async function reset(page) {
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
        const api = window.__ig.api;
        api.stopEditing(false);
        api.clearRanges();
        api.deselectAll();
        api.setFocusedCell(null);
        api.geometry.setScroll({ top: 0, left: 0 });
    });
    await settle(page);
}

async function clickCell(page, rowId, colId, options = {}) {
    await page.evaluate(({ r, c }) => window.__ig.api.geometry.ensureCellVisible({ rowId: r, colId: c }), {
        r: rowId,
        c: colId,
    });
    await settle(page);
    if ((await page.locator(cell(rowId, colId)).count()) === 0) {
        const state = await page.evaluate(() => ({
            scrollTop: document.querySelector('[data-grid-part="viewport"]').scrollTop,
            rows: [...document.querySelectorAll('[data-grid-part="body"] [data-row-id]')]
                .map((row) => row.dataset.rowId)
                .slice(0, 40)
                .join(','),
            editing: window.__ig.api.getEditingCell(),
            focus: window.__ig.api.getFocusedCell(),
        }));
        throw new Error(`cell ${rowId}/${colId} is not mounted: ${JSON.stringify(state)}`);
    }
    await page.locator(cell(rowId, colId)).click(options);
}

/** Dispatches a clipboard event with a DataTransfer, which works the same in every engine. */
async function clipboardEvent(page, type, text) {
    return page.evaluate(
        ({ eventType, data }) => {
            const transfer = new DataTransfer();
            if (data !== undefined) {
                transfer.setData('text/plain', data);
            }
            const event = new ClipboardEvent(eventType, { clipboardData: transfer, bubbles: true, cancelable: true });
            // Firefox gives the event its own copy of the DataTransfer, without the data.
            if (data !== undefined && event.clipboardData.getData('text/plain') !== data) {
                event.clipboardData.setData('text/plain', data);
            }
            document.querySelector('[data-grid-part="viewport"]').dispatchEvent(event);

            return {
                text: event.clipboardData.getData('text/plain'),
                html: event.clipboardData.getData('text/html'),
                prevented: event.defaultPrevented,
            };
        },
        { eventType: type, data: text }
    );
}

async function drag(page, fromSelector, toSelector) {
    // Reveal both cells through the geometry api: they may not be mounted yet.
    const ids = (selector) => {
        const [, rowId, colId] = selector.match(/data-row-id="([^"]+)".*data-col-id="([^"]+)"/);

        return { rowId, colId };
    };
    // Centred, so neither end sits in the autoscroll band at a body edge.
    await page.evaluate((cell) => window.__ig.api.geometry.ensureCellVisible(cell, 'center'), ids(toSelector));
    await settle(page);
    await page.evaluate((cell) => window.__ig.api.geometry.ensureCellVisible(cell, 'center'), ids(fromSelector));
    await settle(page);
    const from = await page.locator(fromSelector).boundingBox();
    const to = await page.locator(toSelector).boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2 + to.width / 2, (from.y + to.y) / 2 + to.height / 2, { steps: 4 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 4 });
    await page.mouse.up();
    await settle(page);
}

async function checks(page) {
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
    await page.goto(`http://localhost:${port}/?fixture=interactive`);
    await page.waitForSelector('[data-row-id]');
    await settle(page);

    // Focus and navigation
    await clickCell(page, '1', 'name');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    const afterArrows = await focused(page);
    const descendant = await page.evaluate(() => {
        const viewport = document.querySelector('[data-grid-part="viewport"]');
        const target = document.getElementById(viewport.getAttribute('aria-activedescendant'));

        return {
            focusedAttr: target?.hasAttribute('data-focused'),
            col: target?.dataset.colId,
            isActive: document.activeElement === viewport,
        };
    });
    record(
        'arrows move focus; aria-activedescendant names the focused cell',
        same(afterArrows, { rowId: '2', colId: 'fee' }) &&
            descendant.focusedAttr &&
            descendant.col === 'fee' &&
            descendant.isActive,
        { afterArrows, descendant }
    );

    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    record(
        'left stops at the first focusable column (the checkbox column is skipped)',
        same(await focused(page), { rowId: '2', colId: 'id' }),
        { focus: await focused(page) }
    );

    await page.keyboard.press('End');
    const end = await focused(page);
    await page.keyboard.press('Tab');
    const wrapped = await focused(page);
    record(
        'End goes to the row end; Tab past it wraps to the next row',
        same(end, { rowId: '2', colId: 'status' }) && same(wrapped, { rowId: '3', colId: 'id' }),
        { end, wrapped }
    );

    await page.keyboard.press('ControlOrMeta+ArrowDown');
    await settle(page);
    const bottom = await focused(page);
    const bottomVisible = await page.evaluate(
        (selector) => {
            const element = document.querySelector(selector);
            const viewport = document.querySelector('[data-grid-part="viewport"]').getBoundingClientRect();
            const rect = element?.getBoundingClientRect();

            return Boolean(rect && rect.top >= viewport.top && rect.bottom <= viewport.bottom + 1);
        },
        cell('1999', 'id')
    );
    record(
        'Ctrl or Cmd plus ArrowDown goes to the last row of the column and scrolls it into view',
        same(bottom, { rowId: '1999', colId: 'id' }) && bottomVisible,
        { bottom, bottomVisible }
    );

    await page.keyboard.press('ControlOrMeta+ArrowUp');
    await page.keyboard.press('PageDown');
    await settle(page);
    const paged = await focused(page);
    record('Page Down moves by a page of rows', Number(paged.rowId) > 10 && paged.colId === 'id', { paged });

    // Full-width section rows are focused as a whole; leaving one restores the column.
    await reset(page);
    await clickCell(page, '49', 'code');
    await page.keyboard.press('ArrowDown');
    const onSection = await focused(page);
    await page.keyboard.press('ArrowDown');
    const pastSection = await focused(page);
    record(
        'full-width rows take focus as a whole and restore the column after',
        same(onSection, { rowId: '50', colId: '__row' }) && same(pastSection, { rowId: '51', colId: 'code' }),
        { onSection, pastSection }
    );

    // Focus is kept while scrolled away (the focused row stays mounted) and recovered after a sort.
    await clickCell(page, '3', 'code');
    await page.evaluate(() => window.__ig.api.geometry.setScroll({ top: 40000 }));
    await settle(page);
    const retained = await page.locator(cell('3', 'code')).count();
    await page.keyboard.press('ArrowDown');
    await settle(page);
    const afterScrollAway = await focused(page);
    const revealed = await page.locator(cell('4', 'code')).isVisible();
    record(
        'focus survives scrolling away; the next key brings the cell back',
        retained === 1 && same(afterScrollAway, { rowId: '4', colId: 'code' }) && revealed,
        { retained, afterScrollAway, revealed }
    );

    await page.evaluate(() => window.__ig.api.setSortModel([{ colId: 'fee', sort: 'desc' }]));
    await settle(page);
    const afterSort = await focused(page);
    await page.evaluate(() => window.__ig.api.setColumnsVisible(['code'], false));
    await settle(page);
    const afterHide = await focused(page);
    await page.evaluate(() => {
        window.__ig.api.setColumnsVisible(['code'], true);
        window.__ig.api.setSortModel([]);
    });
    record(
        'focus stays on its row after a sort and moves to a neighbour when its column is hidden',
        same(afterSort, { rowId: '4', colId: 'code' }) && afterHide?.rowId === '4' && afterHide.colId !== 'code',
        { afterSort, afterHide }
    );

    // A programmatic scroll and a row change in the same task: the change must not undo the scroll.
    await page.evaluate(() => window.__ig.api.geometry.setScroll({ top: 200 }));
    await settle(page);
    const keptScroll = await page.evaluate(() => {
        window.__ig.api.geometry.setScroll({ top: 6000 });
        window.__ig.api.refreshCells();

        return new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(window.__ig.api.geometry.getScroll().top)))
        );
    });
    record(
        'a row change right after a programmatic scroll keeps the new scroll position',
        Math.abs(keptScroll - 6000) < 1,
        { keptScroll }
    );

    // Editing
    await reset(page);
    await clickCell(page, '5', 'name');
    await page.keyboard.type('Xy');
    const draftWhileTyping = await page.locator('[data-grid-editor] input').inputValue();
    await page.keyboard.press('Enter');
    await settle(page);
    record(
        'typing starts editing with the typed key; Enter commits and moves down',
        draftWhileTyping === 'Xy' &&
            (await row(page, 5)).name === 'Xy' &&
            same(await focused(page), { rowId: '6', colId: 'name' }) &&
            (await editing(page)) === null,
        { draftWhileTyping, focus: await focused(page) }
    );

    await page.keyboard.press('Enter');
    const scrollBeforeEnd = await page.evaluate(() => window.__ig.api.geometry.getScroll().top);
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    const draftWithEnd = await page.locator('[data-grid-editor] input').inputValue();
    await page.waitForTimeout(300);
    const scrollAfterEnd = await page.evaluate(() => window.__ig.api.geometry.getScroll().top);
    record(
        'End in an editor moves the caret and leaves the grid where it is',
        draftWithEnd === 'Deal 6!' && scrollAfterEnd === scrollBeforeEnd,
        { draftWithEnd, scrollBeforeEnd, scrollAfterEnd }
    );
    await page.keyboard.press('Escape');
    await settle(page);
    const focusBack = await page.evaluate(() => document.activeElement?.getAttribute('data-grid-part'));
    record(
        'Enter opens the editor on the current value; Escape cancels and focus returns to the grid',
        (await row(page, 6)).name === 'Deal 6' && (await editing(page)) === null && focusBack === 'viewport',
        { name: (await row(page, 6)).name, focusBack }
    );

    await clickCell(page, '8', 'fee');
    await page.keyboard.press('F2');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('-5');
    await page.keyboard.press('Enter');
    await settle(page);
    const rejected = {
        editing: await editing(page),
        error: await page
            .locator('[data-grid-part="editor-error"]')
            .textContent()
            .catch(() => null),
        fee: (await row(page, 8)).fee,
    };
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('12');
    await page.keyboard.press('Enter');
    await settle(page);
    record(
        'a rejected value keeps the editor open with its error; a valid one commits',
        same(rejected.editing, { rowId: '8', colId: 'fee' }) &&
            rejected.error === 'The fee cannot be negative.' &&
            rejected.fee === 296 &&
            (await row(page, 8)).fee === 12,
        { rejected, fee: (await row(page, 8)).fee }
    );

    await clickCell(page, '9', 'code');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('taken');
    await page.keyboard.press('Enter');
    const validating = await page.locator('[data-grid-editor][data-validating]').count();
    await waitFor(page, () => document.querySelector('[data-grid-part="editor-error"]') !== null);
    const asyncError = await page
        .locator('[data-grid-part="editor-error"]')
        .textContent()
        .catch(() => null);
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('fresh');
    await page.keyboard.press('Enter');
    await waitFor(page, () => window.__ig.rows[9].code === 'fresh');
    record(
        'async validation holds the editor open while validating, then shows the server error',
        validating === 1 && asyncError === 'That code is taken.' && (await row(page, 9)).code === 'fresh',
        { validating, asyncError, code: (await row(page, 9)).code }
    );

    await clickCell(page, '10', 'name');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Scrolled');
    await page.evaluate(() => window.__ig.api.geometry.setScroll({ top: 30000, left: 2000 }));
    await settle(page);
    const stillEditing = await page.locator('[data-grid-editor]').count();
    await page.evaluate(() => window.__ig.api.geometry.setScroll({ top: 0, left: 0 }));
    await settle(page);
    const draftAfterScroll = await page
        .locator('[data-grid-editor] input')
        .inputValue()
        .catch(() => null);
    await clickCell(page, '12', 'name');
    await settle(page);
    record(
        'an editor scrolled away keeps its draft; clicking elsewhere commits it',
        stillEditing === 1 &&
            draftAfterScroll === 'Scrolled' &&
            (await row(page, 10)).name === 'Scrolled' &&
            (await editing(page)) === null,
        { stillEditing, draftAfterScroll, name: (await row(page, 10)).name }
    );

    await clickCell(page, '13', 'fee');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('7');
    await page.keyboard.press('Tab');
    await settle(page);
    record(
        'Tab commits and opens the next editable cell',
        (await row(page, 13)).fee === 7 && same(await editing(page), { rowId: '13', colId: 'code' }),
        { editingNext: await editing(page) }
    );
    await page.keyboard.press('Escape');

    await clickCell(page, '14', 'currency');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-test="currency-editor"]');
    const popupOpen = await page.evaluate(() =>
        document.querySelector('[data-grid-part="popup"]')?.matches(':popover-open')
    );
    const popupBox = await page.locator('[data-grid-part="popup"]').boundingBox();
    const cellBox = await page.locator(cell('14', 'currency')).boundingBox();
    await page.locator('[data-test="currency-GBP"]').click();
    await settle(page);
    record(
        'a popup editor opens in a popover anchored below its cell and commits a choice',
        popupOpen &&
            Math.abs(popupBox.y - (cellBox.y + cellBox.height)) < 2 &&
            Math.abs(popupBox.x - cellBox.x) < 2 &&
            (await row(page, 14)).currency === 'GBP' &&
            (await editing(page)) === null,
        { popupOpen, popupBox, cellBox, currency: (await row(page, 14)).currency }
    );

    // Selection
    await reset(page);
    await page.locator('[data-row-id="2"] [data-grid-part="row-checkbox"]').click();
    await page.locator('[data-row-id="4"] [data-grid-part="row-checkbox"]').click();
    const selected = await page.evaluate(() => window.__ig.api.getSelectedRows().map((r) => r.id));
    const selectedAttr = await page.locator('[data-grid-part="row"][data-selected]').count();
    await clickCell(page, '6', 'name');
    await page.keyboard.press(' ');
    const afterSpace = await page.evaluate(() =>
        window.__ig.api
            .getSelectedRows()
            .map((r) => r.id)
            .sort()
    );
    await page.locator('[data-grid-part="header-checkbox"]').click();
    const all = await page.evaluate(() => window.__ig.api.getSelection().mode);
    await page.locator('[data-grid-part="header-checkbox"]').click();
    const none = await page.evaluate(() => window.__ig.api.getSelectedRows().length);
    record(
        'checkboxes, Space and the header checkbox select rows',
        same(selected, ['2', '4']) &&
            selectedAttr === 2 &&
            same(afterSpace, ['2', '4', '6']) &&
            all === 'all' &&
            none === 0,
        { selected, selectedAttr, afterSpace, all, none }
    );

    // Ranges
    await reset(page);
    await drag(page, cell('1', 'm1'), cell('4', 'm3'));
    const resolved = await page.evaluate(() => window.__ig.api.getResolvedRanges()[0]);
    const marked = await page.locator('[data-grid-part="cell"][data-range]').count();
    const edges = await page.evaluate(() => ({
        corner: Object.keys(document.querySelector('[data-row-id="1"] [data-col-id="m1"]').dataset)
            .filter((key) => key.startsWith('range'))
            .sort(),
        middle: Object.keys(document.querySelector('[data-row-id="2"] [data-col-id="m2"]').dataset)
            .filter((key) => key.startsWith('range'))
            .sort(),
    }));
    const selectedText = await page.evaluate(() => getSelection()?.toString() ?? '');
    record('dragging a range selects no text', selectedText === '', { selectedText: selectedText.slice(0, 40) });
    record(
        'dragging selects a rectangle drawn with range edges on the cells',
        same(resolved?.rowIds, ['1', '2', '3', '4']) &&
            same(resolved?.colIds, ['m1', 'm2', 'm3']) &&
            marked === 12 &&
            same(edges.corner, ['range', 'rangeLeft', 'rangeTop']) &&
            same(edges.middle, ['range']),
        { resolved, marked, edges }
    );

    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowRight');
    const extended = await page.evaluate(() => window.__ig.api.getResolvedRanges()[0]);
    record('Shift plus arrows extend the range', extended.rowIds.length === 5 && extended.colIds.length === 4, {
        rows: extended.rowIds.length,
        cols: extended.colIds.length,
    });

    await page.keyboard.down(process.platform === 'darwin' && browserName === 'webkit' ? 'Meta' : 'Control');
    await drag(page, cell('8', 'm5'), cell('9', 'm5'));
    await page.keyboard.up(process.platform === 'darwin' && browserName === 'webkit' ? 'Meta' : 'Control');
    const twoRanges = await page.evaluate(() => window.__ig.api.getRanges().length);
    record('Ctrl or Cmd plus drag adds a second range', twoRanges === 2, { twoRanges });

    await reset(page);
    // A range across pinned and scrolled center columns, extended past the viewport by autoscroll.
    await clickCell(page, '2', 'name');
    await page.evaluate(() => window.__ig.api.geometry.setScroll({ left: 0 }));
    const start = await page.locator(cell('2', 'name')).boundingBox();
    const viewport = await page.locator('[data-grid-part="viewport"]').boundingBox();
    await page.mouse.move(start.x + 10, start.y + 10);
    await page.mouse.down();
    await page.mouse.move(start.x + 200, viewport.y + viewport.height - 4, { steps: 5 });
    await page.waitForTimeout(600);
    await page.mouse.up();
    await settle(page);
    const autoscrolled = await page.evaluate(() => ({
        top: window.__ig.api.geometry.getScroll().top,
        rows: window.__ig.api.getResolvedRanges()[0]?.rowIds.length ?? 0,
    }));
    await page.waitForTimeout(300);
    const scrollAfterRelease = await page.evaluate(() => window.__ig.api.geometry.getScroll().top);
    record(
        'dragging at the bottom edge autoscrolls and keeps extending the range; release stops it',
        autoscrolled.top > 100 && autoscrolled.rows > 25 && Math.abs(scrollAfterRelease - autoscrolled.top) < 1,
        { ...autoscrolled, scrollAfterRelease }
    );

    await reset(page);
    await drag(page, cell('1', 'fee'), cell('4', 'fee'));
    const aggregation = await page.evaluate(() => {
        const api = window.__ig.api;
        const values = api
            .getResolvedRanges()[0]
            .rowIds.map((id) => window.__ig.rows[id].fee)
            .filter((value) => typeof value === 'number');

        return { expected: values.reduce((a, b) => a + b, 0), count: values.length };
    });
    record(
        'range values are logical: the ranges resolve to row ids, not DOM order',
        aggregation.count === 4,
        aggregation
    );

    // Clipboard and fill
    const copied = await clipboardEvent(page, 'copy');
    const expectedCopy = await page.evaluate(() =>
        [1, 2, 3, 4].map((id) => String(window.__ig.rows[id].fee ?? '')).join('\n')
    );
    record(
        'copy writes TSV and an HTML table of the range',
        copied.prevented && copied.text === expectedCopy && copied.html.includes('<table'),
        { text: copied.text, expectedCopy }
    );

    await reset(page);
    await clickCell(page, '20', 'name');
    const pasted = await clipboardEvent(page, 'paste', 'Pasted A\t5\nPasted B\tnot a number\nreject\t9');
    await waitFor(
        page,
        () =>
            window.__ig.pasteCalls.length > 0 &&
            document.querySelector('[data-row-id="22"] [data-col-id="name"][data-invalid]') !== null
    );
    const after = { a: await row(page, 20), b: await row(page, 21), c: await row(page, 22) };
    const invalid = await page
        .locator('[data-grid-part="cell"][data-invalid]')
        .evaluateAll((cells) =>
            cells.map((c) => `${c.closest('[data-row-id]').dataset.rowId}/${c.dataset.colId}`).sort()
        );
    record(
        'paste writes a matrix from the focus, parses numbers, marks bad values and rolls back server rejections',
        pasted.prevented &&
            after.a.name === 'Pasted A' &&
            after.a.fee === 5 &&
            after.b.name === 'Pasted B' &&
            after.b.fee === null &&
            after.c.name === 'Deal 22' &&
            after.c.fee === 9 &&
            same(invalid, ['21/fee', '22/name']),
        {
            after: { a: [after.a.name, after.a.fee], b: [after.b.name, after.b.fee], c: [after.c.name, after.c.fee] },
            invalid,
        }
    );

    await reset(page);
    await drag(page, cell('30', 'm1'), cell('31', 'm2'));
    await page.keyboard.press('Delete');
    await settle(page);
    const cleared = await page.evaluate(() => [
        window.__ig.rows[30].m1,
        window.__ig.rows[30].m2,
        window.__ig.rows[31].m1,
        window.__ig.rows[31].m2,
    ]);
    record(
        'Delete clears the range',
        cleared.every((value) => value === null),
        { cleared }
    );

    await reset(page);
    await page.evaluate(() => {
        window.__ig.rows[33].m4 = 1;
        window.__ig.rows[34].m4 = 2;
    });
    await page.evaluate(() => window.__ig.api.refreshCells());
    await drag(page, cell('33', 'm4'), cell('34', 'm4'));
    await page.waitForSelector('[data-grid-part="fill-handle"]');
    const handle = await page.locator('[data-grid-part="fill-handle"]').boundingBox();
    const fillTo = await page.locator(cell('38', 'm4')).boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(fillTo.x + 10, fillTo.y + 10, { steps: 6 });
    const previewCells = await page.locator('[data-fill-target]').count();
    await page.mouse.up();
    await waitFor(page, () => window.__ig.rows[38].m4 === 2);
    const filled = await page.evaluate(() => [33, 34, 35, 36, 37, 38].map((id) => window.__ig.rows[id].m4));
    record(
        'the fill handle previews and repeats the source down',
        previewCells === 6 && same(filled, [1, 2, 1, 2, 1, 2]),
        { previewCells, filled }
    );

    await reset(page);
    await page.evaluate(() => {
        const api = window.__ig.api;
        api.geometry.ensureCellVisible({ rowId: '34', colId: 'm8' }, 'center');
        api.setRanges([{ anchor: { rowId: '33', colId: 'm8' }, end: { rowId: '34', colId: 'm8' } }]);
    });
    await settle(page);
    await page.evaluate(() => {
        const api = window.__ig.api;
        const handle = document.querySelector('[data-grid-part="fill-handle"]').getBoundingClientRect();
        const edge = api.geometry.edgeProximity(handle.x + handle.width / 2, handle.y + handle.height / 2);
        api.geometry.scrollBy({ left: 10 - edge.right });
    });
    await settle(page);
    const edgeHandle = await page.locator('[data-grid-part="fill-handle"]').boundingBox();
    const beforeEdgeFill = await page.evaluate(() => {
        const api = window.__ig.api;
        const handle = document.querySelector('[data-grid-part="fill-handle"]').getBoundingClientRect();
        return {
            left: api.geometry.getScroll().left,
            right: api.geometry.edgeProximity(handle.x + handle.width / 2, handle.y + handle.height / 2).right,
        };
    });
    await page.mouse.move(edgeHandle.x + edgeHandle.width / 2, edgeHandle.y + edgeHandle.height / 2);
    await page.mouse.down();
    await settle(page);
    const edgeFillLeft = await page.evaluate(() => window.__ig.api.geometry.getScroll().left);
    const edgeTarget = await page.locator(cell('38', 'm8')).boundingBox();
    await page.mouse.move(edgeTarget.x + edgeTarget.width / 2, edgeTarget.y + edgeTarget.height / 2, { steps: 6 });
    await page.mouse.up();
    await settle(page);
    const edgeRange = await page.evaluate(() => window.__ig.api.getResolvedRanges()[0]);
    record(
        'a fill handle at the horizontal edge keeps its column still and extends rows',
        Math.abs(edgeFillLeft - beforeEdgeFill.left) < 1 &&
            beforeEdgeFill.right >= 0 &&
            beforeEdgeFill.right < 48 &&
            edgeRange.endIndex === 38,
        { beforeEdgeFill, edgeFillLeft, endIndex: edgeRange.endIndex }
    );

    // Menus and overlays
    await reset(page);
    await page.locator(cell('7', 'name')).click({ button: 'right' });
    await page.waitForSelector('[data-grid-part="menu"]');
    const menu = await page.evaluate(() => ({
        open: document.querySelector('[data-grid-part="menu"]').matches(':popover-open'),
        items: [...document.querySelectorAll('[data-menu-item]')].map(
            (item) => `${item.dataset.menuItem}${item.disabled ? ':disabled' : ''}`
        ),
    }));
    await page.locator('[data-menu-item="open"]').click();
    await settle(page);
    const closed = await page.locator('[data-grid-part="menu"]').count();
    await page.locator(cell('2', 'name')).click({ button: 'right' });
    const locked = await page.locator('[data-menu-item="delete"]').isDisabled();
    await page.keyboard.press('Escape');
    await settle(page);
    const escClosed = await page.locator('[data-grid-part="menu"]').count();
    const menuLog = await page.evaluate(() => [...window.__ig.menuLog]);
    record(
        'the context menu shows built-ins and permission-aware items, runs them and closes',
        menu.open &&
            same(menu.items, ['copy', 'copyWithHeaders', 'paste', 'open', 'delete', 'more']) &&
            closed === 0 &&
            locked &&
            escClosed === 0 &&
            same(menuLog, ['open 7']),
        { menu, closed, locked, escClosed, menuLog }
    );

    // Submenus open on hover and close when the pointer leaves; a click opens, never toggles shut.
    await page.locator(cell('8', 'name')).click({ button: 'right' });
    await page.locator('[data-menu-item="more"]').hover();
    const hoverOpen = await page.locator('[data-menu-item="more/log"]').isVisible();
    await page.locator('[data-menu-item="open"]').hover();
    const leaveClosed = (await page.locator('[data-menu-item="more/log"]').count()) === 0;
    await page.locator('[data-menu-item="more"]').click();
    const clickOpen = await page.locator('[data-menu-item="more/log"]').isVisible();
    await page.locator('[data-menu-item="more/log"]').click();
    await settle(page);
    const subLog = await page.evaluate(() => window.__ig.menuLog.at(-1));
    await page.locator(cell('8', 'name')).click({ button: 'right' });
    await page.locator('[data-menu-item="more"]').focus();
    await page.keyboard.press('ArrowRight');
    const keyOpen = await page.locator('[data-menu-item="more/log"]').isVisible();
    await page.keyboard.press('ArrowLeft');
    const keyClosed = (await page.locator('[data-menu-item="more/log"]').count()) === 0;
    await page.keyboard.press('Escape');
    await settle(page);
    record(
        'submenus open on hover, click and ArrowRight, and close on leave and ArrowLeft',
        hoverOpen && leaveClosed && clickOpen && subLog === 'log 8' && keyOpen && keyClosed,
        { hoverOpen, leaveClosed, clickOpen, subLog, keyOpen, keyClosed }
    );

    await page.locator('[data-grid-part="header-cell"][data-col-id="m2"]').click({ button: 'right' });
    await page.locator('[data-menu-item="hide"]').click();
    await settle(page);
    const hidden = await page.locator('[data-grid-part="header-cell"][data-col-id="m2"]').count();
    await page.evaluate(() => window.__ig.api.setColumnsVisible(['m2'], true));
    record('the header menu runs its items (hide column)', hidden === 0, { hidden });

    // Closing a menu returns focus to the grid without focusing a cell; tabbing in still focuses the first.
    await reset(page);
    await page.locator('[data-grid-part="header-cell"][data-col-id="m2"]').click({ button: 'right' });
    await page.waitForSelector('[data-grid-part="menu"]');
    await page.keyboard.press('Escape');
    await settle(page);
    const afterMenu = await page.evaluate(() => ({
        focusInGrid: Boolean(document.activeElement?.closest('[data-grid-part="root"]')),
        focusedCell: window.__ig.api.getFocusedCell(),
    }));
    await page.evaluate(() => document.activeElement?.blur());
    await page.locator('[data-test="before-grid"], input, button').first().focus();
    let tabbedIn = null;
    for (let i = 0; i < 20 && !tabbedIn; i++) {
        await page.keyboard.press('Tab');
        tabbedIn = await page.evaluate(() =>
            document.activeElement?.closest('[data-grid-part="root"]') ? window.__ig.api.getFocusedCell() : null
        );
    }
    record(
        'closing a menu leaves no cell focused; tabbing into the grid focuses the first cell',
        afterMenu.focusInGrid && afterMenu.focusedCell === null && tabbedIn !== null,
        { afterMenu, tabbedIn }
    );

    await clickCell(page, '3', 'name');
    await page.keyboard.press('Shift+F10');
    const keyboardMenu = await page.evaluate(() => ({
        open: Boolean(document.querySelector('[data-grid-part="menu"]')),
        focusInMenu: Boolean(document.activeElement?.closest('[data-grid-part="menu"]')),
    }));
    await page.keyboard.press('Escape');
    record(
        'Shift+F10 opens the context menu from the keyboard with focus in it',
        keyboardMenu.open && keyboardMenu.focusInMenu,
        keyboardMenu
    );

    // Right-click keeps the selection visible, and acts on the cell under the pointer.
    await reset(page);
    await clickCell(page, '3', 'name');
    await page.locator(cell('3', 'name')).click({ button: 'right' });
    await page.waitForSelector('[data-grid-part="menu"]');
    await settle(page);
    const ringColor = (rowId, colId) =>
        page.evaluate(
            ({ r, c }) =>
                getComputedStyle(document.querySelector(`[data-row-id="${r}"] [data-col-id="${c}"]`)).boxShadow,
            { r: rowId, c: colId }
        );
    const withMenu = {
        focused: await ringColor('3', 'name'),
        plain: await ringColor('5', 'name'),
        focusInMenu: await page.evaluate(() => Boolean(document.activeElement?.closest('[data-grid-part="menu"]'))),
    };
    await page.keyboard.press('Escape');
    await settle(page);
    await page.locator(cell('6', 'name')).click({ button: 'right' });
    await page.waitForSelector('[data-grid-part="menu"]');
    const movedTo = await page.evaluate(() => window.__ig.api.getFocusedCell());
    await page.keyboard.press('Escape');
    await settle(page);
    await page.evaluate(() =>
        window.__ig.api.setRanges([{ anchor: { rowId: '2', colId: 'name' }, end: { rowId: '4', colId: 'name' } }])
    );
    await settle(page);
    await page.locator(cell('3', 'name')).click({ button: 'right' });
    await page.waitForSelector('[data-grid-part="menu"]');
    const rangesKept = await page.evaluate(() => window.__ig.api.getRanges().length);
    await page.keyboard.press('Escape');
    await settle(page);
    record(
        'right-click keeps the focus ring while the menu is open, focuses an unselected cell, and keeps a range it lands in',
        withMenu.focusInMenu &&
            withMenu.focused !== withMenu.plain &&
            movedTo?.rowId === '6' &&
            movedTo?.colId === 'name' &&
            rangesKept === 1,
        { withMenu, movedTo, rangesKept }
    );

    await page.evaluate(() => window.__ig.api.setQuickFilter('no such deal'));
    await page.waitForSelector('[data-test="empty"]');
    const emptyShown = await page.locator('[data-grid-part="overlay"][data-overlay="empty"]').isVisible();
    await page.evaluate(() => window.__ig.api.setQuickFilter(''));
    await page.waitForSelector('[data-row-id="1"]');
    await page.evaluate(() => window.__ig.api.setOverlay('loading'));
    const loading = await page.locator('[data-overlay="loading"]').textContent();
    await page.evaluate(() => window.__ig.api.setOverlay(null));
    const footer = await page.locator('[data-test="footer"]').textContent();
    record(
        'empty and loading overlays and the footer slot render',
        emptyShown && loading === 'Loading…' && footer === '2000 deals',
        { emptyShown, loading, footer }
    );

    // Column state
    await reset(page);
    const resizeHandle = await page
        .locator('[data-grid-part="header-cell"][data-col-id="code"] [data-grid-part="resize-handle"][data-edge="end"]')
        .boundingBox();
    await page.mouse.move(resizeHandle.x + 3, resizeHandle.y + 5);
    await page.mouse.down();
    await page.mouse.move(resizeHandle.x + 63, resizeHandle.y + 5, { steps: 5 });
    await page.mouse.up();
    await settle(page);
    const resizedWidths = await page.evaluate(() => ({
        header: document.querySelector('[data-grid-part="header-cell"][data-col-id="code"]').getBoundingClientRect()
            .width,
        body: document.querySelector('[data-row-id="1"] [data-col-id="code"]').getBoundingClientRect().width,
        state: window.__ig.api.getColumnState().find((entry) => entry.colId === 'code').width,
    }));
    record(
        'resizing a header keeps header and body widths equal and records it in column state',
        Math.abs(resizedWidths.header - 170) < 1 &&
            resizedWidths.header === resizedWidths.body &&
            resizedWidths.state === 170,
        resizedWidths
    );

    await page.locator('[data-grid-part="header-cell"][data-col-id="name"] [data-grid-part="header-label"]').click();
    await page
        .locator('[data-grid-part="header-cell"][data-col-id="fee"] [data-grid-part="header-label"]')
        .click({ modifiers: ['Shift'] });
    await settle(page);
    const sort = await page.evaluate(() => ({
        model: window.__ig.api.getSortModel(),
        firstRow: document.querySelector('[data-grid-part="body"] [data-row-id]').dataset.rowId,
        ariaSort: document
            .querySelector('[data-grid-part="header-cell"][data-col-id="name"]')
            .getAttribute('aria-sort'),
    }));
    record(
        'header clicks sort; Shift adds a second sort column',
        same(sort.model, [
            { colId: 'name', sort: 'asc' },
            { colId: 'fee', sort: 'asc' },
        ]) &&
            sort.firstRow === '0' &&
            sort.ariaSort === 'ascending',
        sort
    );

    await page.locator('[data-grid-part="group-toggle"]').first().click();
    await settle(page);
    const notesShown = await page.locator('[data-grid-part="header-cell"][data-col-id="notes"]').count();
    const saved = await page.evaluate(() => ({
        columns: window.__ig.api.getColumnState(),
        groups: window.__ig.api.getColumnGroupState(),
    }));
    await page.evaluate(() => {
        window.__ig.api.resetColumnState();
        window.__ig.api.resetColumnGroupState();
    });
    await settle(page);
    const resetDiffers = await page.evaluate(
        (state) => JSON.stringify(window.__ig.api.getColumnState()) !== JSON.stringify(state.columns),
        saved
    );
    await page.evaluate((state) => {
        window.__ig.api.applyColumnState(state.columns, { applyOrder: true });
        window.__ig.api.setColumnGroupState(state.groups);
    }, saved);
    await settle(page);
    const restored = await page.evaluate(
        (state) => ({
            same: JSON.stringify(window.__ig.api.getColumnState()) === JSON.stringify(state.columns),
            codeWidth: document
                .querySelector('[data-grid-part="header-cell"][data-col-id="code"]')
                .getBoundingClientRect().width,
            notes: document.querySelectorAll('[data-grid-part="header-cell"][data-col-id="notes"]').length,
            sort: window.__ig.api.getSortModel().length,
        }),
        saved
    );
    await page.evaluate(() => {
        window.__ig.api.setSortModel([]);
        window.__ig.api.resetColumnGroupState();
    });
    record(
        'column state and group state round trip: reset, then apply the saved state',
        notesShown === 1 &&
            resetDiffers &&
            restored.same &&
            Math.abs(restored.codeWidth - 170) < 1 &&
            restored.notes === 1 &&
            restored.sort === 2,
        { notesShown, resetDiffers, restored }
    );

    const events = await page.evaluate(() => {
        const names = window.__ig.events.map((event) => event.name);

        return {
            ready: names.filter((name) => name === 'ready').length,
            firstRows: names.filter((name) => name === 'firstRowsRendered').length,
            firstRowsAfterReady: names.indexOf('firstRowsRendered') > names.indexOf('ready'),
            kinds: [...new Set(names)].sort(),
        };
    });
    record(
        'events fire through the on prop, ready once, firstRowsRendered once after it',
        events.ready === 1 &&
            events.firstRows === 1 &&
            events.firstRowsAfterReady &&
            [
                'cellValueChanged',
                'editStarted',
                'editStopped',
                'selectionChanged',
                'focusChanged',
                'rangesChanged',
                'columnStateChanged',
            ].every((name) => events.kinds.includes(name)),
        events
    );

    record('no page errors or console errors', errors.length === 0, { errors: errors.slice(0, 5) });
}

const configFile = join(root, 'playground/vite.config.ts');
await build({ configFile, logLevel: 'warn' });
const server = await preview({ configFile, preview: { port, strictPort: true }, logLevel: 'warn' });
const browserType = { chromium, firefox, webkit }[browserName];
const browser = await browserType.launch();
results.environment = { browser: `${browserName} ${browser.version()}`, platform: process.platform };
try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 800 } });
    const page = await context.newPage();
    await checks(page);
    // headerFilterButton 'always' and app icons (?header=app).
    await page.goto(`http://localhost:${port}/?fixture=interactive&header=app`);
    await page.waitForSelector(cell('0', 'name'));
    await settle(page);
    const header = await page.evaluate(() => {
        const name = document.querySelector('[data-grid-part="header-cell"][data-col-id="name"]');
        const toggle = document.querySelector('[data-grid-part="group-toggle"]');

        return {
            filterButton: Boolean(name?.querySelector('[data-grid-part="header-filter-button"]:not([data-active])')),
            suppressed: !document.querySelector(
                '[data-grid-part="header-cell"][data-col-id="currency"] [data-grid-part="header-filter-button"]'
            ),
            toggleIcon: toggle?.querySelector('[data-test^="icon-group-"]')?.dataset.test ?? null,
            toggleLabel: toggle?.getAttribute('aria-label') ?? null,
        };
    });
    await page.evaluate(() => window.__ig.api.setSortModel([{ colId: 'name', sort: 'asc' }]));
    await settle(page);
    const sortIcon = await page.evaluate(
        () =>
            document.querySelector('[data-grid-part="header-cell"][data-col-id="name"] [data-test="icon-asc"]') !== null
    );
    record(
        'filterable columns show the filter button with headerFilterButton always; app icons replace the glyphs',
        header.filterButton &&
            header.toggleIcon !== null &&
            /^(Expand|Collapse) /.test(header.toggleLabel ?? '') &&
            sortIcon,
        { ...header, sortIcon }
    );
    // Pinned rows (?pinned=1): the summary under the header, the total sticky at the bottom, both read only.
    await page.goto(`http://localhost:${port}/?fixture=interactive&pinned=1`);
    await page.waitForSelector('[data-grid-part="pinned-bottom"] [data-grid-part="row"]');
    await settle(page);
    const pinnedAt = async () =>
        page.evaluate(() => {
            const viewport = document.querySelector('[data-grid-part="viewport"]').getBoundingClientRect();
            const header = [...document.querySelectorAll('[data-grid-part="header-row"]')]
                .at(-1)
                .getBoundingClientRect();
            const top = document.querySelector('[data-row-pinned="top"]').getBoundingClientRect();
            const bottom = document.querySelector('[data-row-pinned="bottom"]').getBoundingClientRect();
            const rows = [...document.querySelectorAll('[data-grid-part="body"] [data-grid-part="row"]')];
            const lastBody = rows.at(-1).getBoundingClientRect();
            const vp = document.querySelector('[data-grid-part="viewport"]');
            const hScroll = vp.offsetHeight - vp.clientHeight;

            return {
                topUnderHeader: Math.abs(top.top - header.bottom) <= 1,
                bottomAtEdge: Math.abs(bottom.bottom - (viewport.bottom - hScroll)) <= 1,
                lastBodyAbove: lastBody.bottom <= bottom.top + 1,
                total: document.querySelector('[data-row-pinned="bottom"] [data-col-id="name"]')?.textContent,
                totalBackground: getComputedStyle(document.querySelector('[data-row-pinned="bottom"]')).backgroundColor,
                checkbox: Boolean(document.querySelector('[data-row-pinned] [data-grid-part="row-checkbox"]')),
                absolute: [
                    ...document.querySelectorAll(
                        '[data-grid-part="pinned-top"], [data-grid-part="pinned-bottom"], [data-row-pinned]'
                    ),
                ].some((element) => ['absolute', 'fixed'].includes(getComputedStyle(element).position)),
            };
        });
    const pinnedStart = await pinnedAt();
    await page.evaluate(() => window.__ig.api.geometry.setScroll({ top: 1e9 }));
    await settle(page);
    const pinnedEnd = await pinnedAt();
    await page.locator('[data-row-pinned="bottom"] [data-col-id="name"]').click();
    const pinnedFocus = await page.evaluate(() => window.__ig.api.getFocusedCell());
    record(
        'pinned rows sit under the header and at the bottom edge, never cover the last row, and are read only',
        pinnedStart.topUnderHeader &&
            pinnedStart.bottomAtEdge &&
            pinnedEnd.topUnderHeader &&
            pinnedEnd.bottomAtEdge &&
            pinnedEnd.lastBodyAbove &&
            pinnedStart.total === 'Total' &&
            pinnedStart.totalBackground === 'rgb(1, 2, 3)' &&
            !pinnedStart.checkbox &&
            !pinnedStart.absolute &&
            pinnedFocus === null,
        { pinnedStart, pinnedEnd, pinnedFocus }
    );
    // editorEscape: by default Escape stays in the grid; with 'propagate' the page also sees it.
    const escapeReaches = async (query) => {
        await page.goto(`http://localhost:${port}/?fixture=interactive${query}`);
        await page.waitForSelector(cell('5', 'name'));
        await settle(page);
        await page.evaluate(() => {
            window.__escapes = 0;
            document.addEventListener('keydown', (event) => event.key === 'Escape' && window.__escapes++);
        });
        await page.locator(cell('5', 'name')).dblclick();
        await page.waitForSelector('[data-grid-part="cell"][data-editing]');
        await page.keyboard.press('Escape');
        await settle(page);

        return page.evaluate(() => ({
            escapes: window.__escapes,
            editing: Boolean(document.querySelector('[data-grid-part="cell"][data-editing]')),
        }));
    };
    const escapeStop = await escapeReaches('');
    const escapePropagate = await escapeReaches('&escape=propagate');
    record(
        'Escape cancels an edit; editorEscape propagate also lets the page see it',
        !escapeStop.editing && escapeStop.escapes === 0 && !escapePropagate.editing && escapePropagate.escapes === 1,
        { escapeStop, escapePropagate }
    );
} catch (error) {
    record('checks ran to completion', false, { error: String(error?.stack ?? error).slice(0, 600) });
} finally {
    await browser.close();
    server.httpServer.close();
}

const suffix = browserName === 'chromium' ? '' : `-${browserName}`;
mkdirSync(join(root, 'playground/results'), { recursive: true });
writeFileSync(join(root, `playground/results/interactive-results${suffix}.json`), JSON.stringify(results, null, 2));
const failed = results.checks.filter((check) => !check.pass).length;
console.log(`${results.checks.length - failed}/${results.checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
