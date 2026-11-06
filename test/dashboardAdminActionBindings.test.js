'use strict';
jest.mock('../api/shared/dashboardAdmin/accountActionRuntime', () => ({ createDashboardAdminAccountActionRuntime: jest.fn(value => value) }));
const { createProductionDashboardAccountActions } = require('../lib/dashboardAdminAccountActionsProduction');
const { createAccountActionBindingReader, approvalKey } = require('../api/shared/dashboardAdmin/accountActionBindingStore');
const { AzureAccountActionConfirmationStore } = require('../api/shared/dashboardAdmin/azureAccountActionConfirmationStore');
const { auditResult, hydrate } = require('../api/shared/dashboardAdmin/accountActionState');
const { createResetAuditStore } = require('../api/shared/dashboardAdmin/resetAuditStore');
const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { versionedBlobs } = require('./helpers/adminVersionedBlobs');
const uid = n => '74000000-0000-4000-8000-' + String(n).padStart(12, '0');
const now = '2026-11-02T00:00:00.000Z';
const selector = { provider: 'external', subjectKey: uid(1) + ':' + uid(2), tenantId: uid(3), organisationId: uid(4) };
const query = { operatorSubjectKey: uid(5) + ':' + uid(6), purpose: 'account_support', instanceId: uid(7), selector };
function approval() { return { schemaVersion: 1, bindingId: uid(8), revision: 1, status: 'active', ...query,
    restoreEpoch: uid(9), actions: ['edit', 'list_members', 'reset'], approvedAt: now, validFrom: now,
    validUntil: '2026-11-02T01:00:00.000Z', approvalReference: 'synthetic-independent-approval',
    identityPolicy: { policyId: 'synthetic-policy', policyRevision: 1 },
    auditPolicy: { reference: 'synthetic-audit', revision: 1, agreementVersion: 'nf-dashboard-2026-09-r2',
        retention: { unit: 'calendar_months', count: 13 } } }; }
test('protected action policy is exact target/operator scoped, fresh and never publishes authority', async () => {
    const h = versionedBlobs(); h.put(approvalKey(query), approval());
    const read = createAccountActionBindingReader({ container: h.container, clock: () => now });
    expect((await read(query)).actions).toContain('list_members');
    await expect(read({ ...query, operatorSubjectKey: uid(11) + ':' + uid(12) })).rejects.toHaveProperty('statusCode', 403);
    const replaced = approval(); replaced.revision = 0; h.put(approvalKey(query), replaced);
    await expect(read(query)).rejects.toHaveProperty('statusCode', 403);
    expect(h.calls).toEqual([]);
});
test('expired approvals and target substitution fail closed', async () => {
    const h = versionedBlobs(), value = approval(); value.selector = { ...selector, organisationId: uid(88) };
    h.put(approvalKey(query), value); const read = createAccountActionBindingReader({ container: h.container, clock: () => now });
    await expect(read(query)).rejects.toHaveProperty('statusCode', 403);
    h.put(approvalKey(query), approval());
    await expect(createAccountActionBindingReader({ container: h.container, clock: () => '2026-11-02T01:00:00.000Z' })(query))
        .rejects.toHaveProperty('statusCode', 403);
});
test('ordinary production wires existing protected stores without creating containers or permissions', () => {
    const h = versionedBlobs(), selected = [];
    const dependencies = { ManagedIdentityCredential: jest.fn(function () {}), BlobServiceClient: jest.fn(function () {
        this.getContainerClient = name => { selected.push(name); return h.container; };
    }) };
    const env = { AZURE_STORAGE_ACCOUNT_NAME: 'syntheticdata', NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT: 'syntheticauth',
        NOFRIES_DASHBOARD_ADMIN_ACTION_BINDING: JSON.stringify({ schemaVersion: 1, authorityContainer: 'admin-policy', stateContainer: 'admin-customer-state' }) };
    const dashboard = Object.fromEntries(['browserAuthOptions', 'identityPolicy', 'proofStore', 'readExternalRuntimeEpoch',
        'newRequestId', 'pool', 'instanceId', 'historyBudget', 'newId'].map(key => [key, {}]));
    dashboard.requestBudgetMs = 30000; dashboard.clock = () => now;
    const configured = createProductionDashboardAccountActions(dashboard, dependencies, env).dashboardAdminAccountActions;
    expect(configured.requestBudgetMs).toBe(10000); expect(typeof configured.readApprovedActionBinding).toBe('function');
    expect(typeof configured.confirmationStore.writeState).toBe('function'); expect(selected).toEqual(['admin-policy', 'admin-customer-state']);
    expect(h.calls).toEqual([]);
    expect(createProductionDashboardAccountActions(null, dependencies, {})).toEqual({});
    expect(() => createProductionDashboardAccountActions(dashboard, dependencies, { ...env,
        NOFRIES_DASHBOARD_ADMIN_ACTION_BINDING: JSON.stringify({ schemaVersion: 1, authorityContainer: 'same-container', stateContainer: 'same-container' }) })).toThrow();
});

test('ordinary production never constructs the reset adapter, even with old reset settings', () => {
    const resetFactory = jest.spyOn(require('../lib/dashboardAdminSignupResetProduction'), 'createProductionSignupReset');
    const h = versionedBlobs(), dependencies = {
        ManagedIdentityCredential: jest.fn(function () {}),
        BlobServiceClient: jest.fn(function () { this.getContainerClient = () => h.container; })
    };
    const env = { AZURE_STORAGE_ACCOUNT_NAME: 'syntheticdata', NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT: 'syntheticauth',
        NOFRIES_DASHBOARD_ADMIN_ACTION_BINDING: JSON.stringify({ schemaVersion: 1, authorityContainer: 'admin-policy', stateContainer: 'admin-customer-state' }),
        NOFRIES_DASHBOARD_ADMIN_RESET_SOURCE_SHA: 'a'.repeat(40), NOFRIES_SIGNUP_RESET_WRITER_CONTRACT: 'external_signup_writers_v1' };
    const dashboard = Object.fromEntries(['browserAuthOptions', 'identityPolicy', 'proofStore', 'clock', 'readExternalRuntimeEpoch',
        'newRequestId', 'pool', 'instanceId', 'historyBudget', 'newId'].map(key => [key, {}]));
    dashboard.requestBudgetMs = 1000;
    try {
        const configured = createProductionDashboardAccountActions(dashboard, dependencies, env, {}).dashboardAdminAccountActions;
        expect(configured).not.toHaveProperty('signupReset');
        expect(resetFactory).not.toHaveBeenCalled();
        expect(h.calls).toEqual([]);
    } finally { resetFactory.mockRestore(); }
});
test('audit summary cannot retain labels; missing or altered private state cannot reconcile', async () => {
    const h = versionedBlobs(), store = new AzureAccountActionConfirmationStore(h.container);
    const state = { command: { action: 'edit', selector, operationId: uid(21), commandSha256: 'a'.repeat(64),
        patch: { displayLabel: 'Private synthetic label' } }, labelRevision: 1, restoreEpoch: uid(22), authoritySha256: 'b'.repeat(64) };
    const result = auditResult(state), key = await store.writeState(state);
    expect(key).toBe(result.stateSha256); expect(JSON.stringify(result)).not.toContain('Private synthetic label');
    const row = { result_sha256: hash(result), payload: { resultSha256: hash(result), result } };
    expect((await hydrate(row, store)).payload.result).toEqual(state);
    h.put('dashboard-admin/customer-action-state/' + key + '.json', { ...state, labelRevision: 2 });
    await expect(hydrate(row, store)).rejects.toHaveProperty('statusCode', 503);
});
test('reset audit rejects customer fields and writes only closed immutable evidence', async () => {
    const h = versionedBlobs(), store = createResetAuditStore(h.container);
    const value = { actorSubjectKey: query.operatorSubjectKey, targetSha256: hash(selector), operationId: uid(30), occurredAt: now, version: 'a'.repeat(64) };
    await expect(store.write('inspection', uid(30), { ...value, email: 'synthetic@example.invalid' })).rejects.toThrow();
    expect(h.current.size).toBe(0); await store.write('inspection', uid(30), value);
    expect(await store.read('inspection', uid(30))).toEqual(value);
    await expect(store.write('inspection', uid(30), { ...value, version: 'b'.repeat(64) })).rejects.toThrow();
});
