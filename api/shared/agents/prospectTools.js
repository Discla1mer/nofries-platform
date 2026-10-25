const { CONTEXT_FIELDS } = require('../lifecycle/lifecycleModel');
const { ACTION_PERMISSION } = require('./actionPolicy');

const PROSPECT_TOOL_SCHEMA_VERSION = 'prospect-tools-v1';

const PROSPECT_TOOL_NAMES = Object.freeze({
    UPDATE_CONTEXT: 'update_prospect_context',
    RECORD_SUMMARY: 'record_conversation_summary',
    SUGGEST_NEXT_ACTION: 'suggest_next_action',
    ADVANCE_LIFECYCLE: 'advance_lifecycle'
});

const PROSPECT_TOOL_PERMISSIONS = Object.freeze({
    [PROSPECT_TOOL_NAMES.UPDATE_CONTEXT]: ACTION_PERMISSION.AUTONOMOUS_RECORD,
    [PROSPECT_TOOL_NAMES.RECORD_SUMMARY]: ACTION_PERMISSION.AUTONOMOUS_RECORD,
    [PROSPECT_TOOL_NAMES.SUGGEST_NEXT_ACTION]: ACTION_PERMISSION.AUTONOMOUS_RECORD,
    [PROSPECT_TOOL_NAMES.ADVANCE_LIFECYCLE]: ACTION_PERMISSION.AUTONOMOUS_RECORD
});

function prospectToolDefinitions() {
    return [
        {
            type: 'function',
            name: PROSPECT_TOOL_NAMES.UPDATE_CONTEXT,
            description: 'Save every supported customer fact explicitly stated or strongly implied in the latest visitor message. Never invent a value for an unknown field, omit an explicit supported fact, or paraphrase canonical enum values.',
            strict: true,
            parameters: {
                type: 'object',
                properties: {
                    facts: {
                        type: 'array',
                        maxItems: 20,
                        items: {
                            type: 'object',
                            properties: {
                                field: {
                                    type: 'string',
                                    enum: CONTEXT_FIELDS.map((definition) => definition.path)
                                },
                                value: { type: 'string', maxLength: 2000 },
                                certainty: { type: 'string', enum: ['explicit', 'inferred'] }
                            },
                            required: ['field', 'value', 'certainty'],
                            additionalProperties: false
                        }
                    }
                },
                required: ['facts'],
                additionalProperties: false
            }
        },
        {
            type: 'function',
            name: PROSPECT_TOOL_NAMES.RECORD_SUMMARY,
            description: 'Keep a concise rolling summary of the prospect conversation so later scoping and service agents can use it without rereading the whole transcript.',
            strict: true,
            parameters: {
                type: 'object',
                properties: {
                    summary: { type: 'string', maxLength: 3000 },
                    currentNeed: { type: 'string', maxLength: 800 },
                    concerns: {
                        type: 'array',
                        maxItems: 12,
                        items: { type: 'string', maxLength: 300 }
                    }
                },
                required: ['summary', 'currentNeed', 'concerns'],
                additionalProperties: false
            }
        },
        {
            type: 'function',
            name: PROSPECT_TOOL_NAMES.SUGGEST_NEXT_ACTION,
            description: 'Record the most useful next action. This suggests an action only; it does not send email, book a meeting, or change an external system.',
            strict: true,
            parameters: {
                type: 'object',
                properties: {
                    type: {
                        type: 'string',
                        enum: ['continue_chat', 'human_follow_up', 'send_scope', 'start_scoping', 'book_meeting', 'none']
                    },
                    timing: { type: 'string', maxLength: 180 },
                    detail: { type: 'string', maxLength: 800 }
                },
                required: ['type', 'timing', 'detail'],
                additionalProperties: false
            }
        },
        {
            type: 'function',
            name: PROSPECT_TOOL_NAMES.ADVANCE_LIFECYCLE,
            description: 'Advance a website prospect to discovery only after the visitor has identified an organisation and provided a useful reason for the enquiry. This cannot advance beyond discovery.',
            strict: true,
            parameters: {
                type: 'object',
                properties: {
                    targetState: { type: 'string', enum: ['discovery'] },
                    reason: { type: 'string', maxLength: 500 }
                },
                required: ['targetState', 'reason'],
                additionalProperties: false
            }
        }
    ];
}

function createProspectToolGateway(options = {}) {
    const lifecycleService = options.lifecycleService;
    const access = options.access;
    const sessionHash = options.sessionHash;
    if (!lifecycleService || !access || !sessionHash) {
        throw new Error('Prospect Tool Gateway requires lifecycle service, access, and session');
    }

    return {
        async invoke(name, args, metadata = {}) {
            if (!Object.prototype.hasOwnProperty.call(PROSPECT_TOOL_PERMISSIONS, name)) {
                const error = new Error('The prospect agent is not permitted to use that tool');
                error.statusCode = 403;
                error.details = { code: 'tool_not_permitted', tool: name };
                throw error;
            }
            return lifecycleService.executeProspectTool(access, sessionHash, name, args, Object.assign({}, metadata, {
                details: Object.assign({}, metadata.details || {}, {
                    permission: PROSPECT_TOOL_PERMISSIONS[name]
                })
            }));
        }
    };
}

module.exports = {
    PROSPECT_TOOL_SCHEMA_VERSION,
    PROSPECT_TOOL_NAMES,
    PROSPECT_TOOL_PERMISSIONS,
    createProspectToolGateway,
    prospectToolDefinitions
};
