'use strict';

const { fields, copy, freeze, hash, equal, uuid, instant } = require('../appLifecycle/dashboardRuntimeRecords');
const { normaliseSelector, DashboardAdminError } = require('./service');
const { normaliseCustomerAuthoritySource, inspectCustomerAuthority, planCustomerAuthorityExpiry, customerAuthorityExpiryCommandHash } = require('./customerAuthorityExpiry');
const { subjectHash } = require('../customerSignup/customerAuthority');
const { readActionRecord, writeActionRecord } = require('./accountActionsStorage');
const fail = (status, suffix) => { throw new DashboardAdminError(status, 'dashboard_admin_' + suffix); };

// Trusted host ports only. readContext must verify the native session gate and
// current restore epoch; readApprovedExtension reads an independent approval,
// never constructs one from the HTTP request. The flag is not a grant.
function createExpiryAction({ source: rawSource, authorityContainer, auditContainer, readContext, readApprovedExtension, clock }) {
    const source = normaliseCustomerAuthoritySource(rawSource);
    if (authorityContainer.url !== `https://${source.storageAccount}.blob.core.windows.net/${source.container}` ||
        !/^https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net\/[a-z0-9-]{3,63}$/.test(auditContainer.url) ||
        auditContainer.url === authorityContainer.url || [readContext, readApprovedExtension, clock].some(fn => typeof fn !== 'function')) fail(503, 'unavailable');
    // An approval is bound to the actual audit destination, not a caller digest.
    const auditConfigurationSha256 = hash({ purpose: 'dashboard_admin_account_actions', containerUrl: auditContainer.url });
    return Object.freeze({ async execute(actor, raw, invocation) {
        let input;
        try {
            input = fields(copy(raw, 2048), ['selector', 'operationId', 'confirmationEmail', 'newExpiresAt']);
            input.selector = normaliseSelector(input.selector); uuid(input.operationId); instant(input.newExpiresAt);
            if (typeof input.confirmationEmail !== 'string' || input.confirmationEmail.length > 254) throw new Error();
        } catch (_) { fail(400, 'input_invalid'); }
        const { selector, operationId } = input, start = Date.now();
        let last = null, attempted = false, event, writeStarted = false;
        const check = () => {
            const at = instant(clock());
            if (invocation.signal.aborted || Date.now() - start >= 10000 || last !== null && at < last) fail(503, 'unavailable');
            last = at; return at;
        };
        const signal = AbortSignal.any([invocation.signal, AbortSignal.timeout(10000)]);
        const audit = (phase, outcome, after) => writeActionRecord(auditContainer,
            `dashboard-admin-account-actions/${operationId}/${phase}.json`,
            { ...event, phase, outcome, after, occurredAt: instant(clock()) }, { ifNoneMatch: '*' }, AbortSignal.timeout(5000));
        try {
            check();
            const context = freeze({ ...await readContext(actor, selector, invocation), auditConfigurationSha256 });
            if (context.operatorSubjectKey !== actor.subjectKey) fail(403, 'access_denied');
            check();
            const approved = freeze(fields(copy(await readApprovedExtension(operationId), 16384), ['command', 'approval']));
            const target = { sourceSha256: hash(source), subjectKey: selector.subjectKey,
                tenantId: selector.tenantId, organisationId: selector.organisationId };
            if (selector.provider !== (source.kind === 'external_starter' ? 'external' : 'legacy') ||
                !equal(approved.command.target, target) || approved.command.operationId !== operationId ||
                approved.command.newExpiresAt !== input.newExpiresAt) fail(403, 'access_denied');
            if (!equal(approved.approval.context, context) ||
                approved.approval.commandSha256 !== customerAuthorityExpiryCommandHash(approved.command, context)) fail(403, 'access_denied');
            event = { schemaVersion: 1, operationId, action: 'extend-expired-access', actorSubjectKey: actor.subjectKey,
                targetSha256: hash(selector), commandSha256: hash(approved.command), before: null,
                proposedAfter: { status: 'active', expiresAt: input.newExpiresAt } };
            check();
            await audit('attempt', 'attempt', null); attempted = true;
            check();
            const blobName = `customer-subjects/${subjectHash(selector.subjectKey)}.json`;
            const found = await readActionRecord(authorityContainer, blobName, signal);
            const observation = { source, blobName, ...found, observedAt: check() };
            const before = inspectCustomerAuthority(observation, target, check());
            event.before = { status: before.status, expiresAt: before.expiresAt };
            if (input.confirmationEmail !== found.record.email) fail(400, 'input_invalid');
            if (before.status !== 'expired') fail(409, before.status === 'revoked' ? 'revoked' : 'not_expired');
            let plan;
            const current = async () => {
                check();
                const fresh = { ...await readContext(actor, selector, invocation), auditConfigurationSha256 };
                check();
                if (!equal(context, fresh) || !equal(approved, await readApprovedExtension(operationId))) fail(403, 'access_denied');
                check();
                try { return planCustomerAuthorityExpiry({ observation, ...approved, context }, check()); }
                catch (_) { fail(403, 'access_denied'); }
            };
            plan = await current();
            writeStarted = true;
            try { await writeActionRecord(authorityContainer, blobName, plan.after.record, { ifMatch: plan.before.etag }, signal); }
            catch (error) {
                // An SDK retry can report 412 after a lost successful response.
                // Identical current bytes cannot prove which writer succeeded.
                if ([409, 412].includes(error?.statusCode)) {
                    const currentRecord = await readActionRecord(authorityContainer, blobName, signal);
                    if (hash(currentRecord.record) === plan.after.sha256) fail(503, 'unavailable');
                }
                throw error;
            }
            await audit('terminal', 'succeeded', { status: 'active', expiresAt: input.newExpiresAt });
            attempted = false; // A terminal outcome must never be overwritten.
            return { operationId, outcome: 'succeeded' };
        } catch (error) {
            const conflict = [409, 412].includes(error?.statusCode);
            if (attempted) {
                try { await audit('terminal', conflict ? 'conflict' : writeStarted ? 'uncertain' : 'refused', null); }
                catch (_) { fail(503, 'unavailable'); }
            }
            if (error instanceof DashboardAdminError) throw error;
            fail(conflict ? 409 : 503, conflict ? 'conflict' : 'unavailable');
        }
    } });
}
module.exports = { createExpiryAction };
