#!/usr/bin/env node
import { chromium, firefox, webkit } from 'playwright';
import { build, preview } from 'vite';

import { decodePng } from './png.mjs';

/**
 * Grouping browser checks: grouping in the group column and as full-width rows, tree data from paths,
 * master/detail with measured, growing detail rows, and server groups in the group column.
 * Writes playground/results/groups-results[-browser].json.
 *
 * Usage: node playground/checks/groups.mjs [--browser=chromium|firefox|webkit]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const port = 5187;
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

async function openMode(page, mode) {
    await page.goto(`http://localhost:${port}/?fixture=groups&mode=${mode}`);
    await page.waitForSelector('[data-grid-part="body"] [data-grid-part="row"]');
    await settle(page);
}

const rowsInfo = (page) =>
    page.evaluate(() =>
        [...document.querySelectorAll('[data-grid-part="body"] [data-grid-part="row"]')].map((row) => {
            const groupCell =
                row.querySelector('[data-col-id="__group__"], [data-col-id="task"]') ??
                row.querySelector('[data-grid-part="cell"]');
            const label = row.querySelector('[data-grid-part="row-group-label"]');
            const content = row.querySelector('[data-grid-part="group-cell-content"]');
            const box = row.getBoundingClientRect();

            return {
                id: row.dataset.rowId,
                kind: row.dataset.rowKind,
                label: label?.textContent ?? null,
                count: row.querySelector('[data-grid-part="row-group-count"]')?.textContent ?? null,
                indent: content ? parseFloat(getComputedStyle(content).paddingInlineStart) : null,
                fullWidth: Boolean(row.querySelector('[data-grid-part="full-width-row"]')),
                top: Math.round(box.top),
                height: Math.round(box.height),
                team: row.querySelector('[data-col-id="team"]')?.textContent ?? null,
                city: row.querySelector('[data-col-id="city"]')?.textContent ?? null,
                hasCell: Boolean(groupCell),
            };
        })
    );

const headers = (page) =>
    page.evaluate(() =>
        [...document.querySelectorAll('[data-grid-part="header-cell"]')].map((cell) => cell.dataset.colId)
    );

async function checks(page) {
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));

    // Grouping in the group column.
    await openMode(page, 'group');
    const columnIds = await headers(page);
    const top = await rowsInfo(page);
    await page.locator('[data-row-kind="group"] [data-grid-part="row-expand-toggle"]').first().click();
    await settle(page);
    await page.locator('[data-row-kind="group"] [data-grid-part="row-expand-toggle"]').nth(1).click();
    await settle(page);
    const opened = await rowsInfo(page);
    const leaves = opened.filter((row) => row.kind === 'data');
    record(
        'grouped rows show in a group column first, with labels, counts and indentation by level',
        columnIds[0] === '__group__' &&
            top.length === 4 &&
            top.every((row) => row.kind === 'group' && !row.fullWidth) &&
            top[0].label === 'Admin' &&
            top[0].count === '(1250)' &&
            opened[1].kind === 'group' &&
            opened[1].label === 'Amsterdam' &&
            opened[1].indent > opened[0].indent &&
            leaves.length > 5 &&
            leaves.every((row) => row.team === 'Admin' && row.city === 'Amsterdam') &&
            leaves[0].indent > opened[1].indent,
        {
            columnIds: columnIds.slice(0, 3),
            top: top.map((row) => `${row.label} ${row.count}`),
            sub: opened[1].label,
            indents: [opened[0].indent, opened[1].indent, leaves[0]?.indent],
        }
    );

    // Keyboard: Enter on a group cell closes and opens it.
    await page.locator('[data-row-kind="group"] [data-col-id="__group__"]').first().click();
    await page.keyboard.press('Enter');
    await settle(page);
    const closed = await rowsInfo(page);
    await page.keyboard.press('Enter');
    await settle(page);
    const reopened = await rowsInfo(page);
    record(
        'Enter on a group cell closes and reopens the group, keeping inner groups as they were',
        closed.length === 4 && reopened[1].label === 'Amsterdam' && reopened[2].kind === 'data',
        { closed: closed.length, reopenedSecond: reopened[1].label, third: reopened[2].kind }
    );

    // Full-width group rows with a custom renderer.
    await openMode(page, 'rows');
    const rowColumns = await headers(page);
    const custom = await page.evaluate(() =>
        [...document.querySelectorAll('[data-test="custom-group-row"]')].map((row) => row.textContent)
    );
    await page.locator('[data-test="custom-group-toggle"]').first().click();
    await settle(page);
    const afterToggle = await rowsInfo(page);
    record(
        'full-width group rows use the custom renderer and no group column',
        !rowColumns.includes('__group__') &&
            custom.length === 4 &&
            custom[0].includes('Admin') &&
            custom[0].includes('1250 people') &&
            afterToggle[1].kind === 'group' &&
            afterToggle[1].fullWidth,
        { columns: rowColumns.length, first: custom[0], second: afterToggle[1].kind }
    );

    // Tree data from paths.
    await openMode(page, 'tree');
    const tree = await rowsInfo(page);
    const treeCount = await page.evaluate(() => window.__grp.api.rows.getRowCount());
    const phase = tree.find((row) => row.label === 'Phase 1');
    await page.locator(`[data-row-id=${JSON.stringify(phase.id)}] [data-grid-part="row-expand-toggle"]`).click();
    await settle(page);
    const treeOpen = await rowsInfo(page);
    const phaseIndex = treeOpen.findIndex((row) => row.id === phase.id);
    const tasks = treeOpen.slice(phaseIndex + 1, phaseIndex + 5);
    const treeHeaders = await headers(page);
    record(
        'tree rows show their path key in the group column; filler levels group their children; the first level starts open',
        treeHeaders[0] === '__group__' &&
            tree[0].label === 'Project 0' &&
            tree[0].kind === 'data' &&
            phase.kind === 'group' &&
            phase.count === '(4)' &&
            treeCount === 160 &&
            tasks.map((row) => row.label).join() === 'Task 1,Task 2,Task 3,Task 4' &&
            tasks.every((row) => row.kind === 'data' && row.indent > phase.indent),
        {
            first: tree[0].label,
            phase: `${phase.label} ${phase.count}`,
            treeCount,
            tasks: tasks.map((row) => row.label),
        }
    );

    // Master/detail: detail rows are measured and follow their content.
    await openMode(page, 'detail');
    await page.locator('[data-row-id="0"] [data-grid-part="row-expand-toggle"]').click();
    await page.waitForSelector('[data-test="detail-0"]');
    await settle(page);
    const detailRow = async () => {
        const rows = await rowsInfo(page);
        const detail = rows.find((row) => row.kind === 'detail');
        const next = rows[rows.indexOf(detail) + 1];

        return { detail, next };
    };
    const first = await detailRow();
    const content = await page.evaluate(() =>
        Math.round(document.querySelector('[data-test="detail-0"]').getBoundingClientRect().height)
    );
    await page.locator('[data-test="detail-0-add"]').click();
    await page.locator('[data-test="detail-0-add"]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-test="detail-0"] li').length === 3);
    await settle(page);
    await settle(page);
    const grown = await detailRow();
    record(
        'a detail row is as tall as its content, and rows below move when it grows',
        first.detail.height >= content &&
            first.detail.height > 32 &&
            first.next.top === first.detail.top + first.detail.height &&
            grown.detail.height > first.detail.height + 20 &&
            grown.next.top === grown.detail.top + grown.detail.height &&
            grown.next.id === '1',
        {
            before: first.detail.height,
            content,
            after: grown.detail.height,
            nextTop: grown.next.top,
            detailBottom: grown.detail.top + grown.detail.height,
        }
    );
    await page.locator('[data-row-id="0"] [data-grid-part="row-expand-toggle"]').click();
    await settle(page);
    const collapsed = await rowsInfo(page);
    record(
        'closing a master row removes its detail row',
        !collapsed.some((row) => row.kind === 'detail') && collapsed[1].id === '1',
        { second: collapsed[1].id }
    );

    // Server groups in the group column.
    await page.goto(`http://localhost:${port}/?fixture=server&groupDisplay=column`);
    await page.waitForSelector('[data-row-id="0"]');
    await page.locator('[data-test="group-team"]').check();
    await page.waitForSelector('[data-row-kind="group"] [data-grid-part="row-group-label"]');
    await settle(page);
    const serverHeaders = await headers(page);
    const serverGroups = await rowsInfo(page);
    await page.locator('[data-row-kind="group"] [data-grid-part="row-expand-toggle"]').first().click();
    await page.waitForFunction(
        () =>
            document.querySelector('[data-grid-part="body"] [data-row-kind="data"] [data-col-id="team"]')
                ?.textContent === 'Admin'
    );
    const serverOpen = await rowsInfo(page);
    record(
        'server groups show in the group column with their counts, and load children when opened',
        serverHeaders[0] === '__group__' &&
            serverGroups.length === 6 &&
            !serverGroups[0].fullWidth &&
            serverGroups[0].count === '(16667)' &&
            serverOpen[1].kind === 'data' &&
            serverOpen[1].team === 'Admin',
        {
            headers: serverHeaders.slice(0, 2),
            first: `${serverGroups[0].label} ${serverGroups[0].count}`,
            child: serverOpen[1].team,
        }
    );

    {
        // A range in the first column, right below a full-width group row: closed on every side.
        await openMode(page, 'rows');
        await page.locator('[data-test="custom-group-toggle"]').first().click();
        await settle(page);
        await page.locator('[data-row-kind="group"] [data-test="custom-group-toggle"]').nth(1).click();
        await settle(page);
        const leaves = await page.evaluate(() =>
            [...document.querySelectorAll('[data-grid-part="body"] [data-row-kind="data"]')]
                .slice(0, 4)
                .map((row) => row.dataset.rowId)
        );
        await page.evaluate(
            (ids) =>
                window.__grp.api.setRanges([
                    { anchor: { rowId: ids[0], colId: 'id' }, end: { rowId: ids[3], colId: 'name' } },
                ]),
            leaves
        );
        await page.mouse.move(5, 5);
        await settle(page);
        const box = await page.evaluate((ids) => {
            const first = document
                .querySelector(`[data-row-id="${ids[0]}"] [data-col-id="id"]`)
                .getBoundingClientRect();
            const last = document
                .querySelector(`[data-row-id="${ids[3]}"] [data-col-id="name"]`)
                .getBoundingClientRect();

            return {
                left: Math.round(first.left),
                top: Math.round(first.top),
                right: Math.round(last.right),
                bottom: Math.round(last.bottom),
            };
        }, leaves);
        const image = decodePng(
            await page.screenshot({
                clip: {
                    x: box.left - 2,
                    y: box.top - 3,
                    width: box.right - box.left + 4,
                    height: box.bottom - box.top + 5,
                },
            })
        );
        const at = (x, y) => image.pixel(x - box.left + 2, y - box.top + 3);
        const edge = at(box.right - 1, Math.round((box.top + box.bottom) / 2));
        const isEdge = (pixel) => pixel.every((value, index) => Math.abs(value - edge[index]) <= 12);
        const sides = { left: true, top: true, right: true, bottom: true };
        const misses = [];
        for (let y = box.top; y < box.bottom; y++) {
            if (!isEdge(at(box.left, y))) {
                misses.push(`L${y - box.top}:${at(box.left, y).join('/')}`);
            }
            sides.left &&= isEdge(at(box.left, y));
            sides.right &&= isEdge(at(box.right - 1, y));
        }
        for (let x = box.left + 1; x < box.right - 1; x++) {
            if (!isEdge(at(x, box.top - 1))) {
                misses.push(`T${x - box.left}:${at(x, box.top - 1).join('/')}`);
            }
            sides.top &&= isEdge(at(x, box.top - 1));
            if (!isEdge(at(x, box.bottom - 1))) {
                misses.push(`B${x - box.left}:${at(x, box.bottom - 1).join('/')}`);
            }
            sides.bottom &&= isEdge(at(x, box.bottom - 1));
        }
        record(
            'a range in the first column under a full-width group row is closed on all four sides',
            Object.values(sides).every(Boolean),
            { sides, edge, misses: misses.slice(0, 8), height: box.bottom - box.top }
        );
        await page.evaluate(() => window.__grp.api.clearRanges());
    }

    // A label renderer replaces only the label: the toggle and indent stay, counts can be turned off.
    await page.goto(`http://localhost:${port}/?fixture=groups&mode=tree&label=custom`);
    await page.waitForSelector('[data-test="custom-label"]');
    await settle(page);
    const customLabel = await page.evaluate(() => ({
        labels: document.querySelectorAll('[data-grid-part="group-cell-content"] [data-test="custom-label"]').length,
        counts: document.querySelectorAll('[data-grid-part="row-group-count"]').length,
        toggles: document.querySelectorAll('[data-grid-part="row-expand-toggle"] [data-test^="icon-"]').length,
    }));
    record(
        'a label renderer keeps the toggle and indent; showCount false hides counts; row icons apply',
        customLabel.labels > 0 && customLabel.counts === 0 && customLabel.toggles > 0,
        customLabel
    );
    // Sticky group rows: open a team and one of its cities, scroll into the city's people.
    await openMode(page, 'group');
    await page
        .locator('[data-grid-part="body"] [data-row-kind="group"] [data-grid-part="row-expand-toggle"]')
        .first()
        .click();
    await settle(page);
    await page
        .locator('[data-grid-part="body"] [data-row-kind="group"] [data-grid-part="row-expand-toggle"]')
        .nth(1)
        .click();
    await settle(page);
    const stuckAt = (scrollTop) =>
        page.evaluate((scrollTop) => {
            const viewport = document.querySelector('[data-grid-part="viewport"]');
            viewport.scrollTop = scrollTop;
            viewport.dispatchEvent(new Event('scroll'));

            return new Promise((resolve) =>
                requestAnimationFrame(() =>
                    requestAnimationFrame(() => {
                        const header = document.querySelector('[data-grid-part="header-row"]').getBoundingClientRect();
                        const stuck = [
                            ...document.querySelectorAll('[data-grid-part="sticky-rows"] [data-grid-part="row"]'),
                        ];
                        resolve({
                            stuck: stuck.map((row) => ({
                                id: row.dataset.rowId,
                                label: row.textContent.replace(/\s+/g, ' ').trim().slice(0, 30),
                                top: Math.round(row.getBoundingClientRect().top - header.bottom),
                                height: Math.round(row.getBoundingClientRect().height),
                            })),
                            copies: stuck.map(
                                (row) =>
                                    document.querySelectorAll(
                                        `[data-grid-part="row"][data-row-id="${CSS.escape(row.dataset.rowId)}"]`
                                    ).length
                            ),
                            placeholders: stuck.map((row) =>
                                Boolean(
                                    document.querySelector(
                                        `[data-grid-part="row-spacer"][data-row-id="${CSS.escape(row.dataset.rowId)}"]`
                                    )
                                )
                            ),
                            firstBodyRowUnderStack: (() => {
                                const bottom = stuck.length
                                    ? stuck.at(-1).getBoundingClientRect().bottom
                                    : header.bottom;
                                const row = [
                                    ...document.querySelectorAll('[data-grid-part="body"] [data-grid-part="row"]'),
                                ].find((candidate) => candidate.getBoundingClientRect().bottom > bottom + 1);

                                return row?.querySelector('[data-col-id="name"]')?.textContent ?? null;
                            })(),
                        });
                    })
                )
            );
        }, scrollTop);
    const atTop = await stuckAt(0);
    const inside = await stuckAt(400);
    record(
        'open group rows stick below the header, outermost first, and appear once',
        atTop.stuck.length === 0 &&
            inside.stuck.length === 2 &&
            inside.stuck[0].top === 0 &&
            inside.stuck[1].top === inside.stuck[0].height &&
            inside.copies.every((count) => count === 1) &&
            inside.placeholders.every(Boolean) &&
            inside.firstBodyRowUnderStack !== null,
        { atTop: atTop.stuck, inside }
    );
    const stuckToggle = page.locator('[data-grid-part="sticky-rows"] [data-grid-part="row-expand-toggle"]').nth(1);
    await stuckToggle.click();
    await settle(page);
    const afterClose = await page.evaluate(() =>
        [...document.querySelectorAll('[data-grid-part="row"][data-row-kind="group"]')]
            .map((row) => row.querySelector('[data-grid-part="row-expand-toggle"]')?.getAttribute('aria-expanded'))
            .slice(0, 3)
    );
    record("a stuck row's toggle closes its group", afterClose.includes('false') && afterClose[0] === 'true', {
        afterClose,
    });
    const absolute = await page.evaluate(() =>
        [...document.querySelectorAll('[data-grid-part="root"] *')].some((element) =>
            ['absolute', 'fixed'].includes(getComputedStyle(element).position)
        )
    );
    record('sticky rows use no absolute positioning', !absolute, { absolute });

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
writeFileSync(join(root, `playground/results/groups-results${suffix}.json`), JSON.stringify(results, null, 2));
const failed = results.checks.filter((check) => !check.pass).length;
console.log(`${results.checks.length - failed}/${results.checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
