'use strict';

// Composed protected controller evidence. The database contract double below
// accepts SELECTs only; this does not establish PostgreSQL RLS or browser layout.
const picture = require('../api/shared/protectedAssets/organisationPicture');
const questionnaire = require('../api/shared/protectedAssets/ncscQuestionnaire');
const { createClient } = require('../api/shared/protectedAssets/ncscAssessmentClient');
const { createNcscQuestionnaireMetadata } = require('../api/shared/ncscQuestionnaireMetadata');
const { createPostgresDashboardRepository } = require('../api/shared/appLifecycle/postgresDashboardRepository');
const { dataCodec } = require('../api/shared/appLifecycle/postgresDashboardBootstrap');
const { createNcscAssessmentService } = require('../api/shared/ncscAssessmentService');
const { createNcscAssessmentHandlers } = require('../api/shared/ncscAssessmentHandlers');
const store = require('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { ncscFixture, createClock, createContext, createNcscAdapters, createCommand, saveCommand,
    submitCommand, allResponses, clone } = require('./fixtures/ncscAssessmentFixture');
const { createDom } = require('./fixtures/dashboardDom');

const PREFIX = '/api/dashboard/ncsc/assessments';
const metadata = createNcscQuestionnaireMetadata();
afterEach(() => jest.restoreAllMocks());
const pause = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(predicate) {
    const end = Date.now() + 4000;
    while (!predicate() && Date.now() < end) await pause();
    expect(Boolean(predicate())).toBe(true);
}
const button = (ui, label) => ui.root.querySelectorAll('button').find(node => node.textContent === label);
function click(ui, label) { expect(button(ui, label)).toBeDefined(); button(ui, label).click(); }
function event(node, name) {
    expect(node).toBeDefined();
    for (const callback of node.events[name] || []) callback({ target: node, currentTarget: node, preventDefault() {} });
}
function interactiveDom() {
    const dom = createDom(), create = dom.document.createElement;
    dom.document.createElement = tag => {
        const node = create(tag);
        Object.defineProperty(node, 'id', { get: () => node.getAttribute('id') || '', set: value => node.setAttribute('id', value) });
        node.contains = child => child === node || node.children.some(value => value.contains(child));
        node.removeChild = child => { node.children = node.children.filter(value => value !== child); child.parentElement = null; };
        node.setSelectionRange = (start, end) => { node.selectionStart = start; node.selectionEnd = end; };
        if (tag === 'dialog') { node.showModal = () => { node.open = true; }; node.close = () => { node.open = false; }; }
        return node;
    };
    dom.root = dom.document.createElement('div');
    return dom;
}

async function backend(options = {}) {
    const fixture = ncscFixture(options), clock = createClock(), context = await createContext(fixture.scope, clock);
    const adapters = createNcscAdapters(clock), chains = new Map(), queries = [];
    const mutations = jest.fn(() => { throw new Error('Explanation must not mutate business records.'); });
    const provider = jest.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Explanation must not call a provider or public transport.'); });
    let intercept = null, requestScope = context;
    const row = value => ({ tenant_id: value.tenantId, organisation_id: value.organisationId,
        schema_version: 1, revision: value.revision, payload: clone(value),
        ...(value.grantId ? { grant_id: value.grantId } : {}),
        ...(value.assignmentId ? { assignment_id: value.assignmentId, membership_id: value.membershipId,
            subject_key: value.subjectKey, status: value.status } : {}) });
    const authority = {
        dashboard_tenants: [row(fixture.state.tenantAggregate.tenant)],
        dashboard_organisations: fixture.state.tenantAggregate.organisations.map(row),
        dashboard_membership_states: [row(fixture.state.membershipState)],
        dashboard_entitlement_states: [row(fixture.state.entitlementState)],
        dashboard_feature_flags: [row(fixture.state.flags)],
        dashboard_advisor_assignments: fixture.state.advisorAssignments.map(row),
        dashboard_usage: fixture.state.entitlementState.grants.filter(grant => grant.code.startsWith('dashboard_')).map(grant => row(dataCodec.newUsage(grant)))
    };
    function seed(id, responses, settings = {}) {
        const chain = [], commands = [createCommand(id, 'create-' + id), saveCommand(id, 0, 'save-' + id, responses)];
        if (settings.extraSave) commands.push(saveCommand(id, 1, 'second-save-' + id, responses));
        if (settings.submitted !== false) commands.push(submitCommand(id, settings.extraSave ? 2 : 1, 'submit-' + id));
        for (const command of commands)
            chain.push(store.makeVersion(store.stableIntent(context, command), command.idempotencyKey, chain.at(-1) || null,
                fixture.state.tenantAggregate, clock.now()));
        chains.set(id, chain);
    }
    const mixed = require('./fixtures/ncscAcceptedEvaluation.json');
    seed('assessment-a', mixed.input.atomInputs.map(atom => ({ itemId: atom.itemId, optionId: atom.response.optionId,
        rationale: atom.response.optionId === 'not_applicable' ? { text: '<img src=x onerror=alert(1)> Synthetic pending claim.' } : null })));
    seed('assessment-b', allResponses('yes'));
    seed('assessment-c', allResponses('no'), { submitted: false });
    const versionRow = value => ({ ...row(value.envelope), assessment_id: value.envelope.assessmentId,
        payload_sha256: value.revisionSha256, parent_revision: value.parentRevision, parent_sha256: value.parentSha256 });
    const database = { withTenantTransaction: async (tenantId, work) => work({ query: async (sql, args) => {
        queries.push({ sql, args: clone(args), tenantId });
        if (!sql.startsWith('SELECT')) return mutations(sql, args);
        const table = sql.match(/nofries\.(dashboard_\w+)/)?.[1];
        let rows = table === 'dashboard_ncsc_assessments' ? [...chains.values()].map(chain => versionRow(chain.at(-1)))
            : table === 'dashboard_ncsc_assessment_revisions' ? [...chains.values()].flatMap(chain => chain.map(versionRow)) : authority[table];
        if (!rows) throw new Error('Unexpected SELECT contract: ' + sql);
        const where = sql.split(' WHERE ')[1].split(/ ORDER BY | FOR /)[0];
        rows = rows.filter(value => value.tenant_id === tenantId && [...where.matchAll(/(\w+) = \$(\d+)/g)]
            .every(match => value[match[1]] === args[Number(match[2]) - 1]));
        if (where.includes('revision >= $4')) rows = rows.filter(value => value.revision >= args[3]);
        if (where.includes('assessment_id COLLATE "C" > $3') && args[2] !== null) rows = rows.filter(value => value.assessment_id > args[2]);
        const order = sql.match(/ ORDER BY (\w+)/)?.[1];
        if (order) rows.sort((a, b) => a[order] < b[order] ? -1 : a[order] > b[order] ? 1 : 0);
        const limit = sql.match(/ LIMIT (\$\d+|\d+)/)?.[1];
        if (limit) rows = rows.slice(0, limit.startsWith('$') ? args[Number(limit.slice(1)) - 1] : Number(limit));
        return { rows: clone(rows), rowCount: rows.length };
    } }) };
    const repository = createPostgresDashboardRepository({ database, clock: clock.now, authoriseAdministration: () => false,
        ncsc: { audit: adapters.audit, resolveSubmissionQuota: adapters.resolveSubmissionQuota } });
    const guardMutation = jest.fn(() => false);
    const handlers = createNcscAssessmentHandlers({ service: createNcscAssessmentService({ repository,
        requestContext: { resolve: async () => requestScope } }), guardMutation });
    const fetch = jest.fn(async (url, init) => {
        const parsed = new URL(url, 'https://synthetic.invalid');
        const dispatch = async () => {
            const response = await handlers.handleRequest({ method: init.method, query: Object.fromEntries(parsed.searchParams) },
                decodeURIComponent(parsed.pathname.slice(PREFIX.length).replace(/^\//, '')));
            return new Response(JSON.stringify(response.body), { status: response.status, headers: response.headers });
        };
        return intercept ? intercept({ url, init, dispatch }) : dispatch();
    });
    const closed = createClient({ metadata, fetch });
    return { fixture, context, clock, chains, authority, adapters, queries, mutations, provider, guardMutation, fetch,
        client: closed, organisationId: fixture.scope.organisationId,
        intercept: value => { intercept = value; }, scope: value => { requestScope = value; },
        current: id => store.projectNcscDetail(chains.get(id || 'assessment-a').at(-1)),
        replaceReadFixture(kind) {
            // Independently valid synthetic server responses model upstream drift.
            // Replacing a fixture is not a submitted-answer update or a retained
            // successor-history claim; this tree exposes the existing read API.
            seed('assessment-a', allResponses('yes'), { extraSave: kind === 'revision' });
        } };
}
async function overview(h, options = {}) {
    const dom = createDom(), openCyber = jest.fn();
    const controller = picture.mount(dom.root, { metadata, client: h.client, organisationId: h.organisationId,
        initialAssessmentId: 'assessment-a', openCyber, ...options });
    const ui = { ...dom, controller, openCyber };
    await until(() => button(ui, 'Explain this saved result'));
    return ui;
}
const explanation = ui => ui.root.querySelector('.picture-explanation');
const expectReadOnly = h => {
    expect(h.fetch.mock.calls.every(([url, init]) => url.startsWith(PREFIX) && init.method === 'GET' && init.body === undefined)).toBe(true);
    expect(h.queries.every(query => query.sql.startsWith('SELECT'))).toBe(true);
    expect(h.mutations).not.toHaveBeenCalled(); expect(h.guardMutation).not.toHaveBeenCalled(); expect(h.provider).not.toHaveBeenCalled();
};

test.each([{}, { role: 'fractional_advisor', service: true }])('Overview explicitly explains the selected golden result through protected reads and auditing: %j', async access => {
    const h = await backend(access), ui = await overview(h);
    try {
        const initialCalls = h.fetch.mock.calls.length, initialAudits = h.adapters.events.length;
        expect(ui.root.textContent).toContain('46.4%–60.7%');
        expect(explanation(ui).querySelectorAll('[aria-label="Saved explanation"]')).toHaveLength(0);
        await pause(); expect(h.fetch).toHaveBeenCalledTimes(initialCalls);
        click(ui, 'Unresolved answers'); click(ui, 'Saved range');
        expect(h.fetch).toHaveBeenCalledTimes(initialCalls);
        click(ui, 'Explain this saved result');
        await until(() => explanation(ui).querySelector('[aria-label="Saved explanation"]'));
        const section = explanation(ui), current = h.current();
        expect(section.textContent).toContain('46.4%–60.7%');
        for (const value of ['assessment-a', 'revision 2', current.revisionSha256,
            'submission.evaluation.attainment.lowerDisplay', 'submission.evaluation.attainment.upperDisplay', 'metadata.profileRef'])
            expect(section.textContent).toContain(value);
        expect(h.fetch).toHaveBeenCalledTimes(initialCalls + 1);
        expect(h.fetch.mock.calls.at(-1)[0]).toBe(PREFIX + '/assessment-a');
        expect(h.adapters.events).toHaveLength(initialAudits + 1);
        expect(h.adapters.events.at(-1)).toMatchObject({ action: 'assessment.read', module: 'cyber_security', result: 'succeeded' });
        click(ui, 'Unresolved answers');
        expect(section.textContent).toContain('2 unresolved answers, including 1 pending N/A claims');
        expect(section.textContent).toContain('responses[itemId=');
        expect(section.textContent).toContain('.rationale.text');
        expect(section.textContent).toContain('<img src=x onerror=alert(1)> Synthetic pending claim.');
        expect(section.querySelectorAll('img')).toHaveLength(0); expect(section.querySelectorAll('script')).toHaveLength(0);
        click(ui, 'Framework starting actions');
        expect(section.textContent).toContain('guidance.startingActions[');
        expect(section.textContent).toContain('no action, owner or due date has been created');
        const expectedActions = metadata.questions.filter(question => current.responses.find(response => response.itemId === question.id).optionId !== 'yes')
            .flatMap(question => question.guidance.startingActions);
        const headings = section.querySelectorAll('h5');
        const actualActions = headings.filter(heading => heading.textContent === 'Suggested starting action')
            .map(heading => heading.parentElement.children[heading.parentElement.children.indexOf(heading) + 1].textContent);
        expect(actualActions).toEqual(expectedActions);
        expect(h.fetch).toHaveBeenCalledTimes(initialCalls + 1); expect(ui.openCyber).not.toHaveBeenCalled();
        expectReadOnly(h);
        click(ui, 'Clear saved explanation');
        expect(section.querySelector('[aria-label="Saved explanation"]')).toBeNull();
        expect(section.textContent).not.toContain(current.revisionSha256);
    } finally { ui.controller.destroy(); }
});

test.each(['selection', 'refresh', 'destroy'])('Overview %s cancels a pending explanation and ignores its late response', async leave => {
    const h = await backend(), ui = await overview(h), gate = deferred();
    let signal;
    h.intercept(async ({ init, dispatch }) => { signal ||= init.signal; const response = await dispatch(); await gate.promise; return response; });
    try {
        click(ui, 'Explain this saved result'); await until(() => signal);
        const retainedChild = explanation(ui);
        if (leave === 'selection') {
            const picker = ui.root.querySelector('.picture-toolbar').querySelector('select');
            picker.value = 'assessment-b'; event(picker, 'change');
        } else if (leave === 'refresh') click(ui, 'Refresh');
        else ui.controller.destroy();
        expect(signal.aborted).toBe(true); expect(retainedChild.textContent).toBe('');
        h.intercept(null); gate.resolve(); await pause(); await pause();
        expect(retainedChild.textContent).toBe('');
        if (leave !== 'destroy') {
            await until(() => button(ui, 'Explain this saved result'));
            expect(explanation(ui).querySelector('[aria-label="Saved explanation"]')).toBeNull();
            if (leave === 'selection') expect(ui.root.querySelector('.picture-source').textContent).toContain('revision 2');
        }
        expectReadOnly(h);
    } finally { gate.resolve(); ui.controller.destroy(); }
});

test('revoked assessment access clears the owning Overview context through its existing denial path', async () => {
    const h = await backend(), ui = await overview(h), before = h.adapters.events.length;
    try {
        h.authority.dashboard_membership_states[0].payload.memberships[0].status = 'suspended';
        click(ui, 'Explain this saved result');
        await until(() => ui.root.textContent.includes('This organisation picture is unavailable.'));
        expect(explanation(ui)).toBeNull(); expect(ui.root.querySelector('select')).toBeNull();
        expect(ui.root.textContent).not.toContain('46.4%–60.7%');
        expect(ui.root.textContent).not.toContain('Synthetic office and cloud services.');
        expect(h.adapters.events).toHaveLength(before); expectReadOnly(h);
    } finally { ui.controller.destroy(); }
});

test('a fresh tenant scope cannot read the previously selected assessment or release its explanation', async () => {
    const h = await backend(), ui = await overview(h), before = h.adapters.events.length;
    try {
        h.scope(await createContext({ ...h.fixture.scope, tenantId: 'synthetic-other-tenant' }, h.clock));
        click(ui, 'Explain this saved result');
        await until(() => ui.root.textContent.includes('This organisation picture is unavailable.'));
        expect(explanation(ui)).toBeNull(); expect(ui.root.textContent).not.toContain('assessment-a');
        expect(h.adapters.events).toHaveLength(before); expectReadOnly(h);
    } finally { ui.controller.destroy(); }
});

test.each(['revision', 'hash'])('%s drift requires an explicit second read while preserving an ordinary unsaved draft', async kind => {
    const h = await backend(), dom = interactiveDom();
    const editor = questionnaire.mount(dom.root, { metadata, client: h.client, organisationId: h.organisationId,
        initialAssessmentId: 'assessment-c', presentationMode: 'editable', generation: {}, window: dom.window });
    let ui;
    try {
        expect(h.client.update).toBeUndefined(); expect(h.client.history).toBeUndefined();
        await until(() => button(dom, 'Save progress'));
        const picker = dom.root.querySelector('[id="ncsc-question-index"]'); picker.value = '0'; event(picker, 'change');
        const input = dom.root.querySelector('[id="ncsc-answer-' + metadata.questions[0].id + '-not_applicable"]');
        input.checked = true; event(input, 'change');
        const rationale = dom.root.querySelector('[id="ncsc-rationale-' + metadata.questions[0].id + '"]');
        rationale.value = 'Unsaved independent local rationale.'; event(rationale, 'input');
        const draftBefore = dom.root.textContent, savedDraft = clone(h.current('assessment-c'));
        expect(dom.root.textContent).toContain('unsaved');
        ui = await overview(h); const before = h.fetch.mock.calls.length, auditsBefore = h.adapters.events.length;
        const baselineBefore = ui.root.querySelector('.picture-metrics').textContent;
        const sourceBefore = ui.root.querySelector('.picture-source').textContent;
        const original = h.current(); h.replaceReadFixture(kind); const replacement = h.current();
        expect(replacement.revision).toBe(kind === 'revision' ? original.revision + 1 : original.revision);
        expect(replacement.revisionSha256).not.toBe(original.revisionSha256);
        click(ui, 'Explain this saved result');
        await until(() => button(ui, 'Refresh saved explanation'));
        expect(explanation(ui).textContent).toContain('revision or fingerprint changed');
        expect(explanation(ui).querySelector('[aria-label="Saved explanation"]')).toBeNull();
        expect(h.fetch).toHaveBeenCalledTimes(before + 1);
        await pause(); expect(h.fetch).toHaveBeenCalledTimes(before + 1);
        click(ui, 'Refresh saved explanation');
        await until(() => explanation(ui).querySelector('[aria-label="Saved explanation"]'));
        expect(explanation(ui).textContent).toContain('revision ' + replacement.revision);
        expect(explanation(ui).textContent).toContain(replacement.revisionSha256);
        expect(h.fetch.mock.calls.slice(before).map(([url]) => url)).toEqual([PREFIX + '/assessment-a', PREFIX + '/assessment-a']);
        expect(explanation(ui).textContent).toContain('100.0%');
        expect(h.fetch).toHaveBeenCalledTimes(before + 2);
        expect(h.adapters.events).toHaveLength(auditsBefore + 2);
        expect(ui.root.querySelector('.picture-metrics').textContent).toBe(baselineBefore);
        expect(baselineBefore).toContain('46.4%–60.7%');
        expect(ui.root.querySelector('.picture-source').textContent).toBe(sourceBefore);
        const notice = () => explanation(ui).querySelector('[data-explanation-version-notice]');
        expect(notice()).not.toBeNull();
        expect(notice().getAttribute('role')).toBe('status');
        expect(notice().textContent).toContain('Cyber baseline and this explanation show different saved versions');
        expect(notice().textContent).toContain('baseline’s Refresh control to reload it');
        expect(notice().textContent).not.toMatch(/\b(newer|older|latest|earlier)\b/i);
        const noticeBefore = notice().textContent;
        click(ui, 'Unresolved answers'); click(ui, 'Framework starting actions'); click(ui, 'Saved range');
        expect(notice().textContent).toBe(noticeBefore);
        expect(h.fetch).toHaveBeenCalledTimes(before + 2);
        click(ui, 'Reload saved explanation');
        await until(() => explanation(ui).querySelector('[aria-label="Saved explanation"]'));
        expect(notice().textContent).toBe(noticeBefore);
        expect(h.fetch).toHaveBeenCalledTimes(before + 3);
        expect(h.adapters.events).toHaveLength(auditsBefore + 3);
        expect(ui.root.querySelector('.picture-metrics').textContent).toBe(baselineBefore);
        click(ui, 'Refresh');
        await until(() => button(ui, 'Explain this saved result'));
        expect(notice()).toBeNull();
        expect(ui.root.querySelector('.picture-metrics').textContent).toContain('100.0%');
        expect(ui.root.querySelector('.picture-metrics').textContent).not.toContain('46.4%–60.7%');
        expect(h.fetch).toHaveBeenCalledTimes(before + 5);
        expect(h.adapters.events).toHaveLength(auditsBefore + 5);
        click(ui, 'Explain this saved result');
        await until(() => explanation(ui).querySelector('[aria-label="Saved explanation"]'));
        expect(notice()).toBeNull();
        expect(explanation(ui).textContent).toContain('100.0%');
        expect(h.fetch).toHaveBeenCalledTimes(before + 6);
        expect(h.adapters.events).toHaveLength(auditsBefore + 6);
        expect(dom.root.textContent).toBe(draftBefore);
        expect(dom.root.querySelector('[id="ncsc-rationale-' + metadata.questions[0].id + '"]').value).toBe('Unsaved independent local rationale.');
        expect(button(dom, 'Save progress')).toBeDefined(); expect(h.current('assessment-c')).toEqual(savedDraft);
        expect(ui.openCyber).not.toHaveBeenCalled(); expectReadOnly(h);
        ui.controller.destroy();
        expect(dom.root.textContent).toBe(draftBefore); expect(h.current('assessment-c')).toEqual(savedDraft);
    } finally { editor.destroy(); if (ui) ui.controller.destroy(); }
});

test.each(['draft', 'invalid-result'])('Overview offers no explanation for a selected %s', async kind => {
    const h = await backend();
    if (kind === 'draft') h.chains.get('assessment-a').pop();
    else h.intercept(async ({ url, dispatch }) => {
        const response = await dispatch();
        if (!url.endsWith('/assessment-a')) return response;
        const body = await response.json(); body.assessment.submission.evaluation.evidence = null;
        return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
    });
    const dom = createDom(), controller = picture.mount(dom.root, { metadata, client: h.client,
        organisationId: h.organisationId, initialAssessmentId: 'assessment-a' });
    try {
        await until(() => dom.root.textContent.includes(kind === 'draft' ? 'Baseline in progress' : 'unavailable'));
        expect(button(dom, 'Explain this saved result')).toBeUndefined();
        expect(explanation(dom)).toBeNull(); expect(dom.root.querySelector('.picture-metrics')).toBeNull(); expectReadOnly(h);
    } finally { controller.destroy(); }
});
