'use strict';
const { isCustomerMfaPolicy } = require('./customerMfaPolicy');

// Server-side, fixed Graph origin. No caller-controlled URL or returned tokens.
function createEntraCustomerGraph({ credential, policyId, fetch: request = globalThis.fetch }) {
    if (!/^[a-f0-9-]{36}$/.test(policyId)) throw new Error('customer_mfa_policy_invalid');
    async function graph(path, body) {
        try {
            const token = await credential.getToken('https://graph.microsoft.com/.default');
            if (!token?.token) throw new Error();
            const response = await request(`https://graph.microsoft.com/v1.0/${path}`, {
                method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(5000),
                headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' },
                ...(body ? { body: JSON.stringify(body) } : {})
            });
            if (!response.ok) throw new Error();
            const reader = response.body.getReader(); let size = 0; const chunks = [];
            try { for (;;) { const { done, value } = await reader.read(); if (done) break;
                size += value.length; if (size > 65536) throw new Error(); chunks.push(Buffer.from(value)); } }
            finally { await reader.cancel(); }
            return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (_) { throw new Error('customer_graph_unavailable'); }
    }
    return Object.freeze({
        async verifyMfaPolicy(context) {
            const p = await graph(`identity/conditionalAccess/policies/${policyId}`);
            return isCustomerMfaPolicy(p, policyId, context);
        },
        async findGuestsByEmail(email) {
            const filter = encodeURIComponent(`mail eq '${email.replace(/'/g, "''")}'`);
            const r = await graph(`users?$filter=${filter}&$select=id,mail,userType&$top=2`);
            if (!Array.isArray(r.value) || r['@odata.nextLink']) throw new Error('customer_graph_unavailable');
            return r.value.map(v => ({ id: v.id, mail: v.mail, userType: v.userType }));
        },
        async findUsersByEmail(email) {
            if (typeof email !== 'string' || email !== email.trim().toLowerCase() || email.length > 254 ||
                !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('customer_graph_unavailable');
            const escaped = email.replace(/'/g, "''");
            const filter = encodeURIComponent(`mail eq '${escaped}' or userPrincipalName eq '${escaped}' or ` +
                `otherMails/any(x:x eq '${escaped}') or proxyAddresses/any(x:x eq 'SMTP:${escaped}')`);
            const r = await graph(`users?$filter=${filter}&$select=id,mail,userPrincipalName,otherMails,proxyAddresses,userType,accountEnabled&$top=2`);
            if (!Array.isArray(r.value) || r.value.length > 1 || r['@odata.nextLink']) throw new Error('customer_graph_unavailable');
            return r.value.map(v => {
                if (!v || v.accountEnabled !== true || !['Guest', 'Member'].includes(v.userType) ||
                    !Array.isArray(v.otherMails) || !Array.isArray(v.proxyAddresses)) throw new Error('customer_graph_unavailable');
                const addresses = [v.mail, v.userPrincipalName, ...v.otherMails,
                    ...v.proxyAddresses.filter(a => typeof a === 'string' && /^smtp:/i.test(a)).map(a => a.slice(5))];
                if (!addresses.some(a => typeof a === 'string' && a.toLowerCase() === email)) throw new Error('customer_graph_unavailable');
                // The verified signup mailbox can be an alias, but the authority
                // is always bound to this one immutable enabled directory object.
                return { id: v.id, mail: email, userType: v.userType };
            });
        },
        async createInvitation(body) {
            const r = await graph('invitations', body);
            // Fetch the exact invited object: invitation responses do not
            // guarantee the selected mail/userType projection.
            const v = await graph(`users/${encodeURIComponent(r.invitedUser?.id)}?$select=id,mail,userType`);
            return { status: r.status, invitedUser: { id: v.id, mail: v.mail, userType: v.userType } };
        }
    });
}
module.exports = { createEntraCustomerGraph };
