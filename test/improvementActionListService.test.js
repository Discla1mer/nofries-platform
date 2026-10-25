'use strict';

const { createImprovementActionListService, normaliseImprovementActionListSelector, normaliseImprovementPlanPage } =
    require('../api/shared/improvementPlan/improvementActionListService');
const { createContext, createClock } = require('./fixtures/ncscAssessmentFixture');
const clone = value => JSON.parse(JSON.stringify(value));
const selector = () => ({ planId: 'plan-a', filters: { status: 'all', owner: 'all', overdueOnly: false } });
async function harness() {
    const context = await createContext({ tenantId: 'tenant-a', organisationId: 'organisation-a' }, createClock());
    const repository = { readImprovementActionList: jest.fn(async () => Object.freeze({ planRevision: 3 })) };
    const requestContext = { resolve: jest.fn(async () => context) };
    return { context, repository, requestContext, service: createImprovementActionListService({ repository, requestContext }) };
}

test('closed list selectors preserve exact filters and detach nested input', () => {
    const input = selector(), normalized = normaliseImprovementActionListSelector(input);
    expect(normalized).toEqual(input); expect(Object.isFrozen(normalized.filters)).toBe(true);
    input.filters.status = 'completed'; expect(normalized.filters.status).toBe('all');
    for (const owner of ['all', 'unassigned', '10000000-0000-4000-8000-000000000000:10000000-0000-4000-8000-000000000001']) {
        expect(normaliseImprovementActionListSelector({ ...selector(), filters: { ...selector().filters, owner } }).filters.owner).toBe(owner);
    }
});

test.each(['tenantId', 'organisationId', 'actorSubjectKey', 'asOf', 'now', 'source', 'priority', 'assessmentResult'])
('rejects client-owned %s before authentication or data access', async field => {
    const h = await harness();
    await expect(h.service.list({}, { ...selector(), [field]: 'forged' })).rejects.toMatchObject({ statusCode: 400 });
    expect(h.requestContext.resolve).not.toHaveBeenCalled(); expect(h.repository.readImprovementActionList).not.toHaveBeenCalled();
});

test('invalid/missing filters and accessors never reach the authentication boundary', async () => {
    const h = await harness(), inputs = [null, [], {}, { planId: 'plan-a' }, { ...selector(), planId: 'foreign/path' }];
    for (const [field, value] of [['status', 'ranked'], ['owner', 'display name'], ['overdueOnly', 1], ['asOf', 'forged']]) {
        inputs.push({ ...selector(), filters: { ...selector().filters, [field]: value } });
    }
    for (const field of Object.keys(selector().filters)) {
        const input = selector(); delete input.filters[field]; inputs.push(input);
    }
    let hooks = 0;
    const accessor = selector(); Object.defineProperty(accessor.filters, 'owner', { enumerable: true, get() { hooks++; return 'all'; } });
    inputs.push(accessor, new Proxy(selector(), { ownKeys() { hooks++; return []; } }));
    for (const input of inputs) await expect(h.service.list({}, input)).rejects.toMatchObject({ statusCode: 400 });
    expect(hooks).toBe(0); expect(h.requestContext.resolve).not.toHaveBeenCalled();
});

test('selector is captured before awaiting a genuine fresh context', async () => {
    const h = await harness(), input = selector(), before = clone(input), request = { scope: 'ignored' };
    let release;
    h.requestContext.resolve.mockImplementation(() => new Promise(resolve => { release = () => resolve(h.context); }));
    const pending = h.service.list(request, input); input.filters.owner = 'unassigned';
    expect(h.repository.readImprovementActionList).not.toHaveBeenCalled();
    release(); await expect(pending).resolves.toEqual({ planRevision: 3 });
    expect(h.requestContext.resolve).toHaveBeenCalledWith(request);
    expect(h.repository.readImprovementActionList).toHaveBeenCalledWith(h.context, before);
    expect(Object.keys(h.service)).toEqual(['plans', 'list']);
});

test('copied contexts fail closed, and unknown private errors are sanitized without retry', async () => {
    const h = await harness(); h.requestContext.resolve.mockResolvedValue(clone(h.context));
    await expect(h.service.list({}, selector())).rejects.toMatchObject({ code: 'improvement_list_access_denied', statusCode: 403 });
    expect(h.repository.readImprovementActionList).not.toHaveBeenCalled();
    h.requestContext.resolve.mockResolvedValue(h.context);
    h.repository.readImprovementActionList.mockRejectedValue(new Error('private database detail'));
    let failure; try { await h.service.list({}, selector()); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'improvement_list_unavailable', statusCode: 503 });
    expect(JSON.stringify(failure)).not.toContain('private'); expect(h.repository.readImprovementActionList).toHaveBeenCalledTimes(1);
});

test('fixed constructor ports reject missing and extra interfaces', async () => {
    const h = await harness();
    for (const options of [{}, { repository: h.repository }, { repository: {}, requestContext: h.requestContext },
        { repository: h.repository, requestContext: h.requestContext, bypass: true }]) {
        expect(() => createImprovementActionListService(options)).toThrow();
    }
});

test('closed plan-page codec requires a bounded numeric size and exact ASCII cursor', () => {
    for (const afterPlanId of [null, 'a', 'A._:-9', 'z'.repeat(120)]) {
        const input = { limit: 50, afterPlanId }, page = normaliseImprovementPlanPage(input);
        expect(page).toEqual(input); expect(Object.isFrozen(page)).toBe(true);
        input.afterPlanId = 'changed'; expect(page.afterPlanId).toBe(afterPlanId);
    }
});
test.each([undefined, null, {}, { limit: 20 }, { afterPlanId: null }, { limit: '20', afterPlanId: null },
    { limit: 0, afterPlanId: null }, { limit: 51, afterPlanId: null }, { limit: 1.5, afterPlanId: null },
    { limit: 20, afterPlanId: '' }, { limit: 20, afterPlanId: 'non/ascii' }, { limit: 20, afterPlanId: 'é' },
    { limit: 20, afterPlanId: 'a'.repeat(121) }, { limit: 20, afterPlanId: null, tenantId: 'foreign' }])
('rejects malformed plan page %p before context or data work', async page => {
    const h = await harness();
    await expect(h.service.plans({}, page)).rejects.toMatchObject({ code: 'improvement_list_input_invalid', statusCode: 400 });
    expect(h.requestContext.resolve).not.toHaveBeenCalled();
});
test('plan-page input accessors and proxies are rejected without invoking hooks', async () => {
    const h = await harness(), hook = jest.fn(), accessor = { limit: 20 };
    Object.defineProperty(accessor, 'afterPlanId', { enumerable: true, get: hook });
    for (const input of [accessor, new Proxy({ limit: 20, afterPlanId: null }, { ownKeys: hook })]) {
        await expect(h.service.plans({}, input)).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(hook).not.toHaveBeenCalled(); expect(h.requestContext.resolve).not.toHaveBeenCalled();
});
test('plans uses one genuine paired context and captures its page before authentication awaits', async () => {
    const h = await harness(), listImprovementPlans = jest.fn(async () => Object.freeze({ plans: [] }));
    const service = createImprovementActionListService({ repository: { ...h.repository, listImprovementPlans }, requestContext: h.requestContext });
    const page = { limit: 2, afterPlanId: 'plan-a' }, request = {};
    let release;
    h.requestContext.resolve.mockImplementation(() => new Promise(resolve => { release = () => resolve(h.context); }));
    const pending = service.plans(request, page); page.limit = 50; page.afterPlanId = 'foreign';
    release(); await expect(pending).resolves.toEqual({ plans: [] });
    expect(listImprovementPlans).toHaveBeenCalledTimes(1);
    expect(listImprovementPlans).toHaveBeenCalledWith(h.context, { limit: 2, afterPlanId: 'plan-a' });
    expect(h.requestContext.resolve).toHaveBeenCalledWith(request);
    expect(h.repository.readImprovementActionList).not.toHaveBeenCalled();
});
test('legacy list-only services remain usable and only plans is unavailable', async () => {
    const h = await harness();
    await expect(h.service.plans({}, { limit: 20, afterPlanId: null })).rejects.toMatchObject({ code: 'improvement_list_unavailable', statusCode: 503 });
    expect(h.requestContext.resolve).not.toHaveBeenCalled();
    await expect(h.service.list({}, selector())).resolves.toEqual({ planRevision: 3 });
});
test('plans rejects copied contexts and sanitizes hostile failures without retry or getters', async () => {
    const h = await harness(), listImprovementPlans = jest.fn();
    const service = createImprovementActionListService({ repository: { ...h.repository, listImprovementPlans }, requestContext: h.requestContext });
    h.requestContext.resolve.mockResolvedValue(clone(h.context));
    await expect(service.plans({}, { limit: 20, afterPlanId: null })).rejects.toMatchObject({ statusCode: 403 });
    expect(listImprovementPlans).not.toHaveBeenCalled();
    h.requestContext.resolve.mockResolvedValue(h.context);
    const failure = {}, getter = jest.fn(); Object.defineProperty(failure, 'code', { get: getter });
    listImprovementPlans.mockRejectedValue(failure);
    await expect(service.plans({}, { limit: 20, afterPlanId: null })).rejects.toMatchObject({ code: 'improvement_list_unavailable', statusCode: 503 });
    expect(listImprovementPlans).toHaveBeenCalledTimes(1); expect(getter).not.toHaveBeenCalled();
});
test('the optional plans repository port cannot be supplied by an accessor', async () => {
    const h = await harness(), repository = { ...h.repository }, getter = jest.fn();
    Object.defineProperty(repository, 'listImprovementPlans', { enumerable: true, get: getter });
    expect(() => createImprovementActionListService({ repository, requestContext: h.requestContext })).toThrow();
    expect(getter).not.toHaveBeenCalled();
});
