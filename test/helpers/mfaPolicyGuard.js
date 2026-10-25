'use strict';
// Unchanged pure guard from the private provisioning CLI; no operational configuration.
function fail() { throw new Error('customer_setup_provisioning_blocked'); }
function createMfaPolicyGuard(provider, context) {
    if (typeof provider?.verifyMfaPolicy !== 'function' || context !== 'c1') fail();
    return async () => {
        try { if (await provider.verifyMfaPolicy(context) !== true) fail(); }
        catch (_) { fail(); }
    };
}
module.exports = { createMfaPolicyGuard };
