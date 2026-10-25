'use strict';

// Dormant metadata only: no HTTP route, content access or write capability.
const { requireTenantRequestContext } = require('./appLifecycle/tenantRequestContext');
const { fields, freeze } = require('./appLifecycle/dashboardRuntimeRecords');
const { normaliseEvidenceSelector, normaliseEvidenceState } = require('./evidenceLifecycle/evidenceDomain');

class EvidenceMetadataError extends Error {
    constructor(code = 'evidence_unavailable', statusCode = 503) {
        super(code); this.name = 'EvidenceMetadataError'; this.code = code; this.statusCode = statusCode;
        delete this.stack; Object.freeze(this);
    }
}
function fail(code = 'evidence_input_invalid', status = 400) { throw new EvidenceMetadataError(code, status); }

function normaliseEvidenceMetadataSelector(input) {
    try {
        // Exact data descriptors first; the sole accepted value is a primitive.
        // Nothing supplied by the caller survives an asynchronous boundary.
        const row = fields(input, ['artefactId']);
        const selected = normaliseEvidenceSelector({ tenantId: 'selector', organisationId: 'selector', artefactId: row.artefactId });
        return Object.freeze({ artefactId: selected.artefactId });
    } catch { fail(); }
}
function requireEvidenceContext(input) {
    try { return requireTenantRequestContext(input); }
    catch { fail('evidence_access_denied', 403); }
}
function projectEvidenceMetadata(input) {
    try {
        const state = normaliseEvidenceState(input);
        return freeze({ artefactId: state.artefactId, revision: state.revision,
            currentVersionId: state.currentVersionId, createdAt: state.createdAt, updatedAt: state.updatedAt,
            versions: state.versions.map(version => ({ versionId: version.versionId,
                introducedRevision: version.introducedRevision, recordedAt: version.recordedAt,
                declaredContent: { sha256: version.declaredContent.sha256,
                    contentType: version.declaredContent.contentType, sizeBytes: version.declaredContent.sizeBytes },
                classification: { level: version.classification.level, tags: [...version.classification.tags] },
                quarantine: { state: version.quarantine.state, reason: version.quarantine.reason }
            })) });
    } catch { fail('evidence_unavailable', 503); }
}
function createEvidenceMetadataService(adapters) {
    let resolve, read;
    try {
        const settings = fields(adapters, ['repository', 'requestContext']);
        if (typeof settings.repository?.readEvidenceMetadata !== 'function' ||
            typeof settings.requestContext?.resolve !== 'function') fail();
        resolve = settings.requestContext.resolve.bind(settings.requestContext);
        read = settings.repository.readEvidenceMetadata.bind(settings.repository);
    } catch { fail(); }
    return Object.freeze({
        async read(request, input) {
            const selector = normaliseEvidenceMetadataSelector(input);
            try { return await read(requireEvidenceContext(await resolve(request)), selector); }
            catch (error) {
                if (error instanceof EvidenceMetadataError) throw error;
                throw new EvidenceMetadataError();
            }
        }
    });
}
module.exports = Object.freeze({ EvidenceMetadataError, normaliseEvidenceMetadataSelector,
    requireEvidenceContext, projectEvidenceMetadata, createEvidenceMetadataService });
