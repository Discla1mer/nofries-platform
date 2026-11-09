'use strict';

const { randomUUID } = require('node:crypto');
const { fields, copy, hash, equal, instant, uuid } = require('../appLifecycle/dashboardRuntimeRecords');
const { normaliseSelector, DashboardAdminError } = require('./service');
const { inspectCustomerAuthority, customerAuthorityExpiryCommandHash, planCustomerAuthorityExpiry } = require('./customerAuthorityExpiry');
const { readActionRecord, writeActionRecord } = require('./accountActionsStorage');
const fail = (status, code) => { throw new DashboardAdminError(status, 'dashboard_admin_' + code); };
const prefix = id => { uuid(id); return `dashboard-admin-account-actions/${id}/`; };

// Separate staff operation; the executor only reads these protected records.
// A failed/missing issuance audit leaves the stored approval unusable.
function createExpiryApproval({ source, authorityContainer, auditContainer, readContext, clock }) {
    async function readApprovedExtension(id) {
        const signal = AbortSignal.timeout(5000), path = prefix(id);
        const { record } = await readActionRecord(auditContainer, path + 'approval.json', signal);
        const { record: terminal } = await readActionRecord(auditContainer, path + 'approval-terminal.json', signal);
        if (terminal.outcome !== 'succeeded' || terminal.approvalSha256 !== hash(record)) fail(403, 'access_denied');
        return record;
    }
    async function approve(actor, raw, invocation) {
        let input;
        try {
            input = fields(copy(raw, 2048), ['email', 'confirmationEmail', 'newExpiresAt']); instant(input.newExpiresAt);
            if (typeof input.email !== 'string' || input.email.length > 254 || input.email !== input.email.trim().toLowerCase() ||
                !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) || input.confirmationEmail !== input.email) throw new Error();
        } catch (_) { fail(400, 'input_invalid'); }
        const operationId = randomUUID(), signal = AbortSignal.any([invocation.signal, AbortSignal.timeout(10000)]);
        const context = async selector => ({ ...await readContext(actor, selector, invocation),
            auditConfigurationSha256: hash({ purpose: 'dashboard_admin_account_actions', containerUrl: auditContainer.url }) });
        let last = null;
        const check = () => {
            const at = instant(clock());
            if (signal.aborted || last !== null && at < last) fail(503, 'unavailable');
            last = at; return at;
        };
        let attempted = false, event = { schemaVersion: 1, operationId, action: 'approve-extension', actorSubjectKey: actor.subjectKey,
            targetSha256: hash(input.email), before: null, proposedAfter: { expiresAt: input.newExpiresAt } };
        const audit = (phase, outcome, extra = {}) => writeActionRecord(auditContainer, prefix(operationId) + `approval-${phase}.json`,
            { ...event, ...extra, phase, outcome, occurredAt: instant(clock()) }, { ifNoneMatch: '*' }, AbortSignal.timeout(5000));
        try {
            check(); const initial = await context(null); check();
            if (initial.operatorSubjectKey !== actor.subjectKey) fail(403, 'access_denied');
            await audit('attempt', 'attempt'); attempted = true;
            let observation = null, count = 0;
            // Exact email in one configured authority source; ambiguity or an
            // incomplete bounded scan cannot select a customer for mutation.
            for await (const item of authorityContainer.listBlobsFlat({ prefix: 'customer-subjects/', abortSignal: signal })) {
                check();
                if (++count > 100 || !/^customer-subjects\/[0-9a-f]{64}\.json$/.test(item.name)) fail(503, 'unavailable');
                const found = await readActionRecord(authorityContainer, item.name, signal);
                if (found.record?.email !== input.email) continue;
                if (observation) fail(409, 'conflict');
                observation = { source, blobName: item.name, ...found, observedAt: check() };
            }
            if (!observation) fail(409, 'conflict');
            const record = observation.record;
            const selector = normaliseSelector({ provider: source.kind === 'external_starter' ? 'external' : 'legacy',
                subjectKey: record.subjectKey, tenantId: record.tenantId, organisationId: record.organisationId });
            const target = { sourceSha256: hash(source), subjectKey: selector.subjectKey, tenantId: selector.tenantId, organisationId: selector.organisationId };
            const current = await context(selector); check();
            if (!equal(initial, current)) fail(403, 'access_denied');
            const before = inspectCustomerAuthority(observation, target, check());
            event = { ...event, targetSha256: hash(selector), before: { status: before.status, expiresAt: before.expiresAt } };
            if (before.status !== 'expired') fail(409, before.status === 'revoked' ? 'revoked' : 'not_expired');
            const command = { schemaVersion: 1, purpose: 'customer_authority_expiry_extension', operationId, target,
                beforeSha256: before.authoritySha256, beforeEtag: before.etag, beforeRevision: before.revision,
                beforeExpiresAt: before.expiresAt, newExpiresAt: input.newExpiresAt };
            const issuedAt = check(), expiresAt = new Date(Date.parse(issuedAt) + 15 * 60000).toISOString();
            const approval = { schemaVersion: 1, purpose: command.purpose, status: 'active', approvalId: randomUUID(), revision: 0,
                context: current, commandSha256: customerAuthorityExpiryCommandHash(command, current),
                approvedExpiresAt: input.newExpiresAt, issuedAt, expiresAt };
            try { planCustomerAuthorityExpiry({ observation, command, approval, context: current }, check()); }
            catch (_) { fail(400, 'input_invalid'); }
            if (!equal(current, await context(selector))) fail(403, 'access_denied');
            check(); const approved = { command, approval };
            await writeActionRecord(auditContainer, prefix(operationId) + 'approval.json', approved, { ifNoneMatch: '*' }, signal);
            await audit('terminal', 'succeeded', { approvalSha256: hash(approved), after: { status: 'approved', expiresAt } });
            attempted = false;
            return { selector, operationId, newExpiresAt: input.newExpiresAt, approvalExpiresAt: expiresAt };
        } catch (error) {
            if (attempted) {
                try { await audit('terminal', 'refused', { after: null }); } catch (_) { fail(503, 'unavailable'); }
            }
            if (error instanceof DashboardAdminError) throw error;
            fail(503, 'unavailable');
        }
    }
    return Object.freeze({ approve, readApprovedExtension });
}
module.exports = { createExpiryApproval };
