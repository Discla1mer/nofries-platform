'use strict';
const { fields, hash } = require('../appLifecycle/dashboardRuntimeRecords');
const { normaliseSelector, DashboardAdminError } = require('./service');
const { readActionRecord } = require('./accountActionsStorage');
const { normaliseCustomerAuthoritySource, inspectCustomerAuthority } = require('./customerAuthorityExpiry');
const { subjectHash } = require('../customerSignup/customerAuthority');
const denied = () => { throw new DashboardAdminError(403, 'dashboard_admin_access_denied'); };

// At most three exact subject reads, after the existing scoped native policy.
// Never enumerate email records or guess between two matching authority stores.
function createAccountActionsSources(configuration, dashboard, authorise, createRuntime) {
    const withdrawn = Object.hasOwn(configuration, 'expiry');
    if (withdrawn && configuration.expiry !== false) throw new Error('dashboard_admin_configuration_invalid');
    fields(configuration, ['sources', 'auditContainer', 'auditPolicy', ...(withdrawn ? ['expiry'] : [])]);
    const notFound = () => { throw new DashboardAdminError(404, 'dashboard_admin_not_found'); };
    if (!Array.isArray(configuration.sources) || configuration.sources.length < 1 || configuration.sources.length > 3) throw new Error('dashboard_admin_configuration_invalid');
    const sources = configuration.sources.map(value => {
        fields(value, ['source', 'authorityContainer']);
        const source = normaliseCustomerAuthoritySource(value.source);
        return { ...value, source, runtime: createRuntime({ ...value, auditContainer: configuration.auditContainer,
            auditPolicy: configuration.auditPolicy, ...(withdrawn ? { expiry: false } : {}) }, dashboard, authorise) };
    });
    if (new Set(sources.map(row => row.source.kind)).size !== sources.length ||
        new Set(sources.map(row => row.authorityContainer.url)).size !== sources.length) throw new Error('dashboard_admin_configuration_invalid');
    async function select(actor, input, invocation) {
        const selector = normaliseSelector(input?.selector);
        await authorise(actor, selector); invocation.signal.throwIfAborted();
        const matches = [], blobName = `customer-subjects/${subjectHash(selector.subjectKey)}.json`;
        for (const row of sources) {
            if (selector.provider !== (row.source.kind === 'external_starter' ? 'external' : 'legacy')) continue;
            let found;
            try { found = await readActionRecord(row.authorityContainer, blobName, invocation.signal); }
            catch (error) { if (error.statusCode === 404 && error.code === 'BlobNotFound') continue; throw error; }
            try {
                const at = dashboard.clock();
                inspectCustomerAuthority({ source: row.source, blobName, ...found, observedAt: at },
                    { sourceSha256: hash(row.source), subjectKey: selector.subjectKey, tenantId: selector.tenantId, organisationId: selector.organisationId }, at);
            } catch (_) { denied(); }
            matches.push(row.runtime);
        }
        invocation.signal.throwIfAborted(); if (matches.length !== 1) denied();
        return matches[0];
    }
    // With expiry withdrawn, no extension approval or execution port exists and
    // the refusal happens before any authority or audit storage is touched.
    return Object.freeze({ expiry: !withdrawn,
        ...(withdrawn ? {} : { async approve(actor, input, invocation) { return (await select(actor, input, invocation)).approve(actor, input, invocation); } }),
        async execute(actor, input, invocation, action) {
            if (withdrawn && action === 'extend-expired-access') notFound();
            if (!['extend-expired-access', 'suspend', 'restore', 'approve-suspend', 'approve-restore'].includes(action)) denied();
            return (await select(actor, input, invocation)).execute(actor, input, invocation, action);
        }
    });
}
module.exports = { createAccountActionsSources };
