#!/usr/bin/env node
/**
 * Guards the styling API:
 * - the default stylesheet has no `!important` and no absolute or fixed positioning;
 * - every rule sits in the `the-grid` layer, every selector is wrapped in `:where()` and starts at the grid
 *   root, so themes win without specificity fights and nothing outside a grid is styled;
 * - selectors only use public parts, state attributes and identity attributes from src/styles/parts.ts;
 * - every token the stylesheet reads is defined in it;
 * - every part the React layer renders is listed as public.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const css = readFileSync(join(root, 'src/styles/grid.css'), 'utf8');
const partsSource = readFileSync(join(root, 'src/styles/parts.ts'), 'utf8');
const failures = [];

const block = (name) =>
    partsSource.slice(
        partsSource.indexOf(`export const ${name}`),
        partsSource.indexOf('} as const', partsSource.indexOf(`export const ${name}`))
    );
const keys = (text) => [...text.matchAll(/^\s+'([a-z-]+)':/gm)].map((match) => match[1]);
const parts = new Set(keys(block('GRID_PARTS')));
const states = new Set(keys(block('GRID_STATES')));
const identity = new Set(
    [...partsSource.matchAll(/'(data-[a-z-]+)'/g)].map((match) => match[1]).filter((name) => !states.has(name))
);
identity.add('data-grid-part');

const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
if (/!important/.test(code)) {
    failures.push('grid.css uses !important');
}
if (/position\s*:\s*(absolute|fixed)/.test(code)) {
    failures.push('grid.css uses absolute or fixed positioning');
}
const layerStart = code.indexOf('@layer the-grid {');
if (layerStart === -1 || code.slice(0, layerStart).trim() !== '' || (code.match(/@layer/g) ?? []).length !== 1) {
    failures.push('grid.css must consist of a single @layer the-grid block');
}

// Selectors: the text before each `{` inside the layer, excluding the layer itself.
const inner = code.slice(layerStart + '@layer the-grid {'.length);
// A stack of open blocks: rules hold declarations, at-rules (@media) hold more rules.
const stack = [];
let buffer = '';
const selectors = [];
for (const char of inner) {
    if (char === '{') {
        const prelude = buffer.trim();
        const inRuleContext = stack.every((kind) => kind === 'at');
        if (inRuleContext && prelude.startsWith('@')) {
            if (!/^@media\b/.test(prelude)) {
                failures.push(`unexpected at-rule in grid.css: ${prelude}`);
            }
            stack.push('at');
        } else {
            if (inRuleContext) {
                selectors.push(prelude);
            }
            stack.push('rule');
        }
        buffer = '';
    } else if (char === '}') {
        stack.pop();
        buffer = '';
    } else if (char === ';' && stack.at(-1) === 'rule') {
        buffer = '';
    } else {
        buffer += char;
    }
}
for (const selector of selectors.filter(Boolean)) {
    const stripped = selector.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, '').replace(/[\s>,]/g, '');
    // Every selector in a list starts at the grid root, so the stylesheet styles nothing outside a grid.
    for (const part of selector.split(/,(?![^(]*\))/)) {
        if (!part.trim().startsWith(":where([data-grid-part='root'")) {
            failures.push(`selector not scoped under the grid root: ${part.trim()}`);
        }
        if ((part.match(/data-grid-part='root'/g) ?? []).length > 1) {
            failures.push(`selector nests the grid root inside itself, which never matches: ${part.trim()}`);
        }
    }
    if (stripped !== '' && stripped !== '*') {
        failures.push(`selector not wrapped in :where(): ${selector}`);
    }
    for (const match of selector.matchAll(/\[([a-z-]+)(?:=['"]([^'"]*)['"])?\]/g)) {
        const [, name, value] = match;
        if (name === 'data-grid-part') {
            if (!parts.has(value)) {
                failures.push(`unknown part in grid.css: ${value}`);
            }
        } else if (name.startsWith('data-') && !states.has(name) && !identity.has(name)) {
            failures.push(`private attribute in grid.css: ${name}`);
        }
    }
}

const defined = new Set([...code.matchAll(/(--[a-z_-]+)\s*:/g)].map((match) => match[1]));
for (const match of code.matchAll(/var\((--[a-z_-]+)/g)) {
    if (!defined.has(match[1])) {
        failures.push(`token used but not defined: ${match[1]}`);
    }
}

function walk(dir) {
    return readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);

        return statSync(path).isDirectory() ? walk(path) : [path];
    });
}
for (const file of walk(join(root, 'src/react')).filter((path) => path.endsWith('.tsx') && !path.includes('.test.'))) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(
        /data-grid-part(?:=|': )["']([a-z-]+)["']|part="([a-z-]+)"|part = '([a-z-]+)'/g
    )) {
        const part = match[1] ?? match[2] ?? match[3];
        if (!parts.has(part)) {
            failures.push(`${file.slice(root.length)} renders a part that is not public: ${part}`);
        }
    }
    for (const match of source.matchAll(/'(data-[a-z-]+)'|\s(data-[a-z-]+)=/g)) {
        const name = match[1] ?? match[2];
        if (
            !states.has(name) &&
            !identity.has(name) &&
            !['data-grid-editor-popup', 'data-resize', 'data-test', 'data-suppress-row-select'].includes(name)
        ) {
            failures.push(`${file.slice(root.length)} renders an undocumented attribute: ${name}`);
        }
    }
}

if (failures.length) {
    console.error(`check-styles failed:\n  ${[...new Set(failures)].join('\n  ')}`);
    process.exit(1);
}
console.log(
    `check-styles ok: ${selectors.length} rules in @layer the-grid, ${parts.size} parts, ${states.size} states, ${defined.size} tokens, no !important`
);
