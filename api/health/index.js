const { apiSecurityHeaders } = require('../shared/securityHeaders');
const { getReleaseIdentity } = require('../shared/releaseIdentity');
const { getMonthlyProofSchedulerHealth } = require('../shared/monthlyProofScheduler');
const {
    getLifecycleHealth,
    getServiceDeskControlsDigest,
    getServiceDeskHealth
} = require('../shared/serviceDeskHealth');

module.exports = async function health(context, req, dependencies = {}) {
    const env = dependencies.env || process.env;
    const resolveReleaseIdentity = typeof dependencies.getReleaseIdentity === 'function'
        ? dependencies.getReleaseIdentity
        : getReleaseIdentity;
    const releaseIdentity = resolveReleaseIdentity();
    const resolveMonthlyProofHealth = typeof dependencies.getMonthlyProofSchedulerHealth === 'function'
        ? dependencies.getMonthlyProofSchedulerHealth
        : getMonthlyProofSchedulerHealth;
    const monthlyProofScheduler = resolveMonthlyProofHealth();
    const resolveServiceDeskHealth = typeof dependencies.getServiceDeskHealth === 'function'
        ? dependencies.getServiceDeskHealth
        : getServiceDeskHealth;
    const serviceDesk = await resolveServiceDeskHealth(env);
    const productionDeskSelected = String(env.NOFRIES_SERVICE_DESK_PROVIDER || 'mock').trim().toLowerCase() === 'autotask' || Boolean(serviceDesk);
    const monthlyProofState = monthlyProofRuntimeState(env, monthlyProofScheduler, productionDeskSelected);
    const monthlyProofReady = monthlyProofState.ready;
    const resolveLifecycleHealth = typeof dependencies.getLifecycleHealth === 'function'
        ? dependencies.getLifecycleHealth
        : getLifecycleHealth;
    const resolveControlsDigest = typeof dependencies.getServiceDeskControlsDigest === 'function'
        ? dependencies.getServiceDeskControlsDigest
        : getServiceDeskControlsDigest;
    const lifecycleSelected = productionDeskSelected || Boolean(monthlyProofScheduler);
    const lifecycle = lifecycleSelected ? resolveLifecycleHealth(env) : null;
    const serviceDeskControls = productionDeskSelected ? resolveControlsDigest(env) : '';
    const productionControlsReady = !productionDeskSelected || Boolean(
        serviceDesk && serviceDesk.ready === true && lifecycle && lifecycle.ready === true && serviceDeskControls
    );
    const monthlyProofLifecycleReady = monthlyProofState.legacy || Boolean(
        monthlyProofScheduler && lifecycle && lifecycle.storageProvider === 'azure' &&
        lifecycle.durable === true && lifecycle.ready === true
    );
    const ready = Boolean(releaseIdentity) && monthlyProofReady && monthlyProofLifecycleReady && productionControlsReady;
    const runtimeFields = Object.assign(
        {},
        monthlyProofScheduler ? { monthlyProofScheduler } : {},
        productionDeskSelected ? { serviceDeskControls, serviceDesk } : {},
        lifecycleSelected ? { lifecycle } : {}
    );
    context.res = {
        status: ready ? 200 : 503,
        headers: apiSecurityHeaders({
            'Cache-Control': 'private, no-store, max-age=0',
            'Content-Type': 'application/json; charset=utf-8',
        }),
        body: ready
            ? Object.assign({
                status: 'ok',
                service: 'nofries-web-api',
                releaseSha: releaseIdentity.releaseSha,
                releaseRunId: releaseIdentity.runId
            }, runtimeFields)
            : {
                status: 'unavailable',
                code: !releaseIdentity
                    ? 'release_identity_unavailable'
                    : !monthlyProofReady || !monthlyProofLifecycleReady
                        ? 'monthly_proof_runtime_unavailable'
                        : 'service_desk_runtime_unavailable',
                ...runtimeFields
            }
    };
};

function monthlyProofRuntimeState(env, health, productionDeskSelected) {
    const legacy = !health && legacyPreCutoverStagingAllowed(env, productionDeskSelected);
    const emergency = Boolean(
        health && health.enabled === false && health.status === 'disabled' && exactEmergencyReadOnlyVector(env)
    );
    const scheduled = Boolean(
        health && health.enabled === true && ['ready', 'healthy'].includes(health.status)
    );
    return { emergency, legacy, ready: legacy || emergency || scheduled };
}

function legacyPreCutoverStagingAllowed(env, productionDeskSelected) {
    const schedulerSetting = String(env.NOFRIES_MONTHLY_PROOF_SCHEDULER_ENABLED || '').trim();
    const portalSelected = String(env.NOFRIES_CUSTOMER_PORTAL_ENABLED || '').trim().toLowerCase() === 'true';
    const serviceDeskSelected = String(env.NOFRIES_SERVICE_DESK_PROVIDER || 'mock').trim().toLowerCase() === 'autotask';
    return !schedulerSetting && !portalSelected && !serviceDeskSelected && !productionDeskSelected;
}

function exactEmergencyReadOnlyVector(env) {
    return String(env.NOFRIES_SERVICE_DESK_PROVIDER || '').trim().toLowerCase() === 'autotask' &&
        String(env.NOFRIES_CUSTOMER_PORTAL_ENABLED || '').trim().toLowerCase() === 'true' &&
        String(env.NOFRIES_CUSTOMER_PORTAL_WRITES_ENABLED || '').trim().toLowerCase() === 'false' &&
        String(env.NOFRIES_CUSTOMER_PORTAL_WRITE_SCOPE || '').trim().toLowerCase() === 'disabled' &&
        String(env.NOFRIES_SERVICE_DESK_WRITE_SCOPE || '').trim().toLowerCase() === 'disabled' &&
        String(env.NOFRIES_AUTOTASK_MODE || '').trim().toLowerCase() === 'readonly' &&
        String(env.NOFRIES_AUTOTASK_WRITE_ENABLED || '').trim().toLowerCase() === 'false' &&
        String(env.NOFRIES_MONTHLY_PROOF_SCHEDULER_ENABLED || '').trim().toLowerCase() === 'false' &&
        String(env.NOFRIES_LIFECYCLE_STORAGE_PROVIDER || '').trim().toLowerCase() === 'azure';
}
