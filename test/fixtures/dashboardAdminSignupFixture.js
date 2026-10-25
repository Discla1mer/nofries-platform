'use strict';
const { hash } = require('../../api/shared/appLifecycle/dashboardRuntimeRecords');
const uid = n => '74000000-0000-4000-8000-' + String(n).padStart(12, '0');
const NOW = '2026-10-20T07:00:00.000Z', TENANT = uid(1), SUBJECT = TENANT + ':' + uid(2), ACTOR = TENANT + ':' + uid(3);
const principal = { provider: 'entra-bff', isAuthenticated: true, subjectKey: ACTOR };
const clone = value => JSON.parse(JSON.stringify(value));
function grant() { return { schemaVersion: 1, capability: 'signupList', operatorSubjectKey: ACTOR, provider: 'legacy',
    tenantId: TENANT, populationId: 'synthetic-population', indexId: 'synthetic-index', authorityRevision: 1,
    issuedAt: '2026-10-20T06:59:00.000Z', expiresAt: '2026-10-20T07:59:00.000Z', maxPageSize: 2, maxRows: 4, maxPages: 2,
    fields: ['email', 'organisation', 'accountType', 'milestones'], auditPolicyId: 'synthetic-audit-policy' }; }
function record(n = 1) {
    const binding = { provider: 'legacy', tenantId: TENANT, organisationId: uid(10 + n), accountId: uid(100 + n),
        setupRequestId: uid(200 + n), subjectKey: SUBJECT };
    const fact = value => ({ state: 'recorded', binding: clone(binding), revision: 'synthetic-r1', value });
    const receipt = { receiptId: uid(300 + n), invitationId: uid(400 + n), subjectKey: SUBJECT,
        tenantId: TENANT, organisationId: binding.organisationId, termsVersion: 'synthetic-terms-v1', termsDigest: 'a'.repeat(64),
        acceptedAt: Date.parse('2026-10-20T06:53:00.000Z'), status: 'pending_admission', dashboardAccess: false };
    const registration = { ...receipt, revision: 1 }; delete registration.acceptedAt; delete registration.dashboardAccess;
    return { recordId: 'synthetic-record-' + n, binding,
        account: fact({ accountId: binding.accountId, setupRequestId: binding.setupRequestId, email: 'person' + n + '@example.invalid',
            organisation: 'Synthetic organisation ' + n, accountType: n % 2 ? 'company' : 'consultant',
            createdAt: '2026-10-20T06:50:00.000Z', identitySubjectKey: SUBJECT, activation: null }),
        setup: fact({ accountId: binding.accountId, setupRequestId: binding.setupRequestId, receivedAt: '2026-10-20T06:51:00.000Z' }),
        acceptance: fact(receipt), registration: fact(registration) };
}
function page(records = [record()], nextCursor = null) { return { schemaVersion: 1, provider: 'legacy', tenantId: TENANT,
    populationId: 'synthetic-population', indexId: 'synthetic-index', snapshotId: 'synthetic-snapshot-1', observedAt: NOW,
    status: 'available', records, nextCursor }; }
const ack = event => ({ schemaVersion: 1, durable: true, eventSha256: hash(event) });
module.exports = { uid, NOW, TENANT, SUBJECT, ACTOR, principal, clone, grant, record, page, ack };
