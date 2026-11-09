'use strict';

const { fields, copy, freeze, hash, equal, uuid, instant, revision } = require('../appLifecycle/dashboardRuntimeRecords');
const { randomUUID } = require('node:crypto');
const { DashboardAdminError } = require('./service');
const { prepareInput, actionCommand, commandDigest } = require('./accountActionRecords');
const { accountActionApproval } = require('./accountActionApproval');
const { normaliseCustomerAuthoritySource, inspectCustomerAuthority } = require('./customerAuthorityExpiry');
const { subjectHash } = require('../customerSignup/customerAuthority');
const { readActionRecord, writeActionRecord } = require('./accountActionsStorage');
const { validateMembershipApproval, readMembershipApproval } = require('./accountActionsMembershipApproval');
const fail = (status, suffix) => { throw new DashboardAdminError(status, 'dashboard_admin_' + suffix); };

function createMembershipAction({ source: rawSource, authorityContainer, auditContainer, readContext,
    readApprovedAction, auditPolicy, identityPolicy, createRepository, clock }) {
    const source = normaliseCustomerAuthoritySource(rawSource), policy = freeze(copy(auditPolicy, 2048));
    const auditConfigurationSha256 = hash({ purpose: 'dashboard_admin_account_actions', containerUrl: auditContainer.url });
    if (authorityContainer.url !== `https://${source.storageAccount}.blob.core.windows.net/${source.container}` ||
        authorityContainer.url === auditContainer.url || readApprovedAction !== undefined && typeof readApprovedAction !== 'function') fail(503, 'unavailable');
    return Object.freeze({ async execute(actor, raw, invocation, route) {
        const approving = ['approve-suspend', 'approve-restore'].includes(route), action = approving ? route.slice(8) : route;
        let input, selector;
        try {
            input = fields(copy(raw, 2048), ['selector', ...(!approving ? ['operationId'] : []), 'confirmationEmail', 'expectedMembershipRevision']);
            if (approving) input.operationId = randomUUID();
            selector = prepareInput({ selector: input.selector, action, patch: null }).selector;
            uuid(input.operationId); revision(input.expectedMembershipRevision);
            if (typeof input.confirmationEmail !== 'string' || input.confirmationEmail.length > 254) throw new Error();
        } catch (_) { fail(400, 'input_invalid'); }
        const signal = AbortSignal.any([invocation.signal, AbortSignal.timeout(10000)]), start = Date.now();
        let last = null, context, approval, observed, attempted = false, writing = false, permitted = null;
        const check = () => {
            const at = instant(clock());
            if (signal.aborted || Date.now() - start >= 10000 || last !== null && at < last) fail(503, 'unavailable');
            last = at; return at;
        };
        const event = { schemaVersion: 1, operationId: input.operationId, actorSubjectKey: actor.subjectKey,
            action: route, selector, targetSha256: hash(selector), before: null, proposedAfter: { status: action === 'suspend' ? 'suspended' : 'active' } };
        const envelope = (phase, outcome, after) => ({ ...event, phase, outcome, after, occurredAt: instant(clock()) });
        const audit = (phase, outcome, after) => writeActionRecord(auditContainer,
            `dashboard-admin-account-actions/${input.operationId}/${approving ? 'approval-' : ''}${phase}.json`,
            envelope(phase, outcome, after), { ifNoneMatch: '*' }, AbortSignal.timeout(5000));
        const blobName = `customer-subjects/${subjectHash(selector.subjectKey)}.json`;
        async function current() {
            check();
            const fresh = freeze(copy(await readContext(actor, selector, invocation), 4096));
            check();
            const at = check();
            if (fresh.operatorSubjectKey !== actor.subjectKey || fresh.identityPolicySha256 !== hash(identityPolicy) ||
                context && !equal(context, fresh)) fail(403, 'access_denied');
            context = fresh;
            const found = await readActionRecord(authorityContainer, blobName, signal);
            check();
            const status = inspectCustomerAuthority({ source, blobName, ...found, observedAt: check() },
                { sourceSha256: hash(source), subjectKey: selector.subjectKey, tenantId: selector.tenantId, organisationId: selector.organisationId }, check());
            if (selector.provider !== (source.kind === 'external_starter' ? 'external' : 'legacy')) fail(403, 'access_denied');
            if (status.status === 'revoked') fail(409, 'revoked');
            if (input.confirmationEmail !== found.record.email) fail(400, 'input_invalid');
            if (observed && !equal(observed, found)) fail(409, 'conflict');
            observed = found;
            if (!approving) {
                const record = await readMembershipApproval(auditContainer, input.operationId, check);
                if (readApprovedAction && !equal(record, await readApprovedAction({ operatorSubjectKey: actor.subjectKey, selector, operationId: input.operationId }))) fail(403, 'access_denied');
                const grant = validateMembershipApproval(record, binding(), context, action, policy, check());
                if (!equal(grant.selector, selector) || !equal(grant.identityPolicy, { policyId: identityPolicy.policyId, policyRevision: identityPolicy.policyRevision }) ||
                    approval && !equal(approval, record)) fail(403, 'access_denied');
                approval = freeze(copy(record));
            }
        }
        const binding = () => ({ operationId: input.operationId, sessionSha256: context.sessionSha256,
            expectedMembershipRevision: input.expectedMembershipRevision, authoritySha256: hash(observed.record), sourceSha256: hash(source), auditConfigurationSha256 });
        const readTerminal = async id => {
            try { return (await readActionRecord(auditContainer, `dashboard-admin-account-actions/${id}/terminal.json`, signal)).record; }
            catch (error) { if (error.statusCode === 404) fail(409, 'conflict'); throw error; }
        };
        try {
            await current();
            event.approvalSha256 = approving ? null : hash(approval);
            event.context = { instanceId: context.instanceId, restoreEpoch: context.restoreEpoch };
            await audit('attempt', 'attempt', null); attempted = true;
            if (action === 'suspend' && selector.subjectKey === actor.subjectKey) fail(403, 'access_denied');
            const scope = { tenantId: selector.tenantId, organisationId: selector.organisationId };
            const repository = createRepository(current, command => command.actorSubjectKey === actor.subjectKey &&
                command.tenantId === scope.tenantId && command.organisationId === scope.organisationId &&
                (command.type === 'authority.read' || permitted !== null && equal(command, permitted)), context);
            const seen = await repository.readAuthoritySnapshot(scope, { authenticated: true, subjectKey: actor.subjectKey });
            check();
            const matches = seen.snapshot.membershipState.memberships.filter(row => row.subjectKey === selector.subjectKey && row.status !== 'removed');
            if (matches.length !== 1 || seen.revisions.membership !== input.expectedMembershipRevision) fail(409, 'conflict');
            const member = matches[0]; event.before = { status: member.status };
            if (member.status !== (action === 'suspend' ? 'active' : 'suspended')) fail(409, 'conflict');
            if (action === 'restore') await repository.verifyRestore(selector, seen.snapshot, readTerminal);
            if (approving) {
                await current(); const at = check(), expiresAt = new Date(Date.parse(at) + 900000).toISOString();
                const grant = accountActionApproval({ schemaVersion: 1, bindingId: input.operationId, revision: 0, status: 'active', purpose: 'account_support',
                    operatorSubjectKey: actor.subjectKey, instanceId: context.instanceId, restoreEpoch: context.restoreEpoch, selector, actions: [action],
                    approvedAt: at, validFrom: at, validUntil: expiresAt, approvalReference: input.operationId,
                    identityPolicy: { policyId: identityPolicy.policyId, policyRevision: identityPolicy.policyRevision }, auditPolicy: policy });
                const record = { grant, ...binding() }; event.approvalSha256 = hash(record);
                await writeActionRecord(auditContainer, `dashboard-admin-account-actions/${input.operationId}/approval.json`, record, { ifNoneMatch: '*' }, signal);
                await audit('terminal', 'succeeded', { status: 'approved', expiresAt }); attempted = false;
                return { selector, operationId: input.operationId, action, expectedMembershipRevision: input.expectedMembershipRevision,
                    membershipStatus: member.status, approvalExpiresAt: expiresAt };
            }
            const preparedAt = check();
            const proposed = { schemaVersion: 1, operationId: input.operationId, actorSubjectKey: actor.subjectKey,
                selector, expectedVersion: hash(seen.snapshot), action, patch: null, preparedAt,
                expiresAt: new Date(Date.parse(preparedAt) + 300000).toISOString(),
                witness: { provider: selector.provider, subjectKey: selector.subjectKey, revisions: seen.revisions,
                    restoreEpoch: context.restoreEpoch, authoritySha256: hash(observed.record), approvalSha256: hash(approval) } };
            const command = actionCommand({ ...proposed, commandSha256: commandDigest(proposed) });
            event.commandSha256 = command.commandSha256;
            permitted = freeze({ ...scope, operationId: command.operationId, actorSubjectKey: actor.subjectKey,
                type: 'membership.command', expectedRevisions: seen.revisions,
                payload: { action: action === 'restore' ? 'resume' : 'suspend', payload: { membershipId: member.membershipId } } });
            if (Buffer.byteLength(JSON.stringify({ ...envelope('terminal', 'succeeded', event.proposedAfter),
                nativeCommand: permitted, resultSha256: '0'.repeat(64) })) > 32768) fail(503, 'unavailable');
            writing = true; event.nativeCommand = permitted; event.resultSha256 = hash(await repository.executeAuthorityCommand(permitted));
            await audit('terminal', 'succeeded', event.proposedAfter); attempted = false;
            return { operationId: input.operationId, outcome: 'succeeded' };
        } catch (error) {
            const conflict = [409, 412].includes(error?.statusCode);
            if (attempted) {
                try { await audit('terminal', conflict ? 'conflict' : writing ? 'uncertain' : 'refused', null); }
                catch (_) { fail(503, 'unavailable'); }
            }
            if (error instanceof DashboardAdminError) throw error;
            fail(conflict ? 409 : 503, conflict ? 'conflict' : 'unavailable');
        }
    } });
}
module.exports = { createMembershipAction };
