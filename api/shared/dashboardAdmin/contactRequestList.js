'use strict';

// Staff-only, read-only list of dashboard contact requests (#409), so staff
// can follow up. Organisations come from the staff signup list (the newest
// 200 accounts and their organisation slots); each organisation's rows are read
// through the existing runtime role with its own tenant setting (0026 RLS), in
// one READ ONLY transaction. No migration, grant or new role is involved.
// Contact email: the requesting sign-in subject's account email when that
// subject belongs to a listed account; otherwise the email of the account that
// owns the organisation, marked as such. Nothing here is logged.
const { TOPIC_LABELS } = require('../contactRequestEmail');

const WINDOW_DAYS = 90;
const MAX_ROWS = 200;
const MAX_TENANTS = 400;
const PER_TENANT = 100;
const TENANT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SQL = `SELECT r.subject_key, r.topic, r.requested_at, o.payload->>'displayName' AS display_name
    FROM nofries.dashboard_contact_requests r
    LEFT JOIN nofries.dashboard_organisations o ON o.tenant_id = r.tenant_id AND o.organisation_id = r.organisation_id
    WHERE r.tenant_id = $1 AND r.requested_at >= $2::timestamptz
    ORDER BY r.requested_at DESC, r.request_id LIMIT ${PER_TENANT + 1}`;
const unavailable = () => { throw new Error('contact_requests_unavailable'); };

async function readTenantRows(pool, tenantIds, since, signal) {
    if (!tenantIds.length) return [];
    signal.throwIfAborted();
    const client = await pool.connect();
    let discard = false;
    try {
        await client.query('BEGIN READ ONLY');
        await client.query("SET LOCAL statement_timeout = '2000ms'");
        const found = [];
        for (const tenantId of tenantIds) {
            signal.throwIfAborted();
            await client.query("SELECT set_config('nofries.tenant_id', $1, true)", [tenantId]);
            found.push({ tenantId, rows: (await client.query(SQL, [tenantId, since])).rows });
        }
        await client.query('COMMIT');
        return found;
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) { discard = true; }
        throw error;
    } finally { client.release(discard); }
}

function createContactRequestReader({ list, pool, now = Date.now }) {
    if (typeof list !== 'function' || !pool || typeof pool.connect !== 'function' || typeof now !== 'function') {
        throw new Error('dashboard_admin_configuration_invalid');
    }
    return async function contactRequests(signal) {
        const accounts = await list(signal, false, true);
        if (!accounts || !Array.isArray(accounts.rows) || typeof accounts.truncated !== 'boolean') unavailable();
        const subjects = new Map(), tenants = new Map();
        for (const account of accounts.rows) {
            if (!account || account.readable !== true || typeof account.email !== 'string') continue;
            if (typeof account.subjectKey === 'string' && !subjects.has(account.subjectKey)) subjects.set(account.subjectKey, account.email);
            for (const scope of Array.isArray(account.scopes) ? account.scopes : []) {
                if (typeof scope?.tenantId !== 'string' || !TENANT.test(scope.tenantId) || tenants.has(scope.tenantId)) continue;
                tenants.set(scope.tenantId, { name: typeof scope.name === 'string' ? scope.name : '', email: account.email });
            }
        }
        let truncated = accounts.truncated || tenants.size > MAX_TENANTS;
        const at = now();
        if (!Number.isFinite(at)) unavailable();
        const since = new Date(at - WINDOW_DAYS * 86400000).toISOString();
        const rows = [];
        for (const { tenantId, rows: found } of await readTenantRows(pool, [...tenants.keys()].slice(0, MAX_TENANTS), since, signal)) {
            if (found.length > PER_TENANT) truncated = true;
            const owner = tenants.get(tenantId);
            for (const row of found.slice(0, PER_TENANT)) {
                const requestedAt = new Date(row.requested_at);
                if (!Number.isFinite(requestedAt.getTime())) unavailable();
                const requester = subjects.get(row.subject_key);
                rows.push({ requestedAt: requestedAt.toISOString(),
                    organisation: typeof row.display_name === 'string' && row.display_name ? row.display_name : owner.name,
                    topic: TOPIC_LABELS[row.topic] || 'Other',
                    contactEmail: requester || owner.email, contactBasis: requester ? 'requester' : 'account' });
            }
        }
        rows.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
        if (rows.length > MAX_ROWS) truncated = true;
        signal.throwIfAborted();
        return { rows: rows.slice(0, MAX_ROWS), truncated, windowDays: WINDOW_DAYS };
    };
}

module.exports = { createContactRequestReader, WINDOW_DAYS, MAX_ROWS, MAX_TENANTS };
