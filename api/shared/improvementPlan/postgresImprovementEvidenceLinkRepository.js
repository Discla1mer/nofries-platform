'use strict';

const { copy, fields, freeze, instant } = require('../appLifecycle/dashboardRuntimeRecords');
const { DashboardPersistenceError, dataStorage } = require('../appLifecycle/postgresDashboardBootstrap');
const { resolveEvidenceAccess } = require('../appLifecycle/dashboardResourceAuthority');
const { createPostgresEvidenceMetadataRepository } = require('../appLifecycle/postgresEvidenceMetadataRepository');
const { createPostgresImprovementPlanRepository } = require('./postgresImprovementPlanRepository');
const { resolveImprovementAccess } = require('./improvementPlanAccess');
const { ImprovementEvidenceLinkError, normaliseImprovementEvidenceSelector,
    requireImprovementEvidenceContext, linkError } = require('./improvementEvidenceLinkService');
const fail = (code = 'improvement_evidence_unavailable', status = 503) => {
    throw new ImprovementEvidenceLinkError(code, status);
};

// Trusted source composition only. The host must pair audit/database with its
// request lifetime. No route, runtime binding, schema or business write is added.
function createPostgresImprovementEvidenceLinkRepository(options) {
    let transact, clock, audit;
    try {
        const settings = fields(options, ['database', 'clock', 'audit']);
        fields(settings.audit, ['createEvent', 'writeEvent']);
        if (typeof settings.database?.withTenantTransaction !== 'function' || typeof settings.clock !== 'function' ||
            typeof settings.audit.createEvent !== 'function' || typeof settings.audit.writeEvent !== 'function') fail();
        transact = settings.database.withTenantTransaction.bind(settings.database);
        clock = settings.clock;
        audit = Object.freeze({ createEvent: settings.audit.createEvent.bind(settings.audit),
            writeEvent: settings.audit.writeEvent.bind(settings.audit) });
    } catch { fail('improvement_evidence_input_invalid', 400); }
    return Object.freeze({
        async resolveImprovementEvidenceLink(contextInput, input) {
            try {
                const context = requireImprovementEvidenceContext(contextInput);
                const selector = normaliseImprovementEvidenceSelector(input);
                let previous = context.resolvedAt;
                const now = () => {
                    const at = instant(clock());
                    if (at < previous) fail();
                    previous = at; return at;
                };
                return await transact(context.scope.tenantId, async tx => {
                    let current;
                    try { current = await dataStorage.loadSnapshotForUpdate(tx, context.scope); }
                    catch (error) {
                        if (error instanceof DashboardPersistenceError && error.statusCode === 404) {
                            fail('improvement_evidence_access_denied', 403);
                        }
                        throw error;
                    }
                    const authorise = () => {
                        const at = now();
                        resolveImprovementAccess(current, context, 'improvement.read', at);
                        resolveEvidenceAccess(current, context, at);
                    };
                    authorise();
                    const database = Object.freeze({
                        async withTenantTransaction(tenantId, work) {
                            if (tenantId !== context.scope.tenantId) fail('improvement_evidence_access_denied', 403);
                            return await work(tx);
                        }
                    });
                    const plans = createPostgresImprovementPlanRepository({ database, clock: now });
                    const evidence = createPostgresEvidenceMetadataRepository({ database, clock: now, audit });
                    const retained = await plans.readImprovementPlan(context, { planId: selector.planId });
                    authorise();
                    if (retained.schemaVersion !== 1 || retained.plan.schemaVersion !== 1 ||
                        retained.plan.tenantId !== context.scope.tenantId ||
                        retained.plan.organisationId !== context.scope.organisationId ||
                        retained.plan.planId !== selector.planId) fail();
                    if (retained.plan.revision !== selector.planRevision) fail('improvement_evidence_selection_conflict', 409);
                    const action = retained.plan.actions.find(item => item.actionId === selector.actionId);
                    if (!action) fail('improvement_evidence_not_found', 404);
                    const metadata = await evidence.readEvidenceMetadata(context, { artefactId: selector.artefactId });
                    authorise();
                    if (metadata.schemaVersion !== 1 || metadata.evidence.artefactId !== selector.artefactId) fail();
                    const version = metadata.evidence.versions.find(item => item.versionId === selector.evidenceVersionId);
                    if (!version) fail('improvement_evidence_not_found', 404);
                    if (version.quarantine.state !== 'quarantined' || version.quarantine.reason !== 'content-unverified') fail();
                    const result = freeze(copy({ schemaVersion: 1, status: 'unpersisted',
                        evidenceVerification: 'not_verified', downloadAllowed: false, scoreEffect: 'none',
                        scope: context.scope,
                        action: { planId: selector.planId, planRevision: retained.plan.revision,
                            actionId: action.actionId, itemId: action.itemId, controlId: action.controlId, domainId: action.domainId },
                        assessment: { ...retained.sourceRevision,
                            evaluationOutputSha256: retained.plan.source.evaluationOutputSha256 },
                        evidence: { artefactId: selector.artefactId, versionId: version.versionId,
                            introducedRevision: version.introducedRevision, recordedAt: version.recordedAt,
                            metadataRevision: metadata.evidence.revision, currentVersionId: metadata.evidence.currentVersionId,
                            selectedIsCurrent: version.versionId === metadata.evidence.currentVersionId,
                            declaredContent: version.declaredContent, classification: version.classification,
                            quarantine: version.quarantine }
                    }, 32768));
                    authorise();
                    return result;
                });
            } catch (error) { throw linkError(error); }
        }
    });
}
module.exports = Object.freeze({ createPostgresImprovementEvidenceLinkRepository });
