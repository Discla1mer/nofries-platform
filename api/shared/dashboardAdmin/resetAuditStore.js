'use strict';
const { fields, copy, equal, subject, digest, uuid, instant } = require('../appLifecycle/dashboardRuntimeRecords');
const { DashboardAdminError } = require('./service');
const fail = () => { throw new DashboardAdminError(503, 'dashboard_admin_unavailable'); };
function record(phase, input) {
    const value = fields(copy(input, 2048), ['actorSubjectKey', 'targetSha256', 'operationId',
        ...(phase === 'inspection' ? [] : ['commandSha256']), ...(phase === 'completed' ? ['receipt'] : ['occurredAt', 'version'])]);
    subject(value.actorSubjectKey); digest(value.targetSha256); uuid(value.operationId);
    if (phase !== 'inspection') digest(value.commandSha256);
    if (phase !== 'completed') { instant(value.occurredAt); digest(value.version); }
    else {
        const r = fields(value.receipt, ['operationId', 'commandSha256', 'status', 'version', 'occurredAt']);
        if (r.operationId !== value.operationId || r.commandSha256 !== value.commandSha256 || r.status !== 'succeeded') fail();
        digest(r.version); instant(r.occurredAt);
    }
    return value;
}
function createResetAuditStore(container) {
    function blob(phase, operationId) {
        if (!['inspection', 'requested', 'completed'].includes(phase)) fail(); uuid(operationId);
        return container.getBlockBlobClient('dashboard-admin/audit/signup-reset/' + operationId + '/' + phase + '.json');
    }
    async function read(phase, operationId) {
        let response;
        try {
            response = await blob(phase, operationId).download(0, 2049, { abortSignal: AbortSignal.timeout(4000) });
            if (!Number.isSafeInteger(response.contentLength) || response.contentLength < 1 || response.contentLength > 2048) fail();
            let size = 0; const chunks = [];
            for await (const part of response.readableStreamBody) { size += part.length; if (size > 2048) fail(); chunks.push(part); }
            if (size !== response.contentLength) fail();
            const value = record(phase, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
            if (value.operationId !== operationId) fail(); return value;
        } catch (e) { if (e?.statusCode === 404 && e.code === 'BlobNotFound') return null; fail(); }
        finally { response?.readableStreamBody?.destroy(); }
    }
    return Object.freeze({ read, async write(phase, operationId, input) {
        const value = record(phase, input); if (value.operationId !== operationId) fail();
        try { await blob(phase, operationId).uploadData(Buffer.from(JSON.stringify(value)), { conditions: { ifNoneMatch: '*' },
            abortSignal: AbortSignal.timeout(4000), blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' } }); }
        catch (_) { /* Only exact immutable reconciliation counts as success. */ }
        if (!equal(await read(phase, operationId), value)) fail();
    } });
}
module.exports = { createResetAuditStore };
