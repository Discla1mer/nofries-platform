'use strict';

// Scoring v2 (#399), item 4: the one way to pick a NIST crosswalk for an NCSC
// result. Selection is by the result's exact six-field profileRef, never by
// profileVersion alone. The v2 crosswalk resolves only while
// NOFRIES_NCSC_PROFILE_V2 is exactly 'true'. Anything else fails closed.
const { ACCEPTED_NCSC_CONTEXT, NCSC_V2_CONTEXT, readableNcscProfileContext } = require('./ncscProfileSet');
const { createNistNcscCrosswalk, NistNcscCrosswalkError } = require('./nistNcscCrosswalk');
const { createNistNcscCrosswalkV2 } = require('./nistNcscCrosswalkV2');

const REF_FIELDS = Object.freeze(['frameworkId', 'frameworkVersion', 'profileId', 'profileVersion',
    'catalogueSha256', 'sourceCatalogueSha256']);

/** The fixed crosswalk whose source profile is exactly `profileRef`. Throws
 * NistNcscCrosswalkError('crosswalk_profile_unknown') for any other reference,
 * including the v2 profile while its flag is off.
 */
function nistNcscCrosswalkForProfile(profileRef, env = process.env) {
    const context = readableNcscProfileContext(profileRef, env);
    let crosswalk = null;
    if (context === ACCEPTED_NCSC_CONTEXT) crosswalk = createNistNcscCrosswalk();
    else if (context === NCSC_V2_CONTEXT) crosswalk = createNistNcscCrosswalkV2();
    if (!crosswalk) throw new NistNcscCrosswalkError('crosswalk_profile_unknown');
    if (REF_FIELDS.some((field) => crosswalk.fromProfileRef[field] !== context.profileRef[field])) {
        throw new NistNcscCrosswalkError('crosswalk_profile_mismatch');
    }
    return crosswalk;
}

module.exports = { nistNcscCrosswalkForProfile };
