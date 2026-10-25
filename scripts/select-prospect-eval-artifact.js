'use strict';

const fs = require('node:fs');

function selectProspectEvalArtifact({ outcome, runId, attempt, releaseSha, listing = null }) {
    if (!/^[1-9][0-9]*$/.test(String(runId)) || !/^[1-9][0-9]*$/.test(String(attempt)) ||
        !/^[0-9a-f]{40}$/.test(String(releaseSha))) throw new Error('prospect_eval_artifact_identity_invalid');
    if (outcome === 'failure' || outcome === 'skipped') {
        if (listing !== null) throw new Error('prospect_eval_artifact_listing_unexpected');
        return `prospect-live-eval-failed-${runId}-${attempt}`;
    }
    if (outcome !== 'success' || !listing || typeof listing !== 'object' || Array.isArray(listing) ||
        !Number.isSafeInteger(listing.total_count) || !Array.isArray(listing.artifacts) ||
        listing.total_count !== listing.artifacts.length || listing.total_count > 1) {
        throw new Error('prospect_eval_artifact_listing_invalid');
    }
    const canonical = `prospect-live-eval-${runId}`;
    if (listing.artifacts.length === 0) return canonical;
    const existing = listing.artifacts[0];
    if (!existing || existing.name !== canonical || existing.expired !== false ||
        !Number.isSafeInteger(existing.id) || existing.id < 1 ||
        !/^sha256:[0-9a-f]{64}$/.test(String(existing.digest)) ||
        existing.workflow_run?.id !== Number(runId) || existing.workflow_run?.head_sha !== releaseSha) {
        throw new Error('prospect_eval_artifact_existing_invalid');
    }
    return `prospect-live-eval-success-${runId}-${attempt}`;
}

function runCli(argv = process.argv.slice(2)) {
    if (argv.length !== 4 && argv.length !== 5) throw new Error('prospect_eval_artifact_arguments_invalid');
    const [outcome, runId, attempt, releaseSha, path] = argv;
    if ((outcome === 'success') !== (argv.length === 5)) throw new Error('prospect_eval_artifact_arguments_invalid');
    const listing = path ? JSON.parse(fs.readFileSync(path, 'utf8')) : null;
    const name = selectProspectEvalArtifact({ outcome, runId, attempt, releaseSha, listing });
    process.stdout.write(`artifact_name=${name}\n`);
    return name;
}

if (require.main === module) {
    try { runCli(); }
    catch (_) { console.error('Prospect evaluation artifact evidence unavailable.'); process.exitCode = 1; }
}

module.exports = { selectProspectEvalArtifact, runCli };
