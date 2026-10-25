class ServiceDeskProviderAdmissionError extends Error {
    constructor(statusCode, message, code, details = {}) {
        super(message);
        this.statusCode = statusCode;
        this.details = Object.assign({ code }, details);
    }
}

const { parseCanonicalProviderId } = require('./providerIds');

function assertServiceDeskProviderAdmission(options = {}) {
    const env = options.env || process.env;
    const access = options.access || {};
    const binding = options.binding || {};
    const runtime = options.runtimeStatus || {};
    const operation = options.operation === 'write' ? 'write' : 'read';
    const provider = String(env.NOFRIES_SERVICE_DESK_PROVIDER || 'mock').trim().toLowerCase();
    if (provider !== 'autotask') {
        throw admissionError(503, 'The production service desk provider is not selected', 'service_desk_provider_not_selected');
    }
    const tenantBinding = String(env.NOFRIES_AUTOTASK_TENANT_ID || '').trim().toLowerCase();
    const identityTenantId = String(access.user && access.user.identityTenantId || '').trim().toLowerCase();
    const workspaceTenantId = String(access.tenant && access.tenant.id || '').trim().toLowerCase();
    const bindingWorkspaceTenantId = String(binding.tenantId || '').trim().toLowerCase();
    if (!tenantBinding || !identityTenantId || tenantBinding !== identityTenantId) {
        throw admissionError(403, 'The Autotask connection is not bound to this tenant', 'autotask_tenant_binding_mismatch');
    }
    if (!workspaceTenantId || !bindingWorkspaceTenantId || workspaceTenantId !== bindingWorkspaceTenantId) {
        throw admissionError(403, 'The customer provider binding belongs to another workspace', 'autotask_workspace_binding_mismatch');
    }
    if (
        runtime.provider !== 'autotask' || runtime.sourceOfTruth !== true || runtime.configured !== true ||
        runtime.exactMappings !== true || runtime.customerVisibleNotes !== true || runtime.operationMarkerConfigured !== true ||
        runtime.portalVisibilityReady !== true || runtime.priorityMappingVerified !== true ||
        runtime.durableOperationFence !== true || runtime.crossInstanceExclusive !== true || runtime.leaseRenewal !== true ||
        runtime.immutableOperationBinding !== true || runtime.terminalReceiptArchive !== true ||
        runtime.boundedDuplicateIntentIndex !== true
    ) {
        throw admissionError(503, 'The production service desk controls are not ready', 'service_desk_provider_not_ready');
    }
    if (!parseCanonicalProviderId(binding.companyId)) {
        throw admissionError(409, 'The customer has no exact Autotask company mapping', 'autotask_company_mapping_required');
    }
    if (operation === 'write' && runtime.writeOperationsEnabled !== true) {
        throw admissionError(503, 'Production service desk writes are disabled', 'service_desk_writes_disabled');
    }
    return { admitted: true, provider: 'autotask', operation };
}

function admissionStatus(options = {}) {
    try {
        return Object.assign({ ready: true }, assertServiceDeskProviderAdmission(options));
    } catch (error) {
        return {
            ready: false,
            provider: 'autotask',
            operation: options.operation === 'write' ? 'write' : 'read',
            code: error && error.details && error.details.code || 'service_desk_provider_not_ready'
        };
    }
}

function admissionError(statusCode, message, code, details) {
    return new ServiceDeskProviderAdmissionError(statusCode, message, code, details);
}

module.exports = {
    ServiceDeskProviderAdmissionError,
    admissionStatus,
    assertServiceDeskProviderAdmission
};
