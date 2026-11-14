'use strict';

const { fields, freeze, instant } = require('../appLifecycle/dashboardRuntimeRecords');
const { DashboardPersistenceError, dataStorage } = require('../appLifecycle/postgresDashboardBootstrap');
const { resolveNcscAccess } = require('../appLifecycle/dashboardResourceAuthority');
const { applyImprovementActionCommand, ImprovementPlanError } = require('./improvementPlanDomain');
const { ImprovementPlanServiceError, normaliseImprovementCommand, normaliseImprovementSelector,
    requireImprovementContext, serviceError } = require('./improvementPlanService');
const { resolveImprovementAccess, resolveEligibleOwner } = require('./improvementPlanAccess');
const store = require('./improvementPlanStore');
const { planCarryForward, carryOperationId, applyCarriedSteps } = require('./improvementPlanCarryForward');
const fail = (code = 'improvement_unavailable', status = 503) => { throw new ImprovementPlanServiceError(code, status); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Audit omission preserves the historical raw repository contract for existing
// readers/fixtures. The integrated source always supplies audit; its host must
// pair that sink with this exact transaction. No old audit is backfilled.
function createPostgresImprovementPlanRepository(options) {
    let database, clock, audit = null;
    try {
        const withAudit = Object.prototype.hasOwnProperty.call(options, 'audit');
        const settings = fields(options, withAudit ? ['database', 'clock', 'audit'] : ['database', 'clock']);
        ({ database, clock } = settings);
        if (typeof database?.withTenantTransaction !== 'function' || typeof clock !== 'function') fail();
        if (withAudit) {
            const sink = fields(settings.audit, ['createEvent', 'writeEvent']);
            if (typeof sink.createEvent !== 'function' || typeof sink.writeEvent !== 'function') fail();
            audit = Object.freeze({ createEvent: sink.createEvent.bind(sink), writeEvent: sink.writeEvent.bind(sink) });
        }
    } catch { fail('improvement_input_invalid', 400); }
    function timer(context) {
        let previous = context.resolvedAt;
        return () => {
            const at = instant(clock());
            if (at < previous) fail();
            previous = at; return at;
        };
    }
    async function snapshot(tx, context) {
        try { return await dataStorage.loadSnapshotForUpdate(tx, context.scope); }
        catch (error) {
            if (error instanceof DashboardPersistenceError && error.statusCode === 404) fail('improvement_access_denied', 403);
            throw error;
        }
    }
    function access(snapshot, context, permission, at, generate = false) {
        resolveImprovementAccess(snapshot, context, permission, at);
        if (generate) {
            try { resolveNcscAccess(snapshot, context, 'assessment.read', at); }
            catch { fail('improvement_access_denied', 403); }
        }
    }
    async function auditCommand(context, executionAt, now) {
        try {
            const event = audit.createEvent(context, { action: 'improvement.write', module: 'improvement_plan', result: 'succeeded' });
            fields(event, ['schemaVersion', 'eventType', 'eventId', 'requestId', 'actorSubjectKey',
                'tenantId', 'organisationId', 'action', 'module', 'result', 'occurredAt']);
            if (!Object.isFrozen(event) || event.schemaVersion !== 1 || event.eventType !== 'dashboard.operation' ||
                typeof event.eventId !== 'string' || !UUID.test(event.eventId) || event.requestId !== context.requestId ||
                event.actorSubjectKey !== context.identity.subjectKey || event.tenantId !== context.scope.tenantId ||
                event.organisationId !== context.scope.organisationId || event.action !== 'improvement.write' ||
                event.module !== 'improvement_plan' || event.result !== 'succeeded') fail();
            const occurredAt = instant(event.occurredAt);
            if (occurredAt < executionAt || occurredAt > now()) fail();
            const receipt = await audit.writeEvent(event);
            fields(receipt, ['eventId', 'delivery']);
            if (!Object.isFrozen(receipt) || receipt.eventId !== event.eventId || receipt.delivery !== 'acknowledged') fail();
        } catch {
            // A sink failure must not impersonate a database COMMIT failure and
            // cause reconciliation or a second application/audit attempt.
            fail();
        }
    }
    // Reassessment: re-apply owners, due dates and open-work status from the
    // organisation's previous plan as ordinary appended commands by the current
    // writer, in this transaction. Old plans are only read. Generate still
    // returns its own revision 0, so a replay returns the same result.
    async function carryForward(tx, scope, current, context, initial, generated, source, at, owners) {
        const previousId = await store.previousPlanId(tx, scope, source);
        if (!previousId) return [];
        let previous;
        try { previous = await store.loadHistory(tx, { ...context.scope, planId: previousId }, current.tenantAggregate); }
        catch (error) {
            // A previous plan that no longer validates must not block every
            // later plan: start fresh. Database errors still abort.
            if (!(error instanceof ImprovementPlanServiceError || error instanceof ImprovementPlanError)) throw error;
            try { console.warn('[improvement-plan] carry_forward_source_invalid'); } catch (_) { /* No logging authority. */ }
            return [];
        }
        if (!previous) return [];
        const records = [];
        let state = initial, head = generated;
        for (const action of planCarryForward(previous.result.plan, generated.result.plan)) {
            if (action.ownerSubjectKey) {
                try { resolveEligibleOwner(current, context, action.ownerSubjectKey, at); } catch { continue; }
            }
            // Per action: a rejected start/block keeps the assign; a rejected
            // assign carries nothing. Database errors still abort.
            const carried = applyCarriedSteps(action.steps, state, head, (step, from, last) => {
                const intent = store.stableIntent(context, normaliseImprovementCommand({ planId: scope.planId, type: step.type,
                    operationId: carryOperationId(previous.payloadSha256, last.revision + 1), expectedRevision: last.revision,
                    actionId: action.actionId, payload: step.payload }));
                const domain = store.domainCommand(intent, at, from.source.evaluationOutputSha256);
                const next = applyImprovementActionCommand(from, domain, { ...context.scope, actorSubjectKey: context.identity.subjectKey,
                    eligibleOwnerSubjectKeys: action.ownerSubjectKey ? [action.ownerSubjectKey] : [] });
                return { state: next, record: store.makeRecord(intent, at, source, last.payloadSha256, next, domain) };
            }, error => error instanceof ImprovementPlanError || error instanceof ImprovementPlanServiceError);
            if (!carried) continue;
            records.push(...carried.records); ({ state, head } = carried);
            if (action.ownerSubjectKey) owners.push(action.ownerSubjectKey);
        }
        return records;
    }
    return Object.freeze({
        async readImprovementPlan(contextInput, input) {
            try {
                const context = requireImprovementContext(contextInput), selector = normaliseImprovementSelector(input), now = timer(context);
                return await database.withTenantTransaction(context.scope.tenantId, async tx => {
                    const current = await snapshot(tx, context);
                    access(current, context, 'improvement.read', now());
                    const retained = await store.loadHistory(tx, { ...context.scope, ...selector }, current.tenantAggregate);
                    access(current, context, 'improvement.read', now());
                    if (!retained) fail('improvement_not_found', 404);
                    return freeze({ ...retained.result, sourceRevision: retained.source, history: retained.history });
                });
            } catch (error) { throw serviceError(error); }
        },
        async executeImprovementPlan(contextInput, input) {
            let context, command, intent, now;
            try {
                context = requireImprovementContext(contextInput); command = normaliseImprovementCommand(input);
                intent = store.stableIntent(context, command); now = timer(context);
            } catch (error) { throw serviceError(error); }
            const attempt = async reconcile => {
                let current, owner = null, ownerRequired = false;
                const carriedOwners = [];
                const generate = command.type === 'generate';
                const result = await database.withTenantTransaction(context.scope.tenantId, async tx => {
                    current = await snapshot(tx, context);
                    access(current, context, 'improvement.write', now(), generate);
                    const scope = { ...context.scope, planId: command.planId };
                    const retained = await store.loadHistory(tx, scope, current.tenantAggregate, command.operationId);
                    access(current, context, 'improvement.write', now(), generate);
                    if (retained?.replay) {
                        if (!store.same(retained.replay.intent, intent)) fail('improvement_operation_conflict', 409);
                        return retained.replay.result;
                    }
                    if (reconcile) fail('improvement_outcome_ambiguous', 503);
                    if (generate && retained) fail('improvement_state_conflict', 409);
                    if (!generate && !retained) fail('improvement_not_found', 404);
                    if (!generate && command.expectedRevision !== retained.revision) fail('improvement_revision_conflict', 409);
                    const source = generate ? store.sourceOf(command) : retained.source;
                    const evaluatorInput = generate ? await store.readSource(tx, scope, source, current.tenantAggregate) : null;
                    const at = now();
                    access(current, context, 'improvement.write', at, generate);
                    let state, domainCommand = null;
                    if (generate) state = store.seed(intent, at, evaluatorInput);
                    else {
                        const target = command.type === 'assign' ? command.payload :
                            retained.result.plan.actions.find(action => action.actionId === command.actionId);
                        owner = target?.ownerSubjectKey;
                        // Free-text owner labels have no membership to check.
                        ownerRequired = ['assign', 'start', 'complete'].includes(command.type) && !Object.hasOwn(target || {}, 'ownerLabel');
                        if (ownerRequired) resolveEligibleOwner(current, context, owner, at);
                        domainCommand = store.domainCommand(intent, at, retained.state.source.evaluationOutputSha256);
                        try {
                            state = applyImprovementActionCommand(retained.state, domainCommand, { ...context.scope,
                                actorSubjectKey: context.identity.subjectKey, eligibleOwnerSubjectKeys: ownerRequired ? [owner] : [] });
                        } catch (error) {
                            if (error instanceof ImprovementPlanError) throw new ImprovementPlanServiceError(error.code, error.statusCode);
                            throw error;
                        }
                    }
                    const record = store.makeRecord(intent, at, source, retained?.payloadSha256 ?? null, state, domainCommand);
                    access(current, context, 'improvement.write', now(), generate);
                    await store.append(tx, scope, record);
                    if (generate) {
                        for (const carried of await carryForward(tx, scope, current, context, state, record, source, at, carriedOwners)) await store.append(tx, scope, carried);
                    }
                    if (audit) await auditCommand(context, at, now);
                    const finalAt = now();
                    access(current, context, 'improvement.write', finalAt, generate);
                    if (ownerRequired) resolveEligibleOwner(current, context, owner, finalAt);
                    carriedOwners.forEach(key => resolveEligibleOwner(current, context, key, finalAt));
                    return record.result;
                }, at => {
                    // A paired native host samples these source-specific facts
                    // again after its own awaited final checks and immediately
                    // before COMMIT. Historical unpaired adapters may ignore
                    // this optional port; they retain their prior guarantees.
                    const checkedAt = instant(at);
                    access(current, context, 'improvement.write', checkedAt, generate);
                    // Replayed commands deliberately require the current writer,
                    // not renewed eligibility for an originally selected owner.
                    if (ownerRequired) resolveEligibleOwner(current, context, owner, checkedAt);
                    carriedOwners.forEach(key => resolveEligibleOwner(current, context, key, checkedAt));
                });
                // Settlement may outlive the request's authority. Withholding
                // disclosure here does not undo a committed revision and audit.
                // Replays retain their original owner policy: only the current
                // writer must still be authorised to receive the saved result.
                if (audit) access(current, context, 'improvement.write', now(), generate);
                return result;
            };
            try { return await attempt(false); }
            catch (error) {
                if (!['postgres_commit_failed', 'postgres_rollback_failed'].includes(error.code)) throw serviceError(error);
                // Recovery reads only: never repeat an uncertain write. A matching
                // committed revision is the receipt, reconstructed and validated.
                try { return await attempt(true); }
                catch (recovery) {
                    if (recovery instanceof ImprovementPlanServiceError && recovery.code === 'improvement_access_denied') throw recovery;
                    throw new ImprovementPlanServiceError('improvement_outcome_ambiguous', 503);
                }
            }
        }
    });
}
module.exports = Object.freeze({ createPostgresImprovementPlanRepository });
