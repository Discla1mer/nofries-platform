'use strict';

const crypto = require('node:crypto');
const { createEmailSettingsStore, OFF_SQL, ON_SQL, ACCOUNT_SQL, READ_SQL, TOGGLE_TYPES } =
    require('../api/shared/lifecycleEmail/emailSettingsStore');

const SUBJECT = `${crypto.randomUUID()}:${crypto.randomUUID()}`;
const ACCOUNT = crypto.randomUUID();

describe('email settings store', () => {
    function client(results) {
        const queue = [...results];
        return { query: jest.fn(async () => queue.shift() || { rows: [], rowCount: 0 }), release: jest.fn() };
    }
    const prelude = [['BEGIN'], ['SET LOCAL ROLE nofries_runtime'], ["SELECT set_config('nofries.subject_key', $1, true)", [SUBJECT]],
        [ACCOUNT_SQL, [SUBJECT]]];
    const account = { rows: [{ account_id: ACCOUNT }], rowCount: 1 };
    const ok = {}, ack = { rows: [], rowCount: 0 };

    test('turning off is an idempotent settings upsert that never moves an existing time', async () => {
        const c = client([ok, ok, ok, account, { rowCount: 1 }]);
        expect(await createEmailSettingsStore({ pool: { connect: async () => c } }).change(SUBJECT, 'result_summary', 'off')).toBe('changed');
        expect(c.query.mock.calls).toEqual([...prelude, [OFF_SQL, [ACCOUNT, 'result_summary']], ['COMMIT']]);
        expect(OFF_SQL).toMatch(/'settings'\)\s+ON CONFLICT .* source = 'settings'\s+WHERE email_preferences\.unsubscribed_at IS NULL$/s);
        expect(OFF_SQL).not.toMatch(/=\s*NULL/i);
        const again = client([ok, ok, ok, account, { rowCount: 0 }]);
        expect(await createEmailSettingsStore({ pool: { connect: async () => again } }).change(SUBJECT, 'result_summary', 'off')).toBe('unchanged');
        expect(c.release).toHaveBeenCalledWith(false);
    });

    test('turning on clears only a settings unsubscribe; a link unsubscribe is reported as locked', async () => {
        expect(ON_SQL).toMatch(/SET unsubscribed_at = NULL\s+WHERE account_id = \$1 AND email_type = \$2 AND source = 'settings' AND unsubscribed_at IS NOT NULL$/);
        const cleared = client([ok, ok, ok, account, { rowCount: 1 }]);
        expect(await createEmailSettingsStore({ pool: { connect: async () => cleared } }).change(SUBJECT, 'nudge_unfinished', 'on')).toBe('changed');
        expect(cleared.query.mock.calls).toEqual([...prelude, [ON_SQL, [ACCOUNT, 'nudge_unfinished']], ['COMMIT']]);
        const link = client([ok, ok, ok, account, { rowCount: 0 }, { rows: [{ email_type: 'nudge_unfinished', off: true, source: 'link' }] }]);
        expect(await createEmailSettingsStore({ pool: { connect: async () => link } }).change(SUBJECT, 'nudge_unfinished', 'on')).toBe('link_locked');
        expect(link.query.mock.calls).toEqual([...prelude, [ON_SQL, [ACCOUNT, 'nudge_unfinished']], [READ_SQL, [ACCOUNT]], ['COMMIT']]);
        const already = client([ok, ok, ok, account, { rowCount: 0 }, { rows: [] }]);
        expect(await createEmailSettingsStore({ pool: { connect: async () => already } }).change(SUBJECT, 'nudge_unfinished', 'on')).toBe('unchanged');
    });

    test('without an activated account for the subject nothing is read or written', async () => {
        const c = client([ok, ok, ok, ack]);
        const store = createEmailSettingsStore({ pool: { connect: async () => c } });
        expect(await store.change(SUBJECT, 'result_summary', 'off')).toBeNull();
        expect(c.query.mock.calls).toEqual([...prelude, ['COMMIT']]);
        expect(ACCOUNT_SQL).toMatch(/WHERE subject_key = \$1 AND activated_at IS NOT NULL$/);
    });

    test('reads rows as plain state and discards a connection whose rollback fails', async () => {
        const c = client([ok, ok, ok, account, { rows: [{ email_type: 'welcome', off: false, source: 'settings' }] }]);
        expect(await createEmailSettingsStore({ pool: { connect: async () => c } }).read(SUBJECT))
            .toEqual([{ type: 'welcome', off: false, source: 'settings' }]);
        const broken = { query: jest.fn(async sql => { if (!['BEGIN', 'SET LOCAL ROLE nofries_runtime'].includes(sql)) throw new Error('x'); }), release: jest.fn() };
        await expect(createEmailSettingsStore({ pool: { connect: async () => broken } }).read(SUBJECT)).rejects.toThrow('x');
        expect(broken.release).toHaveBeenCalledWith(true);
        expect(() => createEmailSettingsStore({})).toThrow('email_settings_pool_invalid');
    });

    test('rejects types without a control and unknown actions before connecting', async () => {
        const connect = jest.fn();
        const store = createEmailSettingsStore({ pool: { connect } });
        for (const [type, action] of [['welcome', 'off'], ['marketing', 'off'], ['result_summary', 'toggle'], ['result_summary', undefined]]) {
            await expect(store.change(SUBJECT, type, action)).rejects.toThrow('email_settings_input_invalid');
        }
        expect(connect).not.toHaveBeenCalled();
        expect(TOGGLE_TYPES).toEqual(['result_summary', 'nudge_unfinished', 'reassess_reminder']);
    });
});
