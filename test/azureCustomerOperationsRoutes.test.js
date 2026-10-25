const fs = require('fs');
const os = require('os');
const path = require('path');

const ENV_KEYS = [
    'NOFRIES_ADMIN_EMAILS',
    'NOFRIES_ALLOWED_EMAILS',
    'NOFRIES_BROWSER_AUTH_MODE',
    'NOFRIES_DATA_DIR',
    'NOFRIES_DATTO_RMM_TENANT_ID',
    'NOFRIES_DEFAULT_TENANT_ID',
    'NOFRIES_DEV_EMAIL',
    'NOFRIES_REQUIRE_AUTH'
];
const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

process.env.NOFRIES_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-azure-routes-'));
process.env.NOFRIES_REQUIRE_AUTH = 'false';
process.env.NOFRIES_BROWSER_AUTH_MODE = 'swa';
process.env.NOFRIES_DEV_EMAIL = 'admin@example.com';
process.env.NOFRIES_ALLOWED_EMAILS = 'admin@example.com';
process.env.NOFRIES_ADMIN_EMAILS = 'admin@example.com';
process.env.NOFRIES_DEFAULT_TENANT_ID = 'tenant-a';
process.env.NOFRIES_DATTO_RMM_TENANT_ID = 'tenant-a';

const lifecycleControls = require('../api/lifecycleControls');
const lifecycleOrganisations = require('../api/lifecycleOrganisations');
const dattoRmmOnboarding = require('../api/dattoRmmOnboarding');
const salesOperations = require('../api/salesOperations');
const salesProposals = require('../api/salesProposals');

function triggerRoute(functionName) {
    const definition = require(`../api/${functionName}/function.json`);
    return definition.bindings.find((binding) => binding.type === 'httpTrigger').route;
}

function functionContext() {
    return {
        bindingData: {},
        log: {
            error: jest.fn(),
            info: jest.fn(),
            warn: jest.fn()
        }
    };
}

afterAll(() => {
    ENV_KEYS.forEach((key) => {
        if (previousEnv[key] == null) delete process.env[key];
        else process.env[key] = previousEnv[key];
    });
});

describe('Azure customer-operations route bindings', () => {
    test('binds every lifecycle path depth without a catch-all route', () => {
        expect(triggerRoute('lifecycleOrganisations')).toBe(
            'lifecycle/organisations/{organisationId?}/{action?}/{targetId?}/{operation?}'
        );
        expect(triggerRoute('lifecycleControls')).toBe('lifecycle/controls/run');
        expect(triggerRoute('lifecycleOrganisations')).not.toContain('*');
    });

    test('binds durable sales operation inspection at collection and item depth', () => {
        expect(triggerRoute('salesOperations')).toBe('sales/operations/{operationId?}');
        const definition = require('../api/salesOperations/function.json');
        const trigger = definition.bindings.find((binding) => binding.type === 'httpTrigger');
        expect(trigger.methods).toEqual(['get']);
    });

    test('binds controlled Datto onboarding as an explicit POST-only route', async () => {
        expect(triggerRoute('dattoRmmOnboarding')).toBe('datto-rmm/onboarding/{action}');
        const definition = require('../api/dattoRmmOnboarding/function.json');
        const trigger = definition.bindings.find((binding) => binding.type === 'httpTrigger');
        expect(trigger.methods).toEqual(['post']);

        const context = functionContext();
        await dattoRmmOnboarding(context, {
            method: 'POST',
            url: '/api/datto-rmm/onboarding/prepare',
            headers: {},
            body: { organisationId: 'organisation-hq' }
        });
        expect(context.res.status).toBe(400);
        expect(context.res.body.code).toBe('datto_rmm_provision_confirmation_required');
        expect(context.res.body.code).not.toBe('route_not_found');
    });

    test('binds proposal AI review as an Azure POST action', async () => {
        expect(triggerRoute('salesProposals')).toBe('sales/proposals/{proposalId?}/{action?}');
        const definition = require('../api/salesProposals/function.json');
        const trigger = definition.bindings.find((binding) => binding.type === 'httpTrigger');
        expect(trigger.methods).toContain('post');

        const context = functionContext();
        await salesProposals(context, {
            method: 'POST',
            url: '/api/sales/proposals/missing-proposal/review',
            headers: {},
            body: {}
        });
        expect(context.res.status).toBe(404);
        expect(context.res.body.error).toBe('Proposal not found');
        expect(context.res.body.code).not.toBe('method_not_allowed');
    });

    test.each([
        ['/api/lifecycle/organisations/missing/proposal-ready', 400, 'approved_proposal_binding_evidence_required'],
        ['/api/lifecycle/organisations/missing/onboarding/start', 400, 'onboarding_device_plan_required'],
        ['/api/lifecycle/organisations/missing/onboarding/evidence', 400, 'onboarding_evidence_gate_invalid'],
        ['/api/lifecycle/organisations/missing/customer-master/change', 400, 'customer_master_change_required'],
        ['/api/lifecycle/organisations/missing/support-profile/change', 400, 'support_profile_change_required'],
        ['/api/lifecycle/organisations/missing/activation-requests/request-1/review', 400, 'activation_review_decision_invalid'],
        ['/api/lifecycle/organisations/missing/activation-requests/request-1/execute', 400, 'activation_execution_confirmation_required'],
        ['/api/lifecycle/organisations/missing/proof/approve', 404, 'organisation_not_found']
    ])('dispatches nested lifecycle URL through the shared secured runtime: %s', async (url, status, code) => {
        const context = functionContext();
        await lifecycleOrganisations(context, {
            method: 'POST',
            url,
            headers: {},
            body: {}
        });

        expect(context.res.status).toBe(status);
        expect(context.res.body.code).toBe(code);
        expect(context.res.body.code).not.toBe('route_not_found');
    });

    test('dispatches the controls wrapper through lifecycle authorization and execution', async () => {
        const context = functionContext();
        await lifecycleControls(context, {
            method: 'POST',
            url: '/api/lifecycle/controls/run',
            headers: {},
            body: { confirmInternalOnly: true }
        });

        expect(context.res.status).toBe(200);
        expect(context.res.body).toMatchObject({ generated: [] });
    });

    test('dispatches sales operation collection and item URLs through the sales runtime', async () => {
        const collection = functionContext();
        await salesOperations(collection, {
            method: 'GET',
            url: '/api/sales/operations',
            headers: {}
        });
        expect(collection.res.status).toBe(200);
        expect(collection.res.body.operations).toEqual([]);

        const item = functionContext();
        await salesOperations(item, {
            method: 'GET',
            url: '/api/sales/operations/missing-operation',
            headers: {}
        });
        expect(item.res.status).toBe(404);
        expect(item.res.body.code).toBe('operation_not_found');
    });

    test('new wrappers retain the shared fail-closed tenant boundary', async () => {
        const previousRequired = process.env.NOFRIES_REQUIRE_AUTH;
        const previousPublicUrl = process.env.NOFRIES_PUBLIC_URL;
        process.env.NOFRIES_REQUIRE_AUTH = 'true';
        process.env.NOFRIES_PUBLIC_URL = 'https://nofries.nz';
        try {
            const controls = functionContext();
            await lifecycleControls(controls, {
                method: 'POST',
                url: '/api/lifecycle/controls/run',
                headers: {
                    origin: 'https://nofries.nz',
                    'sec-fetch-site': 'same-origin'
                },
                body: { confirmInternalOnly: true }
            });
            expect(controls.res.status).toBe(403);
            expect(controls.res.body.code).toBe('tenant_access_required');

            const operations = functionContext();
            await salesOperations(operations, {
                method: 'GET',
                url: '/api/sales/operations',
                headers: {}
            });
            expect(operations.res.status).toBe(403);
            expect(operations.res.body.code).toBe('tenant_access_required');
        } finally {
            if (previousRequired == null) delete process.env.NOFRIES_REQUIRE_AUTH;
            else process.env.NOFRIES_REQUIRE_AUTH = previousRequired;
            if (previousPublicUrl == null) delete process.env.NOFRIES_PUBLIC_URL;
            else process.env.NOFRIES_PUBLIC_URL = previousPublicUrl;
        }
    });
});
