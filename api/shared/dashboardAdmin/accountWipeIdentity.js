'use strict';

// Removes a customer's Microsoft Entra External ID user as the last step of a
// staff account delete. Fixed Graph origin. The subject's tenant must be the
// configured External ID tenant, and so must the token's, so a workforce
// (staff) identity or a misconfigured credential can never produce a false
// "removed". DELETE /users/{oid} only moves the user to deleted items, where it
// stays restorable for 30 days, so the user is then also permanently deleted
// from /directory/deletedItems. A 404 at either step counts as gone. No token,
// response body or identifier is logged or returned.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const GRAPH_AUDIENCES = new Set(['https://graph.microsoft.com', '00000003-0000-0000-c000-000000000000']);

// The token is our own (from the injected credential), so its payload is read
// without verifying the signature, only to confirm which tenant and API it is for.
function tokenFor(token, tenantId) {
    if (typeof token !== 'string' || !token) return false;
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8'));
        return payload?.tid === tenantId && GRAPH_AUDIENCES.has(String(payload?.aud).replace(/\/$/, ''));
    } catch (_) { return false; }
}

// After DELETE /users the user can take a moment to appear in deleted items,
// so a 404 there is retried with a short backoff (within the run deadline)
// before the user is counted as gone; still not visible is
// account_wipe_identity_pending, which a later retry finishes.
const PERMANENT_RETRY_MS = Object.freeze([500, 1000, 2000, 4000]);
const wait = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
});

function createAccountWipeIdentity({ tenantId, getToken, fetch: request = globalThis.fetch, timeoutMs = 5000, sleep = wait, now = Date.now, retryDelaysMs = PERMANENT_RETRY_MS }) {
    if (typeof tenantId !== 'string' || !UUID.test(tenantId) || typeof getToken !== 'function' || typeof request !== 'function' ||
        typeof sleep !== 'function' || typeof now !== 'function' || !Array.isArray(retryDelaysMs)) fail('account_wipe_identity_configuration_invalid');
    // A usable Graph token for the External ID tenant, or a fixed code.
    async function token(signal) {
        let value;
        try { value = await getToken({ signal }); } catch (_) { fail('account_wipe_identity_unavailable'); }
        if (!tokenFor(value, tenantId)) fail('account_wipe_identity_configuration_invalid');
        return value;
    }
    return Object.freeze({
        // Checked before any irreversible stage of a delete.
        async check({ signal } = {}) {
            try { await token(signal); } catch (_) { fail('account_wipe_identity_unavailable'); }
            return true;
        },
        async remove(subjectKey, { signal, deadline } = {}) {
            if (typeof subjectKey !== 'string') fail('account_wipe_identity_target_invalid');
            const [subjectTenant, objectId, ...rest] = subjectKey.split(':');
            if (rest.length || !UUID.test(subjectTenant || '') || !UUID.test(objectId || '')) fail('account_wipe_identity_target_invalid');
            if (subjectTenant !== tenantId) fail('account_wipe_identity_wrong_tenant');
            const bearer = await token(signal);
            const call = async url => {
                if (signal?.aborted || deadline !== undefined && now() >= deadline) fail('account_wipe_identity_unavailable');
                let response;
                try {
                    response = await request(url, { method: 'DELETE', redirect: 'error',
                        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
                        headers: { Authorization: `Bearer ${bearer}` } });
                } catch (_) { fail('account_wipe_identity_unavailable'); }
                try { await response.body?.cancel?.(); } catch (_) { /* Body is not needed. */ }
                if (response.status === 204 || response.status === 404) return response.status;
                if ([401, 403].includes(response.status)) fail('account_wipe_identity_forbidden');
                fail('account_wipe_identity_unavailable');
            };
            const permanent = `https://graph.microsoft.com/v1.0/directory/deletedItems/${objectId}`;
            const active = await call(`https://graph.microsoft.com/v1.0/users/${objectId}`);
            let deleted = await call(permanent);
            // Only a user this call has just deleted can be lagging into deleted items.
            for (const delay of active === 204 ? retryDelaysMs : []) {
                if (deleted === 204) break;
                if (deadline !== undefined && now() + delay + timeoutMs > deadline) break;
                try { await sleep(delay, signal); } catch (_) { break; }
                deleted = await call(permanent);
            }
            if (active === 204 && deleted === 404) fail('account_wipe_identity_pending');
            return Object.freeze({ removed: true, alreadyGone: active === 404 && deleted === 404 });
        }
    });
}

module.exports = { createAccountWipeIdentity };
