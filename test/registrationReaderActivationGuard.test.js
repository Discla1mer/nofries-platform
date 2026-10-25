'use strict';

// Core entry-point qualification with controlled trusted ports, not provider
// authentication or native PostgreSQL/RLS acceptance. The driver supplies only
// layout/header facts and stops at the first ordinary authority fence. It never
// supplies a fabricated runtime gate, membership, admission or activation row.
const crypto = require('node:crypto');
const { createPostgresDashboardRuntimeRepository } = require('../api/shared/appLifecycle/postgresDashboardRuntimeRepository');
const domain = require('../api/shared/appLifecycle/dashboardOnboardingDomain');
const { createStarterAccountAllocator } = require('../api/shared/customerSignup/starterAccountAllocation');
const { compileStarterProvisioning } = require('../api/shared/customerSignup/starterProvisioning');
const { normaliseActivationApproval } = require('../api/shared/customerSignup/customerActivation');
const { createMembershipState, applyMembershipCommand } = require('../api/shared/appLifecycle/membershipDomain');
const { fixture, SUBJECT } = require('./fixtures/dashboardFixture');

const NOW = '2026-11-01T13:00:00.000Z';
const BEFORE = '2026-11-01T12:00:00.000Z';
const AFTER = '2026-11-01T14:00:00.000Z';
const id = () => crypto.randomUUID();
const clone = value => JSON.parse(JSON.stringify(value));
const subject = identity => identity.identityTenantId + ':' + identity.oid;
const identity = () => ({ policyId: 'synthetic-registration-guard', policyRevision: 1,
    issuer: 'https://identity.example.test/registration-guard/v2.0', identityTenantId: id(), oid: id(),
    audience: 'synthetic-registration-guard-client' });

async function historicalStarter() {
    let stored;
    const actor = identity(), requestId = id(), at = Date.parse(BEFORE);
    const allocator = createStarterAccountAllocator({ now: () => at,
        store: { load: async () => stored || null,
            create: async (_key, record) => { stored = { record, version: 'synthetic-v1' }; return true; },
            replace: async () => { throw new Error('no activation fixture write expected'); } },
        captureOwner: async () => null, readActivation: async () => null });
    const account = await allocator.reserveInitial({ schemaVersion: 1, requestId, accountType: 'consultant',
        organisationName: 'Synthetic historical consultancy', email: 'synthetic@example.test', status: 'verified',
        codeHash: null, attempts: 1, createdAt: at - 1000, verifiedAt: at,
        codeExpiresAt: at - 1000 + 600000, expiresAt: at - 1000 + 86400000 });
    const slot = account.organisations[0];
    const provisioning = { account, requestId, source: {
        offerInput: { ...Object.fromEntries(['tenantId', 'organisationId', 'organisationName', 'grantId', 'scheduleId', 'kind']
            .map(key => [key, slot[key]])), accountType: 'consultant',
        contact: { name: 'Synthetic Representative', role: 'Owner', address: 'Synthetic address', registrationId: null,
            email: account.email, authorityEvidenceId: id() },
        framework: { moduleId: 'cyber_security', profileId: 'synthetic-profile', version: '1', scoringVersion: '1' } },
        subjectKey: subject(actor), issuerSubjectKey: subject(actor), invitationId: id(), createdAt: BEFORE } };
    const compiled = compileStarterProvisioning(provisioning);
    expect(compiled.source.offerInput).not.toHaveProperty('consultantOrganisationPolicy');
    expect(compiled.planId).toBe('nf-starter-2026-09-r1');
    return { actor, targetSubject: subject(actor), provisioning, selector: { requestId }, target: compiled.scope };
}

function ordinaryCustomer() {
    const actor = identity(), approvedBy = subject(actor), source = fixture({ now: NOW });
    const initialState = clone({ tenantAggregate: source.tenantAggregate,
        membershipState: createMembershipState(source.tenantAggregate, source.scope, BEFORE),
        entitlementState: source.entitlementState, flags: source.flags, advisorAssignments: [] });
    const invitationId = id();
    initialState.membershipState = applyMembershipCommand(initialState.membershipState, source.tenantAggregate,
        { ...source.scope, expectedRevision: 0, actorSubjectKey: approvedBy, now: BEFORE, action: 'invite',
            payload: { invitationId, subjectKey: SUBJECT, roles: ['admin'], validFrom: BEFORE,
                validUntil: AFTER, grantEvidenceId: 'synthetic-representative-authority', expiresAt: AFTER } });
    const authority = { schemaVersion: 2, subjectKey: SUBJECT, email: 'synthetic@example.test', revision: 0, status: 'active',
        invitationDigest: 'a'.repeat(64), invitationId, ...source.scope,
        termsVersion: 'synthetic-historical-terms', termsDigest: 'b'.repeat(64), scheduleId: 'synthetic-historical-schedule',
        scheduleDigest: 'c'.repeat(64), bindingId: null, expiresAt: Date.parse(AFTER) };
    const approval = normaliseActivationApproval({ schemaVersion: 1, activationId: id(), approvalRef: 'synthetic-approval',
        approvedBy, approvedAt: BEFORE, expiresAt: AFTER, authoritySha256: domain.canonicalDigest(authority), authorityRevision: 0,
        subjectKey: SUBJECT, invitationId, membershipId: 'synthetic-member',
        termsVersion: authority.termsVersion, termsDigest: authority.termsDigest,
        scheduleId: authority.scheduleId, scheduleDigest: authority.scheduleDigest, scope: source.scope,
        identity: { ...identity(), identityTenantId: SUBJECT.slice(0, 36), oid: SUBJECT.slice(37) },
        bootstrapOperationId: id(), acceptOperationId: id(), publicationOperationId: id(), bindingId: id(),
        authorityRef: { authorityId: id(), revision: 0, sha256: 'd'.repeat(64) },
        bootstrapExpectedRevisions: { tenant: null, organisation: null, membership: null, entitlement: null,
            flags: null, advisorAssignments: [], usage: [] }, initialState });
    return { actor, targetSubject: SUBJECT, approval, authority,
        selector: { activationId: approval.activationId }, target: approval.scope };
}

function controlDriver(facts, kind, { futureLayout, headerKind = 'v1', failRollbackOnce = false }) {
    const instanceId = id(), restoreEpoch = id(), trace = [], state = { borrows: 0, releases: 0, fenceAttempts: 0 };
    const header = headerKind === 'absent' ? null : headerKind === 'v2'
        ? { schemaVersion: 2, subjectKey: facts.targetSubject, revision: 9, selected: null }
        : { schemaVersion: 1, subjectKey: facts.targetSubject, revision: 9, selected: null, registrations: [] };
    const snapshot = JSON.stringify({ header, provisioning: facts.provisioning || null,
        approval: facts.approval || null, authority: facts.authority || null });
    const capture = { requestId: id(), deadline: '2026-11-01T13:00:30.000Z', sessionSha256: 'e'.repeat(64),
        kind, identityPayload: facts.actor, instanceId, restoreEpoch, issuedAt: BEFORE, expiresAt: AFTER,
        operatorIssuanceProof: null, discovery: null };
    if (kind === 'operator_dashboard') capture.operatorIssuanceProof = domain.normaliseOperatorIssuanceProof({
        schemaVersion: 1, kind: 'operator_dashboard_issuance', sessionSha256: capture.sessionSha256,
        identitySha256: domain.canonicalDigest(capture.identityPayload), instanceId, restoreEpoch,
        issuedAt: BEFORE, expiresAt: AFTER });
    const client = { release() { state.releases++; }, async query(sql, params = []) {
        trace.push({ sql, params: clone(params) });
        if (sql === 'ROLLBACK' && failRollbackOnce) {
            failRollbackOnce = false;
            throw new Error('synthetic first rollback acknowledgement failure');
        }
        if (/pg_advisory_/.test(sql)) {
            state.fenceAttempts++;
            throw new Error('synthetic control stops before retained authority');
        }
        if (/FROM pg_catalog\.pg_attribute/.test(sql)) return { rows: futureLayout
            ? [{ is_text: true, not_null: true, scoped_primary_key: true }] : [] };
        if (/SELECT row_key FROM nofries\.signup_registrations/.test(sql)) return { rows: [] };
        if (/FROM nofries\.signup_registrations/.test(sql)) {
            expect(params).toEqual([facts.targetSubject.slice(0, 36), facts.targetSubject]);
            expect(sql.includes("row_key=''")).toBe(futureLayout);
            return { rows: header === null ? [] : [{ identity_tenant_id: facts.targetSubject.slice(0, 36), subject_key: facts.targetSubject,
                revision: 9, payload: clone(header), ...(futureLayout ? { row_key: '' } : {}) }] };
        }
        if (/^(BEGIN|ROLLBACK|COMMIT|SET LOCAL ROLE |SET LOCAL statement_timeout = 0|SELECT set_config\()/i.test(sql)) return { rows: [] };
        throw new Error('unexpected business query in registration guard control');
    } };
    const options = { pool: { async connect() { state.borrows++; return client; }, async end() {} },
        clock: () => NOW, instanceId, historyBudget: { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 30000 },
        captureRequest: async () => clone(capture), readExternalRuntimeEpoch: async () => ({ instanceId, restoreEpoch }),
        readVerifiedOnboardingProof: async () => null, readPreparedCaseCapability: async () => null,
        authoriseOperatorOperation: () => true, newId: id, newGenerationToken: () => 'f'.repeat(64),
        ...(facts.provisioning ? { readStarterProvisioning: async () => ({ provisioning: clone(facts.provisioning), deadline: AFTER }) }
            : { readCustomerActivation: async () => ({ approval: clone(facts.approval), authority: clone(facts.authority) }) }) };
    return { repository: createPostgresDashboardRuntimeRepository(options), trace, state,
        assertUnchanged() { expect(JSON.stringify({ header, provisioning: facts.provisioning || null,
            approval: facts.approval || null, authority: facts.authority || null })).toBe(snapshot); } };
}

describe('compatible registration reader closes direct activation entries', () => {
    for (const method of ['starterProvisioning', 'customerActivation']) for (const phase of ['prepare', 'activate']) {
        test.each(['v2', 'v1', 'absent'])(`${method} ${phase} rejects future SQL layout with %s header before any preparation write, including repeat`, async headerKind => {
            const facts = method === 'starterProvisioning' ? await historicalStarter() : ordinaryCustomer();
            const f = controlDriver(facts, method === 'starterProvisioning' ? 'customer' : 'operator_dashboard', { futureLayout: true, headerKind });
            for (let attempt = 0; attempt < 2; attempt++) await expect(f.repository[method]({}, { ...facts.selector, phase }))
                .rejects.toMatchObject({ code: 'onboarding_access_denied', statusCode: 403 });
            expect(f.state).toEqual({ borrows: 2, releases: 2, fenceAttempts: 0 });
            expect(f.trace.filter(event => event.sql === 'ROLLBACK')).toHaveLength(2);
            expect(f.trace.filter(event => /SELECT identity_tenant_id/.test(event.sql) && /FROM nofries\.signup_registrations/.test(event.sql))
                .every(event => /FOR UPDATE\s*$/.test(event.sql))).toBe(true);
            expect(f.trace.some(event => event.sql === 'COMMIT' || /\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?nofries\./i.test(event.sql))).toBe(false);
            expect(f.trace.filter(event => /FROM nofries\./.test(event.sql)).every(event => /FROM nofries\.signup_registrations/.test(event.sql))).toBe(true);
            f.assertUnchanged();
        });
        test(`${method} ${phase} permits unchanged SQL11 and historical header to reach the ordinary authority fence`, async () => {
            const facts = method === 'starterProvisioning' ? await historicalStarter() : ordinaryCustomer();
            const f = controlDriver(facts, method === 'starterProvisioning' ? 'customer' : 'operator_dashboard', { futureLayout: false });
            await expect(f.repository[method]({}, { ...facts.selector, phase }))
                .rejects.toMatchObject({ code: 'onboarding_unavailable', statusCode: 503 });
            expect(f.state).toEqual({ borrows: 1, releases: 1, fenceAttempts: 1 });
            const header = f.trace.findIndex(event => /FROM nofries\.signup_registrations/.test(event.sql));
            const fence = f.trace.findIndex(event => /pg_advisory_/.test(event.sql));
            expect(header).toBeGreaterThan(-1); expect(header).toBeLessThan(fence);
            expect(f.trace[header].sql).toMatch(/FOR UPDATE\s*$/);
            expect(f.trace.some(event => /FROM nofries\.signup_registrations/.test(event.sql) && /FOR SHARE\s*$/.test(event.sql))).toBe(false);
            expect(f.trace.some(event => /\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?nofries\./i.test(event.sql))).toBe(false);
            f.assertUnchanged();
        });
        test.each(['v2', 'v1', 'absent'])(`${method} ${phase} rechecks future SQL layout with %s header after uncertain rollback without a write or commit`, async headerKind => {
            const facts = method === 'starterProvisioning' ? await historicalStarter() : ordinaryCustomer();
            const f = controlDriver(facts, method === 'starterProvisioning' ? 'customer' : 'operator_dashboard',
                { futureLayout: true, headerKind, failRollbackOnce: true });
            await expect(f.repository[method]({}, { ...facts.selector, phase }))
                .rejects.toMatchObject({ code: 'onboarding_access_denied', statusCode: 403 });
            expect(f.state).toEqual({ borrows: 2, releases: 2, fenceAttempts: 0 });
            expect(f.trace.filter(event => /FROM pg_catalog\.pg_attribute/.test(event.sql))).toHaveLength(2);
            expect(f.trace.filter(event => event.sql === 'ROLLBACK')).toHaveLength(2);
            expect(f.trace.some(event => event.sql === 'COMMIT' || /\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?nofries\./i.test(event.sql))).toBe(false);
            f.assertUnchanged();
        });
    }
});
