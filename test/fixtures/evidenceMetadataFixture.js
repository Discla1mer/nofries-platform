'use strict';
// Synthetic evidence and authority only; shared by source and real PostgreSQL tests.
const { fixture, SUBJECT, NOW } = require('./dashboardFixture');
const { createEvidence } = require('../../api/shared/evidenceLifecycle/evidenceDomain');
const clone = value => JSON.parse(JSON.stringify(value));
function evidenceFixture(options = {}) {
    const source = fixture({ modules: ['overview', 'evidence'], ...options });
    if (options.tenantId) {
        function replace(value) {
            if (Array.isArray(value)) return value.map(replace);
            if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
                .map(([key, child]) => [key, key === 'tenantId' ? options.tenantId : replace(child)]));
            return value;
        }
        Object.assign(source, replace(source));
    }
    const state = { tenantAggregate: source.tenantAggregate, membershipState: source.membershipState,
        entitlementState: source.entitlementState, flags: source.flags, advisorAssignments: Object.values(source.advisorAssignments) };
    if (options.role === 'fractional_advisor') state.advisorAssignments.forEach(row => {
        row.modules = ['evidence']; row.permissions = ['evidence.read'];
    });
    const ref = recordId => ({ recordId, revision: 0, recordSha256: 'a'.repeat(64) });
    const command = { ...source.scope, artefactId: 'shared:artefact', action: 'create', expectedRevision: null,
        actorSubjectKey: SUBJECT, now: source.now, idempotencyKey: 'synthetic:create', payload: {
            versionId: 'version:0', declaredContent: { sha256: 'a'.repeat(64), contentType: 'application/pdf', sizeBytes: 100 },
            source: { kind: 'operator-declaration', sourceId: 'private-source:A', sourceRevision: 'source-revision:0',
                observedAt: source.now, sourceMetadataSha256: 'b'.repeat(64) },
            classification: { level: 'Internal', tags: [] },
            policySnapshot: { policyId: 'private-policy:A', policyVersion: 'policy-version:0', maximumDeclaredBytes: 100,
                allowedDeclaredContentTypes: ['application/pdf'] },
            governanceRefs: { purposeDecisionRef: ref('private-purpose:A'), metadataRetentionPolicyRef: ref('private-metadata:A'),
                bytesRetentionPolicyRef: ref('private-bytes:A'), legalHoldRefs: [] } } };
    return { ...source, state, command, evidence: createEvidence(state.tenantAggregate, command) };
}
module.exports = { evidenceFixture, clone, SUBJECT, NOW };
