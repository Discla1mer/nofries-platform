const crypto = require('crypto');
const { createAutotaskRuntime } = require('./serviceDesk/autotaskRuntimeFactory');

const PROVIDER_HEALTH_TTL_MS = 15 * 1000;
const PROVIDER_HEALTH_FAILURE_TTL_MS = 15 * 1000;
const PROVIDER_HEALTH_TIMEOUT_MS = 4 * 1000;
const MAX_PROVIDER_HEALTH_CACHE_KEYS = 8;
const providerHealthCache = new Map();

async function getServiceDeskHealth(env = process.env, dependencies = {}) {
    const provider = String(env.NOFRIES_SERVICE_DESK_PROVIDER || 'mock').trim().toLowerCase();
    if (provider !== 'autotask') return null;
    let runtime;
    try {
        runtime = dependencies.runtime || createAutotaskRuntime({
            env,
            timeoutMs: positiveInteger(dependencies.providerTimeoutMs, 3000, 1000, PROVIDER_HEALTH_TIMEOUT_MS)
        });
        const status = runtime.status();
        const storageProvider = String(env.NOFRIES_SERVICE_DESK_STORAGE_PROVIDER || '').trim().toLowerCase();
        const operationStorageProvider = String(env.NOFRIES_SERVICE_DESK_OPERATION_STORAGE_PROVIDER || '').trim().toLowerCase();
        const durable = storageProvider === 'azure' && operationStorageProvider === 'azure' &&
            status.durableOperationFence === true && status.crossInstanceExclusive === true && status.leaseRenewal === true &&
            status.immutableOperationBinding === true && status.terminalReceiptArchive === true &&
            status.boundedDuplicateIntentIndex === true;
        const admissionReady = status.writeScopeReady === true || (
            status.mode === 'readonly' && status.writeScope === 'disabled' &&
            status.writeOperationsEnabled === false
        );
        const localReady = status.configured === true && durable && admissionReady &&
            status.providerAccountReady === true && status.portalVisibilityReady === true &&
            status.priorityMappingVerified === true && status.dattoRmmSourceMappingReady === true;
        const checked = localReady
            ? await cachedProviderHealth(runtime, env, dependencies)
            : { connected: false, fresh: false, checkedAt: '', state: 'configuration_unavailable' };
        return {
            provider: 'autotask',
            mode: status.mode,
            storageProvider,
            operationStorageProvider,
            durable,
            ready: localReady && checked.connected === true && checked.fresh === true,
            connected: checked.connected === true,
            providerHealthFresh: checked.fresh === true,
            providerCheckedAt: checked.checkedAt,
            providerHealthState: checked.state,
            writeOperationsEnabled: status.writeOperationsEnabled === true,
            providerAccountReady: status.providerAccountReady === true,
            portalVisibilityReady: status.portalVisibilityReady === true,
            priorityMappingVerified: status.priorityMappingVerified === true,
            dattoRmmSourceMappingReady: status.dattoRmmSourceMappingReady === true,
            statusWritesEnabled: status.statusWritesEnabled === true
        };
    } catch (error) {
        return {
            provider: 'autotask',
            mode: 'unavailable',
            storageProvider: String(env.NOFRIES_SERVICE_DESK_STORAGE_PROVIDER || '').trim().toLowerCase(),
            operationStorageProvider: String(env.NOFRIES_SERVICE_DESK_OPERATION_STORAGE_PROVIDER || '').trim().toLowerCase(),
            durable: false,
            ready: false,
            connected: false,
            providerHealthFresh: false,
            providerCheckedAt: '',
            providerHealthState: 'unavailable',
            writeOperationsEnabled: false,
            providerAccountReady: false,
            portalVisibilityReady: false,
            priorityMappingVerified: false,
            dattoRmmSourceMappingReady: false,
            statusWritesEnabled: false
        };
    }
}

async function cachedProviderHealth(runtime, env, dependencies) {
    if (!runtime || typeof runtime.health !== 'function') {
        return { connected: false, fresh: false, checkedAt: '', state: 'probe_unavailable' };
    }
    const now = typeof dependencies.now === 'function' ? dependencies.now : () => new Date();
    const at = validDate(now());
    const cache = dependencies.providerHealthCache || providerHealthCache;
    const cacheKey = providerHealthCacheKey(env);
    const existing = cache.get(cacheKey);
    if (existing && existing.value && existing.expiresAt > at.getTime()) return existing.value;
    if (existing && existing.promise) return existing.promise;

    const timeoutMs = positiveInteger(dependencies.probeTimeoutMs, PROVIDER_HEALTH_TIMEOUT_MS, 50, 10000);
    const ttlMs = positiveInteger(dependencies.probeTtlMs, PROVIDER_HEALTH_TTL_MS, 100, 60000);
    const failureTtlMs = positiveInteger(dependencies.failureTtlMs, PROVIDER_HEALTH_FAILURE_TTL_MS, 100, 30000);
    let promise;
    promise = boundedHealthProbe(runtime, timeoutMs)
        .then((result) => normaliseProviderHealth(result, validDate(now()), ttlMs))
        .catch(() => ({
            connected: false,
            fresh: false,
            checkedAt: validDate(now()).toISOString(),
            state: 'unavailable'
        }))
        .then((value) => {
            const completedAt = validDate(now()).getTime();
            const current = cache.get(cacheKey);
            if (!current || current.promise !== promise) return value;
            const providerExpiry = Date.parse(value.checkedAt || '') + ttlMs;
            const expiresAt = value.connected && value.fresh && Number.isFinite(providerExpiry)
                ? Math.min(completedAt + ttlMs, providerExpiry)
                : completedAt + failureTtlMs;
            cache.set(cacheKey, {
                value,
                expiresAt,
                promise: null
            });
            pruneProviderHealthCache(cache, completedAt);
            return value;
        });
    cache.set(cacheKey, { value: existing && existing.value || null, expiresAt: 0, promise });
    return promise;
}

function boundedHealthProbe(runtime, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('provider health timeout')), timeoutMs);
        Promise.resolve()
            .then(() => runtime.health())
            .then(resolve, reject)
            .finally(() => clearTimeout(timer));
    });
}

function normaliseProviderHealth(value, at, ttlMs) {
    const checked = Date.parse(value && value.checkedAt || '');
    const age = at.getTime() - checked;
    const fresh = value && value.connected === true && Number.isFinite(checked) && age >= 0 && age <= ttlMs;
    return {
        connected: fresh,
        fresh,
        checkedAt: Number.isFinite(checked) ? new Date(checked).toISOString() : '',
        state: fresh ? 'connected' : 'stale'
    };
}

function providerHealthCacheKey(env) {
    return crypto.createHash('sha256').update(JSON.stringify({
        provider: cacheBinding(env.NOFRIES_SERVICE_DESK_PROVIDER, true),
        providerScope: cacheBinding(env.NOFRIES_AUTOTASK_PROVIDER_SCOPE_ID, true),
        providerAccount: cacheBinding(env.NOFRIES_AUTOTASK_PROVIDER_ACCOUNT_ID, true),
        apiUrl: cacheBinding(env.NOFRIES_AUTOTASK_API_URL),
        allowedHosts: cacheBinding(env.NOFRIES_AUTOTASK_ALLOWED_HOSTS, true),
        username: cacheBinding(env.NOFRIES_AUTOTASK_USERNAME),
        secret: cacheBinding(env.NOFRIES_AUTOTASK_SECRET),
        integrationCode: cacheBinding(env.NOFRIES_AUTOTASK_INTEGRATION_CODE),
        controls: cacheBinding(env.NOFRIES_SERVICE_DESK_CONTROLS_SHA256, true)
    }), 'utf8').digest('hex');
}

function pruneProviderHealthCache(cache, at) {
    for (const [key, entry] of cache.entries()) {
        if (!entry.promise && entry.expiresAt <= at) cache.delete(key);
    }
    while (cache.size > MAX_PROVIDER_HEALTH_CACHE_KEYS) {
        const completed = Array.from(cache.entries()).find(([, entry]) => !entry.promise);
        if (!completed) break;
        cache.delete(completed[0]);
    }
}

function cacheBinding(value, lowerCase = false) {
    const text = String(value || '').trim();
    return lowerCase ? text.toLowerCase() : text;
}

function validDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error('provider health clock unavailable');
    return date;
}

function positiveInteger(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function getLifecycleHealth(env = process.env) {
    const storageProvider = String(env.NOFRIES_LIFECYCLE_STORAGE_PROVIDER || '').trim().toLowerCase();
    return {
        storageProvider,
        durable: storageProvider === 'azure',
        ready: storageProvider === 'azure'
    };
}

function getServiceDeskControlsDigest(env = process.env) {
    const value = String(env.NOFRIES_SERVICE_DESK_CONTROLS_SHA256 || '').trim().toLowerCase();
    return /^[a-f0-9]{64}$/.test(value) ? value : '';
}

module.exports = {
    getLifecycleHealth,
    getServiceDeskControlsDigest,
    getServiceDeskHealth
};
