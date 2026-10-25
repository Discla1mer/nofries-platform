'use strict';

const { DashboardPersistenceError, dataStorage } = require('./postgresDashboardBootstrap');
const { fields, freeze, instant } = require('./dashboardRuntimeRecords');
const { resolveEvidenceAccess } = require('./dashboardResourceAuthority');
const { createPostgresEvidenceStore } = require('../evidenceLifecycle/postgresEvidenceStore');
const { EvidenceMetadataError, normaliseEvidenceMetadataSelector, requireEvidenceContext,
    projectEvidenceMetadata } = require('../evidenceMetadataService');

// Trusted composition only. Authentication and request lifetime remain the host's
// responsibility; the branded context is provenance, never cached authority.
function createPostgresEvidenceMetadataRepository(options) {
    let database, clock, audit;
    try {
        ({ database, clock, audit } = fields(options, ['database', 'clock', 'audit']));
        fields(audit, ['createEvent', 'writeEvent']);
        if (typeof database?.withTenantTransaction !== 'function' || typeof clock !== 'function' ||
            typeof audit.createEvent !== 'function' || typeof audit.writeEvent !== 'function') throw new Error();
        audit = Object.freeze({ createEvent: audit.createEvent.bind(audit), writeEvent: audit.writeEvent.bind(audit) });
    } catch { throw new EvidenceMetadataError('evidence_input_invalid', 400); }
    return Object.freeze({
        async readEvidenceMetadata(contextInput, input) {
            try {
                const selector = normaliseEvidenceMetadataSelector(input), context = requireEvidenceContext(contextInput);
                let last = context.resolvedAt;
                const now = () => {
                    const at = instant(clock());
                    if (at < last) throw new EvidenceMetadataError();
                    last = at; return at;
                };
                return await database.withTenantTransaction(context.scope.tenantId, async tx => {
                    let snapshot;
                    try {
                        // The store also locks parents FOR UPDATE. Take that mode
                        // immediately, never upgrade a shared parent lock later.
                        snapshot = await dataStorage.loadSnapshotForUpdate(tx, context.scope);
                    } catch (error) {
                        if (error instanceof DashboardPersistenceError && error.statusCode === 404) {
                            throw new EvidenceMetadataError('evidence_access_denied', 403);
                        }
                        throw error;
                    }
                    resolveEvidenceAccess(snapshot, context, now());
                    const store = createPostgresEvidenceStore({ database: Object.freeze({
                        async withTenantTransaction(tenantId, work) {
                            if (tenantId !== context.scope.tenantId) throw new EvidenceMetadataError('evidence_access_denied', 403);
                            return await work(tx);
                        }
                    }) });
                    const state = await store.read({ ...context.scope, ...selector });
                    resolveEvidenceAccess(snapshot, context, now());
                    if (!state) throw new EvidenceMetadataError('evidence_not_found', 404);
                    const result = freeze({ schemaVersion: 1, evidence: projectEvidenceMetadata(state) });
                    const event = audit.createEvent(context, { action: 'evidence.read', module: 'evidence', result: 'succeeded' });
                    await audit.writeEvent(event);
                    resolveEvidenceAccess(snapshot, context, now());
                    return result;
                });
            } catch (error) {
                if (error instanceof EvidenceMetadataError) throw error;
                throw new EvidenceMetadataError();
            }
        }
    });
}
module.exports = Object.freeze({ createPostgresEvidenceMetadataRepository });
