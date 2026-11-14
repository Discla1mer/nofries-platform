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

function createAccountWipeIdentity({ tenantId, getToken, fetch: request = globalThis.fetch, timeoutMs = 5000 }) {
    if (typeof tenantId !== 'string' || !UUID.test(tenantId) || typeof getToken !== 'function' || typeof request !== 'function')
        fail('account_wipe_identity_configuration_invalid');
    return Object.freeze({
        async remove(subjectKey) {
            if (typeof subjectKey !== 'string') fail('account_wipe_identity_target_invalid');
            const [subjectTenant, objectId, ...rest] = subjectKey.split(':');
            if (rest.length || !UUID.test(subjectTenant || '') || !UUID.test(objectId || '')) fail('account_wipe_identity_target_invalid');
            if (subjectTenant !== tenantId) fail('account_wipe_identity_wrong_tenant');
            let token;
            try { token = await getToken(); } catch (_) { fail('account_wipe_identity_unavailable'); }
            if (!tokenFor(token, tenantId)) fail('account_wipe_identity_configuration_invalid');
            const call = async url => {
                let response;
                try {
                    response = await request(url, { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
                        headers: { Authorization: `Bearer ${token}` } });
                } catch (_) { fail('account_wipe_identity_unavailable'); }
                try { await response.body?.cancel?.(); } catch (_) { /* Body is not needed. */ }
                if (response.status === 204 || response.status === 404) return response.status;
                if ([401, 403].includes(response.status)) fail('account_wipe_identity_forbidden');
                fail('account_wipe_identity_unavailable');
            };
            const active = await call(`https://graph.microsoft.com/v1.0/users/${objectId}`);
            const deleted = await call(`https://graph.microsoft.com/v1.0/directory/deletedItems/${objectId}`);
            return Object.freeze({ removed: true, alreadyGone: active === 404 && deleted === 404 });
        }
    });
}

module.exports = { createAccountWipeIdentity };
