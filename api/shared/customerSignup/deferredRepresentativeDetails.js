'use strict';

const { fields, copy, freeze, hash, equal, instant, id } = require('../appLifecycle/dashboardRuntimeRecords');
const { requireTenantRequestContext } = require('../appLifecycle/tenantRequestContext');
const { retainedStarterPreparation, retainedStarterActivation } = require('./starterProvisioning');
const { starterRepresentativeDetails } = require('./starterSetupDetails');
const { DETAILS_POLICY } = require('./customerStarterPlan');
class RepresentativeDetailsError extends Error {
    constructor(code = 'representative_details_unavailable', statusCode = 503) {
        super(code); this.code = code; this.statusCode = statusCode;
    }
}
const fail = (code, status) => { throw new RepresentativeDetailsError(code, status); };
function normaliseRepresentativeDetails(input) {
    try {
        const value = fields(copy(input, 8192), ['name', 'role', 'address']);
        const { name, role, address } = starterRepresentativeDetails({ ...value, registrationId: null, authorityConfirmed: true });
        return freeze({ name, role, address });
    } catch (_) { fail('representative_details_invalid', 400); }
}
// Called only inside the dashboard's locked, generation-bound tenant transaction.
// Enrollment is retained in the immutable offer, not inferred from today's flag.
async function agreement(tx, context) {
    const { tenantId, organisationId } = context.scope;
    const rows = (await tx.query(`SELECT preparation, activation FROM nofries.dashboard_starter_scopes
        WHERE tenant_id=$1 AND organisation_id=$2`, [tenantId, organisationId])).rows;
    if (!rows.length) {
        // Scope rows are intentionally subject-private. Do not mistake an RLS
        // hidden enrolled scope for a historical account and waive its gate.
        const marker = (await tx.query(`SELECT organisation_id FROM nofries.dashboard_deferred_agreements
            WHERE tenant_id=$1 AND organisation_id=$2`, [tenantId, organisationId])).rows;
        if (marker.length) return { memberScope: { tenantId, organisationId } };
        return null;
    }
    if (rows.length !== 1) fail();
    const preparation = retainedStarterPreparation(rows[0].preparation);
    if (preparation.scope.tenantId !== tenantId || preparation.scope.organisationId !== organisationId) fail();
    if (preparation.source.offerInput.detailsPolicy !== DETAILS_POLICY) return null;
    const activation = retainedStarterActivation(preparation, rows[0].activation);
    const receipt = activation.activation.acceptance;
    if (receipt.acceptedAt > Date.parse(context.resolvedAt) || activation.activation.occurredAt > context.resolvedAt) fail();
    const stored = (await tx.query(`SELECT payload FROM nofries.signup_acceptance_receipts
        WHERE tenant_id=$1 AND organisation_id=$2 AND receipt_id=$3`, [tenantId, organisationId, receipt.receiptId])).rows;
    if (stored.length !== 1 || !equal(stored[0].payload.receipt, receipt)) fail();
    return { schemaVersion: 1, ...context.scope, subjectKey: receipt.subjectKey, receiptId: receipt.receiptId,
        acceptanceSha256: hash(receipt), scheduleId: receipt.scheduleId, scheduleDigest: receipt.scheduleDigest,
        authorityEvidenceId: preparation.representativeAuthorityEvidenceId };
}
async function readEvidence(tx, link) {
    const rows = (await tx.query(`SELECT payload, payload_sha256 FROM nofries.dashboard_representative_details
        WHERE tenant_id=$1 AND organisation_id=$2`, [link.tenantId, link.organisationId])).rows;
    if (!rows.length) return null;
    if (rows.length !== 1) fail();
    const row = rows[0], value = fields(copy(row.payload, 16384), ['link', 'details', 'recordedAt']);
    instant(value.recordedAt);
    if (row.payload_sha256 !== hash(value) || !equal(value.link, link) ||
        !equal(value.details, normaliseRepresentativeDetails(value.details))) fail();
    return value;
}
// Only the readiness result leaves this transaction. The marker distinguishes
// enrolled organisations from historical ones; completion must match the
// selected scope and the original acceptance receipt, not the current member.
async function memberReady(tx, scope, resolvedAt) {
    const { rows } = await tx.query(`SELECT d.payload, d.payload_sha256, a.payload->'receipt' AS receipt, invite->>'grantEvidenceId' AS authority_id
        FROM nofries.dashboard_representative_details d
        JOIN nofries.signup_acceptance_receipts a ON a.tenant_id=d.tenant_id
            AND a.organisation_id=d.organisation_id AND a.receipt_id=d.receipt_id AND a.subject_key=d.subject_key
        JOIN nofries.dashboard_membership_states m ON m.tenant_id=d.tenant_id AND m.organisation_id=d.organisation_id
        CROSS JOIN LATERAL jsonb_array_elements(m.payload->'invitations') invite
        WHERE invite->>'tenantId'=d.tenant_id AND invite->>'organisationId'=d.organisation_id
            AND invite->>'invitationId'=a.payload#>>'{receipt,invitationId}'
            AND invite->>'subjectKey'=d.subject_key AND invite->>'status'='accepted'
            AND d.tenant_id=$1 AND d.organisation_id=$2`, [scope.tenantId, scope.organisationId]);
    if (!rows.length) return false;
    if (rows.length !== 1) fail();
    const { payload, payload_sha256, receipt, authority_id } = rows[0];
    const value = fields(copy(payload, 16384), ['link', 'details', 'recordedAt']);
    const expected = { schemaVersion: 1, ...scope, subjectKey: receipt.subjectKey,
        receiptId: receipt.receiptId, acceptanceSha256: hash(receipt), scheduleId: receipt.scheduleId,
        scheduleDigest: receipt.scheduleDigest, authorityEvidenceId: id(authority_id) };
    if (receipt.tenantId !== scope.tenantId || receipt.organisationId !== scope.organisationId ||
        receipt.acceptedAt > Date.parse(resolvedAt) || instant(value.recordedAt) > resolvedAt ||
        payload_sha256 !== hash(value) || !equal(value.link, expected) ||
        !equal(value.details, normaliseRepresentativeDetails(value.details))) fail();
    return true;
}
async function representativeDetails({ database, context: input, clock, audit, enrolledScope }, detailsInput) {
    const context = requireTenantRequestContext(input);
    const details = detailsInput === undefined ? null : normaliseRepresentativeDetails(detailsInput);
    return database.withTenantTransaction(context.scope.tenantId, async tx => {
        const link = await agreement(tx, context);
        if (link?.memberScope) {
            if (details) fail('representative_details_access_denied', 403);
            return { schemaVersion: 1, status: await memberReady(tx, link.memberScope, context.resolvedAt) ? 'ready' : 'details_required' };
        }
        if (!link) {
            if (details) fail('representative_details_not_required', 409);
            // If the lookup marker is unavailable, a subject-private scope can also
            // be invisible here. Neither overrides the retained enrollment.
            if (enrolledScope?.tenantId === context.scope.tenantId &&
                enrolledScope.organisationId === context.scope.organisationId) fail('representative_details_access_denied', 403);
            return { schemaVersion: 1, status: 'ready' };
        }
        const before = await readEvidence(tx, link);
        if (before) {
            if (details && !equal(before.details, details)) fail('representative_details_locked', 409);
            return { schemaVersion: 1, status: 'ready' };
        }
        // Any submitted result in this selected organisation is enough; no scores
        // or questionnaire metadata are modified, and a draft never qualifies.
        const result = (await tx.query(`SELECT EXISTS (SELECT 1 FROM nofries.dashboard_ncsc_assessment_revisions
            WHERE tenant_id=$1 AND organisation_id=$2 AND payload->'submission' <> 'null'::jsonb) AS found`,
        [link.tenantId, link.organisationId])).rows[0];
        if (result?.found !== true) {
            if (details) fail('representative_details_result_required', 409);
            return { schemaVersion: 1, status: 'result_required' };
        }
        if (!details) return { schemaVersion: 1, status: 'details_required' };
        if (link.subjectKey !== context.identity.subjectKey) fail('representative_details_access_denied', 403);
        const record = { link, details, recordedAt: instant(clock()) };
        const inserted = await tx.query(`INSERT INTO nofries.dashboard_representative_details
            (tenant_id, organisation_id, subject_key, receipt_id, payload, payload_sha256)
            VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT DO NOTHING`,
        [link.tenantId, link.organisationId, link.subjectKey, link.receiptId, JSON.stringify(record), hash(record)]);
        const saved = await readEvidence(tx, link);
        if (!saved || !equal(saved.details, details)) fail('representative_details_locked', 409);
        if (inserted.rowCount === 1) await audit.writeEvent(audit.createEvent(context,
            { action: 'representative.record', module: 'overview', result: 'succeeded' }));
        return { schemaVersion: 1, status: 'ready' };
    });
}
// The service-request writer calls this in its own transaction, before storing
// or notifying. No browser assertion can satisfy the gate.
async function requireRepresentativeDetails(tx, context) {
    const link = await agreement(tx, context);
    if (link && !(link.memberScope ? await memberReady(tx, link.memberScope, context.resolvedAt) : await readEvidence(tx, link))) fail('representative_details_required', 409);
}
module.exports = { RepresentativeDetailsError, normaliseRepresentativeDetails, representativeDetails, requireRepresentativeDetails };
