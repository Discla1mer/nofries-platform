'use strict';

const { inspectCustomerAuthority } = require('./customerAuthorityExpiry');
const { subjectHash } = require('../customerSignup/customerAuthority');
const { AzureStarterAccountStore } = require('../customerSignup/azureStarterAccountStore');
const { starterAccountKey } = require('../customerSignup/starterAccountAllocation');
const { hash } = require('../appLifecycle/dashboardRuntimeRecords');
const MAX_SCANNED_SUBJECTS = 100;
const unavailable = () => { throw new Error('account_lookup_unavailable'); };
const provider = source => source.kind === 'external_starter' ? 'external' : 'legacy';

// One row per sign-in authority record (or starter account without one). Only
// allowlisted, non-secret fields leave this reader; digests, invitation and
// terms details stay in storage. No email ever reaches a URL or log.
function row(email, source, extra) {
    return { email, kind: source.kind, schemaVersion: null, plan: null, accountType: null,
        organisation: null, status: 'missing', effectiveAt: null, expiresAt: null, revision: null, ...extra };
}
const starterFields = account => ({ plan: account.planId, accountType: account.accountType,
    organisation: account.organisations[0].organisationName, effectiveAt: account.activation?.activatedAt ?? null });

function createAccountLookupReader(sources, now = Date.now) {
    return async function lookup(email, signal, includeSelector = false) {
        const rows = [];
        let truncated = false;
        for (const { source, container } of sources) {
            signal.throwIfAborted();
            const account = source.kind === 'legacy_admin' ? null :
                (await new AzureStarterAccountStore(container).load(starterAccountKey(email)))?.record;
            const expectedSubject = account?.identitySubjectKey ?? account?.activation?.subjectKey;
            const slot = account?.organisations[0] ?? null;
            let foundExpected = false, count = 0, capped = false;
            // No email index exists for subject records. Bound enumeration and
            // report a hit cap instead of presenting a partial scan as complete.
            for await (const blob of container.listBlobsFlat({ prefix: 'customer-subjects/', abortSignal: signal })) {
                signal.throwIfAborted();
                if (++count > MAX_SCANNED_SUBJECTS) { capped = truncated = true; break; }
                if (!/^customer-subjects\/[a-f0-9]{64}\.json$/.test(blob.name)) unavailable();
                let record, etag;
                try {
                    const response = await container.getBlockBlobClient(blob.name).download(0, 16385, { abortSignal: signal });
                    const chunks = []; let size = 0;
                    try {
                        if (!Number.isSafeInteger(response.contentLength) || response.contentLength < 1 || response.contentLength > 16384) unavailable();
                        for await (const chunk of response.readableStreamBody) {
                            size += chunk.length; if (size > 16384) unavailable(); chunks.push(chunk);
                        }
                        if (size !== response.contentLength) unavailable();
                        record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
                        etag = response.etag;
                    } finally { response.readableStreamBody?.destroy(); }
                } catch (error) {
                    if (error.statusCode === 404 && error.code === 'BlobNotFound') continue;
                    throw error;
                }
                if (record?.email !== email) continue;
                const value = row(email, source, {});
                try {
                    const at = new Date(now()).toISOString();
                    const bound = record.subjectKey === expectedSubject && record.tenantId === slot?.tenantId && record.organisationId === slot?.organisationId;
                    const result = inspectCustomerAuthority({ source, blobName: blob.name, etag, observedAt: at, record },
                        { sourceSha256: hash(source), subjectKey: record.subjectKey, tenantId: record.tenantId, organisationId: record.organisationId }, at);
                    Object.assign(value, { schemaVersion: record.schemaVersion, accountType: record.accountType ?? null, organisation: record.organisationId,
                        status: result.status, expiresAt: result.expiresAt, revision: result.revision }, bound ? starterFields(account) : {});
                    if (includeSelector) value.selector = { provider: provider(source), subjectKey: record.subjectKey,
                        tenantId: record.tenantId, organisationId: record.organisationId };
                } catch (_) { /* A malformed/misbound record is not usable authority. */ }
                if (expectedSubject && blob.name === `customer-subjects/${subjectHash(expectedSubject)}.json`) foundExpected = true;
                rows.push(value);
            }
            // A starter account found by its exact email key is always shown. When
            // the subject scan hit the cap before reaching it, its sign-in record
            // is unknown rather than missing.
            if (account && !foundExpected) rows.push(row(email, source, { ...starterFields(account), ...(capped ? { status: 'unknown' } : {}) }));
        }
        signal.throwIfAborted();
        return { rows, truncated };
    };
}

module.exports = { createAccountLookupReader, MAX_SCANNED_SUBJECTS };
