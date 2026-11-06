'use strict';
const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { createSignupWriterFence, CONTRACT } = require('../api/shared/customerSignup/signupWriterFence');
function signupWriterFence(env, container, external) {
    const selected = env.NOFRIES_SIGNUP_RESET_WRITER_CONTRACT;
    if (selected === undefined || selected === '') return null;
    if (selected !== CONTRACT) throw new Error('signup_writer_fence_configuration_invalid');
    // Only the External ID starter source is eligible for the empty-signup reset.
    if (!external) return null;
    return createSignupWriterFence({ container, scopeId: hash({ account: env.AZURE_STORAGE_ACCOUNT_NAME,
        container: env.NOFRIES_STARTER_AUTHORITY_CONTAINER, writerContract: CONTRACT }) });
}
module.exports = { signupWriterFence };
