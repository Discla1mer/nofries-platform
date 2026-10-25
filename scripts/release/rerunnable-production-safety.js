'use strict';

const crypto = require('crypto');
const fs = require('fs');

const REPOSITORY = 'Discla1mer/NoFries';
const CONNECTOR_CANARY_SECRETS = Object.freeze({
    CANARY_SCOPE: 'NOFRIES_CONNECTOR_CANARY_SCOPE',
    READONLY_CANARY_CLIENT_ID: 'NOFRIES_CONNECTOR_CANARY_CLIENT_ID',
    READONLY_CANARY_CLIENT_SECRET: 'NOFRIES_CONNECTOR_CANARY_CLIENT_SECRET',
    UNAPPROVED_IDENTITY_CANARY_CLIENT_ID: 'NOFRIES_CONNECTOR_NEGATIVE_CANARY_CLIENT_ID',
    UNAPPROVED_IDENTITY_CANARY_CLIENT_SECRET:
        'NOFRIES_CONNECTOR_NEGATIVE_CANARY_CLIENT_SECRET'
});
const CONNECTOR_CANARY_PREFLIGHT_BINDINGS = Object.freeze({
    CANARY_SCOPE: 'NOFRIES_CONNECTOR_CANARY_SCOPE',
    READONLY_CANARY_CLIENT_ID: 'NOFRIES_CONNECTOR_CANARY_CLIENT_ID',
    UNAPPROVED_IDENTITY_CANARY_CLIENT_ID: 'NOFRIES_CONNECTOR_NEGATIVE_CANARY_CLIENT_ID'
});
const STATIC_WEB_APP_SECRET = Object.freeze({
    azure_static_web_apps_api_token:
        'AZURE_STATIC_WEB_APPS_API_TOKEN_NOFRIES_GAP_ANALYSIS'
});
// Preserve the exact historical symbol for source assessment. Its acceptance
// here is not evidence of a live credential; the retirement procedure separately
// rotates it and removes the former production-environment binding. Current
// unified source is required to use V2 by validate-unified-production-release.
const ROTATED_STATIC_WEB_APP_SECRET = 'NOFRIES_STATIC_DEPLOYMENT_TOKEN_V2';
const STATIC_WEB_APP_ACTION =
    'Azure/static-web-apps-deploy@4d27395796ac319302594769cfe812bd207490b1';
const WORKFLOWS = Object.freeze({
    'release-connector-production.yml': Object.freeze({
        path: '.github/workflows/release-connector-production.yml',
        allowedJobs: Object.freeze([
            'freshness_witness', 'rerunnable_safety', 'package',
            'freshness_witness_dispatch', 'readback', 'deploy',
            'automatic_recovery', 'publish_status'
        ]),
        mutationJobs: Object.freeze(['deploy', 'automatic_recovery']),
        writeJobs: Object.freeze({
            automatic_recovery: 'id-token', deploy: 'id-token',
            freshness_witness_dispatch: 'actions', publish_status: 'statuses'
        }),
        secretSteps: Object.freeze({
            deploy: Object.freeze({
                'Mint and validate protected canary identities before Azure sign-in':
                    Object.freeze({ carrier: 'env', execution: 'run',
                        bindings: CONNECTOR_CANARY_SECRETS }),
                'Verify exact connector production preflight':
                    Object.freeze({ carrier: 'env', execution: 'run',
                        bindings: CONNECTOR_CANARY_PREFLIGHT_BINDINGS }),
                'Require exact application canaries before mutation':
                    Object.freeze({ carrier: 'env', execution: 'run',
                        bindings: CONNECTOR_CANARY_SECRETS }),
                'Deploy the exact connector candidate package':
                    Object.freeze({ carrier: 'env', execution: 'run',
                        bindings: CONNECTOR_CANARY_SECRETS })
            }),
            automatic_recovery: Object.freeze({
                'Restore and prove the prior connector on a fresh runner':
                    Object.freeze({ carrier: 'env', execution: 'run',
                        bindings: CONNECTOR_CANARY_SECRETS })
            })
        })
    }),
    'release-unified-production.yml': Object.freeze({
        path: '.github/workflows/release-unified-production.yml',
        allowedJobs: Object.freeze([
            'freshness_witness', 'rerunnable_safety', 'package', 'release',
            'freshness_witness_dispatch', 'recovery_freshness', 'recover'
        ]),
        mutationJobs: Object.freeze(['release', 'recover']),
        writeJobs: Object.freeze({
            freshness_witness_dispatch: 'actions', recover: 'id-token', release: 'id-token'
        }),
        secretSteps: Object.freeze({
            release: Object.freeze({
                'Publish the matching candidate static package': Object.freeze({
                    action: STATIC_WEB_APP_ACTION, carrier: 'with', execution: 'action',
                    bindings: STATIC_WEB_APP_SECRET
                }),
                'Restore the previous static package': Object.freeze({
                    action: STATIC_WEB_APP_ACTION, carrier: 'with', execution: 'action',
                    bindings: STATIC_WEB_APP_SECRET
                })
            }),
            recover: Object.freeze({
                'Independently restore the previous static package': Object.freeze({
                    action: STATIC_WEB_APP_ACTION, carrier: 'with', execution: 'action',
                    bindings: STATIC_WEB_APP_SECRET
                })
            })
        })
    })
});
const RUN_KEYS = Object.freeze([
    'conclusion', 'createdAt', 'displayTitle', 'event', 'headBranch', 'headSha', 'path',
    'repository', 'runAttempt', 'runId', 'runNumber', 'runStartedAt', 'status',
    'updatedAt', 'workflowId'
]);
const ACTIVE_STATUSES = new Set(['in_progress', 'pending', 'queued', 'requested', 'waiting']);
const COMPLETED_CONCLUSIONS = new Set([
    'action_required', 'cancelled', 'failure', 'neutral', 'skipped', 'stale',
    'startup_failure', 'success', 'timed_out'
]);
const HORIZON_MILLISECONDS = 31 * 24 * 60 * 60 * 1000;
// Owner-directed, source-bound pre-customer policy. This is not live tenant
// inventory or retirement of historical authority. No request can select it.
const PRODUCTION_ADMISSION_POLICY = Object.freeze({
    schemaVersion: 1,
    mode: 'prelaunch',
    ownerDecisionId: 'NF-PRELAUNCH-RELEASE-20260908',
    acceptedHistoryBeforeUtc: '2026-09-08T09:43:36.589Z',
    externalCustomerAdmission: false,
    historicalRerunRiskAccepted: true,
    authorityRetired: false
});
const PRODUCTION_ADMISSION_POLICY_SHA256 = crypto.createHash('sha256')
    .update(JSON.stringify(PRODUCTION_ADMISSION_POLICY)).digest('hex');
const QUIESCENCE_STATUSES = Object.freeze([
    'requested', 'waiting', 'pending', 'queued', 'in_progress'
]);

class RerunnableProductionSafetyError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RerunnableProductionSafetyError';
        this.code = 'rerunnable_production_safety_invalid';
    }
}

function fail(message) {
    throw new RerunnableProductionSafetyError(message);
}

function record(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
    return value;
}

function exactKeys(value, keys, label) {
    record(value, label);
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} has unexpected fields.`);
}

function positiveDecimal(value, label) {
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
        fail(`${label} must be a positive decimal string.`);
    }
    return value;
}

function fullSha(value, label) {
    if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
        fail(`${label} must be a full lowercase commit SHA.`);
    }
    return value;
}

function timestamp(value, label) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) {
        fail(`${label} must be a UTC timestamp.`);
    }
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds)) fail(`${label} is invalid.`);
    return milliseconds;
}

function runRecord(value, label, exactAttempt = false) {
    exactKeys(value, exactAttempt ? [...RUN_KEYS, 'originalRunCreatedAt'] : RUN_KEYS, label);
    const runId = positiveDecimal(value.runId, `${label}.runId`);
    const runAttempt = positiveDecimal(value.runAttempt, `${label}.runAttempt`);
    const runNumber = positiveDecimal(value.runNumber, `${label}.runNumber`);
    const workflowId = positiveDecimal(value.workflowId, `${label}.workflowId`);
    const headSha = fullSha(value.headSha, `${label}.headSha`);
    for (const name of ['event', 'headBranch', 'path', 'repository']) {
        if (typeof value[name] !== 'string' || !value[name]) fail(`${label}.${name} is invalid.`);
    }
    if (value.displayTitle !== null && typeof value.displayTitle !== 'string') {
        fail(`${label}.displayTitle is invalid.`);
    }
    const createdAtMilliseconds = timestamp(value.createdAt, `${label}.createdAt`);
    const updatedAtMilliseconds = timestamp(value.updatedAt, `${label}.updatedAt`);
    const runStartedAtMilliseconds = value.runStartedAt === null ? null :
        timestamp(value.runStartedAt, `${label}.runStartedAt`);
    // Exact-attempt creation is endpoint-specific and can follow its start.
    // The original run creation remains the lower bound for both timestamps.
    const originalRunCreatedAtMilliseconds = exactAttempt ?
        timestamp(value.originalRunCreatedAt, `${label}.originalRunCreatedAt`) :
        createdAtMilliseconds;
    if (originalRunCreatedAtMilliseconds > createdAtMilliseconds ||
        createdAtMilliseconds > updatedAtMilliseconds ||
        (runStartedAtMilliseconds !== null &&
            (originalRunCreatedAtMilliseconds > runStartedAtMilliseconds ||
                runStartedAtMilliseconds > updatedAtMilliseconds))) {
        fail(`${label} timestamps are out of order.`);
    }
    if (value.status === 'completed') {
        if (runStartedAtMilliseconds === null || !COMPLETED_CONCLUSIONS.has(value.conclusion)) {
            fail(`${label} has an invalid completed state.`);
        }
    } else if (ACTIVE_STATUSES.has(value.status)) {
        if (value.conclusion !== null ||
            (value.status === 'in_progress' && runStartedAtMilliseconds === null)) {
            fail(`${label} has an invalid active state.`);
        }
    } else {
        fail(`${label} has an unsupported state.`);
    }
    return Object.freeze({
        ...value, createdAtMilliseconds, originalRunCreatedAtMilliseconds,
        headSha, runAttempt, runId, runNumber,
        runStartedAtMilliseconds, updatedAtMilliseconds, workflowId
    });
}

function sameRun(left, right, allowUpdatedAt = false) {
    return RUN_KEYS.every((key) => (allowUpdatedAt && key === 'updatedAt') || left[key] === right[key]);
}

function validateProductionQuiescence(evidence, current, workflowFile) {
    exactKeys(evidence, ['after', 'before'], 'Production quiescence');
    const workflow = WORKFLOWS[workflowFile];
    if (!workflow) fail('The quiescence workflow is unsupported.');
    const phases = Object.create(null);
    for (const phase of ['before', 'after']) {
        const snapshot = evidence[phase];
        const connector = workflowFile === 'release-connector-production.yml';
        const witnessJobsKey = connector ? 'connectorWitnessJobs' : 'unifiedWitnessJobs';
        const hasWitnessJobs = Object.prototype.hasOwnProperty.call(snapshot, witnessJobsKey);
        exactKeys(snapshot, ['statuses', ...(hasWitnessJobs ? [witnessJobsKey] : [])],
            `${phase} quiescence snapshot`);
        const witnessJobs = hasWitnessJobs ? snapshot[witnessJobsKey] : [];
        if (!Array.isArray(witnessJobs) || witnessJobs.length > 1) {
            fail('Production witness nonexecution proof is invalid.');
        }
        if (!Array.isArray(snapshot.statuses) ||
            snapshot.statuses.length !== QUIESCENCE_STATUSES.length) {
            fail('The active manual-run status inventory is incomplete.');
        }
        const byId = new Map();
        let witnessCount = 0;
        for (const [index, group] of snapshot.statuses.entries()) {
            exactKeys(group, ['runs', 'status', 'terminalPageEmpty', 'totalCount'],
                `${phase} active status ${index}`);
            if (group.status !== QUIESCENCE_STATUSES[index] ||
                group.terminalPageEmpty !== true || !Number.isSafeInteger(group.totalCount) ||
                group.totalCount < 0 || group.totalCount >= 100 ||
                !Array.isArray(group.runs) || group.runs.length !== group.totalCount) {
                fail('The active manual-run status inventory is incomplete or truncated.');
            }
            for (const raw of group.runs) {
                const run = runRecord(raw, `${phase} active manual run`);
                if (run.repository !== REPOSITORY || run.event !== 'workflow_dispatch' ||
                    run.status !== group.status || byId.has(run.runId)) {
                    fail('The active manual-run inventory is contradictory.');
                }
                byId.set(run.runId, run);
                if (run.runId === current.runId) {
                    if (!sameRun(run, current, true) ||
                        run.updatedAtMilliseconds < current.updatedAtMilliseconds) {
                        fail('The active inventory does not bind the current release.');
                    }
                    continue;
                }
                const prefix = workflowFile === 'release-connector-production.yml' ?
                    'Connector' : 'Unified';
                const inertWitness = run.workflowId === current.workflowId &&
                    run.path === workflow.path && run.headSha === current.headSha &&
                    run.headBranch === 'main' && run.runAttempt === '1' &&
                    ['queued', 'pending', 'requested', 'waiting'].includes(run.status) &&
                    (run.runStartedAt === null || run.runStartedAt === run.createdAt) &&
                    BigInt(run.runNumber) === BigInt(current.runNumber) + 1n &&
                    run.createdAtMilliseconds >= current.createdAtMilliseconds &&
                    run.displayTitle === `${prefix} freshness witness for ${current.runId}`;
                if (!inertWitness || ++witnessCount > 1) {
                    fail('Another active manual run prevents production quiescence.');
                }
                {
                    if (witnessJobs.length !== 1) fail('Production witness nonexecution proof is missing.');
                    const proof = witnessJobs[0];
                    exactKeys(proof, ['jobs', 'phase', 'runAttempt', 'runId', 'terminalPageEmpty', 'totalCount'],
                        `${phase} production witness jobs`);
                    if (proof.phase !== phase || proof.runId !== run.runId || proof.runAttempt !== '1' ||
                        proof.totalCount !== 0 || proof.terminalPageEmpty !== true ||
                        !Array.isArray(proof.jobs) || proof.jobs.length !== 0) {
                        fail('Production witness nonexecution proof is invalid.');
                    }
                }
            }
        }
        if (!byId.has(current.runId)) fail('The active inventory omits the current release.');
        if (witnessJobs.length !== witnessCount) {
            fail('Production witness nonexecution proof does not match the active inventory.');
        }
        phases[phase] = byId;
    }
    if (phases.before.size !== phases.after.size) {
        fail('The active manual-run inventory changed during collection.');
    }
    for (const [runId, before] of phases.before) {
        const after = phases.after.get(runId);
        if (!after || !sameRun(before, after, runId === current.runId) ||
            after.updatedAtMilliseconds < before.updatedAtMilliseconds) {
            fail('The active manual-run inventory changed during collection.');
        }
    }
    return Object.freeze({ quiescent: true, activeRunCount: phases.after.size });
}

function productionEnvironment(snapshot, expectedSha, workflowId, workflowPath, label) {
    exactKeys(snapshot, [
        'branch', 'branchPolicies', 'currentRun', 'environment', 'ref', 'rolling', 'workflow'
    ], label);
    exactKeys(snapshot.environment, ['deploymentBranchPolicy', 'name'], `${label}.environment`);
    exactKeys(snapshot.environment.deploymentBranchPolicy,
        ['customBranchPolicies', 'protectedBranches'], `${label}.environment policy`);
    if (snapshot.environment.name !== 'production' ||
        snapshot.environment.deploymentBranchPolicy.protectedBranches !== false ||
        snapshot.environment.deploymentBranchPolicy.customBranchPolicies !== true) {
        fail(`${label} does not authenticate the exact production deployment policy.`);
    }
    if (!Array.isArray(snapshot.branchPolicies) || snapshot.branchPolicies.length !== 1) {
        fail(`${label} must contain exactly one deployment branch policy.`);
    }
    exactKeys(snapshot.branchPolicies[0], ['name', 'type'], `${label}.branch policy`);
    if (snapshot.branchPolicies[0].name !== 'main' || snapshot.branchPolicies[0].type !== 'branch') {
        fail(`${label} permits a branch, tag, or wildcard other than exact main.`);
    }
    exactKeys(snapshot.branch, ['name', 'protected', 'sha'], `${label}.branch`);
    if (snapshot.branch.name !== 'main' || snapshot.branch.protected !== true ||
        snapshot.branch.sha !== expectedSha) {
        fail(`${label} does not bind protected main to the current SHA.`);
    }
    exactKeys(snapshot.ref, ['ref', 'sha', 'type'], `${label}.ref`);
    if (snapshot.ref.ref !== 'refs/heads/main' || snapshot.ref.type !== 'commit' ||
        snapshot.ref.sha !== expectedSha) {
        fail(`${label} does not bind the exact main ref to the current SHA.`);
    }
    exactKeys(snapshot.workflow, ['createdAt', 'path', 'state', 'updatedAt', 'workflowId'],
        `${label}.workflow`);
    if (snapshot.workflow.workflowId !== workflowId || snapshot.workflow.path !== workflowPath ||
        snapshot.workflow.state !== 'active') {
        fail(`${label} does not bind the active workflow identity.`);
    }
    const createdAtMilliseconds = timestamp(
        snapshot.workflow.createdAt, `${label}.workflow.createdAt`);
    const updatedAtMilliseconds = timestamp(
        snapshot.workflow.updatedAt, `${label}.workflow.updatedAt`);
    if (createdAtMilliseconds > updatedAtMilliseconds) {
        fail(`${label} active workflow timestamps are out of order.`);
    }
    return Object.freeze({ createdAtMilliseconds, updatedAtMilliseconds });
}

// The schema-6 envelope is retained: 45 platform/current requests + 400 exact
// attempts + 69 source reads + 138 next-attempt probes = 652. Schema 7 shares
// those allocations, preserving 333 outside requests and 15 unallocated out of
// the 1,000-request full-recovery ceiling. No evidence field selects a budget.
function validateRollingWorkload(before, after) {
    const phases = [before, after];
    const sources = new Set();
    let requests = 45;
    for (const headers of phases) {
        if (!Array.isArray(headers) || headers.length < 1 || headers.length >= 200) {
            fail('The complete rolling workload exceeds its repository bound.');
        }
        let attempts = 0;
        for (const header of headers) {
            record(header, 'Rolling workload header');
            positiveDecimal(header.runId, 'Rolling workload run ID');
            const attempt = positiveDecimal(header.runAttempt, 'Rolling workload attempt');
            if (BigInt(attempt) > 51n) fail('The rolling workload exceeds its per-run attempt bound.');
            attempts += Number(attempt);
            sources.add(fullSha(header.headSha, 'Rolling workload source'));
        }
        if (attempts > 200) fail('The rolling workload exceeds its 200-attempt bound.');
        requests += attempts + headers.length;
    }
    requests += sources.size;
    if (requests > 652) fail('The complete rolling workload exceeds its 652-request collection budget.');
    return Object.freeze({ collectionRequests: requests, recoveryRequests: requests + 333 });
}

function validateRerunnableProductionSafety(evidence, expected) {
    exactKeys(expected, ['currentRunAttempt', 'currentRunId', 'currentSha', 'workflowFile'],
        'Expected rerunnable-production identity');
    const workflow = WORKFLOWS[expected.workflowFile];
    if (!workflow) fail('The expected release workflow is unsupported.');
    const expectedRunId = positiveDecimal(expected.currentRunId, 'expected.currentRunId');
    const expectedRunAttempt = positiveDecimal(expected.currentRunAttempt,
        'expected.currentRunAttempt');
    const expectedSha = fullSha(expected.currentSha, 'expected.currentSha');
    if (expectedRunAttempt !== '1') fail('A rerun cannot enter production admission.');

    exactKeys(evidence, [
        'admissionPolicy', 'admissionPolicySha256', 'attemptCount', 'attempts', 'kind',
        'nextAttemptAbsence', 'quiescence', 'schemaVersion', 'snapshots', 'sourceVersions', 'window'
    ], 'Rerunnable-production evidence');
    if (![6, 7].includes(evidence.schemaVersion) || evidence.kind !== 'nofries-rerunnable-production-safety') {
        fail('Rerunnable-production evidence has an unsupported schema.');
    }
    exactKeys(evidence.admissionPolicy, Object.keys(PRODUCTION_ADMISSION_POLICY), 'Admission policy');
    if (Object.keys(PRODUCTION_ADMISSION_POLICY).some((key) =>
        evidence.admissionPolicy[key] !== PRODUCTION_ADMISSION_POLICY[key]) ||
        evidence.admissionPolicySha256 !== PRODUCTION_ADMISSION_POLICY_SHA256) {
        fail('The source-bound prelaunch admission policy was changed.');
    }
    const cutoff = timestamp(PRODUCTION_ADMISSION_POLICY.acceptedHistoryBeforeUtc, 'Policy cutoff');
    const warnings = [];
    exactKeys(evidence.window, [
        'anchorCreatedAt', 'lowerBoundCreatedAt', 'maxAttemptCount',
        'maxRepositoryRunCount', 'maxRunCount', 'repository', 'rerunHorizonDays',
        'workflowId', 'workflowPath'
    ], 'Rerunnable-production window');
    const workflowId = positiveDecimal(evidence.window.workflowId, 'window.workflowId');
    if (evidence.window.repository !== REPOSITORY ||
        evidence.window.workflowPath !== workflow.path ||
        evidence.window.rerunHorizonDays !== 31 ||
        evidence.window.maxRunCount !== (evidence.schemaVersion === 6 ? 70 : 200) ||
        evidence.window.maxRepositoryRunCount !== 200 ||
        evidence.window.maxAttemptCount !== 200) {
        fail('The rolling rerun window identity or bounds are invalid.');
    }
    const anchor = timestamp(evidence.window.anchorCreatedAt, 'window.anchorCreatedAt');
    const lower = timestamp(evidence.window.lowerBoundCreatedAt, 'window.lowerBoundCreatedAt');
    if (anchor < cutoff) fail('The current release predates the approved prelaunch policy.');
    if (anchor - lower !== HORIZON_MILLISECONDS) {
        fail('The rolling rerun lower bound is not exactly 31 days before its anchor.');
    }

    exactKeys(evidence.snapshots, ['after', 'before'], 'Rerunnable-production snapshots');
    const snapshots = Object.create(null);
    for (const phase of ['before', 'after']) {
        const snapshot = evidence.snapshots[phase];
        const activeWorkflow = productionEnvironment(snapshot, expectedSha, workflowId, workflow.path,
            `${phase} platform snapshot`);
        const current = runRecord(snapshot.currentRun, `${phase} current run`);
        if (current.runId !== expectedRunId || current.runAttempt !== expectedRunAttempt ||
            current.headSha !== expectedSha || current.workflowId !== workflowId ||
            current.repository !== REPOSITORY || current.path !== workflow.path ||
            current.event !== 'workflow_dispatch' || current.headBranch !== 'main' ||
            current.status !== 'in_progress' || current.conclusion !== null ||
            current.createdAtMilliseconds !== anchor) {
            fail(`${phase} current run provenance is invalid.`);
        }
        if (activeWorkflow.createdAtMilliseconds > lower) {
            if (activeWorkflow.createdAtMilliseconds > anchor) {
                fail('The active workflow registration is future-dated relative to this release.');
            }
            if (phase === 'before') warnings.push(Object.freeze({
                code: 'workflow_registration_age_advisory', workflowPath: workflow.path,
                registeredAt: snapshot.workflow.createdAt,
                strictAgeEligibleAt: new Date(activeWorkflow.createdAtMilliseconds +
                    HORIZON_MILLISECONDS).toISOString()
            }));
        }
        exactKeys(snapshot.rolling,
            ['headers', 'registrationIds', 'repositoryDispatchCount', 'totalCount'],
            `${phase} rolling snapshot`);
        if (!Number.isSafeInteger(snapshot.rolling.totalCount) ||
            snapshot.rolling.totalCount < 1 ||
            snapshot.rolling.totalCount >= evidence.window.maxRunCount ||
            !Number.isSafeInteger(snapshot.rolling.repositoryDispatchCount) ||
            snapshot.rolling.repositoryDispatchCount < snapshot.rolling.totalCount ||
            snapshot.rolling.repositoryDispatchCount >= 200 ||
            !Array.isArray(snapshot.rolling.headers) ||
            snapshot.rolling.headers.length !== snapshot.rolling.totalCount) {
            fail(`${phase} rolling snapshot is incomplete or near its truncation bound.`);
        }
        const byId = new Map();
        const byNumber = new Map();
        for (const [index, item] of snapshot.rolling.headers.entries()) {
            const run = runRecord(item, `${phase} rolling header ${index}`);
            const registrationRunNumber = `${run.workflowId}\u0000${run.runNumber}`;
            if (run.repository !== REPOSITORY || run.path !== workflow.path ||
                run.event !== 'workflow_dispatch' || run.createdAtMilliseconds < lower ||
                byId.has(run.runId) || byNumber.has(registrationRunNumber)) {
                fail(`${phase} rolling snapshot is contradictory or outside its authenticated scope.`);
            }
            byId.set(run.runId, run);
            byNumber.set(registrationRunNumber, run);
        }
        if (!byId.has(expectedRunId)) fail(`${phase} rolling snapshot omits the current run.`);
        if (!sameRun(current, byId.get(expectedRunId), true)) {
            fail(`${phase} current run contradicts its rolling workflow-run header.`);
        }
        if (!Array.isArray(snapshot.rolling.registrationIds)) {
            fail(`${phase} rolling workflow-registration identity proof is invalid.`);
        }
        const registrationIds = snapshot.rolling.registrationIds.map((value, index) =>
            positiveDecimal(value, `${phase} rolling registration ${index}`));
        const canonicalRegistrationIds = [...new Set(
            [...byId.values()].map((run) => run.workflowId))]
            .sort((left, right) => left.length - right.length || left.localeCompare(right));
        if (JSON.stringify(registrationIds) !== JSON.stringify(canonicalRegistrationIds) ||
            !canonicalRegistrationIds.includes(workflowId)) {
            fail(`${phase} rolling workflow-registration identity proof is invalid.`);
        }
        snapshots[phase] = { activeWorkflow, current, byId };
    }
    if (evidence.schemaVersion === 7) validateRollingWorkload(
        evidence.snapshots.before.rolling.headers, evidence.snapshots.after.rolling.headers);
    if (!sameRun(snapshots.before.current, snapshots.after.current, true) ||
        snapshots.after.current.updatedAtMilliseconds < snapshots.before.current.updatedAtMilliseconds) {
        fail('The exact current run changed during collection.');
    }
    if (snapshots.before.byId.size !== snapshots.after.byId.size) {
        fail('The rolling workflow-run set changed during collection.');
    }
    for (const [runId, before] of snapshots.before.byId) {
        const after = snapshots.after.byId.get(runId);
        if (!after || !sameRun(before, after, true) ||
            after.updatedAtMilliseconds < before.updatedAtMilliseconds) {
            fail('The rolling workflow-run set changed during collection.');
        }
    }
    for (const key of ['environment', 'branchPolicies', 'branch', 'ref', 'workflow']) {
        if (JSON.stringify(evidence.snapshots.before[key]) !==
            JSON.stringify(evidence.snapshots.after[key])) {
            fail(`The ${key} production control changed during collection.`);
        }
    }
    validateProductionQuiescence(evidence.quiescence, snapshots.before.current, expected.workflowFile);
    for (const phase of ['before', 'after']) {
        const active = new Map(evidence.quiescence[phase].statuses.flatMap((group) =>
            group.runs.map((raw) => {
                const run = runRecord(raw, `${phase} cross-checked active run`);
                return [run.runId, run];
            })));
        for (const run of snapshots[phase].byId.values()) {
            if (!ACTIVE_STATUSES.has(run.status)) continue;
            const observed = active.get(run.runId);
            if (!observed || !sameRun(run, observed, run.runId === expectedRunId) ||
                observed.updatedAtMilliseconds < run.updatedAtMilliseconds) {
                fail('Rolling and active manual-run inventories contradict each other.');
            }
        }
    }

    if (!Number.isSafeInteger(evidence.attemptCount) || evidence.attemptCount < 1 ||
        evidence.attemptCount > 200) {
        fail('The rolling attempt proof is incomplete or outside its bound.');
    }
    exactKeys(evidence.attempts, ['after', 'before'], 'Rolling exact-attempt snapshots');
    const attemptSnapshots = Object.create(null);
    const mainShas = new Set();
    for (const phase of ['before', 'after']) {
        const values = evidence.attempts[phase];
        if (!Array.isArray(values) || values.length !== evidence.attemptCount) {
            fail(`The ${phase} rolling attempt proof is incomplete or outside its bound.`);
        }
        const grouped = new Map();
        const byIdentity = new Map();
        for (const [index, item] of values.entries()) {
            const attempt = runRecord(item, `${phase} rolling attempt ${index}`, true);
            const header = snapshots[phase].byId.get(attempt.runId);
            const identity = `${attempt.runId}\u0000${attempt.runAttempt}`;
            if (!header || attempt.workflowId !== header.workflowId ||
                attempt.repository !== REPOSITORY || attempt.path !== workflow.path ||
                attempt.originalRunCreatedAt !== header.createdAt ||
                attempt.originalRunCreatedAtMilliseconds < lower ||
                attempt.runNumber !== header.runNumber || attempt.headSha !== header.headSha ||
                attempt.headBranch !== header.headBranch || attempt.event !== header.event) {
                fail('A rolling attempt is outside the authenticated run set.');
            }
            if (byIdentity.has(identity)) fail('The rolling attempt proof contains a duplicate.');
            byIdentity.set(identity, attempt);
            if (!grouped.has(attempt.runId)) grouped.set(attempt.runId, []);
            grouped.get(attempt.runId).push(attempt);
            mainShas.add(attempt.headSha);
        }
        if (grouped.size !== snapshots[phase].byId.size) {
            fail('The rolling attempt proof omits a workflow run.');
        }
        for (const [runId, header] of snapshots[phase].byId) {
            const attempts = grouped.get(runId) || [];
            attempts.sort((left, right) => Number(left.runAttempt) - Number(right.runAttempt));
            if (attempts.length !== Number(header.runAttempt)) {
                fail('The rolling attempt proof has a gap.');
            }
            for (let index = 0; index < attempts.length; index += 1) {
                if (attempts[index].runAttempt !== String(index + 1)) {
                    fail('The rolling attempt proof is not contiguous.');
                }
            }
            const latest = attempts[attempts.length - 1];
            // Run envelopes and exact attempts expose different creation/update
            // clocks. Every other identity and state field must still agree.
            if (!RUN_KEYS.every((key) => ['createdAt', 'updatedAt'].includes(key) ||
                latest[key] === header[key])) {
                fail('A rolling latest attempt contradicts its workflow-run header.');
            }
            if (header.headBranch === 'main' && runId !== expectedRunId) {
                if (header.status === 'in_progress') {
                    fail('Another protected-main release is concurrently in progress.');
                }
                if (ACTIVE_STATUSES.has(header.status) &&
                    header.createdAtMilliseconds <= snapshots[phase].current.createdAtMilliseconds) {
                    fail('An older protected-main release remains active.');
                }
                if (header.status === 'completed' &&
                    header.createdAtMilliseconds >= snapshots[phase].current.createdAtMilliseconds) {
                    fail('A later protected-main release completed ahead of the current transaction.');
                }
            }
        }
        attemptSnapshots[phase] = byIdentity;
    }
    for (const [identity, before] of attemptSnapshots.before) {
        const after = attemptSnapshots.after.get(identity);
        const mayAdvance = before.runId === expectedRunId &&
            before.runAttempt === expectedRunAttempt && before.status === 'in_progress';
        if (!after || !sameRun(before, after, mayAdvance) ||
            before.originalRunCreatedAt !== after.originalRunCreatedAt ||
            after.updatedAtMilliseconds < before.updatedAtMilliseconds) {
            fail('An exact rolling attempt changed during collection.');
        }
    }

    exactKeys(evidence.nextAttemptAbsence, ['after', 'before'],
        'Exact next-attempt absence proof');
    for (const phase of ['before', 'after']) {
        const values = evidence.nextAttemptAbsence[phase];
        if (!Array.isArray(values) || values.length !== snapshots[phase].byId.size) {
            fail(`The ${phase} exact next-attempt absence proof is incomplete.`);
        }
        const absenceByRun = new Map();
        for (const [index, item] of values.entries()) {
            exactKeys(item, ['httpStatus', 'nextAttempt', 'runId'],
                `${phase} next-attempt proof ${index}`);
            const runId = positiveDecimal(item.runId, `${phase} next-attempt proof ${index}.runId`);
            const nextAttempt = positiveDecimal(item.nextAttempt,
                `${phase} next-attempt proof ${index}.nextAttempt`);
            if (item.httpStatus !== 404 || absenceByRun.has(runId)) {
                fail(`A ${phase} next-attempt absence proof is invalid or duplicated.`);
            }
            const header = snapshots[phase].byId.get(runId);
            if (!header || BigInt(nextAttempt) !== BigInt(header.runAttempt) + 1n) {
                fail(`A ${phase} next-attempt proof does not follow the exact latest attempt.`);
            }
            absenceByRun.set(runId, true);
        }
    }

    if (!Array.isArray(evidence.sourceVersions) || evidence.sourceVersions.length !== mainShas.size) {
        fail('The historical-source proof is incomplete.');
    }
    const sourceShas = new Set();
    for (const [index, item] of evidence.sourceVersions.entries()) {
        exactKeys(item, ['disposition', 'headSha', 'path', 'reasonCode', 'safeContractVersion', 'sha256'],
            `historical source ${index}`);
        const sha = fullSha(item.headSha, `historical source ${index}.headSha`);
        if (item.path !== workflow.path || ![0, 1].includes(item.safeContractVersion) ||
            typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256) ||
            !mainShas.has(sha) || sourceShas.has(sha)) {
            fail('A historical-source proof is invalid.');
        }
        if (item.safeContractVersion === 1) {
            if (item.disposition !== 'strict-compatible' || item.reasonCode !== null) {
                fail('A compatible historical-source disposition is invalid.');
            }
        } else {
            if (sha === expectedSha || item.disposition !== 'prelaunch-accepted-incompatible' ||
                item.reasonCode !== 'historical_contract_incompatible') {
                fail('Current or unclassified incompatible source cannot enter production.');
            }
            for (const phase of ['before', 'after']) {
                for (const attempt of attemptSnapshots[phase].values()) {
                    if (attempt.headSha === sha &&
                        (attempt.originalRunCreatedAtMilliseconds >= cutoff ||
                            attempt.createdAtMilliseconds >= cutoff ||
                            (attempt.runStartedAtMilliseconds !== null &&
                                attempt.runStartedAtMilliseconds >= cutoff))) {
                        fail('Incompatible history or a rerun after the policy cutoff is not accepted.');
                    }
                }
            }
            warnings.push(Object.freeze({ code: 'historical_source_risk_accepted',
                headSha: sha, path: item.path, sha256: item.sha256 }));
        }
        sourceShas.add(sha);
    }
    if (sourceShas.size !== mainShas.size) fail('A historical source version was not checked.');

    return Object.freeze({
        attemptCount: evidence.attemptCount,
        currentRunId: expectedRunId,
        admitted: true,
        admissionMode: PRODUCTION_ADMISSION_POLICY.mode,
        authorityRetired: false,
        externalCustomerAdmission: false,
        prelaunchRiskAccepted: true,
        safe: warnings.length === 0,
        strictHistorySatisfied: warnings.length === 0,
        warnings: Object.freeze(warnings),
        sourceVersionCount: sourceShas.size,
        workflowId
    });
}

function validateStrictRerunnableProductionSafety(evidence, expected) {
    const result = validateRerunnableProductionSafety(evidence, expected);
    if (!result.strictHistorySatisfied) {
        fail('Strict customer-ready history requires mature registration and compatible historical source.');
    }
    return result;
}

function sourceEnvironmentName(environment) {
    if (typeof environment === 'string') return environment;
    return environment && typeof environment === 'object' ? environment.name : null;
}

function topLevelConjuncts(condition, jobName) {
    const trimmed = condition.trim();
    if (!trimmed.startsWith('${{') || !trimmed.endsWith('}}')) {
        fail(`Historical workflow job ${jobName} must use one explicit expression.`);
    }
    const expression = trimmed.slice(3, -2).trim();
    const factors = [];
    let start = 0;
    let depth = 0;
    let quote = null;
    for (let index = 0; index < expression.length; index += 1) {
        const character = expression[index];
        if (quote !== null) {
            if (character === quote && expression[index - 1] !== '\\') quote = null;
            continue;
        }
        if (character === "'" || character === '"') {
            quote = character;
            continue;
        }
        if (character === '(') depth += 1;
        if (character === ')') {
            depth -= 1;
            if (depth < 0) fail(`Historical workflow job ${jobName} has an invalid condition.`);
        }
        const operator = expression.slice(index, index + 2);
        if (depth === 0 && operator === '||') {
            fail(`Historical workflow job ${jobName} has a top-level OR bypass.`);
        }
        if (depth === 0 && operator === '&&') {
            factors.push(expression.slice(start, index).trim());
            start = index + 2;
            index += 1;
        }
    }
    if (depth !== 0 || quote !== null) {
        fail(`Historical workflow job ${jobName} has an invalid condition.`);
    }
    factors.push(expression.slice(start).trim());
    return factors.map((factor) => factor.replace(/\s+/g, ' '));
}

const AUTHORITY_KEY = /(?:^|[_-])(?:secret|token|password|credentials?|pat|api[_-]?key|access[_-]?key|private[_-]?key)(?:$|[_-])/i;
const SENSITIVE_EXPRESSION = /\b(?:inputs|env|needs|steps|matrix)\b[^}]*\b(?:secret|token|password|credentials?|pat|api[_-]?key|access[_-]?key|private[_-]?key)\b/i;

function approvedSecretBinding(workflow, jobName, step, path, value) {
    if (!step || path.length !== 2 || !['env', 'with'].includes(path[0]) ||
        typeof value !== 'string') {
        return null;
    }
    const match = value.match(/^\$\{\{\s*secrets\.([A-Z][A-Z0-9_]*)\s*\}\}$/);
    if (!match) return null;
    const stepName = typeof step.name === 'string' ? step.name : '';
    const contract = workflow.secretSteps[jobName] && workflow.secretSteps[jobName][stepName];
    const rotatedStaticBinding = contract &&
        contract.bindings === STATIC_WEB_APP_SECRET &&
        path[1] === 'azure_static_web_apps_api_token' &&
        match[1] === ROTATED_STATIC_WEB_APP_SECRET;
    if (!contract || contract.carrier !== path[0] ||
        (contract.bindings[path[1]] !== match[1] && !rotatedStaticBinding)) {
        return null;
    }
    if ((contract.execution === 'run' &&
            (typeof step.run !== 'string' || step.uses !== undefined)) ||
        (contract.execution === 'action' &&
            (step.uses !== contract.action || step.run !== undefined))) {
        return null;
    }
    return `${jobName}\u0000${stepName}\u0000${path[0]}\u0000${path[1]}\u0000${match[1]}`;
}

function isExactGitHubTokenBinding(step, path, value) {
    return Boolean(step && path.length === 2 && path[0] === 'env' && path[1] === 'GH_TOKEN' &&
        value === '${{ github.token }}');
}

function inspectAuthorityValue(value, context, path = []) {
    if (typeof value === 'string') {
        const expressions = [...value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)];
        for (const expression of expressions) {
            const body = expression[1].trim();
            if (/\bsecrets\b/i.test(body)) {
                const binding = approvedSecretBinding(
                    context.workflow, context.jobName, context.step, path, value);
                if (!binding || expressions.length !== 1 || value !== expression[0]) {
                    fail(`Historical workflow job ${context.jobName || '<workflow>'} uses an unreviewed or dynamic secret context.`);
                }
                if (context.secretBindings.has(binding)) {
                    fail(`Historical workflow job ${context.jobName} duplicates a reviewed secret binding.`);
                }
                context.secretBindings.add(binding);
            }
            if (/\bgithub\s*\.\s*token\b/i.test(body) &&
                (!isExactGitHubTokenBinding(context.step, path, value) ||
                    expressions.length !== 1 || value !== expression[0])) {
                fail(`Historical workflow job ${context.jobName || '<workflow>'} exposes github.token outside exact GH_TOKEN binding.`);
            }
            if (/\bvars\b/i.test(body) || SENSITIVE_EXPRESSION.test(body)) {
                fail(`Historical workflow job ${context.jobName || '<workflow>'} uses an unreviewed credential or variable context.`);
            }
            if (/\b(?:toJSON|toJson)\s*\(\s*(?:github|secrets|vars)\s*\)/.test(body)) {
                fail(`Historical workflow job ${context.jobName || '<workflow>'} exposes an authority-bearing context.`);
            }
        }
        return;
    }
    if (value === null || value === undefined || typeof value !== 'object') return;
    if (Array.isArray(value)) {
        value.forEach((item, index) => inspectAuthorityValue(item, context, [...path, String(index)]));
        return;
    }
    for (const [key, child] of Object.entries(value)) {
        const nextPath = [...path, key];
        const parentKey = path[path.length - 1];
        if (key === 'persist-credentials') {
            if (child !== false) {
                fail(`Historical workflow job ${context.jobName || '<workflow>'} may persist unreviewed credentials.`);
            }
        } else if (parentKey !== 'permissions' && AUTHORITY_KEY.test(key)) {
            const approvedSecret = approvedSecretBinding(
                context.workflow, context.jobName, context.step, nextPath, child);
            if (!approvedSecret && !isExactGitHubTokenBinding(context.step, nextPath, child)) {
                fail(`Historical workflow job ${context.jobName || '<workflow>'} declares an unreviewed credential or token field.`);
            }
        }
        inspectAuthorityValue(child, context, nextPath);
    }
}

function validateHistoricalAuthority(workflow, document) {
    const allowedJobs = new Set(workflow.allowedJobs);
    const actualJobs = Object.keys(document.jobs);
    const unexpected = actualJobs.filter((name) => !allowedJobs.has(name));
    if (unexpected.length !== 0) {
        fail(`Historical workflow contains unreviewed jobs: ${unexpected.sort().join(', ')}.`);
    }
    const secretBindings = new Set();
    const workflowMetadata = Object.fromEntries(
        Object.entries(document).filter(([name]) => name !== 'jobs'));
    inspectAuthorityValue(workflowMetadata,
        { jobName: null, secretBindings, step: null, workflow });
    for (const [name, value] of Object.entries(document.jobs)) {
        const job = record(value, `Historical workflow job ${name}`);
        if (job.uses !== undefined || job.secrets !== undefined) {
            fail(`Historical workflow job ${name} may not call a reusable workflow or pass secrets.`);
        }
        if (!['ubuntu-latest', 'ubuntu-24.04'].includes(job['runs-on']) ||
            !Array.isArray(job.steps)) {
            fail(`Historical workflow job ${name} is not an exact reviewed runner/steps job.`);
        }
        if (job.container !== undefined || job.services !== undefined) {
            fail(`Historical workflow job ${name} introduces an unreviewed execution service.`);
        }
        const jobMetadata = Object.fromEntries(
            Object.entries(job).filter(([field]) => field !== 'steps'));
        inspectAuthorityValue(jobMetadata,
            { jobName: name, secretBindings, step: null, workflow });
        for (const [index, value] of job.steps.entries()) {
            const step = record(value, `Historical workflow job ${name} step ${index}`);
            inspectAuthorityValue(step,
                { jobName: name, secretBindings, step, workflow });
        }
    }
}

function validateHistoricalWorkflowSource(workflowFile, source) {
    // Only the unprivileged collector needs YAML parsing. Privileged readback
    // jobs validate the JSON evidence without installing development modules.
    const yaml = require('js-yaml');
    const workflow = WORKFLOWS[workflowFile];
    if (!workflow) fail('The historical workflow filename is unsupported.');
    if (typeof source !== 'string' || !source) fail('Historical workflow source is empty.');
    let document;
    try {
        // Duplicate mappings are rejected. Accepting "last key wins" here
        // would create a parser-differential path around the reviewed guards.
        document = yaml.load(source);
    } catch (error) {
        fail(`Historical workflow YAML is invalid: ${error.message}`);
    }
    record(document, 'Historical workflow');
    if (JSON.stringify(document.permissions) !== JSON.stringify({ contents: 'read' })) {
        fail('Historical workflow permissions are not the exact read-only workflow map.');
    }
    exactKeys(document.concurrency, ['cancel-in-progress', 'group', 'queue'],
        'Historical workflow concurrency');
    if (document.concurrency.group !== 'nofries-production-release' ||
        document.concurrency['cancel-in-progress'] !== false || document.concurrency.queue !== 'max') {
        fail('Historical workflow does not use the fixed non-cancelling production queue.');
    }
    record(document.jobs, 'Historical workflow jobs');
    validateHistoricalAuthority(workflow, document);
    const authorityJobs = [];
    for (const [name, value] of Object.entries(document.jobs)) {
        const job = record(value, `Historical workflow job ${name}`);
        const environment = sourceEnvironmentName(job.environment);
        if (job.environment !== undefined && environment !== 'production') {
            fail(`Historical workflow job ${name} has a dynamic or unreviewed environment.`);
        }
        if (job.permissions !== undefined &&
            (!job.permissions || typeof job.permissions !== 'object' || Array.isArray(job.permissions))) {
            fail(`Historical workflow job ${name} has an ambiguous permission form.`);
        }
        const permissionEntries = Object.entries(job.permissions || {});
        if (permissionEntries.some(([, level]) => !['none', 'read', 'write'].includes(level))) {
            fail(`Historical workflow job ${name} has an unsupported permission level.`);
        }
        const writes = permissionEntries.filter(([, level]) => level === 'write')
            .map(([permission]) => permission);
        const expectedWrite = workflow.writeJobs[name];
        if ((expectedWrite === undefined && writes.length !== 0) ||
            (expectedWrite !== undefined && (writes.length !== 1 || writes[0] !== expectedWrite))) {
            fail(`Historical workflow job ${name} has unreviewed write authority.`);
        }
        const hasOidc = writes.includes('id-token');
        if (environment === 'production' || hasOidc) authorityJobs.push(name);
    }
    if (JSON.stringify(authorityJobs.sort()) !== JSON.stringify([...workflow.mutationJobs].sort())) {
        fail('Historical workflow production authority is not confined to the expected jobs.');
    }
    for (const name of workflow.mutationJobs) {
        const job = document.jobs[name];
        if (sourceEnvironmentName(job.environment) !== 'production' ||
            !job.permissions || job.permissions['id-token'] !== 'write') {
            fail(`Historical workflow job ${name} lacks production/OIDC binding.`);
        }
    }
    for (const name of Object.keys(document.jobs)) {
        const job = document.jobs[name];
        const condition = typeof job.if === 'string' ? job.if : '';
        const factors = topLevelConjuncts(condition, name);
        const requiredFactors = [
            "github.event_name == 'workflow_dispatch'",
            'github.run_attempt == 1',
            "github.ref == 'refs/heads/main'",
            name === 'freshness_witness' ?
                "inputs.witness_for_run_id != ''" : "inputs.witness_for_run_id == ''"
        ];
        const hasProtectedRef = factors.includes('github.ref_protected') ||
            factors.includes('github.ref_protected == true');
        if (!requiredFactors.every((factor) => factors.includes(factor)) || !hasProtectedRef) {
            fail(`Historical workflow job ${name} lacks a rerun/ref/witness execution guard.`);
        }
    }
    return Object.freeze({
        headDigest: crypto.createHash('sha256').update(source).digest('hex'),
        safeContractVersion: 1,
        workflowPath: workflow.path
    });
}

function assessHistoricalWorkflowSource(workflowFile, source, { headSha, currentSha } = {}) {
    fullSha(headSha, 'Assessed source SHA');
    fullSha(currentSha, 'Current source SHA');
    if (!WORKFLOWS[workflowFile] || typeof source !== 'string' || !source) {
        fail('Assessed historical source is unavailable.');
    }
    // Parse failures are not a policy exception: only an authenticated, parsed
    // old workflow's stricter contract incompatibility can be classified.
    const yaml = require('js-yaml');
    let parsed;
    try { parsed = yaml.load(source); } catch { fail('Assessed historical YAML is invalid.'); }
    record(parsed, 'Assessed historical workflow');
    let compatible = true;
    try {
        validateHistoricalWorkflowSource(workflowFile, source);
    } catch (error) {
        if (headSha === currentSha || !(error instanceof RerunnableProductionSafetyError)) throw error;
        compatible = false;
    }
    return Object.freeze({
        headSha, path: WORKFLOWS[workflowFile].path,
        sha256: crypto.createHash('sha256').update(source).digest('hex'),
        safeContractVersion: compatible ? 1 : 0,
        disposition: compatible ? 'strict-compatible' : 'prelaunch-accepted-incompatible',
        reasonCode: compatible ? null : 'historical_contract_incompatible'
    });
}

function parseArguments(argv) {
    const values = Object.create(null);
    for (let index = 0; index < argv.length; index += 2) {
        if (!argv[index] || !argv[index].startsWith('--') || argv[index + 1] === undefined) {
            fail('CLI arguments must be --name value pairs.');
        }
        values[argv[index].slice(2)] = argv[index + 1];
    }
    return values;
}

function main() {
    const [mode, ...rest] = process.argv.slice(2);
    const args = parseArguments(rest);
    if (mode === 'workload') {
        exactKeys(args, ['after', 'before'], 'Workload-validation arguments');
        validateRollingWorkload(JSON.parse(fs.readFileSync(args.before, 'utf8')),
            JSON.parse(fs.readFileSync(args.after, 'utf8')));
        return;
    }
    if (mode === 'source') {
        exactKeys(args, ['input', 'workflow'], 'Source-validation arguments');
        validateHistoricalWorkflowSource(args.workflow, fs.readFileSync(args.input, 'utf8'));
        return;
    }
    if (mode === 'evidence') {
        exactKeys(args, ['attempt', 'input', 'run', 'sha', 'workflow'],
            'Evidence-validation arguments');
        validateRerunnableProductionSafety(
            JSON.parse(fs.readFileSync(args.input, 'utf8')),
            { currentRunAttempt: args.attempt, currentRunId: args.run,
                currentSha: args.sha, workflowFile: args.workflow });
        return;
    }
    if (mode === 'source-assessment') {
        exactKeys(args, ['current-sha', 'head-sha', 'input', 'workflow'], 'Source assessment arguments');
        const result = assessHistoricalWorkflowSource(args.workflow, fs.readFileSync(args.input, 'utf8'),
            { currentSha: args['current-sha'], headSha: args['head-sha'] });
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return;
    }
    if (mode === 'policy') {
        exactKeys(args, [], 'Policy arguments');
        process.stdout.write(`${JSON.stringify({ admissionPolicy: PRODUCTION_ADMISSION_POLICY,
            admissionPolicySha256: PRODUCTION_ADMISSION_POLICY_SHA256 })}\n`);
        return;
    }
    if (mode === 'quiescence') {
        exactKeys(args, ['attempt', 'evidence', 'input', 'run', 'sha', 'workflow'], 'Quiescence arguments');
        const original = JSON.parse(fs.readFileSync(args.evidence, 'utf8'));
        validateRerunnableProductionSafety(original, { currentRunAttempt: args.attempt,
            currentRunId: args.run, currentSha: args.sha, workflowFile: args.workflow });
        validateProductionQuiescence(JSON.parse(fs.readFileSync(args.input, 'utf8')),
            runRecord(original.snapshots.before.currentRun, 'Original current release'), args.workflow);
        return;
    }
    fail('Expected source, source-assessment, workload, policy, quiescence or evidence validation mode.');
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`${error.code || 'rerunnable_production_safety_invalid'}: ${error.message}`);
        process.exit(1);
    }
}

module.exports = {
    REPOSITORY,
    RerunnableProductionSafetyError,
    WORKFLOWS,
    PRODUCTION_ADMISSION_POLICY,
    PRODUCTION_ADMISSION_POLICY_SHA256,
    QUIESCENCE_STATUSES,
    assessHistoricalWorkflowSource,
    validateProductionQuiescence,
    validateHistoricalWorkflowSource,
    validateRollingWorkload,
    validateRerunnableProductionSafety,
    validateStrictRerunnableProductionSafety
};
