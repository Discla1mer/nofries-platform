'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { inspectHandover, checkRun, checkRecovery, PUBLIC_REPOSITORY, CI_SOURCES, CI_STEPS } =
    require('../scripts/release/public-repository-handover');

// Every run, source SHA, private repository ID and package below is synthetic.
// Read only the already-public CI command graph, so profile drift fails visibly.
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const root = path.resolve(__dirname, '..');
const repo = { ...PUBLIC_REPOSITORY, fork: false };
const legacyRepo = { full_name: 'synthetic-history/release-control', id: 201, fork: false };
const SOURCE_SHA = 'a'.repeat(40), PREVIOUS_SHA = 'b'.repeat(40), TREE_SHA = 'c'.repeat(40);
const NOW = Date.parse('2026-01-01T12:00:00Z');
const releaseWorkflow = Buffer.from('synthetic reviewed manual release controller');

function fixture(stage = 'first-public') {
    const binding = (runId, sha = SOURCE_SHA, workflowId = 501, runNumber = runId) => ({
        runId, runAttempt: 1, sha, workflowId, runNumber, workflowSha256: sha256(releaseWorkflow), workflowPath: '.github/workflows/synthetic-release.yml'
    });
    const expected = { stage, legacyRepository: { full_name: legacyRepo.full_name, id: legacyRepo.id }, now: NOW,
        source: { sha: SOURCE_SHA, treeSha: TREE_SHA, inventorySha256: sha256(Buffer.from('synthetic exact source inventory')) },
        ci: binding(101, SOURCE_SHA, 500), candidate: binding(102), liveEval: binding(103, SOURCE_SHA, 502),
        rollback: binding(104, PREVIOUS_SHA, 503),
        recovery: { recoveryOrigin: binding(111, PREVIOUS_SHA, 501, 20),
            recoveryController: binding(112, SOURCE_SHA, 501, 21), recoveryWitness: binding(113, SOURCE_SHA, 501, 22) }
    };
    expected.ci.workflowPath = '.github/workflows/ci.yml';
    expected.liveEval.workflowPath = '.github/workflows/synthetic-evaluation.yml';
    expected.recovery.recoveryWitness.displayTitle = 'Synthetic witness for 112';
    const run = (role, b) => ({
        role, id: b.runId, run_attempt: b.runAttempt, workflow_id: b.workflowId, run_number: b.runNumber,
        repository: { ...(role === 'rollbackOrigin' && stage === 'first-public' ? legacyRepo : repo) },
        head_repository: { ...(role === 'rollbackOrigin' && stage === 'first-public' ? legacyRepo : repo) },
        head_sha: b.sha, head_branch: 'main', pull_requests: [],
        path: b.workflowPath,
        event: role === 'ci' ? 'push' : 'workflow_dispatch',
        status: ['candidate', 'recoveryController'].includes(role) ? 'in_progress' : role === 'recoveryWitness' ? 'queued' : 'completed',
        conclusion: ['candidate', 'recoveryController', 'recoveryWitness'].includes(role) ? null : role === 'recoveryOrigin' ? 'failure' : 'success',
        created_at: '2026-01-01T11:40:00Z', run_started_at: '2026-01-01T11:41:00Z', updated_at: '2026-01-01T11:50:00Z',
        display_title: role === 'recoveryWitness' ? 'Synthetic witness for 112' : 'synthetic run'
    });
    const branch = () => ({ name: 'main', protected: true, commit: { sha: SOURCE_SHA, tree: { sha: TREE_SHA } } });
    const listing = () => ({ total_count: 1, workflow_runs: [run('ci', expected.ci)] });
    const evidence = { collectedAt: '2026-01-01T11:59:00Z',
        source: { repository: { ...repo, default_branch: 'main', archived: false, disabled: false },
            before: branch(), after: branch(), inventoryBytes: Buffer.from('synthetic exact source inventory') },
        ci: { collectedAt: '2026-01-01T11:59:00Z',
            workflowBytes: fs.readFileSync(path.join(root, '.github/workflows/ci.yml')),
            sourceBytes: Object.fromEntries(Object.keys(CI_SOURCES).map(name => [name, fs.readFileSync(path.join(root, name))])),
            run: run('ci', expected.ci), attempt: run('ci', expected.ci), runAfter: run('ci', expected.ci),
            listing: listing(), listingAfter: listing(), jobs: { total_count: Object.keys(CI_STEPS).length,
                jobs: Object.entries(CI_STEPS).map(([name, steps], index) => ({
                    id: 601 + index, name, run_id: 101, run_attempt: 1, head_sha: SOURCE_SHA,
                    status: 'completed', conclusion: 'success', started_at: '2026-01-01T11:42:00Z', completed_at: '2026-01-01T11:49:00Z',
                    steps: steps.map((step, number) => ({ name: step, number: number + 1, status: 'completed', conclusion: 'success' }))
                })) } },
        candidate: run('candidate', expected.candidate), liveEval: run('liveEval', expected.liveEval),
        workflowBytes: { candidate: Buffer.from(releaseWorkflow), liveEval: Buffer.from(releaseWorkflow) }
    };
    const componentBytes = { appService: Buffer.from('synthetic prior candidate app'),
        legacyFunction: Buffer.from('synthetic prior candidate function'), static: Buffer.from('synthetic prior candidate static') };
    const components = Object.fromEntries(Object.entries(componentBytes).map(([name, bytes]) => [name, sha256(bytes)]));
    const manifestBytes = Buffer.from(JSON.stringify({ schemaVersion: 2,
        releaseFor: { releaseSha: PREVIOUS_SHA, runId: '104', runAttempt: '1' },
        sha256: { candidateApp: components.appService, candidateLegacyFunction: components.legacyFunction,
            candidateStatic: components.static, rollbackApp: sha256(Buffer.from('older rollback, never the current candidate')) } }));
    const artifactBytes = Buffer.from('synthetic authenticated outer artifact bytes');
    const bundleBytes = Buffer.from('synthetic authenticated package bundle bytes');
    Object.assign(expected.rollback, { artifactId: 701, artifactName: 'synthetic-packages-104-1', artifactSha256: sha256(artifactBytes), bundleSha256: sha256(bundleBytes),
        manifestSha256: sha256(manifestBytes), components });
    const rollbackRepo = stage === 'first-public' ? legacyRepo : repo;
    evidence.rollback = { mode: 'exact-artifact', sourceRole: 'candidate', repository: { ...rollbackRepo },
        producer: run('rollbackOrigin', expected.rollback), producerAfter: run('rollbackOrigin', expected.rollback),
        listing: { total_count: 1, artifacts: [{ id: 701, expired: false, name: 'synthetic-packages-104-1',
            size_in_bytes: artifactBytes.length, created_at: '2026-01-01T11:50:00Z', expires_at: '2026-01-02T11:50:00Z',
            digest: `sha256:${sha256(artifactBytes)}`, workflow_run: { id: 104, head_sha: PREVIOUS_SHA,
                repository_id: rollbackRepo.id, head_repository_id: rollbackRepo.id, head_branch: 'main' } }] },
        artifactBytes, bundleBytes, manifestBytes, componentBytes,
        embeddedIdentities: Object.fromEntries(Object.keys(components).map(name => [name,
            { schemaVersion: 2, releaseSha: PREVIOUS_SHA, runId: '104' }])) };
    const recovery = { collectedAt: '2026-01-01T11:59:00Z', before: {}, after: {}, attempt2Absence: { before: {}, after: {} }, workflowBytes: {} };
    for (const phase of ['before', 'after']) {
        for (const [role, b] of Object.entries(expected.recovery)) {
            recovery[phase][role] = run(role, b);
            recovery.attempt2Absence[phase][role] = { repository: { ...repo }, role, runId: b.runId, attempt: 2, httpStatus: 404 };
            recovery.workflowBytes[role] = Buffer.from(releaseWorkflow);
        }
        recovery[phase].recoveryController.run_started_at = '2026-01-01T11:51:00Z';
        recovery[phase].recoveryController.updated_at = '2026-01-01T11:55:00Z';
        recovery[phase].recoveryWitness.created_at = '2026-01-01T11:52:00Z';
        recovery[phase].recoveryWitness.run_started_at = null;
        recovery[phase].recoveryWitness.updated_at = '2026-01-01T11:55:00Z';
    }
    return { evidence, expected, recovery, run };
}

test.each(['first-public', 'public'])('%s provenance remains an offline check with no deployment authority', stage => {
    const { evidence, expected, recovery } = fixture(stage);
    expect(inspectHandover(evidence, expected)).toEqual({ schemaVersion: 1, mode: 'offline-design-check',
        provenanceConsistent: true, deploymentAuthorized: false,
        rollback: { repository: stage === 'first-public' ? legacyRepo.full_name : repo.full_name, sourceRole: 'candidate', mode: 'exact-artifact' } });
    expect(() => checkRecovery(recovery, expected)).not.toThrow();
    evidence.activate = true; expected.deploymentAuthorized = true;
    expect(inspectHandover(evidence, expected).deploymentAuthorized).toBe(false);
});

const roles = ['ci', 'liveEval', 'candidate', 'rollbackOrigin', 'recoveryOrigin', 'recoveryController', 'recoveryWitness'];
const badRun = {
    repository: r => { r.repository.full_name = 'attacker/nofries-platform'; },
    repositoryId: r => { r.repository.id += 1; },
    headRepository: r => { r.head_repository.full_name = 'attacker/nofries-platform'; },
    fork: r => { r.head_repository.fork = true; },
    role: r => { r.role = 'unknown'; },
    sha: r => { r.head_sha = 'd'.repeat(40); },
    run: r => { r.id += 1; },
    attempt: r => { r.run_attempt += 1; },
    workflow: r => { r.workflow_id += 1; },
    path: r => { r.path = '.github/workflows/unreviewed.yml'; },
    event: r => { r.event = 'pull_request'; },
    pullRequest: r => { r.pull_requests = [{}]; },
    branch: r => { r.head_branch = 'unreviewed'; },
    status: r => { r.status = 'waiting_for_review'; },
    conclusion: r => { r.conclusion = 'neutral'; }
};
for (const stage of ['first-public', 'public']) {
    for (const role of roles) {
        test.each(Object.entries(badRun))(`${stage} ${role} rejects wrong %s`, (_name, mutate) => {
            const { expected, run } = fixture(stage);
            const b = role === 'rollbackOrigin' ? expected.rollback : expected[role] || expected.recovery[role];
            const observed = run(role, b); mutate(observed);
            expect(() => checkRun(role, observed, b, expected)).toThrow('public_handover_refused:');
        });
    }
}

const invalidHandover = {
    'unknown migration stage': (_e, x) => { x.stage = 'all-repositories'; },
    'missing legacy repository pin': (_e, x) => { delete x.legacyRepository; },
    'stale observation': e => { e.collectedAt = '2026-01-01T11:00:00Z'; },
    'source from private repository': e => { e.source.repository = { ...legacyRepo }; },
    'unprotected source': e => { e.source.before.protected = false; },
    'moving main': e => { e.source.after.commit.sha = PREVIOUS_SHA; },
    'wrong tree': e => { e.source.after.commit.tree.sha = PREVIOUS_SHA; },
    'source inventory bytes': e => { e.source.inventoryBytes = Buffer.from('overlay'); },
    'CI for a different source': (_e, x) => { x.ci.sha = PREVIOUS_SHA; },
    'unreviewed CI workflow': e => { e.ci.workflowBytes = Buffer.from('skip everything'); },
    'changed npm command graph': e => { e.ci.sourceBytes['package.json'] = Buffer.from('{}'); },
    'missing source binding': e => { delete e.ci.sourceBytes['scripts/check-dependency-audit.js']; },
    'new CI attempt during collection': e => { e.ci.runAfter.run_attempt += 1; },
    'different latest CI run': e => { e.ci.listingAfter.workflow_runs[0].id += 1; },
    'ambiguous latest CI listing': e => { e.ci.listing.workflow_runs.push(e.ci.run); },
    'partial CI job page': e => { e.ci.jobs.total_count += 1; },
    'mixed-attempt jobs': e => { e.ci.jobs.jobs[0].run_attempt += 1; },
    'duplicate job': e => { e.ci.jobs.jobs[1] = e.ci.jobs.jobs[0]; },
    'missing native job': e => { e.ci.jobs.jobs.splice(1, 1); },
    'skipped verification': e => { e.ci.jobs.jobs[0].steps[1].conclusion = 'skipped'; },
    'duplicate step': e => { e.ci.jobs.jobs[0].steps.push(e.ci.jobs.jobs[0].steps[0]); },
    'stale CI': e => { e.ci.jobs.jobs[0].started_at = '2025-12-30T10:00:00Z'; e.ci.jobs.jobs[0].completed_at = '2025-12-30T11:00:00Z'; },
    'future CI': e => { e.ci.jobs.jobs[0].completed_at = '2026-01-01T12:01:00Z'; },
    'candidate workflow digest': e => { e.workflowBytes.candidate = Buffer.from('different controller'); },
    'live eval workflow digest': e => { e.workflowBytes.liveEval = Buffer.from('different eval'); },
    'relabelled private rollback': e => { e.rollback.repository = { ...repo }; },
    'public producer at first release': e => { e.rollback.producer.repository = { ...repo }; },
    'private producer after transition': (_e, x) => { x.stage = 'public'; },
    'rollback from old rollback slot': e => { e.rollback.sourceRole = 'rollback'; },
    'source reconstruction fallback': e => { e.rollback.mode = 'source-reconstructed'; },
    'expired rollback': e => { e.rollback.listing.artifacts[0].expired = true; },
    'rollback expires before use': e => { e.rollback.listing.artifacts[0].expires_at = '2026-01-01T11:59:00Z'; },
    'wrong rollback byte length': e => { e.rollback.listing.artifacts[0].size_in_bytes += 1; },
    'missing rollback artifact': e => { e.rollback.listing = { total_count: 0, artifacts: [] }; },
    'ambiguous rollback artifact': e => { e.rollback.listing.total_count = 2; e.rollback.listing.artifacts.push(e.rollback.listing.artifacts[0]); },
    'wrong rollback artifact id': e => { e.rollback.listing.artifacts[0].id += 1; },
    'wrong rollback artifact attempt name': e => { e.rollback.listing.artifacts[0].name = 'synthetic-packages-104-2'; },
    'wrong artifact repository id': e => { e.rollback.listing.artifacts[0].workflow_run.repository_id = repo.id; },
    'wrong artifact producer': e => { e.rollback.listing.artifacts[0].workflow_run.id += 1; },
    'rollback producer rerun': e => { e.rollback.producerAfter.run_attempt += 1; },
    'artifact digest metadata': e => { e.rollback.listing.artifacts[0].digest = 'sha256:' + 'd'.repeat(64); },
    'artifact digest bytes': e => { e.rollback.artifactBytes = Buffer.from('corrupt'); },
    'bundle digest bytes': e => { e.rollback.bundleBytes = Buffer.from('corrupt'); },
    'manifest digest bytes': e => { e.rollback.manifestBytes = Buffer.from('corrupt'); },
    'candidate component bytes': e => { e.rollback.componentBytes.static = Buffer.from('old rollback slot'); },
    'mixed embedded source': e => { e.rollback.embeddedIdentities.static.releaseSha = SOURCE_SHA; },
    'mixed embedded run': e => { e.rollback.embeddedIdentities.appService.runId = '999'; },
    'missing component': e => { delete e.rollback.componentBytes.legacyFunction; }
};
test.each(Object.entries(invalidHandover))('handover rejects %s', (_name, mutate) => {
    const { evidence, expected } = fixture(); mutate(evidence, expected);
    expect(() => inspectHandover(evidence, expected)).toThrow('public_handover_refused:');
});

test.each(['releaseSha', 'runId', 'runAttempt'])('manifest %s cannot be rebound by replacing its expected digest', key => {
    const { evidence, expected } = fixture();
    const manifest = JSON.parse(evidence.rollback.manifestBytes);
    manifest.releaseFor[key] = key === 'releaseSha' ? SOURCE_SHA : '999';
    evidence.rollback.manifestBytes = Buffer.from(JSON.stringify(manifest));
    expected.rollback.manifestSha256 = sha256(evidence.rollback.manifestBytes);
    expect(() => inspectHandover(evidence, expected)).toThrow('rollback_manifest_producer');
});
test('first-release rollback cannot copy the previous package rollback digest', () => {
    const { evidence, expected } = fixture();
    const manifest = JSON.parse(evidence.rollback.manifestBytes);
    manifest.sha256.candidateApp = manifest.sha256.rollbackApp;
    evidence.rollback.manifestBytes = Buffer.from(JSON.stringify(manifest));
    expected.rollback.manifestSha256 = sha256(evidence.rollback.manifestBytes);
    expect(() => inspectHandover(evidence, expected)).toThrow('rollback_candidate_digest');
});

const invalidRecovery = {
    'private recovery origin': r => { r.before.recoveryOrigin.repository = { ...legacyRepo }; },
    'private recovery controller': r => { r.before.recoveryController.repository = { ...legacyRepo }; },
    'private recovery witness': r => { r.after.recoveryWitness.repository = { ...legacyRepo }; },
    'role swap': r => { r.before.recoveryController = r.before.recoveryOrigin; },
    'changed source': r => { r.after.recoveryController.head_sha = PREVIOUS_SHA; },
    'changed run': r => { r.after.recoveryOrigin.id += 1; },
    'second attempt': r => { r.after.recoveryOrigin.run_attempt = 2; },
    'wrong controller bytes': r => { r.workflowBytes.recoveryController = Buffer.from('bad'); },
    'missing attempt-2 proof': r => { delete r.attempt2Absence.after.recoveryWitness; },
    'attempt 2 exists': r => { r.attempt2Absence.after.recoveryOrigin.httpStatus = 200; },
    'attempt-2 forbidden response': r => { r.attempt2Absence.after.recoveryOrigin.httpStatus = 403; },
    'attempt-2 proof wrong repository': r => { r.attempt2Absence.before.recoveryController.repository = { ...legacyRepo }; },
    'wrong witness target': r => { r.after.recoveryWitness.display_title = 'Synthetic witness for 999'; },
    'witness started': r => { r.after.recoveryWitness.status = 'in_progress'; },
    'inconsistent snapshots': r => { r.after.recoveryWitness.status = 'waiting'; },
    'out-of-order controller': r => { r.before.recoveryController.run_started_at = '2026-01-01T11:00:00Z'; },
    'impossible update time': r => { r.before.recoveryController.updated_at = '2026-01-01T11:00:00Z'; },
    'nonconsecutive witness': (_r, x) => { x.recovery.recoveryWitness.runNumber += 1; },
    'reused origin run': (_r, x) => { x.recovery.recoveryController.runId = x.recovery.recoveryOrigin.runId; },
    'cross-workflow witness': (_r, x) => { x.recovery.recoveryWitness.workflowId += 1; },
    'stale collection': r => { r.collectedAt = '2026-01-01T11:00:00Z'; }
};
test.each(Object.entries(invalidRecovery))('recovery rejects %s', (_name, mutate) => {
    const { recovery, expected } = fixture(); mutate(recovery, expected);
    expect(() => checkRecovery(recovery, expected)).toThrow('public_handover_refused:');
});
