'use strict';

const { fields, copy, hash, equal, instant, uuid, subject } = require('../appLifecycle/dashboardRuntimeRecords');
const { accountActionApproval } = require('./accountActionApproval');
const { DashboardAdminError, normaliseSelector } = require('./service');
const deny = () => { throw new DashboardAdminError(403, 'dashboard_admin_access_denied'); };
const unavailable = () => { throw new DashboardAdminError(503, 'dashboard_admin_unavailable'); };
const PREFIX = 'dashboard-admin/action-approvals/';
function approvalKey(query) {
    fields(query, ['operatorSubjectKey', 'purpose', 'instanceId', 'selector']);
    subject(query.operatorSubjectKey); uuid(query.instanceId);
    if (query.purpose !== 'account_support') deny();
    const selector = query.selector === null ? null : normaliseSelector(query.selector);
    return PREFIX + hash({ operatorSubjectKey: query.operatorSubjectKey, instanceId: query.instanceId }) + '/' +
        (selector === null ? 'capability' : hash(selector)) + '.json';
}
// Only a protected, independently published record can grant authority. This
// reader performs no publication, container creation, role assignment or scan.
function createAccountActionBindingReader({ container, clock }) {
    const seen = new Map(); let lastAt = null;
    return async query => {
        let response;
        try {
            const key = approvalKey(query), at = instant(clock());
            if (lastAt !== null && at < lastAt) unavailable();
            lastAt = at;
            response = await container.getBlockBlobClient(key).download(0, 8193, { abortSignal: AbortSignal.timeout(4000) });
            if (!Number.isSafeInteger(response.contentLength) || response.contentLength < 1 || response.contentLength > 8192) unavailable();
            const chunks = []; let bytes = 0;
            for await (const chunk of response.readableStreamBody) {
                if (!Buffer.isBuffer(chunk)) unavailable();
                bytes += chunk.length; if (bytes > 8192) unavailable(); chunks.push(chunk);
            }
            if (bytes !== response.contentLength) unavailable();
            const value = accountActionApproval(copy(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))), 8192));
            const after = instant(clock());
            if (after < at || value.operatorSubjectKey !== query.operatorSubjectKey || value.instanceId !== query.instanceId ||
                query.selector !== null && !equal(value.selector, query.selector) || after < value.validFrom || after >= value.validUntil) deny();
            lastAt = after;
            const previous = seen.get(key);
            if (previous && (value.revision < previous.revision || value.revision === previous.revision && !equal(previous, value))) deny();
            if (!previous && seen.size >= 1024) unavailable();
            seen.set(key, value);
            return value;
        } catch (error) {
            if (error instanceof DashboardAdminError) throw error;
            if (error?.statusCode === 404) deny();
            unavailable();
        } finally { response?.readableStreamBody?.destroy(); }
    };
}
module.exports = { createAccountActionBindingReader, approvalKey };
