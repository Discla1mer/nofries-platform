'use strict';

const { createHash } = require('node:crypto');
const { cookieToken, setupReferenceKey, workEmail } = require('../organisationSetup');
const { canonicalDigest } = require('../appLifecycle/dashboardOnboardingDomain');
const { BrowserAuthError } = require('../browserAuth');
const { copy, freeze } = require('../appLifecycle/dashboardRuntimeRecords');

// A fresh mailbox proof supplements the invitation capability. It never creates
// an identity, membership, legal acceptance or operator permission.
function createVerifiedSetupEmailReader({ store, now = Date.now }) {
    const invalid = () => { throw new BrowserAuthError(401, 'browser_auth_email_verification_required'); };
    async function read(key, expectedId, complete = false) {
        if (!/^requests\/[a-f0-9]{64}$/.test(key)) invalid();
        const loaded = await store.load(key), r = loaded?.record;
        if (!r || r.schemaVersion !== 1 || r.requestId !== expectedId || r.status !== 'verified' || r.codeHash !== null ||
            ![r.createdAt, r.verifiedAt, r.codeExpiresAt, r.expiresAt, r.attempts].every(Number.isSafeInteger) ||
            r.createdAt < 0 || r.verifiedAt < r.createdAt || r.verifiedAt > now() || r.verifiedAt >= r.codeExpiresAt ||
            r.codeExpiresAt !== r.createdAt + 600000 || r.expiresAt !== r.createdAt + 86400000 || r.expiresAt <= now() ||
            r.attempts < 0 || r.attempts >= 5 || r.email !== workEmail(r.email) ||
            await store.load(key.replace(/^requests\//, 'detached/'))) invalid();
        if (r.expiresAt <= now()) invalid();
        return complete ? freeze(copy(r, 8192)) : { requestId: r.requestId, email: r.email, proofDigest: canonicalDigest(r) };
    }
    async function resolve(context, email) {
        if (!context || Object.keys(context).sort().join(',') !== 'email,proofDigest,requestId' || context.email !== email) invalid();
        const reference = (await store.load(setupReferenceKey(context.requestId)))?.record;
        if (!reference || reference.requestId !== context.requestId || reference.expiresAt <= now()) invalid();
        const actual = await read(reference.requestKey, context.requestId, true);
        if (actual.email !== email || canonicalDigest(actual) !== context.proofDigest || actual.expiresAt <= now()) invalid();
        return actual;
    }
    return Object.freeze({
        resolve,
        async begin(cookieHeader) {
            const token = cookieToken(cookieHeader); if (!token) return null;
            const key = 'requests/' + createHash('sha256').update(token).digest('hex');
            const record = (await store.load(key))?.record;
            if (!record || record.status !== 'verified' || record.expiresAt <= now()) return null;
            // Leaving setup retains its cookie for concurrent-tab safety. Treat
            // that abandoned pointer as absent when starting independent login;
            // the callback still requires its own invitation or durable proof.
            // read() rechecks detachment so a concurrent leave fails closed.
            if (await store.load(key.replace(/^requests\//, 'detached/'))) return null;
            return read(key, record.requestId);
        },
        async verify(context, email) {
            await resolve(context, email);
            return true;
        }
    });
}
module.exports = { createVerifiedSetupEmailReader };
