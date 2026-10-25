'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { isProxy } = require('node:util').types;
const { copy, fields, freeze } = require('../appLifecycle/dashboardRuntimeRecords');
const { dataCodec } = require('../appLifecycle/postgresDashboardBootstrap');
const { projectAuthorityRead } = require('./readProjection');

class DashboardAdminError extends Error {
    constructor(statusCode, code) { super(code); this.statusCode = statusCode; this.code = code; }
}
const fail = (status, suffix) => { throw new DashboardAdminError(status, 'dashboard_admin_' + suffix); };
const functionPort = value => typeof value === 'function' && !isProxy(value);

function normaliseSelector(input) {
    try {
        const value = fields(copy(input, 2048), ['provider', 'subjectKey', 'tenantId', 'organisationId']);
        if (!['legacy', 'external'].includes(value.provider)) throw new Error();
        dataCodec.subject(value.subjectKey);
        dataCodec.normaliseScope({ tenantId: value.tenantId, organisationId: value.organisationId });
        return freeze(value);
    } catch (_) { fail(400, 'input_invalid'); }
}
function operatorPrincipal(input) {
    try {
        const value = copy(input, 4096);
        if (value.provider !== 'entra-bff' || value.isAuthenticated !== true) throw new Error();
        dataCodec.subject(value.subjectKey);
        return freeze({ provider: value.provider, isAuthenticated: true, subjectKey: value.subjectKey });
    } catch (_) { fail(403, 'access_denied'); }
}

// Trusted internal composition only. No environment flags, static admin grant,
// customer runtime, email inference, mutation port or reader discovery exists.
// The policy must bind provider+immutable subject+scope, current operator grant
// and applicable runtime revocation/restore gates. A local Sales role is not it.
function createDashboardAdminService(options) {
    let config;
    try {
        if (isProxy(options)) throw new Error();
        fields(options, ['authoriseOperator', 'readAuthoritySnapshot', 'audit', 'clock', 'requestBudgetMs']);
        config = { ...options };
        if (![config.authoriseOperator, config.audit, config.clock].every(functionPort) ||
            config.readAuthoritySnapshot !== null && !functionPort(config.readAuthoritySnapshot) ||
            !Number.isSafeInteger(config.requestBudgetMs) || config.requestBudgetMs < 1 || config.requestBudgetMs > 60000) throw new Error();
    } catch (_) { fail(503, 'unavailable'); }

    async function authorise(principalInput, selector = null) {
        const principal = operatorPrincipal(principalInput);
        const target = selector === null ? null : normaliseSelector(selector);
        let allowed;
        try { allowed = await config.authoriseOperator(freeze({ principal, selector: target })); }
        catch (_) { fail(403, 'access_denied'); }
        if (allowed !== true) fail(403, 'access_denied');
        return principal;
    }

    // Hard time bound plus checks at every async boundary. A timed-out reader
    // may finish in its own driver, but cannot return data or start later audit.
    function bounded(work) {
        let closed = false, last = -Infinity, timer;
        const start = Date.now();
        const check = () => {
            let now;
            try { now = Date.parse(dataCodec.instant(config.clock())); } catch (_) { fail(503, 'unavailable'); }
            if (closed || Date.now() - start >= config.requestBudgetMs || now < last) fail(503, 'unavailable');
            last = now;
            return new Date(now).toISOString();
        };
        const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => { closed = true; reject(new DashboardAdminError(503, 'dashboard_admin_unavailable')); }, config.requestBudgetMs);
        });
        return Promise.race([Promise.resolve().then(() => work(check)), deadline])
            .finally(() => { closed = true; clearTimeout(timer); });
    }

    function capabilities(principal) {
        return bounded(async check => {
            check(); await authorise(principal); check();
            return freeze({ lookup: config.readAuthoritySnapshot !== null, recovery: [] });
        });
    }

    function lookup(principalInput, input) {
        return bounded(async check => {
            check();
            // Validate the operator first, before even accepting a target.
            const principal = await authorise(principalInput); check();
            const selector = normaliseSelector(input);
            await authorise(principal, selector); check();
            if (!config.readAuthoritySnapshot) fail(503, 'unavailable');
            const requestId = randomUUID();
            const targetSha256 = createHash('sha256').update(JSON.stringify(selector)).digest('hex');
            async function audit(outcome) {
                const event = freeze({ schemaVersion: 1, category: 'dashboard_admin_read', requestId,
                    actorSubjectKey: principal.subjectKey, targetSha256, outcome, occurredAt: check() });
                let saved;
                // The trusted host binds the exact normalised target to this
                // event privately; the public event remains digest-only.
                try { saved = await config.audit(event, selector); } catch (_) { fail(503, 'unavailable'); }
                check();
                if (saved !== true) fail(503, 'unavailable');
                await authorise(principal, selector); check();
            }
            await audit('attempt');
            let result;
            try {
                // Existing canonical repository accepts the first two arguments.
                // An isolated adapter may additionally verify provider selection.
                const read = await config.readAuthoritySnapshot(
                    freeze({ tenantId: selector.tenantId, organisationId: selector.organisationId }),
                    freeze({ authenticated: true, subjectKey: principal.subjectKey }), selector);
                check(); await authorise(principal, selector); check();
                result = projectAuthorityRead(read, selector);
                // An observation from the future is never current authority.
                if (Date.parse(result.evaluatedAt) > Date.parse(check())) throw new Error();
            } catch (error) {
                if (error instanceof DashboardAdminError) throw error;
                if (error?.code === 'dashboard_administration_denied') fail(403, 'access_denied');
                result = freeze({ status: 'unavailable', identity: { provider: selector.provider, subjectKey: selector.subjectKey },
                    scope: { tenantId: selector.tenantId, organisationId: selector.organisationId }, evaluatedAt: null,
                    signup: { status: 'unavailable' }, diagnostics: { status: 'unavailable' }, recovery: [] });
            }
            await audit(result.status);
            return freeze({ result });
        });
    }
    return Object.freeze({ authorise, capabilities, lookup });
}

module.exports = { createDashboardAdminService, DashboardAdminError, normaliseSelector };
