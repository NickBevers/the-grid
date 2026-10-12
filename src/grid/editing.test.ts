import { describe, expect, it, vi } from 'vitest';

import type { CellEditorComponent, ColumnDefinition, DataRow } from '../contract';
import { ColumnModel } from './columns';
import { EditController, isStartKey, keyPolicyOf, type EditSession } from './editing';

type Item = { id: number; name: string; fee: number };

function setup(definitions?: ColumnDefinition<Item>[]) {
    const rows = new Map<string, DataRow<Item>>(
        [1, 2, 3].map((id) => [
            String(id),
            { kind: 'data', id: String(id), data: { id, name: `Item ${id}`, fee: id * 10 } } as DataRow<Item>,
        ])
    );
    const model = new ColumnModel<Item>(
        definitions ?? [
            { field: 'id' },
            { field: 'name', editable: true },
            { field: 'fee', editable: ({ data }) => data.id !== 3 },
        ]
    );
    const sessions: (EditSession | null)[] = [];
    const events: string[] = [];
    const changes: { oldValue: unknown; newValue: unknown }[] = [];
    const controller = new EditController<Item>({
        getRow: (id) => rows.get(id),
        getColumn: (colId) => model.getResolved(colId),
        onChange: (session) => sessions.push(session),
        onStarted: ({ cell }) => events.push(`started ${cell.rowId}/${cell.colId}`),
        onStopped: ({ cell, committed, reason }) =>
            events.push(`stopped ${cell.rowId}/${cell.colId} ${committed ? 'commit' : 'cancel'} ${reason}`),
        onValueChanged: (event) => changes.push({ oldValue: event.oldValue, newValue: event.newValue }),
    });

    return { rows, model, controller, sessions, events, changes };
}

const editorWith = (parse: CellEditorComponent<Item>['parse']): CellEditorComponent<Item> =>
    Object.assign(() => null, { parse });

describe('EditController', () => {
    it('starts only on editable cells of loaded rows', async () => {
        const { controller } = setup();

        expect(controller.canEdit({ rowId: '1', colId: 'id' })).toBe(false);
        expect(controller.canEdit({ rowId: '3', colId: 'fee' })).toBe(false);
        expect(controller.canEdit({ rowId: '9', colId: 'name' })).toBe(false);
        expect(await controller.start({ rowId: '1', colId: 'id' })).toBe(false);
        expect(await controller.start({ rowId: '1', colId: 'name' })).toBe(true);
        expect(controller.session).toMatchObject({ initialValue: 'Item 1', draft: 'Item 1', status: 'editing' });
    });

    it('commits the draft through the setter and reports the change after the stop', async () => {
        const { controller, rows, events, changes } = setup();
        await controller.start({ rowId: '2', colId: 'name' });
        controller.setDraft('Renamed');

        expect(rows.get('2')!.data.name).toBe('Item 2');
        expect(await controller.stop(true, 'enter')).toBe(true);
        expect(rows.get('2')!.data.name).toBe('Renamed');
        expect(events).toEqual(['started 2/name', 'stopped 2/name commit enter']);
        expect(changes).toEqual([{ oldValue: 'Item 2', newValue: 'Renamed' }]);
        expect(controller.session).toBeNull();
    });

    it('cancel discards the draft', async () => {
        const { controller, rows, changes, events } = setup();
        await controller.start({ rowId: '2', colId: 'name' });
        controller.setDraft('Nope');
        await controller.stop(false, 'escape');

        expect(rows.get('2')!.data.name).toBe('Item 2');
        expect(changes).toEqual([]);
        expect(events.at(-1)).toBe('stopped 2/name cancel escape');
    });

    it('an unchanged commit fires no value change', async () => {
        const { controller, changes } = setup();
        await controller.start({ rowId: '1', colId: 'name' });
        await controller.stop(true, 'blur');

        expect(changes).toEqual([]);
    });

    it('clears the start key on the first draft change, so a remounted editor does not apply it twice', async () => {
        const { controller } = setup();
        await controller.start({ rowId: '1', colId: 'name' }, { startKey: 'x' });
        expect(controller.session!.startKey).toBe('x');
        controller.setDraft('x');

        expect(controller.session).toMatchObject({ startKey: null, draft: 'x' });
    });

    it('a rejected parse keeps the editor open with the error, and the next draft clears it', async () => {
        const parse = vi.fn((draft: unknown) =>
            Number.isNaN(Number(draft))
                ? { ok: false as const, error: 'Enter a number' }
                : { ok: true as const, value: Number(draft) }
        );
        const { controller, rows } = setup([{ field: 'fee', editable: true, cellEditor: editorWith(parse) }]);
        await controller.start({ rowId: '1', colId: 'fee' });
        controller.setDraft('abc');

        expect(await controller.stop(true, 'enter')).toBe(false);
        expect(controller.session).toMatchObject({ error: 'Enter a number', draft: 'abc', status: 'editing' });
        controller.setDraft('42');
        expect(controller.session!.error).toBeNull();
        expect(await controller.stop(true, 'enter')).toBe(true);
        expect(rows.get('1')!.data.fee).toBe(42);
    });

    it('async validation keeps the editor open, dedupes a second stop, and a cancel wins', async () => {
        let resolve!: (outcome: { ok: true; value: unknown }) => void;
        const parse = () => new Promise<{ ok: true; value: unknown }>((done) => (resolve = done));
        const { controller, rows } = setup([{ field: 'name', editable: true, cellEditor: editorWith(parse) }]);
        await controller.start({ rowId: '1', colId: 'name' });
        controller.setDraft('Server checked');
        const first = controller.stop(true, 'enter');
        const second = controller.stop(true, 'blur');

        expect(controller.session!.status).toBe('validating');
        expect(second).toBe(first);
        resolve({ ok: true, value: 'Server checked' });
        expect(await first).toBe(true);
        expect(rows.get('1')!.data.name).toBe('Server checked');

        await controller.start({ rowId: '2', colId: 'name' });
        controller.setDraft('Too late');
        const pending = controller.stop(true, 'enter');
        expect(await controller.stop(false, 'escape')).toBe(true);
        resolve({ ok: true, value: 'Too late' });
        expect(await pending).toBe(true);
        expect(rows.get('2')!.data.name).toBe('Item 2');
    });

    it('a parse that throws is shown as an error', async () => {
        const parse = () => Promise.reject(new Error('Server said no'));
        const { controller } = setup([{ field: 'name', editable: true, cellEditor: editorWith(parse) }]);
        await controller.start({ rowId: '1', colId: 'name' });

        expect(await controller.stop(true, 'enter')).toBe(false);
        expect(controller.session!.error).toBe('Server said no');
    });

    it('starting another cell commits the current edit first, and refuses when that commit is rejected', async () => {
        const parse = (draft: unknown) =>
            draft === 'bad' ? { ok: false as const, error: 'Bad' } : { ok: true as const, value: draft };
        const { controller, rows, events } = setup([{ field: 'name', editable: true, cellEditor: editorWith(parse) }]);
        await controller.start({ rowId: '1', colId: 'name' });
        controller.setDraft('good');

        expect(await controller.start({ rowId: '2', colId: 'name' })).toBe(true);
        expect(rows.get('1')!.data.name).toBe('good');
        controller.setDraft('bad');
        expect(await controller.start({ rowId: '3', colId: 'name' })).toBe(false);
        expect(controller.session!.cell).toEqual({ rowId: '2', colId: 'name' });
        expect(events).toContain('stopped 1/name commit api');
    });

    it('keeps the draft through refreshes and ends with rowRemoved when the row goes', async () => {
        const { controller, rows, events } = setup();
        await controller.start({ rowId: '2', colId: 'name' });
        controller.setDraft('Typed');
        rows.get('2')!.data = { ...rows.get('2')!.data, name: 'Changed on the server' };
        controller.rowsChanged();

        expect(controller.session!.draft).toBe('Typed');
        rows.delete('2');
        controller.rowsChanged();
        expect(controller.session).toBeNull();
        expect(events.at(-1)).toBe('stopped 2/name cancel rowRemoved');
    });

    it('starts and stops synchronously unless a parse is async, so the next key reaches the editor', () => {
        const { controller, rows } = setup();

        expect(controller.start({ rowId: '1', colId: 'name' })).toBe(true);
        expect(controller.session).not.toBeNull();
        controller.setDraft('Now');
        expect(controller.stop(true, 'enter')).toBe(true);
        expect(rows.get('1')!.data.name).toBe('Now');
        expect(controller.start({ rowId: '2', colId: 'name' })).toBe(true);
        expect(controller.start({ rowId: '3', colId: 'name' })).toBe(true);
        expect(controller.session!.cell.rowId).toBe('3');
    });

    it('reports every session change and ends with null', async () => {
        const { controller, sessions } = setup();
        await controller.start({ rowId: '1', colId: 'name' });
        controller.setDraft('a');
        await controller.stop(true, 'tab');

        expect(sessions.map((session) => session?.draft ?? null)).toEqual(['Item 1', 'a', null]);
    });
});

describe('editing helpers', () => {
    it('recognises printable start keys', () => {
        const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
            isStartKey({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });

        expect(key('a')).toBe(true);
        expect(key('7')).toBe(true);
        expect(key(' ')).toBe(true);
        expect(key('Enter')).toBe(false);
        expect(key('c', { metaKey: true })).toBe(false);
    });

    it('fills key policy defaults', () => {
        const editor = Object.assign(() => null, { keyPolicy: { enter: 'newline' as const } });

        expect(keyPolicyOf(undefined)).toEqual({
            enter: 'commitAndMoveDown',
            tab: 'commitAndMove',
            arrowsNavigateGrid: false,
        });
        expect(keyPolicyOf(editor)).toEqual({ enter: 'newline', tab: 'commitAndMove', arrowsNavigateGrid: false });
    });
});
