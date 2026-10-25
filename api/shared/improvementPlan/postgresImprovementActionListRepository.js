'use strict';

const { isProxy } = require('node:util').types;
const { copy, fields, freeze, instant } = require('../appLifecycle/dashboardRuntimeRecords');
const { DashboardPersistenceError, dataStorage } = require('../appLifecycle/postgresDashboardBootstrap');
const { requireImprovementContext } = require('./improvementPlanService');
const { resolveImprovementAccess } = require('./improvementPlanAccess');
const { projectImprovementActionList, ImprovementActionListError } = require('./improvementActionListProjection');
const { normaliseImprovementActionListSelector, normaliseImprovementPlanPage, actionListError } = require('./improvementActionListService');
const store = require('./improvementPlanStore');

// Dormant composition. The host must pair the audit sink with this transaction
// and the genuine request lifetime. No route, schema or default runtime is added.
function createPostgresImprovementActionListRepository(options) {
    let transact, clock, audit;
    try {
        const settings = fields(options, ['database', 'clock', 'audit']);
        fields(settings.audit, ['createEvent', 'writeEvent']);
        if (typeof settings.database?.withTenantTransaction !== 'function' || typeof settings.clock !== 'function' ||
            typeof settings.audit.createEvent !== 'function' || typeof settings.audit.writeEvent !== 'function') throw new Error();
        transact = settings.database.withTenantTransaction.bind(settings.database);
        clock = settings.clock;
        audit = Object.freeze({ createEvent: settings.audit.createEvent.bind(settings.audit),
            writeEvent: settings.audit.writeEvent.bind(settings.audit) });
    } catch { throw new ImprovementActionListError('improvement_list_input_invalid', 400); }
    return Object.freeze({
        async listImprovementPlans(contextInput, input) {
            try {
                const page = normaliseImprovementPlanPage(input), context = requireImprovementContext(contextInput);
                let previous = context.resolvedAt, snapshot;
                const now = () => {
                    const at = instant(clock());
                    if (at < previous) throw new ImprovementActionListError();
                    previous = at; return at;
                };
                const result = await transact(context.scope.tenantId, async tx => {
                    try { snapshot = await dataStorage.loadSnapshotForUpdate(tx, context.scope); }
                    catch (error) {
                        if (error instanceof DashboardPersistenceError && error.statusCode === 404) {
                            throw new ImprovementActionListError('improvement_list_access_denied', 403);
                        }
                        throw error;
                    }
                    resolveImprovementAccess(snapshot, context, 'improvement.read', now());
                    const selected = await tx.query('SELECT tenant_id, organisation_id, plan_id, revision FROM nofries.dashboard_improvement_heads ' +
                        'WHERE tenant_id = $1 AND organisation_id = $2 ' +
                        'AND ($3::text IS NULL OR plan_id COLLATE "C" > $3::text COLLATE "C") ' +
                        'ORDER BY plan_id COLLATE "C" LIMIT $4',
                    [context.scope.tenantId, context.scope.organisationId, page.afterPlanId, page.limit + 1]);
                    if (!selected || typeof selected !== 'object' || isProxy(selected)) throw new ImprovementActionListError();
                    const descriptor = Object.getOwnPropertyDescriptor(selected, 'rows');
                    if (!descriptor || !Object.hasOwn(descriptor, 'value') || isProxy(descriptor.value) ||
                        !Array.isArray(descriptor.value) || descriptor.value.length > page.limit + 1) throw new ImprovementActionListError();
                    const rows = copy(descriptor.value, 32768);
                    let after = page.afterPlanId;
                    const identities = rows.map(row => {
                        fields(row, ['tenant_id', 'organisation_id', 'plan_id', 'revision']);
                        // Validate identity with the same accepted cursor codec;
                        // the bounded head is selection metadata, not history proof.
                        try { normaliseImprovementPlanPage({ limit: 1, afterPlanId: row.plan_id }); }
                        catch { throw new ImprovementActionListError(); }
                        if (row.tenant_id !== context.scope.tenantId || row.organisation_id !== context.scope.organisationId ||
                            row.plan_id === null || !Number.isSafeInteger(row.revision) || row.revision < 0 || row.revision > 1024 ||
                            after !== null && row.plan_id <= after) throw new ImprovementActionListError();
                        after = row.plan_id; return { planId: row.plan_id, planRevision: row.revision };
                    });
                    const plans = identities.slice(0, page.limit), asOf = now();
                    resolveImprovementAccess(snapshot, context, 'improvement.read', asOf);
                    const event = audit.createEvent(context, { action: 'improvement.read', module: 'improvement_plan', result: 'succeeded' });
                    await audit.writeEvent(event);
                    resolveImprovementAccess(snapshot, context, 'improvement.read', now());
                    return freeze({ schemaVersion: 1, scope: context.scope, asOf, plans,
                        nextAfterPlanId: identities.length > page.limit ? plans.at(-1).planId : null });
                });
                resolveImprovementAccess(snapshot, context, 'improvement.read', now());
                return result;
            } catch (error) { throw actionListError(error); }
        },
        async readImprovementActionList(contextInput, input) {
            try {
                const selector = normaliseImprovementActionListSelector(input), context = requireImprovementContext(contextInput);
                let previous = context.resolvedAt;
                const now = () => {
                    const at = instant(clock());
                    if (at < previous) throw new ImprovementActionListError();
                    previous = at; return at;
                };
                let snapshot;
                const result = await transact(context.scope.tenantId, async tx => {
                    try { snapshot = await dataStorage.loadSnapshotForUpdate(tx, context.scope); }
                    catch (error) {
                        if (error instanceof DashboardPersistenceError && error.statusCode === 404) {
                            throw new ImprovementActionListError('improvement_list_access_denied', 403);
                        }
                        throw error;
                    }
                    resolveImprovementAccess(snapshot, context, 'improvement.read', now());
                    const scope = { ...context.scope, planId: selector.planId };
                    const retained = await store.loadHistory(tx, scope, snapshot.tenantAggregate);
                    const asOf = now();
                    resolveImprovementAccess(snapshot, context, 'improvement.read', asOf);
                    if (!retained) throw new ImprovementActionListError('improvement_list_not_found', 404);
                    const result = projectImprovementActionList(retained.state, { scope, asOf, filters: selector.filters });
                    const event = audit.createEvent(context, { action: 'improvement.read', module: 'improvement_plan', result: 'succeeded' });
                    await audit.writeEvent(event);
                    resolveImprovementAccess(snapshot, context, 'improvement.read', now());
                    return result;
                });
                // COMMIT may itself await I/O past the request's access window.
                // Withhold the prepared list if time advanced/failed at settlement.
                resolveImprovementAccess(snapshot, context, 'improvement.read', now());
                return result;
            } catch (error) { throw actionListError(error); }
        }
    });
}
module.exports = Object.freeze({ createPostgresImprovementActionListRepository });
