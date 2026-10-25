'use strict';
const { projectSignupRecord, projectSignupPage } = require('../api/shared/dashboardAdmin/signupProjection');
const f = require('./fixtures/dashboardAdminSignupFixture');
const project = input => projectSignupPage(input, f.grant(), { now: f.NOW, limit: 2 });
describe('closed signup evidence projection', () => {
    test('projects only captured fields and genuine timestamps without IDs/proofs/diagnostics', () => {
        const row = project(f.page()).rows[0];
        expect(Object.keys(row)).toEqual(['email', 'organisation', 'accountType', 'milestones']);
        expect(row).toMatchObject({ email: 'person1@example.invalid', accountType: 'company', milestones: {
            accountSaved: { status: 'recorded', at: '2026-10-20T06:50:00.000Z' },
            setupSaved: { status: 'recorded', at: '2026-10-20T06:51:00.000Z' },
            termsAccepted: { status: 'recorded', at: '2026-10-20T06:53:00.000Z' },
            accountActivated: { status: 'unknown', at: null }, admission: { status: 'awaiting_admission', at: null } } });
        expect(JSON.stringify(row)).not.toMatch(/74000000|termsDigest|identity|subject|proof|lastActive|visits|verificationAttempts|completed|diagnostics/);
        expect(Object.isFrozen(row.milestones.admission)).toBe(true);
    });
    test('activation is historical and pending registration never overrides it', () => {
        const r = f.record(); r.account.value.activation = { subjectKey: f.SUBJECT, receiptId: r.acceptance.value.receiptId,
            activatedAt: '2026-10-20T06:54:00.000Z', validUntil: '2026-11-20T06:54:00.000Z' };
        expect(project(f.page([r])).rows[0].milestones).toMatchObject({ accountActivated: { status: 'recorded', at: r.account.value.activation.activatedAt }, admission: { status: 'unknown', at: null } });
        r.registration.value.status = 'revoked';
        expect(project(f.page([r])).rows[0].milestones.admission).toEqual({ status: 'revoked', at: null });
    });
    test.each(['unknown', 'unavailable'])('preserves %s facts and never infers activation/admission', state => {
        const r = f.record(); for (const key of ['account', 'setup', 'acceptance', 'registration']) r[key] = { state };
        const result = project(f.page([r])).rows[0];
        expect(result.email).toBeNull(); expect(result.organisation).toBeNull(); expect(result.accountType).toBeNull();
        for (const item of Object.values(result.milestones)) expect(item).toEqual({ status: state, at: null });
    });
    test('pending registration with unavailable account does not prove awaiting admission', () => {
        const r = f.record(); r.account = { state: 'unavailable' };
        expect(project(f.page([r])).rows[0].milestones.admission).toEqual({ status: 'unknown', at: null });
    });
    test.each(['provider', 'tenantId', 'populationId', 'indexId'])('rejects page %s scope mismatch', key => {
        const p = f.page(); p[key] = 'foreign'; expect(() => project(p)).toThrow();
    });
    test.each(['provider', 'tenantId', 'organisationId', 'accountId', 'setupRequestId', 'subjectKey'])('rejects conflicting %s fact bindings', key => {
        const r = f.record(); r.setup.binding[key] = key === 'subjectKey' ? f.TENANT + ':' + f.uid(99) : f.uid(99);
        expect(() => project(f.page([r]))).toThrow();
    });
    const invalid = {
        'future observation': p => { p.observedAt = '2026-10-20T07:00:00.001Z'; },
        'stale observation': p => { p.observedAt = '2026-10-20T06:59:29.999Z'; },
        'missing record collection': p => { delete p.records; },
        'malformed collection': p => { p.records = {}; },
        'oversize page': p => { p.records = [f.record(), f.record(2), f.record(3)]; },
        'duplicate row': p => { p.records.push(f.record()); },
        'duplicate account different record': p => { const r = f.record(); r.recordId += '-copy'; p.records.push(r); },
        'unavailable with rows': p => { p.status = 'unavailable'; },
        'empty with cursor': p => { p.records = []; p.nextCursor = 'source-next'; },
        'oversize cursor': p => { p.nextCursor = 'x'.repeat(257); },
        'raw source credentials': p => { p.records[0].account.value.proof = 'secret'; },
        'unknown fact with data': p => { p.records[0].setup = { state: 'unknown', value: {} }; },
        'missing fact': p => { delete p.records[0].acceptance; },
        'bad source revision': p => { p.records[0].account.revision = ''; },
        'future creation': p => { p.records[0].account.value.createdAt = '2026-10-21T00:00:00.000Z'; },
        'noncanonical email': p => { p.records[0].account.value.email = 'UPPER@example.invalid'; },
        'CRM account type': p => { p.records[0].account.value.accountType = 'customer'; },
        'HTML name': p => { p.records[0].account.value.organisation = '<img>'; },
        'future terms': p => { p.records[0].acceptance.value.acceptedAt = Date.parse(f.NOW) + 1; },
        'terms before setup': p => { p.records[0].acceptance.value.acceptedAt = Date.parse('2026-10-20T06:49:00.000Z'); },
        'invented dashboard access': p => { p.records[0].acceptance.value.dashboardAccess = true; },
        'inconsistent terms': p => { p.records[0].registration.value.termsDigest = 'b'.repeat(64); },
        'revoked timestamp invented': p => { p.records[0].registration.value.revokedAt = f.NOW; },
        'foreign identity': p => { p.records[0].account.value.identitySubjectKey = f.TENANT + ':' + f.uid(99); },
        'negative revision': p => { p.records[0].registration.value.revision = -1; }
    };
    test.each(Object.entries(invalid))('rejects %s', (_, change) => { const p = f.page(); change(p); expect(() => project(p)).toThrow(); });
    test('snapshot continuity enforced and empty is distinct from unavailable', () => {
        expect(() => projectSignupPage(f.page(), f.grant(), { now: f.NOW, limit: 2, snapshotId: 'other' })).toThrow();
        expect(project(f.page([]))).toMatchObject({ status: 'available', rows: [] });
        expect(project({ ...f.page([]), status: 'unavailable' })).toMatchObject({ status: 'unavailable', rows: [] });
    });
    test('rejects accessors, proxies, sparse arrays without executing them', () => {
        const p = f.page(), getter = jest.fn(); Object.defineProperty(p.records[0], 'account', { enumerable: true, get: getter });
        expect(() => project(p)).toThrow(); expect(getter).not.toHaveBeenCalled();
        expect(() => project(new Proxy(f.page(), {}))).toThrow();
        const sparse = f.page(); sparse.records = new Array(1); expect(() => project(sparse)).toThrow();
    });
    test('activation ID is distinct from the acceptance receipt ID', () => {
        const r = f.record(); r.account.value.activation = { subjectKey: f.SUBJECT, receiptId: f.uid(999), activatedAt: '2026-10-20T06:54:00.000Z', validUntil: '2026-10-21T06:54:00.000Z' };
        expect(projectSignupRecord(r, f.grant(), f.NOW).milestones.accountActivated.status).toBe('recorded');
    });
});

test('chronology remains coherent when intermediate sources are unknown/unavailable', () => {
    const r = f.record(); r.setup = { state: 'unknown' }; r.acceptance.value.acceptedAt = Date.parse('2026-10-20T06:00:00.000Z');
    expect(() => project(f.page([r]))).toThrow();
    const a = f.record(); a.acceptance = { state: 'unavailable' };
    a.account.value.activation = { subjectKey: f.SUBJECT, receiptId: f.uid(999), activatedAt: '2026-10-20T06:50:30.000Z', validUntil: '2026-10-21T06:50:30.000Z' };
    expect(() => project(f.page([a]))).toThrow();
});

test('maps actual domain-created account/setup with fresh proof and distinct activation receipt', async () => {
    const { createStarterAccountAllocator } = require('../api/shared/customerSignup/starterAccountAllocation');
    const { createStarterSetupDetails } = require('../api/shared/customerSignup/starterSetupDetails');
    const { validateAcceptanceReceipt } = require('../api/shared/customerSignup/invitationAcceptance');
    let time = Date.parse('2026-10-20T06:50:00.000Z'), activation;
    const accounts = new Map(), setups = new Map();
    const allocator = createStarterAccountAllocator({ now: () => time,
        captureOwner: async () => ({ subjectKey: f.SUBJECT, email: 'domain@example.invalid' }), readActivation: async () => activation,
        store: { load: async key => f.clone(accounts.get(key) || null), create: async (key, record) => { accounts.set(key, { record, version: 1 }); },
            replace: async (key, version, record) => { accounts.set(key, { record, version: version + 1 }); return true; } } });
    const proof = { schemaVersion: 1, requestId: f.uid(950), accountType: 'consultant', organisationName: 'A* Consulting',
        email: 'domain@example.invalid', status: 'verified', codeHash: null, attempts: 0, createdAt: time - 1000,
        codeExpiresAt: time - 1000 + 600000, expiresAt: time - 1000 + 86400000, verifiedAt: time };
    const reserved = await allocator.reserveInitial(proof), slot = reserved.organisations[0];
    time += 60000;
    const details = createStarterSetupDetails({ accounts: allocator, now: () => time,
        framework: async () => ({ moduleId: 'cyber_security', profileId: 'synthetic-cyber', version: '1.0', scoringVersion: '1.0' }),
        store: { load: async key => f.clone(setups.get(key) || null), create: async (key, record) => { setups.set(key, record); } } });
    const freshProof = { ...proof, requestId: f.uid(951), verifiedAt: time };
    const saved = await details.save(freshProof, { name: 'Synthetic representative', role: 'Owner', address: 'Synthetic address', registrationId: '', authorityConfirmed: true });
    expect(saved.requestId).toBe(reserved.setupRequestId); expect(saved.assertion.setupRequestId).not.toBe(reserved.setupRequestId);
    time += 60000;
    const receipt = validateAcceptanceReceipt({ receiptId: f.uid(952), invitationId: f.uid(953), subjectKey: f.SUBJECT,
        tenantId: slot.tenantId, organisationId: slot.organisationId, termsVersion: 'synthetic-terms', termsDigest: 'a'.repeat(64),
        acceptedAt: time, status: 'pending_admission', dashboardAccess: false });
    time += 60000;
    // Same shape as lib/starterSignupProduction.readActivation: activationId,
    // not the terms acceptance receiptId, identifies this recorded effect.
    activation = { email: reserved.email, subjectKey: f.SUBJECT, accountId: reserved.accountId, organisationId: slot.organisationId,
        receiptId: slot.activationId, activatedAt: new Date(time).toISOString() };
    const active = await allocator.activate({});
    const b = { provider: 'legacy', tenantId: slot.tenantId, organisationId: slot.organisationId, accountId: active.accountId,
        setupRequestId: active.setupRequestId, subjectKey: f.SUBJECT };
    const fact = value => ({ state: 'recorded', binding: f.clone(b), revision: 'synthetic-v1', value });
    const input = { recordId: 'actual-domain-synthetic', binding: b,
        account: fact({ accountId: active.accountId, setupRequestId: active.setupRequestId, email: active.email,
            organisation: slot.organisationName, accountType: active.accountType, createdAt: active.createdAt,
            identitySubjectKey: active.identitySubjectKey || null, activation: active.activation }),
        setup: fact({ accountId: saved.accountId, setupRequestId: saved.requestId, receivedAt: saved.assertion.receivedAt }),
        acceptance: fact(receipt), registration: { state: 'unavailable' } };
    const result = projectSignupRecord(input, { provider: 'legacy', tenantId: slot.tenantId }, f.NOW);
    expect(result.organisation).toBe('A* Consulting'); expect(result.milestones.accountActivated.at).toBe(active.activation.activatedAt);
    expect(JSON.stringify(result)).not.toContain('Synthetic address'); expect(JSON.stringify(result)).not.toContain('proof');
});
