const { apiSecurityHeaders } = require('./securityHeaders');
const { handleFunnelCountRequest } = require('./funnelCounts');

async function runFunction(context, req, handler) {
    try {
        context.res = await handler(context, req);
    } catch (error) {
        if (context && context.log && typeof context.log.error === 'function') {
            context.log.error(error);
        }
        context.res = json(500, {
            error: 'No Fries could not complete that request'
        });
    }
}

async function legacyWorkspaceRetired() {
    return json(410, {
        error: 'This legacy workspace route has been retired',
        code: 'legacy_workspace_retired'
    });
}

async function billingDisabled() {
    return json(410, {
        error: 'Public subscription billing is disabled for the tenant pilot',
        code: 'billing_disabled'
    });
}

async function telemetryRetired() {
    return json(410, {
        error: 'Public acquisition telemetry is disabled',
        code: 'telemetry_disabled'
    });
}

// The Functions host has no database pool: with the flag on it validates and
// answers 503; the App Service route in server.js does the write.
async function telemetryFunnelCounts(context, req) {
    return handleFunnelCountRequest(req, { env: process.env, log: context && context.log });
}

async function parseMultipart() {
    return {
        fields: {},
        file: null
    };
}

function json(status, body) {
    return {
        status,
        headers: apiSecurityHeaders({
            'Content-Type': 'application/json; charset=utf-8',
        }),
        body
    };
}

module.exports = {
    handlers: {
        account: legacyWorkspaceRetired,
        workspace: legacyWorkspaceRetired,
        createOrganisation: legacyWorkspaceRetired,
        assessment: legacyWorkspaceRetired,
        organisationEvidence: legacyWorkspaceRetired,
        evidence: legacyWorkspaceRetired,
        createShareLink: legacyWorkspaceRetired,
        revokeShareLink: legacyWorkspaceRetired,
        share: legacyWorkspaceRetired,
        productAsset: legacyWorkspaceRetired,
        billingCheckout: billingDisabled,
        billingConfirm: billingDisabled,
        billingWebhook: billingDisabled,
        telemetry: telemetryFunnelCounts,
        founderSummary: telemetryRetired
    },
    parseMultipart,
    runFunction
};