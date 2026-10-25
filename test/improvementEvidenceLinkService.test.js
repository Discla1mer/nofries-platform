'use strict';

const { createImprovementEvidenceLinkService, normaliseImprovementEvidenceSelector } =
    require('../api/shared/improvementPlan/improvementEvidenceLinkService');
const { createContext, createClock } = require('./fixtures/ncscAssessmentFixture');
const { SUBJECT } = require('./fixtures/dashboardFixture');
const scope = { tenantId: 'tenant-a', organisationId: 'organisation-a' };
const selector = () => ({ planId: 'plan-a', planRevision: 0, actionId: 'action:a',
    artefactId: 'evidence:a', evidenceVersionId: 'version:0' });
const clone = value => JSON.parse(JSON.stringify(value));
async function harness() {
    const context = await createContext(scope, createClock(), SUBJECT);
    const repository = { resolveImprovementEvidenceLink: jest.fn(async () => Object.freeze({ status: 'unpersisted' })) };
    const requestContext = { resolve: jest.fn(async () => context) };
    return { context, repository, requestContext, service: createImprovementEvidenceLinkService({ repository, requestContext }) };
}

test('selector preserves exact detached Unicode evidence identities and bounded plan revisions', () => {
    const input = { ...selector(), artefactId: '證據'.repeat(90), evidenceVersionId: '😀'.repeat(90), planRevision: 1024 };
    const result = normaliseImprovementEvidenceSelector(input);
    expect(result).toEqual(input); expect(Object.isFrozen(result)).toBe(true);
    input.artefactId = 'changed'; expect(result.artefactId).toBe('證據'.repeat(90));
});

test.each(['tenantId', 'organisationId', 'actorSubjectKey', 'controlId', 'itemId', 'source', 'score', 'confidence', 'verified'])
('rejects caller-supplied %s before authentication or repository access', async key => {
    const h = await harness();
    await expect(h.service.resolve({}, { ...selector(), [key]: 'forged' })).rejects.toMatchObject({ statusCode: 400 });
    expect(h.requestContext.resolve).not.toHaveBeenCalled();
    expect(h.repository.resolveImprovementEvidenceLink).not.toHaveBeenCalled();
});

test('closed selectors reject missing fields, invalid revisions and malformed identifiers', () => {
    const inputs = [null, [], {}, { ...selector(), planId: 'with/slash' }, { ...selector(), actionId: ' ' },
        { ...selector(), artefactId: '\ud800' }, { ...selector(), evidenceVersionId: 'a'.repeat(181) }];
    for (const key of Object.keys(selector())) { const input = selector(); delete input[key]; inputs.push(input); }
    for (const planRevision of [-1, -0, 1025, 1.5, '0', null]) inputs.push({ ...selector(), planRevision });
    for (const input of inputs) expect(() => normaliseImprovementEvidenceSelector(input)).toThrow();
});

test('hostile input hooks never execute', () => {
    let hooks = 0;
    const accessor = selector(); Object.defineProperty(accessor, 'planId', { enumerable: true, get() { hooks++; return 'plan-a'; } });
    const proxy = new Proxy(selector(), { ownKeys() { hooks++; return []; } });
    const toJSON = { ...selector(), toJSON() { hooks++; return selector(); } };
    for (const input of [accessor, proxy, toJSON]) expect(() => normaliseImprovementEvidenceSelector(input)).toThrow();
    expect(hooks).toBe(0);
});

test('service detaches selectors before awaiting the fresh branded request context', async () => {
    const h = await harness(), input = selector(), original = clone(input), request = { tenantId: 'forged' };
    let release;
    h.requestContext.resolve.mockImplementation(() => new Promise(resolve => { release = () => resolve(h.context); }));
    const pending = h.service.resolve(request, input); input.evidenceVersionId = 'changed';
    expect(h.repository.resolveImprovementEvidenceLink).not.toHaveBeenCalled();
    release(); await pending;
    expect(h.requestContext.resolve).toHaveBeenCalledWith(request);
    expect(h.repository.resolveImprovementEvidenceLink).toHaveBeenCalledWith(h.context, original);
    expect(Object.keys(h.service)).toEqual(['resolve']);
});

test('copied contexts and private adapter errors are withheld without retry', async () => {
    const h = await harness(); h.requestContext.resolve.mockResolvedValue(clone(h.context));
    await expect(h.service.resolve({}, selector())).rejects.toMatchObject({ code: 'improvement_evidence_access_denied', statusCode: 403 });
    expect(h.repository.resolveImprovementEvidenceLink).not.toHaveBeenCalled();
    h.requestContext.resolve.mockResolvedValue(h.context);
    h.repository.resolveImprovementEvidenceLink.mockRejectedValue(new Error('secret database locator'));
    let failure; try { await h.service.resolve({}, selector()); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'improvement_evidence_unavailable', statusCode: 503 });
    expect(JSON.stringify(failure)).not.toContain('secret');
    expect(h.repository.resolveImprovementEvidenceLink).toHaveBeenCalledTimes(1);
});

test('configuration requires the fixed resolver and request-context interfaces', async () => {
    const h = await harness();
    for (const options of [{}, { repository: h.repository }, { repository: {}, requestContext: h.requestContext },
        { repository: h.repository, requestContext: h.requestContext, confidence: true }]) {
        expect(() => createImprovementEvidenceLinkService(options)).toThrow();
    }
});
