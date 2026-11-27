'use strict';

// Organisation profile service (#608 step 2) against a scripted transaction.
// Native SQL, the row-level policy and the permission checks are covered in
// test/integration/organisationProfileHttpPostgres.js.
const { OrganisationProfileError, normaliseOrganisationProfile, organisationProfile, READ_SQL, INSERT_SQL, UPDATE_SQL } =
    require('../api/shared/organisationProfile/organisationProfileService');

const SUBJECT = '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222';
const context = () => ({ requestId: '33333333-3333-4333-8333-333333333333', resolvedAt: '2026-11-27T08:00:00.000Z',
    scope: { tenantId: 'tenant-a', organisationId: 'org-a' }, identity: { authenticated: true, subjectKey: SUBJECT } });
jest.mock('../api/shared/appLifecycle/tenantRequestContext', () => ({ requireTenantRequestContext: value => value }));

function harness(initial = null) {
    let row = initial ? { ...initial } : null;
    const calls = [], events = [];
    const tx = {
        async query(sql, params) {
            calls.push(sql);
            if (sql === READ_SQL) return { rows: row ? [{ ...row }] : [] };
            if (sql === INSERT_SQL) {
                if (row) return { rowCount: 0 };
                row = { revision: 1, website: params[2], industry: params[3], region: params[4], size_band: params[5], updated_at: new Date(params[6]) };
                return { rowCount: 1 };
            }
            if (sql === UPDATE_SQL) {
                if (!row || row.revision !== params[2]) return { rowCount: 0 };
                row = { revision: row.revision + 1, website: params[3], industry: params[4], region: params[5], size_band: params[6], updated_at: new Date(params[7]) };
                return { rowCount: 1 };
            }
            throw new Error('unexpected SQL');
        }
    };
    const database = { withTenantTransaction: jest.fn(async (tenantId, work) => { expect(tenantId).toBe('tenant-a'); return work(tx); }) };
    const audit = { createEvent: jest.fn((ctx, action) => ({ action })), writeEvent: jest.fn(async event => { events.push(event); }) };
    const run = input => organisationProfile({ database, context: context(), clock: () => '2026-11-27T08:00:01.000Z', audit }, input);
    return { run, calls, events, row: () => row };
}
const body = values => ({ expectedRevision: 0, website: '', industry: '', region: '', sizeBand: '', ...values });

test('an organisation with no profile reads as revision 0 with every field empty', async () => {
    const h = harness();
    expect(await h.run()).toEqual({ schemaVersion: 1, revision: 0, website: null, industry: null, region: null, sizeBand: null, updatedAt: null });
    expect(h.events).toEqual([]);
});

test('the first save inserts revision 1 with a normalised website and writes one audit event', async () => {
    const h = harness();
    const saved = await h.run(body({ website: ' Example.CO.nz/about ', industry: 'retail', region: 'auckland', sizeBand: '6-20' }));
    expect(saved).toEqual({ schemaVersion: 1, revision: 1, website: 'https://example.co.nz/', industry: 'retail', region: 'auckland',
        sizeBand: '6-20', updatedAt: '2026-11-27T08:00:01.000Z' });
    expect(h.calls.filter(sql => sql === INSERT_SQL)).toHaveLength(1);
    expect(h.events).toEqual([{ action: { action: 'organisation.manage', module: 'overview', result: 'succeeded' } }]);
});

test('an update needs the current revision; a stale one is a conflict carrying the current profile and writes nothing', async () => {
    const h = harness({ revision: 2, website: null, industry: 'retail', region: 'otago', size_band: null, updated_at: new Date('2026-11-01T00:00:00Z') });
    const updated = await h.run(body({ expectedRevision: 2, industry: 'health' }));
    expect(updated).toMatchObject({ revision: 3, industry: 'health', region: null });
    let error;
    try { await h.run(body({ expectedRevision: 2, industry: 'education' })); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(OrganisationProfileError);
    expect([error.code, error.statusCode]).toEqual(['organisation_profile_conflict', 409]);
    expect(error.profile).toMatchObject({ revision: 3, industry: 'health' });
    expect(h.row()).toMatchObject({ revision: 3, industry: 'health' });
    expect(h.events).toHaveLength(1);
});

test('saving the same values again changes nothing and writes no audit event', async () => {
    const h = harness({ revision: 1, website: 'https://example.co.nz/', industry: 'retail', region: null, size_band: null, updated_at: new Date() });
    expect(await h.run(body({ expectedRevision: 1, website: 'example.co.nz', industry: 'retail' }))).toMatchObject({ revision: 1 });
    expect(h.calls.filter(sql => sql !== READ_SQL)).toEqual([]);
    expect(h.events).toEqual([]);
});

test.each([
    ['a missing key', { expectedRevision: 0, website: '', industry: '', region: '' }],
    ['an extra key', { ...body(), name: 'x' }],
    ['a negative revision', body({ expectedRevision: -1 })],
    ['a non-integer revision', body({ expectedRevision: '0' })],
    ['an unknown industry', body({ industry: 'mining' })],
    ['an unknown region', body({ region: 'mars' })],
    ['an unknown size', body({ sizeBand: '1000' })],
    ['a private website', body({ website: 'http://localhost/' })],
    ['an IP website', body({ website: 'https://10.0.0.1/' })],
    ['an array', []],
    ['null', null]
])('refuses %s before any database work', async (_label, input) => {
    expect(() => normaliseOrganisationProfile(input)).toThrow(expect.objectContaining({ code: 'organisation_profile_invalid', statusCode: 400 }));
    const h = harness();
    await expect(h.run(input)).rejects.toMatchObject({ code: 'organisation_profile_invalid' });
    expect(h.calls).toEqual([]);
});

test('a stored row that breaks the closed lists is unavailable, not shown', async () => {
    const h = harness({ revision: 1, website: null, industry: 'mining', region: null, size_band: null, updated_at: new Date() });
    await expect(h.run()).rejects.toMatchObject({ code: 'organisation_profile_unavailable', statusCode: 503 });
});
