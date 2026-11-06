'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fields, copy, hash, instant, uuid, id } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { CONTRACT } = require('../api/shared/customerSignup/signupWriterFence');
const { DashboardAdminError } = require('../api/shared/dashboardAdmin/service');
const fail = () => { throw new DashboardAdminError(503, 'dashboard_admin_unavailable'); };
function writerImplementationSha256() {
    return hash(['lib/customerSignupProduction.js', 'lib/starterSignupProduction.js', 'lib/signupWriterFenceProduction.js',
        'api/shared/customerSignup/signupWriterFence.js', 'api/shared/customerSignup/azureStarterAccountStore.js',
        'api/shared/customerSignup/externalStarterClaim.js', 'api/shared/customerSignup/provisionCustomerInvitation.js']
        .map(file => ({ file, content: fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8') })));
}
function createProductionSignupReset(env, dashboard, dependencies, externalConfiguration, stateStore) {
    const descriptor = Object.getOwnPropertyDescriptor(env, 'NOFRIES_DASHBOARD_ADMIN_RESET_SOURCE_SHA');
    if (!descriptor || Object.hasOwn(descriptor, 'value') && [undefined, ''].includes(descriptor.value)) return null;
    if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string' || !/^[a-f0-9]{40}$/.test(descriptor.value) ||
        env.NOFRIES_SIGNUP_RESET_WRITER_CONTRACT !== CONTRACT || !externalConfiguration) fail();
    const sourceSha = descriptor.value;
    const opened = require('./dashboardAdminBindings').openBindings(env, dashboard, dependencies, externalConfiguration);
    if (!opened || opened.binding.provider !== 'external') fail();
    const { source, common, index, authorityContainer, sourceBindingSha256 } = opened;
    const selectedEnv = { ...env, NOFRIES_STARTER_AUTHORITY_CONTAINER: externalConfiguration.starterAuthorityContainer };
    const writerFence = require('./signupWriterFenceProduction').signupWriterFence(selectedEnv, source, true);
    const { createCustomerIdentityProviderProfile, customerProviderKey } = require('../api/shared/customerSignup/customerIdentityProviderProfile');
    const profile = createCustomerIdentityProviderProfile(externalConfiguration.identityProvider,
        { tenantId: env.NOFRIES_ENTRA_TENANT_ID, clientId: env.NOFRIES_ENTRA_CLIENT_ID });
    const providerKey = customerProviderKey(profile), implementationSha256 = writerImplementationSha256();
    const { createPostgresDatabase } = require('../api/shared/database/postgres');
    const database = createPostgresDatabase({ pool: { end: () => common.pool.end(), async connect() {
        const client = await common.pool.connect();
        return { release: discard => client.release(discard), async query(sql, params) {
            const result = await client.query(sql, params);
            if (sql === 'BEGIN') await client.query('SET LOCAL ROLE nofries_runtime');
            return result;
        } };
    } } });
    const { createPostgresSignupRegistrationStore } = require('../api/shared/customerSignup/postgresSignupRegistrationStore');
    const registrations = createPostgresSignupRegistrationStore({ database });
    let lastAt = null;
    async function readAdoption() {
        // This record must be published by the existing private release
        // controller AFTER old writers are drained and version recovery checked.
        // The public application never manufactures or updates this evidence.
        const { readVersioned } = require('../api/shared/dashboardAdmin/emptySignupResetAdapter');
        const stored = await readVersioned(authorityContainer, 'dashboard-admin/reset-writer-adoption.json', 4096);
        if (!stored) fail();
        const a = fields(copy(stored.record, 4096), ['schemaVersion', 'writerContract', 'implementationSha256', 'sourceSha',
            'instanceId', 'restoreEpoch', 'sourceBindingSha256', 'oldWritersStopped', 'versioningVerified',
            'approvedAt', 'validUntil', 'approvalReference']);
        instant(a.approvedAt); instant(a.validUntil); uuid(a.instanceId); uuid(a.restoreEpoch); id(a.approvalReference);
        const at = instant(common.clock()), epoch = await common.readExternalRuntimeEpoch();
        if (lastAt !== null && at < lastAt || a.schemaVersion !== 1 || a.writerContract !== CONTRACT ||
            a.implementationSha256 !== implementationSha256 || a.sourceSha !== sourceSha || a.instanceId !== common.instanceId ||
            epoch.instanceId !== a.instanceId || epoch.restoreEpoch !== a.restoreEpoch || a.sourceBindingSha256 !== sourceBindingSha256 ||
            a.oldWritersStopped !== true || a.versioningVerified !== true || a.approvedAt > at || a.validUntil <= at ||
            Date.parse(a.validUntil) - Date.parse(a.approvedAt) > 3600000) fail();
        lastAt = at;
    }
    async function inspectDependencies(account) {
        const s = account.identitySubjectKey, slot = account.organisations[0];
        // Registration reads set the IdP tenant and subject RLS keys themselves.
        if (await registrations.readStorageMode({ subjectKey: s }) !== null) return { empty: false };
        return database.withTenantTransaction(slot.tenantId, async tx => {
            await tx.query("SELECT set_config('nofries.subject_key',$1,true)", [s]);
            // Tenant rows have tenant-only RLS; their absence also excludes all
            // canonical child records through the unchanged foreign keys.
            for (const [sql, params] of [
                ['SELECT tenant_id FROM nofries.dashboard_tenants WHERE tenant_id=$1 LIMIT 1', [slot.tenantId]],
                ['SELECT account_id FROM nofries.dashboard_starter_accounts WHERE subject_key=$1 LIMIT 1', [s]],
                ['SELECT tenant_id FROM nofries.dashboard_starter_scopes WHERE subject_key=$1 LIMIT 1', [s]]
            ]) {
                const result = await tx.query(sql, params);
                if (!Array.isArray(result.rows)) fail();
                if (result.rows.length) return { empty: false };
            }
            return { empty: true, accountId: account.accountId, tenantId: slot.tenantId, organisationId: slot.organisationId,
                subjectKey: s, registration: 'absent', canonicalTenant: 'absent', starterAccount: 'absent', starterScopes: 'absent' };
        });
    }
    const { createEmptySignupResetAdapter } = require('../api/shared/dashboardAdmin/emptySignupResetAdapter');
    return createEmptySignupResetAdapter({ container: source, index, writerFence, sourceSha, providerKey,
        containerSha256: hash({ storageAccount: env.AZURE_STORAGE_ACCOUNT_NAME, container: externalConfiguration.starterAuthorityContainer }),
        readAdoption, inspectDependencies, clock: common.clock,
        audit: require('../api/shared/dashboardAdmin/resetAuditStore').createResetAuditStore(stateStore.container) });
}
module.exports = { createProductionSignupReset, writerImplementationSha256 };
