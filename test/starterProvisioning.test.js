'use strict';
const test = global.test || require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createStarterAccountAllocator } = require('../api/shared/customerSignup/starterAccountAllocation');
const { compileStarterProvisioning, retainedStarterPreparation, starterBootstrapCommand, compileStarterAdmission,
    retainedStarterActivation, starterActivationCommands } = require('../api/shared/customerSignup/starterProvisioning');
const { createBootstrapOperations } = require('../api/shared/appLifecycle/postgresDashboardBootstrap');
const { accountWindow } = require('../api/shared/customerSignup/customerStarterPlan');
const AT = '2026-09-29T10:00:00.000Z';
async function fixture() {
    let saved;
    const id = crypto.randomUUID, tenant = id(), oid = id(), subject = tenant + ':' + oid;
    const accounts = createStarterAccountAllocator({ now: () => Date.parse(AT),
        readActivation: async () => null, captureOwner: async () => null,
        store: { load: async () => saved || null, create: async (_, record) => { saved = { record, version: '1' }; return true; }, replace: async () => false } });
    const requestId = id(), at = Date.parse(AT);
    const account = await accounts.reserveInitial({ schemaVersion: 1, requestId, email: 'synthetic@gmail.com', organisationName: 'Unrelated Ltd',
        accountType: 'company', status: 'verified', codeHash: null, attempts: 0, createdAt: at - 1000,
        codeExpiresAt: at + 599000, expiresAt: at + 86399000, verifiedAt: at });
    const slot = account.organisations[0];
    const source = { offerInput: { ...Object.fromEntries(['tenantId','organisationId','organisationName','grantId','scheduleId','kind'].map(k => [k, slot[k]])),
        accountType: account.accountType, contact: { name: 'Synthetic User', role: 'Owner', address: 'Synthetic address', registrationId: null,
            email: account.email, authorityEvidenceId: id() }, framework: { moduleId: 'cyber_security', profileId: 'synthetic', version: '1', scoringVersion: '1' } },
        subjectKey: subject, issuerSubjectKey: subject, invitationId: id(), createdAt: AT };
    const p = compileStarterProvisioning({ account, requestId, source });
    const acceptance = { receiptId: id(), invitationId: p.invitationId, subjectKey: subject, ...p.scope,
        ...p.terms, scheduleId: p.schedule.scheduleId, scheduleDigest: p.schedule.scheduleDigest,
        acceptedAt: at, status: 'pending_admission', dashboardAccess: false };
    const identity = { policyId: 'synthetic-starter', policyRevision: 1, issuer: 'https://identity.example.test/v2.0',
        identityTenantId: tenant, oid, audience: 'synthetic-client' };
    return { account, requestId, source, p, input: { preparation: p, acceptance, identity, occurredAt: AT, accountActivatedAt: null } };
}
test('starter provisioning uses a customer-owned reserved scope and zero-access bootstrap', async () => {
    const f = await fixture(); assert.deepEqual(retainedStarterPreparation(f.p), f.p);
    const command = starterBootstrapCommand(f.p);
    assert.equal(command.actorSubjectKey, f.source.subjectKey);
    createBootstrapOperations({ clock: () => AT, authoriseAdministration: () => false }).prepareInitialisation(command, f.p.initialState);
    assert.throws(() => compileStarterProvisioning({ account: f.account, requestId: f.requestId, source: { ...f.source, issuerSubjectKey: crypto.randomUUID() + ':' + crypto.randomUUID() } }));
    assert.throws(() => retainedStarterPreparation({ ...f.p, slot: { ...f.p.slot, arbitrary: true } }));
    assert.throws(() => retainedStarterPreparation({ ...f.p, slot: { ...f.p.slot, authorityId: f.p.slot.bindingId } }));
});
test('genuine consent compiles one fixed admission and a replay-stable set of SQL commands', async () => {
    const f = await fixture(), result = compileStarterAdmission(f.input);
    assert.deepEqual(retainedStarterActivation(f.p, result.activation), result);
    assert.equal(result.activation.validUntil, '2026-10-13T10:00:00.000Z');
    assert.equal(result.activation.admission.revision, 0);
    const commands = starterActivationCommands(f.p, result);
    assert.equal(commands.length, 5); assert.equal(new Set(commands.map(c => c.operationId)).size, 5);
    assert.equal(commands[4].payload.limit, 'memberships'); assert.equal(commands[4].payload.amount, 1);
    assert.equal(result.nextState.usage[0].counters.memberships, 1);
    assert.deepEqual(starterActivationCommands(f.p, result), commands);
    assert.throws(() => compileStarterAdmission({ ...f.input, acceptance: { ...f.input.acceptance, organisationId: crypto.randomUUID() } }));
    assert.throws(() => compileStarterAdmission({ ...f.input, identity: { ...f.input.identity, oid: crypto.randomUUID() } }));
    assert.throws(() => retainedStarterActivation(f.p, { ...result.activation, validUntil: '2030-10-13T10:00:00.000Z' }));
});
test('independent client reservations compile beyond the old count without growing or replacing the account', async () => {
    const f = await fixture(), id = crypto.randomUUID;
    const account = { ...f.account, accountType: 'consultant', activation: { subjectKey: f.source.subjectKey,
        receiptId: id(), activatedAt: AT, validUntil: accountWindow(AT).validUntil } };
    const before = JSON.stringify(account), clients = [];
    for (let i = 0; i < 6; i++) {
        const slot = Object.fromEntries(Object.keys(account.organisations[0]).map(k => [k,
            k === 'kind' ? 'client' : k === 'organisationName' ? 'Synthetic client ' + i : id()]));
        const source = { ...f.source, offerInput: { ...f.source.offerInput,
            ...Object.fromEntries(['tenantId', 'organisationId', 'organisationName', 'grantId', 'scheduleId', 'kind'].map(k => [k, slot[k]])),
            accountType: 'consultant', consultantOrganisationPolicy: 'unlimited-v1' } };
        const input = { account, requestId: slot.requestId, source, slot };
        const p = compileStarterProvisioning(input); clients.push(p);
        assert.equal(p.ordinal, 1); assert.deepEqual(retainedStarterPreparation(p), p);
        assert.deepEqual(compileStarterProvisioning(input), p);
        assert.throws(() => compileStarterProvisioning({ ...input, requestId: id() }));
        assert.throws(() => compileStarterProvisioning({ ...input, account: { ...account, activation: null } }));
        assert.throws(() => compileStarterProvisioning({ ...input, account: { ...account, accountType: 'company' } }));
        assert.throws(() => compileStarterProvisioning({ ...input, slot: { ...slot, bindingId: account.organisations[0].bindingId } }));
        const oldSource = { ...source, offerInput: { ...source.offerInput } }; delete oldSource.offerInput.consultantOrganisationPolicy;
        assert.throws(() => compileStarterProvisioning({ ...input, source: oldSource }));
        assert.throws(() => retainedStarterPreparation({ ...p, source: oldSource }));
    }
    assert.equal(new Set(clients.map(p => p.slot.organisationId)).size, 6);
    assert.equal(new Set(clients.map(p => p.slot.bindingId)).size, 6);
    assert.equal(JSON.stringify(account), before); assert.equal(account.organisations.length, 1);
});
