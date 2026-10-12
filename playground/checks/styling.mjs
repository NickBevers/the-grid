#!/usr/bin/env node
import { chromium, firefox, webkit } from 'playwright';
import { build, preview } from 'vite';

import { decodePng } from './png.mjs';

/**
 * Styling browser checks. The default stylesheet renders every state from its tokens, in light and dark
 * schemes (forced and following the operating system) and both densities. The example brand theme
 * restyles the grid through tokens and public parts only. Plain application selectors override the
 * defaults without `!important`.
 * Writes playground/results/styling-results[-browser].json; exits non-zero on failure.
 *
 * Usage: node playground/checks/styling.mjs [--browser=chromium|firefox|webkit]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const port = 5197;
const browserName = process.argv.find((arg) => arg.startsWith('--browser='))?.split('=')[1] ?? 'chromium';
const results = { date: new Date().toISOString(), environment: {}, checks: [] };

function record(name, pass, details = {}) {
    results.checks.push({ name, pass, ...details });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(details)}`);
}

const cell = (rowId, colId) => `[data-row-id="${rowId}"] [data-grid-part="cell"][data-col-id="${colId}"]`;
const settle = (page) =>
    page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function open(page, query) {
    await page.goto(`http://localhost:${port}/?fixture=interactive&${query}`);
    await page.waitForSelector('[data-row-id="1"]');
    await settle(page);
}

/**
 * Collects computed styles for every state. Token values are resolved by a probe element inside the grid
 * root, so `light-dark()` and `color-mix()` resolve exactly as the grid's own rules do.
 */
async function collect(page) {
    await page.evaluate(() => {
        const api = window.__ig.api;
        api.setSelected(['3', '4', '5'], true);
        api.setRanges([{ anchor: { rowId: '8', colId: 'm1' }, end: { rowId: '9', colId: 'm2' } }]);
        api.setFocusedCell({ rowId: '11', colId: 'name' }, { scroll: false });
    });
    await page.locator('[data-grid-part="viewport"]').focus();
    await settle(page);

    const result = await page.evaluate(() => {
        const cellSelector = (rowId, colId) =>
            `[data-row-id="${rowId}"] [data-grid-part="cell"][data-col-id="${colId}"]`;
        const gridRoot = document.querySelector('[data-grid-part="root"]');
        const probe = document.createElement('div');
        gridRoot.appendChild(probe);
        const token = (name) => {
            probe.style.color = `var(${name})`;

            return getComputedStyle(probe).color;
        };
        const style = (selector) => getComputedStyle(document.querySelector(selector));
        const rowSelector = (id) => `[data-row-id="${id}"][data-grid-part="row"]`;
        const values = {
            tokens: {
                background: token('--the-grid-background'),
                header: token('--the-grid-header-background'),
                focus: token('--the-grid-focus-ring-color'),
                range: token('--the-grid-range-background'),
                rangeBorder: token('--the-grid-range-border-color'),
                selected: token('--the-grid-selected-row-background'),
                selectedBorder: token('--the-grid-selected-row-border-color'),
                fullWidth: token('--the-grid-full-width-row-background'),
                invalid: token('--the-grid-invalid-color'),
            },
            root: {
                background: style('[data-grid-part="root"]').backgroundColor,
                font: style('[data-grid-part="root"]').fontFamily,
            },
            header: style('[data-grid-part="header-row"]').backgroundColor,
            focused: {
                ring: style(cellSelector('11', 'name')).boxShadow,
                outlineStyle: style(cellSelector('11', 'name')).outlineStyle,
            },
            range: {
                background: style(cellSelector('8', 'm1')).backgroundColor,
                shadow: style(cellSelector('8', 'm1')).boxShadow,
            },
            rangeInner: style(cellSelector('9', 'm2')).boxShadow,
            selected: {
                tint: style(rowSelector('4')).backgroundImage,
                first: style(rowSelector('3')).boxShadow,
                middle: style(rowSelector('4')).boxShadow,
                last: style(rowSelector('5')).boxShadow,
                lastCell: style(`${rowSelector('5')} [data-col-id="name"]`).boxShadow,
                pinnedRight: style(`${rowSelector('3')} [data-grid-part="pinned-right"]`).boxShadow,
                pinnedBackground: style(`${rowSelector('4')} [data-grid-part="pinned-left"]`).backgroundColor,
            },
            cellPadding: style(cellSelector('1', 'name')).paddingLeft,
            rowHeight: document.querySelector(rowSelector('1')).getBoundingClientRect().height,
            widthsMatch: [...document.querySelectorAll('[data-grid-part="header-cell"]')].every((header) => {
                const body = document.querySelector(`[data-row-id="1"] [data-col-id="${header.dataset.colId}"]`);

                return (
                    !body || Math.abs(body.getBoundingClientRect().width - header.getBoundingClientRect().width) < 0.01
                );
            }),
        };
        probe.remove();

        return values;
    });
    // The section row is further down than the viewport shows.
    await page.evaluate(() =>
        window.__ig.api.geometry.ensureIndexVisible(window.__ig.api.rows.getIndexOf('50'), 'center')
    );
    await settle(page);
    result.fullWidth = await page.evaluate(
        () =>
            getComputedStyle(document.querySelector('[data-row-id="50"] [data-grid-part="full-width-row"]'))
                .backgroundColor
    );
    await page.evaluate(() => window.__ig.api.geometry.setScroll({ top: 0 }));
    await settle(page);

    return result;
}

async function checks(page) {
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));

    // Neutral theme, light.
    await open(page, 'theme=neutral&scheme=light');
    const light = await collect(page);
    record(
        'every state renders from its token (neutral, light)',
        light.root.background === light.tokens.background &&
            light.header === light.tokens.header &&
            light.focused.ring.includes(light.tokens.focus) &&
            light.range.background === light.tokens.range &&
            light.range.shadow.includes(light.tokens.rangeBorder) &&
            light.selected.tint.includes(light.tokens.selected) &&
            light.fullWidth === light.tokens.fullWidth,
        light
    );
    const top = '0px 1px 0px 0px inset';
    const bottom = '0px -1px 0px 0px inset';
    record(
        'a selected run is outlined as one block from the row model, through the pinned sections',
        light.selected.first.includes(top) &&
            !light.selected.first.includes(bottom) &&
            !light.selected.middle.includes(top) &&
            !light.selected.middle.includes(bottom) &&
            light.selected.lastCell.includes(light.tokens.selectedBorder) &&
            light.selected.first.includes(light.tokens.selectedBorder) &&
            light.selected.pinnedRight.includes(top),
        light.selected
    );
    record(
        'pinned sections stay opaque on tinted rows, so scrolled cells never show through',
        alpha(light.selected.pinnedBackground) === 1,
        {
            pinnedBackground: light.selected.pinnedBackground,
        }
    );
    // The focus ring sits on the grid lines: outer strips left, top and bottom and at the left corners, and an
    // inset strip over the cell's own right border. No outline.
    const ringParts = light.focused.ring
        .split(/,(?![^(]*\))/)
        .map((part) => part.trim())
        .filter((part) => part.includes(light.tokens.focus))
        .map((part) => part.replace(light.tokens.focus, '').trim());
    const expectedRing = ['-1px 0px 0px 0px', '0px -1px 0px 0px', '-1px -1px 0px 0px'];
    record(
        "focus rings are outer strips left, top and top-left plus the cell's own right and bottom lines",
        expectedRing.every((part) => ringParts.includes(part)) && light.focused.outlineStyle === 'none',
        { ringParts, outlineStyle: light.focused.outlineStyle }
    );
    record(
        'range edges draw on the outer cells only and never change widths',
        light.rangeInner !== light.range.shadow && light.widthsMatch,
        { inner: light.rangeInner, widthsMatch: light.widthsMatch }
    );
    record(
        'the neutral palette carries no brand colour',
        [light.tokens.focus, light.tokens.selectedBorder, light.tokens.rangeBorder].every((color) => isNeutral(color)),
        { focus: light.tokens.focus }
    );

    // Invalid and editing states.
    await page.evaluate(() => window.__ig.api.setFocusedCell({ rowId: '20', colId: 'fee' }, { scroll: false }));
    await page.locator('[data-grid-part="viewport"]').focus();
    await page.keyboard.press('F2');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('-1');
    await page.keyboard.press('Enter');
    await settle(page);
    const editing = await page.evaluate(() => ({
        cell: getComputedStyle(document.querySelector('[data-grid-part="cell"][data-editing]')).boxShadow,
        editor: getComputedStyle(document.querySelector('[data-grid-editor][data-invalid]')).outlineColor,
        error: getComputedStyle(document.querySelector('[data-grid-part="editor-error"]')).color,
    }));
    await page.keyboard.press('Escape');
    record(
        'editing and validation states use their tokens',
        editing.editor === light.tokens.invalid &&
            editing.error === light.tokens.invalid &&
            editing.cell.includes(light.tokens.focus),
        { editing, invalid: light.tokens.invalid }
    );

    // Scroll edges.
    await page.evaluate(() => window.__ig.api.geometry.setScroll({ left: 400, top: 300 }));
    await settle(page);
    const scrolled = await page.evaluate(() => ({
        flags: Object.keys(document.querySelector('[data-grid-part="root"]').dataset)
            .filter((key) => key.startsWith('scrolled'))
            .sort(),
        pinned: getComputedStyle(document.querySelector('[data-grid-part="row"] [data-grid-part="pinned-left"]'))
            .boxShadow,
        header: getComputedStyle(document.querySelector('[data-grid-part="header"]')).boxShadow,
    }));
    record(
        'scroll edges mark the root and shade the pinned section and header',
        ['scrolledLeft', 'scrolledRight', 'scrolledTop'].every((flag) => scrolled.flags.includes(flag)) &&
            scrolled.pinned !== 'none' &&
            scrolled.header !== 'none',
        scrolled
    );

    // Menu.
    await page.evaluate(() => window.__ig.api.geometry.setScroll({ left: 0, top: 0 }));
    await settle(page);
    await page.locator(cell('2', 'name')).click({ button: 'right' });
    await page.waitForSelector('[data-grid-part="menu"]');
    const menu = await page.evaluate(() => {
        const style = getComputedStyle(document.querySelector('[data-grid-part="menu"]'));

        return { background: style.backgroundColor, radius: style.borderTopLeftRadius, shadow: style.boxShadow };
    });
    await page.keyboard.press('Escape');
    record(
        'the default menu is themed',
        menu.background === light.tokens.background && menu.radius === '8px' && menu.shadow !== 'none',
        menu
    );

    // Dark tokens through the colorScheme prop, and the operating system preference with "system".
    await open(page, 'theme=neutral&scheme=dark');
    const dark = await collect(page);
    record(
        'colorScheme="dark" applies the dark tokens',
        luminance(dark.root.background) < 0.2 &&
            luminance(dark.header) < 0.3 &&
            dark.focused.ring.includes(dark.tokens.focus),
        { background: dark.root.background, header: dark.header }
    );
    await page.emulateMedia({ colorScheme: 'dark' });
    await open(page, 'theme=neutral&scheme=system');
    const systemDark = await collect(page);
    await page.emulateMedia({ colorScheme: 'light' });
    await open(page, 'theme=neutral&scheme=system');
    const systemLight = await collect(page);
    record(
        'colorScheme="system" follows the operating system',
        systemDark.root.background === dark.root.background && systemLight.root.background === light.root.background,
        { dark: systemDark.root.background, light: systemLight.root.background }
    );

    // Compact density.
    await open(page, 'theme=neutral&scheme=light&density=compact');
    const compact = await collect(page);
    record(
        'compact density lowers the row height and the cell padding',
        compact.rowHeight === 28 &&
            compact.cellPadding === '6px' &&
            light.rowHeight === 32 &&
            light.cellPadding === '10px',
        { compact: [compact.rowHeight, compact.cellPadding], comfortable: [light.rowHeight, light.cellPadding] }
    );

    // The example brand theme, through tokens and public parts only.
    await open(page, 'theme=app&scheme=dark');
    const app = await collect(page);
    const appHooks = await page.evaluate(() => ({
        cursor: getComputedStyle(document.querySelector('[data-row-id="1"] [data-col-id="id"]')).cursor,
        italic: getComputedStyle(document.querySelector('[data-row-id="9"] [data-col-id="name"]')).fontStyle,
    }));
    record(
        'the example brand theme applies its look (indigo accent, slate header, Inter, light even on a dark page)',
        app.focused.ring.includes(app.tokens.focus) &&
            isIndigo(app.tokens.focus) &&
            app.root.font.startsWith('Inter') &&
            luminance(app.root.background) > 0.9 &&
            app.header !== light.header &&
            app.selected.tint.includes(app.tokens.selected),
        { focus: app.tokens.focus, header: app.header, font: app.root.font, background: app.root.background }
    );
    record(
        'cellClass and rowClassName classes style cells through plain selectors',
        appHooks.cursor === 'not-allowed' && appHooks.italic === 'italic',
        appHooks
    );

    // Plain application selectors beat the defaults without !important.
    await page.addStyleTag({
        content: `
            [data-grid-part='header-row'] { background-color: rgb(1, 2, 3); }
            .ig [data-grid-part='cell'] { background-color: rgb(4, 5, 6); }
        `,
    });
    await settle(page);
    const overrides = await page.evaluate(() => ({
        header: getComputedStyle(document.querySelector('[data-grid-part="header-row"]')).backgroundColor,
        rangeCell: getComputedStyle(document.querySelector('[data-row-id="8"] [data-col-id="m1"]')).backgroundColor,
        rangeEdges: getComputedStyle(document.querySelector('[data-row-id="8"] [data-col-id="m1"]')).boxShadow,
    }));
    record(
        'a single attribute selector overrides the defaults, even on range cells, without !important',
        overrides.header === 'rgb(1, 2, 3)' &&
            overrides.rangeCell === 'rgb(4, 5, 6)' &&
            overrides.rangeEdges !== 'none',
        overrides
    );

    const important = await page.evaluate(
        () =>
            [...document.styleSheets]
                .flatMap((sheet) => {
                    try {
                        return [...sheet.cssRules].map((rule) => rule.cssText);
                    } catch {
                        return [];
                    }
                })
                .filter((text) => text.includes('the-grid') && text.includes('!important')).length
    );
    // Pixels: rings and range edges lie exactly on the grid lines on all four sides, with no overhang.
    await open(page, 'theme=app&scheme=light');
    record(
        'rings and range edges sit on the grid lines, pixel for pixel, and hovering a neighbour never paints over focus or a range',
        ...(await ringPixels(page))
    );
    record(
        'the first row keeps its ring top on the line under the header, and the resize marker covers the column line',
        ...(await headerEdgePixels(page))
    );

    record('no !important in any loaded grid or theme rule', important === 0, { important });
    record('no page errors', errors.length === 0, { errors: errors.slice(0, 3) });
}

/**
 * Screenshots a focused cell, a hovered cell and a one-column range at 1x and checks the ring pixels: the
 * grid lines around each cell (left: the pixel column before it, right: its own last pixel column, top: the
 * row above's last pixel row, bottom: the pixel row after it) are ring coloured end to end, the pixels just
 * outside the right line and inside the ring are not.
 */
async function ringPixels(page) {
    const setup = async (state) => {
        await page.evaluate(() => {
            window.__ig.api.clearRanges();
            window.__ig.api.geometry.setScroll({ top: 0, left: 0 });
        });
        if (state.startsWith('focus')) {
            await page.evaluate(() => window.__ig.api.setFocusedCell({ rowId: '3', colId: 'code' }, { scroll: false }));
            await page.locator('[data-grid-part="viewport"]').focus();
            // Hovering the neighbour below or to the right must not paint over the focus ring.
            if (state === 'focus+hoverBelow') {
                await page.hover('[data-row-id="4"] [data-col-id="code"]');
            } else if (state === 'focus+hoverRight') {
                await page.hover('[data-row-id="3"] [data-col-id="code"] + [data-grid-part="cell"]');
            } else {
                await page.mouse.move(5, 5);
            }
        } else if (state === 'hover') {
            await page.evaluate(() => window.__ig.api.setFocusedCell(null));
            await page.hover('[data-row-id="3"] [data-col-id="code"]');
        } else {
            await page.evaluate(() =>
                window.__ig.api.setRanges([
                    { anchor: { rowId: '3', colId: 'code' }, end: { rowId: '4', colId: 'code' } },
                ])
            );
            if (state === 'range+hoverBelow') {
                await page.hover('[data-row-id="5"] [data-col-id="code"]');
            } else {
                await page.mouse.move(5, 5);
            }
        }
        await settle(page);
    };
    const report = {};
    let pass = true;
    for (const state of ['focus', 'hover', 'range', 'focus+hoverBelow', 'focus+hoverRight', 'range+hoverBelow']) {
        await setup(state);
        const box = await page.evaluate(() => {
            const rect = document.querySelector('[data-row-id="3"] [data-col-id="code"]').getBoundingClientRect();
            const below = document.querySelector('[data-row-id="4"] [data-col-id="code"]').getBoundingClientRect();

            return {
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                w: Math.round(rect.width),
                h: Math.round(rect.height),
                belowBottom: Math.round(below.bottom),
            };
        });
        // Cells own their bottom line: the last pixel row of the (last) cell.
        const bottomRow = state.startsWith('range') ? box.belowBottom - 1 : box.y + box.h - 1;
        const image = decodePng(
            await page.screenshot({
                clip: { x: box.x - 3, y: box.y - 3, width: box.w + 6, height: bottomRow - box.y + 6 },
            })
        );
        const at = (x, y) => image.pixel(x - box.x + 3, y - box.y + 3);
        const ring = at(box.x + box.w - 1, box.y + Math.floor(box.h / 2));
        const isRing = (pixel) => pixel.every((value, index) => Math.abs(value - ring[index]) <= 12);
        const left = box.x - 1;
        const right = box.x + box.w - 1;
        const top = box.y - 1;
        const bottom = bottomRow;
        const samples = [];
        for (let y = top; y <= bottom; y++) {
            samples.push(['left', isRing(at(left, y))], ['right', isRing(at(right, y))]);
        }
        for (let x = left; x <= right; x++) {
            samples.push(['top', isRing(at(x, top))], ['bottom', isRing(at(x, bottom))]);
        }
        const missing = [...new Set(samples.filter(([, ok]) => !ok).map(([side]) => side))];
        const overhang = isRing(at(right + 1, top)) || isRing(at(right + 1, bottom)) || isRing(at(left - 1, top + 2));
        const inside = isRing(at(left + 1, top + 3)) || isRing(at(right - 1, top + 3));
        const ok = missing.length === 0 && !overhang && !inside;
        pass &&= ok;
        report[state] = { ok, missing, overhang, inside, ring };
    }

    return [pass, report];
}

/**
 * The first row under the header: a focused cell's ring is closed on top, on the line under the header,
 * at the top and after scrolling back. The resize marker covers the column line itself.
 */
async function headerEdgePixels(page) {
    const report = {};
    await page.evaluate(() => {
        window.__ig.api.clearRanges();
        window.__ig.api.geometry.setScroll({ top: 0, left: 0 });
    });
    await settle(page);
    const firstId = await page.evaluate(
        () => document.querySelector('[data-grid-part="body"] [data-first-row]').dataset.rowId
    );
    await page.evaluate(
        (rowId) => window.__ig.api.setFocusedCell({ rowId, colId: 'code' }, { scroll: false }),
        firstId
    );
    await page.locator('[data-grid-part="viewport"]').focus();
    await page.mouse.move(5, 5);
    const ringTop = async () => {
        await settle(page);
        const box = await page.evaluate((rowId) => {
            const rect = document
                .querySelector(`[data-row-id="${rowId}"] [data-col-id="code"]`)
                .getBoundingClientRect();
            const header = document.querySelector('[data-grid-part="header-row"]').getBoundingClientRect();

            return {
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                w: Math.round(rect.width),
                h: Math.round(rect.height),
                headerBottom: Math.round(header.bottom),
            };
        }, firstId);
        const image = decodePng(
            await page.screenshot({ clip: { x: box.x - 2, y: box.y - 2, width: box.w + 4, height: box.h + 4 } })
        );
        const at = (x, y) => image.pixel(x - box.x + 2, y - box.y + 2);
        const ring = at(box.x + box.w - 1, box.y + Math.floor(box.h / 2));
        const isRing = (pixel) => pixel.every((value, index) => Math.abs(value - ring[index]) <= 12);
        const missing = [];
        for (let x = box.x; x < box.x + box.w; x++) {
            if (!isRing(at(x, box.y))) {
                missing.push(x);
            }
        }
        // Just under the line is the cell, not ring.
        return {
            ok: missing.length === 0 && !isRing(at(box.x + 4, box.y + 2)) && box.y === box.headerBottom,
            missing: missing.length,
            top: box.y,
            headerBottom: box.headerBottom,
        };
    };
    report.atTop = await ringTop();
    await page.evaluate(() => window.__ig.api.geometry.setScroll({ top: 200 }));
    await settle(page);
    await page.evaluate(() => window.__ig.api.geometry.setScroll({ top: 0 }));
    report.afterScroll = await ringTop();

    // Resize marker: hover the handle of the "code" header and read the column line under it.
    await page.evaluate(() => window.__ig.api.setFocusedCell(null));
    const handle = page.locator(
        '[data-grid-part="header-cell"][data-col-id="code"] [data-grid-part="resize-handle"][data-edge="end"]'
    );
    await handle.hover();
    await settle(page);
    const header = await page.evaluate(() => {
        const rect = document
            .querySelector('[data-grid-part="header-cell"][data-col-id="code"]')
            .getBoundingClientRect();

        return { right: Math.round(rect.right), y: Math.round(rect.top + rect.height / 2) };
    });
    const strip = decodePng(
        await page.screenshot({ clip: { x: header.right - 6, y: header.y, width: 12, height: 1 } })
    );
    const accent = strip.pixel(5, 0);
    const colored = Array.from({ length: 12 }, (_, index) => strip.pixel(index, 0)).map((pixel) =>
        pixel.every((value, index) => Math.abs(value - accent[index]) <= 12)
    );
    // The line is the cell's last pixel (index 5); the marker is that pixel and the one before, nothing else.
    report.resize = {
        ok:
            colored.join() ===
            [false, false, false, false, true, true, false, false, false, false, false, false].join(),
        colored: colored.map(Number).join(''),
    };
    await page.mouse.move(5, 5);

    return [report.atTop.ok && report.afterScroll.ok && report.resize.ok, report];
}

/** Parses rgb(), rgba(), color(srgb ...) and oklch() as browsers serialise them, enough for these checks. */
function channels(color) {
    const numbers = color.match(/[\d.]+/g)?.map(Number) ?? [];
    if (color.startsWith('oklch')) {
        return { oklch: numbers };
    }
    const scale = color.startsWith('color(') ? 255 : 1;

    return { rgb: numbers.slice(0, 3).map((value) => value * scale) };
}

function alpha(color) {
    const match = color.match(/^rgba\([^)]*,\s*([\d.]+)\)$/) ?? color.match(/\/\s*([\d.]+)\)$/);

    return match ? Number(match[1]) : 1;
}

function luminance(color) {
    const parsed = channels(color);
    if (parsed.oklch) {
        return parsed.oklch[0] > 1 ? parsed.oklch[0] / 100 : parsed.oklch[0];
    }
    const [r, g, b] = parsed.rgb.map((value) => value / 255);

    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function isNeutral(color) {
    const parsed = channels(color);
    if (parsed.oklch) {
        return parsed.oklch[1] < 0.02;
    }
    const [r, g, b] = parsed.rgb;

    return Math.max(r, g, b) - Math.min(r, g, b) < 12;
}

function isIndigo(color) {
    const parsed = channels(color);
    if (parsed.oklch) {
        return parsed.oklch[1] > 0.05 && parsed.oklch[2] > 250 && parsed.oklch[2] < 300;
    }
    const [r, g, b] = parsed.rgb;

    return b > r + 20 && b > g;
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
writeFileSync(join(root, `playground/results/styling-results${suffix}.json`), JSON.stringify(results, null, 2));
const failed = results.checks.filter((check) => !check.pass).length;
console.log(`${results.checks.length - failed}/${results.checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
