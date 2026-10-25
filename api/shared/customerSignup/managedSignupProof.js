'use strict';

const { fields, copy, freeze, uuid, subject, digest } = require('../appLifecycle/dashboardRuntimeRecords');
const { verifiedSnapshot } = require('./organisationSetupBinding');
const { workEmail } = require('../organisationSetup');

// Trusted composition supplies this record from an authenticated external
// session, never from the POST body. Keep provider provenance distinct from the
// legacy application OTP record and commit the immutable subject into its hash.
function starterSetupSnapshot(raw, requestId) {
    if (raw?.source !== 'external-id-signup') return verifiedSnapshot(raw, requestId);
    const r = fields(copy(raw, 8192), ['schemaVersion', 'source', 'requestId', 'subjectKey', 'providerKey',
        'authenticationSha256', 'email', 'organisationName', 'accountType', 'createdAt', 'verifiedAt', 'expiresAt']);
    uuid(r.requestId); subject(r.subjectKey); digest(r.providerKey); digest(r.authenticationSha256);
    if (r.schemaVersion !== 1 || r.requestId !== requestId || r.email !== workEmail(r.email) ||
        !['company', 'consultant'].includes(r.accountType) || typeof r.organisationName !== 'string' ||
        !r.organisationName || r.organisationName.length > 120 || r.organisationName !== r.organisationName.trim().normalize('NFC') ||
        /[\u0000-\u001f\u007f-\u009f<>]/u.test(r.organisationName) ||
        ![r.createdAt, r.verifiedAt, r.expiresAt].every(Number.isSafeInteger) || r.createdAt < 0 ||
        r.verifiedAt !== r.createdAt || r.expiresAt <= r.verifiedAt || r.expiresAt > r.verifiedAt + 3600000) {
        throw new Error('managed_signup_proof_invalid');
    }
    return freeze(r);
}
module.exports = { starterSetupSnapshot };
