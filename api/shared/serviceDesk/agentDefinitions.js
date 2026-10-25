const { ACTION_PERMISSION } = require('../agents/actionPolicy');

const AGENT_IDS = Object.freeze({
    SERVICE_MANAGER: 'service_manager',
    TECHNICAL_INVESTIGATOR: 'technical_investigator',
    ACTION_AGENT: 'action_agent'
});

const TOOL_NAMES = Object.freeze({
    AUTOTASK_TICKET_CREATE: 'autotask.ticket.create',
    AUTOTASK_TICKET_READ: 'autotask.ticket.read',
    AUTOTASK_TICKET_UPDATE: 'autotask.ticket.update',
    DATTO_DEVICE_READ: 'datto.device.read',
    DATTO_OUTLOOK_AUTH_READ: 'datto.outlook_auth.read',
    DATTO_REMEDIATION_SIMULATE: 'datto.remediation.simulate',
    DATTO_REMEDIATION_VERIFY: 'datto.remediation.verify',
    IT_GLUE_RUNBOOK_SEARCH: 'it_glue.runbook.search'
});

const TOOL_PERMISSION_CLASSES = Object.freeze({
    [TOOL_NAMES.AUTOTASK_TICKET_CREATE]: ACTION_PERMISSION.AUTONOMOUS_RECORD,
    [TOOL_NAMES.AUTOTASK_TICKET_READ]: ACTION_PERMISSION.AUTONOMOUS_READ,
    [TOOL_NAMES.AUTOTASK_TICKET_UPDATE]: ACTION_PERMISSION.AUTONOMOUS_RECORD,
    [TOOL_NAMES.DATTO_DEVICE_READ]: ACTION_PERMISSION.AUTONOMOUS_READ,
    [TOOL_NAMES.DATTO_OUTLOOK_AUTH_READ]: ACTION_PERMISSION.AUTONOMOUS_READ,
    [TOOL_NAMES.DATTO_REMEDIATION_SIMULATE]: ACTION_PERMISSION.HUMAN_APPROVAL_REQUIRED,
    [TOOL_NAMES.DATTO_REMEDIATION_VERIFY]: ACTION_PERMISSION.AUTONOMOUS_READ,
    [TOOL_NAMES.IT_GLUE_RUNBOOK_SEARCH]: ACTION_PERMISSION.AUTONOMOUS_READ
});

const AGENT_DEFINITIONS = Object.freeze({
    [AGENT_IDS.SERVICE_MANAGER]: Object.freeze({
        id: AGENT_IDS.SERVICE_MANAGER,
        name: 'Service coordinator',
        ownership: 'Owns the ticket, customer updates, hand-offs and final result.',
        instructions: [
            'Remain responsible for the customer-facing response from intake to closure.',
            'Delegate evidence gathering to the Technical Investigator.',
            'Never present a remediation as completed until the Action Agent returns verification evidence.',
            'Keep all work inside the authenticated tenant and record material activity.'
        ],
        tools: Object.freeze([
            TOOL_NAMES.AUTOTASK_TICKET_CREATE,
            TOOL_NAMES.AUTOTASK_TICKET_READ,
            TOOL_NAMES.AUTOTASK_TICKET_UPDATE
        ])
    }),
    [AGENT_IDS.TECHNICAL_INVESTIGATOR]: Object.freeze({
        id: AGENT_IDS.TECHNICAL_INVESTIGATOR,
        name: 'Technical review',
        ownership: 'Collects read-only information from the ticket, computer and approved support steps.',
        instructions: [
            'Use read-only tools only.',
            'Separate observed evidence from diagnosis.',
            'Recommend one bounded remediation and identify its risk and approval requirement.',
            'Do not execute, approve, or imply that a change has occurred.'
        ],
        tools: Object.freeze([
            TOOL_NAMES.AUTOTASK_TICKET_READ,
            TOOL_NAMES.DATTO_DEVICE_READ,
            TOOL_NAMES.DATTO_OUTLOOK_AUTH_READ,
            TOOL_NAMES.IT_GLUE_RUNBOOK_SEARCH
        ])
    }),
    [AGENT_IDS.ACTION_AGENT]: Object.freeze({
        id: AGENT_IDS.ACTION_AGENT,
        name: 'Approved action',
        ownership: 'Runs one approved fix, checks the result and records what happened.',
        instructions: [
            'Refuse remediation work without an active approval bound to the current recommendation and action.',
            'Execute only the approved action through the Tool Gateway.',
            'Verify the outcome before updating the ticket.',
            'Do not broaden scope, choose a different action, or access unrelated customer resources.'
        ],
        tools: Object.freeze([
            TOOL_NAMES.AUTOTASK_TICKET_READ,
            TOOL_NAMES.AUTOTASK_TICKET_UPDATE,
            TOOL_NAMES.DATTO_REMEDIATION_SIMULATE,
            TOOL_NAMES.DATTO_REMEDIATION_VERIFY
        ])
    })
});

function publicAgentDefinitions() {
    return Object.values(AGENT_DEFINITIONS).map((agent) => ({
        id: agent.id,
        name: agent.name,
        ownership: agent.ownership,
        tools: agent.tools.slice(),
        mode: 'mock'
    }));
}

module.exports = {
    AGENT_DEFINITIONS,
    AGENT_IDS,
    TOOL_NAMES,
    TOOL_PERMISSION_CLASSES,
    publicAgentDefinitions
};
