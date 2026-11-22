'use strict';

const { randomUUID } = require('node:crypto');
const { fields, copy, hash, equal, uuid, revision, instant } = require('../appLifecycle/dashboardRuntimeRecords');
const { tuples, sameTuple } = require('../appLifecycle/paidFrameworkDecisions');
const { normaliseSelector, DashboardAdminError } = require('./service');
const { readActionRecord, writeActionRecord } = require('./accountActionsStorage');
const { normaliseCustomerAuthoritySource, inspectCustomerAuthority } = require('./customerAuthorityRecords');
const { subjectHash } = require('../customerSignup/customerAuthority');
const { APPROVAL_AUTHORITY } = require('./accountActionsMembershipApproval');

function fail(status, code) { throw new DashboardAdminError(status, 'dashboard_admin_' + code); }
// Audit records carry the reason digest the database stores, never the text.
function audited(command) {
    const { reason, ...rest } = command;
    return { ...rest, reasonSha256: hash(reason), reasonLength: reason.length };
}

function createFrameworkAction(options) {
    const { authorityContainer, auditContainer, readContext, createRepository, clock, identityPolicy } = options;
    const source = normaliseCustomerAuthoritySource(options.source);
    return async (actor, raw, invocation) => {
        let input, command;
        try {
            input = fields(copy(raw, 2048), ['selector', 'expectedMembershipRevision', 'confirmationEmail',
                'tuple', 'action', 'reason', 'step', ...(raw?.step === 'apply' ? ['operationId'] : [])]);
            const tuple = fields(input.tuple, ['moduleId', 'profileId', 'version']);
            if (!tuples.some(item => sameTuple(item, tuple)) || !['grant', 'revoke'].includes(input.action) ||
                !['approve', 'apply'].includes(input.step) || typeof input.confirmationEmail !== 'string' ||
                input.confirmationEmail.length > 254 || typeof input.reason !== 'string' ||
                !input.reason.trim() || input.reason !== input.reason.trim() || input.reason.length > 240 ||
                /[\x00-\x1f\x7f]/u.test(input.reason)) throw new Error();
            command = { selector: normaliseSelector(input.selector), expectedMembershipRevision: revision(input.expectedMembershipRevision),
                actorSubjectKey: actor.subjectKey, tuple, reason: input.reason, action: input.action,
                operationId: input.step === 'approve' ? randomUUID() : uuid(input.operationId) };
        } catch (_) { fail(400, 'input_invalid'); }
        const signal = AbortSignal.any([invocation.signal, AbortSignal.timeout(10000)]);
        const selector = command.selector, directory = 'dashboard-admin-framework-access/' + command.operationId + '/';
        const audit = (name, record) => writeActionRecord(auditContainer, directory + name + '.json',
            { schemaVersion: 1, ...record }, { ifNoneMatch: '*' }, AbortSignal.timeout(5000));
        const blobName = 'customer-subjects/' + subjectHash(selector.subjectKey) + '.json';
        let binding, approval, last = null;
        function now() {
            const value = instant(clock());
            if (signal.aborted || last !== null && value < last) fail(503, 'unavailable');
            last = value; return value;
        }
        async function current() {
            now();
            const context = await readContext(actor, selector, { ...invocation, signal });
            if (context.operatorSubjectKey !== actor.subjectKey || context.identityPolicySha256 !== hash(identityPolicy)) fail(403, 'access_denied');
            const found = await readActionRecord(authorityContainer, blobName, signal);
            const observed = inspectCustomerAuthority({ source, blobName, ...found, observedAt: now() },
                { sourceSha256: hash(source), subjectKey: selector.subjectKey, tenantId: selector.tenantId, organisationId: selector.organisationId }, now());
            if (observed.status === 'revoked' || input.confirmationEmail !== found.record.email ||
                selector.provider !== (source.kind === 'external_starter' ? 'external' : 'legacy')) fail(403, 'access_denied');
            const fresh = { context, authoritySha256: hash(found.record), sourceSha256: hash(source),
                auditPolicySha256: hash(options.auditPolicy), auditContainer: auditContainer.url };
            if (binding && !equal(binding, fresh)) fail(403, 'access_denied');
            binding = fresh;
            if (approval && (now() < approval.approvedAt || now() >= approval.expiresAt)) fail(403, 'access_denied');
        }
        // A site using an external approval policy cannot substitute a self-issued grant.
        if (options.readApprovedAction) fail(403, 'access_denied');
        await current();
        const repo = createRepository(current, candidate => equal(candidate, command), binding.context);
        if (input.step === 'approve') {
            const witness = await repo.frameworkDecision(command, null);
            await current();
            const approvedAt = now(), expiresAt = new Date(Date.parse(approvedAt) + 900000).toISOString();
            await audit('approval', { approvalAuthority: APPROVAL_AUTHORITY, command: audited(command), binding, witness, approvedAt, expiresAt });
            return { operationId: command.operationId, approvalExpiresAt: expiresAt, action: command.action, tuple: command.tuple };
        }
        try { approval = (await readActionRecord(auditContainer, directory + 'approval.json', signal)).record; }
        catch (error) { if (error.statusCode === 404) fail(403, 'access_denied'); throw error; }
        if (approval.schemaVersion !== 1 || approval.approvalAuthority !== APPROVAL_AUTHORITY ||
            !equal(approval.command, audited(command)) || !equal(approval.binding, binding) ||
            Date.parse(instant(approval.expiresAt)) - Date.parse(instant(approval.approvedAt)) !== 900000) fail(403, 'access_denied');
        await current();
        // The create-only attempt consumes this approval across all processes before any mutation.
        const event = { command: audited(command), approvalSha256: hash(approval), before: approval.witness };
        try { await audit('attempt', { ...event, at: now() }); }
        catch (error) { if (error.statusCode === 409 || error.statusCode === 412) fail(409, 'conflict'); throw error; }
        let result;
        try { result = await repo.frameworkDecision(command, approval.witness); }
        catch (error) {
            // An unbound operator capability is refused before any write, so it is deterministic.
            const notApplied = error.statusCode === 503 && error.notApplied === 'operator_capability_unbound';
            await audit('outcome', { ...event, outcome: notApplied ? 'not_applied' : error.statusCode === 409 || error.statusCode === 403 ? 'refused' : 'uncertain',
                ...(notApplied ? { code: error.notApplied } : {}), at: instant(clock()) });
            throw error;
        }
        await audit('outcome', { ...event, result, outcome: 'succeeded', at: instant(clock()) });
        return { operationId: command.operationId, outcome: 'succeeded', ...result };
    };
}
module.exports = { createFrameworkAction };
