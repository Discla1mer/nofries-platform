'use strict';

const { isProxy } = require('node:util').types;
const { fields, freeze, instant } = require('../appLifecycle/dashboardRuntimeRecords');
const { DashboardPersistenceError, dataStorage } = require('../appLifecycle/postgresDashboardBootstrap');
const { getImprovementPlanView } = require('./improvementPlanDomain');
const { ImprovementActionListError } = require('./improvementActionListProjection');
const { ImprovementPlanServiceError, normaliseImprovementSelector, requireImprovementContext } = require('./improvementPlanService');
const { resolveImprovementAccess, resolveEligibleOwner } = require('./improvementPlanAccess');
const store = require('./improvementPlanStore');

const fail = (code = 'improvement_unavailable', status = 503) => { throw new ImprovementPlanServiceError(code, status); };
function editorError(error) {
    return !isProxy(error) && (error instanceof ImprovementPlanServiceError || error instanceof ImprovementActionListError)
        ? error : new ImprovementPlanServiceError();
}
function method(port, name) {
    if (!port || typeof port !== 'object' || isProxy(port)) throw new Error();
    const descriptor = Object.getOwnPropertyDescriptor(port, name);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function' || isProxy(descriptor.value)) throw new Error();
    return descriptor.value.bind(port);
}

// Current editor metadata is read from the same locked authority and validated
// retained history as commands. It grants nothing: execute rechecks every fact.
function createImprovementActionEditorSource(options) {
    let transact, clock, resolve, audit;
    try {
        const settings = fields(options, ['database', 'clock', 'audit', 'requestContext']);
        fields(settings.audit, ['createEvent', 'writeEvent']);
        if (typeof settings.clock !== 'function' || isProxy(settings.clock)) throw new Error();
        transact = method(settings.database, 'withTenantTransaction');
        clock = settings.clock;
        resolve = method(settings.requestContext, 'resolve');
        audit = Object.freeze({ createEvent: method(settings.audit, 'createEvent'), writeEvent: method(settings.audit, 'writeEvent') });
    } catch { fail('improvement_input_invalid', 400); }
    return Object.freeze({
        async editor(request, input) {
            // Capture the closed selector before resolving the genuine request.
            const selector = normaliseImprovementSelector(input);
            try {
                const context = requireImprovementContext(await resolve(request));
                let previous = context.resolvedAt, snapshot, canWrite = false;
                const advertisedOwners = new Set();
                const now = () => {
                    const at = instant(clock());
                    if (at < previous) fail();
                    previous = at; return at;
                };
                const assertCurrentAt = suppliedAt => {
                    const at = instant(suppliedAt);
                    if (at < previous) fail();
                    previous = at;
                    resolveImprovementAccess(snapshot, context, 'improvement.read', at);
                    // A read-only result may remain read-only. An advertised
                    // writer or owner must retain that exact authority window.
                    if (canWrite) resolveImprovementAccess(snapshot, context, 'improvement.write', at);
                    for (const owner of advertisedOwners) resolveEligibleOwner(snapshot, context, owner, at);
                };
                const result = await transact(context.scope.tenantId, async tx => {
                    try { snapshot = await dataStorage.loadSnapshotForUpdate(tx, context.scope); }
                    catch (error) {
                        if (error instanceof DashboardPersistenceError && error.statusCode === 404) fail('improvement_access_denied', 403);
                        throw error;
                    }
                    resolveImprovementAccess(snapshot, context, 'improvement.read', now());
                    const scope = { ...context.scope, planId: selector.planId };
                    const retained = await store.loadHistory(tx, scope, snapshot.tenantAggregate);
                    const asOf = now();
                    resolveImprovementAccess(snapshot, context, 'improvement.read', asOf);
                    if (!retained) fail('improvement_not_found', 404);
                    const plan = getImprovementPlanView(retained.state);
                    if (plan.tenantId !== scope.tenantId || plan.organisationId !== scope.organisationId || plan.planId !== scope.planId ||
                        plan.revision !== retained.revision || plan.updatedAt > asOf) fail();
                    try { resolveImprovementAccess(snapshot, context, 'improvement.write', asOf); canWrite = true; }
                    catch (error) {
                        if (isProxy(error) || !(error instanceof ImprovementPlanServiceError) || error.code !== 'improvement_access_denied') throw error;
                    }
                    const eligibility = new Map();
                    const eligible = owner => {
                        if (!eligibility.has(owner)) {
                            try { resolveEligibleOwner(snapshot, context, owner, asOf); eligibility.set(owner, true); }
                            catch (error) {
                                if (isProxy(error) || !(error instanceof ImprovementPlanServiceError) || error.code !== 'improvement_owner_ineligible') throw error;
                                eligibility.set(owner, false);
                            }
                        }
                        return eligibility.get(owner);
                    };
                    const self = context.identity.subjectKey, selfEligible = canWrite && eligible(self);
                    const ownerChoices = selfEligible ? [{ subjectKey: self, label: 'Assign to me' }] : [];
                    if (selfEligible) advertisedOwners.add(self);
                    const actions = plan.actions.map(action => {
                        const commands = [];
                        if (canWrite && plan.revision < 1024) {
                            if (action.status !== 'completed' && selfEligible) commands.push('assign');
                            const ownerRequired = action.dueDate !== null && action.ownerSubjectKey !== null &&
                                ['open', 'blocked', 'in_progress'].includes(action.status);
                            const ownerEligible = ownerRequired && eligible(action.ownerSubjectKey);
                            if (['open', 'blocked'].includes(action.status) && ownerEligible) commands.push('start');
                            if (action.status === 'in_progress') commands.push('block');
                            if (['in_progress', 'blocked'].includes(action.status) && ownerEligible) commands.push('complete');
                            if (action.status === 'completed') commands.push('reopen');
                            if (ownerEligible && commands.some(command => command === 'start' || command === 'complete')) {
                                advertisedOwners.add(action.ownerSubjectKey);
                            }
                        }
                        return { actionId: action.actionId, commands };
                    });
                    const output = freeze({ schemaVersion: 1, scope, planRevision: plan.revision, asOf, canWrite, ownerChoices, actions });
                    assertCurrentAt(now());
                    const event = audit.createEvent(context, { action: 'improvement.read', module: 'improvement_plan', result: 'succeeded' });
                    await audit.writeEvent(event);
                    assertCurrentAt(now());
                    return output;
                }, assertCurrentAt);
                // A successful COMMIT can settle after the advertised authority
                // expires. Withhold disclosure without retrying the read/audit.
                assertCurrentAt(now());
                return result;
            } catch (error) { throw editorError(error); }
        }
    });
}
module.exports = Object.freeze({ createImprovementActionEditorSource });
