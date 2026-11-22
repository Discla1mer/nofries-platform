'use strict';
const request = require('supertest');
const { customerProductionHarness, uid } = require('./helpers/customerProductionHarness');
const { resetAbuseProtectionForTests } = require('../api/shared/abuseProtection');
const ROUTE = '/api/external-customer-signup';
beforeEach(() => resetAbuseProtectionForTests());
test.each([undefined, 'false', 'TRUE', 'true'])('production enrollment is default-off and only exact true opts in (%s)', async flag => {
    const h = customerProductionHarness({ starter: true, external: true, customerClientId: uid(105), now: Date.now(),
        configureExternal({ env, dependencies, state }) {
            if (flag !== undefined) env.NOFRIES_DEFER_STARTER_DETAILS = flag;
            dependencies.clock = () => new Date(state.now).toISOString();
        } });
    const login = await h.loginExternal(); expect(login.response.status).toBe(303);
    const { createProductionDashboardConfiguration } = require('../lib/dashboardProduction');
    const dashboard = createProductionDashboardConfiguration(h.env, h.dependencies);
    expect(dashboard.questionnaireExportGateEnabled).toBe(flag === 'true' ? true : undefined);
    // Flag off: the dashboard stays identical to main (no details route, gate or 0028 read).
    expect(dashboard.representativeDetailsEnabled).toBe(flag === 'true' ? true : undefined);
    const state = await request(h.app).get(ROUTE + '/state').set('Cookie', login.cookie);
    expect(state.status).toBe(200);
    expect(state.body.state).toEqual({ status: 'setup_details', email: h.state.externalEmail,
        ...(flag === 'true' ? { deferredDetails: true } : {}) });
    if (flag !== 'true') return;
    const input = { accountType: 'company', organisationName: 'Synthetic Workshop', details: { authorityConfirmed: true } };
    const send = body => h.sameOrigin(request(h.app).post(ROUTE + '/setup')).set('Cookie', login.cookie)
        .set('X-CSRF-Token', state.body.csrfToken).send(body);
    expect((await send({ ...input, details: { authorityConfirmed: false } })).status).toBe(400);
    const result = await send(input); expect(result.status).toBe(200); expect(result.body.state.status).toBe('continue_authentication');
    const store = h.getContainer('external-starter-authority');
    const saved = [...store.records].filter(([key]) => key.startsWith('customer-starter/starter-setups/'));
    expect(saved).toHaveLength(1);
    const declaration = JSON.parse(saved[0][1]);
    expect(Object.keys(declaration.offerInput.contact).sort()).toEqual(['authorityEvidenceId', 'email']);
    expect(declaration.offerInput.detailsPolicy).toBe('after-first-result-v1');
    expect(declaration.assertion.proof.subjectKey).toBeTruthy();
    expect([...store.records.keys()].filter(key => key.startsWith('customer-schedules/'))).toHaveLength(1);
    const { AzureStarterSetupStore } = require('../api/shared/customerSignup/azureStarterSetupStore');
    const memberLookup = new AzureStarterSetupStore(store);
    const { tenantId, organisationId } = declaration.offerInput;
    expect(await memberLookup.ownDeferredCompany({ tenantId, organisationId })).toBe(true);
    expect(await memberLookup.ownDeferredCompany({ tenantId: uid(707), organisationId })).toBe(false);
    expect(await memberLookup.ownDeferredCompany({ tenantId, organisationId: uid(708) })).toBe(false);
    expect(await memberLookup.ownDeferredCompany({ tenantId, organisationId: 'historical-org' })).toBe(false);
    const before = Buffer.from(saved[0][1]);
    // An already-completed claim cannot be edited, and its immutable bytes remain.
    await send({ resume: true }); expect(store.records.get(saved[0][0])).toEqual(before);
    expect(h.pool.receipts.size).toBe(0); // setup alone records no acceptance
});
