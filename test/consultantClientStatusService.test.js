'use strict';

const { createConsultantClientStatusService, ConsultantClientStatusError, normaliseConsultantClientStatusPage,
    CLIENT_STATUS_ROUTES } = require('../api/shared/improvementPlan/consultantClientStatusService');

const GENERATION = 'b'.repeat(64), NOW = '2026-11-01T04:00:00.000Z';
const bindingId = n => '62000000-0000-4000-8000-' + String(n).padStart(12, '0');
const denied = () => Object.assign(new Error('denied'), { statusCode: 403 });
const down = () => Object.assign(new Error('down'), { statusCode: 503 });
function assessment(id, status, change = {}) {
    // Mirrors projectNcscSummary, including fields the service must drop.
    return { assessmentId: id, moduleId: 'cyber_security', profileRef: { profileId: 'private-profile' }, status,
        revision: 2, revisionSha256: 'c'.repeat(64), createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-20T00:00:00.000Z', progress: { total: 40, answered: 12, missing: 28, unknown: 0, notApplicableClaims: 0 }, ...change };
}
// clients: [{ label, assessments: [...], plans: ['plan-id'], fail: { assessments, plans } }]
function fixture(clients, options = {}) {
    const calls = [];
    const ports = { generation: GENERATION, clock: jest.fn(() => NOW),
        listBindings: jest.fn(async page => {
            const all = clients.map((row, i) => ({ bindingId: bindingId(i + 1), organisationLabel: row.label }));
            const rest = all.filter(row => page.afterBindingId === null || row.bindingId > page.afterBindingId);
            return { bindings: rest.slice(0, page.limit), nextAfterBindingId: rest.length > page.limit ? rest[page.limit - 1].bindingId : null };
        }),
        assessments: options.assessmentsOff ? null : jest.fn(async (id, page) => {
            calls.push(['assessments', id, page]);
            const client = clients[Number(id.slice(-12)) - 1];
            if (client.fail?.assessments) throw client.fail.assessments();
            const rows = client.assessments.filter(row => page.afterAssessmentId === null || row.assessmentId > page.afterAssessmentId);
            const shown = rows.slice(0, page.limit);
            return { schemaVersion: 1, assessments: shown, nextAfterAssessmentId: rows.length > page.limit ? shown.at(-1).assessmentId : null };
        }),
        plans: jest.fn(async (id, page) => {
            calls.push(['plans', id, page]);
            const client = clients[Number(id.slice(-12)) - 1];
            if (client.fail?.plans) throw client.fail.plans();
            const plans = client.plans || [];
            return { schemaVersion: 1, scope: { tenantId: 'private-tenant', organisationId: 'private-org' }, asOf: NOW,
                plans: plans.slice(0, 1).map(planId => ({ planId, planRevision: 1 })), nextAfterPlanId: plans.length > 1 ? plans[0] : null };
        }),
        finish: jest.fn(async () => { if (options.finishError) throw options.finishError; }),
        assertDisclosure: jest.fn(() => { if (options.disclosureError) throw options.disclosureError; }) };
    return { calls, ports, service: createConsultantClientStatusService(ports) };
}
const read = (h, limit = 10, afterBindingId = null) => h.service.read({ limit, afterBindingId });
const byLabel = result => Object.fromEntries(result.clients.map(row => [row.organisationLabel, row]));

test('reports each client stage from retained records with the matching next action', async () => {
    const h = fixture([
        { label: 'Harbourview Logistics', assessments: [] },
        { label: 'Kauri Dental', assessments: [assessment('a-draft', 'in-progress')] },
        { label: 'Ōtaki Growers', assessments: [assessment('a-sub', 'submitted')] },
        { label: 'Taupō Freight', assessments: [assessment('a-sub', 'submitted')], plans: ['plan-1'] }]);
    const clients = byLabel(await read(h));
    expect(clients['Harbourview Logistics']).toMatchObject({ stage: 'not_started',
        actions: [{ kind: 'start_assessment', route: '#cyber-security' }] });
    expect(clients['Kauri Dental']).toMatchObject({ stage: 'in_progress',
        actions: [{ kind: 'resume_assessment', route: '#cyber-security', assessmentId: 'a-draft' }] });
    expect(clients['Ōtaki Growers']).toMatchObject({ stage: 'results_ready',
        actions: [{ kind: 'review_results', route: '#cyber-security', assessmentId: 'a-sub' }] });
    expect(clients['Taupō Freight']).toMatchObject({ stage: 'plan_ready',
        actions: [{ kind: 'open_plan', route: '#improvement-plan', planId: 'plan-1' }, { kind: 'review_results', assessmentId: 'a-sub' }] });
    expect(Object.values(CLIENT_STATUS_ROUTES).sort()).toEqual(['#cyber-security', '#improvement-plan']);
});

test('saved progress is the server answered/total count, never a computed percentage', async () => {
    const h = fixture([{ label: 'Kauri Dental', assessments: [
        assessment('a-old', 'created', { updatedAt: '2026-09-01T00:00:00.000Z', progress: { total: 40, answered: 0 } }),
        assessment('a-new', 'in-progress', { updatedAt: '2026-10-30T09:15:00.000Z', progress: { total: 40, answered: 31 } })] }]);
    const [row] = (await read(h)).clients;
    expect(row.assessment.latestDraft).toEqual({ assessmentId: 'a-new', status: 'in-progress', revision: 2,
        updatedAt: '2026-10-30T09:15:00.000Z', progress: { answered: 31, total: 40 } });
    expect(row.assessment.draftCount).toBe(2);
    expect(JSON.stringify(row)).not.toMatch(/percent|%|missing|notApplicable/);
});

test('submitted results lead, with newer saved work offered second; private fields never leave', async () => {
    const h = fixture([{ label: 'Ōtaki Growers', assessments: [
        assessment('a-1', 'submitted', { updatedAt: '2026-08-01T00:00:00.000Z' }),
        assessment('a-2', 'submitted', { updatedAt: '2026-10-01T00:00:00.000Z', revision: 5 }),
        assessment('a-3', 'in-progress', { updatedAt: '2026-10-25T00:00:00.000Z' })] }]);
    const result = await read(h), [row] = result.clients;
    expect(row.stage).toBe('results_ready');
    expect(row.actions.map(a => [a.kind, a.assessmentId])).toEqual([['review_results', 'a-2'], ['resume_assessment', 'a-3']]);
    expect(row.assessment.latestSubmitted).toEqual({ assessmentId: 'a-2', revision: 5, updatedAt: '2026-10-01T00:00:00.000Z' });
    expect(JSON.stringify(result)).not.toMatch(/private-|tenantId|organisationId|revisionSha256|profileRef|moduleId/);
    expect(result.asOf).toBe(NOW);
});

test('a denied client discloses nothing and the rest of the page still reports', async () => {
    const h = fixture([{ label: 'Visible Ltd', assessments: [] },
        { label: 'Former Client Ltd', assessments: [], fail: { assessments: denied } },
        { label: 'Plan Denied Ltd', assessments: [], fail: { plans: denied } }]);
    const result = await read(h);
    expect(result.clients.map(row => row.organisationLabel)).toEqual(['Visible Ltd']);
    expect(JSON.stringify(result)).not.toMatch(/Former Client|Plan Denied|62000000-0000-4000-8000-00000000000[23]/);
    expect(result.coverage).toMatchObject({ checkedClients: 1, unavailableClients: 2, complete: true });
});

test('an unavailable plan read is reported as unknown instead of implying no plan', async () => {
    const h = fixture([{ label: 'Ōtaki Growers', assessments: [assessment('a-sub', 'submitted')], fail: { plans: down } },
        { label: 'Kauri Dental', assessments: [], fail: { plans: down } }]);
    const clients = byLabel(await read(h));
    expect(clients['Ōtaki Growers']).toMatchObject({ stage: 'results_ready_plan_unknown', plan: { state: 'unavailable' } });
    expect(clients['Kauri Dental']).toMatchObject({ stage: 'not_started', plan: { state: 'unavailable' } });
});

test('a partial scan names no "latest" record and claims no stage it has not fully seen', async () => {
    // The newest submission sorts last by ID, beyond the three pages read.
    const many = Array.from({ length: 60 }, (_, i) => assessment('a-' + String(i).padStart(3, '0'), 'in-progress'))
        .concat(assessment('z-newest', 'submitted', { updatedAt: '2026-10-31T00:00:00.000Z' }));
    const h = fixture([{ label: 'Large Co', assessments: many }, { label: 'Large Planned Co', assessments: many, plans: ['plan-1'] }]);
    const clients = byLabel(await read(h));
    expect(clients['Large Co']).toMatchObject({ stage: 'assessment_partial',
        actions: [{ kind: 'open_client', route: '#cyber-security' }],
        assessment: { coverage: 'partial', draftCount: 60, submittedCount: 0, latestDraft: null, latestSubmitted: null } });
    expect(clients['Large Planned Co']).toMatchObject({ stage: 'plan_ready',
        actions: [{ kind: 'open_plan', route: '#improvement-plan', planId: 'plan-1' }] });
    expect(clients['Large Planned Co'].actions).toHaveLength(1);
    expect(JSON.stringify(clients)).not.toMatch(/a-0[0-9]{2}|z-newest/);
    expect(h.calls.filter(call => call[0] === 'assessments' && call[1].endsWith('1'))).toHaveLength(3);
});

test('in plans-only mode a failed plan read discloses nothing, because no authority check succeeded', async () => {
    const h = fixture([{ label: 'Checked Ltd', assessments: [], plans: ['plan-1'] },
        { label: 'Plan Outage Ltd', assessments: [], fail: { plans: down } },
        { label: 'Missing Plan Ltd', assessments: [], fail: { plans: () => Object.assign(new Error(), { statusCode: 404 }) } }],
    { assessmentsOff: true });
    const result = await read(h);
    expect(result.clients.map(row => row.organisationLabel)).toEqual(['Checked Ltd']);
    expect(JSON.stringify(result)).not.toMatch(/Plan Outage|Missing Plan|62000000-0000-4000-8000-00000000000[23]/);
    expect(result.coverage).toMatchObject({ checkedClients: 1, unavailableClients: 2 });
});

test('without admitted portfolio assessment reads, status says not checked and offers to open the client', async () => {
    const h = fixture([{ label: 'Kauri Dental', assessments: [] }, { label: 'Taupō Freight', assessments: [], plans: ['plan-9'] }],
        { assessmentsOff: true });
    const result = await read(h), clients = byLabel(result);
    expect(result.coverage.assessmentStatus).toBe('not_checked');
    expect(clients['Kauri Dental']).toMatchObject({ stage: 'assessment_not_checked',
        actions: [{ kind: 'open_client', route: '#cyber-security' }], assessment: { coverage: 'not_checked' } });
    expect(clients['Taupō Freight'].stage).toBe('plan_ready');
});

test('pages the client directory without repeating clients', async () => {
    expect((await read(fixture(Array.from({ length: 12 }, (_, i) => ({ label: 'C' + i, assessments: [] }))))).clients).toHaveLength(10);
    const h = fixture(Array.from({ length: 5 }, (_, i) => ({ label: 'Client ' + (i + 1), assessments: [] })));
    const first = await read(h, 2);
    expect(first.clients).toHaveLength(2); expect(first.coverage.complete).toBe(false);
    const second = await read(h, 2, first.nextAfterBindingId), third = await read(h, 2, second.nextAfterBindingId);
    const labels = [first, second, third].flatMap(page => page.clients.map(row => row.organisationLabel));
    expect(labels).toEqual(['Client 1', 'Client 2', 'Client 3', 'Client 4', 'Client 5']);
    expect(third.nextAfterBindingId).toBeNull();
});

test('unexpected failures, malformed records and failed final authority withhold the whole page', async () => {
    await expect(read(fixture([{ label: 'A', assessments: [], fail: { assessments: () => new Error('boom') } }])))
        .rejects.toMatchObject({ code: 'client_status_unavailable', statusCode: 503 });
    await expect(read(fixture([{ label: 'A', assessments: [assessment('a', 'archived')] }])))
        .rejects.toBeInstanceOf(ConsultantClientStatusError);
    await expect(read(fixture([{ label: 'A', assessments: [assessment('a', 'in-progress', { progress: { total: 3, answered: 4 } })] }])))
        .rejects.toBeInstanceOf(ConsultantClientStatusError);
    const finish = fixture([{ label: 'A', assessments: [] }], { finishError: denied() });
    await expect(read(finish)).rejects.toThrow('denied');
    const disclosure = fixture([{ label: 'A', assessments: [] }], { disclosureError: denied() });
    await expect(read(disclosure)).rejects.toThrow('denied');
    expect(disclosure.ports.finish).toHaveBeenCalledTimes(1);
});

test('rejects malformed paging input and port configuration', () => {
    for (const input of [{ limit: 0, afterBindingId: null }, { limit: 11, afterBindingId: null }, { limit: 5, afterBindingId: 'x' },
        { limit: 5 }, { limit: 5, afterBindingId: null, tenantId: 't' }]) {
        expect(() => normaliseConsultantClientStatusPage(input)).toThrow(ConsultantClientStatusError);
    }
    const ports = fixture([]).ports;
    expect(() => createConsultantClientStatusService({ ...ports, generation: 'short' })).toThrow(ConsultantClientStatusError);
    expect(() => createConsultantClientStatusService({ ...ports, assessments: 'nope' })).toThrow(ConsultantClientStatusError);
    expect(() => createConsultantClientStatusService({ ...ports, extra: () => null })).toThrow(ConsultantClientStatusError);
});
