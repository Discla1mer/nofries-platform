'use strict';
const { randomUUID } = require('node:crypto');
const { fields, copy, freeze, equal, hash, instant, revision } = require('../appLifecycle/dashboardRuntimeRecords');
const { normaliseSelector, DashboardAdminError } = require('./service');
const { writeActionRecord } = require('./accountActionsStorage');
const fail = (status, code) => { throw new DashboardAdminError(status, 'dashboard_admin_' + code); };

// Native read only, with the same scoped session checks and durable blob audit.
// This does not depend on the dormant dashboard-admin lookup SQL proposal.
function createMembershipRead({ auditContainer, readContext, createRepository, clock }) {
    return async function readMembership(actor, raw, invocation) {
        let selector;
        try { selector = normaliseSelector(fields(copy(raw, 2048), ['selector']).selector); }
        catch (_) { fail(400, 'input_invalid'); }
        const signal = AbortSignal.any([invocation.signal, AbortSignal.timeout(10000)]);
        let context, last, attempted = false, terminal = false;
        const check = () => {
            const at = instant(clock());
            if (signal.aborted || last && at < last) fail(503, 'unavailable');
            last = at; return at;
        };
        async function current() {
            check(); const fresh = freeze(copy(await readContext(actor, selector, { ...invocation, signal }), 4096)); check();
            if (fresh.operatorSubjectKey !== actor.subjectKey || context && !equal(context, fresh)) fail(403, 'access_denied');
            context = fresh;
        }
        const operationId = randomUUID(), event = { schemaVersion: 1, operationId, action: 'read-membership',
            actorSubjectKey: actor.subjectKey, targetSha256: hash(selector), selector };
        const audit = (phase, outcome, after) => writeActionRecord(auditContainer,
            `dashboard-admin-account-actions/${operationId}/${phase}.json`,
            { ...event, phase, outcome, after, occurredAt: instant(clock()) }, { ifNoneMatch: '*' }, AbortSignal.timeout(5000));
        try {
            await current(); await audit('attempt', 'attempt', null); attempted = true;
            const scope = { tenantId: selector.tenantId, organisationId: selector.organisationId };
            const repository = createRepository(current, command => command.type === 'authority.read' &&
                command.actorSubjectKey === actor.subjectKey && command.tenantId === scope.tenantId && command.organisationId === scope.organisationId, context);
            const seen = await repository.readAuthoritySnapshot(scope, { authenticated: true, subjectKey: actor.subjectKey });
            const members = seen.snapshot.membershipState.memberships.filter(row => row.subjectKey === selector.subjectKey && row.status !== 'removed');
            revision(seen.revisions.membership);
            if (members.length !== 1 || !['active', 'suspended'].includes(members[0].status) ||
                seen.snapshot.membershipState.revision !== seen.revisions.membership) fail(409, 'conflict');
            const result = { selector, membershipStatus: members[0].status, expectedMembershipRevision: seen.revisions.membership };
            await current(); await audit('terminal', 'succeeded', { status: result.membershipStatus, revision: result.expectedMembershipRevision }); terminal = true;
            await current(); return result;
        } catch (error) {
            if (attempted && !terminal) {
                try { await audit('terminal', 'refused', null); } catch (_) { fail(503, 'unavailable'); }
            }
            if (error instanceof DashboardAdminError) throw error;
            fail(503, 'unavailable');
        }
    };
}
module.exports = { createMembershipRead };
