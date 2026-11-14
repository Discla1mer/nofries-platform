'use strict';

// Environment-only staff console composition. Authority is the
// allowlisted staff admin's own workforce login plus the native operator
// session gate and restore epoch; no per-customer approval record, locator
// JSON or publication step is involved. Invalid settings log one safe line and
// leave the console off; they never stop the host. These settings grant nothing
// by themselves: the host still checks subject allowlist, admin role and gate.
const { isProxy } = require('node:util').types;
const { createHmac } = require('node:crypto');
const { hash, uuid } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { normaliseCustomerAuthoritySource } = require('../api/shared/dashboardAdmin/customerAuthorityRecords');

const STAFF_CONSOLE_SETTING = 'NOFRIES_STAFF_CONSOLE';
const LOOKUP_SETTING = 'NOFRIES_DASHBOARD_ADMIN_ACCOUNT_LOOKUP';
const ACTIONS_SETTING = 'NOFRIES_DASHBOARD_ADMIN_ACCOUNT_ACTIONS';
const AUDIT_POLICY = Object.freeze({ reference: 'dashboard-admin-account-actions', revision: 1,
    agreementVersion: 'nf-dashboard-2026-09-r2', retention: Object.freeze({ unit: 'calendar_months', count: 13 }) });
const AUDIT_SETTING = 'NOFRIES_DASHBOARD_ADMIN_AUDIT_CONTAINER';
const DIGEST_LABEL = 'nofries:dashboard-admin-account-lookup:v1';
const SOURCES = Object.freeze([
    ['legacy_admin', 'NOFRIES_CUSTOMER_AUTHORITY_CONTAINER', 'NOFRIES_ENTRA_TENANT_ID'],
    ['legacy_starter', 'NOFRIES_STARTER_AUTHORITY_CONTAINER', 'NOFRIES_ENTRA_TENANT_ID'],
    ['external_starter', 'NOFRIES_EXTERNAL_CUSTOMER_AUTHORITY_CONTAINER', 'NOFRIES_EXTERNAL_CUSTOMER_TENANT_ID']
]);
const COMMON = Object.freeze(['browserAuthOptions', 'identityPolicy', 'proofStore', 'clock', 'readExternalRuntimeEpoch',
    'newRequestId', 'pool', 'instanceId', 'historyBudget', 'newId']);
const fail = () => { throw new Error('dashboard_admin_staff_configuration_invalid'); };
const CONTAINER = /^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const ACCOUNT = /^[a-z0-9]{3,24}$/;

function own(value, key) {
    if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return undefined;
    if (!Object.hasOwn(descriptor, 'value')) fail();
    return descriptor.value;
}
const container = value => { if (typeof value !== 'string' || !CONTAINER.test(value)) fail(); return value; };
const flag = (env, key) => {
    const value = own(env, key);
    if ([undefined, '', 'false'].includes(value)) return false;
    if (value !== 'true') fail();
    return true;
};

// Returns null while the console is off; throws for anything that is set but
// unusable. Only non-secret identifiers are read; nothing here opens storage.
function readStaffAdminSettings(env) {
    // Both switches are required: the console flag selects this composition and
    // the existing lookup flag keeps its meaning, so setting it false turns off
    // the email lookup and the selector lookup together.
    if (!flag(env, STAFF_CONSOLE_SETTING) || !flag(env, LOOKUP_SETTING)) return null;
    const account = own(env, 'AZURE_STORAGE_ACCOUNT_NAME'), authAccount = own(env, 'NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT');
    if (![account, authAccount].every(value => typeof value === 'string' && ACCOUNT.test(value)) || account === authAccount) fail();
    // Session, proof, epoch, audit and any legacy approval container are never
    // customer sources; the audit container is also distinct from every source.
    const auditContainer = container(own(env, AUDIT_SETTING));
    // A legacy listing locator names an approval container that must never be
    // a customer source. An unusable locator names none: listing reports that
    // itself (one line), and it does not switch this console off.
    let approvalContainer = null;
    try { approvalContainer = require('./dashboardAdminBindings').readDashboardAdminBinding(env)?.authorityContainer ?? null; } catch (_) { /* reported by listing */ }
    const reserved = [own(env, 'NOFRIES_BROWSER_AUTH_CONTAINER') || 'nofries-browser-auth', own(env, 'NOFRIES_DASHBOARD_PROOF_CONTAINER'),
        own(env, 'NOFRIES_DASHBOARD_EPOCH_CONTAINER'), ...(approvalContainer ? [approvalContainer] : [])].map(container);
    if (reserved.includes(auditContainer)) fail();
    reserved.push(auditContainer);
    const sources = SOURCES.filter(([, setting]) => ![undefined, ''].includes(own(env, setting))).map(([kind, setting, tenantSetting]) => {
        const tenant = own(env, tenantSetting); uuid(tenant);
        return normaliseCustomerAuthoritySource({ schemaVersion: 1, kind, storageAccount: account, container: container(own(env, setting)),
            providerKind: kind === 'external_starter' ? 'external-id' : 'workforce-b2b', providerTenantId: tenant,
            providerConfigurationSha256: hash({ kind, tenant }) });
    });
    const names = sources.map(source => source.container);
    if (!names.length || new Set(names).size !== names.length || names.some(name => reserved.includes(name))) fail();
    const identityClientId = own(env, 'NOFRIES_MANAGED_IDENTITY_CLIENT_ID');
    if (identityClientId !== undefined && identityClientId !== '') uuid(identityClientId);
    // The audit target digest is keyed with a value derived from an existing
    // server secret, so it cannot be reversed by guessing addresses. The
    // derived key never leaves this closure and is never logged or stored.
    const secret = own(env, 'NOFRIES_SCOPE_SIGNING_SECRET');
    if (typeof secret !== 'string' || secret.length < 32) fail();
    const key = createHmac('sha256', secret).update(DIGEST_LABEL).digest();
    const targetDigest = email => createHmac('sha256', key).update(String(email)).digest('hex');
    return Object.freeze({ account, sources: Object.freeze(sources), auditContainer, targetDigest, identityClientId: identityClientId || null, reserved: Object.freeze(reserved) });
}

// Account actions (suspend/restore) need every authority source. Returns
// false while actions are off; throws for a flag that is set but unusable.
function readStaffActionSettings(env, settings) {
    if (!flag(env, ACTIONS_SETTING)) return false;
    if (settings.sources.length !== SOURCES.length) fail();
    return true;
}

function blobService(settings, dependencies, retryOptions) {
    const dependency = (key, fallback) => {
        const value = Object.hasOwn(dependencies, key) ? own(dependencies, key) : fallback();
        if (typeof value !== 'function' || isProxy(value)) fail();
        return value;
    };
    const ManagedIdentityCredential = dependency('ManagedIdentityCredential', () => require('@azure/identity').ManagedIdentityCredential);
    const BlobServiceClient = dependency('BlobServiceClient', () => require('@azure/storage-blob').BlobServiceClient);
    const credential = settings.identityClientId ? new ManagedIdentityCredential({ clientId: settings.identityClientId }) : new ManagedIdentityCredential();
    return new BlobServiceClient(`https://${settings.account}.blob.core.windows.net`, credential, { retryOptions });
}

// Every authorised email lookup leaves one create-only durable record in the
// admin audit container: actor digest, HMAC target digest, status, count and cap. No
// email, subject key or row data is written. A failed write fails the lookup.
function createLookupAuditWriter(auditContainer) {
    const { writeActionRecord } = require('../api/shared/dashboardAdmin/accountActionsStorage');
    return async function audit(event) {
        if (!['dashboard_admin_account_lookup', 'dashboard_admin_account_list'].includes(event.category)) fail();
        const record = { schemaVersion: 1, category: event.category, requestId: event.requestId, actorSha256: event.actorSha256,
            targetSha256: event.targetSha256, status: event.status, count: event.count, truncated: event.truncated, occurredAt: event.occurredAt };
        if (typeof record.requestId !== 'string' || !/^[0-9a-f-]{36}$/.test(record.requestId)) fail();
        await writeActionRecord(auditContainer, `dashboard-admin-account-lookups/${record.requestId}.json`, record, { ifNoneMatch: '*' }, AbortSignal.timeout(5000));
    };
}

function compose(env, dashboard, dependencies) {
    const settings = readStaffAdminSettings(env);
    if (!settings) return {};
    if (!dashboard || typeof dashboard !== 'object' || isProxy(dashboard) || !dependencies || typeof dependencies !== 'object' || isProxy(dependencies)) fail();
    const common = Object.fromEntries(COMMON.map(key => [key, own(dashboard, key)]));
    const budget = own(dashboard, 'requestBudgetMs');
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > 60000) fail();
    common.requestBudgetMs = Math.min(budget, 10000);
    const { createDashboardAdminRuntime } = require('../api/shared/dashboardAdmin/runtimeAdapter');
    const { createAccountLookupReader } = require('../api/shared/dashboardAdmin/accountLookupStore');
    const { createAccountListReader } = require('../api/shared/dashboardAdmin/accountListStore');
    // Reads and the create-only audit record use one attempt each; a lost
    // acknowledgement is never retried into a second conditional write.
    const service = blobService(settings, dependencies, { maxTries: 1, tryTimeoutInMs: 4000 });
    const sources = settings.sources.map(source => ({ source, container: service.getContainerClient(source.container) }));
    const auditContainer = service.getContainerClient(settings.auditContainer);
    const ports = { dashboardAdmin: createDashboardAdminRuntime(common),
        dashboardAdminAccountLookup: Object.freeze({ read: createAccountLookupReader(sources, () => Date.parse(common.clock())),
            list: createAccountListReader(sources, () => Date.parse(common.clock())),
            audit: createLookupAuditWriter(auditContainer), targetDigest: settings.targetDigest }) };
    try {
        if (!readStaffActionSettings(env, settings)) return ports;
        // Writes are optional: unusable action settings leave the read-only
        // console running. The staff runtime above authorises them: the same
        // native gate, plus a typed-email, session-bound 15-minute approval per
        // operation and create-only attempt/terminal audit records. Only
        // suspend and restore exist; nothing here writes a customer authority record.
        // Frozen: nothing in-process can add a source, reader or action later.
        const configuration = Object.freeze({ sources: Object.freeze(sources.map(entry => Object.freeze({ source: entry.source, authorityContainer: entry.container }))),
            auditContainer, auditPolicy: AUDIT_POLICY });
        require('../api/shared/dashboardAdmin/accountActionsRuntime').createAccountActionsRuntime(configuration, dashboard, async () => fail());
        ports.dashboardAdminAccountActions = configuration;
    } catch (_) {
        try { console.warn('[dashboard-admin-account-actions] dashboard_admin_unavailable'); } catch (_) { /* no logging authority */ }
    }
    return ports;
}

function createStaffDashboardAdministration(env, dashboard, dependencies = {}) {
    try { return Object.freeze(compose(env, dashboard, dependencies)); }
    catch (_) {
        try { console.warn('[dashboard-admin] dashboard_admin_configuration_invalid'); } catch (_) { /* no logging authority */ }
        return Object.freeze({});
    }
}

module.exports = { STAFF_CONSOLE_SETTING, LOOKUP_SETTING, ACTIONS_SETTING, readStaffActionSettings, AUDIT_SETTING, readStaffAdminSettings, createStaffDashboardAdministration };
