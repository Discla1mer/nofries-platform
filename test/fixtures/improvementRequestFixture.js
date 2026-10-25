'use strict';

// Controlled synthetic SQL transport for genuine native request/source composition.
// Canonical session/admission records follow dashboardRequestDatabase.test.js.
// Revisions and audit rows stage together until actual transaction-helper COMMIT;
// this is not PostgreSQL/RLS, installed schema, effective privilege or live proof.
const crypto = require('node:crypto');
const domain = require('../../api/shared/appLifecycle/dashboardOnboardingDomain');
const { applyMembershipCommand } = require('../../api/shared/appLifecycle/membershipDomain');
const { ncscFixture, SUBJECT, clone } = require('./ncscAssessmentFixture');
const { dataStorage } = require('../../api/shared/appLifecycle/postgresDashboardBootstrap');
const ncscStore = require('../../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const accepted = require('./ncscAcceptedEvaluation.json').input;
const NOW = '2026-09-07T11:00:00.000Z';
const START = '2026-09-07T10:30:00.000Z';
const END = '2026-09-07T12:00:00.000Z';
const SOURCE_SHA = 'c'.repeat(64);
const OWNER = '10000000-0000-4000-8000-000000000000:10000000-0000-4000-8000-000000000002';
const uuid = n => `60000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const canonical = value => value && typeof value === 'object'
    ? Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
        : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
    : JSON.stringify(value);
const hash = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const snake = key => key.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase());

function authorityFixture(options = {}) {
    const example = ncscFixture({ ...options, now: NOW, tenantId: 'request-guard-tenant', organisationId: accepted.organisationId, capacity: 3 });
    const product = example.state.entitlementState.grants.find(row => row.grantId === 'synthetic-product');
    product.modules.push('improvement_plan'); product.modules.sort();
    if (options.ownerEndsAt) {
        for (const [action, actorSubjectKey, payload] of [
            ['invite', SUBJECT, { invitationId: 'synthetic-owner-invitation', subjectKey: OWNER, roles: ['viewer'],
                validFrom: START, validUntil: options.ownerEndsAt, expiresAt: options.ownerEndsAt,
                grantEvidenceId: 'synthetic-owner-evidence' }],
            ['accept', OWNER, { invitationId: 'synthetic-owner-invitation', membershipId: 'synthetic-owner-membership' }]
        ]) example.state.membershipState = applyMembershipCommand(example.state.membershipState, example.state.tenantAggregate,
            { ...example.scope, expectedRevision: example.state.membershipState.revision, actorSubjectKey, now: START, action, payload });
    }
    if (options.assessmentEndsAt) {
        const assignment = clone(example.state.advisorAssignments[0]);
        assignment.assignmentId = 'synthetic-improvement-assignment'; assignment.modules = ['improvement_plan'];
        assignment.permissions = ['improvement.read', 'improvement.write'];
        example.state.advisorAssignments[0].permissions = ['assessment.read'];
        example.state.advisorAssignments[0].validUntil = options.assessmentEndsAt;
        example.state.advisorAssignments.push(assignment);
        example.state.advisorAssignments.sort((a, b) => a.assignmentId.localeCompare(b.assignmentId));
    }
    if (options.membershipEndsAt) {
        example.state.membershipState.memberships[0].validUntil = options.membershipEndsAt;
        example.state.membershipState.invitations[0].validUntil = options.membershipEndsAt;
        example.state.membershipState.invitations[0].expiresAt = options.membershipEndsAt;
    }
    if (options.assignmentEndsAt) example.state.advisorAssignments.forEach(a => { a.validUntil = options.assignmentEndsAt; });
    const identity = { policyId: 'synthetic-runtime-policy', policyRevision: 1,
        issuer: 'https://identity.example.test/runtime/v2.0', identityTenantId: SUBJECT.split(':')[0], oid: SUBJECT.split(':')[1],
        audience: 'synthetic-runtime-client' };
    const member = example.state.membershipState.memberships[0];
    const approved = { schemaVersion: 1, operationType: 'publish_existing_membership', bindingId: uuid(3), scope: clone(example.scope),
        membershipId: member.membershipId, invitationId: member.invitationId, grantEvidenceId: member.grantEvidenceId,
        identity, validFrom: member.validFrom, validUntil: member.validUntil };
    const admission = domain.applyAdmissionCommand({ predecessor: null, command: { schemaVersion: 1,
        operationType: 'publishAdmissionDecision', operationId: uuid(4), actorSubjectKey: SUBJECT, authorityId: uuid(5),
        expectedRevision: null, expectedHeadSha256: null, payload: { target: example.scope,
            identityPolicyRef: { policyId: identity.policyId, policyRevision: identity.policyRevision }, approvedEffectSha256: hash(approved),
            evidenceRefs: [{ kind: 'approval', id: 'synthetic-approval', sha256: '1'.repeat(64) }], validFrom: START, validUntil: options.admissionEndsAt || END } },
        facts: { occurredAt: START } }).record;
    const { schemaVersion, operationType, ...approvedFields } = approved;
    const binding = domain.publishExistingMembershipBinding({ ...approvedFields, receiptId: uuid(6), operationId: uuid(7),
        authorityRef: { authorityId: admission.authorityId, revision: admission.revision, sha256: admission.decisionSha256 },
        actorSubjectKey: SUBJECT, at: START, currentAuthority: example.state }).binding;
    const seed = { identityPayload: identity, instanceId: uuid(1), restoreEpoch: uuid(2), issuedAt: START, expiresAt: options.sessionEndsAt || END };
    const session = domain.applySessionCommand({ predecessor: null, command: { schemaVersion: 1, operationType: 'activateCustomerSession',
        operationId: uuid(8), sessionSha256: '2'.repeat(64), actorSubjectKey: SUBJECT, payload: { seed, bindingId: binding.bindingId } },
        facts: { occurredAt: NOW, generationToken: '3'.repeat(64), binding } }).record;
    const instance = { schemaVersion: 1, instanceId: seed.instanceId, revision: 1, restoreEpoch: seed.restoreEpoch,
        ingressStatus: 'enabled', changedAt: START, evidenceRef: 'synthetic-instance-approval', evidenceSha256: '4'.repeat(64) };
    const rows = {
        instance: { instance_id: instance.instanceId, revision: instance.revision, restore_epoch: instance.restoreEpoch,
            ingress_status: instance.ingressStatus, changed_at: instance.changedAt, evidence_ref: instance.evidenceRef,
            evidence_sha256: instance.evidenceSha256, record_sha256: hash(instance), head_receipt_id: uuid(9) },
        session: Object.fromEntries(Object.entries(session).filter(([key]) => key !== 'schemaVersion').map(([key, value]) => [snake(key), clone(value)])),
        binding: { ...Object.fromEntries(Object.entries(binding).filter(([key]) => !['schemaVersion', 'scope', 'identity', 'origin', 'authorityRef'].includes(key))
            .map(([key, value]) => [snake(key), clone(value)])), tenant_id: example.scope.tenantId, organisation_id: example.scope.organisationId,
            identity_payload: clone(identity), binding_origin: binding.origin, authority_id: admission.authorityId,
            authority_revision: admission.revision, authority_sha256: admission.decisionSha256 },
        head: { authority_id: admission.authorityId, tenant_id: example.scope.tenantId, organisation_id: example.scope.organisationId,
            head_revision: admission.revision, head_sha256: admission.decisionSha256, status: admission.payload.decision, updated_at: admission.payload.occurredAt },
        admission: { authority_id: admission.authorityId, revision: admission.revision, tenant_id: example.scope.tenantId, organisation_id: example.scope.organisationId,
            parent_revision: admission.parentRevision, parent_sha256: admission.parentSha256, decision_sha256: admission.decisionSha256,
            occurred_at: admission.payload.occurredAt, actor_subject_key: admission.payload.actorSubjectKey, payload: clone(admission.payload) }
    };
    const snapshot = { ...clone(example.state), usage: example.state.entitlementState.grants.filter(grant => Object.keys(grant.limits).length)
        .map(grant => ({ schemaVersion: 1, ...example.scope, grantId: grant.grantId, revision: 0,
            counters: Object.fromEntries(Object.keys(grant.limits).map(key => [key, 0])) })) };
    return { example, identity, member, binding, admission, session, instance, rows, snapshot };
}

function createImprovementRequestFixture(fixtureOptions = {}) {
    const f = authorityFixture(fixtureOptions), requests = new WeakMap();
    let sequence = 100;
    const state = { at: NOW, trace: [], transactions: [], hook: null, released: 0, borrows: 0,
        externalEpoch: f.instance.restoreEpoch, committed: { heads: [], revisions: [], auditRows: [] } };
    dataStorage.loadSnapshotForShare.mockReset().mockImplementation(async () => clone(f.snapshot));
    dataStorage.loadSnapshotForUpdate.mockReset().mockImplementation(async () => clone(f.snapshot));
    ncscStore.readHead.mockReset().mockImplementation(async (_tx, scope) => {
        expect(scope).toEqual({ ...f.example.scope, assessmentId: accepted.assessmentId });
        return { synthetic: 'submitted-assessment-head' };
    });
    ncscStore.readHistory.mockReset().mockImplementation(async (_tx, scope, _head, revisions, aggregate) => {
        expect(scope).toEqual({ ...f.example.scope, assessmentId: accepted.assessmentId });
        expect(revisions).toEqual([2]); expect(aggregate).toEqual(f.snapshot.tenantAggregate);
        return new Map([[2, { revisionSha256: SOURCE_SHA,
            envelope: { state: { status: 'submitted' }, submission: { input: clone(accepted) } } }]]);
    });
    function scoped(params) {
        expect(params.slice(0, 2)).toEqual([f.example.scope.tenantId, f.example.scope.organisationId]);
        expect(params[2]).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/);
    }
    const matching = (row, params) => row.tenant_id === params[0] && row.organisation_id === params[1] && row.plan_id === params[2];
    async function answer(client, sql, params) {
        if (sql === 'BEGIN' || sql === 'BEGIN READ ONLY') {
            expect(client.transaction).toBeNull();
            const transaction = { id: client.id, readOnly: sql !== 'BEGIN', status: 'pending',
                staged: clone(state.committed), mutations: [] };
            state.transactions.push(transaction); client.transaction = transaction;
            return { rows: [] };
        }
        if (sql === 'COMMIT') {
            const transaction = client.transaction;
            expect(transaction?.status).toBe('pending');
            if (transaction.mutations.length) state.committed = clone(transaction.staged);
            transaction.status = 'committed'; client.transaction = null;
            return { rows: [] };
        }
        if (sql === 'ROLLBACK') {
            if (client.transaction) client.transaction.status = 'rolled_back';
            client.transaction = null; return { rows: [] };
        }
        if (/^SET LOCAL (?:statement_timeout|ROLE nofries_runtime)\b/i.test(sql) ||
            /SELECT[\s\S]*(?:set_config|pg_advisory_xact_lock)/i.test(sql)) return { rows: [] };
        const fixed = [['dashboard_runtime_instance', 'instance'], ['dashboard_session_gates', 'session'],
            ['dashboard_identity_bindings', 'binding'], ['dashboard_admission_authorities', 'head'],
            ['dashboard_admission_decisions', 'admission']];
        for (const [table, key] of fixed) if (new RegExp('FROM nofries\\.' + table + '\\b', 'i').test(sql)) {
            return { rows: f.rows[key] ? [clone(f.rows[key])] : [] };
        }
        const transaction = client.transaction;
        expect(transaction?.status).toBe('pending');
        const staged = transaction.staged;
        if (/SELECT octet_length\(\$1::jsonb::text\) AS payload_bytes/i.test(sql)) {
            // Synthetic fixed transport response, not a native JSONB measurement.
            return { rows: [{ payload_bytes: Buffer.byteLength(params[0], 'utf8') }] };
        }
        if (/FROM nofries\.dashboard_runtime_audit\b/i.test(sql)) {
            return { rows: clone(staged.auditRows.filter(row => row.event_id === params[0])) };
        }
        if (/INSERT INTO nofries\.dashboard_runtime_audit\b/i.test(sql)) {
            const columns = /dashboard_runtime_audit\s*\(([^)]+)\)/i.exec(sql)[1].split(',').map(value => value.trim());
            const row = Object.fromEntries(columns.map((column, index) => [column,
                ['payload', 'scope_json'].includes(column) ? JSON.parse(params[index]) : params[index]]));
            expect(staged.auditRows.some(existing => existing.event_id === row.event_id)).toBe(false);
            staged.auditRows.push(row); transaction.mutations.push('audit'); return { rows: [], rowCount: 1 };
        }
        if (sql === 'SELECT tenant_id, organisation_id, plan_id, revision FROM nofries.dashboard_improvement_heads WHERE tenant_id = $1 AND organisation_id = $2 AND ($3::text IS NULL OR plan_id COLLATE "C" > $3::text COLLATE "C") ORDER BY plan_id COLLATE "C" LIMIT $4') {
            expect(params.slice(0, 2)).toEqual([f.example.scope.tenantId, f.example.scope.organisationId]);
            expect(params[3]).toBeGreaterThanOrEqual(2); expect(params[3]).toBeLessThanOrEqual(51);
            const selected = staged.heads.filter(row => row.tenant_id === params[0] && row.organisation_id === params[1]
                && (params[2] === null || row.plan_id > params[2]))
                .sort((a, b) => a.plan_id < b.plan_id ? -1 : a.plan_id > b.plan_id ? 1 : 0)
                .slice(0, params[3]).map(row => ({ tenant_id: row.tenant_id, organisation_id: row.organisation_id,
                    plan_id: row.plan_id, revision: row.revision }));
            return { rows: clone(selected) };
        }
        if (/FROM nofries\.dashboard_improvement_heads\b/i.test(sql)) {
            scoped(params); return { rows: clone(staged.heads.filter(row => matching(row, params))) };
        }
        if (/FROM nofries\.dashboard_improvement_revisions\b/i.test(sql)) {
            scoped(params); return { rows: clone(staged.revisions.filter(row => matching(row, params))) };
        }
        if (/INSERT INTO nofries\.dashboard_improvement_revisions\b/i.test(sql)) {
            scoped(params); expect(params).toHaveLength(12);
            expect(staged.revisions.some(row => matching(row, params) && (row.revision === params[3] || row.operation_id === params[4]))).toBe(false);
            staged.revisions.push({ tenant_id: params[0], organisation_id: params[1], plan_id: params[2], revision: params[3],
                operation_id: params[4], payload_sha256: params[5], parent_revision: params[6], parent_sha256: params[7],
                assessment_id: params[8], assessment_revision: params[9], assessment_sha256: params[10], payload: JSON.parse(params[11]) });
            transaction.mutations.push('revision'); return { rows: [], rowCount: 1 };
        }
        if (/INSERT INTO nofries\.dashboard_improvement_heads\b/i.test(sql)) {
            scoped(params); expect(staged.heads.some(row => matching(row, params))).toBe(false);
            staged.heads.push({ tenant_id: params[0], organisation_id: params[1], plan_id: params[2],
                revision: params[3], payload_sha256: params[4] });
            transaction.mutations.push('head'); return { rows: [], rowCount: 1 };
        }
        if (/UPDATE nofries\.dashboard_improvement_heads SET revision=\$4,payload_sha256=\$5\b/i.test(sql)) {
            scoped(params); const head = staged.heads.find(row => matching(row, params));
            if (!head || head.revision !== params[5] || head.payload_sha256 !== params[6]) return { rows: [], rowCount: 0 };
            head.revision = params[3]; head.payload_sha256 = params[4];
            transaction.mutations.push('head'); return { rows: [], rowCount: 1 };
        }
        throw new Error('Unexpected SQL in improvement request transport: ' + sql);
    }
    const pool = { end: jest.fn(), connect: jest.fn(async () => {
        state.borrows++; const client = { id: state.borrows, transaction: null }; let released = false;
        return { query: async (sql, params = []) => {
            const event = { sql, params: clone(params), clientId: client.id, phase: 'before' };
            state.trace.push(event);
            if (state.hook) await state.hook(event);
            const result = await answer(client, sql, params);
            if (state.hook) await state.hook({ ...event, phase: 'after', result });
            return result;
        }, release: () => { expect(released).toBe(false); released = true; state.released++; } };
    }) };
    const options = { pool, clock: jest.fn(() => state.at), instanceId: f.instance.instanceId,
        historyBudget: { maxRecords: 4096, maxBytes: 67108864, maxDurationMs: 60000 },
        captureRequest: jest.fn(async request => requests.has(request) ? clone(requests.get(request)) : null),
        readExternalRuntimeEpoch: jest.fn(async () => ({ instanceId: f.instance.instanceId, restoreEpoch: state.externalEpoch })),
        newId: jest.fn(() => uuid(++sequence)), resolveSubmissionQuota: jest.fn() };
    if (fixtureOptions.enabled !== false) options.improvementEnabled = true;
    function request(overrides = {}) {
        const original = {};
        requests.set(original, { requestId: uuid(++sequence), deadline: '2026-09-07T11:01:00.000Z',
            sessionSha256: f.session.sessionSha256, kind: 'customer', identityPayload: clone(f.identity),
            instanceId: f.instance.instanceId, restoreEpoch: f.instance.restoreEpoch,
            issuedAt: START, expiresAt: f.session.expiresAt, operatorIssuanceProof: null, discovery: null, ...overrides });
        return original;
    }
    function generate(planId = 'plan-a', operationId = 'generate-a') {
        return { planId, type: 'generate', operationId, expectedRevision: null, actionId: null,
            payload: { assessmentId: accepted.assessmentId, assessmentRevision: 2, assessmentRevisionSha256: SOURCE_SHA } };
    }
    function command(plan, type, payload = {}, operationId = `${type}-${plan.revision}`) {
        return { planId: plan.planId, type, operationId, expectedRevision: plan.revision,
            actionId: plan.actions[0].actionId, payload };
    }
    return { ...f, state, pool, options, request, requests, generate, command, SUBJECT, NOW,
        selector: (planId = 'plan-a') => ({ planId, filters: { status: 'all', owner: 'all', overdueOnly: false } }) };
}

module.exports = { createImprovementRequestFixture, NOW, SUBJECT, OWNER };
