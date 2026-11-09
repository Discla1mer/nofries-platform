'use strict';
jest.mock('../api/shared/dashboardOperatorSession', () => ({ createDashboardOperatorSession: () => ({ captureRequest: jest.fn() }) }));
jest.mock('../api/shared/appLifecycle/postgresDashboardRuntimeRepository', () => ({ createPostgresDashboardAdministrationRepository: () => ({}) }));
jest.mock('../api/shared/dashboardAdmin/accountActionsExpiry', () => ({ createExpiryAction: jest.fn(() => ({ execute: jest.fn(() => 'expiry') })) }));
jest.mock('../api/shared/dashboardAdmin/accountActionsApproval', () => ({ createExpiryApproval: jest.fn(() => ({ approve: jest.fn(), readApprovedExtension: jest.fn() })) }));
jest.mock('../api/shared/dashboardAdmin/accountActionsMembership', () => ({ createMembershipAction: jest.fn(() => ({ execute: jest.fn(() => 'membership') })) }));
const { createAccountActionsRuntime } = require('../api/shared/dashboardAdmin/accountActionsRuntime');
const { createExpiryAction } = require('../api/shared/dashboardAdmin/accountActionsExpiry');
const { createExpiryApproval } = require('../api/shared/dashboardAdmin/accountActionsApproval');
const configuration = { source: {}, authorityContainer: {}, auditContainer: {}, auditPolicy: {} };
test('membership configuration retains the built-in extension issuer and requires an explicit executor action', () => {
    const runtime = createAccountActionsRuntime(configuration, { pool: {} }, jest.fn());
    expect(runtime.membershipAvailable).toBe(true);
    const issuer = createExpiryApproval.mock.results.at(-1).value;
    expect(runtime.approve).toBe(issuer.approve);
    expect(createExpiryAction.mock.calls.at(-1)[0].readApprovedExtension).toBe(issuer.readApprovedExtension);
    for (const route of ['suspend', 'restore', 'approve-suspend', 'approve-restore']) expect(runtime.execute({}, {}, {}, route)).toBe('membership');
    expect(runtime.execute({}, {}, {}, 'extend-expired-access')).toBe('expiry');
    for (const route of [undefined, 'approve-extension', 'delete']) expect(() => runtime.execute({}, {}, {}, route)).toThrow('dashboard_admin_unavailable');
    expect(createExpiryAction.mock.results.at(-1).value.execute).toHaveBeenCalledTimes(1);
});
test('an extension-only runtime does not advertise membership controls', () => {
    const { auditPolicy, ...extension } = configuration;
    expect(createAccountActionsRuntime(extension, { pool: {} }, jest.fn()).membershipAvailable).toBe(false);
});
test('explicit extension readers remain supported and malformed optional readers fail closed', () => {
    const readApprovedExtension = jest.fn(), runtime = createAccountActionsRuntime({ ...configuration, readApprovedExtension }, { pool: {} }, jest.fn());
    expect(runtime.approve).toBeUndefined(); expect(createExpiryAction.mock.calls.at(-1)[0].readApprovedExtension).toBe(readApprovedExtension);
    for (const key of ['readApprovedExtension', 'readApprovedAction']) expect(() =>
        createAccountActionsRuntime({ ...configuration, [key]: null }, { pool: {} }, jest.fn())).toThrow('dashboard_admin_configuration_invalid');
});
