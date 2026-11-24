'use strict';

// Offline planning only. The caller must establish every fact server-side.
// A complete lookup counts distinct lifecycle organisations with the exact
// verified sign-in email, including prospects and accepted customers.
function decideServiceIntake(facts = {}) {
    if (facts?.contactRequested !== true) return 'no_action';
    if (facts.source !== 'dashboard' || facts.verifiedSignInEmail !== true ||
        facts.workspaceKind !== 'own_organisation' || facts.lookupComplete !== true) {
        return 'operator_review';
    }
    if (facts.exactMatchCount === 0) return 'create_prospect';
    if (facts.exactMatchCount === 1) return 'use_existing';
    return 'operator_review';
}

module.exports = { decideServiceIntake };
