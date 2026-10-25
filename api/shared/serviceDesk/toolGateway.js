const {
    AGENT_DEFINITIONS,
    TOOL_NAMES,
    TOOL_PERMISSION_CLASSES
} = require('./agentDefinitions');
const { assertKnownPermission, requiresHumanApproval } = require('../agents/actionPolicy');

class ToolGatewayError extends Error {
    constructor(statusCode, message, details = {}) {
        super(message);
        this.statusCode = statusCode;
        this.details = details;
    }
}

function createToolGateway(options = {}) {
    const tenantId = cleanIdentifier(options.tenantId);
    const customerId = cleanIdentifier(options.customerId);
    const adapters = options.adapters;
    const now = typeof options.now === 'function' ? options.now : () => new Date();
    const events = [];

    if (!tenantId || !customerId || !adapters) {
        throw new ToolGatewayError(500, 'The Tool Gateway is not configured', {
            code: 'tool_gateway_not_configured'
        });
    }

    return {
        async invoke(request = {}) {
            const agent = AGENT_DEFINITIONS[request.agentId];
            const tool = String(request.tool || '').trim();
            const input = request.input && typeof request.input === 'object' ? request.input : {};
            const contextTenantId = cleanIdentifier(request.tenantId);

            if (!agent) {
                throw new ToolGatewayError(403, 'Unknown agent identity', { code: 'agent_not_permitted' });
            }
            if (!agent.tools.includes(tool)) {
                throw new ToolGatewayError(403, `${agent.name} is not permitted to use ${tool}`, {
                    code: 'tool_not_permitted',
                    agentId: agent.id,
                    tool
                });
            }
            const permissionClass = assertKnownPermission(TOOL_PERMISSION_CLASSES[tool]);
            if (!contextTenantId || contextTenantId !== tenantId) {
                throw new ToolGatewayError(403, 'The agent request crossed a tenant boundary', {
                    code: 'tenant_boundary_violation'
                });
            }
            if (cleanIdentifier(input.resourceTenantId) !== tenantId) {
                throw new ToolGatewayError(403, 'The requested resource is outside the active tenant', {
                    code: 'tenant_boundary_violation'
                });
            }
            if (cleanIdentifier(input.resourceCustomerId) !== customerId) {
                throw new ToolGatewayError(403, 'The requested resource is outside the active customer', {
                    code: 'customer_boundary_violation'
                });
            }

            if (requiresHumanApproval(permissionClass)) {
                assertApproval(input);
            }

            const at = now().toISOString();
            const result = await dispatch(tool, input, {
                tenantId,
                customerId,
                at
            });
            events.push({
                actorType: 'agent',
                actorId: agent.id,
                actorName: agent.name,
                action: 'tool.invoked',
                targetType: 'tool',
                targetId: tool,
                ticketId: cleanText(input.ticketId, 180),
                summary: `${agent.name} used ${tool}`,
                details: {
                    tool,
                    permissionClass,
                    provider: cleanText(result && result.provider, 80),
                    simulated: Boolean(result && result.simulated),
                    outcome: cleanText(result && (result.outcome || result.status || (result.passed ? 'passed' : 'completed')), 120)
                }
            });
            return result;
        },
        drainAuditEvents() {
            return events.splice(0, events.length);
        }
    };

    async function dispatch(tool, input, context) {
        switch (tool) {
            case TOOL_NAMES.AUTOTASK_TICKET_CREATE:
                return adapters.autotask.createTicket(input, context);
            case TOOL_NAMES.AUTOTASK_TICKET_READ:
                return adapters.autotask.readTicket(input, context);
            case TOOL_NAMES.AUTOTASK_TICKET_UPDATE:
                return adapters.autotask.updateTicket(input, context);
            case TOOL_NAMES.DATTO_DEVICE_READ:
                return adapters.datto.readDevice(input, context);
            case TOOL_NAMES.DATTO_OUTLOOK_AUTH_READ:
                return adapters.datto.readOutlookAuth(input, context);
            case TOOL_NAMES.DATTO_REMEDIATION_SIMULATE:
                return adapters.datto.simulateRemediation(input, context);
            case TOOL_NAMES.DATTO_REMEDIATION_VERIFY:
                return adapters.datto.verifyRemediation(input, context);
            case TOOL_NAMES.IT_GLUE_RUNBOOK_SEARCH:
                return adapters.itGlue.searchRunbooks(input, context);
            default:
                throw new ToolGatewayError(404, 'Tool not found', { code: 'tool_not_found', tool });
        }
    }
}

function assertApproval(input) {
    const approval = input.approval;
    const valid = Boolean(
        approval &&
        approval.status === 'active' &&
        approval.id &&
        approval.recommendationId === input.recommendationId &&
        approval.actionKey === input.actionKey &&
        approval.ticketId === input.ticketId
    );
    if (!valid) {
        throw new ToolGatewayError(409, 'An active approval bound to this recommendation is required', {
            code: 'approval_required'
        });
    }
}

function cleanText(value, limit) {
    return String(value || '').trim().slice(0, limit);
}

function cleanIdentifier(value) {
    return String(value || '').trim().toLowerCase();
}

module.exports = {
    ToolGatewayError,
    createToolGateway
};
