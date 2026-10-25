'use strict';

// Administrative policy storage is separate from mailbox proof and customer
// sessions. Runtime composition receives only the read capability below.
const { copy, fields, freeze, hash, equal, id, uuid, digest, revision, instant } = require('../appLifecycle/dashboardRuntimeRecords');
const { createNcscSubmissionQuotaResolver, normaliseNcscSubmissionSelection } = require('../../../lib/ncscSubmissionPolicy');
const TARGET = ['tenantId', 'organisationId', 'productGrantId', 'agreementRef', 'moduleId', 'profileRef'];
const MAX_INDEX = 262144, MAX_ARCHIVE = 16384, MAX_REVISIONS = 128;
const fail = () => { throw new Error('ncsc_policy_store_unavailable'); };
const conflict = () => { throw new Error('ncsc_policy_publication_conflict'); };
const targetOf = value => Object.fromEntries(TARGET.map(key => [key, value[key]]));
const targetHash = target => hash({ purpose: 'nofries-ncsc-policy-target-v1', target });
const indexKey = target => `ncsc-policy-indexes/${targetHash(target)}.json`;
const archiveKey = entry => `ncsc-policy-revisions/${targetHash(targetOf(entry.policy))}/${hash(entry)}.json`;
function approvedEntry(input) {
    const entry = copy(input, MAX_ARCHIVE);
    fields(entry, ['schemaVersion', 'policy', 'approval']);
    if (entry.schemaVersion !== 1) fail();
    createNcscSubmissionQuotaResolver({ schemaVersion: 1, policies: [entry.policy] });
    fields(entry.approval, ['approvalId', 'evidenceRef', 'evidenceSha256', 'approvedAt']);
    uuid(entry.approval.approvalId); id(entry.approval.evidenceRef);
    digest(entry.approval.evidenceSha256); instant(entry.approval.approvedAt);
    return freeze(entry);
}
function policyIndex(input, target) {
    const value = fields(copy(input, MAX_INDEX), ['schemaVersion', 'target', 'revision', 'entries']);
    fields(value.target, TARGET); revision(value.revision);
    if (value.schemaVersion !== 1 || !equal(value.target, target) || !Array.isArray(value.entries) ||
        !value.entries.length || value.entries.length > MAX_REVISIONS || value.revision !== value.entries.length - 1) fail();
    let previous = null;
    for (let i = 0; i < value.entries.length; i++) {
        const entry = approvedEntry(value.entries[i]);
        if (!equal(targetOf(entry.policy), target) || entry.policy.policyRevision !== i ||
            previous && (entry.policy.policyId !== previous.policy.policyId || entry.policy.validFrom < previous.policy.validUntil ||
                entry.approval.approvedAt < previous.approval.approvedAt)) fail();
        previous = entry;
    }
    createNcscSubmissionQuotaResolver({ schemaVersion: 1, policies: value.entries.map(entry => entry.policy) });
    return freeze(value);
}
async function read(container, key, maximum) {
    try {
        const response = await container.getBlockBlobClient(key).download(0, maximum + 1, { abortSignal: AbortSignal.timeout(5000) });
        if (!Number.isSafeInteger(response.contentLength) || response.contentLength < 0 || response.contentLength > maximum ||
            typeof response.etag !== 'string' || !response.etag || response.etag.length > 256 || /[\x00-\x1f\x7f]/.test(response.etag)) fail();
        const chunks = []; let bytes = 0;
        try {
            for await (const chunk of response.readableStreamBody) {
                bytes += chunk.length; if (bytes > maximum || bytes > response.contentLength) fail(); chunks.push(chunk);
            }
        } finally { response.readableStreamBody?.destroy(); }
        if (bytes !== response.contentLength) fail();
        return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))), etag: response.etag };
    } catch (error) {
        if (error?.statusCode === 404 && error?.code === 'BlobNotFound') return null;
        fail();
    }
}
const upload = (container, key, value, conditions) => container.getBlockBlobClient(key).uploadData(Buffer.from(JSON.stringify(value)), {
    conditions, abortSignal: AbortSignal.timeout(5000),
    blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' }
});
function createNcscPolicyReader({ authorityContainer }) {
    return Object.freeze({ async readPolicies(input) {
        try {
            const selection = normaliseNcscSubmissionSelection(input), target = targetOf(selection);
            const found = await read(authorityContainer, indexKey(target), MAX_INDEX);
            if (!found) return null;
            const index = policyIndex(found.value, target);
            const selected = index.entries.find(entry => entry.policy.validFrom <= selection.at && selection.at < entry.policy.validUntil);
            if (!selected) return null;
            const archived = await read(authorityContainer, archiveKey(selected), MAX_ARCHIVE);
            if (!archived || !equal(approvedEntry(archived.value), selected)) fail();
            // The archive, not an index-supplied substitute, is the receipt policy.
            return freeze({ schemaVersion: 1, policies: [approvedEntry(archived.value).policy] });
        } catch (_) { fail(); }
    } });
}
function normalisePublication(input) {
    const command = fields(copy(input, MAX_ARCHIVE), ['schemaVersion', 'entry', 'expectedIndexRevision', 'expectedIndexSha256']);
    if (command.schemaVersion !== 1) fail();
    approvedEntry(command.entry);
    if (command.expectedIndexRevision === null || command.expectedIndexSha256 === null) {
        if (command.expectedIndexRevision !== null || command.expectedIndexSha256 !== null) fail();
    } else { revision(command.expectedIndexRevision); digest(command.expectedIndexSha256); }
    return freeze(command);
}
function createNcscPolicyPublisher({ authorityContainer, clock, beforeWrite }) {
    if (typeof clock !== 'function' || typeof beforeWrite !== 'function') fail();
    return Object.freeze({
        async inspect(input) {
            const command = normalisePublication(input), target = targetOf(command.entry.policy);
            const current = await read(authorityContainer, indexKey(target), MAX_INDEX);
            const index = current ? policyIndex(current.value, target) : null;
            return freeze({ expectedIndexRevision: index?.revision ?? null, expectedIndexSha256: index ? hash(index) : null });
        },
        async publish(input) {
        const command = normalisePublication(input), entry = approvedEntry(command.entry), target = targetOf(entry.policy);
        const at = instant(clock());
        if (entry.approval.approvedAt > at) conflict();
        const current = await read(authorityContainer, indexKey(target), MAX_INDEX);
        const index = current ? policyIndex(current.value, target) : null;
        const same = index?.entries.find(candidate => equal(candidate, entry));
        const result = freeze({ schemaVersion: 1, targetSha256: targetHash(target), policyId: entry.policy.policyId,
            policyRevision: entry.policy.policyRevision, archiveSha256: hash(entry) });
        if (same) {
            const archive = await read(authorityContainer, archiveKey(entry), MAX_ARCHIVE);
            if (!archive || !equal(approvedEntry(archive.value), entry)) fail();
            return result;
        }
        // A completed exact publication is historical evidence, even after
        // expiry. Only a new append requires a currently unexpired policy.
        if (entry.policy.validUntil <= at) conflict();
        if (index ? command.expectedIndexRevision !== index.revision || command.expectedIndexSha256 !== hash(index)
            : command.expectedIndexRevision !== null) conflict();
        const next = policyIndex({ schemaVersion: 1, target, revision: (index?.revision ?? -1) + 1,
            entries: [...(index?.entries || []), entry] }, target);
        // Archive is create-only. A failed head CAS leaves a harmless retained
        // archive; retries never overwrite another publisher or erase history.
        await beforeWrite();
        try { await upload(authorityContainer, archiveKey(entry), entry, { ifNoneMatch: '*' }); }
        catch (_) {
            const archive = await read(authorityContainer, archiveKey(entry), MAX_ARCHIVE);
            if (!archive || !equal(approvedEntry(archive.value), entry)) fail();
        }
        await beforeWrite();
        if (entry.policy.validUntil <= instant(clock())) conflict();
        try { await upload(authorityContainer, indexKey(target), next, current ? { ifMatch: current.etag } : { ifNoneMatch: '*' }); }
        catch (_) {
            const observed = await read(authorityContainer, indexKey(target), MAX_INDEX);
            if (!observed || !equal(policyIndex(observed.value, target), next)) conflict();
        }
        const observed = await read(authorityContainer, indexKey(target), MAX_INDEX);
        if (!observed || !equal(policyIndex(observed.value, target), next)) conflict();
        return result;
    } });
}
module.exports = { createNcscPolicyReader, createNcscPolicyPublisher, normalisePublication,
    approvedEntry, policyIndex, indexKey, archiveKey, MAX_REVISIONS };
