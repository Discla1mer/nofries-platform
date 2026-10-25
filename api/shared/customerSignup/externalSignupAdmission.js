'use strict';

const { reserveSetupGlobalBudget } = require('../organisationSetup');
const { subject, digest, hash, equal } = require('../appLifecycle/dashboardRuntimeRecords');
const fail = () => { throw new Error('external_signup_admission_unavailable'); };

function createExternalSignupAdmission({ store, permitStore, providerKey, now = Date.now }) {
    digest(providerKey);
    if (!store || !['load', 'create', 'replace'].every(key => typeof store[key] === 'function') ||
        !permitStore || permitStore === store || !['load', 'create'].every(key => typeof permitStore[key] === 'function') ||
        typeof now !== 'function') fail();
    function expected(subjectKey) {
        subject(subjectKey);
        // A retained idempotency permit, not an expiring authentication proof.
        // Never delete/refund it on uncertainty, logout, day rollover or retry.
        return { schemaVersion: 1, subjectKey, providerKey, expiresAt: Number.MAX_SAFE_INTEGER };
    }
    const keyFor = subjectKey => 'admissions/' + hash('nofries:external-signup-admission:v1\0' + providerKey + '\0' + subjectKey);
    async function present(key, value) {
        const saved = await permitStore.load(key);
        if (saved === null) return false;
        if (!saved || !equal(saved.record, value)) fail();
        return true;
    }
    return Object.freeze({
        async reserve(subjectKey) {
            const value = expected(subjectKey), key = keyFor(subjectKey);
            if (await present(key, value)) return;
            // The aggregate CAS reservation precedes even the permit write.
            // The same CAS also retains a bounded subject hash, so concurrent
            // callbacks and lost acknowledgements charge once within the day.
            await reserveSetupGlobalBudget(store, now(), key.slice('admissions/'.length));
            try { await permitStore.create(key, value); }
            catch { /* Only exact durable readback can reconcile a lost acknowledgement. */ }
            if (!await present(key, value)) fail();
        },
        async recheck(subjectKey) {
            const value = expected(subjectKey);
            if (!await present(keyFor(subjectKey), value)) fail();
        }
    });
}
module.exports = { createExternalSignupAdmission };
