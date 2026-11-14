'use strict';

// Removes a customer's Microsoft Entra External ID user as the last step of a
// staff account delete. Fixed Graph origin, one DELETE by object id; the
// subject's tenant must be the configured External ID tenant, so a workforce
// (staff) identity can never be targeted. A user that is already gone counts
// as removed. No token, response body or identifier is logged or returned.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = code => { const error = new Error(code); error.code = code; throw error; };

function createAccountWipeIdentity({ tenantId, getToken, fetch: request = globalThis.fetch, timeoutMs = 5000 }) {
    if (typeof tenantId !== 'string' || !UUID.test(tenantId) || typeof getToken !== 'function' || typeof request !== 'function')
        fail('account_wipe_identity_configuration_invalid');
    return Object.freeze({
        async remove(subjectKey) {
            if (typeof subjectKey !== 'string') fail('account_wipe_identity_target_invalid');
            const [subjectTenant, objectId, ...rest] = subjectKey.split(':');
            if (rest.length || !UUID.test(subjectTenant || '') || !UUID.test(objectId || '')) fail('account_wipe_identity_target_invalid');
            if (subjectTenant !== tenantId) fail('account_wipe_identity_wrong_tenant');
            let response;
            try {
                const token = await getToken();
                if (typeof token !== 'string' || !token) throw new Error();
                response = await request(`https://graph.microsoft.com/v1.0/users/${objectId}`, {
                    method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
                    headers: { Authorization: `Bearer ${token}` } });
            } catch (_) { fail('account_wipe_identity_unavailable'); }
            try { await response.body?.cancel?.(); } catch (_) { /* Body is not needed. */ }
            if (response.status === 204) return Object.freeze({ removed: true, alreadyGone: false });
            if (response.status === 404) return Object.freeze({ removed: true, alreadyGone: true });
            if ([401, 403].includes(response.status)) fail('account_wipe_identity_forbidden');
            fail('account_wipe_identity_unavailable');
        }
    });
}

module.exports = { createAccountWipeIdentity };
