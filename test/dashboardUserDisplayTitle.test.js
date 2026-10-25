'use strict';

jest.mock('../api/shared/appLifecycle/postgresDashboardBootstrap', () => {
    const actual = jest.requireActual('../api/shared/appLifecycle/postgresDashboardBootstrap');
    return { ...actual, dataStorage: { ...actual.dataStorage, loadSnapshotForShare: jest.fn() } };
});
let mockProjectionTitle = null;
jest.mock('../api/shared/dashboardAdmission', () => {
    const actual = jest.requireActual('../api/shared/dashboardAdmission');
    return { ...actual, createDashboardAdmissionDecision(adapters) {
        const decide = actual.createDashboardAdmissionDecision(adapters);
        return async (...args) => {
            const result = await decide(...args);
            return mockProjectionTitle === null || result.outcome !== 'succeeded' ? result : {
                ...result, projection: { ...result.projection, currentUser: { jobTitle: mockProjectionTitle } }
            };
        };
    } };
});

const { createStarterAccountAllocator } = require('../api/shared/customerSignup/starterAccountAllocation');
const { compileStarterProvisioning, compileStarterAdmission } = require('../api/shared/customerSignup/starterProvisioning');
const { readDashboardUserProfile } = require('../api/shared/appLifecycle/dashboardUserProfile');
const { projectDashboard } = require('../api/shared/appLifecycle/dashboardProjection');
const { createDashboardAdmissionDecision } = require('../api/shared/dashboardAdmission');
const shell = require('../api/shared/protectedAssets/dashboardShell');
const { admissionFixture } = require('./fixtures/dashboardAdmissionFixture');
const { fixture } = require('./fixtures/dashboardFixture');
const { createDom } = require('./fixtures/dashboardDom');
const domain = require('../api/shared/appLifecycle/dashboardOnboardingDomain');
const { projectCurrentRow } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { dataStorage } = require('../api/shared/appLifecycle/postgresDashboardBootstrap');
const { createDashboardRequestDatabase } = require('../api/shared/database/dashboardRequestDatabase');

const AT = '2026-10-01T10:00:00.000Z';
const id = n => '85000000-0000-4000-8000-' + String(n).padStart(12, '0');
const clone = value => JSON.parse(JSON.stringify(value));
afterEach(() => { mockProjectionTitle = null; });

// Compile real retained records from synthetic setup/consent; do not mock the
// preparation or activation validators used by the new optional read.
async function savedProfile(jobTitle = 'Managing Director') {
    let stored, sequence = 100;
    const subjectKey = id(1) + ':' + id(2), requestId = id(3), at = Date.parse(AT);
    const accounts = createStarterAccountAllocator({ now: () => at, newId: () => id(++sequence),
        captureOwner: async () => null, readActivation: async () => null,
        store: { load: async () => stored ?? null,
            create: async (_, record) => { stored = { record, version: '1' }; return true; }, replace: async () => false } });
    const account = await accounts.reserveInitial({ schemaVersion: 1, requestId,
        email: 'synthetic-title@example.test', organisationName: 'Synthetic title workspace', accountType: 'company',
        status: 'verified', codeHash: null, attempts: 0, createdAt: at - 1000,
        codeExpiresAt: at + 599000, expiresAt: at + 86399000, verifiedAt: at });
    const slot = account.organisations[0];
    const source = { offerInput: {
        ...Object.fromEntries(['tenantId', 'organisationId', 'organisationName', 'grantId', 'scheduleId', 'kind'].map(key => [key, slot[key]])),
        accountType: account.accountType,
        contact: { name: 'Synthetic Person', role: jobTitle, email: account.email,
            address: 'Synthetic address', registrationId: null, authorityEvidenceId: id(4) },
        framework: { moduleId: 'cyber_security', profileId: 'synthetic-profile', version: '1', scoringVersion: '1' }
    }, subjectKey, issuerSubjectKey: subjectKey, invitationId: id(5), createdAt: AT };
    const preparation = compileStarterProvisioning({ account, requestId, source });
    const compiled = compileStarterAdmission({ preparation, accountActivatedAt: null, occurredAt: AT,
        identity: { policyId: 'synthetic-title-policy', policyRevision: 0, issuer: 'https://identity.example.test/v2.0',
            identityTenantId: id(1), oid: id(2), audience: 'synthetic-title-client' },
        acceptance: { receiptId: id(6), invitationId: preparation.invitationId, subjectKey, ...preparation.scope,
            ...preparation.terms, scheduleId: preparation.schedule.scheduleId, scheduleDigest: preparation.schedule.scheduleDigest,
            acceptedAt: at, status: 'pending_admission', dashboardAccess: false } });
    const member = compiled.nextState.membershipState.memberships[0];
    const selector = { scope: preparation.scope, subjectKey, bindingId: slot.bindingId, authorityId: slot.authorityId,
        ...Object.fromEntries(['membershipId', 'invitationId', 'grantEvidenceId', 'validFrom', 'validUntil'].map(key => [key, member[key]])) };
    const row = { preparation, activation: compiled.activation };
    const tx = { query: jest.fn(async () => ({ rows: [clone(row)] })) };
    return { selector, row, tx, compiled, input: { ...compiled.nextState, advisorAssignments: {},
        summary: null, scope: preparation.scope, subjectKey, now: AT } };
}

function boundProfile(input, jobTitle) {
    return { ...input.scope, subjectKey: input.subjectKey,
        membershipId: input.membershipState.memberships[0].membershipId, jobTitle };
}
function render(model) {
    const dom = createDom(); shell.mount(dom.root, model); return dom;
}

async function hostProfile(options = {}) {
    const f = await savedProfile(), identity = f.compiled.activation.identity;
    const { usage: ignoredUsage, ...currentAuthority } = f.compiled.nextState;
    const binding = domain.publishExistingMembershipBinding({ ...f.compiled.command,
        receiptId: id(20), actorSubjectKey: f.selector.subjectKey, at: AT, currentAuthority }).binding;
    const expiresAt = options.sessionExpiresAt || '2026-10-01T11:00:00.000Z';
    const seed = { identityPayload: identity, instanceId: id(21), restoreEpoch: id(22), issuedAt: AT, expiresAt };
    const session = domain.applySessionCommand({ predecessor: null, command: { schemaVersion: 1,
        operationType: 'activateCustomerSession', operationId: id(23), sessionSha256: '2'.repeat(64),
        actorSubjectKey: f.selector.subjectKey, payload: { seed, bindingId: binding.bindingId } },
    facts: { occurredAt: AT, generationToken: '3'.repeat(64), binding } }).record;
    const instance = { schemaVersion: 1, instanceId: seed.instanceId, revision: 1, restoreEpoch: seed.restoreEpoch,
        ingressStatus: 'enabled', changedAt: AT, evidenceRef: 'synthetic-title-instance', evidenceSha256: '4'.repeat(64) };
    const admission = f.compiled.activation.admission;
    const fixed = Object.fromEntries([
        ['dashboard_runtime_instance', 'instance', instance, { receiptId: id(24) }],
        ['dashboard_session_gates', 'session', session], ['dashboard_identity_bindings', 'binding', binding],
        ['dashboard_admission_authorities', 'authority', admission], ['dashboard_admission_decisions', 'admission', admission]
    ].map(([table, kind, record, meta]) => [table, projectCurrentRow(kind, record, meta)]));
    const state = { at: AT, profileRows: [clone(f.row)], trace: [], afterProfileRead: null, audits: new Map(), released: 0 };
    const source = { ...clone(f.compiled.nextState), advisorAssignments: [], usage: [] };
    dataStorage.loadSnapshotForShare.mockReset().mockImplementation(async () => clone(source));
    const pool = { end: jest.fn(), connect: jest.fn(async () => ({
        async query(sql, params = []) {
            state.trace.push({ sql, params: clone(params) });
            if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(sql) || /(?:set_config|pg_advisory_xact_lock)/.test(sql)) return { rows: [] };
            for (const [table, row] of Object.entries(fixed)) if (sql.includes('FROM nofries.' + table + ' ')) return { rows: [clone(row)] };
            if (sql.includes('FROM nofries.dashboard_starter_scopes')) {
                const rows = clone(state.profileRows);
                if (state.afterProfileRead) state.afterProfileRead();
                return { rows };
            }
            if (sql.includes('SELECT octet_length')) return { rows: [{ payload_bytes: 1024 }] };
            if (sql.includes('FROM nofries.dashboard_runtime_audit')) return { rows: state.audits.has(params[0]) ? [clone(state.audits.get(params[0]))] : [] };
            if (sql.includes('INSERT INTO nofries.dashboard_runtime_audit')) {
                const columns = /dashboard_runtime_audit\s*\(([^)]+)\)/.exec(sql)[1].split(',').map(value => value.trim());
                const row = Object.fromEntries(columns.map((column, index) => [column,
                    ['payload', 'scope_json'].includes(column) ? JSON.parse(params[index]) : params[index]]));
                state.audits.set(row.event_id, row); return { rows: [] };
            }
            throw new Error('Unexpected synthetic host query');
        }, release() { state.released++; }
    })) };
    const request = { method: 'GET', body: { jobTitle: 'Injected request title' } };
    const host = createDashboardRequestDatabase({ pool, clock: () => state.at, instanceId: instance.instanceId,
        historyBudget: { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 },
        readExternalRuntimeEpoch: async () => ({ instanceId: instance.instanceId, restoreEpoch: instance.restoreEpoch }),
        newId: () => id(25), resolveSubmissionQuota: () => { throw new Error('No write expected'); },
        captureRequest: async original => original === request ? {
            requestId: id(26), deadline: '2026-10-01T10:01:00.000Z', sessionSha256: session.sessionSha256,
            kind: 'customer', identityPayload: identity, instanceId: instance.instanceId, restoreEpoch: instance.restoreEpoch,
            issuedAt: AT, expiresAt, operatorIssuanceProof: null, discovery: null
        } : null });
    return { ...f, state, pool, read: () => host.handleHostResource(request, { route: 'bootstrap', expectedGeneration: session.generationToken }) };
}

test('real host bootstrap composes the retained personal title and rechecks it before the sealed response', async () => {
    const f = await hostProfile(), response = await f.read();
    expect(response.status).toBe(200);
    expect(response.body.currentUser).toEqual({ jobTitle: 'Managing Director' });
    expect(response.body.audience).toBe('IT manager');
    const reads = f.state.trace.filter(event => event.sql.includes('FROM nofries.dashboard_starter_scopes'));
    expect(reads.length).toBe(2);
    expect(f.state.audits.size).toBe(1);
    expect(f.state.released).toBe(f.pool.connect.mock.calls.length);
    expect(f.state.trace.filter(event => event.sql === 'COMMIT').length).toBe(2);
});

test('real host bootstrap preserves a legacy account with no stored personal title', async () => {
    const f = await hostProfile(); f.state.profileRows = [];
    expect((await f.read()).body.currentUser).toEqual({ jobTitle: null });
});

test('session expiry during the optional title read still prevents bootstrap disclosure', async () => {
    const f = await hostProfile({ sessionExpiresAt: '2026-10-01T10:00:01.000Z' });
    f.state.afterProfileRead = () => { f.state.at = '2026-10-01T10:00:01.000Z'; };
    await expect(f.read()).rejects.toMatchObject({ code: 'dashboard_access_denied', statusCode: 403 });
    expect(f.state.trace.filter(event => event.sql === 'COMMIT').length).toBe(1);
    expect(f.state.trace.filter(event => event.sql === 'ROLLBACK').length).toBe(1);
    expect(f.state.released).toBe(f.pool.connect.mock.calls.length);
});

test('sealed host comparison refuses a projected title that differs from the authorised persisted title', async () => {
    const f = await hostProfile(); mockProjectionTitle = 'Injected projected title';
    await expect(f.read()).rejects.toMatchObject({ code: 'dashboard_unavailable', statusCode: 503 });
    expect(f.state.trace.filter(event => event.sql === 'COMMIT').length).toBe(1);
    expect(f.state.trace.filter(event => event.sql === 'ROLLBACK').length).toBe(1);
});

test('activated title read selects the current subject, tenant, organisation, binding and authority and emits only display data', async () => {
    const f = await savedProfile();
    const profile = await readDashboardUserProfile(f.tx, f.selector, AT);
    const [sql, params] = f.tx.query.mock.calls[0];
    expect(sql).toMatch(/tenant_id = \$1 AND organisation_id = \$2 AND subject_key = \$3/);
    expect(sql).toMatch(/binding_id = \$4 AND authority_id = \$5 AND activation IS NOT NULL/);
    expect(params).toEqual([f.selector.scope.tenantId, f.selector.scope.organisationId,
        f.selector.subjectKey, f.selector.bindingId, f.selector.authorityId]);
    expect(profile).toEqual({ ...f.selector.scope, subjectKey: f.selector.subjectKey,
        membershipId: f.selector.membershipId, jobTitle: 'Managing Director' });
    expect(Object.isFrozen(profile)).toBe(true);
    const model = projectDashboard({ ...f.input, currentUserProfile: profile });
    expect(model.currentUser).toEqual({ jobTitle: 'Managing Director' });
    expect(model.audience).toBe('IT manager');
    for (const key of ['subjectKey', 'membershipId', 'email', 'address', 'authorityEvidenceId', 'source']) {
        expect(JSON.stringify(model)).not.toContain('"' + key + '"');
    }
    const dom = render(model);
    expect(dom.root.querySelector('.dashboard-context').textContent).toContain('Managing Director');
    expect(dom.root.querySelector('.dashboard-topbar').textContent).toContain('Managing Director');
    expect(dom.root.querySelector('.dashboard-context').textContent).not.toContain('IT manager');
});

test('no retained personal record yields an omitted title while the old audience and modules remain available', async () => {
    const f = await savedProfile(); f.tx.query.mockResolvedValue({ rows: [] });
    expect(await readDashboardUserProfile(f.tx, f.selector, AT)).toBeNull();
    const input = fixture(), model = projectDashboard(input), dom = render(model);
    expect(model.currentUser).toEqual({ jobTitle: null });
    expect(model.audience).toBe('IT manager');
    expect(dom.root.querySelector('.dashboard-context').textContent).not.toContain('IT manager');
    expect(dom.root.querySelector('.dashboard-topbar').textContent).not.toContain('IT manager');
    const menus = [dom.root.querySelector('.dashboard-rail').querySelector('nav'),
        dom.root.querySelector('.dashboard-mobile-nav')];
    for (const menu of menus) {
        expect(menu.querySelectorAll('[data-module]').map(link => link.dataset.module).sort())
            .toEqual(model.modules.map(item => item.key).sort());
    }
});

test.each(['subjectKey', 'bindingId', 'authorityId', 'membershipId', 'invitationId', 'grantEvidenceId', 'validFrom', 'validUntil',
    'tenantId', 'organisationId'])('a retained title returned for a different %s cannot be disclosed', async field => {
    const f = await savedProfile(), selector = clone(f.selector);
    if (field === 'subjectKey') selector.subjectKey = id(1) + ':' + id(9);
    else if (field === 'tenantId' || field === 'organisationId') selector.scope[field] = id(9);
    else if (field === 'validFrom') selector.validFrom = '2026-10-01T09:59:59.999Z';
    else if (field === 'validUntil') selector.validUntil = '2026-10-15T10:00:00.001Z';
    else selector[field] = id(9);
    await expect(readDashboardUserProfile(f.tx, selector, AT)).rejects.toMatchObject({
        code: 'dashboard_unavailable', statusCode: 503, message: 'Dashboard persistence refused: unavailable' });
});

test.each(['unactivated', 'changed offer', 'changed activation', 'multiple rows', 'driver failure', 'getter'])
('a stored title source with %s never becomes a display label', async kind => {
    const f = await savedProfile(), row = clone(f.row); let getters = 0;
    if (kind === 'unactivated') row.activation = null;
    if (kind === 'changed offer') row.preparation.source.offerInput.contact.role = 'Other saved role';
    if (kind === 'changed activation') row.activation.subjectKey = id(1) + ':' + id(9);
    if (kind === 'getter') Object.defineProperty(row, 'preparation', { enumerable: true,
        get() { getters++; return f.row.preparation; } });
    f.tx.query.mockResolvedValue({ rows: kind === 'multiple rows' ? [row, row] : [row] });
    if (kind === 'driver failure') f.tx.query.mockRejectedValue(new Error('synthetic private driver detail'));
    await expect(readDashboardUserProfile(f.tx, f.selector, AT)).rejects.toMatchObject({
        code: 'dashboard_unavailable', statusCode: 503, message: 'Dashboard persistence refused: unavailable' });
    expect(getters).toBe(0);
});

test('expired title selection is refused before its optional SQL read', async () => {
    const f = await savedProfile();
    await expect(readDashboardUserProfile(f.tx, f.selector, f.selector.validUntil)).rejects.toMatchObject({ code: 'dashboard_unavailable' });
    expect(f.tx.query).not.toHaveBeenCalled();
});

test('users with the same permissions can have different entered titles without changing any capability', () => {
    const input = fixture({ empty: true });
    const first = projectDashboard({ ...input, currentUserProfile: boundProfile(input, 'Business owner') });
    const secondInput = clone(input), secondSubject = id(1) + ':' + id(2);
    secondInput.subjectKey = secondSubject;
    for (const row of [...secondInput.membershipState.memberships, ...secondInput.membershipState.invitations]) {
        row.subjectKey = secondSubject; row.createdBy = secondSubject; row.updatedBy = secondSubject;
    }
    const second = projectDashboard({ ...secondInput, currentUserProfile: boundProfile(secondInput, 'Operations Director') });
    expect(first.currentUser.jobTitle).toBe('Business owner'); expect(second.currentUser.jobTitle).toBe('Operations Director');
    const { currentUser: ignoredFirst, ...firstCapabilities } = first;
    const { currentUser: ignoredSecond, ...secondCapabilities } = second;
    expect(firstCapabilities).toEqual(secondCapabilities);
});

test.each(['tenantId', 'organisationId', 'subjectKey', 'membershipId'])('projection refuses a profile with foreign %s', field => {
    const input = fixture(), profile = boundProfile(input, 'Managing Director'); profile[field] = 'foreign';
    expect(() => projectDashboard({ ...input, currentUserProfile: profile })).toThrow('dashboard_unavailable');
});

test.each(['admin', 'editor', 'viewer'])('missing %s title never falls back to the audience label, including old payloads', role => {
    const model = clone(projectDashboard(fixture({ role, empty: true }))); delete model.currentUser;
    const validated = shell.validate(model), dom = render(model);
    expect(validated.currentUser).toEqual({ jobTitle: null });
    expect(dom.root.querySelector('.dashboard-context').textContent).not.toContain(model.audience);
    expect(dom.root.querySelector('.dashboard-topbar').textContent).not.toContain(model.audience);
});

test.each(['', ' ', 'x'.repeat(121), ' Director', 'Director\nOwner', '<img src=x onerror=alert(1)>',
    'Director\u0085Owner', 'e\u0301', null, 42, { role: 'owner' }])('malformed job title %j is refused by the server and browser display contracts', jobTitle => {
    const input = fixture({ empty: true });
    expect(() => projectDashboard({ ...input, currentUserProfile: boundProfile(input, jobTitle) })).toThrow('dashboard_unavailable');
    if (jobTitle !== null) {
        const model = clone(projectDashboard(input)); model.currentUser = { jobTitle };
        expect(() => shell.validate(model)).toThrow('invalid');
        expect(render(model).root.querySelector('.dashboard-status-panel')).not.toBeNull();
    }
});

test('safe entered title renders as text and survives a context replacement without stale titles', () => {
    const input = fixture({ empty: true }), dom = createDom();
    const model = projectDashboard({ ...input, currentUserProfile: boundProfile(input, 'Director & Co-owner') });
    const old = shell.mount(dom.root, model);
    expect(dom.root.querySelector('.dashboard-topbar').textContent).toContain('Director & Co-owner');
    shell.mount(dom.root, projectDashboard(input)); old.destroy();
    expect(dom.root.querySelector('.dashboard-topbar')).not.toBeNull();
    expect(dom.root.textContent).not.toContain('Director & Co-owner');
});

test('only the trusted detached snapshot supplies the title; request and principal title claims grant nothing', async () => {
    const f = admissionFixture({ empty: true }), load = f.adapters.loadSnapshot;
    f.adapters.loadSnapshot = async (...args) => ({ ...await load(...args),
        currentUserProfile: boundProfile(f.state.input, 'Managing Director') });
    const decide = createDashboardAdmissionDecision(f.adapters);
    const result = await decide({ body: { jobTitle: 'Injected request title' }, claims: { jobTitle: 'Injected token title' } });
    expect(result.projection.currentUser.jobTitle).toBe('Managing Director');
    f.adapters.authenticate = async () => ({ authenticated: true, subjectKey: f.state.subjectKey, jobTitle: 'Injected principal title' });
    await expect(createDashboardAdmissionDecision(f.adapters)({})).rejects.toMatchObject({ code: 'dashboard_unavailable' });
});

test('detached profile getters cannot run and a correct title never rescues removed or expired membership', async () => {
    const f = admissionFixture({ empty: true }), load = f.adapters.loadSnapshot; let getters = 0;
    const profile = boundProfile(f.state.input, 'Managing Director');
    Object.defineProperty(profile, 'jobTitle', { enumerable: true, get() { getters++; return 'Injected getter title'; } });
    f.adapters.loadSnapshot = async (...args) => ({ ...await load(...args), currentUserProfile: profile });
    await expect(createDashboardAdmissionDecision(f.adapters)({})).rejects.toMatchObject({ code: 'dashboard_unavailable' });
    expect(getters).toBe(0);
    for (const status of ['suspended', 'removed', 'expired']) {
        const input = clone(f.state.input), safe = boundProfile(input, 'Managing Director');
        if (status === 'expired') input.now = input.membershipState.memberships[0].validUntil;
        else input.membershipState.memberships[0].status = status;
        expect(() => projectDashboard({ ...input, currentUserProfile: safe })).toThrow('dashboard_unavailable');
    }
});
