'use strict';

const base = require('./tenantAccess');

const ROLE_CAPABILITIES = Object.freeze(Object.fromEntries(
    Object.entries(base.ROLE_CAPABILITIES).map(([role, capabilities]) => [
        role,
        Object.freeze(withProofIssue(capabilities))
    ])
));

function resolveTenantAccess(identity, env = process.env) {
    const access = base.resolveTenantAccess(identity, env);
    if (!access || !access.user) return access;
    return Object.assign({}, access, {
        user: Object.assign({}, access.user, {
            capabilities: withProofIssue(access.user.capabilities)
        })
    });
}

function assertCapability(access, capability) {
    if (
        capability === 'proof:issue' &&
        access && access.allowed && access.user &&
        Array.isArray(access.user.capabilities) &&
        access.user.capabilities.includes('proof:approve')
    ) return;
    base.assertCapability(access, capability);
}

function withProofIssue(capabilities) {
    const values = Array.isArray(capabilities) ? capabilities.slice() : [];
    if (values.includes('proof:approve') && !values.includes('proof:issue')) {
        values.push('proof:issue');
    }
    return values;
}

module.exports = Object.assign({}, base, {
    ROLE_CAPABILITIES,
    assertCapability,
    resolveTenantAccess
});
