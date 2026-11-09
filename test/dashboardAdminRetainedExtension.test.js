'use strict';
const { Readable } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { createExpiryAction } = require('../api/shared/dashboardAdmin/accountActionsExpiry');
const { customerAuthorityExpiryCommandHash } = require('../api/shared/dashboardAdmin/customerAuthorityExpiry');
const { createRetainedTrialAssessmentReader } = require('../api/shared/customerSignup/retainedTrialAssessmentReader');
const { retainedTrialFixture, clone, NOW } = require('./fixtures/retainedTrialReadFixture');
const iso = value => new Date(value).toISOString();

test.each([false, true])('refused trial extension preserves saved results after the proposed expiry (consultant=%s)', async client => {
    const f = await retainedTrialFixture({ client }), now = Date.parse(NOW), audit = new Map();
    f.state.subject.expiresAt = now - 1000;
    const before = clone(f.state.subject), selector = { provider: 'external', subjectKey: f.actor,
        tenantId: before.tenantId, organisationId: before.organisationId };
    const actor = { subjectKey: randomUUID() + ':' + randomUUID() };
    const source = { schemaVersion: 1, kind: 'external_starter', storageAccount: 'syntheticstore', container: 'authority',
        providerKind: 'external-id', providerTenantId: f.identity.identityTenantId, providerConfigurationSha256: 'a'.repeat(64) };
    const context = { operatorSubjectKey: actor.subjectKey, sessionSha256: 'b'.repeat(64), instanceId: f.state.instance.instanceId,
        restoreEpoch: f.state.instance.restoreEpoch, identityPolicySha256: 'c'.repeat(64) };
    const authorityWrite = jest.fn(async bytes => { f.state.subject = JSON.parse(bytes.toString()); return { etag: '"after"' }; });
    const authorityContainer = { url: 'https://syntheticstore.blob.core.windows.net/authority',
        pipeline: { options: { retryOptions: { maxTries: 1 } } }, getBlockBlobClient: () => ({
            async download() { const bytes = Buffer.from(JSON.stringify(f.state.subject));
                return { contentLength: bytes.length, etag: '"before"', readableStreamBody: Readable.from([bytes]) }; },
            uploadData: authorityWrite }) };
    const auditContainer = { url: 'https://syntheticstore.blob.core.windows.net/audit', getBlockBlobClient: key => ({
        async uploadData(bytes, options) { expect(options.conditions).toEqual({ ifNoneMatch: '*' }); expect(audit.has(key)).toBe(false);
            audit.set(key, JSON.parse(bytes.toString())); return { etag: '"audit"' }; } }) };
    const bound = { ...context, auditConfigurationSha256: hash({ purpose: 'dashboard_admin_account_actions', containerUrl: auditContainer.url }) };
    const command = { schemaVersion: 1, purpose: 'customer_authority_expiry_extension', operationId: randomUUID(),
        target: { sourceSha256: hash(source), subjectKey: f.actor, tenantId: before.tenantId, organisationId: before.organisationId },
        beforeSha256: hash(before), beforeEtag: '"before"', beforeRevision: 0, beforeExpiresAt: iso(before.expiresAt), newExpiresAt: iso(now + 3600000) };
    const approval = { schemaVersion: 1, purpose: command.purpose, status: 'active', approvalId: randomUUID(), revision: 0,
        context: bound, commandSha256: customerAuthorityExpiryCommandHash(command, bound), approvedExpiresAt: command.newExpiresAt,
        issuedAt: NOW, expiresAt: iso(now + 60000) };
    const executor = createExpiryAction({ source, authorityContainer, auditContainer, readContext: async () => clone(context),
        readApprovedExtension: async () => ({ command, approval }), clock: () => f.state.now });
    const reader = createRetainedTrialAssessmentReader(f.options), saved = await reader.read({}, f.input);
    await expect(executor.execute(actor, { selector, operationId: command.operationId,
        confirmationEmail: before.email, newExpiresAt: command.newExpiresAt }, { request: {}, signal: new AbortController().signal }))
        .rejects.toMatchObject({ statusCode: 403, code: 'dashboard_admin_access_denied' });
    expect(authorityWrite).not.toHaveBeenCalled(); expect(f.state.subject).toEqual(before);
    expect([...audit.values()].map(row => [row.phase, row.outcome])).toEqual([['attempt', 'attempt'], ['terminal', 'refused']]);
    // Advance beyond the requested extension with a fresh current read-purpose
    // capture. Neither the authority revision nor the saved assessment changed.
    const later = Date.parse(command.newExpiresAt) + 1;
    f.state.now = iso(later);
    Object.assign(f.state.capture, { issuedAt: iso(later - 1000), expiresAt: iso(later + 3600000), deadline: iso(later + 30000) });
    const retained = await reader.read({}, f.input);
    expect(retained.assessment).toEqual(saved.assessment); expect(retained.readOnly).toBe(true);
});
