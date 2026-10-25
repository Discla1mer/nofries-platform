const OUTLOOK_ACTION_KEY = 'clear_outlook_token_cache_and_restart';

function createMockServiceDeskAdapters(options = {}) {
    const tenantId = cleanIdentifier(options.tenantId);
    const customerId = cleanIdentifier(options.customerId);
    if (!tenantId || !customerId) {
        throw adapterError(500, 'The mock adapter tenant and customer are required', 'adapter_boundary_required');
    }

    return {
        autotask: {
            async createTicket(input, context) {
                assertBoundary(tenantId, customerId, input, context);
                return {
                    provider: 'mock-autotask',
                    simulated: true,
                    externalTicketId: `AT-${shortId(input.ticketId).toUpperCase()}`,
                    queue: 'Service Desk',
                    status: 'New',
                    createdAt: context.at
                };
            },
            async readTicket(input, context) {
                assertBoundary(tenantId, customerId, input, context);
                return {
                    provider: 'mock-autotask',
                    simulated: true,
                    externalTicketId: input.externalTicketId,
                    status: input.status || 'In progress',
                    summary: input.summary,
                    deviceId: input.deviceId,
                    affectedUser: input.affectedUser
                };
            },
            async updateTicket(input, context) {
                assertBoundary(tenantId, customerId, input, context);
                return {
                    provider: 'mock-autotask',
                    simulated: true,
                    externalTicketId: input.externalTicketId,
                    status: input.status,
                    note: cleanText(input.note, 1000),
                    updatedAt: context.at
                };
            }
        },
        datto: {
            async readDevice(input, context) {
                assertBoundary(tenantId, customerId, input, context);
                return {
                    provider: 'mock-datto-rmm',
                    simulated: true,
                    deviceId: input.deviceId,
                    hostname: input.deviceId === 'demo-win11-07' ? 'AKL-LT-007' : cleanText(input.deviceId, 80),
                    operatingSystem: 'Windows 11 Pro',
                    online: true,
                    lastSeenMinutesAgo: 2,
                    patchState: 'current',
                    diskState: 'healthy',
                    securityAgentState: 'healthy'
                };
            },
            async readOutlookAuth(input, context) {
                assertBoundary(tenantId, customerId, input, context);
                return {
                    provider: 'mock-datto-rmm',
                    simulated: true,
                    deviceId: input.deviceId,
                    affectedUser: input.affectedUser,
                    outlookProcessRunning: true,
                    tokenRefreshFailures: 7,
                    failureWindowMinutes: 38,
                    lastError: 'AADSTS50173: The provided grant has expired due to it being revoked',
                    microsoft365ServiceHealth: 'healthy',
                    networkReachability: 'healthy',
                    observation: 'Failures are isolated to the local Outlook authentication cache.'
                };
            },
            async simulateRemediation(input, context) {
                assertBoundary(tenantId, customerId, input, context);
                if (input.actionKey !== OUTLOOK_ACTION_KEY) {
                    throw adapterError(422, 'The requested mock remediation is not supported', 'unsupported_mock_action');
                }
                return {
                    provider: 'mock-datto-rmm',
                    simulated: true,
                    actionKey: input.actionKey,
                    deviceId: input.deviceId,
                    outcome: 'simulated_success',
                    commandsRun: [
                        'Close Outlook for the affected user',
                        'Clear the local Outlook identity token cache',
                        'Start Outlook and request a fresh sign-in token'
                    ],
                    rollbackRequired: false,
                    executedAt: context.at
                };
            },
            async verifyRemediation(input, context) {
                assertBoundary(tenantId, customerId, input, context);
                const passed = Boolean(
                    input.execution &&
                    input.execution.outcome === 'simulated_success' &&
                    input.execution.actionKey === OUTLOOK_ACTION_KEY
                );
                return {
                    provider: 'mock-datto-rmm',
                    simulated: true,
                    deviceId: input.deviceId,
                    passed,
                    checks: [
                        { name: 'Outlook process restarted', passed },
                        { name: 'Fresh token obtained', passed },
                        { name: 'Mailbox connection healthy', passed },
                        { name: 'No new authentication failure in five-minute sample', passed }
                    ],
                    verifiedAt: context.at
                };
            }
        },
        itGlue: {
            async searchRunbooks(input, context) {
                assertBoundary(tenantId, customerId, input, context);
                const query = cleanText(input.query, 300).toLowerCase();
                const matched = /outlook|authentication|sign.?in|token/.test(query);
                return {
                    provider: 'mock-it-glue',
                    simulated: true,
                    results: matched ? [{
                        id: 'KB-M365-014',
                        title: 'Outlook repeated sign-in prompt — local token reset',
                        classification: 'internal',
                        risk: 'low',
                        approvalRequired: true,
                        actionKey: OUTLOOK_ACTION_KEY,
                        verification: 'Confirm fresh token, mailbox connectivity, and no new authentication errors.'
                    }] : []
                };
            }
        }
    };
}

function assertBoundary(expectedTenantId, expectedCustomerId, input, context) {
    const contextTenantId = cleanIdentifier(context && context.tenantId);
    const resourceTenantId = cleanIdentifier(input && input.resourceTenantId);
    if (!contextTenantId || contextTenantId !== expectedTenantId) {
        throw adapterError(403, 'The adapter context does not match this tenant', 'tenant_boundary_violation');
    }
    if (!resourceTenantId || resourceTenantId !== expectedTenantId) {
        throw adapterError(403, 'The requested resource does not belong to this tenant', 'tenant_boundary_violation');
    }
    const contextCustomerId = cleanIdentifier(context && context.customerId);
    const resourceCustomerId = cleanIdentifier(input && input.resourceCustomerId);
    if (!contextCustomerId || contextCustomerId !== expectedCustomerId) {
        throw adapterError(403, 'The adapter context does not match this customer', 'customer_boundary_violation');
    }
    if (!resourceCustomerId || resourceCustomerId !== expectedCustomerId) {
        throw adapterError(403, 'The requested resource does not belong to this customer', 'customer_boundary_violation');
    }
}

function adapterError(statusCode, message, code) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.details = { code };
    return error;
}

function shortId(value) {
    return String(value || '00000000').replace(/[^a-z0-9]/gi, '').slice(-8) || '00000000';
}

function cleanText(value, limit) {
    return String(value || '').trim().slice(0, limit);
}

function cleanIdentifier(value) {
    return String(value || '').trim().toLowerCase();
}

module.exports = {
    OUTLOOK_ACTION_KEY,
    createMockServiceDeskAdapters
};
