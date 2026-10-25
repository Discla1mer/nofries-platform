'use strict';

// Actual production HTTP handlers over retained synthetic Blob/provider state.
// SQL transport below represents SQL0015 with a historical v1 header; canonical
// organisation/membership rows come from the existing domain fixture. This is
// source qualification, not native PostgreSQL/RLS or provider acceptance.
const request = require('supertest');
const { customerProductionHarness, uid } = require('./helpers/customerProductionHarness');
const { resetAbuseProtectionForTests } = require('../api/shared/abuseProtection');

const clone = value => JSON.parse(JSON.stringify(value));
const sorted = entries => [...entries].sort(([a], [b]) => a.localeCompare(b));
function snapshot(h) {
    return JSON.stringify({
        blobs: sorted(h.state.containers).map(([name, container]) => [name,
            sorted(container.records).map(([key, bytes]) => [key, bytes.toString('base64')])]),
        registrations: sorted(h.pool.registrations), receipts: sorted(h.pool.receipts),
        organisations: [...h.pool.organisations].sort(), preparations: sorted(h.pool.preparations),
        delivered: h.state.delivered
    });
}

function futureLayout(h) {
    const original = h.pool, trace = [], blobWrites = [];
    for (const [name, container] of h.state.containers) {
        const get = container.getBlockBlobClient;
        container.getBlockBlobClient = function (key) {
            const blob = get.call(this, key);
            for (const method of ['uploadData', 'delete', 'deleteIfExists']) {
                const invoke = blob[method];
                blob[method] = async function (...args) {
                    blobWrites.push({ name, key, method });
                    return invoke.apply(this, args);
                };
            }
            return blob;
        };
    }
    h.recomposeWithPool({ ...original, async connect() {
        const client = await original.connect();
        return { ...client, async query(sql, params = []) {
            trace.push({ sql, params: clone(params) });
            if (sql.includes('FROM pg_catalog.pg_attribute')) {
                return { rows: [{ is_text: true, not_null: true, scoped_primary_key: true }] };
            }
            if (/SELECT row_key FROM nofries\.signup_registrations/.test(sql)) return { rows: [] };
            const result = await client.query(sql, params);
            if (/SELECT identity_tenant_id/.test(sql) && /FROM nofries\.signup_registrations/.test(sql)) {
                expect(sql).toContain("row_key=''");
                return { ...result, rows: result.rows.map(row => ({ ...row, row_key: '' })) };
            }
            return result;
        } };
    } });
    const before = snapshot(h);
    return { trace, assertPassive() {
        expect(trace.some(event => /FROM pg_catalog\.pg_attribute/.test(event.sql))).toBe(true);
        expect(trace.filter(event => /\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?nofries\./i.test(event.sql))).toEqual([]);
        expect(trace.filter(event => /pg_advisory_/.test(event.sql))).toEqual([]);
        expect(blobWrites).toEqual([]);
        expect(snapshot(h)).toBe(before);
    } };
}

async function acceptedCustomer({ bound = true } = {}) {
    const h = customerProductionHarness();
    // The canonical helper applies the real membership accept command when a
    // binding is present, rather than fabricating a ready predicate or DTO.
    const user = h.addUser({ bindingId: bound ? uid(80) : null });
    const login = await h.login(user);
    expect(login.response.status).toBe(303);
    const consent = await h.consent(login.cookie);
    expect(consent.before.body.state.status).toBe('terms');
    expect(consent.response.status).toBe(200);
    expect(consent.response.body.state.status).toBe(bound ? 'continue_to_dashboard' : 'pending_admission');
    expect(h.pool.receipts.size).toBe(1); expect(h.pool.registrations.size).toBe(1);
    const terms = { accepted: true, termsVersion: h.termsVersion, termsDigest: h.termsDigest,
        scheduleId: user.scheduleId, scheduleDigest: user.scheduleDigest };
    return { h, user, login, consent, terms };
}

async function readAndRetry(f) {
    return [
        await request(f.h.app).get('/api/customer-signup/state').set('Cookie', f.login.cookie),
        await f.h.sameOrigin(request(f.h.app).post('/api/customer-signup/terms')).set('Cookie', f.login.cookie)
            .set('X-CSRF-Token', f.consent.before.body.csrfToken).send(f.terms),
        await f.h.sameOrigin(request(f.h.app).post('/api/customer-signup/terms')).set('Cookie', f.login.cookie)
            .set('X-CSRF-Token', f.consent.before.body.csrfToken).send({ resume: true })
    ];
}

beforeEach(() => resetAbuseProtectionForTests());

test('future SQL layout preserves a completed generic bound organisation through passive state and stale consent retries', async () => {
    const f = await acceptedCustomer(), observed = futureLayout(f.h);
    for (const response of await readAndRetry(f)) {
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ state: { status: 'continue_to_dashboard' } });
    }
    expect(observed.trace.some(event => /FROM nofries\.dashboard_membership_states/.test(event.sql))).toBe(true);
    expect(observed.trace.some(event => /FROM nofries\.signup_acceptance_receipts/.test(event.sql))).toBe(true);
    expect(observed.trace.some(event => /FROM nofries\.signup_registrations/.test(event.sql))).toBe(true);
    observed.assertPassive();
});

test.each(['receipt without registration', 'registration without receipt', 'revoked registration'])(
    'future SQL layout cannot continue a generic bound organisation with %s or repair it on retry', async defect => {
        const f = await acceptedCustomer();
        if (defect === 'receipt without registration') f.h.pool.registrations.clear();
        if (defect === 'registration without receipt') f.h.pool.receipts.clear();
        if (defect === 'revoked registration') {
            const row = f.h.pool.registrations.get(f.user.authority.subjectKey);
            row.payload.registrations[0].status = 'revoked';
            row.payload.selected = null;
            row.payload.revision++; row.revision = String(row.payload.revision);
        }
        const observed = futureLayout(f.h);
        for (const response of await readAndRetry(f)) {
            expect(response.status).toBe(503);
            expect(response.body.state).toBeUndefined();
            expect(response.body.csrfToken).toBeUndefined();
        }
        observed.assertPassive();
    });

test('future SQL layout leaves accepted but unbound generic organisation read-only without creating admission', async () => {
    const f = await acceptedCustomer({ bound: false }), observed = futureLayout(f.h);
    for (const response of await readAndRetry(f)) {
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ state: { status: 'setup_read_only' } });
    }
    observed.assertPassive();
});

test.each(['company', 'consultant'])(
    'future SQL layout blocks verified legacy %s setup before account/details/context or invitation attempts', async accountType => {
        const h = customerProductionHarness({ starter: true, now: Date.now() });
        const start = await h.sameOrigin(request(h.app).post('/api/organisation-setup/request'))
            .send({ email: `${accountType}-setup@example.invalid`, accountType,
                organisationName: 'Synthetic retained setup' });
        expect(start.status).toBe(202);
        const cookie = start.headers['set-cookie'][0].split(';')[0];
        const post = action => h.sameOrigin(request(h.app).post('/api/organisation-setup/' + action))
            .set('Cookie', cookie).set('X-NoFries-Setup-Request', start.body.requestId);
        const verified = await post('verify').send({ code: h.state.delivered[0].text.match(/\b[0-9]{8}\b/)[0] });
        expect(verified.status).toBe(200); expect(verified.body.nextStep).toBe('details_required');
        expect(h.getContainer('starter-authority').records.size).toBe(0);
        const observed = futureLayout(h);
        const input = { name: 'Synthetic representative', role: 'Owner', address: 'Synthetic address',
            registrationId: '', authorityConfirmed: true };
        for (let attempt = 0; attempt < 2; attempt++) {
            const denied = await post('details').send(input);
            expect(denied.status).toBe(503);
            const retained = await request(h.app).get('/api/organisation-setup/state').set('Cookie', cookie);
            expect(retained.status).toBe(200); expect(retained.body).toEqual(verified.body);
        }
        expect(observed.trace.some(event => /set_config\('nofries\.tenant_id'/.test(event.sql) &&
            event.params[0] === h.env.NOFRIES_ENTRA_TENANT_ID)).toBe(true);
        expect(observed.trace.filter(event => /FROM nofries\./.test(event.sql))).toEqual([]);
        expect(h.getContainer('starter-authority').records.size).toBe(0);
        expect(h.state.delivered).toHaveLength(1);
        observed.assertPassive();
    });
