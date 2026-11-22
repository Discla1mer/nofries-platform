'use strict';

// Genuine request binder, scoped contexts, paid evaluator and paired audit over
// controlled synthetic SQL. Native PostgreSQL/RLS coverage is in
// test/integration/paidFrameworkStatusPostgres.js.
jest.mock('../api/shared/appLifecycle/postgresDashboardBootstrap', () => {
    const actual = jest.requireActual('../api/shared/appLifecycle/postgresDashboardBootstrap');
    return { ...actual, dataStorage: { ...actual.dataStorage, loadSnapshotForShare: jest.fn(), loadSnapshotForUpdate: jest.fn() } };
});
jest.mock('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore', () => {
    const actual = jest.requireActual('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
    return { ...actual, readHead: jest.fn(), readHistory: jest.fn() };
});
const { createDashboardResourceRuntime } = require('../api/shared/dashboardRuntime');
const { createImprovementRequestFixture } = require('./fixtures/improvementRequestFixture');
const { STARTER_PROOF_SQL, STATUS_SQL, normalisePaidStatusPage, statusRows } = require('../api/shared/assessmentLifecycle/paidFrameworkStatus');

const NIST = { profileId: 'nf-nist-csf-2-0-core', profileVersion: '2026-09-08.1' };
const ISO = { profileId: 'nf-iso-27001-2022-readiness', profileVersion: '2026-11-19.1' };

function setup({ refs = [NIST], proof = true, heads = { [NIST.profileId]: 'in-progress' }, paid = true, sessionEndsAt } = {}) {
    const h = createImprovementRequestFixture({ profileRefs: refs, ...(sessionEndsAt ? { sessionEndsAt } : {}) });
    const original = h.options.pool;
    h.statusQueries = []; h.proofQueries = [];
    h.proof = proof; h.heads = heads;
    h.options.pool = { end: original.end, connect: jest.fn(async () => {
        const client = await original.connect();
        return { release: client.release, query: async (sql, params = []) => {
            if (sql === STARTER_PROOF_SQL) {
                h.proofQueries.push(params);
                const row = h.rows.binding;
                return { rows: h.proof && params[1].includes(row.binding_id) && params[0] === h.SUBJECT ? [{ binding_id: row.binding_id,
                    tenant_id: row.tenant_id, organisation_id: row.organisation_id, authority_id: row.authority_id }] : [] };
            }
            if (sql === STATUS_SQL) {
                h.statusQueries.push(params);
                if (h.afterStatus) h.afterStatus();
                expect(params.slice(0, 2)).toEqual([h.example.scope.tenantId, h.example.scope.organisationId]);
                return { rows: params[2].map((profileId, i) => ({ profile_id: profileId, profile_version: params[3][i],
                    status: h.heads[profileId] || 'not_started' })) };
            }
            if (/FROM nofries\.dashboard_paid_framework_access\b/.test(sql)) return { rows: [] };
            return client.query(sql, params);
        } };
    }) };
    if (paid) h.options.paidFrameworksEnabled = true;
    h.runtime = createDashboardResourceRuntime(h.options);
    h.read = (input = { afterBindingId: null }, request = h.request()) => {
        let check = null;
        return h.runtime.readPaidFrameworkStatus(request, { expectedGeneration: h.session.generationToken }, input, value => { check = value; })
            .then(result => { h.check = check; return result; });
    };
    return h;
}
const reads = h => h.state.committed.auditRows.filter(row => row.payload.action === 'assessment.read');

test('an authorised adviser sees status-only rows for an activated client with paired audit and no selection change', async () => {
    const h = setup({ refs: [NIST, ISO], heads: { [NIST.profileId]: 'created', [ISO.profileId]: 'submitted' } });
    const session = JSON.stringify(h.rows.session);
    const result = await h.read();
    expect(result).toEqual({ rows: [
        { bindingId: h.binding.bindingId, moduleId: 'cyber_security', profileId: ISO.profileId, version: ISO.profileVersion, status: 'submitted' },
        { bindingId: h.binding.bindingId, moduleId: 'cyber_security', profileId: NIST.profileId, version: NIST.profileVersion, status: 'in_progress' }] });
    expect(JSON.stringify(result)).not.toMatch(/tenantId|organisationId|assessmentId|responses|rationale|updatedAt|organisationLabel/);
    // One batched starter proof for the page and one for the recheck; one aggregate per client.
    expect(h.proofQueries).toHaveLength(2);
    expect(h.statusQueries).toEqual([[h.example.scope.tenantId, h.example.scope.organisationId,
        [ISO.profileId, NIST.profileId], [ISO.profileVersion, NIST.profileVersion]]]);
    expect(reads(h)).toHaveLength(1);
    expect(reads(h)[0]).toMatchObject({ tenant_id: h.example.scope.tenantId, payload: { module: 'cyber_security', result: 'succeeded' } });
    expect(JSON.stringify(h.rows.session)).toBe(session);
    expect(typeof h.check).toBe('function'); expect(h.check()).toBe(h.state.at);
    expect(h.state.borrows).toBe(h.state.released);
});

test('only exactly entitled tuples are read; an empty history is not started', async () => {
    const h = setup({ heads: {} });
    expect((await h.read()).rows).toEqual([expect.objectContaining({ profileId: NIST.profileId, status: 'not_started' })]);
    expect(h.statusQueries[0][2]).toEqual([NIST.profileId]);
});

test.each([
    ['no activated starter client proof', h => { h.proof = false; }],
    ['an ended membership', h => { h.snapshot.membershipState.memberships[0].status = 'suspended'; }],
    ['no exact paid grant', h => { h.snapshot.flags.frameworks = []; }]
])('%s contributes no row, status query or audit', async (_label, change) => {
    const h = setup(); change(h);
    expect(await h.read()).toEqual({ rows: [] });
    expect(h.statusQueries).toEqual([]); expect(reads(h)).toHaveLength(0);
    expect(h.state.borrows).toBe(h.state.released);
});

test('an invalid or unknown head fails the whole page as unavailable', async () => {
    const h = setup({ heads: { [NIST.profileId]: 'invalid' } });
    await expect(h.read()).rejects.toMatchObject({ code: 'framework_unavailable', statusCode: 503 });
    expect(reads(h)).toHaveLength(0);
});

test('revocation after the status read discards the whole page', async () => {
    const h = setup();
    h.afterStatus = () => { h.snapshot.membershipState.memberships[0].status = 'suspended'; };
    await expect(h.read()).rejects.toMatchObject({ code: 'framework_access_denied', statusCode: 403 });
    expect(reads(h)).toHaveLength(0);
    expect(h.state.borrows).toBe(h.state.released);
});

test('the response-time disclosure check enforces session expiry after the read settles', async () => {
    const cutoff = '2026-09-07T11:00:30.000Z', h = setup({ sessionEndsAt: cutoff });
    await h.read();
    h.state.at = cutoff;
    expect(() => h.check()).toThrow(expect.objectContaining({ code: 'framework_access_denied' }));
});

test('stale generations, non-customer sessions and reused requests are refused', async () => {
    const h = setup();

    await expect(h.runtime.readPaidFrameworkStatus(h.request(), { expectedGeneration: 'f'.repeat(64) }, { afterBindingId: null }))
        .rejects.toMatchObject({ statusCode: 403 });
    await expect(h.read(undefined, h.request({ kind: 'operator_dashboard' }))).rejects.toMatchObject({ statusCode: 403 });
    const request = h.request();
    expect((await h.read(undefined, request)).rows).toHaveLength(1);
    await expect(h.read(undefined, request)).rejects.toMatchObject({ statusCode: 403 });
    await expect(h.read({ afterBindingId: 'not-a-uuid' })).rejects.toMatchObject({ statusCode: 403 });
    expect(h.statusQueries).toHaveLength(1);
});

test('flag off exposes no status capability and issues no SQL', () => {
    const h = setup({ paid: false });
    expect(h.runtime.readPaidFrameworkStatus).toBeUndefined();
    expect(h.options.pool.connect).not.toHaveBeenCalled();
});

test('page and row codecs accept only the documented shapes', () => {
    expect(normalisePaidStatusPage({ afterBindingId: null })).toEqual({ afterBindingId: null });
    for (const input of [{}, { afterBindingId: 'x' }, { afterBindingId: null, tenantId: 't' }]) {
        expect(() => normalisePaidStatusPage(input)).toThrow(expect.objectContaining({ statusCode: 400 }));
    }
    const pins = [{ profileId: 'a', version: '1' }];
    expect(statusRows({ rows: [{ profile_id: 'a', profile_version: '1', status: 'in-progress' }] }, pins)).toEqual(['in_progress']);
    for (const rows of [[], [{ profile_id: 'a', profile_version: '2', status: 'submitted' }], [{ profile_id: 'a', profile_version: '1', status: 'invalid' }]]) {
        expect(() => statusRows({ rows }, pins)).toThrow(expect.objectContaining({ statusCode: 503 }));
    }
});
