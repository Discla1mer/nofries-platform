'use strict';
// Synthetic agreement and acceptance only. Never imported by production.
const crypto = require('node:crypto');
const { createStarterAccountAllocator } = require('../../api/shared/customerSignup/starterAccountAllocation');
const { createStarterSetupDetails } = require('../../api/shared/customerSignup/starterSetupDetails');
const { compileStarterProvisioning, compileStarterAdmission } = require('../../api/shared/customerSignup/starterProvisioning');
const { createTenantRequestContext } = require('../../api/shared/appLifecycle/tenantRequestContext');
const AT = '2026-11-18T10:00:00.000Z';
const DATA = { name: 'Synthetic Avery', role: 'Operations lead', address: '123 Synthetic Street, Wellington' };
async function deferredFixture({ enabled = true, identity, scope } = {}) {
    const at = Date.parse(AT), id = crypto.randomUUID;
    identity ||= { policyId: 'synthetic-deferred', policyRevision: 1, issuer: 'https://synthetic.invalid/v2.0',
        identityTenantId: id(), oid: id(), audience: 'synthetic-client' };
    const subjectKey = identity.identityTenantId + ':' + identity.oid;
    const proof = { schemaVersion: 1, requestId: id(), email: 'synthetic@example.test', organisationName: 'Synthetic Workshop',
        accountType: 'company', status: 'verified', codeHash: null, attempts: 0,
        createdAt: at - 1000, codeExpiresAt: at + 599000, expiresAt: at + 86399000, verifiedAt: at };
    let accountRow;
    const rows = new Map();
    const store = { async load(key) { return rows.get(key) || null; }, async create(key, value) {
        if (rows.has(key)) throw new Error('Synthetic conflict'); rows.set(key, value); return true;
    } };
    const accounts = createStarterAccountAllocator({ now: () => at, readActivation: async () => null, captureOwner: async () => null,
        store: { async replace() { return false; }, async load() { return accountRow; }, async create(key, value) {
            const record = scope ? { ...value, organisations: [{ ...value.organisations[0], ...scope }] } : value;
            accountRow = { record, version: '1' }; return true;
        } } });
    const options = { accounts, store, now: () => at, deferDetails: enabled,
        framework: () => ({ moduleId: 'cyber_security', profileId: 'synthetic', version: '1', scoringVersion: '1' }) };
    const setup = createStarterSetupDetails(options);
    const body = enabled ? { authorityConfirmed: true } : { ...DATA, registrationId: null, authorityConfirmed: true };
    const saved = await setup.save(proof, body), account = await accounts.readInitial(proof);
    const source = { offerInput: saved.offerInput, subjectKey, issuerSubjectKey: subjectKey, invitationId: id(), createdAt: AT };
    const preparation = compileStarterProvisioning({ account, requestId: proof.requestId, source });
    const receipt = { receiptId: id(), invitationId: source.invitationId, subjectKey, ...preparation.scope, ...preparation.terms,
        scheduleId: preparation.schedule.scheduleId, scheduleDigest: preparation.schedule.scheduleDigest,
        acceptedAt: at, status: 'pending_admission', dashboardAccess: false };
    const activation = compileStarterAdmission({ preparation, acceptance: receipt, identity, occurredAt: AT, accountActivatedAt: null }).activation;
    const context = await createTenantRequestContext({ authenticate: async () => ({ authenticated: true, subjectKey }),
        resolveScope: async () => preparation.scope, createRequestId: id, clock: () => AT }).resolve({});
    return { saved, account, preparation, activation, receipt, context, setup, options, proof, body, rows };
}
module.exports = { deferredFixture, AT, DATA };
