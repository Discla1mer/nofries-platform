'use strict';
const { fields, copy, equal, hash, subject, uuid, digest, instant } = require('../appLifecycle/dashboardRuntimeRecords');
const { dataCodec } = require('../appLifecycle/postgresDashboardBootstrap');
const { normaliseSelector, DashboardAdminError } = require('./service');
const invalid = () => { throw new DashboardAdminError(503, 'dashboard_admin_unavailable'); };
const absent = () => { throw new DashboardAdminError(404, 'dashboard_admin_not_found'); };
function outcomeRecord(raw, selector, operationId, phase, now) {
    const value = copy(raw, 32768), membership = ['suspend', 'restore'].includes(value.action);
    fields(value, ['schemaVersion', 'operationId', 'actorSubjectKey', 'action', 'targetSha256', 'before', 'proposedAfter',
        'phase', 'outcome', 'after', 'occurredAt', ...(membership ? ['selector', 'approvalSha256', 'context'] : ['commandSha256']),
        ...(membership ? ['commandSha256', 'nativeCommand', 'resultSha256'].filter(key => Object.hasOwn(value, key)) : [])]);
    uuid(value.operationId); subject(value.actorSubjectKey); digest(value.targetSha256); instant(value.occurredAt);
    if (value.targetSha256 !== hash(selector)) absent();
    if (value.schemaVersion !== 1 || value.operationId !== operationId || value.phase !== phase || value.occurredAt > now ||
        !['extend-expired-access', 'suspend', 'restore'].includes(value.action) ||
        !(phase === 'attempt' ? value.outcome === 'attempt' : ['succeeded', 'uncertain', 'refused', 'conflict'].includes(value.outcome))) invalid();
    const to = value.action === 'suspend' ? 'suspended' : 'active';
    if (membership) {
        let target; try { target = normaliseSelector(value.selector); } catch (_) { invalid(); }
        if (!equal(target, selector)) absent();
        fields(value.context, ['instanceId', 'restoreEpoch']); uuid(value.context.instanceId); uuid(value.context.restoreEpoch); digest(value.approvalSha256);
        if (!equal(value.proposedAfter, { status: to })) invalid();
        if (value.before !== null) { fields(value.before, ['status']); if (!['active', 'suspended'].includes(value.before.status)) invalid(); }
        if (Object.hasOwn(value, 'nativeCommand')) {
            const command = dataCodec.normaliseCommand(value.nativeCommand);
            if (command.type !== 'membership.command' || command.operationId !== operationId || command.actorSubjectKey !== value.actorSubjectKey ||
                command.tenantId !== selector.tenantId || command.organisationId !== selector.organisationId ||
                command.payload.action !== (value.action === 'suspend' ? 'suspend' : 'resume')) invalid();
        }
        for (const key of ['commandSha256', 'resultSha256']) if (Object.hasOwn(value, key)) digest(value[key]);
        if (Object.hasOwn(value, 'nativeCommand') !== Object.hasOwn(value, 'commandSha256') ||
            Object.hasOwn(value, 'resultSha256') && !value.nativeCommand ||
            value.outcome === 'uncertain' && !value.nativeCommand) invalid();
    } else {
        digest(value.commandSha256); fields(value.proposedAfter, ['status', 'expiresAt']); instant(value.proposedAfter.expiresAt);
        if (value.proposedAfter.status !== 'active') invalid();
        if (value.before !== null) {
            fields(value.before, ['status', 'expiresAt']); instant(value.before.expiresAt);
            if (!['active', 'expired', 'revoked'].includes(value.before.status)) invalid();
        }
    }
    if (phase === 'attempt' && (value.before !== null || value.nativeCommand || value.resultSha256 || membership && value.commandSha256)) invalid();
    if (value.outcome === 'uncertain' && value.before?.status !== (membership ? value.action === 'suspend' ? 'active' : 'suspended' : 'expired')) invalid();
    if (value.outcome === 'succeeded') {
        if (!value.before || value.before.status !== (membership ? value.action === 'suspend' ? 'active' : 'suspended' : 'expired') ||
            !equal(value.after, value.proposedAfter) || membership && (!value.nativeCommand || !value.resultSha256)) invalid();
    } else if (value.after !== null) invalid();
    return value;
}
function outcomePair(attempt, terminal) {
    if (!terminal) return;
    for (const key of ['operationId', 'actorSubjectKey', 'action', 'targetSha256', 'proposedAfter', 'selector', 'approvalSha256', 'context']) {
        if (!equal(attempt[key] ?? null, terminal[key] ?? null)) invalid();
    }
    if (attempt.occurredAt > terminal.occurredAt || attempt.action === 'extend-expired-access' && attempt.commandSha256 !== terminal.commandSha256) invalid();
}
// The command contains revision IDs for other organisation members. Keep the
// outcome view to the operator's audit facts, never expose that internal vector.
const outcomeView = value => value === null ? null : Object.fromEntries(['operationId', 'actorSubjectKey', 'action',
    'phase', 'outcome', 'before', 'proposedAfter', 'after', 'occurredAt'].map(key => [key, value[key]]));
module.exports = { outcomeRecord, outcomePair, outcomeView };
