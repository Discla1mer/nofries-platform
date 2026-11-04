'use strict';

// Unmounted, read-only planning aid. A future trusted verifier must validate the
// provenance, completeness and freshness of every witness, including the
// inability of detached writes or marker clears to land after its observation.
// This module grants no authority and performs no storage or lease operations.
const { copy, fields, freeze, hash, digest, uuid, revision } = require('../appLifecycle/dashboardRuntimeRecords');

const blocked = code => Object.freeze({ status: 'blocked', code, authoritative: false });
const SHA = /^[a-f0-9]{40}$/;
function binding(value) {
    fields(value, ['operationId', 'sourceSha', 'writerDigest', 'targetDigest', 'fenceId', 'fenceGeneration']);
    uuid(value.operationId); uuid(value.fenceId); digest(value.writerDigest); digest(value.targetDigest);
    revision(value.fenceGeneration);
    if (typeof value.sourceSha !== 'string' || !SHA.test(value.sourceSha)) throw Error('invalid');
}
function witness(value, keys, bindingSha256) {
    fields(value, ['bindingSha256', ...keys]);
    if (value.bindingSha256 !== bindingSha256) throw Error('binding');
}
function pointer(value, bindingSha256) {
    witness(value, ['originalVersion', 'originalSha256', 'currentVersion', 'currentSha256'], bindingSha256);
    if (typeof value.originalVersion !== 'string' || !/^[A-Za-z0-9:._-]{1,128}$/.test(value.originalVersion)) throw Error('invalid');
    digest(value.originalSha256);
    if (value.currentVersion === null && value.currentSha256 === null) return;
    if (typeof value.currentVersion !== 'string' || !/^[A-Za-z0-9:._-]{1,128}$/.test(value.currentVersion)) throw Error('invalid');
    digest(value.currentSha256);
}
function createRetainedWriterRecoveryPlan({ verifyEvidence } = {}) {
    return async function evaluate(input) {
        if (typeof verifyEvidence !== 'function') return blocked('verifier_unavailable');
        let e;
        try {
            e = freeze(copy(input, 16384));
            fields(e, ['schemaVersion', 'binding', 'fence', 'drain', 'account', 'authority', 'dependencies', 'audit']);
            if (e.schemaVersion !== 1) throw Error('invalid');
            binding(e.binding); const b = hash(e.binding);
            witness(e.fence, ['retained', 'current', 'noSuccessor', 'markerClearStopped'], b);
            witness(e.drain, ['admissionStopped', 'allWritersCovered', 'detachedSettled', 'issuedReconciled'], b);
            pointer(e.account, b); pointer(e.authority, b);
            witness(e.dependencies, ['sqlUnchanged', 'indexReconciled'], b);
            witness(e.audit, ['complete'], b);
            for (const part of [e.fence, e.drain, e.dependencies, e.audit]) {
                for (const [key, value] of Object.entries(part)) if (key !== 'bindingSha256' && typeof value !== 'boolean') throw Error('invalid');
            }
        } catch (_) { return blocked('invalid_evidence'); }
        try {
            // A boolean result represents the trusted verifier's attestation of
            // this exact immutable snapshot, not independent verification here.
            if (await verifyEvidence(e) !== true) return blocked('evidence_unverified');
        } catch (_) { return blocked('evidence_unverified'); }
        if (!e.fence.retained || !e.fence.current || !e.fence.noSuccessor || !e.fence.markerClearStopped) return blocked('fence_unconfirmed');
        if (!e.drain.admissionStopped || !e.drain.allWritersCovered || !e.drain.detachedSettled || !e.drain.issuedReconciled) return blocked('drain_unconfirmed');
        if (!e.dependencies.sqlUnchanged || !e.dependencies.indexReconciled) return blocked('dependencies_unconfirmed');
        if (!e.audit.complete) return blocked('audit_unconfirmed');
        if ([e.account, e.authority].some(p => p.currentVersion !== null && (p.currentSha256 !== p.originalSha256 || p.currentVersion !== p.originalVersion))) return blocked('pointer_conflict');
        // This is a point-in-time assessment only. A verifier cannot preserve
        // these facts through future effects; no result authorizes execution.
        return freeze({ status: 'assessment', code: 'prerequisites_reported', authoritative: false,
            executionAuthorized: false, evidenceSha256: hash(e), prerequisites: [
                'independently_verify_current_fence_and_writer_drain',
                'independently_verify_original_and_current_pointer_versions',
                'independently_verify_dependencies_and_audit',
                'design_atomic_execution_and_separate_authorization'
            ] });
    };
}
module.exports = { createRetainedWriterRecoveryPlan };
