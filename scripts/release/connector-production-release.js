'use strict';

const crypto = require('crypto');
const zlib = require('zlib');
const {
    validateRerunnableProductionSafety
} = require('./rerunnable-production-safety.js');

const FULL_SHA = /^[0-9a-f]{40}$/;
const POSITIVE_ID = /^[1-9][0-9]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CONNECTOR_BOOTSTRAP_SHA = '501c38017eb1ad7ae5fa6a8323b38b55c92eb4a8';
const CONNECTOR_BOOTSTRAP_RUN_ID = '33294841371';
const CONNECTOR_BOOTSTRAP_RUN_ATTEMPT = '1';
const NON_SUCCESS_CONCLUSIONS = Object.freeze(new Set([
    'action_required',
    'cancelled',
    'failure',
    'neutral',
    'skipped',
    'stale',
    'startup_failure',
    'timed_out'
]));
const COMPLETED_CONCLUSIONS = Object.freeze(new Set([
    'success', ...NON_SUCCESS_CONCLUSIONS
]));
const ACTIVE_RUN_STATUSES = Object.freeze(new Set([
    'in_progress', 'pending', 'queued', 'requested', 'waiting'
]));

const MAX_ARTIFACT_ZIP_BYTES = 256 * 1024 * 1024;
const MAX_RECOVERY_TAR_BYTES = 256 * 1024 * 1024;
const MAX_RECOVERY_MEMBER_BYTES = 128 * 1024 * 1024;
const MAX_RECOVERY_MEMBERS = 64;

const RECOVERY_TAR_DIRECTORIES = Object.freeze(new Set([
    'release/',
    'release/candidate/',
    'release/rollback/',
    'release/evidence/'
]));

const RECOVERY_TAR_FILES = Object.freeze(new Set([
    'automatic-recovery-provenance-expected.json',
    'automatic-recovery-provenance.json',
    'automatic-recovery-validation.json',
    'pre-canary-receipt.json',
    'production-preflight.json',
    'production-preflight.sha256',
    'protection.json',
    'release/candidate/connector-function.zip',
    'release/candidate/package-manifest.json',
    'release/connector-package-bundle.json',
    'release/connector-package-bundle.sha256',
    'release/connector-package-manifest.json',
    'release/connector-release-manifest-expected.json',
    'release/connector-release-manifest.json',
    'release/connector-release-manifest.sha256',
    'release/rollback-lineage.json',
    'release/rollback/connector-function.zip',
    'release/rollback/package-manifest.json',
    'release/evidence/app-health.json',
    'release/evidence/app-production-delta.txt',
    'release/evidence/app-release.json',
    'release/evidence/candidate-source.json',
    'release/evidence/ci-provenance-expected.json',
    'release/evidence/ci-provenance.json',
    'release/evidence/ci-run.json',
    'release/evidence/connector-health.json',
    'release/evidence/connector-production-delta.txt',
    'release/evidence/exact-rollback-control.json',
    'release/evidence/exact-rollback-validation.json',
    'release/evidence/live-eval-artifact.json',
    'release/evidence/live-eval-provenance-expected.json',
    'release/evidence/live-eval-provenance.json',
    'release/evidence/live-eval-run.json',
    'release/evidence/previous-app-provenance-expected.json',
    'release/evidence/previous-app-provenance.json',
    'release/evidence/previous-app-run.json',
    'release/evidence/previous-connector-provenance-expected.json',
    'release/evidence/previous-connector-provenance.json',
    'release/evidence/previous-connector-release-artifacts.json',
    'release/evidence/previous-connector-run.json',
    'release/evidence/prospect-live.json',
    'release/evidence/release-request-control.json',
    'release/evidence/rollback-source.json',
    'release/evidence/validated-package-bundle.json'
]));

const EXPECTED_CONNECTOR_RELEASE = Object.freeze({
    schemaVersion: 1,
    repository: 'Discla1mer/NoFries',
    ref: 'refs/heads/main',
    workflowPath: '.github/workflows/release-connector-production.yml',
    connectorResourceGroup: 'nofrieswebsite',
    connectorName: 'nofries-agent-connector-flex',
    connectorService: 'nofries-agent-connector'
});

const RELEASABLE_CONNECTOR_IMPACT = Object.freeze(new Set([
    'release/connector-package-manifest.json',
    'package-lock.json',
    'package.json',
    'connector-functions/health/function.json',
    'connector-functions/health/index.js',
    'connector-functions/host.json',
    'connector-functions/mcp/function.json',
    'connector-functions/mcp/index.js',
    'connector-functions/mcpAuth/function.json',
    'connector-functions/mcpAuth/index.js',
    'connector-functions/mcpProtectedResource/function.json',
    'connector-functions/mcpProtectedResource/index.js',
    'connector-functions/mcpProtectedResourcePath/function.json',
    'connector-functions/mcpProtectedResourcePath/index.js',
    'connector-functions/package.json',
    'connector-functions/sharedRuntime.js',
    'api/shared/abuseProtection.js',
    'api/shared/browserAuth.js',
    'api/shared/browserSessionStore.js',
    'api/shared/customerSignup/customerIdentityProviderProfile.js',
    'api/shared/database/postgres.js',
    'api/shared/identity.js',
    'api/shared/lifecycle/customerOperations.js',
    'api/shared/lifecycle/lifecycleModel.js',
    'api/shared/lifecycle/lifecycleRepository.js',
    'api/shared/lifecycle/lifecycleService.js',
    'api/shared/lifecycle/lifecycleState.js',
    'api/shared/lifecycle/postgresLifecycleRepository.js',
    'api/shared/lifecycleRuntime.js',
    'api/shared/mcpAuth.js',
    'api/shared/mcpRuntime.js',
    'api/shared/nofriesCatalogue.js',
    'api/shared/proposalApprovalProvider.js',
    'api/shared/proposalApprovalSeal.js',
    'api/shared/releaseIdentity.js',
    'api/shared/releaseManifest.json',
    'api/shared/requestLimits.js',
    'api/shared/salesWorkspaceRepository.js',
    'api/shared/securityHeaders.js',
    'api/shared/tenantAccess.js'
]));

const VALID_PLANS = new WeakSet();
const VALID_STATES = new WeakSet();
const VALID_ARTIFACT_EVIDENCE = new WeakSet();

class ConnectorProductionReleaseError extends Error {
    constructor(code, message) {
        super(`${code}:${message}`);
        this.name = 'ConnectorProductionReleaseError';
        this.code = code;
    }
}

function fail(code, message) {
    throw new ConnectorProductionReleaseError(code, message);
}

function plain(value, code, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype) {
        fail(code, `${label} must be a plain object.`);
    }
    return value;
}

function exactKeys(value, expected, code, label) {
    plain(value, code, label);
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
        fail(code, `${label} has an extra or missing field.`);
    }
}

function exactString(value, expected, code, label) {
    if (value !== expected) fail(code, `${label} is not the reviewed value.`);
    return value;
}

function fullSha(value, code, label) {
    if (typeof value !== 'string' || !FULL_SHA.test(value)) {
        fail(code, `${label} must be a lowercase full commit SHA.`);
    }
    return value;
}

function positiveId(value, code, label) {
    const text = typeof value === 'number' && Number.isSafeInteger(value)
        ? String(value)
        : value;
    if (typeof text !== 'string' || !POSITIVE_ID.test(text)) {
        fail(code, `${label} must be a positive decimal identifier.`);
    }
    return text;
}

function canonicalTimestamp(value, code, label) {
    if (typeof value !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
        fail(code, `${label} must be a canonical UTC timestamp with second precision.`);
    }
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds) ||
        new Date(milliseconds).toISOString().replace('.000Z', 'Z') !== value) {
        fail(code, `${label} must be a real canonical UTC timestamp.`);
    }
    return milliseconds;
}

function digest(value, code, label, prefix = false) {
    if (typeof value !== 'string') fail(code, `${label} must be a SHA-256 digest.`);
    const text = prefix ? value.replace(/^sha256:/, '') : value;
    if (!SHA256.test(text) || (prefix && value !== `sha256:${text}`)) {
        fail(code, `${label} must be a lowercase SHA-256 digest${prefix ? ' with sha256: prefix' : ''}.`);
    }
    return text;
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function bytes(value, code, label) {
    if (!Buffer.isBuffer(value)) fail(code, `${label} must be trusted bytes.`);
    return value;
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const entry of Object.values(value)) deepFreeze(entry);
    return Object.freeze(value);
}

function snapshot(value) {
    return deepFreeze(JSON.parse(JSON.stringify(value)));
}

function validateConnectorReleaseRequest(request) {
    const code = 'connector_release_request_invalid';
    const captureSpecified = request != null &&
        Object.prototype.hasOwnProperty.call(request, 'captureCanaryBinding');
    exactKeys(request, [
        'bootstrapConfirmation', 'confirmation', 'liveEvalRunId', 'operation', 'ref',
        'releaseSha', 'repository', 'rollbackMode', 'workflowRunAttempt',
        'workflowRunId', 'workflowSha', ...(captureSpecified ? ['captureCanaryBinding'] : [])
    ], code, 'Connector release request');
    if (captureSpecified && typeof request.captureCanaryBinding !== 'boolean') {
        fail('connector_release_request_capture_canary_binding',
            'captureCanaryBinding must be a boolean when supplied.');
    }
    exactString(request.operation, 'release', 'connector_release_request_operation', 'operation');
    exactString(request.confirmation, 'RELEASE-NOFRIES-CONNECTOR-PRODUCTION',
        'connector_release_request_confirmation', 'confirmation');
    exactString(request.ref, EXPECTED_CONNECTOR_RELEASE.ref,
        'connector_release_request_ref', 'ref');
    exactString(request.repository, EXPECTED_CONNECTOR_RELEASE.repository,
        'connector_release_request_repository', 'repository');
    const releaseSha = fullSha(request.releaseSha,
        'connector_release_request_release_sha', 'releaseSha');
    const workflowSha = fullSha(request.workflowSha,
        'connector_release_request_workflow_sha', 'workflowSha');
    if (workflowSha !== releaseSha) {
        fail('connector_release_request_workflow_sha', 'The workflow SHA must equal the exact release SHA.');
    }
    positiveId(request.workflowRunId,
        'connector_release_request_workflow_run_id', 'workflowRunId');
    positiveId(request.workflowRunAttempt,
        'connector_release_request_workflow_run_attempt', 'workflowRunAttempt');
    positiveId(request.liveEvalRunId,
        'connector_release_request_live_eval_run_id', 'liveEvalRunId');
    if (!['exact-artifact', 'source-reconstructed-bootstrap'].includes(request.rollbackMode)) {
        fail('connector_release_request_rollback_mode', 'The rollback mode is not reviewed.');
    }
    if (request.rollbackMode === 'exact-artifact') {
        exactString(request.bootstrapConfirmation, '',
            'connector_release_request_bootstrap_confirmation', 'bootstrapConfirmation');
    } else {
        exactString(request.bootstrapConfirmation,
            `ACCEPT-SOURCE-RECONSTRUCTED-BOOTSTRAP-ROLLBACK:${releaseSha}`,
            'connector_release_request_bootstrap_confirmation', 'bootstrapConfirmation');
    }
    return Object.freeze({ ...request });
}

function validateConnectorRecoveryControl(control) {
    const code = 'connector_recovery_control_invalid';
    const captureSpecified = control != null &&
        Object.prototype.hasOwnProperty.call(control, 'captureCanaryBinding');
    exactKeys(control, [
        'confirmation', 'currentRunAttempt', 'currentRunId', 'operation', 'recoveryRunAttempt',
        'recoveryRunId', 'ref', 'releaseSha', 'repository', 'workflowSha',
        ...(captureSpecified ? ['captureCanaryBinding'] : [])
    ], code, 'Connector recovery control');
    if (captureSpecified && control.captureCanaryBinding !== false) {
        fail('connector_recovery_control_capture_canary_binding',
            'Canary binding capture must remain disabled for recovery.');
    }
    exactString(control.operation, 'recover', 'connector_recovery_control_operation', 'operation');
    exactString(control.confirmation, 'RECOVER-NOFRIES-CONNECTOR-PRODUCTION',
        'connector_recovery_control_confirmation', 'confirmation');
    exactString(control.ref, EXPECTED_CONNECTOR_RELEASE.ref,
        'connector_recovery_control_ref', 'ref');
    exactString(control.repository, EXPECTED_CONNECTOR_RELEASE.repository,
        'connector_recovery_control_repository', 'repository');
    const releaseSha = fullSha(control.releaseSha,
        'connector_recovery_control_release_sha', 'releaseSha');
    const workflowSha = fullSha(control.workflowSha,
        'connector_recovery_control_workflow_sha', 'workflowSha');
    if (workflowSha !== releaseSha) {
        fail('connector_recovery_control_workflow_sha', 'Recovery must execute from the exact protected-main controller SHA.');
    }
    const currentRunId = positiveId(control.currentRunId,
        'connector_recovery_control_current_run_id', 'currentRunId');
    positiveId(control.currentRunAttempt,
        'connector_recovery_control_current_run_attempt', 'currentRunAttempt');
    const recoveryRunId = positiveId(control.recoveryRunId,
        'connector_recovery_control_recovery_run_id', 'recoveryRunId');
    positiveId(control.recoveryRunAttempt,
        'connector_recovery_control_recovery_run_attempt', 'recoveryRunAttempt');
    if (currentRunId === recoveryRunId) {
        fail('connector_recovery_control_origin_alias', 'Recovery cannot name its own run as the origin.');
    }
    return Object.freeze({ ...control });
}

function validateConnectorRunProvenance(run, expected) {
    exactKeys(run, [
        'conclusion', 'event', 'headBranch', 'headSha', 'path', 'repository',
        'runAttempt', 'runId', 'status'
    ], 'connector_run_provenance_invalid', 'Connector workflow run');
    exactKeys(expected, [
        'conclusion', 'event', 'headBranch', 'headSha', 'path', 'repository',
        'runAttempt', 'runId', 'status'
    ],
        'connector_run_provenance_expected_invalid', 'Expected connector workflow run');
    const runId = positiveId(expected.runId,
        'connector_run_provenance_run_id', 'expected runId');
    const runAttempt = positiveId(expected.runAttempt,
        'connector_run_provenance_attempt', 'expected runAttempt');
    const releaseSha = fullSha(expected.headSha,
        'connector_run_provenance_sha', 'expected headSha');
    exactString(expected.conclusion, 'success',
        'connector_run_provenance_conclusion', 'expected conclusion');
    exactString(expected.status, 'completed',
        'connector_run_provenance_status', 'expected status');
    if (!['push', 'workflow_dispatch'].includes(expected.event)) {
        fail('connector_run_provenance_event', 'Expected run event is not an approved release evidence event.');
    }
    exactString(expected.headBranch, 'main',
        'connector_run_provenance_branch', 'expected headBranch');
    exactString(expected.repository, EXPECTED_CONNECTOR_RELEASE.repository,
        'connector_run_provenance_repository', 'expected repository');
    const allowedPaths = new Set([
        '.github/workflows/ci.yml',
        '.github/workflows/prospect-live-eval.yml',
        '.github/workflows/release-connector-production.yml',
        '.github/workflows/release-production.yml',
        '.github/workflows/release-unified-production.yml'
    ]);
    if (!allowedPaths.has(expected.path)) {
        fail('connector_run_provenance_path', 'Expected workflow path is not approved release evidence.');
    }
    if (positiveId(run.runId, 'connector_run_provenance_run_id', 'run.runId') !== runId) {
        fail('connector_run_provenance_run_id', 'Connector run ID does not match.');
    }
    if (positiveId(run.runAttempt, 'connector_run_provenance_attempt', 'run.runAttempt') !== runAttempt) {
        fail('connector_run_provenance_attempt', 'Connector run attempt does not match.');
    }
    exactString(run.conclusion, expected.conclusion,
        'connector_run_provenance_conclusion', 'run.conclusion');
    exactString(run.status, expected.status,
        'connector_run_provenance_status', 'run.status');
    exactString(run.event, expected.event,
        'connector_run_provenance_event', 'run.event');
    exactString(run.headBranch, expected.headBranch,
        'connector_run_provenance_branch', 'run.headBranch');
    exactString(run.headSha, releaseSha, 'connector_run_provenance_sha', 'run.headSha');
    exactString(run.path, expected.path,
        'connector_run_provenance_path', 'run.path');
    exactString(run.repository, expected.repository,
        'connector_run_provenance_repository', 'run.repository');
    return Object.freeze({ releaseSha, runId, runAttempt });
}

function validateConnectorReleaseManifest(bundle, expected, packageBundle) {
    const invalid = 'connector_bundle_invalid';
    exactKeys(bundle, ['schemaVersion', 'kind', 'origin', 'cumulativeDelta', 'candidate', 'rollback'],
        invalid, 'Connector release bundle');
    if (bundle.schemaVersion !== 1) fail('connector_bundle_schema', 'Connector release bundle schemaVersion must be 1.');
    exactString(bundle.kind, 'nofries-connector-release-manifest',
        'connector_bundle_kind', 'Connector release manifest kind');
    exactKeys(expected, [
        'appBaselineSha', 'connectorBaselineRunAttempt', 'connectorBaselineRunId',
        'connectorBaselineSha', 'liveEvalRunId',
        'releaseRunAttempt', 'releaseRunId', 'targetSha', 'workflowSha'
    ], 'connector_bundle_expected_invalid', 'Expected connector bundle identity');
    const targetSha = fullSha(expected.targetSha, 'connector_bundle_target_sha', 'targetSha');
    const connectorBaselineSha = fullSha(expected.connectorBaselineSha,
        'connector_bundle_connector_baseline', 'connectorBaselineSha');
    const appBaselineSha = fullSha(expected.appBaselineSha,
        'connector_bundle_app_baseline', 'appBaselineSha');
    const workflowSha = fullSha(expected.workflowSha,
        'connector_bundle_workflow_sha', 'workflowSha');
    const releaseRunId = positiveId(expected.releaseRunId,
        'connector_bundle_run_id', 'releaseRunId');
    const releaseRunAttempt = positiveId(expected.releaseRunAttempt,
        'connector_bundle_run_attempt', 'releaseRunAttempt');
    const connectorBaselineRunId = positiveId(expected.connectorBaselineRunId,
        'connector_bundle_rollback_run_id', 'connectorBaselineRunId');
    const connectorBaselineRunAttempt = positiveId(expected.connectorBaselineRunAttempt,
        'connector_bundle_rollback_run_attempt', 'connectorBaselineRunAttempt');
    const liveEvalRunId = positiveId(expected.liveEvalRunId,
        'connector_bundle_live_eval_run_id', 'liveEvalRunId');
    if (workflowSha !== targetSha) fail('connector_bundle_workflow_sha', 'Workflow SHA must equal target SHA.');
    if (connectorBaselineSha === targetSha) {
        fail('connector_bundle_candidate_rollback_alias', 'Candidate and rollback SHAs must differ.');
    }

    exactKeys(bundle.origin, [
        'repository', 'ref', 'workflowPath', 'workflowSha', 'releaseSha',
        'runId', 'runAttempt', 'liveEvalRunId'
    ], invalid, 'Connector bundle origin');
    exactString(bundle.origin.repository, EXPECTED_CONNECTOR_RELEASE.repository,
        'connector_bundle_repository', 'origin.repository');
    exactString(bundle.origin.ref, EXPECTED_CONNECTOR_RELEASE.ref,
        'connector_bundle_ref', 'origin.ref');
    exactString(bundle.origin.workflowPath, EXPECTED_CONNECTOR_RELEASE.workflowPath,
        'connector_bundle_workflow_path', 'origin.workflowPath');
    if (fullSha(bundle.origin.workflowSha, 'connector_bundle_workflow_sha', 'origin.workflowSha') !== workflowSha ||
        fullSha(bundle.origin.releaseSha, 'connector_bundle_release_sha', 'origin.releaseSha') !== targetSha) {
        fail('connector_bundle_origin_mismatch', 'Bundle origin does not match the exact target/controller SHA.');
    }
    if (positiveId(bundle.origin.runId, 'connector_bundle_run_id', 'origin.runId') !== releaseRunId ||
        positiveId(bundle.origin.runAttempt, 'connector_bundle_run_attempt', 'origin.runAttempt') !== releaseRunAttempt) {
        fail('connector_bundle_origin_mismatch', 'Bundle origin run does not match.');
    }
    if (positiveId(bundle.origin.liveEvalRunId,
        'connector_bundle_live_eval_run_id', 'origin.liveEvalRunId') !== liveEvalRunId) {
        fail('connector_bundle_live_eval_run_id', 'Bundle live-evaluation run does not match.');
    }

    exactKeys(bundle.cumulativeDelta, ['appBaselineSha', 'connectorBaselineSha', 'targetSha'],
        invalid, 'Connector cumulative delta');
    if (fullSha(bundle.cumulativeDelta.appBaselineSha,
        'connector_bundle_app_baseline', 'cumulativeDelta.appBaselineSha') !== appBaselineSha ||
        fullSha(bundle.cumulativeDelta.connectorBaselineSha,
        'connector_bundle_connector_baseline', 'cumulativeDelta.connectorBaselineSha') !== connectorBaselineSha ||
        fullSha(bundle.cumulativeDelta.targetSha,
        'connector_bundle_target_sha', 'cumulativeDelta.targetSha') !== targetSha) {
        fail('connector_bundle_cumulative_delta', 'Bundle cumulative delta identity does not match.');
    }

    const candidate = validateBundleRole(bundle.candidate, {
        archive: 'candidate/connector-function.zip', releaseSha: targetSha,
        runId: releaseRunId, runAttempt: releaseRunAttempt
    }, 'candidate');
    const rollback = validateBundleRole(bundle.rollback, {
        archive: 'rollback/connector-function.zip', releaseSha: connectorBaselineSha,
        runId: connectorBaselineRunId, runAttempt: connectorBaselineRunAttempt
    }, 'rollback');
    if (rollback.runId === candidate.runId ||
        bundle.rollback.archiveSha256 === bundle.candidate.archiveSha256 ||
        bundle.rollback.manifestSha256 === bundle.candidate.manifestSha256) {
        fail('connector_bundle_candidate_rollback_alias', 'Candidate and rollback identities or bytes are aliased.');
    }
    validatePackageBundleLink(packageBundle, bundle, releaseRunAttempt);
    return Object.freeze({
        appBaselineSha,
        connectorBaselineRunAttempt,
        connectorBaselineSha,
        targetSha,
        releaseRunId,
        releaseRunAttempt
    });
}

function validatePackageBundleLink(packageBundle, releaseManifest, expectedAttempt) {
    exactKeys(packageBundle, [
        'schemaVersion', 'kind', 'closureManifestSha256', 'run', 'candidate', 'rollback'
    ], 'connector_package_bundle_invalid', 'Connector package bundle');
    if (packageBundle.schemaVersion !== 1 || packageBundle.kind !== 'nofries-connector-package-bundle') {
        fail('connector_package_bundle_invalid', 'Connector package bundle schema or kind is invalid.');
    }
    digest(packageBundle.closureManifestSha256,
        'connector_package_bundle_invalid', 'packageBundle.closureManifestSha256');
    exactKeys(packageBundle.run, ['id', 'attempt'],
        'connector_package_bundle_invalid', 'Connector package bundle run');
    const packageRunId = positiveId(packageBundle.run.id,
        'connector_package_bundle_invalid', 'packageBundle.run.id');
    if (!Number.isInteger(packageBundle.run.attempt) || String(packageBundle.run.attempt) !== expectedAttempt) {
        fail('connector_package_bundle_invalid', 'Connector package bundle attempt does not match.');
    }
    for (const roleName of ['candidate', 'rollback']) {
        const role = packageBundle[roleName];
        const manifestRole = releaseManifest[roleName];
        exactKeys(role, [
            'sourceSha', 'releaseRunId', 'releaseRunAttempt', 'archive', 'packageManifest'
        ],
            'connector_package_bundle_invalid', `Connector package bundle ${roleName}`);
        exactKeys(role.archive, ['path', 'bytes', 'sha256'],
            'connector_package_bundle_invalid', `Connector package bundle ${roleName} archive`);
        exactKeys(role.packageManifest, ['path', 'sha256'],
            'connector_package_bundle_invalid', `Connector package bundle ${roleName} package manifest`);
        const expectedArchivePath = `${roleName}/connector-function.zip`;
        const expectedManifestPath = `${roleName}/package-manifest.json`;
        exactString(role.archive.path, expectedArchivePath,
            'connector_package_bundle_invalid', `${roleName}.archive.path`);
        exactString(role.packageManifest.path, expectedManifestPath,
            'connector_package_bundle_invalid', `${roleName}.packageManifest.path`);
        if (!Number.isSafeInteger(role.archive.bytes) || role.archive.bytes < 1) {
            fail('connector_package_bundle_invalid', `${roleName} archive byte count is invalid.`);
        }
        const sourceSha = fullSha(role.sourceSha,
            'connector_package_bundle_invalid', `${roleName}.sourceSha`);
        const runId = positiveId(role.releaseRunId,
            'connector_package_bundle_invalid', `${roleName}.releaseRunId`);
        const runAttempt = positiveId(role.releaseRunAttempt,
            'connector_package_bundle_invalid', `${roleName}.releaseRunAttempt`);
        if (sourceSha !== manifestRole.releaseSha || runId !== String(manifestRole.runId) ||
            runAttempt !== String(manifestRole.runAttempt) ||
            digest(role.archive.sha256, 'connector_package_bundle_invalid', `${roleName}.archive.sha256`) !== manifestRole.archiveSha256 ||
            digest(role.packageManifest.sha256, 'connector_package_bundle_invalid', `${roleName}.packageManifest.sha256`) !== manifestRole.manifestSha256) {
            fail('connector_package_bundle_link_invalid', `Connector ${roleName} package evidence is not bound to the release manifest.`);
        }
        if (roleName === 'candidate' && runId !== packageRunId) {
            fail('connector_package_bundle_link_invalid', 'Candidate package run is not the package-build run.');
        }
    }
}

function validateBundleRole(role, expected, name) {
    exactKeys(role, ['releaseSha', 'runId', 'runAttempt', 'archive', 'archiveSha256', 'manifestSha256'],
        'connector_bundle_invalid', `Connector ${name} bundle entry`);
    if (fullSha(role.releaseSha, `connector_bundle_${name}_sha`, `${name}.releaseSha`) !== expected.releaseSha) {
        fail(`connector_bundle_${name}_sha`, `${name} release SHA does not match.`);
    }
    const runId = positiveId(role.runId, `connector_bundle_${name}_run_id`, `${name}.runId`);
    if (runId !== expected.runId) {
        fail(`connector_bundle_${name}_run_id`, `${name} run ID does not match.`);
    }
    const runAttempt = positiveId(role.runAttempt,
        `connector_bundle_${name}_run_attempt`, `${name}.runAttempt`);
    if (runAttempt !== expected.runAttempt) {
        fail(`connector_bundle_${name}_run_attempt`, `${name} run attempt does not match.`);
    }
    exactString(role.archive, expected.archive, `connector_bundle_${name}_archive`, `${name}.archive`);
    digest(role.archiveSha256, `connector_bundle_${name}_archive_digest`, `${name}.archiveSha256`);
    digest(role.manifestSha256, `connector_bundle_${name}_manifest_digest`, `${name}.manifestSha256`);
    return Object.freeze({ runId, runAttempt });
}

function validateImpact(impact) {
    exactKeys(impact, ['safe', 'impacts'], 'connector_release_admission_impact', 'Connector impact');
    if (typeof impact.safe !== 'boolean' || !Array.isArray(impact.impacts) ||
        impact.impacts.some((entry) => typeof entry !== 'string')) {
        fail('connector_release_admission_impact', 'Connector impact shape is invalid.');
    }
    const sorted = [...impact.impacts].sort();
    if (new Set(sorted).size !== sorted.length || JSON.stringify(sorted) !== JSON.stringify(impact.impacts) ||
        impact.safe !== (impact.impacts.length === 0)) {
        fail('connector_release_admission_impact', 'Connector impact classification is inconsistent.');
    }
    for (const entry of impact.impacts) {
        if (!entry || entry.startsWith('/') || entry.includes('\\') ||
            entry.split('/').some((part) => !part || part === '.' || part === '..') ||
            !RELEASABLE_CONNECTOR_IMPACT.has(entry)) {
            fail('connector_release_admission_impact', `Connector impact is outside the standalone package boundary: ${entry}`);
        }
    }
    return impact;
}

function validateStandaloneConnectorImpact(impact, pendingAppImpact) {
    const validated = validateImpact(impact);
    const app = pendingAppImpact === undefined ? null : validateImpact(pendingAppImpact);
    // A controller-only main advance can require new exact-SHA provenance for
    // connector inputs already deployed while the older app is still pending.
    const admitted = validated.safe ? app : validated;
    if (!admitted || admitted.safe || admitted.impacts.length === 0) {
        fail('connector_standalone_impact_required',
            'A standalone connector release requires admitted connector impact from the connector or pending app baseline.');
    }
    return admitted;
}

function recordedDigest(value, expectedName, code, label) {
    const text = Buffer.isBuffer(value) ? value.toString('utf8').trim() : String(value || '').trim();
    const match = new RegExp(`^([0-9a-f]{64})(?: {2}${expectedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})?$`).exec(text);
    if (!match) fail(code, `${label} is not an exact SHA-256 record.`);
    return match[1];
}

function boundedBytes(value, maximum, code, label) {
    const buffer = bytes(value, code, label);
    if (buffer.length < 1 || buffer.length > maximum) {
        fail(code, `${label} exceeds its reviewed byte bounds.`);
    }
    return buffer;
}

let crc32Table;

function crc32(buffer) {
    if (!crc32Table) {
        crc32Table = new Uint32Array(256);
        for (let index = 0; index < 256; index += 1) {
            let value = index;
            for (let bit = 0; bit < 8; bit += 1) {
                value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
            }
            crc32Table[index] = value >>> 0;
        }
    }
    let value = 0xffffffff;
    for (const byte of buffer) value = crc32Table[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
}

function validateZipExtra(extra, code, label) {
    const identifiers = new Set();
    let offset = 0;
    while (offset < extra.length) {
        if (offset + 4 > extra.length) fail(code, `${label} has a truncated field header.`);
        const identifier = extra.readUInt16LE(offset);
        const length = extra.readUInt16LE(offset + 2);
        offset += 4;
        if (offset + length > extra.length) fail(code, `${label} has a truncated field value.`);
        if (identifiers.has(identifier)) fail(code, `${label} repeats an extra-field identifier.`);
        identifiers.add(identifier);
        if (identifier === 0x0001 || identifier === 0x9901) {
            fail(code, `${label} uses an unsupported ZIP64 or encrypted extension.`);
        }
        offset += length;
    }
}

function exactZipName(buffer, expected, code, label) {
    const expectedBytes = Buffer.from(expected, 'utf8');
    if (!buffer.equals(expectedBytes)) fail(code, `${label} is not the reviewed member name.`);
}

function findExactZipEndRecord(archive, code) {
    const minimumOffset = Math.max(0, archive.length - 22 - 0xffff);
    const matches = [];
    for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
        if (archive.readUInt32LE(offset) !== 0x06054b50) continue;
        const commentLength = archive.readUInt16LE(offset + 20);
        if (offset + 22 + commentLength === archive.length) matches.push(offset);
    }
    if (matches.length !== 1) fail(code, 'Artifact ZIP must have exactly one unambiguous end record.');
    return matches[0];
}

function extractSingleArtifactMember(value, expectedName, code) {
    const archive = boundedBytes(value, MAX_ARTIFACT_ZIP_BYTES, code, 'artifact ZIP');
    if (archive.length < 22) fail(code, 'Artifact ZIP is truncated.');
    const endOffset = findExactZipEndRecord(archive, code);
    const diskNumber = archive.readUInt16LE(endOffset + 4);
    const centralDisk = archive.readUInt16LE(endOffset + 6);
    const diskEntries = archive.readUInt16LE(endOffset + 8);
    const totalEntries = archive.readUInt16LE(endOffset + 10);
    const centralSize = archive.readUInt32LE(endOffset + 12);
    const centralOffset = archive.readUInt32LE(endOffset + 16);
    const commentLength = archive.readUInt16LE(endOffset + 20);
    if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== 1 || totalEntries !== 1 ||
        commentLength !== 0 || centralSize === 0xffffffff || centralOffset === 0xffffffff ||
        centralOffset + centralSize !== endOffset) {
        fail(code, 'Artifact ZIP must be a single-member, non-ZIP64 archive without a comment.');
    }
    if (centralOffset + 46 > endOffset || archive.readUInt32LE(centralOffset) !== 0x02014b50) {
        fail(code, 'Artifact ZIP central directory is invalid.');
    }
    const centralFlags = archive.readUInt16LE(centralOffset + 8);
    const method = archive.readUInt16LE(centralOffset + 10);
    const modifiedTime = archive.readUInt16LE(centralOffset + 12);
    const modifiedDate = archive.readUInt16LE(centralOffset + 14);
    const expectedCrc32 = archive.readUInt32LE(centralOffset + 16);
    const compressedSize = archive.readUInt32LE(centralOffset + 20);
    const uncompressedSize = archive.readUInt32LE(centralOffset + 24);
    const nameLength = archive.readUInt16LE(centralOffset + 28);
    const extraLength = archive.readUInt16LE(centralOffset + 30);
    const memberCommentLength = archive.readUInt16LE(centralOffset + 32);
    const memberDisk = archive.readUInt16LE(centralOffset + 34);
    const externalAttributes = archive.readUInt32LE(centralOffset + 38);
    const localOffset = archive.readUInt32LE(centralOffset + 42);
    const centralEnd = centralOffset + 46 + nameLength + extraLength + memberCommentLength;
    if (centralEnd !== endOffset || memberCommentLength !== 0 || memberDisk !== 0 || localOffset !== 0 ||
        compressedSize === 0xffffffff || uncompressedSize === 0xffffffff ||
        uncompressedSize < 1 || uncompressedSize > MAX_RECOVERY_TAR_BYTES) {
        fail(code, 'Artifact ZIP central member is outside the reviewed bounds.');
    }
    if ((centralFlags & ~0x080e) !== 0 || ![0, 8].includes(method) ||
        (method === 0 && (centralFlags & 0x0006) !== 0)) {
        fail(code, 'Artifact ZIP uses unsupported flags or compression.');
    }
    const unixType = (externalAttributes >>> 16) & 0xf000;
    if ((unixType !== 0 && unixType !== 0x8000) || (externalAttributes & 0x10) !== 0) {
        fail(code, 'Artifact ZIP member is not a regular file.');
    }
    const centralNameStart = centralOffset + 46;
    exactZipName(archive.subarray(centralNameStart, centralNameStart + nameLength),
        expectedName, code, 'Artifact ZIP member');
    validateZipExtra(archive.subarray(
        centralNameStart + nameLength, centralNameStart + nameLength + extraLength
    ), code, 'Artifact ZIP central extra data');

    if (archive.length < 30 || archive.readUInt32LE(0) !== 0x04034b50) {
        fail(code, 'Artifact ZIP local header is invalid.');
    }
    const localFlags = archive.readUInt16LE(6);
    const localMethod = archive.readUInt16LE(8);
    const localModifiedTime = archive.readUInt16LE(10);
    const localModifiedDate = archive.readUInt16LE(12);
    const localCrc32 = archive.readUInt32LE(14);
    const localCompressedSize = archive.readUInt32LE(18);
    const localUncompressedSize = archive.readUInt32LE(22);
    const localNameLength = archive.readUInt16LE(26);
    const localExtraLength = archive.readUInt16LE(28);
    const localDataStart = 30 + localNameLength + localExtraLength;
    if (localDataStart > centralOffset || localFlags !== centralFlags || localMethod !== method ||
        localModifiedTime !== modifiedTime || localModifiedDate !== modifiedDate) {
        fail(code, 'Artifact ZIP local and central headers disagree.');
    }
    exactZipName(archive.subarray(30, 30 + localNameLength),
        expectedName, code, 'Artifact ZIP local member');
    validateZipExtra(archive.subarray(30 + localNameLength, localDataStart),
        code, 'Artifact ZIP local extra data');
    const usesDescriptor = (centralFlags & 0x0008) !== 0;
    if ((!usesDescriptor && (localCrc32 !== expectedCrc32 ||
        localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize)) ||
        (usesDescriptor && ((localCrc32 !== 0 && localCrc32 !== expectedCrc32) ||
            (localCompressedSize !== 0 && localCompressedSize !== compressedSize) ||
            (localUncompressedSize !== 0 && localUncompressedSize !== uncompressedSize)))) {
        fail(code, 'Artifact ZIP local member sizes or checksum disagree.');
    }
    const compressedEnd = localDataStart + compressedSize;
    if (compressedEnd > centralOffset) fail(code, 'Artifact ZIP member data is truncated.');
    let descriptorOffset = compressedEnd;
    if (usesDescriptor && descriptorOffset + 4 <= centralOffset &&
        archive.readUInt32LE(descriptorOffset) === 0x08074b50) {
        descriptorOffset += 4;
    }
    if (usesDescriptor) {
        if (descriptorOffset + 12 !== centralOffset ||
            archive.readUInt32LE(descriptorOffset) !== expectedCrc32 ||
            archive.readUInt32LE(descriptorOffset + 4) !== compressedSize ||
            archive.readUInt32LE(descriptorOffset + 8) !== uncompressedSize) {
            fail(code, 'Artifact ZIP data descriptor is invalid.');
        }
    } else if (compressedEnd !== centralOffset) {
        fail(code, 'Artifact ZIP contains bytes outside its single reviewed member.');
    }
    const compressed = archive.subarray(localDataStart, compressedEnd);
    let recovered;
    try {
        recovered = method === 0
            ? Buffer.from(compressed)
            : zlib.inflateRawSync(compressed, { maxOutputLength: MAX_RECOVERY_TAR_BYTES });
    } catch (error) {
        fail(code, `Artifact ZIP member cannot be decompressed: ${error.message}`);
    }
    if (recovered.length !== uncompressedSize || (method === 0 && compressedSize !== uncompressedSize) ||
        crc32(recovered) !== expectedCrc32) {
        fail(code, 'Artifact ZIP member length or CRC-32 is invalid.');
    }
    return recovered;
}

function tarText(header, offset, length, code, label) {
    const field = header.subarray(offset, offset + length);
    const nul = field.indexOf(0);
    const end = nul === -1 ? field.length : nul;
    if (nul !== -1 && field.subarray(nul).some((byte) => byte !== 0)) {
        fail(code, `${label} has non-zero bytes after its terminator.`);
    }
    const value = field.subarray(0, end).toString('utf8');
    if (Buffer.byteLength(value, 'utf8') !== end || /[^\x20-\x7e]/.test(value)) {
        fail(code, `${label} is not canonical printable ASCII.`);
    }
    return value;
}

function tarOctal(header, offset, length, code, label) {
    const field = header.subarray(offset, offset + length);
    if ((field[0] & 0x80) !== 0) fail(code, `${label} uses unsupported base-256 encoding.`);
    const text = field.toString('ascii');
    if (!/^[ \0]*[0-7]+[ \0]*$/.test(text)) fail(code, `${label} is not canonical octal.`);
    const digits = text.match(/[0-7]+/)[0];
    const value = BigInt(`0o${digits}`);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail(code, `${label} exceeds the safe integer range.`);
    return Number(value);
}

function tarChecksum(header, code) {
    const recorded = tarOctal(header, 148, 8, code, 'TAR checksum');
    let observed = 0;
    for (let index = 0; index < 512; index += 1) {
        observed += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    if (recorded !== observed) fail(code, 'Recovery TAR header checksum is invalid.');
}

function canonicalTarPath(value, code) {
    if (!value || value.startsWith('/') || value.includes('\\') || value.includes('\0') ||
        value.split('/').some((part, index, parts) =>
            (!part && index !== parts.length - 1) || part === '.' || part === '..')) {
        fail(code, 'Recovery TAR contains a non-canonical member path.');
    }
    return value;
}

function parseExactTar(value, expectedDirectories, expectedFiles, code) {
    const directories = expectedDirectories instanceof Set
        ? expectedDirectories
        : new Set(expectedDirectories);
    const files = expectedFiles instanceof Set ? expectedFiles : new Set(expectedFiles);
    const archive = boundedBytes(value, MAX_RECOVERY_TAR_BYTES, code, 'recovery TAR');
    if (archive.length % 512 !== 0 || archive.length < 1536) {
        fail(code, 'Recovery TAR length is not block aligned.');
    }
    const members = new Map();
    let offset = 0;
    let zeroBlocks = 0;
    while (offset + 512 <= archive.length) {
        const header = archive.subarray(offset, offset + 512);
        if (header.every((byte) => byte === 0)) {
            zeroBlocks += 1;
            offset += 512;
            if (zeroBlocks >= 2) break;
            continue;
        }
        if (zeroBlocks !== 0) fail(code, 'Recovery TAR has a member after an end marker.');
        if (members.size >= MAX_RECOVERY_MEMBERS) fail(code, 'Recovery TAR has too many members.');
        tarChecksum(header, code);
        const posixMagic = header.subarray(257, 265).equals(Buffer.from('ustar\0' + '00', 'binary'));
        const gnuMagic = header.subarray(257, 265).equals(Buffer.from('ustar  \0', 'binary'));
        if (!posixMagic && !gnuMagic) fail(code, 'Recovery TAR format is not reviewed USTAR/GNU TAR.');
        if (header.subarray(345, 500).some((byte) => byte !== 0)) {
            fail(code, 'Recovery TAR uses an unsupported prefix or extension header.');
        }
        const name = canonicalTarPath(tarText(header, 0, 100, code, 'TAR member name'), code);
        const linkName = tarText(header, 157, 100, code, 'TAR link name');
        const size = tarOctal(header, 124, 12, code, 'TAR member size');
        const uid = tarOctal(header, 108, 8, code, 'TAR uid');
        const gid = tarOctal(header, 116, 8, code, 'TAR gid');
        const modified = tarOctal(header, 136, 12, code, 'TAR mtime');
        const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
        if (uid !== 0 || gid !== 0 || modified !== 0 || linkName !== '' || !['0', '5'].includes(type)) {
            fail(code, 'Recovery TAR member metadata is outside the reviewed deterministic format.');
        }
        if (members.has(name)) fail(code, 'Recovery TAR repeats a member path.');
        const expectedDirectory = directories.has(name);
        const expectedFile = files.has(name);
        if ((!expectedDirectory && !expectedFile) || (expectedDirectory && type !== '5') ||
            (expectedFile && type !== '0') || (expectedDirectory && size !== 0) ||
            (expectedFile && (size < 1 || size > MAX_RECOVERY_MEMBER_BYTES)) ||
            (expectedFile && !name.endsWith('.zip') && size > 8 * 1024 * 1024)) {
            fail(code, `Recovery TAR member is outside the reviewed inventory: ${name}`);
        }
        const dataStart = offset + 512;
        const dataEnd = dataStart + size;
        const paddedEnd = dataStart + Math.ceil(size / 512) * 512;
        if (dataEnd > archive.length || paddedEnd > archive.length) {
            fail(code, 'Recovery TAR member data is truncated.');
        }
        if (archive.subarray(dataEnd, paddedEnd).some((byte) => byte !== 0)) {
            fail(code, 'Recovery TAR member padding is not zero-filled.');
        }
        members.set(name, Buffer.from(archive.subarray(dataStart, dataEnd)));
        offset = paddedEnd;
    }
    if (zeroBlocks < 2 || archive.subarray(offset).some((byte) => byte !== 0)) {
        fail(code, 'Recovery TAR does not end with zero-filled end markers.');
    }
    const expectedCount = directories.size + files.size;
    if (members.size !== expectedCount ||
        [...directories, ...files].some((name) => !members.has(name))) {
        fail(code, 'Recovery TAR member inventory is incomplete.');
    }
    return members;
}

function bindExtractedMember(input, members, inputName, memberName, maximum, code, label) {
    const supplied = boundedBytes(input[inputName], maximum, code, label);
    const recovered = members.get(memberName);
    if (!recovered || !recovered.equals(supplied)) {
        fail(code, `${label} is not byte-for-byte bound to the authenticated artifact.`);
    }
    return recovered;
}

function validateConnectorRollbackEvidence(
    input,
    releaseManifest,
    packageBundle,
    rollbackArchive,
    rollbackPackageManifest
) {
    const code = 'connector_release_admission_rollback_lineage';
    exactKeys(input, ['control', 'lineage', 'validation'], code,
        'Connector rollback lineage evidence');
    const { control, lineage, validation } = input;
    exactKeys(control, [
        'schemaVersion', 'kind', 'mode', 'repository', 'workflowPath',
        'current', 'previous', 'bootstrapConfirmation'
    ], code, 'Exact rollback control');
    if (control.schemaVersion !== 1 ||
        control.kind !== 'nofries-connector-exact-rollback-control' ||
        !['exact-artifact', 'source-reconstructed-bootstrap'].includes(control.mode)) {
        fail(code, 'Exact rollback control schema, kind or mode is invalid.');
    }
    exactString(control.repository, EXPECTED_CONNECTOR_RELEASE.repository,
        code, 'control.repository');
    exactString(control.workflowPath, EXPECTED_CONNECTOR_RELEASE.workflowPath,
        code, 'control.workflowPath');
    for (const [name, identity] of [['current', control.current], ['previous', control.previous]]) {
        exactKeys(identity, ['releaseSha', 'runId', 'runAttempt'], code,
            `Exact rollback ${name} identity`);
        fullSha(identity.releaseSha, code, `${name}.releaseSha`);
        positiveId(identity.runId, code, `${name}.runId`);
        positiveId(identity.runAttempt, code, `${name}.runAttempt`);
    }
    if (control.current.releaseSha === control.previous.releaseSha ||
        control.current.runId === control.previous.runId) {
        fail(code, 'Current and previous connector identities must differ.');
    }
    const expectedCurrent = {
        releaseSha: releaseManifest.candidate.releaseSha,
        runId: String(releaseManifest.candidate.runId),
        runAttempt: String(releaseManifest.origin.runAttempt)
    };
    const expectedPrevious = {
        releaseSha: releaseManifest.rollback.releaseSha,
        runId: String(releaseManifest.rollback.runId),
        runAttempt: control.previous.runAttempt
    };
    if (control.current.releaseSha !== expectedCurrent.releaseSha ||
        control.current.runId !== expectedCurrent.runId ||
        control.current.runAttempt !== expectedCurrent.runAttempt ||
        control.previous.releaseSha !== expectedPrevious.releaseSha ||
        control.previous.runId !== expectedPrevious.runId ||
        control.previous.runAttempt !== expectedPrevious.runAttempt ||
        String(packageBundle.run.id) !== control.current.runId ||
        String(packageBundle.run.attempt) !== control.current.runAttempt) {
        fail(code, 'Exact rollback control is not bound to the admitted connector release.');
    }
    if (control.mode === 'exact-artifact') {
        exactString(control.bootstrapConfirmation, '', code, 'control.bootstrapConfirmation');
        if (control.previous.releaseSha === CONNECTOR_BOOTSTRAP_SHA &&
            control.previous.runId === CONNECTOR_BOOTSTRAP_RUN_ID) {
            fail(code, 'The bootstrap connector cannot claim an exact prior artifact.');
        }
    } else if (control.previous.releaseSha !== CONNECTOR_BOOTSTRAP_SHA ||
        control.previous.runId !== CONNECTOR_BOOTSTRAP_RUN_ID ||
        control.previous.runAttempt !== CONNECTOR_BOOTSTRAP_RUN_ATTEMPT ||
        control.bootstrapConfirmation !==
            `ACCEPT-SOURCE-RECONSTRUCTED-BOOTSTRAP-ROLLBACK:${control.current.releaseSha}`) {
        fail(code, 'Bootstrap rollback control is not the reviewed live-bootstrap-only exception.');
    }

    exactKeys(lineage, [
        'schemaVersion', 'kind', 'mode', 'exactBytes', 'current', 'rollback',
        'sourceArtifact', 'bootstrapException'
    ], code, 'Rollback lineage');
    exactKeys(lineage.current, ['releaseSha', 'runId', 'runAttempt'], code,
        'Rollback lineage current identity');
    if (lineage.schemaVersion !== 1 ||
        lineage.kind !== 'nofries-connector-rollback-lineage' ||
        lineage.mode !== control.mode ||
        lineage.exactBytes !== (control.mode === 'exact-artifact') ||
        lineage.current.releaseSha !== control.current.releaseSha ||
        lineage.current.runId !== control.current.runId ||
        lineage.current.runAttempt !== control.current.runAttempt) {
        fail(code, 'Rollback lineage identity or mode does not match its control.');
    }
    exactKeys(lineage.rollback, [
        'releaseSha', 'runId', 'runAttempt', 'archiveSha256', 'archiveBytes'
    ], code, 'Rollback lineage identity');
    const rollbackBytes = boundedBytes(rollbackArchive, MAX_RECOVERY_MEMBER_BYTES,
        code, 'rollback archive');
    const rollbackSha256 = sha256(rollbackBytes);
    exactKeys(rollbackPackageManifest, [
        'schemaVersion', 'kind', 'role', 'sourceSha', 'releaseRunId', 'runAttempt',
        'closureManifestSha256', 'runtimeDependencies', 'dependencyDeclarations',
        'dependencyPackages', 'inputs', 'files', 'archive'
    ], code, 'Rollback package manifest');
    exactKeys(rollbackPackageManifest.archive, ['path', 'bytes', 'sha256'], code,
        'Rollback package manifest archive');
    if (lineage.rollback.releaseSha !== control.previous.releaseSha ||
        lineage.rollback.runId !== control.previous.runId ||
        lineage.rollback.runAttempt !== control.previous.runAttempt ||
        lineage.rollback.archiveSha256 !== rollbackSha256 ||
        lineage.rollback.archiveBytes !== rollbackBytes.length ||
        rollbackPackageManifest.schemaVersion !== 1 ||
        rollbackPackageManifest.kind !== 'nofries-connector-package' ||
        rollbackPackageManifest.role !== 'rollback' ||
        rollbackPackageManifest.sourceSha !== control.previous.releaseSha ||
        String(rollbackPackageManifest.releaseRunId) !== control.previous.runId ||
        String(rollbackPackageManifest.runAttempt) !== control.previous.runAttempt ||
        rollbackPackageManifest.archive.path !== 'rollback/connector-function.zip' ||
        rollbackPackageManifest.archive.sha256 !== rollbackSha256 ||
        rollbackPackageManifest.archive.bytes !== rollbackBytes.length ||
        rollbackSha256 !== releaseManifest.rollback.archiveSha256) {
        fail(code, 'Rollback lineage does not bind the admitted rollback archive.');
    }
    if (control.mode === 'exact-artifact') {
        exactKeys(lineage.sourceArtifact, [
            'id', 'name', 'digest', 'sourceRole', 'artifactZipSha256',
            'releaseEvidenceTarSha256', 'candidateManifestSha256',
            'closureManifestSha256', 'archiveSha256', 'packageBundleSha256',
            'runId', 'runAttempt', 'headSha'
        ], code, 'Rollback lineage source artifact');
        positiveId(lineage.sourceArtifact.id, code, 'sourceArtifact.id');
        exactString(lineage.sourceArtifact.name,
            `connector-release-${control.previous.runId}-${control.previous.runAttempt}`,
            code, 'sourceArtifact.name');
        const sourceArtifactSha256 = digest(lineage.sourceArtifact.digest,
            code, 'sourceArtifact.digest', true);
        digest(lineage.sourceArtifact.packageBundleSha256,
            code, 'sourceArtifact.packageBundleSha256');
        digest(lineage.sourceArtifact.releaseEvidenceTarSha256,
            code, 'sourceArtifact.releaseEvidenceTarSha256');
        digest(lineage.sourceArtifact.candidateManifestSha256,
            code, 'sourceArtifact.candidateManifestSha256');
        digest(lineage.sourceArtifact.closureManifestSha256,
            code, 'sourceArtifact.closureManifestSha256');
        if (lineage.sourceArtifact.sourceRole !== 'candidate' ||
            sourceArtifactSha256 !== lineage.sourceArtifact.artifactZipSha256 ||
            lineage.sourceArtifact.archiveSha256 !== rollbackSha256 ||
            digest(lineage.sourceArtifact.archiveSha256, code,
                'sourceArtifact.archiveSha256') !== rollbackSha256 ||
            lineage.sourceArtifact.closureManifestSha256 !==
                rollbackPackageManifest.closureManifestSha256 ||
            lineage.sourceArtifact.runId !== control.previous.runId ||
            lineage.sourceArtifact.runAttempt !== control.previous.runAttempt ||
            lineage.sourceArtifact.headSha !== control.previous.releaseSha ||
            lineage.bootstrapException !== null) {
            fail(code, 'Exact rollback lineage source artifact is inconsistent.');
        }
    } else {
        if (lineage.sourceArtifact !== null) {
            fail(code, 'Bootstrap rollback lineage must not name a source artifact.');
        }
        exactKeys(lineage.bootstrapException, [
            'confirmation', 'bootstrapSha', 'bootstrapRunId', 'controllerSha'
        ], code, 'Bootstrap rollback exception');
        if (rollbackPackageManifest.closureManifestSha256 !==
                packageBundle.closureManifestSha256 ||
            lineage.bootstrapException.confirmation !== control.bootstrapConfirmation ||
            lineage.bootstrapException.bootstrapSha !== CONNECTOR_BOOTSTRAP_SHA ||
            lineage.bootstrapException.bootstrapRunId !== CONNECTOR_BOOTSTRAP_RUN_ID ||
            lineage.bootstrapException.controllerSha !== control.current.releaseSha) {
            fail(code, 'Bootstrap rollback exception is not bound to the exact control.');
        }
    }

    exactKeys(validation, [
        'schemaVersion', 'kind', 'mode', 'exactBytes', 'rollbackSha',
        'rollbackRunId', 'rollbackArchiveSha256', 'sourceArtifactId'
    ], code, 'Exact rollback validation report');
    if (validation.schemaVersion !== 1 ||
        validation.kind !== 'nofries-connector-exact-rollback-validation' ||
        validation.mode !== lineage.mode ||
        validation.exactBytes !== lineage.exactBytes ||
        validation.rollbackSha !== lineage.rollback.releaseSha ||
        validation.rollbackRunId !== lineage.rollback.runId ||
        validation.rollbackArchiveSha256 !== lineage.rollback.archiveSha256 ||
        validation.sourceArtifactId !== (lineage.sourceArtifact && lineage.sourceArtifact.id)) {
        fail(code, 'Exact rollback validation report is not bound to the rollback lineage.');
    }
    return Object.freeze({
        mode: lineage.mode,
        exactBytes: lineage.exactBytes,
        rollbackArchiveSha256: rollbackSha256
    });
}

function validateConnectorArtifactEvidence(input, expected, releaseManifest, packageBundle) {
    const code = 'connector_release_admission_artifact';
    exactKeys(input, [
        'metadata', 'artifactZip', 'recoveryBundle',
        'releaseManifest', 'releaseManifestDigest',
        'packageBundle', 'packageBundleDigest',
        'candidateArchive', 'candidatePackageManifest',
        'rollbackArchive', 'rollbackPackageManifest',
        'rollbackLineage', 'rollbackControl', 'rollbackValidation'
    ], code, 'Connector artifact inputs');
    exactKeys(expected, ['runId', 'runAttempt'], code, 'Expected connector artifact identity');
    exactKeys(input.metadata, ['id', 'name', 'digest', 'expired', 'runId'],
        code, 'Connector artifact metadata');
    const runId = positiveId(expected.runId, code, 'expected runId');
    const runAttempt = positiveId(expected.runAttempt, code, 'expected runAttempt');
    exactString(input.metadata.name, `connector-recovery-${runId}-${runAttempt}`,
        code, 'artifact.name');
    if (input.metadata.expired !== false ||
        positiveId(input.metadata.runId, code, 'artifact.runId') !== runId) {
        fail(code, 'Connector artifact expiry or run identity is invalid.');
    }
    positiveId(input.metadata.id, code, 'artifact.id');
    const artifactZip = boundedBytes(input.artifactZip, MAX_ARTIFACT_ZIP_BYTES, code, 'artifact ZIP');
    const artifactZipSha256 = sha256(artifactZip);
    if (digest(input.metadata.digest, code, 'artifact.digest', true) !== artifactZipSha256) {
        fail(code, 'Downloaded artifact ZIP bytes do not match GitHub metadata.');
    }
    const recoveredBundle = extractSingleArtifactMember(
        artifactZip, 'connector-recovery-evidence.tar', code);
    const suppliedBundle = boundedBytes(input.recoveryBundle, MAX_RECOVERY_TAR_BYTES,
        code, 'recovery TAR');
    if (!recoveredBundle.equals(suppliedBundle)) {
        fail(code, 'Recovery TAR is not the single member of the authenticated artifact ZIP.');
    }
    const members = parseExactTar(
        recoveredBundle, RECOVERY_TAR_DIRECTORIES, RECOVERY_TAR_FILES, code);
    const releaseManifestBytes = bindExtractedMember(input, members, 'releaseManifest',
        'release/connector-release-manifest.json', 8 * 1024 * 1024, code, 'release manifest');
    const parsedReleaseManifest = JSON.parse(releaseManifestBytes.toString('utf8'));
    if (JSON.stringify(parsedReleaseManifest) !== JSON.stringify(releaseManifest)) {
        fail(code, 'Extracted release-manifest bytes do not match the validated manifest.');
    }
    const packageBundleBytes = bindExtractedMember(input, members, 'packageBundle',
        'release/connector-package-bundle.json', 8 * 1024 * 1024, code, 'package bundle');
    const parsedPackageBundle = JSON.parse(packageBundleBytes.toString('utf8'));
    if (JSON.stringify(parsedPackageBundle) !== JSON.stringify(packageBundle)) {
        fail(code, 'Extracted package-bundle bytes do not match the validated package bundle.');
    }
    const releaseManifestSha256 = sha256(releaseManifestBytes);
    const packageBundleSha256 = sha256(packageBundleBytes);
    const releaseManifestDigest = bindExtractedMember(input, members, 'releaseManifestDigest',
        'release/connector-release-manifest.sha256', 8 * 1024 * 1024,
        code, 'release-manifest digest');
    const packageBundleDigest = bindExtractedMember(input, members, 'packageBundleDigest',
        'release/connector-package-bundle.sha256', 8 * 1024 * 1024,
        code, 'package-bundle digest');
    if (recordedDigest(releaseManifestDigest, 'connector-release-manifest.json', code,
        'release-manifest digest') !== releaseManifestSha256 ||
        recordedDigest(packageBundleDigest, 'connector-package-bundle.json', code,
            'package-bundle digest') !== packageBundleSha256) {
        fail(code, 'Extracted manifest or package bundle does not match its recorded digest.');
    }
    const recoveredCandidateArchive = bindExtractedMember(input, members, 'candidateArchive',
        'release/candidate/connector-function.zip', MAX_RECOVERY_MEMBER_BYTES, code, 'candidate archive');
    const recoveredCandidateManifest = bindExtractedMember(input, members, 'candidatePackageManifest',
        'release/candidate/package-manifest.json', 8 * 1024 * 1024,
        code, 'candidate package manifest');
    const recoveredRollbackArchive = bindExtractedMember(input, members, 'rollbackArchive',
        'release/rollback/connector-function.zip', MAX_RECOVERY_MEMBER_BYTES, code, 'rollback archive');
    const recoveredRollbackManifest = bindExtractedMember(input, members, 'rollbackPackageManifest',
        'release/rollback/package-manifest.json', 8 * 1024 * 1024,
        code, 'rollback package manifest');
    const recoveredRollbackLineage = bindExtractedMember(input, members, 'rollbackLineage',
        'release/rollback-lineage.json', 8 * 1024 * 1024, code, 'rollback lineage');
    const recoveredRollbackControl = bindExtractedMember(input, members, 'rollbackControl',
        'release/evidence/exact-rollback-control.json', 8 * 1024 * 1024,
        code, 'exact rollback control');
    const recoveredRollbackValidation = bindExtractedMember(input, members, 'rollbackValidation',
        'release/evidence/exact-rollback-validation.json', 8 * 1024 * 1024,
        code, 'exact rollback validation');
    const observed = {
        candidateArchiveSha256: sha256(recoveredCandidateArchive),
        candidateManifestSha256: sha256(recoveredCandidateManifest),
        rollbackArchiveSha256: sha256(recoveredRollbackArchive),
        rollbackManifestSha256: sha256(recoveredRollbackManifest)
    };
    if (observed.candidateArchiveSha256 !== releaseManifest.candidate.archiveSha256 ||
        observed.candidateManifestSha256 !== releaseManifest.candidate.manifestSha256 ||
        observed.rollbackArchiveSha256 !== releaseManifest.rollback.archiveSha256 ||
        observed.rollbackManifestSha256 !== releaseManifest.rollback.manifestSha256) {
        fail(code, 'Extracted candidate or rollback bytes do not match the protected release manifest.');
    }
    const rollbackEvidence = validateConnectorRollbackEvidence({
        control: JSON.parse(recoveredRollbackControl.toString('utf8')),
        lineage: JSON.parse(recoveredRollbackLineage.toString('utf8')),
        validation: JSON.parse(recoveredRollbackValidation.toString('utf8'))
    }, releaseManifest, packageBundle, recoveredRollbackArchive,
    JSON.parse(recoveredRollbackManifest.toString('utf8')));
    const evidence = Object.freeze({
        artifactId: String(input.metadata.id),
        artifactName: input.metadata.name,
        artifactZipSha256,
        recoveryBundleSha256: sha256(recoveredBundle),
        releaseManifestSha256,
        packageBundleSha256,
        runId,
        runAttempt,
        ...observed,
        ...rollbackEvidence,
        rollbackLineageSha256: sha256(recoveredRollbackLineage),
        rollbackControlSha256: sha256(recoveredRollbackControl),
        rollbackValidationSha256: sha256(recoveredRollbackValidation)
    });
    VALID_ARTIFACT_EVIDENCE.add(evidence);
    return evidence;
}

function validateUnifiedConnectorAdmission(admission, artifactEvidence) {
    plain(admission, 'connector_release_admission_invalid', 'Connector admission');
    if (!VALID_ARTIFACT_EVIDENCE.has(artifactEvidence)) {
        fail('connector_release_admission_artifact', 'Connector admission requires evidence computed from downloaded bytes.');
    }
    exactKeys(admission, [
        'appBaselineSha', 'connectorImpact', 'targetSha', 'liveConnector',
        'standaloneRun', 'releaseManifest', 'packageBundle'
    ], 'connector_release_admission_invalid', 'Connector-impacting admission');
    const appBaselineSha = fullSha(admission.appBaselineSha,
        'connector_release_admission_app_baseline', 'appBaselineSha');
    const targetSha = fullSha(admission.targetSha,
        'connector_release_admission_target', 'targetSha');
    const impact = validateImpact(admission.connectorImpact);
    if (impact.safe) {
        fail('connector_release_admission_safe_bypass', 'A safe connector delta must pass the classifier directly, not release admission.');
    }
    exactKeys(admission.liveConnector, [
        'service', 'status', 'statusCode', 'releaseSha', 'releaseRunId', 'releaseRunAttempt'
    ], 'connector_release_admission_live', 'Live connector identity');
    if (admission.liveConnector.statusCode !== 200 ||
        admission.liveConnector.status !== 'ready' ||
        admission.liveConnector.service !== EXPECTED_CONNECTOR_RELEASE.connectorService ||
        admission.liveConnector.releaseSha !== targetSha) {
        fail('connector_release_admission_live', 'Live connector does not report the exact ready target.');
    }
    const runId = positiveId(admission.liveConnector.releaseRunId,
        'connector_release_admission_live_run', 'liveConnector.releaseRunId');
    const liveRunAttempt = positiveId(admission.liveConnector.releaseRunAttempt,
        'connector_release_admission_live_run_attempt', 'liveConnector.releaseRunAttempt');
    const runAttempt = positiveId(admission.standaloneRun && admission.standaloneRun.runAttempt,
        'connector_release_admission_run_attempt', 'standaloneRun.runAttempt');
    if (liveRunAttempt !== runAttempt) {
        fail('connector_release_admission_live_run_attempt',
            'Live connector run attempt does not match the admitted workflow attempt.');
    }
    validateConnectorRunProvenance(admission.standaloneRun, {
        conclusion: 'success', event: 'workflow_dispatch', headBranch: 'main', headSha: targetSha,
        path: EXPECTED_CONNECTOR_RELEASE.workflowPath, repository: EXPECTED_CONNECTOR_RELEASE.repository,
        runAttempt, runId, status: 'completed'
    });
    const bundleIdentity = validateConnectorReleaseManifest(admission.releaseManifest, {
        appBaselineSha,
        connectorBaselineSha: admission.releaseManifest && admission.releaseManifest.cumulativeDelta && admission.releaseManifest.cumulativeDelta.connectorBaselineSha,
        connectorBaselineRunId: admission.releaseManifest && admission.releaseManifest.rollback && admission.releaseManifest.rollback.runId,
        connectorBaselineRunAttempt: admission.releaseManifest && admission.releaseManifest.rollback && admission.releaseManifest.rollback.runAttempt,
        liveEvalRunId: admission.releaseManifest && admission.releaseManifest.origin && admission.releaseManifest.origin.liveEvalRunId,
        releaseRunAttempt: runAttempt,
        releaseRunId: runId,
        targetSha,
        workflowSha: targetSha
    }, admission.packageBundle);
    if (artifactEvidence.runId !== runId || artifactEvidence.runAttempt !== runAttempt ||
        artifactEvidence.candidateArchiveSha256 !== admission.releaseManifest.candidate.archiveSha256 ||
        artifactEvidence.candidateManifestSha256 !== admission.releaseManifest.candidate.manifestSha256 ||
        artifactEvidence.rollbackArchiveSha256 !== admission.releaseManifest.rollback.archiveSha256 ||
        artifactEvidence.rollbackManifestSha256 !== admission.releaseManifest.rollback.manifestSha256) {
        fail('connector_release_admission_artifact', 'Computed artifact evidence is not bound to the admitted release.');
    }
    return Object.freeze({
        admitted: true,
        connectorReleaseRunId: bundleIdentity.releaseRunId,
        targetSha
    });
}

function flattenJobs(jobPages) {
    if (!Array.isArray(jobPages) || jobPages.length < 1 || jobPages.length > 10) {
        fail('connector_recovery_origin_pages_invalid', 'Jobs pages must be a bounded non-empty array.');
    }
    const jobs = [];
    let totalCount = null;
    const identifiers = new Set();
    for (const page of jobPages) {
        plain(page, 'connector_recovery_origin_page_invalid', 'Jobs page');
        if (!Number.isSafeInteger(page.total_count) || page.total_count < 1 || page.total_count > 1000 ||
            !Array.isArray(page.jobs)) {
            fail('connector_recovery_origin_page_invalid', 'Jobs page is incomplete or outside its bound.');
        }
        if (totalCount === null) totalCount = page.total_count;
        if (page.total_count !== totalCount) {
            fail('connector_recovery_origin_pages_invalid', 'Jobs pages disagree on total count.');
        }
        for (const job of page.jobs) {
            plain(job, 'connector_recovery_origin_page_invalid', 'Job');
            const identifier = positiveId(job.id,
                'connector_recovery_origin_page_invalid', 'job.id');
            if (identifiers.has(identifier)) {
                fail('connector_recovery_origin_pages_invalid', 'Jobs pages contain a duplicate job.');
            }
            identifiers.add(identifier);
            jobs.push(job);
        }
    }
    if (jobs.length !== totalCount) {
        fail('connector_recovery_origin_pages_invalid', 'Jobs pages are incomplete.');
    }
    return jobs;
}

function classifyConnectorRecoveryOriginSteps(jobPages, operation) {
    exactString(operation, 'recover', 'connector_recovery_origin_operation', 'operation');
    const matches = flattenJobs(jobPages).filter((job) => job && job.name === 'Release connector production');
    if (matches.length !== 1) fail('connector_recovery_origin_job_missing', 'Exactly one origin release job is required.');
    const job = matches[0];
    if (job.status !== 'completed') fail('connector_recovery_origin_incomplete', 'Origin release job is not complete.');
    if (!Array.isArray(job.steps)) fail('connector_recovery_origin_steps_invalid', 'Origin release job has no steps.');
    const markers = job.steps.filter((step) => step && step.name === 'Mark the protected connector mutation boundary');
    if (markers.length !== 1) {
        fail('connector_recovery_origin_marker_ambiguous', 'Exactly one mutation marker step is required.');
    }
    const deployments = job.steps.filter((step) => step && step.name === 'Deploy the exact connector candidate package');
    if (deployments.length !== 1) {
        fail('connector_recovery_origin_deploy_ambiguous', 'Exactly one candidate deployment step is required.');
    }
    const marker = markers[0];
    const deployment = deployments[0];
    if (marker.status !== 'completed' || deployment.status !== 'completed') {
        fail('connector_recovery_origin_incomplete', 'Origin mutation steps are not complete.');
    }
    if (marker.conclusion === 'success') {
        return Object.freeze({ disposition: 'recovery_required', mutationAuthorized: true });
    }
    if (['skipped', 'failure', 'cancelled'].includes(marker.conclusion) && deployment.conclusion === 'skipped') {
        fail('connector_recovery_not_required', 'The origin run did not cross the connector mutation boundary.');
    }
    fail('connector_recovery_origin_marker_ambiguous', 'Origin mutation evidence is inconsistent.');
}

function validateConnectorRecoveryOrigin(run, expected) {
    exactKeys(run, [
        'conclusion', 'event', 'headBranch', 'headSha', 'path', 'repository',
        'runAttempt', 'runId', 'status'
    ], 'connector_recovery_origin_invalid', 'Connector recovery origin run');
    exactKeys(expected, [
        'currentRunAttempt', 'currentRunId', 'mode', 'releaseSha', 'runAttempt', 'runId'
    ],
        'connector_recovery_origin_expected_invalid', 'Expected recovery origin');
    if (!['automatic', 'manual'].includes(expected.mode)) {
        fail('connector_recovery_origin_mode', 'Recovery origin mode is invalid.');
    }
    const releaseSha = fullSha(expected.releaseSha,
        'connector_recovery_origin_sha', 'expected releaseSha');
    const runId = positiveId(expected.runId,
        'connector_recovery_origin_run_id', 'expected runId');
    const runAttempt = positiveId(expected.runAttempt,
        'connector_recovery_origin_attempt', 'expected runAttempt');
    const currentRunId = positiveId(expected.currentRunId,
        'connector_recovery_origin_current_run_id', 'expected currentRunId');
    const currentRunAttempt = positiveId(expected.currentRunAttempt,
        'connector_recovery_origin_current_attempt', 'expected currentRunAttempt');
    if (positiveId(run.runId, 'connector_recovery_origin_run_id', 'run.runId') !== runId ||
        positiveId(run.runAttempt, 'connector_recovery_origin_attempt', 'run.runAttempt') !== runAttempt) {
        fail('connector_recovery_origin_identity', 'Recovery origin run or attempt does not match.');
    }
    exactString(run.event, 'workflow_dispatch', 'connector_recovery_origin_event', 'run.event');
    exactString(run.headBranch, 'main', 'connector_recovery_origin_branch', 'run.headBranch');
    exactString(run.headSha, releaseSha, 'connector_recovery_origin_sha', 'run.headSha');
    exactString(run.path, EXPECTED_CONNECTOR_RELEASE.workflowPath,
        'connector_recovery_origin_path', 'run.path');
    exactString(run.repository, EXPECTED_CONNECTOR_RELEASE.repository,
        'connector_recovery_origin_repository', 'run.repository');
    if (expected.mode === 'automatic') {
        if (runId !== currentRunId || runAttempt !== currentRunAttempt) {
            fail('connector_recovery_origin_identity', 'Automatic recovery must belong to the current run and attempt.');
        }
        if (run.status !== 'in_progress' || run.conclusion !== null) {
            fail('connector_recovery_origin_state', 'Automatic recovery origin must be the current in-progress run.');
        }
    } else {
        if (runId === currentRunId) {
            fail('connector_recovery_origin_identity', 'Manual recovery must name a different originating run.');
        }
        if (run.status !== 'completed' || !NON_SUCCESS_CONCLUSIONS.has(run.conclusion)) {
            fail('connector_recovery_origin_state',
                'Manual recovery origin must be a completed non-successful run.');
        }
    }
    return Object.freeze({ mode: expected.mode, releaseSha, runId, runAttempt });
}

function recoveryRunRecord(value, label) {
    const code = 'connector_recovery_freshness_invalid';
    exactKeys(value, [
        'conclusion', 'createdAt', 'displayTitle', 'event', 'headBranch', 'headSha', 'path',
        'repository', 'runAttempt', 'runId', 'runNumber', 'runStartedAt', 'status',
        'updatedAt', 'workflowId'
    ], code, label);
    const runId = positiveId(value.runId, code, `${label}.runId`);
    const runAttempt = positiveId(value.runAttempt, code, `${label}.runAttempt`);
    const workflowId = positiveId(value.workflowId, code, `${label}.workflowId`);
    const runNumber = positiveId(value.runNumber, code, `${label}.runNumber`);
    const headSha = fullSha(value.headSha, code, `${label}.headSha`);
    if (typeof value.event !== 'string' || !value.event ||
        typeof value.headBranch !== 'string' || !value.headBranch ||
        typeof value.path !== 'string' || !value.path ||
        typeof value.repository !== 'string' || !value.repository) {
        fail(code, `${label} has an invalid workflow identity.`);
    }
    if (value.displayTitle !== null && typeof value.displayTitle !== 'string') {
        fail(code, `${label}.displayTitle is invalid.`);
    }
    const createdAt = canonicalTimestamp(value.createdAt, code, `${label}.createdAt`);
    const updatedAt = canonicalTimestamp(value.updatedAt, code, `${label}.updatedAt`);
    let runStartedAt = null;
    if (value.runStartedAt !== null) {
        runStartedAt = canonicalTimestamp(value.runStartedAt, code, `${label}.runStartedAt`);
    }
    if (createdAt > updatedAt || (runStartedAt !== null &&
        (createdAt > runStartedAt || runStartedAt > updatedAt))) {
        fail(code, `${label} timestamps are out of order.`);
    }
    if (value.status === 'completed') {
        if (runStartedAt === null || !COMPLETED_CONCLUSIONS.has(value.conclusion)) {
            fail(code, `${label} has an invalid completed state.`);
        }
    } else if (ACTIVE_RUN_STATUSES.has(value.status)) {
        if (value.conclusion !== null || (value.status === 'in_progress' && runStartedAt === null)) {
            fail(code, `${label} has an invalid active state.`);
        }
    } else {
        fail(code, `${label} has an unsupported status.`);
    }
    return Object.freeze({
        ...value, createdAtMilliseconds: createdAt, headSha, runAttempt, runId, runNumber,
        runStartedAtMilliseconds: runStartedAt, updatedAtMilliseconds: updatedAt, workflowId
    });
}

function sameRecoveryRun(left, right, allowUpdatedAtChange = false) {
    const keys = [
        'conclusion', 'createdAt', 'displayTitle', 'event', 'headBranch', 'headSha', 'path',
        'repository', 'runAttempt', 'runId', 'runNumber', 'runStartedAt', 'status', 'workflowId'
    ];
    if (!allowUpdatedAtChange) keys.push('updatedAt');
    return keys.every((key) => left[key] === right[key]);
}

// This bridge is deliberately incident-specific. It does not permit arbitrary recovery gaps.
const CONNECTOR_NONMUTATING_PREDECESSORS = Object.freeze({
    originRunId: '34547028272',
    originSha: '93ac1ecf81ebab34d2482f47469167d882e12f9e',
    historicalSha: '52309635bfce7a2eb7edcc0fb51194723ec031b9',
    controller: { runId: '34560183287', runNumber: '4', conclusion: 'failure',
        displayTitle: 'Connector production recover',
        jobs: [
            ['103141118194', 'Prove rolling connector production safety', 'success'],
            ['103141118798', 'Build immutable connector release bundle', 'skipped'],
            ['103141119266', 'Record an inert connector recovery freshness witness', 'skipped'],
            ['103141352751', 'Create the connector recovery freshness high-water', 'failure'],
            ['103141438527', 'Verify release or recovery bundle', 'skipped'],
            ['103141439028', 'Release connector production', 'skipped'],
            ['103141439300', 'Reconcile a failed connector mutation', 'skipped'],
            ['103141439692', 'Publish connector release status', 'skipped']
        ] },
    witness: { runId: '34560291531', runNumber: '5', conclusion: 'success',
        displayTitle: 'Connector freshness witness for 34560183287',
        jobs: [
            ['103141440020', 'Record an inert connector recovery freshness witness', 'success'],
            ['103141440637', 'Build immutable connector release bundle', 'skipped'],
            ['103141440688', 'Prove rolling connector production safety', 'skipped'],
            ['103141440731', 'Create the connector recovery freshness high-water', 'skipped'],
            ['103141441132', 'Verify release or recovery bundle', 'skipped'],
            ['103141441458', 'Release connector production', 'skipped'],
            ['103141441990', 'Reconcile a failed connector mutation', 'skipped'],
            ['103141442629', 'Publish connector release status', 'skipped']
        ] }
});

const CONNECTOR_PREDECESSOR_EXECUTED_STEPS = Object.freeze({
    '103141118194': [
        [1, 'Set up job', 'success'],
        [2, 'Check out exact rolling-safety controller', 'success'],
        [3, 'Set up rolling-safety Node.js', 'success'],
        [4, 'Install rolling-safety dependencies', 'success'],
        [5, 'Prepare exact rolling-safety request', 'success'],
        [6, 'Collect and validate rolling production safety', 'success'],
        [7, 'Revalidate rolling production safety before upload', 'success'],
        [8, 'Persist immutable rolling production safety', 'success'],
        [9, 'Bind immutable rolling production safety', 'success'],
        [10, 'Remove rolling-safety temporary files', 'success'],
        [19, 'Post Set up rolling-safety Node.js', 'success'],
        [20, 'Post Check out exact rolling-safety controller', 'success'],
        [21, 'Complete job', 'success']
    ],
    '103141352751': [
        [1, 'Set up job', 'success'],
        [2, 'Check out exact witness-dispatch safety source', 'success'],
        [3, 'Verify exact witness-dispatch executables before authority', 'success'],
        [4, 'Set up witness-dispatch safety Node.js', 'success'],
        [5, 'Download and revalidate witness-dispatch rolling safety', 'success'],
        [6, 'Dispatch and bind the inert same-workflow witness', 'failure'],
        [11, 'Post Set up witness-dispatch safety Node.js', 'skipped'],
        [12, 'Post Check out exact witness-dispatch safety source', 'success'],
        [13, 'Complete job', 'success']
    ],
    '103141440020': [
        [1, 'Set up job', 'success'],
        [2, 'Prove this run is inert witness attempt one', 'success'],
        [3, 'Complete job', 'success']
    ]
});

function validateConnectorNonmutatingPredecessors(proof, records, runtimeSafety) {
    const code = 'connector_recovery_predecessor_invalid';
    const incident = CONNECTOR_NONMUTATING_PREDECESSORS;
    if (records.origin.runId !== incident.originRunId ||
        records.origin.headSha !== incident.originSha || records.origin.runNumber !== '3' ||
        records.controller.runNumber !== '6' || records.witness.runNumber !== '7') {
        fail(code, 'Only the recorded origin-3/predecessors-4-5/controller-6/witness-7 bridge is allowed.');
    }
    exactKeys(proof, ['after', 'before'], code, 'Nonmutating predecessor proof');
    for (const phase of ['before', 'after']) {
        exactKeys(proof[phase], ['controller', 'witness'], code, `${phase} predecessors`);
        for (const role of ['controller', 'witness']) {
            const expected = incident[role];
            const item = proof[phase][role];
            exactKeys(item, ['attempt2Absence', 'jobs', 'run'], code, `${phase} predecessor ${role}`);
            const run = recoveryRunRecord(item.run, `${phase} predecessor ${role}`);
            if (run.runId !== expected.runId || run.runNumber !== expected.runNumber ||
                run.runAttempt !== '1' || run.headSha !== incident.historicalSha ||
                run.workflowId !== records.origin.workflowId || run.status !== 'completed' ||
                run.conclusion !== expected.conclusion || run.displayTitle !== expected.displayTitle ||
                run.repository !== EXPECTED_CONNECTOR_RELEASE.repository ||
                run.path !== EXPECTED_CONNECTOR_RELEASE.workflowPath ||
                run.event !== 'workflow_dispatch' || run.headBranch !== 'main' ||
                run.createdAtMilliseconds <= records.origin.updatedAtMilliseconds ||
                run.updatedAtMilliseconds >= records.controller.createdAtMilliseconds) {
                fail(code, `The ${phase} predecessor ${role} identity or terminal state is invalid.`);
            }
            const headers = runtimeSafety.snapshots[phase].rolling.headers;
            const header = headers.find((value) => value.runId === run.runId);
            if (!header || !sameRecoveryRun(run, header)) {
                fail(code, `The ${phase} predecessor ${role} contradicts the rolling inventory.`);
            }
            exactKeys(item.attempt2Absence, ['httpStatus', 'nextAttempt', 'runId'], code,
                `${phase} predecessor ${role} attempt-2 absence`);
            if (item.attempt2Absence.httpStatus !== 404 ||
                item.attempt2Absence.nextAttempt !== '2' ||
                item.attempt2Absence.runId !== expected.runId) {
                fail(code, 'A predecessor lacks authenticated attempt-2 absence.');
            }
            exactKeys(item.jobs, ['jobs', 'terminalPageEmpty', 'totalCount'], code,
                `${phase} predecessor ${role} jobs`);
            if (item.jobs.totalCount !== 8 || item.jobs.terminalPageEmpty !== true ||
                !Array.isArray(item.jobs.jobs) || item.jobs.jobs.length !== 8) {
                fail(code, 'The predecessor job inventory is not complete.');
            }
            const ids = new Set();
            for (const job of item.jobs.jobs) {
                exactKeys(job, ['conclusion', 'id', 'name', 'runAttempt', 'runId', 'status', 'steps'],
                    code, 'Predecessor job');
                const specification = expected.jobs.find(([id]) => id === job.id);
                if (!specification || ids.has(job.id) || job.name !== specification[1] ||
                    job.conclusion !== specification[2] || job.status !== 'completed' ||
                    job.runId !== expected.runId || job.runAttempt !== '1') {
                    fail(code, 'A predecessor job identity or outcome is invalid.');
                }
                ids.add(job.id);
                if (job.conclusion === 'skipped') {
                    if (job.steps !== null && (!Array.isArray(job.steps) || job.steps.length !== 0)) {
                        fail(code, 'A skipped predecessor job contains executed steps.');
                    }
                    continue;
                }
                const expectedSteps = CONNECTOR_PREDECESSOR_EXECUTED_STEPS[job.id];
                if (!expectedSteps || !Array.isArray(job.steps) || job.steps.length !== expectedSteps.length) {
                    fail(code, 'The complete executed predecessor step inventory is missing.');
                }
                const numbers = new Set();
                for (const step of job.steps) {
                    exactKeys(step, ['conclusion', 'name', 'number', 'status'], code, 'Predecessor step');
                    const expectedStep = expectedSteps.find(([number]) => number === step.number);
                    if (!expectedStep || numbers.has(step.number) || step.status !== 'completed' ||
                        step.name !== expectedStep[1] || step.conclusion !== expectedStep[2]) {
                        fail(code, 'A predecessor step differs from the exact nonmutating incident.');
                    }
                    numbers.add(step.number);
                }
            }
        }
        const earlier = proof[phase].controller.run;
        const later = proof[phase].witness.run;
        if (Date.parse(later.createdAt) < Date.parse(earlier.runStartedAt) ||
            Date.parse(later.updatedAt) < Date.parse(earlier.updatedAt)) {
            fail(code, 'The historical predecessor pair has contradictory timing.');
        }
        // The rolling proof already rejects duplicate numbers. Require every intervening number.
        const intervening = runtimeSafety.snapshots[phase].rolling.headers.filter((run) =>
            run.workflowId === records.origin.workflowId &&
            BigInt(run.runNumber) > 3n && BigInt(run.runNumber) < 6n);
        if (intervening.length !== 2 || !intervening.some((run) => run.runId === incident.controller.runId) ||
            !intervening.some((run) => run.runId === incident.witness.runId)) {
            fail(code, 'The complete intervening run inventory is not the exact incident pair.');
        }
    }
    if (JSON.stringify(proof.before) !== JSON.stringify(proof.after)) {
        fail(code, 'The authenticated predecessor proof changed during collection.');
    }
}

function validateConnectorRecoveryFreshness(evidence, expected) {
    const code = 'connector_recovery_freshness_invalid';
    exactKeys(evidence, [
        'attempt2Absence', 'chainSnapshots', 'controller', 'kind', 'origin',
        'runtimeSafety', 'schemaVersion', 'witness',
        ...(Object.prototype.hasOwnProperty.call(evidence || {}, 'predecessorProof') ? ['predecessorProof'] : [])
    ], code, 'Connector recovery freshness evidence');
    exactKeys(expected, ['controller', 'mode', 'origin', 'schemaVersion', 'witness'], code,
        'Expected connector recovery freshness identity');
    if (evidence.schemaVersion !== 4 ||
        evidence.kind !== 'nofries-connector-recovery-freshness' ||
        expected.schemaVersion !== 4 || expected.mode !== 'manual') {
        fail(code, 'Connector recovery freshness evidence must use manual schema v4.');
    }

    const trusted = Object.create(null);
    for (const name of ['origin', 'controller', 'witness']) {
        exactKeys(expected[name], ['headSha', 'runAttempt', 'runId'], code, `Expected ${name}`);
        trusted[name] = Object.freeze({
            runId: positiveId(expected[name].runId, code, `${name}.runId`),
            runAttempt: positiveId(expected[name].runAttempt, code, `${name}.runAttempt`),
            headSha: fullSha(expected[name].headSha, code, `${name}.headSha`)
        });
        if (trusted[name].runAttempt !== '1') {
            fail('connector_recovery_freshness_rerun_unsupported',
                'The origin, controller, and witness must all be first attempts.');
        }
    }
    if (new Set(Object.values(trusted).map((identity) => identity.runId)).size !== 3 ||
        trusted.controller.headSha !== trusted.witness.headSha) {
        fail(code, 'The connector recovery chain identity is not one-shot.');
    }

    const runtime = validateRerunnableProductionSafety(evidence.runtimeSafety, {
        currentRunAttempt: trusted.controller.runAttempt,
        currentRunId: trusted.controller.runId,
        currentSha: trusted.controller.headSha,
        workflowFile: 'release-connector-production.yml'
    });
    exactKeys(evidence.chainSnapshots, ['after', 'before'], code,
        'Connector recovery chain snapshots');
    const snapshots = Object.create(null);
    for (const phase of ['before', 'after']) {
        exactKeys(evidence.chainSnapshots[phase], ['controller', 'origin', 'witness'], code,
            `${phase} connector chain snapshot`);
        const records = Object.create(null);
        for (const name of ['origin', 'controller', 'witness']) {
            const run = recoveryRunRecord(evidence.chainSnapshots[phase][name],
                `${phase} connector ${name}`);
            const identity = trusted[name];
            if (run.runId !== identity.runId || run.runAttempt !== identity.runAttempt ||
                run.headSha !== identity.headSha || run.workflowId !== runtime.workflowId ||
                run.event !== 'workflow_dispatch' || run.headBranch !== 'main' ||
                run.path !== EXPECTED_CONNECTOR_RELEASE.workflowPath ||
                run.repository !== EXPECTED_CONNECTOR_RELEASE.repository) {
                fail(code, `The ${phase} connector ${name} provenance is invalid.`);
            }
            records[name] = run;
        }
        if (records.origin.status !== 'completed' ||
            !NON_SUCCESS_CONCLUSIONS.has(records.origin.conclusion) ||
            records.controller.status !== 'in_progress' || records.controller.conclusion !== null ||
            !['queued', 'pending', 'requested', 'waiting'].includes(records.witness.status) ||
            records.witness.conclusion !== null ||
            records.witness.displayTitle !==
                `Connector freshness witness for ${records.controller.runId}`) {
            fail(code, `The ${phase} connector chain state is invalid.`);
        }
        const adjacentOrigin = BigInt(records.controller.runNumber) === BigInt(records.origin.runNumber) + 1n;
        if (!adjacentOrigin) {
            if (!evidence.predecessorProof) fail('connector_recovery_stale',
                'A nonadjacent origin requires the exact authenticated historical incident bridge.');
            validateConnectorNonmutatingPredecessors(evidence.predecessorProof, records, evidence.runtimeSafety);
        } else if (evidence.predecessorProof !== undefined && evidence.predecessorProof !== null) {
            fail(code, 'An adjacent recovery must not carry a predecessor bridge.');
        }
        if (BigInt(records.witness.runNumber) !== BigInt(records.controller.runNumber) + 1n ||
            records.controller.runStartedAtMilliseconds === null ||
            records.controller.runStartedAtMilliseconds <= records.origin.updatedAtMilliseconds ||
            records.witness.createdAtMilliseconds < records.controller.runStartedAtMilliseconds) {
            fail('connector_recovery_stale',
                'The exact origin/controller/witness transaction is not N/N+1/N+2.');
        }
        snapshots[phase] = records;
    }
    for (const name of ['origin', 'controller', 'witness']) {
        const before = snapshots.before[name];
        const after = snapshots.after[name];
        if (!sameRecoveryRun(before, after, true) ||
            after.updatedAtMilliseconds < before.updatedAtMilliseconds) {
            fail(code, `The exact connector ${name} changed during freshness collection.`);
        }
        const top = recoveryRunRecord(evidence[name], `Connector ${name}`);
        if (!sameRecoveryRun(top, after)) {
            fail(code, `The top-level connector ${name} is not the final exact snapshot.`);
        }
    }

    exactKeys(evidence.attempt2Absence, ['after', 'before'], code,
        'Connector chain attempt-2 absence');
    for (const phase of ['before', 'after']) {
        const values = evidence.attempt2Absence[phase];
        if (!Array.isArray(values) || values.length !== 3) {
            fail(code, `The ${phase} connector attempt-2 proof is incomplete.`);
        }
        const seen = new Set();
        for (const [index, value] of values.entries()) {
            exactKeys(value, ['httpStatus', 'nextAttempt', 'role', 'runId'], code,
                `${phase} connector attempt-2 proof ${index}`);
            if (!['origin', 'controller', 'witness'].includes(value.role) ||
                value.runId !== trusted[value.role].runId || value.nextAttempt !== '2' ||
                value.httpStatus !== 404 || seen.has(value.role)) {
                fail(code, `The ${phase} connector attempt-2 proof is invalid.`);
            }
            seen.add(value.role);
        }
    }
    return Object.freeze({
        attemptCount: runtime.attemptCount,
        controllerRunId: trusted.controller.runId,
        fresh: true,
        mode: expected.mode,
        originRunId: trusted.origin.runId,
        runCount: evidence.runtimeSafety.snapshots.after.rolling.totalCount,
        witnessRunId: trusted.witness.runId
    });
}

function createConnectorReleasePlan(request, bundle, packageBundle) {
    const validatedRequest = validateConnectorReleaseRequest(request);
    const validatedBundle = validateConnectorReleaseManifest(bundle, {
        appBaselineSha: bundle && bundle.cumulativeDelta && bundle.cumulativeDelta.appBaselineSha,
        connectorBaselineSha: bundle && bundle.cumulativeDelta && bundle.cumulativeDelta.connectorBaselineSha,
        connectorBaselineRunId: bundle && bundle.rollback && bundle.rollback.runId,
        connectorBaselineRunAttempt: bundle && bundle.rollback && bundle.rollback.runAttempt,
        liveEvalRunId: validatedRequest.liveEvalRunId,
        releaseRunAttempt: validatedRequest.workflowRunAttempt,
        releaseRunId: validatedRequest.workflowRunId,
        targetSha: validatedRequest.releaseSha,
        workflowSha: validatedRequest.workflowSha
    }, packageBundle);
    const plan = deepFreeze({
        request: snapshot(validatedRequest),
        bundle: snapshot(bundle),
        identity: snapshot(validatedBundle)
    });
    VALID_PLANS.add(plan);
    return plan;
}

function startConnectorRelease(plan) {
    if (!VALID_PLANS.has(plan)) fail('connector_release_plan_invalid', 'Connector release plan is not validated.');
    return freezeState({
        stage: 'planned', terminal: false, outcome: null,
        mutationStarted: false, recoveryRequired: false,
        authenticatedCanary: false, tenantNegativeCanary: false,
        plan
    });
}

function transitionConnectorRelease(state, event) {
    if (!VALID_STATES.has(state)) fail('connector_release_state_invalid', 'Connector release state is not validated.');
    if (state.terminal) fail('connector_release_terminal', 'Connector release is already terminal.');
    if (typeof event !== 'string') fail('connector_release_transition_invalid', 'Release event is invalid.');
    const next = { ...state };
    if (event === 'failure_before_mutation' && state.stage === 'planned') {
        Object.assign(next, { stage: 'failed_unmutated', terminal: true, outcome: 'failed' });
        return freezeState(next);
    }
    if (event === 'connector_mutation_started' && state.stage === 'planned') {
        Object.assign(next, { stage: 'mutating', mutationStarted: true });
        return freezeState(next);
    }
    if (event === 'connector_deploy_succeeded' && state.stage === 'mutating') {
        next.stage = 'candidate_deployed';
        return freezeState(next);
    }
    if (event === 'authenticated_canary_succeeded' && state.stage === 'candidate_deployed') {
        Object.assign(next, { stage: 'authenticated_canary_proven', authenticatedCanary: true });
        return freezeState(next);
    }
    if (event === 'tenant_negative_canary_succeeded' && state.stage === 'authenticated_canary_proven') {
        Object.assign(next, { stage: 'tenant_negative_canary_proven', tenantNegativeCanary: true });
        return freezeState(next);
    }
    if (event === 'post_probe_succeeded' && state.stage === 'tenant_negative_canary_proven' &&
        state.authenticatedCanary && state.tenantNegativeCanary) {
        Object.assign(next, { stage: 'released', terminal: true, outcome: 'success' });
        return freezeState(next);
    }
    if (['failure', 'cancel'].includes(event) && state.mutationStarted &&
        !['recovering', 'recovering_connector_restored'].includes(state.stage)) {
        Object.assign(next, { stage: 'recovering', recoveryRequired: true, outcome: 'failed' });
        return freezeState(next);
    }
    if (['rollback_deploy_succeeded', 'rollback_already_live'].includes(event) &&
        state.stage === 'recovering') {
        next.stage = 'recovering_connector_restored';
        return freezeState(next);
    }
    if (event === 'rollback_probe_succeeded' && state.stage === 'recovering_connector_restored') {
        Object.assign(next, { stage: 'rolled_back', terminal: true, outcome: 'failed', recoveryRequired: false });
        return freezeState(next);
    }
    if (event === 'recovery_failed' && ['recovering', 'recovering_connector_restored'].includes(state.stage)) {
        Object.assign(next, { stage: 'recovery_failed', terminal: true, outcome: 'recovery_failed', recoveryRequired: true });
        return freezeState(next);
    }
    fail('connector_release_transition_invalid', `Event ${event} is invalid from stage ${state.stage}.`);
}

function freezeState(state) {
    const frozen = Object.freeze(state);
    VALID_STATES.add(frozen);
    return frozen;
}

module.exports = {
    ConnectorProductionReleaseError,
    EXPECTED_CONNECTOR_RELEASE,
    RELEASABLE_CONNECTOR_IMPACT,
    classifyConnectorRecoveryOriginSteps,
    createConnectorReleasePlan,
    extractSingleArtifactMember,
    parseExactTar,
    startConnectorRelease,
    transitionConnectorRelease,
    validateConnectorArtifactEvidence,
    validateConnectorRollbackEvidence,
    validateConnectorRecoveryFreshness,
    validateConnectorRecoveryControl,
    validateConnectorRecoveryOrigin,
    validateConnectorReleaseManifest,
    validateConnectorReleaseRequest,
    validateConnectorRunProvenance,
    validateStandaloneConnectorImpact,
    validateUnifiedConnectorAdmission
};
