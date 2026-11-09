'use strict';

// Operator workstation only. No runtime import, HTTP route or automatic approval.
const { fields, copy, canonical, hash, equal, uuid, digest, revision } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { approvalTarget, approvalHead, approvalRevision, headKey, revisionKey } = require('../api/shared/dashboardAdmin/approvalRecords');
const fail = () => { throw new Error('dashboard_admin_publication_refused'); };

async function publishApproval(input, { authority, epoch, confirm = null, print, now = Date.now }) {
    const value = fields(copy(input, 24000), ['storageAccount', 'authorityContainer', 'epochStorageAccount', 'epochContainer',
        'record', 'expectedRevision', 'expectedRecordSha256']);
    for (const key of ['storageAccount', 'epochStorageAccount']) if (!/^[a-z0-9]{3,24}$/.test(value[key])) fail();
    for (const key of ['authorityContainer', 'epochContainer']) if (!/^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value[key])) fail();
    if (value.storageAccount === value.epochStorageAccount) fail();
    const raw = value.record, target = approvalTarget({ instanceId: raw.instanceId, operatorSubjectKey: raw.operatorSubjectKey, purpose: raw.purpose });
    const head = approvalHead({ schemaVersion: 1, recordType: 'dashboard_admin_approval_head', ...target,
        restoreEpoch: raw.restoreEpoch, revision: raw.revision, status: raw.status, recordSha256: hash(raw) }, target);
    const record = approvalRevision(raw, head), key = headKey(target);
    const initial = value.expectedRevision === null && value.expectedRecordSha256 === null;
    if (!initial) { revision(value.expectedRevision); digest(value.expectedRecordSha256); }
    const signal = AbortSignal.timeout(30000);
    function checkTime() {
        signal.throwIfAborted();
        if (Date.parse(record.changedAt) > now() || record.status === 'active' && Date.parse(record.binding.validUntil) <= now()) fail();
    }
    async function read(container, name, maximum = 16384, canonicalOnly = true) {
        checkTime(); let response;
        try { response = await container.getBlockBlobClient(name).download(0, maximum + 1, { abortSignal: signal }); }
        catch (error) { if (error.statusCode === 404 && error.code === 'BlobNotFound') return null; throw error; }
        const stream = response.readableStreamBody;
        try {
            if (!Number.isSafeInteger(response.contentLength) || response.contentLength < 1 || response.contentLength > maximum ||
                !/^"[^"\r\n]{1,200}"$/.test(response.etag)) fail();
            const chunks = []; let size = 0;
            for await (const chunk of stream) { checkTime(); size += chunk.length; if (size > maximum) fail(); chunks.push(chunk); }
            if (size !== response.contentLength) fail();
            const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), data = JSON.parse(text);
            if (canonicalOnly && canonical(data) !== text) fail();
            return { data, etag: response.etag };
        } finally { stream?.destroy(); }
    }
    async function checkEpoch() {
        const current = await read(epoch, `runtime-epochs/${target.instanceId}.json`, 1024, false);
        if (!current) fail();
        fields(current.data, ['instanceId', 'restoreEpoch']); uuid(current.data.restoreEpoch);
        if (!equal(current.data, { instanceId: target.instanceId, restoreEpoch: record.restoreEpoch })) fail();
    }
    await checkEpoch();
    const current = await read(authority, key, 2048);
    if (current) {
        approvalHead(current.data, target);
        const archive = await read(authority, revisionKey(target, current.data.recordSha256));
        if (!archive) fail(); approvalRevision(archive.data, current.data);
        if (equal(current.data, head)) { print({ status: 'already_applied', recordSha256: head.recordSha256, writes: [] }); return; }
        if (initial || current.data.revision !== value.expectedRevision || current.data.recordSha256 !== value.expectedRecordSha256 ||
            record.revision !== current.data.revision + 1) fail();
    } else if (!initial || record.revision !== 0) fail();
    const audit = { schemaVersion: 1, recordType: 'dashboard_admin_publication_intent', recordSha256: head.recordSha256,
        operatorSha256: hash(target.operatorSubjectKey), decisionReference: record.decisionReference,
        changedAt: record.changedAt, expectedRevision: value.expectedRevision, expectedRecordSha256: value.expectedRecordSha256 };
    const writes = [];
    for (const [blob, body] of [[`dashboard-admin-publication-intents/${head.recordSha256}.json`, audit], [revisionKey(target, head.recordSha256), record]]) {
        const stored = await read(authority, blob);
        if (stored && !equal(stored.data, body)) fail();
        if (!stored) writes.push({ blob, body, conditions: { ifNoneMatch: '*' } });
    }
    writes.push({ blob: key, body: head, conditions: current ? { ifMatch: current.etag } : { ifNoneMatch: '*' } });
    const plan = { storageAccount: value.storageAccount, authorityContainer: value.authorityContainer,
        epochStorageAccount: value.epochStorageAccount, epochContainer: value.epochContainer, restoreEpoch: record.restoreEpoch, writes };
    const planSha256 = hash(plan);
    print({ status: 'plan', planSha256, ...plan });
    if (confirm === null) return;
    if (confirm !== planSha256) fail();
    for (const write of writes) {
        await checkEpoch(); checkTime();
        await authority.getBlockBlobClient(write.blob).uploadData(Buffer.from(canonical(write.body)), {
            conditions: write.conditions, abortSignal: signal,
            blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' }
        });
    }
    await checkEpoch();
    if (!equal((await read(authority, key, 2048))?.data, head)) fail();
    print({ status: 'applied', planSha256, recordSha256: head.recordSha256 });
}

async function main(args) {
    if (process.env.GITHUB_ACTIONS || process.env.CI || ![2, 4].includes(args.length) || args[0] !== '--request' ||
        args.length === 4 && (args[2] !== '--confirm' || !/^[a-f0-9]{64}$/.test(args[3]))) fail();
    const fs = require('node:fs'), bytes = fs.readFileSync(args[1]);
    if (bytes.length > 24000) fail();
    const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    // Validate endpoint selectors before constructing authenticated clients.
    for (const key of ['storageAccount', 'epochStorageAccount']) if (typeof input[key] !== 'string' || !/^[a-z0-9]{3,24}$/.test(input[key])) fail();
    for (const key of ['authorityContainer', 'epochContainer']) if (typeof input[key] !== 'string' || !/^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(input[key])) fail();
    const { AzureCliCredential } = require('@azure/identity'), { BlobServiceClient } = require('@azure/storage-blob');
    const credential = new AzureCliCredential();
    const container = (account, name) => new BlobServiceClient(`https://${account}.blob.core.windows.net`, credential,
        { retryOptions: { maxTries: 1 } }).getContainerClient(name);
    await publishApproval(input, { authority: container(input.storageAccount, input.authorityContainer),
        epoch: container(input.epochStorageAccount, input.epochContainer), confirm: args[3] ?? null,
        print: value => console.log(JSON.stringify(value, null, 2)) });
}
if (require.main === module) main(process.argv.slice(2)).catch(() => {
    // Provider messages can contain credentials or URLs. Never print them.
    console.error('dashboard_admin_publication_refused: inspect the current plan and epoch before retrying; partial writes may exist.');
    process.exitCode = 1;
});
module.exports = { publishApproval };
