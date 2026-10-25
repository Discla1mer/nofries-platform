const committedManifest = require('./releaseManifest.json');

function validateReleaseManifest(candidate) {
    if (!candidate || candidate.schemaVersion !== 2) {
        throw new Error('Release manifest schemaVersion must be 2.');
    }

    const releaseSha = String(candidate.releaseSha || '').trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(releaseSha)) {
        throw new Error('Release manifest releaseSha must be a full 40-character Git commit SHA.');
    }

    const runId = String(candidate.runId || '').trim();
    if (!/^\d+$/.test(runId)) {
        throw new Error('Release manifest runId must be a non-empty numeric Actions run ID.');
    }

    const rawRunAttempt = candidate.runAttempt;
    let runAttempt = null;
    if (rawRunAttempt !== undefined && rawRunAttempt !== null) {
        runAttempt = String(rawRunAttempt).trim();
        if (!/^[1-9][0-9]*$/.test(runAttempt)) {
            throw new Error('Release manifest runAttempt must be a positive numeric Actions run attempt.');
        }
    }

    const identity = {
        schemaVersion: 2,
        releaseSha,
        runId
    };
    if (runAttempt !== null) identity.runAttempt = runAttempt;
    return Object.freeze(identity);
}

function getReleaseIdentity(candidate = committedManifest) {
    try {
        return validateReleaseManifest(candidate);
    } catch {
        return null;
    }
}

module.exports = {
    getReleaseIdentity,
    validateReleaseManifest
};

