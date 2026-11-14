'use strict';

// Data layer for signed-in email settings (#151, slice E7). Turning a type off
// is the same idempotent write as the link unsubscribe (never moves an earlier
// time). Turning it back on is allowed only when the person turned it off in
// settings: the privacy notice says an email-link unsubscribe is permanent, so
// a 'link' row stays off. Welcome is sent once at activation and has no control.
const TOGGLE_TYPES = Object.freeze(['result_summary', 'nudge_unfinished', 'reassess_reminder']);
const ACTIONS = Object.freeze(['off', 'on']);

const ACCOUNT_SQL = `SELECT account_id FROM nofries.dashboard_starter_accounts
    WHERE subject_key = $1 AND activated_at IS NOT NULL`;
const READ_SQL = `SELECT email_type, unsubscribed_at IS NOT NULL AS off, source FROM nofries.email_preferences
    WHERE account_id = $1`;
// Same shape as the link write: an existing unsubscribe keeps its time and source.
const OFF_SQL = `INSERT INTO nofries.email_preferences (account_id, email_type, unsubscribed_at, source)
    VALUES ($1, $2, clock_timestamp(), 'settings')
    ON CONFLICT (account_id, email_type) DO UPDATE SET unsubscribed_at = clock_timestamp(), source = 'settings'
    WHERE email_preferences.unsubscribed_at IS NULL`;
// Only a settings-sourced unsubscribe may be cleared. A link unsubscribe is permanent.
const ON_SQL = `UPDATE nofries.email_preferences SET unsubscribed_at = NULL
    WHERE account_id = $1 AND email_type = $2 AND source = 'settings' AND unsubscribed_at IS NOT NULL`;

// Runs as nofries_runtime with the signed-in subject as the RLS context, like
// the link unsubscribe writer. The starter-account and email_preferences
// policies then admit only that subject's own account.
function createEmailSettingsStore({ pool }) {
    if (!pool || typeof pool.connect !== 'function') throw new Error('email_settings_pool_invalid');
    async function inSubject(subjectKey, work) {
        const client = await pool.connect();
        let discard = false;
        try {
            await client.query('BEGIN');
            try {
                await client.query('SET LOCAL ROLE nofries_runtime');
                await client.query("SELECT set_config('nofries.subject_key', $1, true)", [subjectKey]);
                const accounts = (await client.query(ACCOUNT_SQL, [subjectKey])).rows;
                const result = accounts.length === 1 ? await work(client, accounts[0].account_id) : null;
                await client.query('COMMIT');
                return result;
            } catch (error) {
                try { await client.query('ROLLBACK'); } catch (_) { discard = true; }
                throw error;
            }
        } finally {
            client.release(discard);
        }
    }
    const rows = async (client, accountId) => (await client.query(READ_SQL, [accountId])).rows
        .map(row => ({ type: row.email_type, off: row.off === true, source: row.source }));
    return Object.freeze({
        // null: no activated starter account for this subject.
        read: subjectKey => inSubject(subjectKey, rows),
        // 'changed' | 'unchanged' | 'link_locked', or null without an account.
        change: (subjectKey, emailType, action) => !TOGGLE_TYPES.includes(emailType) || !ACTIONS.includes(action)
            ? Promise.reject(new Error('email_settings_input_invalid')) : inSubject(subjectKey, async (client, accountId) => {
            if (action === 'off') return (await client.query(OFF_SQL, [accountId, emailType])).rowCount ? 'changed' : 'unchanged';
            if ((await client.query(ON_SQL, [accountId, emailType])).rowCount) return 'changed';
            const row = (await rows(client, accountId)).find(item => item.type === emailType);
            return row && row.off && row.source === 'link' ? 'link_locked' : 'unchanged';
        })
    });
}

module.exports = { TOGGLE_TYPES, ACCOUNT_SQL, READ_SQL, OFF_SQL, ON_SQL, createEmailSettingsStore };
