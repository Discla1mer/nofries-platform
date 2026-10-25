'use strict';
const { normaliseEvidenceMetadataSelector, requireEvidenceContext, projectEvidenceMetadata,
    createEvidenceMetadataService } = require('../api/shared/evidenceMetadataService');
const { createContext, createClock } = require('./fixtures/ncscAssessmentFixture');
const { evidenceFixture, clone, NOW } = require('./fixtures/evidenceMetadataFixture');
const caught = fn => { try { return fn(); } catch (error) { return error; } };
test.each([{}, null, [], { artefactId: '' }, { artefactId: 'x', tenantId: 'other' },
    { artefactId: 'x', organisationId: 'other' }, { artefactId: 'x', actorSubjectKey: 'other' },
    { artefactId: ' x' }, { artefactId: 'x\u0000' }, { artefactId: 'x'.repeat(181) }])
('rejects noncanonical or scope-selecting input %j', value => {
    expect(caught(() => normaliseEvidenceMetadataSelector(value))).toMatchObject({ code: 'evidence_input_invalid', statusCode: 400 });
});
test.each(['getter', 'proxy', 'symbol', 'toJSON'])('rejects hostile %s input without executing its hooks', kind => {
    let calls = 0, value = { artefactId: 'x' };
    if (kind === 'getter') Object.defineProperty(value, 'artefactId', { enumerable: true, get() { calls++; return 'x'; } });
    if (kind === 'proxy') value = new Proxy(value, { ownKeys() { calls++; return []; } });
    if (kind === 'symbol') value[Symbol('scope')] = 'other';
    if (kind === 'toJSON') value.toJSON = () => { calls++; return { artefactId: 'x' }; };
    expect(caught(() => normaliseEvidenceMetadataSelector(value))).toMatchObject({ code: 'evidence_input_invalid' });
    expect(calls).toBe(0);
});
test('accepts canonical Unicode evidence IDs and detaches the selector', () => {
    const input = { artefactId: '界'.repeat(180) }, value = normaliseEvidenceMetadataSelector(input);
    input.artefactId = 'changed'; expect(value.artefactId).toBe('界'.repeat(180)); expect(Object.isFrozen(value)).toBe(true);
});
test('context provenance cannot be replayed by serialising a genuine context', async () => {
    const f = evidenceFixture(), context = await createContext(f.scope, createClock(NOW));
    expect(requireEvidenceContext(context)).toBe(context);
    expect(caught(() => requireEvidenceContext(clone(context)))).toMatchObject({ code: 'evidence_access_denied', statusCode: 403 });
});
test('public metadata is an immutable allowlist retaining explicit unverified quarantine', () => {
    const f = evidenceFixture(), result = projectEvidenceMetadata(f.evidence);
    expect(Object.keys(result).sort()).toEqual(['artefactId', 'revision', 'currentVersionId', 'createdAt', 'updatedAt', 'versions'].sort());
    expect(Object.keys(result.versions[0]).sort()).toEqual(['versionId', 'introducedRevision', 'recordedAt', 'declaredContent', 'classification', 'quarantine'].sort());
    expect(result.versions[0].quarantine).toEqual({ state: 'quarantined', reason: 'content-unverified' });
    expect(JSON.stringify(result)).not.toMatch(/private-|createdBy|recordedBy|tenantId|organisationId|sourceMetadataSha256|policySnapshot|governanceRefs/);
    expect(Object.isFrozen(result.versions[0].declaredContent)).toBe(true);
    expect(result).not.toBe(f.evidence);
});
test('service detaches input before waiting for context and passes only the branded request context', async () => {
    const f = evidenceFixture(), context = await createContext(f.scope, createClock(NOW));
    const repository = { readEvidenceMetadata: jest.fn(async () => ({ schemaVersion: 1, evidence: projectEvidenceMetadata(f.evidence) })) };
    let release; const requestContext = { resolve: jest.fn(() => new Promise(resolve => { release = () => resolve(context); })) };
    const service = createEvidenceMetadataService({ repository, requestContext }), request = {}, input = { artefactId: 'shared:artefact' };
    const pending = service.read(request, input); input.artefactId = 'changed';
    await Promise.resolve(); release(); await pending;
    expect(requestContext.resolve).toHaveBeenCalledWith(request);
    expect(repository.readEvidenceMetadata).toHaveBeenCalledWith(context, { artefactId: 'shared:artefact' });
    expect(Object.keys(service)).toEqual(['read']);
});
test('invalid selector prevents both authentication and repository calls', async () => {
    const requestContext = { resolve: jest.fn() }, repository = { readEvidenceMetadata: jest.fn() };
    const service = createEvidenceMetadataService({ repository, requestContext });
    await expect(service.read({}, { artefactId: 'x', tenantId: 'other' })).rejects.toMatchObject({ code: 'evidence_input_invalid' });
    expect(requestContext.resolve).not.toHaveBeenCalled(); expect(repository.readEvidenceMetadata).not.toHaveBeenCalled();
});

test('literal opaque asterisk remains a selector, never a wildcard query', () => {
    expect(normaliseEvidenceMetadataSelector({ artefactId: '*' })).toEqual({ artefactId: '*' });
});
