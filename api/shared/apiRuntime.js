const { apiSecurityHeaders } = require('./securityHeaders');

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
        telemetry: telemetryRetired,
        founderSummary: telemetryRetired
    },
    parseMultipart,
    runFunction
};