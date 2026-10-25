'use strict';
const { createQuestionAssistanceRequest: prepare, validateQuestionAssistanceResponse: validate } = require('../api/shared/questionnaireAssistance');
const { createNcscQuestionnaireMetadata } = require('../api/shared/ncscQuestionnaireMetadata');
const questions = createNcscQuestionnaireMetadata().questions;
const input = () => ({ questionId: questions[0].id, mode: 'suggest', notes: 'We test recovery every month.', sources: [] });
const result = () => ({ explanation: 'Check that this covers all in-scope systems.', optionId: 'partial', rationale: null,
    followUp: ['Which systems are included?'], citations: [{ sourceId: 'notes', quote: 'test recovery every month' }] });
test.each(questions.map(q => [q.id]))('prepares accepted question %s without writes or model authority', id => {
    const request = prepare({ ...input(), questionId: id });
    expect(JSON.parse(request.inputJson).questionId).toBe(id);
    expect(request.instructions).toContain('untrusted data');
    expect(request.inputSha256).toMatch(/^[a-f0-9]{64}$/);
});
test('preserves client input as data and validates exact supporting quotes', () => {
    const request = prepare(input()), proposal = validate(request, JSON.stringify(result()));
    expect(proposal).toMatchObject({ status: 'suggested_not_confirmed', questionId: questions[0].id, optionId: 'partial' });
    expect(proposal.citations[0]).toMatchObject({ sourceId: 'notes', version: 'input' });
    expect(proposal.outputSha256).toMatch(/^[a-f0-9]{64}$/);
});
test('cleared document excerpts retain version and digest', () => {
    const request = prepare({ ...input(), sources: [{ id: 'doc1', version: 'v2', text: 'Backups are reviewed weekly.' }] });
    const proposal = validate(request, JSON.stringify({ ...result(), citations: [{ sourceId: 'doc1', quote: 'reviewed weekly' }] }));
    expect(proposal.citations[0]).toMatchObject({ sourceId: 'doc1', version: 'v2' });
});
test('validated nested provenance cannot change after grounding', () => {
    const proposal = validate(prepare(input()), JSON.stringify(result()));
    const original = JSON.stringify(proposal);
    for (const mutate of [
        () => { proposal.citations[0].quote = 'invented'; },
        () => { proposal.citations[0].sha256 = 'changed'; },
        () => proposal.citations.push({ sourceId: 'other' }),
        () => { proposal.followUp[0] = 'changed'; },
        () => proposal.followUp.push('extra')
    ]) expect(mutate).toThrow(TypeError);
    expect(JSON.stringify(proposal)).toBe(original);
});
test('insufficient information may produce no suggestion', () => {
    expect(validate(prepare(input()), JSON.stringify({ ...result(), optionId: null, citations: [] })).optionId).toBeNull();
});
test('empty context supports question explanation without inventing an answer', () => {
    const request = prepare({ ...input(), notes: '' });
    expect(request.instructions).toContain('If notes and sources are empty');
    expect(validate(request, JSON.stringify({ ...result(), optionId: null, citations: [] })).optionId).toBeNull();
    expect(() => validate(request, JSON.stringify(result()))).toThrow();
});
test('explicit explanation intent is bound to the prompt and provenance despite attached context', () => {
    const context = { ...input(), sources: [{ id: 'doc1', version: 'v2', text: 'Backups are reviewed weekly.' }] };
    const request = prepare({ ...context, mode: 'explain' });
    expect(request.promptVersion).toBe('ncsc-question-assistance-v3');
    expect(JSON.parse(request.inputJson).mode).toBe('explain');
    expect(request.instructions).toContain('If mode is explain');
    expect(request.inputSha256).not.toBe(prepare(context).inputSha256);
    const proposal = validate(request, JSON.stringify({ ...result(), optionId: null, citations: [] }));
    expect(proposal).toMatchObject({ optionId: null, rationale: null, citations: [] });
});
test.each([
    {},
    { citations: [{ sourceId: 'doc1', quote: 'reviewed weekly' }] },
    { optionId: null, citations: [{ sourceId: 'doc1', quote: 'reviewed weekly' }] },
    { optionId: 'not_applicable', rationale: 'The document excludes this process.' }
])('explanation mode rejects source-backed answers or citations %j', delta => {
    const request = prepare({ ...input(), mode: 'explain',
        sources: [{ id: 'doc1', version: 'v2', text: 'Backups are reviewed weekly.' }] });
    expect(() => validate(request, JSON.stringify({ ...result(), ...delta }))).toThrow('questionnaire_assistance_invalid');
});
test.each([
    { optionId: 'certified' }, { score: 100 }, { citations: [] }, { rationale: 'not allowed for partial' },
    { citations: [{ sourceId: 'other-tenant', quote: 'test' }] },
    { citations: [{ sourceId: 'notes', quote: 'made up' }] }, { optionId: 'not_applicable', rationale: '' },
    { explanation: '\ud800' }, { followUp: ['x'.repeat(501)] }
])('rejects malformed or ungrounded model output %j', delta => {
    expect(() => validate(prepare(input()), JSON.stringify({ ...result(), ...delta }))).toThrow('questionnaire_assistance_invalid');
});
test.each([
    { mode: undefined }, { mode: null }, { mode: 'automatic' },
    { questionId: 'unknown' }, { notes: 'x'.repeat(4001) }, { notes: '\ud800' },
    { sources: [{ id: 'notes', version: 'v1', text: 'ambiguous' }, { id: 'notes', version: 'v2', text: 'ambiguous' }] },
    { sources: [{ id: '../escape', version: 'v1', text: 'x' }] },
    { sources: [{ id: 'doc', version: 'v1', text: 'x'.repeat(8001) }] }
])('rejects unbounded or invalid input %j', delta => {
    expect(() => prepare({ ...input(), ...delta })).toThrow('questionnaire_assistance_invalid');
});
test('rejects truncated, oversized and changed request provenance', () => {
    const request = prepare(input());
    for (const raw of ['{', 'x'.repeat(16385)]) expect(() => validate(request, raw)).toThrow();
    expect(() => validate({ ...request, inputSha256: '0'.repeat(64) }, JSON.stringify(result()))).toThrow();
});
