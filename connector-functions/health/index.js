const { API_SECURITY_HEADERS } = require('../sharedRuntime')('securityHeaders');
const { getReleaseIdentity } = require('../sharedRuntime')('releaseIdentity');

module.exports = async function health(context, req, dependencies = {}) {
    const resolveReleaseIdentity = typeof dependencies.getReleaseIdentity === 'function'
        ? dependencies.getReleaseIdentity
        : getReleaseIdentity;
    const releaseIdentity = resolveReleaseIdentity();
    const ready = Boolean(releaseIdentity && /^[1-9][0-9]*$/.test(releaseIdentity.runAttempt));
    context.res = {
        status: ready ? 200 : 503,
        headers: Object.assign({}, API_SECURITY_HEADERS, {
            'Cache-Control': 'private, no-store, max-age=0',
            'Content-Type': 'application/json; charset=utf-8'
        }),
        body: ready
            ? {
                service: 'nofries-agent-connector',
                status: 'ready',
                releaseSha: releaseIdentity.releaseSha,
                releaseRunId: releaseIdentity.runId,
                releaseRunAttempt: releaseIdentity.runAttempt
            }
            : {
                service: 'nofries-agent-connector',
                status: 'unavailable',
                code: 'release_identity_unavailable'
            }
    };
};

