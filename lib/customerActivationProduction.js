'use strict';

const { TextDecoder } = require('node:util');
const { normaliseActivationApproval, buildActivationCommands, validateMembershipReservationResult, activationKey, completionKey, activationReferenceKey, activationReference, customerReference } = require('../api/shared/customerSignup/customerActivation');
const { createPostgresDatabase } = require('../api/shared/database/postgres');
const { dataStorage } = require('../api/shared/appLifecycle/postgresDashboardBootstrap');
const { authority, subjectHash } = require('../api/shared/customerSignup/customerAuthority');
const { fields, copy, freeze, hash, uuid, id, digest, instant, revision } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const fail = () => { throw new Error('customer_activation_unavailable'); };
const MAX_BYTES = 524288;

async function readBlob(blob, optional = false) {
    let response;
    try { response = await blob.download(0, MAX_BYTES + 1, { abortSignal: AbortSignal.timeout(5000) }); }
    catch (error) { if (optional && error?.statusCode === 404 && error?.code === 'BlobNotFound') return null; fail(); }
    const stream = response.readableStreamBody;
    if (!stream || !Number.isSafeInteger(response.contentLength) || response.contentLength <= 0 || response.contentLength > MAX_BYTES ||
        typeof response.etag !== 'string' || !response.etag) { stream?.destroy(); fail(); }
    const chunks = []; let size = 0;
    try {
        for await (const chunk of stream) { size += chunk.length; if (size > MAX_BYTES) fail(); chunks.push(chunk); }
        if (size !== response.contentLength) fail();
        return { record: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))), etag: response.etag };
    } catch (_) { fail(); } finally { stream.destroy(); }
}

function completionResult(input) {
    const value = fields(copy(input, MAX_BYTES), ['schemaVersion', 'activationId', 'phase', 'approvalSha256', 'bootstrapReference',
        'membershipOperationId', 'membershipResultSha256', 'publicationOperationId', 'publicationResultSha256', 'bindingId',
        'membershipReservationOperationId', 'membershipReservationResultSha256', 'membershipReservationResult',
        'acceptanceReceiptId', 'acceptanceSha256', 'authorityRevision', 'authoritySha256', 'observedAt']);
    if (value.schemaVersion !== 2 || value.phase !== 'activated') fail();
    id(value.membershipReservationOperationId);
    for (const key of ['activationId', 'membershipOperationId', 'publicationOperationId', 'bindingId']) uuid(value[key]);
    for (const key of ['approvalSha256', 'membershipResultSha256', 'membershipReservationResultSha256', 'publicationResultSha256', 'acceptanceSha256', 'authoritySha256']) digest(value[key]);
    if (typeof value.acceptanceReceiptId !== 'string' || !value.acceptanceReceiptId || value.acceptanceReceiptId.length > 180) fail();
    revision(value.authorityRevision); instant(value.observedAt);
    const reference = fields(value.bootstrapReference, ['schemaVersion', 'operationType', 'tenantId', 'organisationId', 'operationId', 'intentSha256', 'resultSha256']);
    if (reference.schemaVersion !== 1 || reference.operationType !== 'organisation.initialise') fail();
    uuid(reference.operationId); digest(reference.intentSha256); digest(reference.resultSha256);
    return freeze(value);
}

function createCustomerActivationPort({ authorityContainer, sessionContainer, readMembershipReservation, now = Date.now,
    readSourceSha = () => require('../api/shared/releaseIdentity').getReleaseIdentity()?.releaseSha }) {
    async function read(id) {
        const approval = normaliseActivationApproval((await readBlob(authorityContainer.getBlockBlobClient(activationKey(id)))).record);
        if (approval.activationId !== id) fail();
        const current = authority((await readBlob(authorityContainer.getBlockBlobClient(`customer-subjects/${subjectHash(approval.subjectKey)}.json`))).record,
            approval.subjectKey, now());
        return freeze({ approval, authority: current });
    }
    return Object.freeze({ read,
        async readPreparation(current) {
            const saved = await readBlob(authorityContainer.getBlockBlobClient(activationReferenceKey(current)), true);
            if (!saved) return null;
            const reference = fields(saved.record, ['schemaVersion', 'activationId', 'approvalSha256']);
            uuid(reference.activationId); digest(reference.approvalSha256);
            const loaded = await read(reference.activationId), approval = loaded.approval;
            const expectedCustomer = { subjectKey: approval.subjectKey, ...approval.scope, invitationId: approval.invitationId,
                termsVersion: approval.termsVersion, termsDigest: approval.termsDigest,
                scheduleId: approval.scheduleId, scheduleDigest: approval.scheduleDigest };
            if (hash(reference) !== hash(activationReference(approval)) || hash(current) !== hash(loaded.authority) ||
                current.bindingId !== null || current.revision !== approval.authorityRevision ||
                hash(current) !== approval.authoritySha256 || hash(customerReference(current)) !== hash(expectedCustomer) ||
                now() < Date.parse(approval.approvedAt) || now() >= Date.parse(approval.expiresAt)) fail();
            return approval;
        },
        async writeCompletion(input) {
            const result = completionResult(input), current = await read(result.activationId), a = current.approval;
            const observedAt = Date.parse(result.observedAt), at = now();
            if (hash(a) !== result.approvalSha256 || current.authority.bindingId !== null ||
                current.authority.revision !== a.authorityRevision || hash(current.authority) !== a.authoritySha256 ||
                result.authorityRevision !== a.authorityRevision || result.authoritySha256 !== a.authoritySha256 ||
                result.bindingId !== a.bindingId || result.membershipOperationId !== a.acceptOperationId ||
                result.membershipReservationOperationId !== buildActivationCommands(a).reserveMembership.operationId ||
                result.publicationOperationId !== a.publicationOperationId ||
                result.bootstrapReference.operationId !== a.bootstrapOperationId ||
                result.bootstrapReference.tenantId !== a.scope.tenantId || result.bootstrapReference.organisationId !== a.scope.organisationId ||
                observedAt > at || at - observedAt > 60000 || at >= Date.parse(a.expiresAt)) fail();
            // Do not attest a digest merely because it is well formed or was
            // returned by the preceding transaction. Independently read the
            // committed DATA receipt through the restricted tenant reader.
            if (typeof readMembershipReservation !== 'function') fail();
            const savedReservation = validateMembershipReservationResult(a, await readMembershipReservation(a));
            validateMembershipReservationResult(a, result.membershipReservationResult);
            if (hash(savedReservation) !== result.membershipReservationResultSha256 ||
                hash(savedReservation) !== hash(result.membershipReservationResult)) fail();
            const sourceSha = readSourceSha();
            if (typeof sourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(sourceSha)) fail();
            const record = freeze({ schemaVersion: 1, sourceSha, result, expiresAt: new Date(Math.min(observedAt + 300000, Date.parse(a.expiresAt))).toISOString() });
            const blob = sessionContainer.getBlockBlobClient(completionKey(a.activationId));
            const before = await readBlob(blob, true);
            if (before && before.record?.result?.approvalSha256 !== result.approvalSha256) fail();
            const final = await read(result.activationId);
            if (hash(final) !== hash(current) || now() >= Date.parse(record.expiresAt)) fail();
            let error;
            try { await blob.uploadData(Buffer.from(JSON.stringify(record)), { abortSignal: AbortSignal.timeout(5000),
                conditions: before ? { ifMatch: before.etag } : { ifNoneMatch: '*' },
                blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' } }); }
            catch (caught) { error = caught; }
            const after = await readBlob(blob);
            if (hash(after.record) !== hash(record)) fail();
            // An uncertain transport response is reconciled only by exact bytes.
            if (error && !after) fail();
        }
    });
}

function createProductionCustomerActivation(env, dashboard, dependencies = {}) {
    if (env.NOFRIES_CUSTOMER_SIGNUP_ENABLED !== 'true' || !dashboard || !env.NOFRIES_ADMIN_SUBJECTS) return null;
    const dataAccount = env.AZURE_STORAGE_ACCOUNT_NAME, authAccount = env.NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT;
    const authorityName = env.NOFRIES_CUSTOMER_AUTHORITY_CONTAINER, sessionName = env.NOFRIES_BROWSER_AUTH_CONTAINER || 'nofries-browser-auth';
    if (![dataAccount, authAccount].every(value => typeof value === 'string' && /^[a-z0-9]{3,24}$/.test(value)) || dataAccount === authAccount ||
        ![authorityName, sessionName].every(value => typeof value === 'string' && /^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value)) || authorityName === sessionName) fail();
    const ManagedIdentityCredential = dependencies.ManagedIdentityCredential || require('@azure/identity').ManagedIdentityCredential;
    const credential = env.NOFRIES_MANAGED_IDENTITY_CLIENT_ID ? new ManagedIdentityCredential({ clientId: env.NOFRIES_MANAGED_IDENTITY_CLIENT_ID }) : new ManagedIdentityCredential();
    const BlobServiceClient = dependencies.BlobServiceClient || require('@azure/storage-blob').BlobServiceClient;
    const service = account => new BlobServiceClient(`https://${account}.blob.core.windows.net`, credential,
        { retryOptions: { maxTries: 2, tryTimeoutInMs: 4000 } });
    const port = createCustomerActivationPort({ authorityContainer: service(dataAccount).getContainerClient(authorityName),
        sessionContainer: service(authAccount).getContainerClient(sessionName), now: () => Date.parse(dashboard.clock()),
        readMembershipReservation: createMembershipReservationReader(dashboard.pool) });
    return Object.freeze({ read: port.read, writeCompletion: port.writeCompletion });
}

function createMembershipReservationReader(pool) {
    const database = createPostgresDatabase({ pool: { end: () => pool.end(), async connect() {
        const client = await pool.connect();
        return { release: discard => client.release(discard), async query(sql, params) {
            const result = await client.query(sql, params);
            if (sql === 'BEGIN') await client.query('SET LOCAL ROLE nofries_runtime');
            return result;
        } };
    } } });
    return async approvalInput => {
        const a = normaliseActivationApproval(approvalInput), command = buildActivationCommands(a).reserveMembership;
        return database.withTenantTransaction(a.scope.tenantId, async tx => {
            const snapshot = await dataStorage.loadSnapshotForShare(tx, a.scope);
            const result = await dataStorage.readOperationReceipt(tx, command, hash({ command, initialState: null }), snapshot);
            return validateMembershipReservationResult(a, result);
        });
    };
}

module.exports = { createProductionCustomerActivation, createCustomerActivationPort, completionResult, createMembershipReservationReader };
