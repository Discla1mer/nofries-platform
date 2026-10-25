'use strict';

const { getReleaseIdentity } = require('./releaseIdentity');
const { tenantStorageKey } = require('./tenantAccess');

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_HEALTH_AGE_MS = 48 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 5 * 60 * 1000;
const MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

let activeScheduler = null;

function startMonthlyProofScheduler(options = {}) {
    if (activeScheduler) return activeScheduler;
    const env = options.env || process.env;
    const enabled = String(env.NOFRIES_MONTHLY_PROOF_SCHEDULER_ENABLED || '').trim().toLowerCase();
    if (!enabled && legacyPreCutoverStagingAllowed(env)) {
        // A unified source release necessarily precedes the dedicated settings
        // cutover. The legacy production vector has neither the portal nor the
        // Autotask desk selected, so expose no scheduler surface and let the host
        // start. Once either production feature is selected, an absent setting is
        // a configuration error and target/canary readiness remains fail-closed.
        return null;
    }
    if (enabled === 'false') {
        activeScheduler = disabledScheduler();
        return activeScheduler;
    }
    if (enabled !== 'true') {
        throw schedulerError('Hosted monthly Proof scheduling must be explicitly enabled or disabled', 'monthly_proof_scheduler_setting_invalid');
    }
    const lifecycleProvider = String(
        env.NOFRIES_LIFECYCLE_STORAGE_PROVIDER || env.NOFRIES_STORAGE_PROVIDER || ''
    ).trim().toLowerCase();
    if (lifecycleProvider !== 'azure') {
        throw schedulerError('Hosted monthly Proof scheduling requires Azure lifecycle storage', 'monthly_proof_scheduler_storage_invalid');
    }
    const releaseIdentity = options.releaseIdentity || getReleaseIdentity();
    if (!releaseIdentity || !/^[a-f0-9]{40}$/.test(String(releaseIdentity.releaseSha || ''))) {
        throw schedulerError('Hosted monthly Proof scheduling requires an exact release identity', 'monthly_proof_scheduler_release_invalid');
    }
    const intervalMs = boundedDuration(env.NOFRIES_MONTHLY_PROOF_INTERVAL_MS, DEFAULT_INTERVAL_MS);
    const maxHealthAgeMs = boundedDuration(
        env.NOFRIES_MONTHLY_PROOF_HEALTH_MAX_AGE_MS,
        DEFAULT_MAX_HEALTH_AGE_MS,
        DEFAULT_INTERVAL_MS,
        14 * 24 * 60 * 60 * 1000
    );
    const now = options.now || (() => new Date());
    const repositoryOverride = Object.prototype.hasOwnProperty.call(options, 'repository');
    const serviceOverride = Object.prototype.hasOwnProperty.call(options, 'service');
    if (repositoryOverride !== serviceOverride) {
        throw schedulerError(
            'Monthly Proof scheduler repository and service overrides must be supplied together',
            'monthly_proof_dependency_pair_invalid'
        );
    }
    let repository;
    let service;
    if (repositoryOverride) {
        repository = options.repository;
        service = options.service;
    } else {
        // Resolve lazily because appLifecycleRuntime also owns the HTTP routes
        // that load this scheduler through the customer-portal runtime.
        const lifecycleRuntime = require('./appLifecycleRuntime');
        repository = lifecycleRuntime.getLifecycleRepository();
        service = lifecycleRuntime.getLifecycleService();
    }
    if (!repository || typeof repository.verifyProofPersistence !== 'function') {
        throw schedulerError('Lifecycle storage cannot verify monthly Proof persistence', 'monthly_proof_persistence_verifier_missing');
    }
    const access = options.access || systemAccess(env);
    const logger = options.logger || console;
    const setTimer = options.setTimeout || setTimeout;
    const clearTimer = options.clearTimeout || clearTimeout;
    const health = {
        enabled: true,
        status: 'starting',
        cadence: 'daily',
        lastAttemptAt: '',
        lastSucceededAt: '',
        nextDueAt: '',
        persistenceVerified: false,
        persistenceReceiptSha256: '',
        errorCode: ''
    };
    let timer = null;
    let stopped = false;
    let running = false;

    async function run() {
        if (stopped || running) return healthSnapshot(health, now(), maxHealthAgeMs);
        running = true;
        const startedAt = now();
        health.status = 'running';
        health.lastAttemptAt = startedAt.toISOString();
        health.errorCode = '';
        try {
            const receipt = await repository.verifyProofPersistence({
                operationId: `monthly-proof:${releaseIdentity.releaseSha}:${releaseIdentity.runId}`,
                releaseSha: releaseIdentity.releaseSha
            });
            if (!receipt || receipt.verified !== true || !/^[a-f0-9]{64}$/.test(String(receipt.receiptSha256 || ''))) {
                throw schedulerError('Monthly Proof persistence verification did not return a valid receipt', 'monthly_proof_persistence_receipt_invalid');
            }
            health.persistenceVerified = true;
            health.persistenceReceiptSha256 = receipt.receiptSha256;
            await runControlsWithRetry(repository, service, access, startedAt.toISOString());
            health.status = 'ready';
            health.lastSucceededAt = now().toISOString();
        } catch (error) {
            health.status = 'error';
            health.persistenceVerified = false;
            health.persistenceReceiptSha256 = '';
            health.errorCode = safeErrorCode(error);
            if (logger && typeof logger.error === 'function') {
                logger.error(`Monthly Proof scheduler failed (${health.errorCode}).`);
            }
        } finally {
            running = false;
            if (!stopped) {
                health.nextDueAt = new Date(now().getTime() + intervalMs).toISOString();
                timer = setTimer(() => {
                    void run();
                }, intervalMs);
                if (timer && typeof timer.unref === 'function') timer.unref();
            }
        }
        return healthSnapshot(health, now(), maxHealthAgeMs);
    }

    activeScheduler = {
        health() {
            return healthSnapshot(health, now(), maxHealthAgeMs);
        },
        run,
        stop() {
            stopped = true;
            if (timer) clearTimer(timer);
            timer = null;
            health.nextDueAt = '';
        }
    };
    activeScheduler.startPromise = run();
    return activeScheduler;
}

function legacyPreCutoverStagingAllowed(env = process.env) {
    const portalSelected = String(env.NOFRIES_CUSTOMER_PORTAL_ENABLED || '').trim().toLowerCase() === 'true';
    const serviceDeskSelected = String(env.NOFRIES_SERVICE_DESK_PROVIDER || 'mock').trim().toLowerCase() === 'autotask';
    return !portalSelected && !serviceDeskSelected;
}

function disabledScheduler() {
    const health = Object.freeze({
        enabled: false,
        status: 'disabled',
        cadence: 'daily',
        lastAttemptAt: '',
        lastSucceededAt: '',
        nextDueAt: '',
        persistenceVerified: false,
        persistenceReceiptSha256: '',
        errorCode: ''
    });
    return {
        startPromise: Promise.resolve(health),
        health() { return health; },
        async run() { return health; },
        stop() {}
    };
}

async function runControlsWithRetry(repository, service, access, scheduledFor) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const state = await repository.read(access);
        try {
            return await service.runCustomerControls(access, {
                expectedRevision: state.revision,
                scheduledFor,
                confirmInternalOnly: true
            });
        } catch (error) {
            lastError = error;
            if (!(error && error.details && error.details.code === 'revision_conflict')) throw error;
        }
    }
    throw lastError;
}

function getMonthlyProofSchedulerHealth(options = {}) {
    if (!activeScheduler) return null;
    return activeScheduler.health(options);
}

function requireMonthlyProofProductionReady(options = {}) {
    const health = options.health || getMonthlyProofSchedulerHealth();
    if (
        !health || health.enabled !== true || health.status !== 'ready' || health.cadence !== 'daily' ||
        health.persistenceVerified !== true || !/^[a-f0-9]{64}$/.test(String(health.persistenceReceiptSha256 || '')) ||
        !health.lastSucceededAt || !health.nextDueAt
    ) {
        throw schedulerError('Monthly Proof production runtime is unavailable', 'monthly_proof_runtime_unavailable');
    }
    return health;
}

function healthSnapshot(health, now, maxAgeMs) {
    const snapshot = Object.assign({}, health);
    const lastSucceeded = Date.parse(snapshot.lastSucceededAt || '');
    if (
        snapshot.status === 'ready' &&
        (!Number.isFinite(lastSucceeded) || now.getTime() - lastSucceeded > maxAgeMs || now.getTime() < lastSucceeded - (5 * 60 * 1000))
    ) snapshot.status = 'stale';
    return Object.freeze(snapshot);
}

function systemAccess(env) {
    const tenantId = String(env.NOFRIES_DEFAULT_TENANT_ID || env.NOFRIES_TENANT_SLUG || 'founding-pilot').trim();
    const tenantName = String(env.NOFRIES_TENANT_NAME || 'No Fries').trim().slice(0, 120);
    return {
        allowed: true,
        user: {
            email: 'monthly-proof-scheduler@nofries.invalid',
            name: 'Monthly Proof scheduler',
            principalId: '',
            identityTenantId: '',
            subjectKey: '',
            actorId: 'monthly-proof-scheduler',
            role: 'system',
            capabilities: []
        },
        tenant: {
            id: tenantId,
            key: tenantStorageKey(tenantId),
            name: tenantName,
            slug: String(env.NOFRIES_TENANT_SLUG || tenantName).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
        },
        authentication: { required: true, authenticated: true, provider: 'system' }
    };
}

function boundedDuration(value, fallback, minimum = MIN_INTERVAL_MS, maximum = MAX_INTERVAL_MS) {
    if (value == null || String(value).trim() === '') return fallback;
    const duration = Number(value);
    if (!Number.isSafeInteger(duration) || duration < minimum || duration > maximum) {
        throw schedulerError('Monthly Proof scheduler duration setting is invalid', 'monthly_proof_scheduler_duration_invalid');
    }
    return duration;
}

function safeErrorCode(error) {
    const candidate = String(error && (error.code || error.details && error.details.code) || 'monthly_proof_scheduler_failed')
        .trim().toLowerCase();
    return /^[a-z0-9_]{1,120}$/.test(candidate) ? candidate : 'monthly_proof_scheduler_failed';
}

function schedulerError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function resetMonthlyProofSchedulerForTests() {
    if (activeScheduler) activeScheduler.stop();
    activeScheduler = null;
}

module.exports = {
    DEFAULT_INTERVAL_MS,
    DEFAULT_MAX_HEALTH_AGE_MS,
    getMonthlyProofSchedulerHealth,
    requireMonthlyProofProductionReady,
    resetMonthlyProofSchedulerForTests,
    startMonthlyProofScheduler,
    systemAccess
};
