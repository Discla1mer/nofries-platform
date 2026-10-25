'use strict';
const { equal } = require('../appLifecycle/dashboardRuntimeRecords');

// The existing authority container remains Reader-only. The starter container
// contains only newly reserved scopes. A conflicting subject is never selected
// by precedence; shared immutable legal archives must have identical bytes.
function combineCustomerRecords(legacy, starter) {
    const result = { readEmailProof: legacy.readEmailProof, createEmailProof: legacy.createEmailProof };
    for (const name of ['readSubject', 'readTerms', 'readTermsOffer', 'readSchedule']) {
        result[name] = async (...args) => {
            const [a, b] = await Promise.all([legacy[name](...args), starter[name](...args)]);
            if (a !== null && b !== null && (name === 'readSubject' || !equal(a, b))) throw new Error('customer_authority_conflict');
            return a ?? b;
        };
    }
    return Object.freeze(result);
}
module.exports = { combineCustomerRecords };
