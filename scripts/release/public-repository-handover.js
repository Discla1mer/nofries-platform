'use strict';

// Inactive, offline migration contract. This code cannot authenticate its own
// inputs and never authorizes deployment. A separately reviewed controller must
// collect REST responses and protect expected tuples/digests independently of
// candidate source, PR artifacts, workflow inputs and the evidence under test.
const { createHash } = require('node:crypto');

const PUBLIC_REPOSITORY = Object.freeze({ full_name: 'Discla1mer/nofries-platform', id: 1433679464 });
const CI_PATH = '.github/workflows/ci.yml';
const CI_WORKFLOW_SHA256 = 'f6abeb1daf69c8b4f8ea200bf7efa0d188dc8bb82ee8b36451d918155ca4e015';
const CI_SOURCES = Object.freeze({
    'package.json': 'ae256ac8c889e2c6dabc04c5a554b6b81892bae178a8f8799b18e010851dfb1c',
    'scripts/ci-journey-sequencer.js': '0cfe1e2f72d1694b604621b65d85ab7617032dcc985b8f13ce666f2c65f00306',
    'scripts/ci-journey-order.js': 'b09a4f16700a0ea6558b7208375e9d347f6f6a6e23b69922ce63491d7d8d9d81',
    'scripts/check-dependency-audit.js': '5de53625d16faed5ff9269ae6e6c86035b31210374ecc1af91ab4f5218374e4a'
});
const CI_STEPS = Object.freeze({
    application: Object.freeze(['Verify pinned local dependencies',
        'Run npm ci --ignore-scripts --omit=optional --audit=false', 'Run npm run verify',
        'Run npm run eval:prospect:promptfoo', 'Build runtime package and verify install closure']),
    postgres: Object.freeze(['Run npm ci --ignore-scripts --omit=optional --audit=false',
        'Apply migrations twice and run native tenant-isolation tests']),
    dependencies: Object.freeze(['Audit both governed closures with the unchanged exact temporary disposition'])
});
const ROLES = Object.freeze(['ci', 'liveEval', 'candidate', 'rollbackOrigin',
    'recoveryOrigin', 'recoveryController', 'recoveryWitness']);
const COMPONENTS = Object.freeze({ appService: 'candidateApp', legacyFunction: 'candidateLegacyFunction', static: 'candidateStatic' });
const MAX_OBSERVATION_MS = 10 * 60 * 1000;
const MAX_CI_AGE_MS = 24 * 60 * 60 * 1000;

function insist(condition, code) {
    if (!condition) throw new Error(`public_handover_refused:${code}`);
}
function record(value, code) {
    insist(value !== null && typeof value === 'object' && !Array.isArray(value), code);
    return value;
}
function keys(value, names, code) {
    record(value, code);
    insist(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...names].sort()), code);
}
function id(value) { return Number.isSafeInteger(value) && value > 0; }
function hash(value, size) { return typeof value === 'string' && new RegExp(`^[0-9a-f]{${size}}$`).test(value) && !/^0+$/.test(value); }
function sha256(bytes) {
    insist(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 256 * 1024 * 1024, 'bytes');
    return createHash('sha256').update(bytes).digest('hex');
}
function digest(bytes, expected, code) {
    insist(hash(expected, 64) && sha256(bytes) === expected, code);
}
function time(value) {
    insist(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value), 'time');
    const result = Date.parse(value);
    insist(Number.isFinite(result) && new Date(result).toISOString() === value.replace('Z', '.000Z'), 'time');
    return result;
}
function fresh(collectedAt, now) {
    insist(Number.isSafeInteger(now) && now > 0, 'clock');
    const collected = time(collectedAt);
    insist(collected <= now && now - collected <= MAX_OBSERVATION_MS, 'stale_observation');
    return collected;
}
function runTimes(run) {
    const created = time(run.created_at), updated = time(run.updated_at);
    insist(created <= updated, 'run_time');
    const started = run.run_started_at === null ? null : time(run.run_started_at);
    insist(started === null ? run.role === 'recoveryWitness' : created <= started && started <= updated, 'run_time');
    return { created, started, updated };
}
function stage(value) { insist(['first-public', 'public'].includes(value), 'stage'); }
function repositoryFor(role, expected) {
    stage(expected.stage);
    insist(ROLES.includes(role), 'role');
    if (role === 'rollbackOrigin' && expected.stage === 'first-public') {
        const legacy = record(expected.legacyRepository, 'legacy_repository');
        insist(id(legacy.id) && legacy.id !== PUBLIC_REPOSITORY.id && typeof legacy.full_name === 'string'
            && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(legacy.full_name)
            && legacy.full_name.toLowerCase() !== PUBLIC_REPOSITORY.full_name.toLowerCase(), 'legacy_repository');
        return legacy;
    }
    return PUBLIC_REPOSITORY;
}
function repository(observed, expected) {
    record(observed, 'repository');
    insist(observed.full_name === expected.full_name && observed.id === expected.id && observed.fork === false, 'repository');
}

function checkRun(role, observed, binding, expected) {
    record(observed, 'run'); record(binding, 'binding');
    insist(observed.role === role, 'role');
    const repo = repositoryFor(role, expected);
    repository(observed.repository, repo); repository(observed.head_repository, repo);
    insist(id(binding.runId) && id(binding.runAttempt) && id(binding.workflowId) && id(binding.runNumber)
        && hash(binding.sha, 40), 'binding');
    insist(observed.id === binding.runId && observed.run_attempt === binding.runAttempt
        && observed.workflow_id === binding.workflowId && observed.run_number === binding.runNumber, 'run_identity');
    insist(typeof binding.workflowPath === 'string' && /^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/.test(binding.workflowPath)
        && (role !== 'ci' || binding.workflowPath === CI_PATH), 'workflow_binding');
    insist(observed.head_sha === binding.sha && observed.head_branch === 'main'
        && observed.path === binding.workflowPath && observed.event === (role === 'ci' ? 'push' : 'workflow_dispatch')
        && Array.isArray(observed.pull_requests) && observed.pull_requests.length === 0, 'run_source');
    // CI may have a reviewed rerun; release, rollback and every recovery role are one-shot.
    insist(role === 'ci' || binding.runAttempt === 1, 'attempt');
    if (['ci', 'liveEval', 'rollbackOrigin'].includes(role)) {
        insist(observed.status === 'completed' && observed.conclusion === 'success', 'run_success');
    } else if (role === 'recoveryOrigin') {
        insist(observed.status === 'completed' && ['failure', 'cancelled', 'timed_out'].includes(observed.conclusion), 'origin_state');
    } else if (role === 'recoveryWitness') {
        insist(['queued', 'pending', 'requested', 'waiting'].includes(observed.status) && observed.conclusion === null, 'witness_state');
    } else {
        insist(observed.status === 'in_progress' && observed.conclusion === null, 'controller_state');
    }
    runTimes(observed);
    return observed;
}

function checkSource(evidence, expected) {
    record(evidence, 'source');
    insist(hash(expected.sha, 40) && hash(expected.treeSha, 40), 'source_binding');
    repository(evidence.repository, PUBLIC_REPOSITORY);
    insist(evidence.repository.default_branch === 'main' && evidence.repository.archived === false
        && evidence.repository.disabled === false, 'repository_state');
    for (const branch of [evidence.before, evidence.after]) {
        insist(branch?.name === 'main' && branch.protected === true && branch.commit?.sha === expected.sha
            && branch.commit?.tree?.sha === expected.treeSha, 'protected_source');
    }
    // The protected collector must build this inventory from exact commit blobs,
    // without private parents, overlays, untracked files, symlinks or Git replace refs.
    digest(evidence.inventoryBytes, expected.inventorySha256, 'source_inventory');
}

function checkCi(evidence, expected) {
    record(evidence, 'ci');
    insist(expected.ci.sha === expected.source.sha, 'ci_source');
    const collected = fresh(evidence.collectedAt, expected.now);
    digest(evidence.workflowBytes, CI_WORKFLOW_SHA256, 'unreviewed_ci_workflow');
    keys(evidence.sourceBytes, Object.keys(CI_SOURCES), 'ci_sources');
    for (const [path, expectedDigest] of Object.entries(CI_SOURCES)) digest(evidence.sourceBytes[path], expectedDigest, 'ci_source_bytes');
    for (const run of [evidence.run, evidence.attempt, evidence.runAfter]) {
        checkRun('ci', run, expected.ci, expected);
        insist(runTimes(run).updated <= collected, 'ci_run_time');
    }
    for (const page of [evidence.listing, evidence.listingAfter]) {
        insist(id(page?.total_count) && page.workflow_runs?.length === 1, 'ci_listing');
        checkRun('ci', page.workflow_runs[0], expected.ci, expected);
    }
    const page = evidence.jobs, jobNames = Object.keys(CI_STEPS), names = new Set(), ids = new Set();
    insist(page?.total_count === jobNames.length && page.jobs?.length === jobNames.length, 'ci_jobs');
    for (const job of page.jobs) {
        insist(id(job.id) && !ids.has(job.id) && Object.hasOwn(CI_STEPS, job.name) && !names.has(job.name), 'ci_duplicate_job');
        ids.add(job.id); names.add(job.name);
        insist(job.run_id === expected.ci.runId && job.run_attempt === expected.ci.runAttempt
            && job.head_sha === expected.source.sha && job.status === 'completed' && job.conclusion === 'success', 'ci_job_identity');
        const started = time(job.started_at), completed = time(job.completed_at);
        const runTime = runTimes(evidence.run);
        insist(runTime.started <= started && started <= completed && completed <= runTime.updated
            && completed <= collected && expected.now - completed <= MAX_CI_AGE_MS, 'ci_job_time');
        insist(Array.isArray(job.steps) && job.steps.length > 0 && job.steps.length <= 200, 'ci_steps');
        const steps = new Map(), numbers = new Set();
        for (const step of job.steps) {
            insist(typeof step.name === 'string' && step.name.length > 0 && !steps.has(step.name)
                && id(step.number) && !numbers.has(step.number) && step.status === 'completed'
                && ['success', 'skipped'].includes(step.conclusion), 'ci_step');
            steps.set(step.name, step); numbers.add(step.number);
        }
        for (const name of CI_STEPS[job.name]) insist(steps.get(name)?.conclusion === 'success', 'ci_coverage');
    }
}

function checkRollback(evidence, expected) {
    record(evidence, 'rollback');
    const binding = expected.rollback;
    checkRun('rollbackOrigin', evidence.producer, binding, expected);
    checkRun('rollbackOrigin', evidence.producerAfter, binding, expected);
    insist(binding.sha !== expected.source.sha, 'rollback_same_source');
    insist(evidence.sourceRole === 'candidate' && evidence.mode === 'exact-artifact', 'rollback_role');
    const repo = repositoryFor('rollbackOrigin', expected);
    repository(evidence.repository, repo);
    const listing = evidence.listing;
    insist(listing?.total_count === 1 && listing.artifacts?.length === 1, 'rollback_artifact_listing');
    const artifact = listing.artifacts[0];
    insist(id(binding.artifactId) && artifact.id === binding.artifactId && artifact.expired === false
        && typeof binding.artifactName === 'string' && binding.artifactName.length > 0 && binding.artifactName.length <= 200
        && artifact.name === binding.artifactName
        && artifact.workflow_run?.id === binding.runId && artifact.workflow_run?.head_sha === binding.sha
        && artifact.workflow_run?.repository_id === repo.id && artifact.workflow_run?.head_repository_id === repo.id
        && artifact.workflow_run?.head_branch === 'main', 'rollback_artifact_identity');
    insist(artifact.digest === `sha256:${binding.artifactSha256}`, 'rollback_artifact_digest');
    digest(evidence.artifactBytes, binding.artifactSha256, 'rollback_artifact_bytes');
    insist(artifact.size_in_bytes === evidence.artifactBytes.length && time(artifact.created_at) <= expected.now
        && time(artifact.expires_at) > expected.now, 'rollback_artifact_lifetime');
    digest(evidence.bundleBytes, binding.bundleSha256, 'rollback_bundle');
    digest(evidence.manifestBytes, binding.manifestSha256, 'rollback_manifest');
    let manifest;
    try { manifest = JSON.parse(evidence.manifestBytes.toString('utf8')); } catch { insist(false, 'rollback_manifest_json'); }
    insist(manifest.schemaVersion === 2 && manifest.releaseFor?.releaseSha === binding.sha
        && manifest.releaseFor?.runId === String(binding.runId) && manifest.releaseFor?.runAttempt === '1', 'rollback_manifest_producer');
    keys(evidence.componentBytes, Object.keys(COMPONENTS), 'rollback_components');
    keys(evidence.embeddedIdentities, Object.keys(COMPONENTS), 'rollback_identities');
    keys(binding.components, Object.keys(COMPONENTS), 'rollback_component_bindings');
    for (const [component, manifestKey] of Object.entries(COMPONENTS)) {
        insist(manifest.sha256?.[manifestKey] === binding.components[component], 'rollback_candidate_digest');
        digest(evidence.componentBytes[component], binding.components[component], 'rollback_component_bytes');
        const identity = evidence.embeddedIdentities[component];
        insist(identity.schemaVersion === 2 && identity.releaseSha === binding.sha
            && identity.runId === String(binding.runId), 'rollback_embedded_identity');
    }
    // This never republishes the artifact or relabels a private producer as public.
    return Object.freeze({ repository: repo.full_name, sourceRole: 'candidate', mode: 'exact-artifact' });
}

function checkRecovery(evidence, expected) {
    record(evidence, 'recovery');
    const collected = fresh(evidence.collectedAt, expected.now);
    const roles = ['recoveryOrigin', 'recoveryController', 'recoveryWitness'];
    const bindings = expected.recovery;
    keys(bindings, roles, 'recovery_bindings');
    insist(new Set(roles.map(role => bindings[role].runId)).size === 3, 'recovery_distinct');
    insist(bindings.recoveryController.sha === bindings.recoveryWitness.sha
        && bindings.recoveryController.sha === expected.source.sha, 'recovery_controller_source');
    insist(bindings.recoveryController.workflowId === bindings.recoveryOrigin.workflowId
        && bindings.recoveryController.workflowId === bindings.recoveryWitness.workflowId, 'recovery_workflow');
    insist(bindings.recoveryController.runNumber === bindings.recoveryOrigin.runNumber + 1
        && bindings.recoveryWitness.runNumber === bindings.recoveryController.runNumber + 1, 'recovery_sequence');
    for (const phase of ['before', 'after']) {
        keys(evidence[phase], roles, 'recovery_snapshots');
        for (const role of roles) {
            checkRun(role, evidence[phase][role], bindings[role], expected);
            insist(runTimes(evidence[phase][role]).updated <= collected, 'recovery_run_time');
        }
        const snapshot = evidence[phase];
        insist(typeof bindings.recoveryWitness.displayTitle === 'string' && bindings.recoveryWitness.displayTitle.length > 0
            && snapshot.recoveryWitness.display_title === bindings.recoveryWitness.displayTitle, 'recovery_witness_target');
        insist(time(snapshot.recoveryController.run_started_at) > time(snapshot.recoveryOrigin.updated_at)
            && time(snapshot.recoveryWitness.created_at) >= time(snapshot.recoveryController.run_started_at), 'recovery_order');
        const absence = evidence.attempt2Absence?.[phase];
        keys(absence, roles, 'recovery_absence');
        for (const role of roles) {
            const item = absence[role];
            repository(item.repository, PUBLIC_REPOSITORY);
            insist(item.role === role && item.runId === bindings[role].runId && item.attempt === 2
                && item.httpStatus === 404, 'recovery_repeated');
        }
    }
    for (const role of roles) {
        digest(evidence.workflowBytes[role], bindings[role].workflowSha256, 'recovery_workflow_digest');
        const before = evidence.before[role], after = evidence.after[role];
        for (const field of ['status', 'conclusion', 'created_at', 'run_started_at', 'display_title']) {
            insist(before[field] === after[field], 'recovery_changed');
        }
        insist(time(after.updated_at) >= time(before.updated_at), 'recovery_changed');
    }
}

function inspectHandover(evidence, expected) {
    record(evidence, 'evidence'); record(expected, 'expected'); stage(expected.stage);
    fresh(evidence.collectedAt, expected.now);
    checkSource(evidence.source, expected.source);
    checkCi(evidence.ci, expected);
    for (const role of ['candidate', 'liveEval']) {
        insist(expected[role].sha === expected.source.sha, 'release_source');
        checkRun(role, evidence[role], expected[role], expected);
        insist(runTimes(evidence[role]).updated <= time(evidence.collectedAt), 'release_run_time');
        digest(evidence.workflowBytes[role], expected[role].workflowSha256, 'workflow_digest');
    }
    const rollback = checkRollback(evidence.rollback, expected);
    return Object.freeze({ schemaVersion: 1, mode: 'offline-design-check', provenanceConsistent: true,
        deploymentAuthorized: false, rollback });
}

module.exports = { inspectHandover, checkSource, checkCi, checkRun, checkRollback, checkRecovery,
    PUBLIC_REPOSITORY, CI_SOURCES, CI_STEPS, CI_WORKFLOW_SHA256 };
