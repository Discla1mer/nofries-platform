'use strict';

// Executable design only: no host imports this adapter. See the decision note.
const { copy, fields, freeze, scope, subject, uuid, digest, revision, instant, hash, equal } = require('../appLifecycle/dashboardRuntimeRecords');
const { createOrganisation } = require('../appLifecycle/tenantDomain');
const ACTION = 'paid_entitlement';
const fail = (statusCode = 503) => { const error = new Error('paid_entitlement_' + (statusCode === 409 ? 'conflict' : 'unavailable')); error.statusCode = statusCode; throw error; };
function patch(input) {
    const value = fields(copy(input, 1024), ['enabled', 'validUntil', 'agreementRef']);
    if (typeof value.enabled !== 'boolean') fail();
    if (value.enabled) { instant(value.validUntil); uuid(value.agreementRef); }
    else if (value.validUntil !== null || value.agreementRef !== null) fail();
    return value;
}
function selector(input) {
    const value = fields(copy(input, 2048), ['provider', 'subjectKey', 'tenantId', 'organisationId']);
    if (!['legacy', 'external'].includes(value.provider)) fail();
    subject(value.subjectKey); scope({ tenantId: value.tenantId, organisationId: value.organisationId }); return value;
}
function record(input, target) {
    const value = fields(copy(input, 2048), ['schemaVersion', 'tenantId', 'organisationId', 'revision', 'enabled', 'validUntil', 'agreementRef']);
    if (value.schemaVersion !== 1 || value.tenantId !== target.tenantId || value.organisationId !== target.organisationId) fail();
    revision(value.revision); patch({ enabled: value.enabled, validUntil: value.validUntil, agreementRef: value.agreementRef });
    if (value.revision === 0 && value.enabled) fail(); return value;
}
function command(input) {
    const value = fields(copy(input, 8192), ['schemaVersion', 'operationId', 'actorSubjectKey', 'selector', 'expectedVersion',
        'action', 'patch', 'preparedAt', 'expiresAt', 'witness', 'commandSha256']);
    if (value.schemaVersion !== 1 || value.action !== ACTION) fail();
    uuid(value.operationId); subject(value.actorSubjectKey); selector(value.selector); digest(value.expectedVersion); digest(value.commandSha256);
    patch(value.patch); instant(value.preparedAt); instant(value.expiresAt);
    fields(value.witness, ['bindingSha256', 'restoreEpoch']); digest(value.witness.bindingSha256); revision(value.witness.restoreEpoch);
    const { commandSha256, ...unsigned } = value;
    if (hash(unsigned) !== commandSha256 || value.preparedAt >= value.expiresAt || Date.parse(value.expiresAt) - Date.parse(value.preparedAt) > 300000) fail();
    return freeze(value);
}

// store.transaction(scope, work) MUST serialize reads/writes on the same tenant
// fence as #47/#61. tx.save stages flag + audit + receipt atomically; transaction
// must invoke the supplied commit guard at its LAST commit boundary and roll back
// on failure. There is deliberately no production store implementation here.
function createPaidEntitlementAdminBridge({ enabled = false, store } = {}) {
    if (typeof enabled !== 'boolean') fail();
    async function guarded(ctx, operation) {
        try {
            if (!enabled || !store || typeof store.transaction !== 'function' || !ctx ||
                typeof ctx.check !== 'function' || typeof ctx.beforeCommit !== 'function' ||
                ctx.principal?.provider !== 'entra-bff' || ctx.principal.isAuthenticated !== true) fail();
            subject(ctx.principal.subjectKey); instant(ctx.check()); await ctx.beforeCommit();
            const result = await operation(); instant(ctx.check()); await ctx.beforeCommit(); return freeze(result);
        } catch (error) { fail(error?.statusCode === 409 ? 409 : 503); }
    }
    async function snapshot(tx, target) {
        const value = fields(copy(await tx.snapshot(target), 8192), ['selector', 'displayName', 'bindingSha256', 'restoreEpoch', 'record']);
        if (!equal(selector(value.selector), target)) fail();
        digest(value.bindingSha256); revision(value.restoreEpoch); value.record = record(value.record, target);
        if (createOrganisation({ tenantId: target.tenantId, organisationId: target.organisationId, displayName: value.displayName }).displayName !== value.displayName) fail();
        return value;
    }
    function transact(target, work, guard) {
        return store.transaction({ tenantId: target.tenantId, organisationId: target.organisationId }, work, guard);
    }
    function inspect(input, ctx) {
        return guarded(ctx, async () => {
            const target = selector(input);
            return transact(target, async tx => {
                const current = await snapshot(tx, target);
                return { selector: target, version: hash(current), displayName: current.displayName, paidEntitlement: current.record,
                    actions: [ACTION], witness: { bindingSha256: current.bindingSha256, restoreEpoch: current.restoreEpoch } };
            }, ctx.beforeCommit);
        });
    }
    function bound(input, ctx) {
        const value = command(input);
        if (value.actorSubjectKey !== ctx.principal.subjectKey || value.preparedAt > ctx.check()) fail(); return value;
    }
    async function retained(tx, value, ctx) {
        const raw = await tx.receipt(value.operationId);
        if (raw === null) return null;
        const current = await snapshot(tx, value.selector);
        if (!equal(value.witness, { bindingSha256: current.bindingSha256, restoreEpoch: current.restoreEpoch })) fail(409);
        const receipt = fields(copy(raw, 2048), ['operationId', 'commandSha256', 'status', 'version', 'occurredAt']);
        if (receipt.operationId !== value.operationId || receipt.commandSha256 !== value.commandSha256 || receipt.status !== 'succeeded') fail();
        digest(receipt.version); instant(receipt.occurredAt);
        if (receipt.occurredAt < value.preparedAt || receipt.occurredAt >= value.expiresAt || receipt.occurredAt > ctx.check()) fail(); return receipt;
    }
    function outcome(input, ctx) {
        return guarded(ctx, async () => {
            const value = bound(input, ctx);
            return transact(value.selector, tx => retained(tx, value, ctx), ctx.beforeCommit);
        });
    }
    function commit(input, ctx) {
        return guarded(ctx, async () => {
            const value = bound(input, ctx);
            const commitGuard = async () => {
                await ctx.beforeCommit();
                const at = instant(ctx.check());
                if (at >= value.expiresAt || value.patch.enabled && at >= value.patch.validUntil) fail(409);
            };
            // A retained success is reconciled by outcome; commit itself never
            // starts after confirmation expiry, including an idempotent retry.
            await commitGuard();
            return transact(value.selector, async tx => {
                const prior = await retained(tx, value, ctx); if (prior) return prior;
                const current = await snapshot(tx, value.selector), old = current.record;
                if (hash(current) !== value.expectedVersion || !equal(value.witness, { bindingSha256: current.bindingSha256, restoreEpoch: current.restoreEpoch })) fail(409);
                if (equal(value.patch, { enabled: old.enabled, validUntil: old.validUntil, agreementRef: old.agreementRef })) fail(409);
                const next = record({ ...old, revision: old.revision + 1, ...value.patch }, value.selector);
                await commitGuard();
                const event = { schemaVersion: 1, category: ACTION, operationId: value.operationId, actorSubjectKey: value.actorSubjectKey,
                    targetSha256: hash(value.selector), commandSha256: value.commandSha256, restoreEpoch: current.restoreEpoch,
                    before: old, after: next, occurredAt: instant(ctx.check()) };
                const receipt = { operationId: value.operationId, commandSha256: value.commandSha256, status: 'succeeded',
                    version: hash(event), occurredAt: event.occurredAt };
                await tx.save(freeze({ record: next, event, receipt })); await commitGuard(); return receipt;
            }, commitGuard);
        });
    }
    return Object.freeze({ inspect, commit, outcome });
}
module.exports = Object.freeze({ createPaidEntitlementAdminBridge });
