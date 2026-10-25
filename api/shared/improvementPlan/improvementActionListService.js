'use strict';

const { isProxy } = require('node:util').types;
const { copy, fields, freeze, subject } = require('../appLifecycle/dashboardRuntimeRecords');
const { normaliseImprovementSelector, requireImprovementContext } = require('./improvementPlanService');
const { ImprovementActionListError } = require('./improvementActionListProjection');

function normaliseImprovementActionListSelector(input) {
    try {
        const value = fields(copy(input, 4096), ['planId', 'filters']);
        normaliseImprovementSelector({ planId: value.planId });
        const filters = fields(value.filters, ['status', 'owner', 'overdueOnly']);
        if (!['all', 'open', 'in_progress', 'blocked', 'completed'].includes(filters.status) ||
            typeof filters.overdueOnly !== 'boolean') throw new Error();
        if (!['all', 'unassigned'].includes(filters.owner)) subject(filters.owner);
        return freeze(value);
    } catch { throw new ImprovementActionListError('improvement_list_input_invalid', 400); }
}
function normaliseImprovementPlanPage(input) {
    try {
        const page = fields(copy(input, 4096), ['limit', 'afterPlanId']);
        if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 50) throw new Error();
        if (page.afterPlanId !== null) normaliseImprovementSelector({ planId: page.afterPlanId });
        return freeze(page);
    } catch { throw new ImprovementActionListError('improvement_list_input_invalid', 400); }
}
function actionListError(error) {
    if (isProxy(error)) return new ImprovementActionListError();
    if (error instanceof ImprovementActionListError) return error;
    const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
    if (code === 'improvement_access_denied') {
        return new ImprovementActionListError('improvement_list_access_denied', 403);
    }
    return new ImprovementActionListError();
}
function createImprovementActionListService(adapters) {
    let resolve, read, plans = null;
    try {
        const settings = fields(adapters, ['repository', 'requestContext']);
        if (!settings.repository || isProxy(settings.repository) || typeof settings.repository.readImprovementActionList !== 'function' ||
            typeof settings.requestContext?.resolve !== 'function') throw new Error();
        resolve = settings.requestContext.resolve.bind(settings.requestContext);
        read = settings.repository.readImprovementActionList.bind(settings.repository);
        // Existing list-only repositories remain compatible. This additive port
        // is explicit own data; an accessor cannot fabricate listing authority.
        const listing = Object.getOwnPropertyDescriptor(settings.repository, 'listImprovementPlans');
        if (listing) {
            if (!Object.hasOwn(listing, 'value') || typeof listing.value !== 'function' || isProxy(listing.value)) throw new Error();
            plans = listing.value.bind(settings.repository);
        }
    } catch { throw new ImprovementActionListError('improvement_list_input_invalid', 400); }
    return Object.freeze({
        async plans(request, input) {
            const page = normaliseImprovementPlanPage(input);
            try {
                if (!plans) throw new ImprovementActionListError();
                const context = requireImprovementContext(await resolve(request));
                return await plans(context, page);
            } catch (error) { throw actionListError(error); }
        },
        async list(request, input) {
            const selector = normaliseImprovementActionListSelector(input);
            try {
                const context = requireImprovementContext(await resolve(request));
                return await read(context, selector);
            } catch (error) { throw actionListError(error); }
        }
    });
}
module.exports = Object.freeze({ normaliseImprovementActionListSelector, normaliseImprovementPlanPage,
    actionListError, createImprovementActionListService });
