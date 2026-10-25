'use strict';

const { createAccountPurposeReader } = require('./accountPurpose');

// Unmounted server composition. The existing reader owns current identity,
// account binding and explicit stable-ID purpose rechecks. These facts grant no
// authentication, profile/score permission, QA entitlement or Founder badge.
function createLunaAccountFactsReader(options) {
    const reader = createAccountPurposeReader(options);
    return Object.freeze({
        async read(cookieHeader) {
            const facts = await reader.read(cookieHeader);
            if (facts === null) return null;
            const kind = facts.purpose.reason !== 'explicit_assignment' ? null :
                facts.purpose.kind === 'genuine_customer' ? 'customer' :
                    facts.purpose.kind === 'verified_test' ? 'test' : null;
            return Object.freeze({
                accountId: facts.accountId,
                // The actual reader has no selected canonical join authority.
                // Reservation/preparation timestamps are not silent fallbacks.
                accountCreatedAt: null,
                // Luna's normalized provenance vocabulary is not an attestation.
                // The reader still requires a trusted enrollment producer; this
                // wrapper creates no assignments and accepts no raw-facts input.
                classification: Object.freeze(kind
                    ? { kind, source: 'verified_nofries_record' }
                    : { kind: 'unknown', source: 'unknown' }),
            });
        },
    });
}

module.exports = { createLunaAccountFactsReader };
