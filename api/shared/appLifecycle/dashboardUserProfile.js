'use strict';

const { copy, fields, freeze, equal, scope, subject, id, instant } = require('./dashboardRuntimeRecords');
const { DashboardPersistenceError } = require('./postgresDashboardBootstrap');
const { retainedStarterPreparation, retainedStarterActivation } = require('../customerSignup/starterProvisioning');

// This optional display read runs inside the existing, authorised host
// transaction. The representative's title belongs only to their retained
// subject, scope and activated membership; it is never an organisation default.
async function readDashboardUserProfile(tx, selector, at) {
    try {
        const target = fields(copy(selector, 4096), ['scope', 'subjectKey', 'bindingId', 'authorityId',
            'membershipId', 'invitationId', 'grantEvidenceId', 'validFrom', 'validUntil']);
        scope(target.scope); subject(target.subjectKey); instant(at);
        for (const key of ['bindingId', 'authorityId', 'membershipId', 'invitationId', 'grantEvidenceId']) id(target[key]);
        instant(target.validFrom); instant(target.validUntil);
        if (target.validFrom > at || at >= target.validUntil) throw new Error();
        const result = await tx.query(
            `SELECT preparation, activation FROM nofries.dashboard_starter_scopes
             WHERE tenant_id = $1 AND organisation_id = $2 AND subject_key = $3
             AND binding_id = $4 AND authority_id = $5 AND activation IS NOT NULL`,
            [target.scope.tenantId, target.scope.organisationId, target.subjectKey, target.bindingId, target.authorityId]);
        if (!Array.isArray(result?.rows) || result.rows.length > 1) throw new Error();
        if (!result.rows.length) return null;
        const row = fields(copy(result.rows[0], 393216), ['preparation', 'activation']);
        const preparation = retainedStarterPreparation(row.preparation);
        const compiled = retainedStarterActivation(preparation, row.activation);
        const activation = compiled.activation;
        if (!equal(preparation.scope, target.scope) || preparation.subjectKey !== target.subjectKey ||
            preparation.slot.bindingId !== target.bindingId || preparation.slot.authorityId !== target.authorityId ||
            preparation.slot.membershipId !== target.membershipId || preparation.invitationId !== target.invitationId ||
            preparation.representativeAuthorityEvidenceId !== target.grantEvidenceId ||
            activation.occurredAt !== target.validFrom || activation.validUntil !== target.validUntil) throw new Error();
        return freeze({ ...target.scope, subjectKey: target.subjectKey, membershipId: target.membershipId,
            jobTitle: preparation.source.offerInput.contact.role });
    } catch (_) {
        throw new DashboardPersistenceError('unavailable', 503);
    }
}

module.exports = { readDashboardUserProfile };
