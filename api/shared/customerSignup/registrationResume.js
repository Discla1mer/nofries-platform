'use strict';

// One-shot marker for an account-creation attempt that outlives its sign-in
// transaction. The provider has usually made the account by then, so the
// callback may restart ordinary sign-in once instead of showing a dead end.
// It is not an identifier and proves nothing: it only chooses between two
// unauthenticated redirects. SameSite=None because the provider's form_post
// callback is a cross-site POST, like the transaction cookie it stands in for.
const NAME = '__Host-nofries-external-creating';
const MAX_AGE_SECONDS = 60 * 60;
const RESUME_LOCATION = '/api/external-customer-auth/login';

const registrationResumeCookie = () => `${NAME}=1; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${MAX_AGE_SECONDS}`;
const clearRegistrationResumeCookie = () =>
    `${NAME}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
// Exactly one well-formed copy. Anything else is treated as absent.
function hasRegistrationResumeMarker(header) {
    const copies = String(header || '').split(';').map(part => part.trim()).filter(part => part.startsWith(NAME + '='));
    return copies.length === 1 && copies[0] === NAME + '=1';
}

module.exports = { RESUME_LOCATION, registrationResumeCookie, clearRegistrationResumeCookie, hasRegistrationResumeMarker };
