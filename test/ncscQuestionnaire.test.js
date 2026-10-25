'use strict';

// Structural/controller evidence only. This is not a browser or a SQL engine.
const { createNcscQuestionnaireMetadata } = require('../api/shared/ncscQuestionnaireMetadata');
const clientModule = require('../api/shared/protectedAssets/ncscAssessmentClient');
const { createAcceptedNcscFrameworkProfile } = require('../api/shared/assessmentEngine/ncscAcceptedFrameworkProfile');
const { ACCEPTED_PROFILE_REF } = require('../api/shared/assessmentEngine/ncscAssessmentEvaluator');
const { createNcscAssessmentHandlers } = require('../api/shared/ncscAssessmentHandlers');
const { createNcscAssessmentService, normaliseNcscCommand, projectNcscDetail, projectNcscSummary,
    NcscAssessmentError } = require('../api/shared/ncscAssessmentService');
const { makeVersion, stableIntent } = require('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { ncscFixture, createClock, createContext, allResponses, createCommand, saveCommand,
    submitCommand, clone } = require('./fixtures/ncscAssessmentFixture');
const { createDom } = require('./fixtures/dashboardDom');

const PREFIX = '/api/dashboard/ncsc/assessments';
const metadata = () => createNcscQuestionnaireMetadata();
const pause = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const reply = (body, status = 200, headers = {}) => {
    const values = new Headers(headers);
    if (!values.has('content-type')) values.set('content-type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(body), { status, headers: values });
};

// Real normalization, domain transitions, DTOs, service and HTTP handlers. Only
// the repository's durable transaction is replaced here; the SQL journey is
// independently registered in integration/ncscAssessmentPostgres.js.
async function backend(options = {}) {
    const fixture = ncscFixture(options), clock = createClock(), context = await createContext(fixture.scope, clock);
    const versions = new Map(), receipts = new Map(), calls = [], records = [];
    let denied = false;
    const requireAccess = () => { if (denied) throw new NcscAssessmentError('ncsc_access_denied', 403); };
    const repository = {
        async listNcscAssessments(_context, page) {
            requireAccess(); const ids = [...versions.keys()].sort().filter(id => !page.afterAssessmentId || id > page.afterAssessmentId);
            const selected = ids.slice(0, page.limit);
            return { schemaVersion: 1, assessments: selected.map(id => projectNcscSummary(versions.get(id))),
                nextAfterAssessmentId: ids.length > selected.length ? selected.at(-1) : null };
        },
        async readNcscAssessment(_context, selector) {
            requireAccess(); const value = versions.get(selector.assessmentId);
            if (!value) throw new NcscAssessmentError('ncsc_not_found', 404);
            return { schemaVersion: 1, assessment: projectNcscDetail(value) };
        },
        async executeNcscAssessment(current, input) {
            requireAccess(); const command = normaliseNcscCommand(input), intent = stableIntent(current, command);
            const digest = JSON.stringify(intent), receipt = receipts.get(command.idempotencyKey);
            if (receipt) {
                if (receipt.digest !== digest) throw new NcscAssessmentError('ncsc_idempotency_conflict', 409);
                return clone(receipt.value);
            }
            const value = makeVersion(intent, command.idempotencyKey, versions.get(command.assessmentId) || null,
                fixture.state.tenantAggregate, clock.now());
            versions.set(command.assessmentId, value);
            const result = { schemaVersion: 1, action: command.action, assessment: projectNcscDetail(value) };
            receipts.set(command.idempotencyKey, { digest, value: result }); records.push(clone(command));
            return clone(result);
        }
    };
    const service = createNcscAssessmentService({ repository, requestContext: { resolve: async () => context } });
    const handlers = createNcscAssessmentHandlers({ service, guardMutation: async () => true });
    const fetch = jest.fn(async (url, init) => {
        calls.push({ url, init: { ...init, body: init.body } });
        const parsed = new URL(url, 'https://synthetic.invalid');
        const request = { method: init.method || 'GET', query: Object.fromEntries(parsed.searchParams),
            ...(init.body === undefined ? {} : { body: JSON.parse(init.body) }) };
        const relative = decodeURIComponent(parsed.pathname.slice(PREFIX.length).replace(/^\//, ''));
        const response = await handlers.handleRequest(request, relative);
        return reply(response.body, response.status, response.headers);
    });
    return { client: clientModule.createClient({ metadata: metadata(), fetch }), fetch, calls, records,
        versions, receipts, context, repository, handlers, clock, organisationId: fixture.scope.organisationId,
        deny: () => { denied = true; },
        execute: command => repository.executeNcscAssessment(context, command) };
}

function expectFrozen(value) {
    if (value && typeof value === 'object') {
        expect(Object.isFrozen(value)).toBe(true);
        Object.values(value).forEach(expectFrozen);
    }
}

describe('accepted questionnaire metadata and closed browser client', () => {
    test('presentation text, references, options and relationships derive from the accepted factory', () => {
        const source = createAcceptedNcscFrameworkProfile(), display = metadata();
        expect(display.profileRef).toEqual(ACCEPTED_PROFILE_REF);
        expect(display).toMatchObject({ schemaVersion: 1, moduleId: 'cyber_security', title: source.profile.title,
            description: source.profile.description, attribution: source.statements.attribution,
            claim: source.statements.claim, limitations: source.statements.limitations });
        const licensed = source.sources.find(item => item.licenceUrl);
        expect(display.licence).toEqual({ label: licensed.licence, url: licensed.licenceUrl });
        for (const [collection, fields] of [['domains', ['id', 'order', 'title', 'guidance']],
            ['controls', ['id', 'domainId', 'order', 'title', 'guidance']],
            ['questions', ['id', 'controlId', 'order', 'prompt', 'guidance', 'responseOptionIds']],
            ['responseOptions', ['id', 'label', 'applicable']]]) {
            expect(display[collection]).toEqual(source[collection].map(row => ({
                ...Object.fromEntries(fields.map(field => [field, row[field]])),
                ...(collection === 'questions' ? { sources: row.sourceIds.map(id => {
                    const reference = source.sources.find(item => item.id === id);
                    return { id: reference.id, title: reference.title, url: reference.url, lastVerifiedAt: reference.lastVerifiedAt };
                }) } : {})
            })));
        }
        expectFrozen(display); expect(metadata()).toEqual(display); expect(metadata()).not.toBe(display);
        expect(JSON.stringify(display)).not.toMatch(/implementationFactor|"weight"|"sourceIds"|sourceReferences|specificationDocument/);
    });

    test('closed client traverses actual handler create/save/clear/list/read/submit envelopes', async () => {
        const h = await backend(), id = 'assessment:a_b.1-2';
        const created = await h.client.create(createCommand(id));
        expect(created).toMatchObject({ schemaVersion: 1, action: 'create', assessment: { assessmentId: id, revision: 0 } });
        const saved = await h.client.save(saveCommand(id, 0, 'save-one', allResponses().slice(0, 2)));
        expect(saved.assessment.progress.answered).toBe(2);
        const cleared = await h.client.save(saveCommand(id, 1, 'clear-one', [{ itemId: allResponses()[0].itemId, optionId: null, rationale: null }]));
        expect(cleared.assessment.progress.answered).toBe(1);
        await h.client.save(saveCommand(id, 2, 'complete', allResponses('unknown')));
        const submitted = await h.client.submit(submitCommand(id, 3, 'submit-one'));
        expect(submitted.assessment).toMatchObject({ status: 'submitted', revision: 4,
            submission: { revision: 4, evaluation: { provenance: { assessmentRevision: 'rev-4' } } } });
        expect(await h.client.read(id)).toEqual({ schemaVersion: 1, assessment: submitted.assessment });
        expect((await h.client.list()).assessments[0]).toEqual(projectNcscSummary(h.versions.get(id)));
        expect(h.calls.every(({ url, init }) => url.startsWith(PREFIX) && init.credentials === 'same-origin' &&
            init.cache === 'no-store' && init.redirect === 'error')).toBe(true);
        const bodies = h.calls.filter(row => row.init.body).map(row => JSON.parse(row.init.body));
        expect(Object.keys(bodies[0]).sort()).toEqual(['assessmentId', 'expectedRevision', 'idempotencyKey', 'payload']);
        bodies.slice(1).forEach(body => expect(Object.keys(body).sort()).toEqual(['expectedRevision', 'idempotencyKey', 'payload']));
        expect(h.calls[1].url).toBe(`${PREFIX}/${encodeURIComponent(id)}/save`);
        expectFrozen(submitted);
    });

    test('inputs are detached synchronously and the client never invents or automatically retries a command key', async () => {
        const h = await backend(), pending = deferred(), command = createCommand();
        const fetch = jest.fn(async (...args) => { await pending.promise; return h.fetch(...args); });
        const client = clientModule.createClient({ metadata: metadata(), fetch });
        const request = client.create(command);
        command.assessmentId = 'changed'; command.idempotencyKey = 'changed'; command.payload.scopePopulation.description = 'changed';
        pending.resolve(); const result = await request;
        expect(result.assessment.assessmentId).toBe('assessment-a');
        expect(result.assessment.scopePopulation.description).toBe('Synthetic office and cloud services.');
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(JSON.parse(fetch.mock.calls[0][1].body).idempotencyKey).toBe('create-a');
    });

    test.each(['\u0000', '\uD800', '\uDC00', '', ' \n\t', 'x'.repeat(4001)])('client rejects invalid text before fetch %#', async text => {
        const fetch = jest.fn(), client = clientModule.createClient({ metadata: metadata(), fetch });
        const commands = [createCommand('assessment-a', 'create-a', text), saveCommand('assessment-a', 0, 'save-a',
            [{ itemId: allResponses()[0].itemId, optionId: 'not_applicable', rationale: { text } }])];
        for (const command of commands) {
            await expect(client[command.action](command)).rejects.toMatchObject({ code: 'ncsc_input_invalid' });
        }
        expect(fetch).not.toHaveBeenCalled();
    });

    test('client byte accounting agrees with the server for exact bounds, escapes, digit widths and valid Unicode', async () => {
        const h = await backend();
        for (const text of ['Māori e\u0301 界 \uD83D\uDE80\n\t\b\f\u0001\\u0000', '\uD83D\uDE80'.repeat(2000)]) {
            const command = createCommand('assessment-a', 'create-a', text);
            expect(h.client.normaliseCommand(command)).toEqual(normaliseNcscCommand(command));
            expect(h.client.commandByteLength(command)).toBe(Buffer.byteLength(JSON.stringify(normaliseNcscCommand(command)), 'utf8'));
        }
        const rows = allResponses('not_applicable'); rows.forEach(row => { row.rationale.text = 'x'.repeat(4000); });
        const command = saveCommand('assessment-a', 99, 'key-for-bounds', rows);
        let remaining = 65536 - Buffer.byteLength(JSON.stringify(command), 'utf8');
        for (const row of rows) { const extra = Math.min(remaining, 4000); row.rationale.text = 'é'.repeat(extra) + 'x'.repeat(4000 - extra); remaining -= extra; }
        expect(remaining).toBe(0); expect(h.client.commandByteLength(command)).toBe(65536);
        expect(h.client.normaliseCommand(command)).toEqual(normaliseNcscCommand(command));
        const wider = { ...command, expectedRevision: 100 };
        expect(h.client.commandByteLength(wider)).toBe(65537);
        expect(() => h.client.normaliseCommand(wider)).toThrow(); expect(() => normaliseNcscCommand(wider)).toThrow();
        expect(h.client.commandByteLength({ ...command, expectedRevision: 9 }) + 1).toBe(h.client.commandByteLength({ ...command, expectedRevision: 10 }));
        rows.forEach(row => { row.rationale.text = '界'.repeat(4000); });
        expect(h.client.commandByteLength(command)).toBeGreaterThan(65536);
    });

    test.each(['ncsc_unavailable', 'ncsc_outcome_ambiguous'])('every mutation 503 is uncertain and never automatically retried: %s', async code => {
        const fetch = jest.fn(async () => reply({ code }, 503)), client = clientModule.createClient({ metadata: metadata(), fetch });
        await expect(client.create(createCommand())).rejects.toMatchObject({ code, statusCode: 503, ambiguous: true });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    test.each([
        ['HTML', () => new Response('<html>private text</html>', { headers: { 'content-type': 'text/html' } })],
        ['malformed JSON', () => new Response('{', { headers: { 'content-type': 'application/json' } })],
        ['unknown error', () => reply({ code: 'private_arbitrary_error', message: 'secret-canary' }, 500)],
        ['unexpected status', () => reply({ schemaVersion: 1 }, 202)],
        ['transport rejection', () => { throw new Error('secret-canary'); }]
    ])('malformed mutation outcome is generic, uncertain and contains no arbitrary server message: %s', async (_name, response) => {
        const fetch = jest.fn(async () => response()), client = clientModule.createClient({ metadata: metadata(), fetch });
        await expect(client.create(createCommand())).rejects.toMatchObject({ code: 'ncsc_unavailable', ambiguous: true });
        try { await client.create(createCommand()); } catch (error) { expect(error.message).not.toMatch(/secret-canary|private text|private_arbitrary_error/); }
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    test('caller routes, unknown fields and invalid list controls fail before transport', async () => {
        const fetch = jest.fn(), client = clientModule.createClient({ metadata: metadata(), fetch });
        for (const id of ['../other', 'id/path', 'https://foreign.invalid', 'é', 'a'.repeat(121)]) await expect(client.read(id)).rejects.toBeDefined();
        for (const limit of [0, 101, '50', 1.1]) await expect(client.list({ limit })).rejects.toBeDefined();
        await expect(client.create({ ...createCommand(), tenantId: 'foreign' })).rejects.toBeDefined();
        expect(fetch).not.toHaveBeenCalled();
    });

    test('short list pages preserve their server cursor and support the maximum summary count', async () => {
        const h = await backend(); await h.execute(createCommand());
        const first = (await h.client.list()).assessments[0];
        const page = { schemaVersion: 1, assessments: [first], nextAfterAssessmentId: first.assessmentId };
        const fetch = jest.fn(async () => reply(page)), client = clientModule.createClient({ metadata: metadata(), fetch });
        expect((await client.list()).nextAfterAssessmentId).toBe(first.assessmentId);
        page.assessments = []; page.nextAfterAssessmentId = null;
        await client.list({ limit: 100, afterAssessmentId: first.assessmentId });
        const url = new URL(fetch.mock.calls[1][0], 'https://synthetic.invalid');
        expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '100', afterAssessmentId: first.assessmentId });
        page.assessments = Array.from({ length: 100 }, (_, index) => ({ ...first, assessmentId: `assessment-${String(index).padStart(3, '0')}` }));
        page.nextAfterAssessmentId = null;
        expect((await client.list({ limit: 100 })).assessments).toHaveLength(100);
    });

    test('received detail can exceed the command budget after valid separate saves', async () => {
        const h = await backend(); await h.execute(createCommand());
        const rows = allResponses('not_applicable'); rows.forEach(row => { row.rationale.text = '界'.repeat(4000); });
        for (let start = 0, revision = 0; start < rows.length; start += 4, revision += 1) {
            await h.execute(saveCommand('assessment-a', revision, `batch-${revision}`, rows.slice(start, start + 4)));
        }
        const detail = await h.client.read('assessment-a');
        expect(Buffer.byteLength(JSON.stringify(detail), 'utf8')).toBeGreaterThan(65536);
        expect(detail.assessment.responses.map(row => row.rationale.text)).toEqual(rows.map(row => row.rationale.text));
    });

    test.each([
        ['foreign identity', value => { value.assessment.assessmentId = 'foreign'; }],
        ['profile mismatch', value => { value.assessment.profileRef.sourceCatalogueSha256 = 'f'.repeat(64); }],
        ['unsafe revision', value => { value.assessment.revision = 129; }],
        ['bad digest', value => { value.assessment.revisionSha256 = 'bad'; }],
        ['unknown status', value => { value.assessment.status = 'approved'; }],
        ['bad timestamp', value => { value.assessment.updatedAt = '2026-02-30T00:00:00.000Z'; }],
        ['progress inconsistency', value => { value.assessment.progress.answered = 999; }],
        ['private envelope', value => { value.assessment.membership = { secret: 'private' }; }]
    ])('invalid consumed response field is refused: %s', async (_name, mutate) => {
        const h = await backend(), value = await h.execute(createCommand()); delete value.action;
        mutate(value);
        const client = clientModule.createClient({ metadata: metadata(), fetch: async () => reply(value) });
        await expect(client.read('assessment-a')).rejects.toMatchObject({ code: 'ncsc_unavailable' });
    });
});

function interactiveDom() {
    const dom = createDom(), create = dom.document.createElement;
    dom.document.createElement = tag => {
        const element = create(tag);
        Object.defineProperty(element, 'id', { get: () => element.getAttribute('id') || '', set: value => element.setAttribute('id', value) });
        element.removeChild = child => { const index = element.children.indexOf(child); if (index >= 0) element.children.splice(index, 1); child.parentElement = null; return child; };
        element.contains = child => element === child || element.children.some(item => item.contains ? item.contains(child) : item === child);
        element.setSelectionRange = (start, end) => { element.selectionStart = start; element.selectionEnd = end; };
        if (tag === 'dialog') {
            element.showModal = jest.fn(() => { element.open = true; dom.document.modal = element; });
            element.close = jest.fn(() => { element.open = false; if (dom.document.modal === element) dom.document.modal = null; });
        }
        return element;
    };
    dom.root = dom.document.createElement('div');
    dom.document.getElementById = id => dom.root.querySelectorAll('[id]').find(element => element.id === id) || null;
    return dom;
}
const byId = (ui, id) => ui.root.querySelectorAll('[id]').find(element => element.id === id);
const savedActions = ui => ui.root.querySelector('.ncsc-assessment-list')?.querySelectorAll('button') || [];
const control = (ui, label) => ui.root.querySelectorAll('button').find(element => element.textContent === label);
function event(element, name) {
    if (!element) throw new Error(`Missing ${name} control`);
    for (const handler of element.events[name] || []) handler({ currentTarget: element, target: element, preventDefault() {} });
}
function enter(element, value) { element.value = value; event(element, 'input'); }
async function until(predicate, label = 'UI state') {
    const end = Date.now() + 4000;
    while (!predicate() && Date.now() < end) await pause();
    expect(Boolean(predicate())).toBe(true);
}
function choose(ui, index, option, rationale) {
    const selector = byId(ui, 'ncsc-question-index'); selector.value = String(index); event(selector, 'change');
    const id = metadata().questions[index].id, input = byId(ui, `ncsc-answer-${id}-${option}`);
    input.checked = true; event(input, 'change');
    if (rationale !== undefined) enter(byId(ui, `ncsc-rationale-${id}`), rationale);
}
function mountUi(h, settings = {}) {
    const renderer = require('../api/shared/protectedAssets/ncscQuestionnaire');
    const dom = settings.dom || interactiveDom(); let sequence = 0;
    const controller = renderer.mount(dom.root, { metadata: metadata(), client: settings.client || h.client, organisationId: h.organisationId,
        presentationMode: 'editable', generation: {}, window: dom.window,
        createId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`, ...settings });
    return { ...dom, controller };
}
async function createInUi(h, options = {}) {
    const ui = mountUi(h, options); await until(() => control(ui, 'Start an assessment'));
    control(ui, 'Start an assessment').click(); enter(byId(ui, 'ncsc-scope'), '  Synthetic declared cloud scope.\n  ');
    control(ui, 'Create assessment').click(); await until(() => control(ui, 'Save progress'));
    return ui;
}
async function resumeUi(h, options = {}) {
    const ui = mountUi(h, options); await until(() => savedActions(ui).length > 0);
    savedActions(ui)[0].click();
    await until(() => byId(ui, 'ncsc-question-index')); return ui;
}

describe('saved assessment list pagination and resume', () => {
    async function paginationFocusFixture(options = {}) {
        const h = await backend(), gate = deferred();
        for (const id of ['assessment-first', 'assessment-hidden', 'assessment-next']) {
            await h.execute(createCommand(id, 'seed-' + id));
        }
        let hold = true;
        const list = jest.fn(async input => {
            if (input.afterAssessmentId && hold) { hold = false; await gate.promise; }
            return h.client.list({ ...input, limit: input.afterAssessmentId ? 2 : 1 });
        });
        const ui = mountUi(h, { ...options, client: { ...h.client, list } });
        await until(() => savedActions(ui).length === 1);
        return { h, ui, gate, list };
    }

    test.each(['editable', 'read-only'])('pagination focus follows the first newly visible %s record', async presentationMode => {
        const { h, ui, gate, list } = await paginationFocusFixture({ presentationMode });
        try {
            enter(byId(ui, 'ncsc-assessment-search'), 'assessment-next');
            const filter = byId(ui, 'ncsc-assessment-status'); filter.value = 'unfinished'; event(filter, 'change');
            const more = control(ui, 'Load more assessments'); more.focus(); more.click(); more.click();
            expect(list).toHaveBeenCalledTimes(2);
            expect(control(ui, 'Load more assessments').disabled).toBe(true);
            gate.resolve(); await until(() => savedActions(ui).length === 1);
            expect(ui.document.activeElement === savedActions(ui)[0]).toBe(true);
            expect(byId(ui, 'ncsc-assessment-search').value).toBe('assessment-next');
            expect(byId(ui, 'ncsc-assessment-status').value).toBe('unfinished');
            expect(h.calls.map(call => call.url)).toEqual([PREFIX + '?limit=1', PREFIX + '?limit=2&afterAssessmentId=assessment-first']);
            expect(h.calls.every(call => call.init.method === 'GET')).toBe(true);
            expect(h.records).toHaveLength(3);
        } finally { gate.resolve(); ui.controller.destroy(); }
    });

    test('pagination focus returns to search when the last page adds no matching rows', async () => {
        const { h, ui, gate } = await paginationFocusFixture();
        try {
            enter(byId(ui, 'ncsc-assessment-search'), 'absent-reference');
            const more = control(ui, 'Load more assessments'); more.focus(); more.click();
            gate.resolve(); await until(() => !control(ui, 'Load more assessments'));
            expect(savedActions(ui)).toHaveLength(0);
            expect(ui.document.activeElement === byId(ui, 'ncsc-assessment-search')).toBe(true);
            expect(byId(ui, 'ncsc-assessment-search').value).toBe('absent-reference');
            expect(h.records).toHaveLength(3);
        } finally { gate.resolve(); ui.controller.destroy(); }
    });

    test('failed pagination returns focus to its retryable More control without changing the cursor', async () => {
        const { h, ui, gate, list } = await paginationFocusFixture();
        try {
            const more = control(ui, 'Load more assessments'); more.focus(); more.click();
            gate.reject({ code: 'ncsc_unavailable', statusCode: 503 });
            await until(() => control(ui, 'Load more assessments')?.disabled === false);
            expect(ui.document.activeElement === control(ui, 'Load more assessments')).toBe(true);
            expect(savedActions(ui)).toHaveLength(1);
            expect(ui.root.querySelector('.ncsc-status').textContent).not.toBe('');
            control(ui, 'Load more assessments').click();
            await until(() => savedActions(ui).length === 3);
            expect(list.mock.calls.slice(1).map(([input]) => input.afterAssessmentId)).toEqual(['assessment-first', 'assessment-first']);
            expect(h.calls.every(call => call.init.method === 'GET')).toBe(true);
            expect(h.records).toHaveLength(3);
        } finally { ui.controller.destroy(); }
    });

    test.each(['outside', 'search', 'existing action', 'details', 'away then heading'])('pagination does not take focus after movement to %s', async destination => {
        const { ui, gate } = await paginationFocusFixture();
        try {
            const more = control(ui, 'Load more assessments'); more.focus(); more.click();
            const heading = byId(ui, 'ncsc-title');
            // This structural DOM has no native blur dispatch; emulate that event.
            event(heading, 'blur');
            let target;
            if (destination === 'outside' || destination === 'away then heading') target = ui.document.createElement('button');
            else if (destination === 'search') target = byId(ui, 'ncsc-assessment-search');
            else if (destination === 'details') target = ui.root.querySelector('.ncsc-assessment-list').querySelector('summary');
            else target = savedActions(ui)[0];
            target.focus();
            if (destination === 'away then heading') { heading.focus(); target = heading; }
            gate.resolve(); await until(() => savedActions(ui).length === 3);
            expect(ui.document.activeElement === (target.id ? byId(ui, target.id) : target)).toBe(true);
        } finally { gate.resolve(); ui.controller.destroy(); }
    });

    test('denied pagination clears the list without focusing a saved record or retry', async () => {
        const { ui, gate } = await paginationFocusFixture();
        try {
            const more = control(ui, 'Load more assessments'); more.focus(); more.click();
            gate.reject({ code: 'ncsc_access_denied', statusCode: 403 });
            await until(() => ui.root.textContent.includes('This assessment is not available.'));
            expect(savedActions(ui)).toHaveLength(0);
            expect(control(ui, 'Load more assessments')).toBeUndefined();
            expect(ui.document.activeElement === byId(ui, 'ncsc-title')).toBe(true);
        } finally { ui.controller.destroy(); }
    });

    test('returning after incomplete submission validation reloads the list and preserves the saved answers', async () => {
        const h = await backend(), ui = await createInUi(h);
        try {
            choose(ui, 0, 'yes'); choose(ui, 1, 'partial');
            control(ui, 'Save progress').click(); await until(() => ui.root.textContent.includes('Saved revision 1.'));
            const saved = clone(h.records), assessmentId = h.records[0].assessmentId;
            control(ui, 'Submit assessment').click();
            expect(ui.root.querySelector('.ncsc-errors').querySelectorAll('a')).toHaveLength(12);
            const requests = h.calls.length;
            control(ui, 'Back to assessments').click();
            await until(() => savedActions(ui).length === 1);
            expect(ui.root.textContent).not.toContain('Loading assessments.');
            expect(ui.root.textContent).not.toContain('Please check these answers');
            expect(ui.root.querySelector('.ncsc-errors').hidden).toBe(true);
            expect(h.calls.slice(requests).map(call => [call.init.method, call.url])).toEqual([['GET', PREFIX + '?limit=50']]);
            expect(h.records).toEqual(saved);
            savedActions(ui)[0].click(); await until(() => byId(ui, 'ncsc-question-index'));
            expect(h.calls.at(-1).url).toBe(PREFIX + '/' + assessmentId);
            expect(ui.root.textContent).toContain('Saved responses: 2 of 14 selected');
            expect(ui.root.textContent).not.toContain('Please check these answers');
            expect(h.records).toEqual(saved);
        } finally { ui.controller.destroy(); }
    });

    test('returning from invalid empty scope clears validation without creating an assessment', async () => {
        const h = await backend(), ui = mountUi(h);
        try {
            await until(() => control(ui, 'Start an assessment'));
            control(ui, 'Start an assessment').click(); control(ui, 'Create assessment').click();
            expect(ui.root.querySelector('.ncsc-errors').hidden).toBe(false);
            control(ui, 'Back to assessments').click();
            await until(() => ui.root.textContent.includes('No saved assessments yet.'));
            expect(ui.root.textContent).not.toContain('Please check these answers');
            expect(ui.root.querySelector('.ncsc-errors').hidden).toBe(true);
            expect(h.records).toHaveLength(0);
            expect(h.calls.every(call => call.init.method === 'GET')).toBe(true);
        } finally { ui.controller.destroy(); }
    });

    test('search and status combine without reads, preserve focus, recover from no matches and resume the exact record', async () => {
        const h = await backend();
        await h.execute(createCommand('assessment-draft', 'seed-draft'));
        await h.execute(createCommand('assessment-submitted', 'seed-submitted'));
        await h.execute(saveCommand('assessment-submitted', 0, 'save-submitted', allResponses()));
        await h.execute(submitCommand('assessment-submitted', 1, 'submit-record'));
        const ui = mountUi(h); await until(() => savedActions(ui).length === 2);
        const search = byId(ui, 'ncsc-assessment-search'), filter = byId(ui, 'ncsc-assessment-status');
        expect(savedActions(ui).map(button => button.textContent)).toEqual(['Continue assessment', 'View results']);
        search.focus(); enter(search, ' ASSESSMENT-SUBMITTED ');
        expect(savedActions(ui).map(button => button.textContent)).toEqual(['View results']);
        expect(ui.document.activeElement).toBe(search);
        filter.value = 'unfinished'; event(filter, 'change');
        expect(savedActions(ui)).toHaveLength(0);
        expect(ui.root.querySelector('.ncsc-assessment-empty').hidden).toBe(false);
        expect(ui.root.textContent).toContain('0 of 2 loaded assessments shown');
        control(ui, 'Clear filters').click();
        expect(search.value).toBe(''); expect(filter.value).toBe('all');
        expect(ui.document.activeElement).toBe(search); expect(savedActions(ui)).toHaveLength(2);
        enter(search, projectNcscSummary([...h.versions.values()][0]).createdAt.slice(0, 10));
        expect(savedActions(ui)).toHaveLength(2);
        filter.value = 'submitted'; event(filter, 'change');
        expect(savedActions(ui)).toHaveLength(1); expect(h.calls).toHaveLength(1);
        savedActions(ui)[0].click(); await until(() => Boolean(byId(ui, 'ncsc-question-index')));
        expect(h.calls.at(-1).url).toBe(PREFIX + '/assessment-submitted');
        expect(h.calls.every(call => call.init.method === 'GET')).toBe(true);
        expect(h.records).toHaveLength(4); ui.controller.destroy();
    });

    test('filters persist through pagination and disclose the loaded-record boundary', async () => {
        const h = await backend();
        const ids = ['assessment-first', 'assessment-next'];
        for (const id of ids) await h.execute(createCommand(id, 'seed-' + id));
        const list = jest.fn(input => h.client.list({ ...input, limit: 1 }));
        const ui = mountUi(h, { client: { ...h.client, list } }); await until(() => savedActions(ui).length === 1);
        enter(byId(ui, 'ncsc-assessment-search'), 'assessment-next');
        const filter = byId(ui, 'ncsc-assessment-status'); filter.value = 'unfinished'; event(filter, 'change');
        expect(savedActions(ui)).toHaveLength(0);
        expect(ui.root.textContent).toContain('Search and filters cover loaded assessments.');
        control(ui, 'Load more assessments').click(); await until(() => savedActions(ui).length === 1);
        expect(byId(ui, 'ncsc-assessment-search').value).toBe('assessment-next');
        expect(byId(ui, 'ncsc-assessment-status').value).toBe('unfinished');
        expect(ui.root.textContent).toContain('1 of 2 loaded assessments shown');
        expect(ui.root.textContent).not.toContain('Search and filters cover loaded assessments.');
        expect(h.calls).toHaveLength(2);
        savedActions(ui)[0].click(); await until(() => Boolean(byId(ui, 'ncsc-question-index')));
        expect(h.calls.at(-1).url).toBe(PREFIX + '/assessment-next');
        expect(h.records).toHaveLength(2); ui.controller.destroy();
    });

    test('read-only saved cards offer viewing and never imply editing', async () => {
        const h = await backend(); await h.execute(createCommand());
        const ui = mountUi(h, { presentationMode: 'read-only' }); await until(() => savedActions(ui).length === 1);
        expect(savedActions(ui)[0].textContent).toBe('View assessment');
        expect(control(ui, 'Start an assessment')).toBeUndefined();
        expect(ui.root.querySelector('progress').value).toBe(0);
        expect(ui.root.querySelector('progress').max).toBe(14);
        ui.controller.destroy();
    });

    test('an explicit saved target performs one fresh exact read without list/create/save/submit', async () => {
        const h = await backend();
        await h.execute(createCommand('assessment-target', 'seed-target', 'Synthetic exact target scope.'));
        await h.execute(createCommand('assessment-other', 'seed-other', 'Synthetic other scope.'));
        const ui = mountUi(h, { initialAssessmentId: 'assessment-target' });
        try {
            await until(() => byId(ui, 'ncsc-question-index'));
            expect(h.calls.map(call => call.url)).toEqual([PREFIX + '/assessment-target']);
            expect(h.calls.every(call => call.init.method === 'GET')).toBe(true);
            expect(h.records).toHaveLength(2);
            expect(ui.root.textContent).toContain('Synthetic exact target scope.');
            expect(ui.root.textContent).not.toContain('Synthetic other scope.');
        } finally { ui.controller.destroy(); }
    });
    test('a failed saved read retries only the selected record and ignores repeated clicks while loading', async () => {
        const h = await backend(), gate = deferred(), id = 'assessment-target';
        await h.execute(createCommand(id, 'seed-target', 'Synthetic exact retry scope.'));
        await h.execute(createCommand('assessment-other', 'seed-other', 'Synthetic other scope.'));
        const retained = clone(h.records), list = jest.fn(h.client.list);
        const read = jest.fn(async (...args) => {
            if (read.mock.calls.length === 1) throw new NcscAssessmentError('ncsc_unavailable', 503);
            await gate.promise; return h.client.read(...args);
        });
        const ui = mountUi(h, { client: { ...h.client, list, read }, initialAssessmentId: id });
        try {
            await until(() => control(ui, 'Retry loading this assessment'));
            expect(ui.root.textContent).toContain('The saved assessment could not be loaded.');
            expect(ui.root.textContent).not.toContain('unsent draft');
            expect(control(ui, 'Start an assessment')).toBeUndefined();
            expect(control(ui, 'Retry loading assessments')).toBeUndefined();
            const retry = control(ui, 'Retry loading this assessment'); retry.click(); retry.click();
            expect(read).toHaveBeenCalledTimes(2);
            expect(read.mock.calls.map(args => args[0])).toEqual([id, id]);
            expect(control(ui, 'Retry loading this assessment')).toBeUndefined();
            expect(ui.root.textContent).toContain('Loading the selected assessment.');
            expect(control(ui, 'Back to assessments')).toBeDefined();
            await pause(); expect(read).toHaveBeenCalledTimes(2);
            gate.resolve(); await until(() => byId(ui, 'ncsc-question-index'));
            retry.click(); await pause(); expect(read).toHaveBeenCalledTimes(2);
            expect(ui.root.textContent).toContain('Synthetic exact retry scope.');
            expect(ui.root.textContent).not.toContain('Synthetic other scope.');
            expect(ui.root.textContent).toContain('Saved revision 0.');
            expect(list).not.toHaveBeenCalled();
            expect(h.calls.map(call => call.url)).toEqual([PREFIX + '/' + id]);
            expect(h.calls.every(call => call.init.method === 'GET')).toBe(true);
            expect(h.records).toEqual(retained);
        } finally { gate.resolve(); ui.controller.destroy(); }
    });
    test('two selected-record failures keep explicit retries on the same saved record until success', async () => {
        const h = await backend(), id = 'assessment-target';
        await h.execute(createCommand(id, 'seed-target', 'Synthetic twice-unavailable saved scope.'));
        await h.execute(createCommand('assessment-other', 'seed-other', 'Synthetic unrelated saved scope.'));
        const retained = clone(h.records), list = jest.fn(h.client.list);
        const read = jest.fn(async (...args) => {
            if (read.mock.calls.length <= 2) throw new NcscAssessmentError('ncsc_unavailable', 503);
            return h.client.read(...args);
        });
        const ui = mountUi(h, { client: { ...h.client, list, read }, initialAssessmentId: id });
        try {
            await until(() => control(ui, 'Retry loading this assessment'));
            const firstRetry = control(ui, 'Retry loading this assessment');
            firstRetry.click();
            await until(() => control(ui, 'Retry loading this assessment') && read.mock.calls.length === 2);
            expect(ui.root.textContent).toContain('The saved assessment could not be loaded.');
            expect(control(ui, 'Start an assessment')).toBeUndefined();
            expect(control(ui, 'Retry loading assessments')).toBeUndefined();
            expect(control(ui, 'Back to assessments')).toBeDefined();
            firstRetry.click(); await pause();
            expect(read).toHaveBeenCalledTimes(2);
            control(ui, 'Retry loading this assessment').click();
            await until(() => byId(ui, 'ncsc-question-index'));
            expect(read.mock.calls.map(args => args[0])).toEqual([id, id, id]);
            expect(ui.root.textContent).toContain('Synthetic twice-unavailable saved scope.');
            expect(ui.root.textContent).not.toContain('Synthetic unrelated saved scope.');
            expect(ui.root.textContent).toContain('Saved revision 0.');
            expect(list).not.toHaveBeenCalled();
            expect(h.calls.map(call => call.url)).toEqual([PREFIX + '/' + id]);
            expect(h.calls.every(call => call.init.method === 'GET')).toBe(true);
            expect(h.records).toEqual(retained);
        } finally { ui.controller.destroy(); }
    });
    test.each([
        ['initial', 'success'], ['retry', 'success'], ['retry', 'denied']
    ])('Back cancels the pending %s read and ignores its older %s after new navigation', async (phase, outcome) => {
        const h = await backend(), gate = deferred(), id = 'assessment-target';
        const seeded = await h.execute(createCommand(id, 'seed-target', 'Synthetic stale saved scope.'));
        const retained = clone(h.records), list = jest.fn(h.client.list);
        const read = jest.fn(async () => {
            if (phase === 'retry' && read.mock.calls.length === 1) throw new NcscAssessmentError('ncsc_unavailable', 503);
            await gate.promise;
            if (outcome === 'denied') throw new NcscAssessmentError('ncsc_access_denied', 403);
            return { schemaVersion: 1, assessment: seeded.assessment };
        });
        const ui = mountUi(h, { client: { ...h.client, list, read }, initialAssessmentId: id });
        try {
            if (phase === 'retry') {
                await until(() => control(ui, 'Retry loading this assessment'));
                control(ui, 'Retry loading this assessment').click();
            }
            const signal = read.mock.calls.at(-1)[1].signal;
            const back = control(ui, 'Back to assessments'); back.click(); back.click();
            expect(signal.aborted).toBe(true);
            await until(() => control(ui, 'Start an assessment'));
            expect(list).toHaveBeenCalledTimes(1);
            control(ui, 'Start an assessment').click();
            enter(byId(ui, 'ncsc-scope'), 'New unsent scope after cancelling the read.');
            gate.resolve(); await pause(); await pause();
            expect(byId(ui, 'ncsc-scope').value).toBe('New unsent scope after cancelling the read.');
            expect(byId(ui, 'ncsc-question-index')).toBeUndefined();
            expect(ui.root.textContent).not.toContain('Synthetic stale saved scope.');
            expect(ui.root.textContent).not.toContain('This assessment is not available.');
            expect(list).toHaveBeenCalledTimes(1);
            expect(read).toHaveBeenCalledTimes(phase === 'retry' ? 2 : 1);
            expect(h.records).toEqual(retained);
        } finally { gate.resolve(); ui.controller.destroy(); }
    });
    test('disposing a pending saved-record retry aborts it and ignores its late response and old controls', async () => {
        const h = await backend(), gate = deferred(), id = 'assessment-target';
        const seeded = await h.execute(createCommand(id, 'seed-target', 'Synthetic disposed scope.'));
        const retained = clone(h.records), list = jest.fn(h.client.list);
        const read = jest.fn(async () => {
            if (read.mock.calls.length === 1) throw new NcscAssessmentError('ncsc_unavailable', 503);
            await gate.promise; return { schemaVersion: 1, assessment: seeded.assessment };
        });
        const ui = mountUi(h, { client: { ...h.client, list, read }, initialAssessmentId: id });
        try {
            await until(() => control(ui, 'Retry loading this assessment'));
            const retry = control(ui, 'Retry loading this assessment'); retry.click();
            const signal = read.mock.calls[1][1].signal, back = control(ui, 'Back to assessments');
            ui.controller.destroy(); expect(signal.aborted).toBe(true);
            retry.click(); back.click(); gate.resolve(); await pause(); await pause();
            expect(ui.root.textContent).toBe('');
            expect(read).toHaveBeenCalledTimes(2); expect(list).not.toHaveBeenCalled();
            expect(h.records).toEqual(retained);
        } finally { gate.resolve(); ui.controller.destroy(); }
    });
    test('a denied saved-record retry retains the access-denied view without list fallback or writes', async () => {
        const h = await backend(), id = 'assessment-target';
        await h.execute(createCommand(id, 'seed-target', 'Synthetic inaccessible scope.'));
        const retained = clone(h.records), list = jest.fn(h.client.list);
        const read = jest.fn(async (...args) => {
            if (read.mock.calls.length === 1) throw new NcscAssessmentError('ncsc_unavailable', 503);
            return h.client.read(...args);
        });
        const ui = mountUi(h, { client: { ...h.client, list, read }, initialAssessmentId: id });
        try {
            await until(() => control(ui, 'Retry loading this assessment'));
            const retry = control(ui, 'Retry loading this assessment'); h.deny(); retry.click();
            await until(() => ui.root.textContent.includes('This assessment is not available.'));
            retry.click(); await pause();
            expect(ui.root.textContent).not.toContain('Synthetic inaccessible scope.');
            expect(ui.root.querySelectorAll('button')).toHaveLength(0);
            expect(read).toHaveBeenCalledTimes(2); expect(list).not.toHaveBeenCalled();
            expect(h.records).toEqual(retained);
        } finally { ui.controller.destroy(); }
    });
    test.each(['missing', 'denied', 'wrong response', 'destroyed'])('an initial %s record cannot reveal another record or trigger a fallback mutation', async kind => {
        const h = await backend();
        await h.execute(createCommand('assessment-other', 'seed-other', 'Synthetic private other scope.'));
        const gate = deferred(); let reads = 0;
        const client = { ...h.client, read: async (...args) => {
            reads++;
            if (kind === 'destroyed') { await gate.promise; return h.client.read('assessment-other'); }
            if (kind === 'wrong response') return h.client.read('assessment-other');
            return h.client.read(...args);
        } };
        if (kind === 'denied') h.deny();
        const ui = mountUi(h, { client, initialAssessmentId: 'assessment-target' });
        try {
            if (kind === 'destroyed') { ui.controller.destroy(); gate.resolve(); }
            await until(() => reads === 1); for (let i = 0; i < 20; i++) await pause();
            expect(ui.root.textContent).not.toContain('Synthetic private other scope.');
            expect(byId(ui, 'ncsc-question-index')).toBeUndefined();
            expect(control(ui, 'Create assessment')).toBeUndefined();
            expect(h.records).toHaveLength(1);
            expect(h.calls.every(call => call.init.method === 'GET')).toBe(true);
            expect(h.calls.some(call => call.url === PREFIX + '?limit=50')).toBe(false);
            if (kind === 'destroyed') expect(ui.root.textContent).toBe('');
        } finally { ui.controller.destroy(); }
    });
    test.each(['', '../other', 'assessment/other', null, 42, 'a'.repeat(121)])('invalid initial read target %p fails before transport', async initialAssessmentId => {
        const h = await backend();
        expect(() => mountUi(h, { initialAssessmentId })).toThrow('ncsc_composition_required');
        expect(h.calls).toHaveLength(0); expect(h.records).toHaveLength(0);
    });
    test.each(['empty scope', 'discard scope'])('returning from %s during the initial list read reloads without getting stuck or accepting the stale page', async outcome => {
        const h = await backend(), gate = deferred(); let listReads = 0;
        const stalePage = await h.client.list();
        const client = { ...h.client, list: async (...args) => {
            listReads++;
            if (listReads === 1) { await gate.promise; return stalePage; }
            return h.client.list(...args);
        } };
        const ui = mountUi(h, { client });
        try {
            await until(() => listReads === 1 && control(ui, 'Start an assessment'));
            control(ui, 'Start an assessment').click();
            if (outcome === 'discard scope') enter(byId(ui, 'ncsc-scope'), 'Unsent scope to discard.');
            await h.execute(createCommand('saved-while-list-loading', 'create-during-list', 'Retained saved scope.'));
            control(ui, 'Back to assessments').click();
            if (outcome === 'discard scope') control(ui, 'Discard unsent changes').click();
            await until(() => savedActions(ui).length > 0);
            expect(listReads).toBe(2);
            expect(ui.root.textContent).not.toContain('Loading assessments.');
            expect(ui.root.textContent).not.toContain('Unsent scope to discard.');
            gate.resolve(); await pause(); await pause();
            expect(savedActions(ui)).toHaveLength(1);
            expect(ui.root.textContent).not.toContain('No saved assessments yet.');
            expect(h.records).toHaveLength(1);
        } finally { gate.resolve(); ui.controller.destroy(); }
    });

    test('saving a new scope while returning to assessments refreshes the list and reopens the exact saved creation', async () => {
        const h = await backend(), ui = mountUi(h), scope = 'Synthetic scope saved while returning to the list.';
        await until(() => control(ui, 'Start an assessment'));
        control(ui, 'Start an assessment').click(); enter(byId(ui, 'ncsc-scope'), scope);
        control(ui, 'Back to assessments').click(); control(ui, 'Save and leave').click();
        await until(() => h.records.length === 1 && !ui.root.querySelector('dialog'));
        await until(() => Boolean(control(ui, 'Start an assessment')));
        expect(control(ui, 'Save progress')).toBeUndefined();
        const savedRow = savedActions(ui)[0];
        expect(savedRow).toBeDefined();
        expect(h.calls.filter(item => item.url === PREFIX + '?limit=50')).toHaveLength(2);
        savedRow.click(); await until(() => control(ui, 'Save progress'));
        expect(ui.root.textContent).toContain(scope);
        expect(h.records).toHaveLength(1); expect(h.records[0].action).toBe('create');
        expect(h.calls.at(-1).url).toBe(PREFIX + '/' + h.records[0].assessmentId);
        ui.controller.destroy();
    });

    test.each(['new scope', 'saved assessment'])('failed replacement list after leaving %s offers retry without claiming saved work is absent', async origin => {
        const h = await backend(); let listReads = 0;
        const client = { ...h.client, list: async (...args) => {
            listReads++;
            if (listReads === 2) throw new NcscAssessmentError('ncsc_unavailable', 503);
            return h.client.list(...args);
        } };
        const ui = mountUi(h, { client }); await until(() => control(ui, 'Start an assessment'));
        control(ui, 'Start an assessment').click(); enter(byId(ui, 'ncsc-scope'), 'Retained synthetic scope despite a list outage.');
        if (origin === 'saved assessment') {
            control(ui, 'Create assessment').click(); await until(() => control(ui, 'Save progress'));
        }
        control(ui, 'Back to assessments').click();
        if (origin === 'new scope') control(ui, 'Save and leave').click();
        await until(() => ui.root.textContent.includes('assessment service is unavailable'));
        expect(h.records).toHaveLength(1);
        expect(ui.root.textContent).not.toContain('No saved assessments yet.');
        expect(control(ui, 'Retry loading assessments')).toBeDefined();
        control(ui, 'Retry loading assessments').click();
        await until(() => savedActions(ui).length > 0);
        expect(h.records).toHaveLength(1); expect(listReads).toBe(3);
        ui.controller.destroy();
    });

    test('loads one page at a time and resumes the exact saved draft from the next page without writes', async () => {
        const h = await backend(), gate = deferred();
        const ids = Array.from({ length: 52 }, (_value, index) => `assessment-${String(index).padStart(3, '0')}`);
        for (const id of ids) await h.execute(createCommand(id, `create-${id}`, `Synthetic saved scope for ${id}`));
        const resumedId = ids.at(-1), rows = allResponses('unknown').slice(0, 2);
        await h.execute(saveCommand(resumedId, 0, 'save-page-two', rows));
        const retained = clone(h.records);
        const list = jest.fn(async input => {
            if (input.afterAssessmentId !== null) await gate.promise;
            return h.client.list(input);
        });
        const ui = mountUi(h, { client: { ...h.client, list } });
        const assessments = () => ui.root.querySelector('.ncsc-assessment-list').querySelectorAll('button');
        try {
            await until(() => assessments().length === 50 && control(ui, 'Load more assessments'));
            const firstPage = assessments().map(item => item.textContent);
            expect(h.calls).toHaveLength(1);
            expect(h.calls[0].url).toBe(`${PREFIX}?limit=50`);
            const more = control(ui, 'Load more assessments'); more.click(); more.click();
            await until(() => list.mock.calls.length === 2);
            expect(control(ui, 'Load more assessments').disabled).toBe(true);
            control(ui, 'Load more assessments').click(); await pause();
            expect(list).toHaveBeenCalledTimes(2);
            expect(list.mock.calls[1][0]).toMatchObject({ limit: 50, afterAssessmentId: ids[49] });
            expect(assessments().map(item => item.textContent)).toEqual(firstPage);
            gate.resolve();
            await until(() => assessments().length === 52 && !control(ui, 'Load more assessments'));
            expect(assessments().slice(0, 50).map(item => item.textContent)).toEqual(firstPage);
            expect(h.calls[1].url).toBe(`${PREFIX}?limit=50&afterAssessmentId=${ids[49]}`);
            assessments().at(-1).click();
            await until(() => byId(ui, 'ncsc-question-index'));
            expect(h.calls.at(-1).url).toBe(`${PREFIX}/${resumedId}`);
            expect(ui.root.textContent).toContain(`Synthetic saved scope for ${resumedId}`);
            expect(ui.root.textContent).toContain('Saved revision 1. 2 of 14 answered.');
            expect(byId(ui, 'ncsc-question-index').value).toBe('2');
            const selector = byId(ui, 'ncsc-question-index'); selector.value = '0'; event(selector, 'change');
            expect(byId(ui, `ncsc-answer-${rows[0].itemId}-unknown`).checked).toBe(true);
            expect(h.calls).toHaveLength(3);
            expect(h.calls.every(call => call.init.method === 'GET')).toBe(true);
            expect(h.records).toEqual(retained);
        } finally { gate.resolve(); ui.controller.destroy(); }
    });

    test('a failed next page keeps earlier drafts and retries the same cursor only on explicit request', async () => {
        const h = await backend();
        const ids = Array.from({ length: 51 }, (_value, index) => `assessment-${String(index).padStart(3, '0')}`);
        for (const id of ids) await h.execute(createCommand(id, `create-${id}`));
        const retained = clone(h.records); let failNextPage = true;
        const fetch = jest.fn(async (url, init) => {
            if (url.includes('afterAssessmentId=') && failNextPage) {
                failNextPage = false; return reply({ code: 'ncsc_unavailable' }, 503);
            }
            return h.fetch(url, init);
        });
        const client = clientModule.createClient({ metadata: metadata(), fetch }), ui = mountUi(h, { client });
        const assessments = () => ui.root.querySelector('.ncsc-assessment-list').querySelectorAll('button');
        try {
            await until(() => assessments().length === 50 && control(ui, 'Load more assessments'));
            const firstPage = assessments().map(item => item.textContent);
            control(ui, 'Load more assessments').click();
            await until(() => ui.root.textContent.includes('The assessment service is unavailable.'));
            expect(assessments().map(item => item.textContent)).toEqual(firstPage);
            expect(control(ui, 'Load more assessments').disabled).toBe(false);
            await pause(); expect(fetch).toHaveBeenCalledTimes(2);
            expect(h.records).toEqual(retained);
            control(ui, 'Load more assessments').click();
            await until(() => assessments().length === 51 && !control(ui, 'Load more assessments'));
            expect(fetch).toHaveBeenCalledTimes(3);
            expect(fetch.mock.calls[1][0]).toBe(`${PREFIX}?limit=50&afterAssessmentId=${ids[49]}`);
            expect(fetch.mock.calls[2][0]).toBe(fetch.mock.calls[1][0]);
            expect(assessments().slice(0, 50).map(item => item.textContent)).toEqual(firstPage);
            expect(fetch.mock.calls.every(([_url, init]) => init.method === 'GET')).toBe(true);
            expect(h.records).toEqual(retained);
        } finally { ui.controller.destroy(); }
    });
});

describe('questionnaire draft progress and unanswered navigation', () => {
    test('reopening a sparse draft skips explicit Unknown and pending N/A answers without writing', async () => {
        const h = await backend(), rows = allResponses();
        await h.execute(createCommand());
        await h.execute(saveCommand('assessment-a', 0, 'saved-sparse', [
            { ...rows[0], optionId: 'unknown' },
            { ...rows[1], optionId: 'not_applicable', rationale: { text: 'Synthetic pending exclusion.' } },
            { ...rows[3], optionId: 'no' }
        ]));
        const ui = await resumeUi(h), picker = byId(ui, 'ncsc-question-index');
        expect(picker.value).toBe('2');
        expect(ui.root.querySelector('legend').textContent).toBe(metadata().questions[2].prompt);
        expect(picker.children[0].textContent).toContain('Unknown');
        expect(picker.children[1].textContent).toContain('Pending N/A');
        expect(picker.children[2].textContent).toContain('Unanswered');
        expect(picker.children[3].textContent).toContain('No');
        expect(byId(ui, 'ncsc-draft-progress').textContent).toBe('Local draft: 3 of 14 answers selected · 1 resolved · 11 unanswered. Counts are not a score.');
        expect(ui.root.textContent).toContain('Saved responses: 3 of 14 selected; 11 unanswered; 1 Unknown; 1 pending N/A claims.');
        expect(ui.root.textContent).toContain('Saved resolved answers: 1 of 14 (Yes, Partial or No).');
        expect(h.records).toHaveLength(2); ui.controller.destroy();
    });

    test.each([false, true])('all explicit responses open at question one, with submitted answers distinguished: %s', async submitted => {
        const h = await backend(); await h.execute(createCommand());
        await h.execute(saveCommand('assessment-a', 0, 'all-unknown', allResponses('unknown')));
        if (submitted) await h.execute(submitCommand());
        const ui = await resumeUi(h);
        expect(byId(ui, 'ncsc-question-index').value).toBe('0');
        expect(byId(ui, 'ncsc-draft-progress').textContent).toBe((submitted ? 'Saved answers: ' : 'Local draft: ') + '14 of 14 answers selected · 0 resolved · 0 unanswered. Counts are not a score.');
        if (submitted) expect(control(ui, 'Next unanswered question')).toBeUndefined();
        else expect(control(ui, 'Next unanswered question').disabled).toBe(true);
        expect(ui.root.textContent).toContain('14 Unknown'); ui.controller.destroy();
    });

    test('Yes, Partial and No resolve local answers without claiming those responses are already saved', async () => {
        const h = await backend(), ui = await createInUi(h);
        ['yes', 'partial', 'no', 'unknown', 'not_applicable'].forEach((option, index) =>
            choose(ui, index, option, option === 'not_applicable' ? 'Synthetic pending exclusion.' : undefined));
        expect(byId(ui, 'ncsc-draft-progress').textContent).toBe('Local draft: 5 of 14 answers selected · 3 resolved · 9 unanswered · 5 with unsaved changes. Counts are not a score.');
        expect(ui.root.textContent).toContain('Saved resolved answers: 0 of 14 (Yes, Partial or No).');
        control(ui, 'Save progress').click(); await until(() => ui.root.textContent.includes('Your progress is saved.'));
        expect(ui.root.textContent).toContain('Saved responses: 5 of 14 selected; 9 unanswered; 1 Unknown; 1 pending N/A claims.');
        expect(ui.root.textContent).toContain('Saved resolved answers: 3 of 14 (Yes, Partial or No).');
        expect(ui.root.textContent).toContain('Resolved means answered Yes, Partial or No; it does not mean implemented.');
        expect(metadata().questions.slice(0, 5).map(question => h.records.at(-1).payload.responses.find(row => row.itemId === question.id).optionId))
            .toEqual(['yes', 'partial', 'no', 'unknown', 'not_applicable']);
        ui.controller.destroy();
    });

    test('compact question selector preserves every full prompt, question order and unsaved answer status', async () => {
        const h = await backend(), ui = await createInUi(h), questions = metadata().questions;
        try {
            const picker = byId(ui, 'ncsc-question-index');
            expect(picker.children).toHaveLength(questions.length);
            questions.forEach((question, index) => {
                expect(picker.children[index].value).toBe(String(index));
                expect(picker.children[index].textContent).toBe((index + 1) + ' of ' + questions.length + ' · Unanswered');
                picker.value = String(index); event(picker, 'change');
                expect(ui.root.querySelector('legend').textContent).toBe(question.prompt);
            });
            const help = byId(ui, picker.getAttribute('aria-describedby'));
            expect(help.textContent).toBe('The full question is below. * marks unsaved changes.');
            choose(ui, 0, 'unknown'); choose(ui, 1, 'not_applicable', 'Synthetic pending claim');
            expect(picker.children[0].textContent).toBe('1 of ' + questions.length + ' · Unknown *');
            expect(picker.children[1].textContent).toBe('2 of ' + questions.length + ' · Pending N/A *');
            control(ui, 'Save progress').click(); await until(() => ui.root.textContent.includes('Your progress is saved.'));
            const saved = byId(ui, 'ncsc-question-index');
            expect(saved.children[0].textContent).toBe('1 of ' + questions.length + ' · Unknown');
            expect(saved.children[1].textContent).toBe('2 of ' + questions.length + ' · Pending N/A');
            expect(Object.fromEntries(h.records.at(-1).payload.responses.map(row => [row.itemId, row.optionId])))
                .toEqual({ [questions[0].id]: 'unknown', [questions[1].id]: 'not_applicable' });
        } finally { ui.controller.destroy(); }
    });

    test('local answer, rationale and clear update navigation while saved counts wait for acknowledgement', async () => {
        const h = await backend(), ui = await createInUi(h);
        choose(ui, 0, 'unknown');
        expect(ui.root.querySelector('.ncsc-status').textContent).toContain('1 answer has unsaved changes.');
        choose(ui, 1, 'not_applicable', 'Initial claim');
        expect(ui.root.querySelector('.ncsc-status').textContent).toContain('2 answers have unsaved changes.');
        const rationale = byId(ui, 'ncsc-rationale-' + metadata().questions[1].id);
        rationale.focus(); rationale.setSelectionRange(3, 7); enter(rationale, 'Changed pending claim');
        expect(byId(ui, rationale.id)).toBe(rationale); expect(ui.document.activeElement).toBe(rationale);
        expect(rationale.selectionStart).toBe(3); expect(rationale.selectionEnd).toBe(7);
        expect(byId(ui, 'ncsc-draft-progress').textContent).toContain('2 of 14 answers selected · 0 resolved · 12 unanswered · 2 with unsaved changes');
        expect(byId(ui, 'ncsc-question-index').children[1].textContent).toContain('Pending N/A *');
        expect(ui.root.textContent).toContain('Saved responses: 0 of 14 selected; 14 unanswered');
        control(ui, 'Clear answer').click();
        expect(byId(ui, 'ncsc-draft-progress').textContent).toContain('1 of 14 answers selected · 0 resolved · 13 unanswered · 1 with unsaved changes');
        expect(ui.root.querySelector('.ncsc-status').textContent).toContain('1 answer has unsaved changes.');
        expect(byId(ui, 'ncsc-question-index').children[1].textContent).not.toContain('*');
        control(ui, 'Save progress').click(); await until(() => ui.root.textContent.includes('Your progress is saved.'));
        expect(byId(ui, 'ncsc-draft-progress').textContent).toBe('Local draft: 1 of 14 answers selected · 0 resolved · 13 unanswered. Counts are not a score.');
        expect(ui.root.textContent).toContain('Saved responses: 1 of 14 selected; 13 unanswered; 1 Unknown');
        const picker = byId(ui, 'ncsc-question-index'); picker.value = '0'; event(picker, 'change');
        control(ui, 'Clear answer').click();
        expect(byId(ui, 'ncsc-draft-progress').textContent).toContain('0 of 14 answers selected · 0 resolved · 14 unanswered · 1 with unsaved changes');
        expect(picker.children[0].textContent).toContain('Unanswered *');
        expect(ui.root.textContent).toContain('Saved responses: 1 of 14 selected'); ui.controller.destroy();
    });

    test('next unanswered wraps, skips local explicit responses and focuses the destination question', async () => {
        const h = await backend(), ui = await createInUi(h), picker = byId(ui, 'ncsc-question-index');
        picker.value = '13'; event(picker, 'change'); control(ui, 'Next unanswered question').click();
        expect(picker.value).toBe('0'); expect(ui.document.activeElement).toBe(ui.root.querySelector('legend'));
        choose(ui, 1, 'unknown'); choose(ui, 0, 'not_applicable', 'Synthetic pending claim');
        control(ui, 'Next unanswered question').click();
        expect(picker.value).toBe('2'); expect(ui.document.activeElement).toBe(ui.root.querySelector('legend'));
        expect(ui.root.querySelector('.ncsc-navigation-summary').textContent).toBe('Question 3 of 14 · 12 unanswered');
        expect(h.records).toHaveLength(1); ui.controller.destroy();
    });

    test('detached navigation and picker controls cannot change the current selection after a render', async () => {
        const h = await backend(), ui = await createInUi(h);
        const oldPicker = byId(ui, 'ncsc-question-index'), oldJump = control(ui, 'Next unanswered question');
        const oldNext = control(ui, 'Next question');
        choose(ui, 0, 'unknown'); control(ui, 'Next unanswered question').click();
        const oldPrevious = control(ui, 'Previous question'); expect(oldPrevious.disabled).toBe(false);
        choose(ui, 1, 'unknown');
        oldJump.click(); oldNext.click(); oldPrevious.click(); expect(byId(ui, 'ncsc-question-index').value).toBe('1');
        control(ui, 'Save progress').click(); await until(() => ui.root.textContent.includes('Your progress is saved.'));
        const current = byId(ui, 'ncsc-question-index'), before = ui.root.textContent;
        expect(current).not.toBe(oldPicker); oldPicker.value = '7'; event(oldPicker, 'change'); oldJump.click(); oldNext.click(); oldPrevious.click();
        expect(current.value).toBe('1'); expect(ui.root.textContent).toBe(before); ui.controller.destroy();
    });

    test('next unresolved includes missing, Unknown and pending N/A, skips resolved answers and wraps without saving', async () => {
        const h = await backend(), ui = await createInUi(h);
        metadata().questions.forEach((_, index) => choose(ui, index, ['yes', 'partial', 'no'][index % 3]));
        expect(control(ui, 'Next unresolved question').disabled).toBe(true);
        choose(ui, 1, 'unknown'); choose(ui, 3, 'not_applicable', 'Synthetic pending claim');
        choose(ui, 5, 'yes'); control(ui, 'Clear answer').click();
        const picker = byId(ui, 'ncsc-question-index');
        picker.value = '0'; event(picker, 'change');
        for (const target of ['1', '3', '5', '1']) {
            control(ui, 'Next unresolved question').click();
            expect(picker.value).toBe(target);
            expect(ui.document.activeElement).toBe(ui.root.querySelector('legend'));
        }
        const detached = control(ui, 'Next unresolved question');
        choose(ui, 1, 'yes'); detached.click(); expect(picker.value).toBe('1');
        control(ui, 'Next unresolved question').click(); expect(picker.value).toBe('3');
        expect(h.records).toHaveLength(1);
        expect(ui.root.textContent).toContain('Unknown and pending N/A remain valid responses for submission.');
        ui.controller.destroy(); detached.click(); expect(ui.root.textContent).toBe('');
    });

    test('submitted unresolved navigation uses saved answers and stays read-only', async () => {
        const h = await backend(), responses = allResponses('yes');
        responses[1] = { ...responses[1], optionId: 'unknown' };
        responses[3] = { ...responses[3], optionId: 'not_applicable', rationale: { text: 'Synthetic claim' } };
        await h.execute(createCommand());
        await h.execute(saveCommand('assessment-a', 0, 'unresolved-save', responses));
        await h.execute(submitCommand());
        const ui = await resumeUi(h, { presentationMode: 'read-only' });
        const before = ui.root.querySelector('.ncsc-results').textContent;
        for (const target of ['1', '3', '1']) {
            control(ui, 'Next unresolved question').click();
            expect(byId(ui, 'ncsc-question-index').value).toBe(target);
            expect(ui.root.querySelectorAll('input').filter(input => input.type === 'radio').every(input => input.disabled)).toBe(true);
        }
        expect(control(ui, 'Save progress')).toBeUndefined();
        expect(control(ui, 'Next unanswered question')).toBeUndefined();
        expect(h.records).toHaveLength(3);
        expect(ui.root.querySelector('.ncsc-results').textContent).toBe(before);
        ui.controller.destroy();
    });

    test('same-day saved assessments have distinct linked references and last-saved times without extra reads', async () => {
        const h = await backend();
        await h.execute(createCommand('assessment-a', 'create-a'));
        await h.execute(createCommand('assessment-b', 'create-b'));
        const ui = mountUi(h);
        await until(() => ui.root.querySelector('.ncsc-assessment-list')?.querySelectorAll('button').length === 2);
        const buttons = ui.root.querySelector('.ncsc-assessment-list').querySelectorAll('button');
        const descriptions = buttons.map(button => byId(ui, button.getAttribute('aria-describedby')));
        expect(descriptions.every(Boolean)).toBe(true);
        expect(descriptions[0].textContent).toContain('Assessment reference: assessment-a');
        expect(descriptions[1].textContent).toContain('Assessment reference: assessment-b');
        expect(descriptions[0].textContent).toContain('Last saved: ');
        expect(descriptions[0].textContent).toContain(' UTC');
        expect(h.calls).toHaveLength(1);
        buttons[1].click(); await until(() => Boolean(byId(ui, 'ncsc-question-index')));
        expect(h.calls.at(-1).url).toContain('/assessment-b');
        expect(h.records).toHaveLength(2); ui.controller.destroy();
    });

    test('read-only unfinished assessments label their acknowledged answers as saved', async () => {
        const h = await backend(); await h.execute(createCommand());
        await h.execute(saveCommand('assessment-a', 0, 'read-only-progress', allResponses('unknown').slice(0, 1)));
        const ui = await resumeUi(h, { presentationMode: 'read-only' });
        expect(byId(ui, 'ncsc-draft-progress').textContent).toBe('Saved answers: 1 of 14 answers selected · 0 resolved · 13 unanswered. Counts are not a score.');
        expect(control(ui, 'Save progress')).toBeUndefined();
        expect(ui.root.querySelectorAll('input').filter(input => input.type === 'radio').every(input => input.disabled)).toBe(true);
        control(ui, 'Next unanswered question').click(); expect(h.records).toHaveLength(2);
        ui.controller.destroy();
    });
});

describe('question assistance source integration', () => {
    test.each(['', 'Private draft notes'])('explains without transmitting notes or offering an answer: %s', async text => {
        const h = await backend(), assistance = { suggest: jest.fn(async request => ({ questionId: request.questionId,
            status: 'suggested_not_confirmed', explanation: 'Describe who owns this process.', optionId: null,
            rationale: null, followUp: ['Who manages it?'], citations: [] })) };
        const ui = await createInUi(h, { assistance }), id = metadata().questions[0].id;
        enter(byId(ui, 'ncsc-assistance-notes-' + id), text);
        control(ui, 'Explain this question').click();
        await until(() => ui.root.textContent.includes('Describe who owns this process.'));
        expect(assistance.suggest.mock.calls[0][0]).toMatchObject({ mode: 'explain', notes: '' });
        expect(byId(ui, 'ncsc-assistance-notes-' + id).value).toBe(text);
        expect(control(ui, 'Use this answer in my draft')).toBeUndefined();
        expect(h.records).toHaveLength(1); ui.controller.destroy();
    });
    test('rejects an answer returned for an explanation-only request', async () => {
        const h = await backend(), ui = await createInUi(h, { assistance: { suggest: async () => suggestion() } });
        control(ui, 'Explain this question').click();
        await until(() => ui.root.textContent.includes('Assistance is unavailable'));
        expect(control(ui, 'Use this answer in my draft')).toBeUndefined();
        expect(h.records).toHaveLength(1); ui.controller.destroy();
    });
    test('trusted source attachment preserves explicit explanation intent through the pure contract', async () => {
        const { createQuestionAssistanceRequest: prepare, validateQuestionAssistanceResponse: validate } = require('../api/shared/questionnaireAssistance');
        const h = await backend(), requests = [], assistance = { suggest: async request => {
            const prepared = prepare({ questionId: request.questionId, mode: request.mode, notes: request.notes,
                sources: [{ id: 'doc1', version: 'v1', text: 'A named owner reviews the process monthly.' }] });
            const input = JSON.parse(prepared.inputJson); requests.push(input);
            // A deterministic provider fixture follows the declared intent with
            // context attached; no live model or evidence access is exercised.
            return validate(prepared, JSON.stringify({ explanation: 'Identify who owns this process.',
                optionId: input.mode === 'explain' ? null : 'partial', rationale: null, followUp: [],
                citations: input.mode === 'explain' ? [] : [{ sourceId: 'doc1', quote: 'reviews the process monthly' }] }));
        } };
        const ui = await createInUi(h, { assistance }), id = metadata().questions[0].id;
        enter(byId(ui, 'ncsc-assistance-notes-' + id), 'Private draft notes');
        control(ui, 'Explain this question').click();
        await until(() => ui.root.textContent.includes('Identify who owns this process.'));
        expect(requests[0]).toMatchObject({ mode: 'explain', notes: '' });
        expect(requests[0].sources).toHaveLength(1);
        expect(ui.root.textContent).not.toContain('Assistance is unavailable');
        expect(control(ui, 'Use this answer in my draft')).toBeUndefined();
        expect(byId(ui, 'ncsc-answer-' + id + '-partial').checked).toBe(false);
        expect(h.records).toHaveLength(1);
        control(ui, 'Suggest an answer').click();
        await until(() => control(ui, 'Use this answer in my draft'));
        expect(requests[1]).toMatchObject({ mode: 'suggest', notes: 'Private draft notes' });
        expect(h.records).toHaveLength(1); ui.controller.destroy();
    });
    test('keeps bounded notes per question through navigation and answer edits; clearing cancels requests', async () => {
        const h = await backend(), later = deferred(), assistance = { suggest: jest.fn(() => later.promise) };
        const ui = await createInUi(h, { assistance }), [first, second] = metadata().questions;
        enter(byId(ui, 'ncsc-assistance-notes-' + first.id), 'First question context');
        control(ui, 'Next question').click();
        expect(byId(ui, 'ncsc-assistance-notes-' + second.id).value).toBe('');
        enter(byId(ui, 'ncsc-assistance-notes-' + second.id), 'x'.repeat(4001));
        choose(ui, 0, 'partial');
        expect(byId(ui, 'ncsc-assistance-notes-' + first.id).value).toBe('First question context');
        control(ui, 'Suggest an answer').click(); control(ui, 'Clear these notes').click();
        expect(assistance.suggest.mock.calls[0][1].signal.aborted).toBe(true);
        later.resolve(suggestion()); await pause();
        expect(control(ui, 'Use this answer in my draft')).toBeUndefined();
        control(ui, 'Next question').click();
        expect(byId(ui, 'ncsc-assistance-notes-' + second.id).value).toHaveLength(4000);
        choose(ui, 0, 'no');
        expect(byId(ui, 'ncsc-assistance-notes-' + first.id).value).toBe('');
        ui.controller.destroy();
    });
    test('notes are not restored in a new mount or saved as answer records', async () => {
        const h = await backend(), assistance = { suggest: jest.fn() }, ui = await createInUi(h, { assistance });
        const id = metadata().questions[0].id;
        enter(byId(ui, 'ncsc-assistance-notes-' + id), 'Ephemeral context only');
        choose(ui, 0, 'partial'); control(ui, 'Save progress').click();
        await until(() => h.records.length === 2);
        expect(JSON.stringify(h.records)).not.toContain('Ephemeral context only');
        ui.controller.destroy();
        const resumed = await resumeUi(h, { assistance });
        const selector = byId(resumed, 'ncsc-question-index'); selector.value = '0'; event(selector, 'change');
        expect(byId(resumed, 'ncsc-assistance-notes-' + id).value).toBe('');
        resumed.controller.destroy();
    });
    test('leaving clears notes and detached controls cannot restore them or invoke assistance', async () => {
        const h = await backend(), assistance = { suggest: jest.fn() }, ui = await createInUi(h, { assistance });
        const id = metadata().questions[0].id, notes = byId(ui, 'ncsc-assistance-notes-' + id);
        const staleExplain = control(ui, 'Explain this question');
        enter(notes, 'Do not retain on reopen'); control(ui, 'Back to assessments').click();
        await until(() => savedActions(ui).length > 0);
        enter(notes, 'Detached stale event'); staleExplain.click();
        expect(assistance.suggest).not.toHaveBeenCalled();
        savedActions(ui)[0].click();
        await until(() => byId(ui, 'ncsc-assistance-notes-' + id));
        expect(byId(ui, 'ncsc-assistance-notes-' + id).value).toBe('');
        ui.controller.destroy();
    });
    test.each([false, true])('answer errors focus the correct field with assistance enabled (N/A: %s)', async na => {
        const h = await backend(), ui = await createInUi(h, { assistance: { suggest: jest.fn() } });
        const question = metadata().questions[0];
        if (na) choose(ui, 0, 'not_applicable', ' ');
        control(ui, 'Submit assessment').click(); await pause();
        const targetId = na ? `ncsc-rationale-${question.id}` : `ncsc-answer-${question.id}-${question.responseOptionIds[0]}`;
        const link = ui.root.querySelectorAll('a').find(item => item.href === '#' + targetId);
        expect(link).toBeDefined(); link.click();
        expect(ui.document.activeElement).toBe(byId(ui, targetId));
        expect(byId(ui, targetId).getAttribute('aria-invalid')).toBe('true');
        expect(byId(ui, 'ncsc-assistance-notes-' + question.id).getAttribute('aria-invalid')).not.toBe('true');
        expect(h.records).toHaveLength(1); ui.controller.destroy();
    });
    const suggestion = () => ({ questionId: metadata().questions[0].id, status: 'suggested_not_confirmed',
        explanation: '<b>Review this suggestion</b>', optionId: 'partial', rationale: null,
        followUp: ['Does this cover every system?'], citations: [{ sourceId: 'notes', quote: 'Some systems' }] });
    test('all questions retain guidance with explicit disabled AI fallback', async () => {
        const h = await backend(), ui = await createInUi(h);
        for (let i = 0; i < metadata().questions.length; i++) {
            const selector = byId(ui, 'ncsc-question-index'); selector.value = String(i); event(selector, 'change');
            expect(ui.root.textContent).toContain('Help me answer this question');
            expect(ui.root.textContent).toContain('not enabled in this assessment');
        }
        ui.controller.destroy();
    });
    test('requires explicit confirmation then existing Save; never renders model HTML', async () => {
        const h = await backend(), assistance = { suggest: jest.fn(async () => suggestion()) };
        const ui = await createInUi(h, { assistance });
        const id = metadata().questions[0].id;
        enter(byId(ui, 'ncsc-assistance-notes-' + id), 'Some systems');
        control(ui, 'Suggest an answer').click(); await until(() => control(ui, 'Use this answer in my draft'));
        expect(ui.root.querySelector('b')).toBeNull();
        expect(byId(ui, 'ncsc-answer-' + id + '-partial').checked).toBe(false);
        expect(h.records).toHaveLength(1);
        control(ui, 'Use this answer in my draft').click();
        expect(byId(ui, 'ncsc-answer-' + id + '-partial').checked).toBe(true);
        expect(h.records).toHaveLength(1);
        control(ui, 'Save progress').click(); await until(() => h.records.length === 2);
        expect(h.records[1].payload.responses[0].optionId).toBe('partial');
        ui.controller.destroy();
    });
    test('navigation aborts and ignores delayed suggestions', async () => {
        const h = await backend(), deferredResult = deferred(), assistance = { suggest: jest.fn(() => deferredResult.promise) };
        const ui = await createInUi(h, { assistance });
        enter(byId(ui, 'ncsc-assistance-notes-' + metadata().questions[0].id), 'Some systems');
        control(ui, 'Suggest an answer').click(); control(ui, 'Next question').click();
        expect(assistance.suggest.mock.calls[0][1].signal.aborted).toBe(true);
        deferredResult.resolve(suggestion()); await pause();
        expect(control(ui, 'Use this answer in my draft')).toBeUndefined(); ui.controller.destroy();
    });
    test('provider failure preserves manual draft and hides provider details', async () => {
        const h = await backend(), ui = await createInUi(h, { assistance: { suggest: async () => { throw new Error('private-provider-token'); } } });
        choose(ui, 0, 'no');
        enter(byId(ui, 'ncsc-assistance-notes-' + metadata().questions[0].id), 'Some systems');
        control(ui, 'Suggest an answer').click(); await until(() => ui.root.textContent.includes('Assistance is unavailable'));
        expect(ui.root.textContent).not.toContain('private-provider-token');
        expect(byId(ui, 'ncsc-answer-' + metadata().questions[0].id + '-no').checked).toBe(true); ui.controller.destroy();
    });
    test('editing the answer invalidates an outstanding suggestion', async () => {
        const h = await backend(), later = deferred();
        const ui = await createInUi(h, { assistance: { suggest: () => later.promise } });
        enter(byId(ui, 'ncsc-assistance-notes-' + metadata().questions[0].id), 'Some systems');
        control(ui, 'Suggest an answer').click(); choose(ui, 0, 'no');
        later.resolve(suggestion()); await pause();
        expect(control(ui, 'Use this answer in my draft')).toBeUndefined();
        expect(byId(ui, 'ncsc-answer-' + metadata().questions[0].id + '-no').checked).toBe(true); ui.controller.destroy();
    });
    test.each([{ questionId: 'other' }, { optionId: 'certified' }, { citations: [] }])('rejects invalid suggestion DTO %j', delta => {
        return (async () => {
            const h = await backend(), ui = await createInUi(h, { assistance: { suggest: async () => ({ ...suggestion(), ...delta }) } });
            enter(byId(ui, 'ncsc-assistance-notes-' + metadata().questions[0].id), 'Some systems');
            control(ui, 'Suggest an answer').click(); await until(() => ui.root.textContent.includes('Assistance is unavailable'));
            expect(control(ui, 'Use this answer in my draft')).toBeUndefined(); expect(h.records).toHaveLength(1); ui.controller.destroy();
        })();
    });
});

describe('submitted assessment results', () => {
    const resultModel = require('../api/shared/protectedAssets/ncscQuestionnaire').resultModel;
    async function submitted(option = 'yes') {
        const h = await backend(); await h.execute(createCommand()); await h.execute(saveCommand('assessment-a', 0, 'save-a', allResponses(option)));
        const response = await h.execute(submitCommand()); return { h, assessment: response.assessment };
    }
    test.each([['yes', '100.0%', 0], ['no', '0.0%', 0], ['partial', '50.0%', 0],
        ['unknown', '0.0%–100.0%', 14], ['not_applicable', '0.0%–100.0%', 14]])('projects actual server %s output without inventing evidence or risk', async (option, attainment, unknown) => {
        const { h, assessment } = await submitted(option), before = clone(assessment), model = resultModel(assessment, metadata(), h.organisationId);
        expect(model).toMatchObject({ attainment, unknown, substantiated: '0.0%', tested: '0.0%', pending: option === 'not_applicable' ? 14 : 0 });
        expect(model.inputs).toContainEqual(['Output SHA-256', assessment.submission.evaluation.outputSha256]);
        expect(model.domains.flatMap(domain => domain.controls.flatMap(control => control.questions))).toHaveLength(14);
        expect(assessment).toEqual(before);
    });
    test('rejects coherently rescaled weights that contradict the accepted profile', async () => {
        expect(createAcceptedNcscFrameworkProfile().questions.every(question => question.weight === 1)).toBe(true);
        const { h, assessment } = await submitted();
        const evaluation = assessment.submission.evaluation;
        evaluation.atoms.forEach(atom => { atom.weight *= 2; atom.lowerCreditUnits *= 2; atom.upperCreditUnits *= 2; });
        [evaluation, ...evaluation.domains, ...evaluation.controls].forEach(group => {
            group.attainment.denominatorWeight *= 2;
            group.attainment.lowerCreditUnits *= 2; group.attainment.upperCreditUnits *= 2;
        });
        // Counts, coverage and percentage ranges still agree; only the weight contract is false.
        expect(resultModel(assessment, metadata(), h.organisationId)).toBeNull();
    });
    test.each(['attested', 'independently_reviewed_current'])('rejects coherent %s evidence claims absent from this saved-assessment adapter', async evidenceState => {
        const { h, assessment } = await submitted(), evaluation = assessment.submission.evaluation;
        evaluation.atoms.forEach(atom => { atom.evidenceState = evidenceState; });
        [evaluation, ...evaluation.domains, ...evaluation.controls].forEach(group => {
            const evidence = group.evidence;
            Object.keys(evidence.distribution).forEach(key => { evidence.distribution[key] = key === evidenceState ? evidence.denominator : 0; });
            ['providedCoverage', 'substantiatedCoverage', 'testedCoverage'].forEach(key => {
                const covered = key === 'providedCoverage' || evidenceState === 'independently_reviewed_current';
                evidence[key].numerator = covered ? evidence.denominator : 0;
                evidence[key].percentTenths = covered ? 1000 : 0;
                evidence[key].display = covered ? '100.0%' : '0.0%';
            });
        });
        expect(resultModel(assessment, metadata(), h.organisationId)).toBeNull();
    });
    test('new submission and reopening show separate measures and native drill-downs', async () => {
        const h = await backend(), ui = await createInUi(h);
        metadata().questions.forEach((_, index) => choose(ui, index, 'yes'));
        control(ui, 'Submit assessment').click(); await until(() => ui.root.textContent.includes('Calculation inputs and versions'));
        const panel = ui.root.querySelector('.ncsc-results');
        expect(panel.getAttribute('aria-label')).toBe('Assessment results');
        const metrics = panel.querySelectorAll('.ncsc-result-metric');
        expect(metrics.map(card => card.querySelector('h3').textContent)).toEqual(['Reported implementation', 'Resolved answers', 'Supporting evidence']);
        expect(metrics[0].querySelector('.ncsc-result-value').textContent).toBe('100.0%');
        expect(metrics[2].querySelector('.ncsc-result-value').textContent).toBe('0.0%');
        expect(metrics[2].textContent).toContain('Confidence is not assessed.');
        expect(panel.textContent).toContain('Not calculated'); expect(panel.textContent).toContain('No comparison available');
        expect(panel.querySelectorAll('.ncsc-result-control')).toHaveLength(metadata().controls.length);
        expect(panel.textContent).toContain('Suggested next actions'); expect(panel.textContent).toContain('Useful evidence');
        expect(panel.textContent).toContain('not an audit or certification');
        const before = panel.textContent; ui.controller.destroy(); expect(ui.root.textContent).toBe('');
        const restored = await resumeUi(h, { presentationMode: 'read-only' });
        expect(restored.root.querySelector('.ncsc-results').textContent).toBe(before);
        expect(control(restored, 'Submit assessment')).toBeUndefined(); restored.controller.destroy();
    });
    test('mixed answers display the independently specified golden range and pending rationale as plain text', async () => {
        const h = await backend(), source = require('./fixtures/ncscAcceptedEvaluation.json');
        const rationale = '<img src=x onerror=alert(1)> Synthetic pending claim';
        await h.execute(createCommand());
        await h.execute(saveCommand('assessment-a', 0, 'mixed-save', source.input.atomInputs.map(atom => ({ itemId: atom.itemId,
            optionId: atom.response.optionId, rationale: atom.response.optionId === 'not_applicable' ? { text: rationale } : null }))));
        await h.execute(submitCommand()); const ui = await resumeUi(h);
        const panel = ui.root.querySelector('.ncsc-results');
        expect(panel.textContent).toContain('46.4%–60.7%');
        const resolved = panel.querySelectorAll('.ncsc-result-metric').find(card => card.querySelector('h3').textContent === 'Resolved answers');
        expect(resolved.textContent).toContain('12 of 14'); expect(resolved.textContent).toContain('85.7%');
        const assessment = (await h.client.read('assessment-a')).assessment;
        const projected = resultModel(assessment, metadata(), h.organisationId);
        expect(projected).toMatchObject({ denominatorWeight: 14, lowerCreditUnits: 13, upperCreditUnits: 17 });
        projected.domains.forEach((domain, index) => {
            const evaluated = assessment.submission.evaluation.domains[index];
            expect(domain).toMatchObject({ lowerPercentTenths: evaluated.attainment.lowerPercentTenths,
                upperPercentTenths: evaluated.attainment.upperPercentTenths, denominatorWeight: evaluated.attainment.denominatorWeight,
                completed: evaluated.countsCompletion.completionNumerator, total: evaluated.countsCompletion.completionDenominator });
        });
        expect(panel.textContent).toContain('Unknown or unresolved answers: 2. Pending N/A claims: 1.');
        expect(panel.textContent).toContain(rationale); expect(panel.querySelectorAll('img')).toHaveLength(0);
        expect(panel.querySelectorAll('script')).toHaveLength(0); ui.controller.destroy();
    });
    test.each([
        ['wrong profile', a => { a.submission.evaluation.provenance.profileRef.catalogueSha256 = 'f'.repeat(64); }],
        ['wrong revision', a => { a.submission.evaluation.provenance.assessmentRevision = 'rev-99'; }],
        ['wrong organisation', a => { a.submission.evaluation.provenance.organisationId = 'other-organisation'; }],
        ['wrong assessment', a => { a.submission.evaluation.provenance.assessmentId = 'another-assessment'; }],
        ['wrong time', a => { a.submission.evaluation.provenance.scoreAsOf = '2026-09-01T00:00:00.000Z'; }],
        ['missing control', a => { a.submission.evaluation.controls.pop(); }],
        ['duplicate control', a => { a.submission.evaluation.controls[1] = a.submission.evaluation.controls[0]; }],
        ['wrong question mapping', a => { a.submission.evaluation.atoms[0].controlId = 'other-control'; }],
        ['changed saved answer', a => { a.responses[0].optionId = 'no'; }],
        ['invalid range', a => { a.submission.evaluation.attainment.upperPercentTenths = -1; }],
        ['misleading display', a => { a.submission.evaluation.attainment.lowerDisplay = 'Fully compliant'; }],
        ['invented risk', a => { a.submission.evaluation.remediationPriority.status = 'calculated'; }],
        ['unknown trend', a => { a.submission.evaluation.trend.status = 'improved'; }],
        ['missing hash', a => { delete a.submission.evaluation.outputSha256; }],
        ['wrong evidence snapshot digest', a => { a.submission.evaluation.provenance.evidenceSnapshot.sha256 = 'f'.repeat(64); }],
        ['wrong risk snapshot digest', a => { a.submission.evaluation.provenance.riskContextSnapshot.sha256 = 'f'.repeat(64); }],
        ['wrong mapping digest', a => { a.submission.evaluation.provenance.mappingSha256 = 'f'.repeat(64); }],
        ['wrong weight-set digest', a => { a.submission.evaluation.provenance.weightSetSha256 = 'f'.repeat(64); }],
        ['wrong scored-atom-set digest', a => { a.submission.evaluation.provenance.scoredAtomSetSha256 = 'f'.repeat(64); }],
        ['wrong applicability-basis digest', a => { a.submission.evaluation.provenance.applicabilityBasisSha256 = 'f'.repeat(64); }],
        ['unsupported rounding rule', a => { a.submission.evaluation.provenance.roundingRule = 'decimal-floor-v1'; }],
        ['unsupported evaluator', a => { a.submission.evaluation.provenance.evaluatorId = 'different-evaluator'; }],
        ['unsupported evaluator version', a => { a.submission.evaluation.provenance.evaluatorVersion = 'next-version'; }],
        ['unsupported evaluator source', a => { a.submission.evaluation.provenance.evaluatorSourceSha256 = 'f'.repeat(64); }],
        ['unsupported mapping version', a => { a.submission.evaluation.provenance.mappingVersion = 'next-mapping'; }],
        ['unsupported weight version', a => { a.submission.evaluation.provenance.weightSetVersion = 'next-weights'; }],
        ['impossible unknown count', a => { a.submission.evaluation.countsCompletion.unknown = 999; }],
        ['wrong coverage population', a => { a.submission.evaluation.evidence.substantiatedCoverage.denominator = 1; }],
        ['wrong evidence coverage', a => { const v = a.submission.evaluation.evidence.substantiatedCoverage; v.numerator = 14; v.percentTenths = 1000; v.display = '100.0%'; }],
        ['overall range disagrees with controls', a => { const v = a.submission.evaluation.attainment; v.lowerPercentTenths = 500; v.lowerDisplay = '50.0%'; }],
        ['domain credit disagrees with atoms', a => { a.submission.evaluation.domains[0].attainment.lowerCreditUnits = 0; }],
        ['atom credit disagrees with saved answer', a => { a.submission.evaluation.atoms[0].lowerCreditUnits = 0; }],
        ['control population disagrees with atoms', a => { a.submission.evaluation.controls[0].countsCompletion.totalAtoms = 2; }],
        ['unsupported approved N/A', a => { a.submission.evaluation.atoms[0].applicable = false; }],
        ['evidence distribution disagrees with atoms', a => { a.submission.evaluation.evidence.distribution.not_provided = 0; }],
        ['incomplete evidence', a => { delete a.submission.evaluation.evidence; }]
    ])('refuses %s while leaving the input untouched', async (_name, mutate) => {
        const { h, assessment } = await submitted(); mutate(assessment); const before = clone(assessment);
        expect(resultModel(assessment, metadata(), h.organisationId)).toBeNull(); expect(assessment).toEqual(before);
    });
    test.each([undefined, '', 'another-authorised-organisation'])('missing or different mount organisation %s never renders another organisation result', async organisationId => {
        const { h, assessment } = await submitted();
        expect(resultModel(assessment, metadata(), organisationId)).toBeNull();
        const ui = await resumeUi(h, { organisationId });
        expect(ui.root.textContent).toContain('Results are unavailable for this submission');
        expect(ui.root.querySelectorAll('.ncsc-result-metric')).toHaveLength(0);
        expect(control(ui, 'Submit assessment')).toBeUndefined(); ui.controller.destroy();
    });
    test('bad result projection retains submitted answers, never a partial score', async () => {
        const { h } = await submitted();
        const client = { ...h.client, read: async (...args) => {
            const result = clone(await h.client.read(...args)); result.assessment.submission.evaluation.evidence = null; return result;
        } };
        const ui = await resumeUi(h, { client });
        expect(ui.root.textContent).toContain('Results are unavailable for this submission');
        expect(ui.root.querySelectorAll('.ncsc-result-metric')).toHaveLength(0);
        expect(ui.root.querySelectorAll('input').every(input => input.disabled)).toBe(true);
        expect(control(ui, 'Submit assessment')).toBeUndefined(); ui.controller.destroy();
    });
    test('an old submitted response cannot populate a replacement tenant mount', async () => {
        const { h } = await submitted(), wait = deferred();
        const ui = mountUi(h, { client: { ...h.client, read: async (...args) => { const response = await h.client.read(...args); await wait.promise; return response; } } });
        await until(() => savedActions(ui).length > 0);
        savedActions(ui)[0].click();
        const replacementBackend = await backend({ tenantId: 'synthetic-results-other' });
        const replacement = mountUi(replacementBackend, { dom: ui });
        await until(() => replacement.root.textContent.includes('No saved assessments yet.'));
        wait.resolve(); await pause(); await pause();
        expect(replacement.root.textContent).not.toContain('Output SHA-256');
        expect(replacement.root.querySelector('.ncsc-results')).toBeNull(); replacement.controller.destroy();
    });
});

describe('questionnaire form accessibility', () => {
    test('every accepted question has visible input guidance and an illustrative example without changing or saving an answer', async () => {
        const h = await backend(); await h.execute(createCommand());
        const ui = mountUi(h, { initialAssessmentId: 'assessment-a' });
        try {
            await until(() => byId(ui, 'ncsc-question-index'));
            const retainedRecords = clone(h.records), retainedCalls = h.calls.length;
            const acceptedDisplay = JSON.stringify(metadata()), examples = new Set();
            for (const [index, question] of metadata().questions.entries()) {
                const picker = byId(ui, 'ncsc-question-index'); picker.value = String(index); event(picker, 'change');
                const fieldset = ui.root.querySelector('fieldset'), hint = byId(ui, 'ncsc-input-guidance-' + question.id);
                expect(fieldset.querySelector('legend').textContent).toBe(question.prompt);
                expect(hint.parentElement).toBe(fieldset);
                expect(hint.textContent.length).toBeGreaterThan(40);
                expect(hint.textContent).not.toBe(question.prompt);
                expect(hint.textContent).not.toBe(question.guidance.summary);
                expect(fieldset.getAttribute('aria-describedby')).toBe(hint.id);
                const guidance = ui.root.querySelectorAll('details').find(item => item.querySelector('summary').textContent === 'Guidance and evidence examples');
                const example = guidance.querySelector('.ncsc-input-example');
                expect(example.textContent).toMatch(/^Example: .+ (Yes|Partial|No|Unknown)\b/);
                examples.add(example.textContent);
                expect(guidance.textContent).toContain(question.guidance.summary);
                [...question.guidance.evidenceExamples, ...question.guidance.startingActions].forEach(text => expect(guidance.textContent).toContain(text));
                expect(guidance.textContent).toContain('records you can consult to check your answer');
                expect(guidance.textContent).toContain('Document upload is not enabled here.');
                expect(fieldset.querySelectorAll('input')).toHaveLength(question.responseOptionIds.length);
                expect(fieldset.querySelectorAll('input').every(input => input.checked === false)).toBe(true);
                expect(ui.root.querySelectorAll('textarea')).toHaveLength(0);
                expect(ui.root.querySelectorAll('input').some(input => input.type === 'file')).toBe(false);
            }
            expect(examples.size).toBe(metadata().questions.length);
            expect(JSON.stringify(metadata())).toBe(acceptedDisplay);
            expect(h.records).toEqual(retainedRecords); expect(h.calls).toHaveLength(retainedCalls);
            expect(h.calls.every(call => call.init.method === 'GET')).toBe(true);
        } finally { ui.controller.destroy(); }
    });

    test('reading examples and navigating preserves the person’s unsaved choice without a transport write', async () => {
        const h = await backend(); await h.execute(createCommand());
        const ui = mountUi(h, { initialAssessmentId: 'assessment-a' });
        try {
            await until(() => byId(ui, 'ncsc-question-index'));
            const retainedRecords = clone(h.records), retainedCalls = h.calls.length;
            choose(ui, 0, 'partial');
            const guidance = ui.root.querySelectorAll('details').find(item => item.querySelector('summary').textContent === 'Guidance and evidence examples');
            guidance.open = true;
            expect(guidance.querySelector('.ncsc-input-example').textContent).toContain('Example:');
            control(ui, 'Next question').click(); control(ui, 'Previous question').click();
            expect(byId(ui, 'ncsc-answer-' + metadata().questions[0].id + '-partial').checked).toBe(true);
            expect(ui.root.textContent).toContain('unsaved changes');
            expect(h.records).toEqual(retainedRecords); expect(h.calls).toHaveLength(retainedCalls);
        } finally { ui.controller.destroy(); }
    });

    test('native answer labels explain current implementation and pending N/A without suggesting an available approval action', async () => {
        const h = await backend(), ui = await createInUi(h), question = metadata().questions[0];
        const explanations = {
            yes: 'All parts of this statement are in place across your declared scope.',
            partial: 'Plans alone do not count.', no: 'including when work is only planned.',
            unknown: 'not have enough information', not_applicable: 'this remains unresolved.'
        };
        for (const [id, explanation] of Object.entries(explanations)) {
            const input = byId(ui, `ncsc-answer-${question.id}-${id}`), label = input.parentElement;
            expect(label.tagName).toBe('LABEL'); expect(label.getAttribute('for')).toBe(input.id);
            expect(byId(ui, input.getAttribute('aria-labelledby')).textContent).toBe(metadata().responseOptions.find(option => option.id === id).label);
            expect(byId(ui, input.getAttribute('aria-describedby')).textContent).toContain(explanation);
        }
        choose(ui, 0, 'not_applicable', 'Synthetic pending exclusion.');
        const help = byId(ui, `ncsc-rationale-help-${question.id}`);
        expect(byId(ui, `ncsc-rationale-${question.id}`).getAttribute('aria-describedby')).toBe(help.id);
        expect(help.textContent).toContain('included in the score denominator');
        expect(help.textContent).toContain('N/A approval is not available in this journey.');
        expect(help.textContent).not.toContain('until reviewed');
        expect(h.records).toHaveLength(1); ui.controller.destroy();
    });

    test('official source links stay in question guidance and preserve the open draft in a separate tab', async () => {
        const h = await backend(), ui = await createInUi(h), question = metadata().questions[0];
        const guidance = ui.root.querySelectorAll('details').find(item => item.querySelector('summary').textContent === 'Guidance and evidence examples');
        expect(guidance.textContent).toContain('Why we ask'); expect(guidance.textContent).toContain(metadata().sourceDisclosure);
        const links = guidance.querySelectorAll('a');
        expect(links).toHaveLength(question.sources.length);
        links.forEach((link, index) => {
            expect(link.href).toBe(question.sources[index].url);
            expect(link.target).toBe('_blank'); expect(link.rel).toBe('noopener noreferrer');
            expect(link.textContent).toContain('opens in a new tab');
            expect(link.parentElement.textContent).toContain(question.sources[index].lastVerifiedAt);
        });
        const licence = ui.root.querySelector('.ncsc-provenance').querySelector('a');
        expect(licence.target).toBe('_blank'); expect(licence.rel).toBe('noopener noreferrer');
        expect(h.records).toHaveLength(1); ui.controller.destroy();
    });

    test('missing answers describe every radio and identify each question in the focused summary', async () => {
        const h = await backend(), ui = await createInUi(h), questions = metadata().questions;
        control(ui, 'Submit assessment').click(); await pause();
        const summary = ui.root.querySelector('.ncsc-errors'), links = summary.querySelectorAll('a');
        expect(ui.document.activeElement).toBe(summary);
        expect(links).toHaveLength(questions.length);
        expect(new Set(links.map(link => link.textContent)).size).toBe(questions.length);
        questions.forEach((question, index) => {
            expect(links[index].textContent).toBe('Question ' + (index + 1) + ': Choose an answer, including Unknown when appropriate.');
            expect(links[index].href).toBe('#ncsc-answer-' + question.id + '-' + question.responseOptionIds[0]);
        });
        links[1].click();
        const question = questions[1], errorId = `ncsc-error-${question.id}`;
        expect(ui.document.activeElement).toBe(byId(ui, `ncsc-answer-${question.id}-${question.responseOptionIds[0]}`));
        expect(ui.root.querySelector('fieldset').getAttribute('aria-describedby').split(' ')).toEqual(['ncsc-input-guidance-' + question.id, errorId]);
        for (const id of question.responseOptionIds) {
            const radio = byId(ui, `ncsc-answer-${question.id}-${id}`);
            expect(radio.getAttribute('aria-invalid')).toBe('true');
            expect(radio.getAttribute('aria-describedby')).toBe(radio.id + '-help ' + errorId);
            expect(byId(ui, errorId).textContent).toContain('Choose an answer');
        }
        expect(h.records).toHaveLength(1); ui.controller.destroy();
    });

    test('pending N/A errors describe the rationale and retain its help without invalidating radio choices', async () => {
        const h = await backend(), ui = await createInUi(h), question = metadata().questions[0];
        choose(ui, 0, 'not_applicable', ' ');
        control(ui, 'Save progress').click(); await pause();
        const summary = ui.root.querySelector('.ncsc-errors'); expect(ui.document.activeElement).toBe(summary);
        summary.querySelector('a').click();
        const rationale = byId(ui, `ncsc-rationale-${question.id}`);
        expect(ui.document.activeElement).toBe(rationale);
        expect(rationale.getAttribute('aria-describedby').split(' ')).toEqual([`ncsc-rationale-help-${question.id}`, `ncsc-error-${question.id}`]);
        expect(rationale.getAttribute('aria-invalid')).toBe('true');
        expect(ui.root.querySelector('fieldset').getAttribute('aria-describedby')).toBe('ncsc-input-guidance-' + question.id);
        expect(ui.root.querySelectorAll('input').every(input => input.getAttribute('aria-invalid') === null)).toBe(true);
        expect(h.records).toHaveLength(1); ui.controller.destroy();
    });

    test('a corrected scope has no obsolete validation error after a known create rejection', async () => {
        const h = await backend(), create = jest.fn(async () => { throw { code: 'ncsc_request_too_large', statusCode: 413, ambiguous: false }; });
        const ui = mountUi(h, { client: { ...h.client, create } });
        await until(() => control(ui, 'Start an assessment'));
        control(ui, 'Start an assessment').click(); control(ui, 'Create assessment').click();
        expect(byId(ui, 'ncsc-scope').getAttribute('aria-invalid')).toBe('true');
        enter(byId(ui, 'ncsc-scope'), 'Synthetic corrected scope.');
        const start = control(ui, 'Create assessment'); start.focus(); start.click();
        await until(() => ui.root.textContent.includes('too large for this operation'));
        expect(create).toHaveBeenCalledTimes(1);
        expect(byId(ui, 'ncsc-scope').value).toBe('Synthetic corrected scope.');
        expect(byId(ui, 'ncsc-scope').getAttribute('aria-invalid')).toBeNull();
        expect(byId(ui, 'ncsc-scope').getAttribute('aria-describedby')).toBe('ncsc-scope-help');
        expect(ui.root.querySelector('.ncsc-errors').hidden).toBe(true);
        expect(ui.root.textContent).not.toContain('Enter a nonblank scope');
        expect(h.records).toHaveLength(0); ui.controller.destroy();
    });

    test.each([false, true])('save failure updates the mounted live region and preserves focus ownership (outside: %s)', async outsideFocus => {
        const h = await backend(), wait = deferred(), save = jest.fn(async () => { await wait.promise; throw { code: 'ncsc_unavailable', statusCode: 503, ambiguous: true }; });
        const ui = await createInUi(h, { client: { ...h.client, save } }); choose(ui, 0, 'unknown');
        const status = ui.root.querySelector('[role="status"]');
        const submit = control(ui, 'Save progress'); submit.focus(); submit.click();
        await until(() => ui.root.textContent.includes('Operation in progress'));
        expect(ui.root.querySelector('[role="status"]')).toBe(status);
        const outside = ui.document.createElement('button'); if (outsideFocus) outside.focus();
        wait.resolve(); await until(() => ui.root.textContent.includes('This operation is unconfirmed'));
        expect(ui.root.querySelector('[role="status"]')).toBe(status);
        expect(status.getAttribute('aria-live')).toBe('polite'); expect(status.getAttribute('aria-atomic')).toBe('true');
        expect(status.textContent).toContain('Retry the same operation');
        expect(ui.document.activeElement).toBe(outsideFocus ? outside : status);
        expect(save).toHaveBeenCalledTimes(1); expect(h.records).toHaveLength(1); ui.controller.destroy();
    });

    test('save acknowledgment updates the existing live region', async () => {
        const h = await backend(), wait = deferred();
        const ui = await createInUi(h, { client: { ...h.client, save: async (...args) => { await wait.promise; return h.client.save(...args); } } });
        choose(ui, 0, 'unknown'); const status = ui.root.querySelector('[role="status"]');
        control(ui, 'Save progress').click();
        await until(() => ui.root.textContent.includes('Operation in progress'));
        expect(ui.root.querySelector('[role="status"]')).toBe(status);
        wait.resolve(); await until(() => status.textContent.includes('Your progress is saved.'));
        expect(ui.root.querySelector('[role="status"]')).toBe(status);
        expect(h.versions.values().next().value.envelope.revision).toBe(1); ui.controller.destroy();
    });

    test('a delayed save failure preserves newer typing and its focus and selection', async () => {
        const h = await backend(), wait = deferred();
        const ui = await createInUi(h, { client: { ...h.client, save: async () => { await wait.promise; throw { code: 'ncsc_unavailable', statusCode: 503, ambiguous: true }; } } });
        choose(ui, 0, 'not_applicable', 'Synthetic initial rationale.');
        const save = control(ui, 'Save progress'); save.focus(); save.click();
        await until(() => ui.root.textContent.includes('Operation in progress'));
        const id = `ncsc-rationale-${metadata().questions[0].id}`, input = byId(ui, id);
        enter(input, 'Synthetic newer typing.'); input.focus(); input.setSelectionRange(3, 7);
        wait.resolve(); await until(() => ui.root.textContent.includes('This operation is unconfirmed'));
        expect(ui.document.activeElement).toBe(byId(ui, id)); expect(byId(ui, id).value).toBe('Synthetic newer typing.');
        expect(byId(ui, id).selectionStart).toBe(3); expect(byId(ui, id).selectionEnd).toBe(7);
        expect(h.records).toHaveLength(1); ui.controller.destroy();
    });
});

describe('questionnaire public controls and retained mutation intent', () => {
    test('starting an assessment moves keyboard focus into the scope field', async () => {
        const h = await backend(), ui = mountUi(h);
        await until(() => ui.root.textContent.includes('No saved assessments yet.'));
        const start = control(ui, 'Start an assessment'); start.focus(); start.click();
        expect(ui.document.activeElement).toBe(byId(ui, 'ncsc-scope'));
        expect(ui.root.contains(ui.document.activeElement)).toBe(true);
    });

    test('clearing an answer retains an attached keyboard target and the unsaved state', async () => {
        const h = await backend(), ui = await createInUi(h);
        choose(ui, 0, 'not_applicable', 'Synthetic rationale');
        const clear = control(ui, 'Clear answer'); clear.focus(); clear.click();
        expect(ui.document.activeElement).toBe(control(ui, 'Clear answer'));
        expect(ui.root.contains(ui.document.activeElement)).toBe(true);
        expect(ui.root.querySelectorAll('input').every(input => !input.checked)).toBe(true);
        expect(byId(ui, `ncsc-rationale-${metadata().questions[0].id}`)).toBeUndefined();
    });

    test('saving retains an enabled focus target while pending and after acknowledgment', async () => {
        const h = await backend(), wait = deferred();
        const client = { ...h.client, save: async (...args) => { await wait.promise; return h.client.save(...args); } };
        const ui = await createInUi(h, { client }); choose(ui, 0, 'unknown');
        const save = control(ui, 'Save progress'); save.focus(); save.click();
        await until(() => ui.root.textContent.includes('Operation in progress'));
        expect(ui.root.contains(ui.document.activeElement)).toBe(true);
        expect(Boolean(ui.document.activeElement.disabled)).toBe(false);
        wait.resolve(); await until(() => ui.root.textContent.includes('Your progress is saved.'));
        expect(ui.root.contains(ui.document.activeElement)).toBe(true);
        expect(Boolean(ui.document.activeElement.disabled)).toBe(false);
        expect(h.versions.values().next().value.envelope.revision).toBe(1);
    });

    test('a delayed save never steals focus back from outside the questionnaire', async () => {
        const h = await backend(), wait = deferred();
        const client = { ...h.client, save: async (...args) => { await wait.promise; return h.client.save(...args); } };
        const ui = await createInUi(h, { client }); choose(ui, 0, 'unknown');
        const save = control(ui, 'Save progress'); save.focus(); save.click();
        await until(() => ui.root.textContent.includes('Operation in progress'));
        const outside = ui.document.createElement('button'); outside.focus();
        wait.resolve(); await until(() => ui.root.textContent.includes('Your progress is saved.'));
        expect(ui.document.activeElement).toBe(outside);
    });

    test('create, N/A rationale, explicit clear, destroy/remount and resume use acknowledged API progress', async () => {
        const h = await backend(), ui = await createInUi(h), question = metadata().questions[0];
        expect(ui.root.textContent).toContain(question.prompt);
        expect(ui.root.querySelector('fieldset').querySelector('legend').textContent).toBe(question.prompt);
        expect(ui.root.querySelectorAll('input').filter(input => input.type === 'radio').map(input => input.value)).toEqual(question.responseOptionIds);
        choose(ui, 0, 'not_applicable', '  Exact Māori claim\n界 \uD83D\uDE80  ');
        const rationale = byId(ui, `ncsc-rationale-${question.id}`); rationale.focus(); enter(rationale, rationale.value + '!');
        expect(byId(ui, rationale.id)).toBe(rationale); expect(ui.document.activeElement).toBe(rationale);
        expect(ui.root.textContent).toMatch(/unsaved/);
        control(ui, 'Save progress').click(); await until(() => h.records.filter(row => row.action === 'save').length === 1);
        await until(() => ui.root.textContent.includes('Your progress is saved'));
        expect(h.records[1].payload.responses).toEqual([{ itemId: question.id, optionId: 'not_applicable', rationale: { text: rationale.value } }]);
        expect(ui.root.querySelector('[role="status"]').getAttribute('aria-live')).toBe('polite');
        ui.controller.destroy(); const resumed = await resumeUi(h);
        expect(byId(resumed, 'ncsc-question-index').value).toBe('1');
        const selector = byId(resumed, 'ncsc-question-index'); selector.value = '0'; event(selector, 'change');
        expect(byId(resumed, rationale.id).value).toBe(rationale.value);
        expect(resumed.root.textContent).toMatch(/pending claim|pending N\/A/i);
        control(resumed, 'Clear answer').click(); control(resumed, 'Save progress').click();
        await until(() => h.records.filter(row => row.action === 'save').length === 2);
        expect(h.records.at(-1).payload.responses).toEqual([{ itemId: question.id, optionId: null, rationale: null }]);
        resumed.controller.destroy(); const final = await resumeUi(h);
        expect(final.root.querySelectorAll('input').filter(input => input.type === 'radio').every(input => !input.checked)).toBe(true);
        expect(final.root.textContent).toMatch(/Saved revision 2/); final.controller.destroy();
    });

    test.each([undefined, 'read-only', 'unknown', true])('missing or unknown presentation mode remains read-only: %s', async presentationMode => {
        const h = await backend(); await h.execute(createCommand());
        const ui = await resumeUi(h, { presentationMode });
        expect(control(ui, 'Save progress')).toBeUndefined(); expect(control(ui, 'Submit assessment')).toBeUndefined();
        expect(ui.root.querySelectorAll('input').every(input => input.disabled)).toBe(true);
        expect(h.records).toHaveLength(1); ui.controller.destroy();
    });

    test('invalid local N/A blocks save and submit of older complete server answers and links to the inactive question', async () => {
        const h = await backend(); await h.execute(createCommand()); await h.execute(saveCommand());
        const ui = await resumeUi(h); ui.window.location.hash = '#cyber-security';
        choose(ui, 0, 'not_applicable', ' '); choose(ui, 1, 'unknown');
        control(ui, 'Submit assessment').click(); await pause();
        expect(h.records).toHaveLength(2); expect(ui.root.querySelector('[role="alert"]')).toBeDefined();
        const link = ui.root.querySelectorAll('a').find(item => item.href === `#ncsc-rationale-${metadata().questions[0].id}`);
        expect(link).toBeDefined(); link.click();
        const invalid = byId(ui, `ncsc-rationale-${metadata().questions[0].id}`);
        expect(ui.document.activeElement).toBe(invalid); expect(invalid.getAttribute('aria-invalid')).toBe('true');
        expect(ui.window.location.hash).toBe('#cyber-security');
        control(ui, 'Save progress').click(); await pause(); expect(h.records).toHaveLength(2); ui.controller.destroy();
    });

    test.each([
        { text: '', kind: 'blank' }, { text: ' \n\t', kind: 'blank' },
        { text: '\u0000', kind: 'character' }, { text: '\uD800', kind: 'character' }, { text: '\uDC00', kind: 'character' },
        { text: 'x'.repeat(4001), kind: 'length' }, { text: '\uD83D\uDE80'.repeat(2001), kind: 'length' }
    ])('invalid declaration and rationale retain text with cause-specific copy: $kind %#', async ({ text, kind }) => {
        const h = await backend(), ui = mountUi(h); await until(() => control(ui, 'Start an assessment'));
        const expected = scope => kind === 'blank' ? scope ? 'Enter the assessment scope.' : 'Explain why this does not apply.'
            : kind === 'length' ? 'Shorten the ' + (scope ? 'scope' : 'explanation') + ' to 4,000 characters or fewer. Some emoji count as two.'
                : 'Re-enter the ' + (scope ? 'scope' : 'explanation') + ' to remove an unsupported character.';
        try {
            control(ui, 'Start an assessment').click(); enter(byId(ui, 'ncsc-scope'), text); control(ui, 'Create assessment').click(); await pause();
            expect(h.records).toHaveLength(0); expect(byId(ui, 'ncsc-scope').value).toBe(text);
            expect(ui.root.querySelector('.ncsc-errors').textContent).toContain('Assessment scope: ' + expected(true));
            expect(ui.root.querySelector('.ncsc-errors').textContent).not.toMatch(/UTF-16|NUL|Unicode|nonblank/);
            enter(byId(ui, 'ncsc-scope'), 'Synthetic corrected declaration'); control(ui, 'Create assessment').click(); await until(() => control(ui, 'Save progress'));
            choose(ui, 0, 'not_applicable', text); control(ui, 'Save progress').click(); await pause();
            expect(h.records).toHaveLength(1); expect(byId(ui, `ncsc-rationale-${metadata().questions[0].id}`).value).toBe(text);
            const summary = ui.root.querySelector('.ncsc-errors');
            expect(summary.textContent).toContain('Question 1: ' + expected(false));
            expect(summary.textContent).not.toContain(metadata().questions[0].prompt);
            expect(summary.textContent).not.toMatch(/UTF-16|NUL|Unicode|nonblank/);
            expect(byId(ui, `ncsc-error-${metadata().questions[0].id}`).textContent).toBe(expected(false));
        } finally { ui.controller.destroy(); }
    });

    test('valid paired emoji at the existing text limit keep their exact scope and rationale semantics', async () => {
        const h = await backend(), ui = mountUi(h), text = '\uD83D\uDE80'.repeat(2000);
        try {
            await until(() => control(ui, 'Start an assessment'));
            control(ui, 'Start an assessment').click(); enter(byId(ui, 'ncsc-scope'), text); control(ui, 'Create assessment').click();
            await until(() => control(ui, 'Save progress'));
            expect(h.records[0].payload.scopePopulation.description).toBe(text);
            choose(ui, 0, 'not_applicable', text); control(ui, 'Save progress').click();
            await until(() => ui.root.textContent.includes('Your progress is saved.'));
            expect(h.records.at(-1).payload.responses[0].rationale.text).toBe(text);
            expect(ui.root.querySelector('.ncsc-errors').hidden).toBe(true);
        } finally { ui.controller.destroy(); }
    });

    test('known no-policy submit denial keeps the saved draft editable and allows leaving', async () => {
        const h = await backend();
        await h.execute(createCommand()); await h.execute(saveCommand());
        const submit = jest.fn(async () => {
            throw Object.assign(new Error('ncsc_submission_unavailable'),
                { code: 'ncsc_submission_unavailable', statusCode: 409, ambiguous: false });
        });
        const ui = await resumeUi(h, { client: { ...h.client, submit } });
        control(ui, 'Submit assessment').click();
        await until(() => ui.root.textContent.includes('Submission is not available yet.'));
        expect(submit).toHaveBeenCalledTimes(1);
        expect(control(ui, 'Retry same operation')).toBeUndefined();
        expect(control(ui, 'Save progress').disabled).toBe(false);
        choose(ui, 0, 'no'); control(ui, 'Save progress').click();
        await until(() => h.records.filter(row => row.action === 'save').length === 2);
        control(ui, 'Back to assessments').click();
        await until(() => savedActions(ui).length === 1);
        expect(h.records.some(row => row.action === 'submit')).toBe(false);
        ui.controller.destroy();
    });

    test('Unknown and pending N/A complete answers submit without scores, approval or editable sealed controls', async () => {
        const h = await backend(), ui = await createInUi(h);
        metadata().questions.forEach((_question, index) => choose(ui, index, index === 0 ? 'not_applicable' : 'unknown', index === 0 ? 'Synthetic pending claim' : undefined));
        control(ui, 'Submit assessment').click(); await until(() => h.records.some(row => row.action === 'submit'));
        await until(() => control(ui, 'Save progress') === undefined);
        const version = [...h.versions.values()][0]; expect(version.envelope.state.status).toBe('submitted');
        expect(version.envelope.submission.evaluation.countsCompletion.claimedNotApplicableAtoms).toBe(1);
        expect(control(ui, 'Submit assessment')).toBeUndefined(); expect(ui.root.textContent).toMatch(/Submitted|submitted/);
        expect(ui.root.textContent).not.toMatch(/overall score|Issue report|Approve N\/A/);
        expect(ui.root.textContent).toContain('Output SHA-256');
        expect(ui.root.querySelectorAll('input').every(input => input.disabled)).toBe(true); ui.controller.destroy();
        const restored = await resumeUi(h); expect(control(restored, 'Save progress')).toBeUndefined(); restored.controller.destroy();
    });

    test('multibyte rationales save in serial whole-answer batches without truncation or oversized commands', async () => {
        const h = await backend(), ui = await createInUi(h), text = '界'.repeat(4000);
        metadata().questions.forEach((_question, index) => choose(ui, index, 'not_applicable', text));
        control(ui, 'Save progress').click(); await until(() => ui.root.textContent.includes('Your progress is saved'));
        const saves = h.records.filter(row => row.action === 'save'); expect(saves.length).toBeGreaterThan(1);
        expect(saves.map(row => row.expectedRevision)).toEqual(saves.map((_row, index) => index));
        saves.forEach(row => { expect(Buffer.byteLength(JSON.stringify(row), 'utf8')).toBeLessThanOrEqual(65536); expect(normaliseNcscCommand(row)).toEqual(row); });
        expect(saves.flatMap(row => row.payload.responses).map(row => row.itemId)).toEqual(metadata().questions.map(row => row.id).sort());
        expect(saves.flatMap(row => row.payload.responses).every(row => row.rationale.text === text)).toBe(true); ui.controller.destroy();
    });

    test('editing a pending batch retains newer generations and duplicate Save clicks produce one operation', async () => {
        const h = await backend(), wait = deferred(); let entered = false;
        const save = jest.fn(async (...args) => { const result = await h.client.save(...args); entered = true; await wait.promise; return result; });
        const ui = await createInUi(h, { client: { ...h.client, save } });
        choose(ui, 0, 'not_applicable', 'Captured draft'); control(ui, 'Save progress').click(); control(ui, 'Save progress').click();
        await until(() => entered); const id = `ncsc-rationale-${metadata().questions[0].id}`;
        enter(byId(ui, id), 'Newer typing must survive'); byId(ui, id).focus(); byId(ui, id).setSelectionRange(4, 8);
        wait.resolve(); await until(() => ui.root.textContent.includes('Newer edits are still unsaved'));
        expect(save).toHaveBeenCalledTimes(1); expect(byId(ui, id).value).toBe('Newer typing must survive');
        expect(ui.document.activeElement.id).toBe(id); expect(ui.document.activeElement.selectionStart).toBe(4);
        expect(h.records.at(-1).payload.responses[0].rationale.text).toBe('Captured draft');
        control(ui, 'Save progress').click(); await until(() => h.records.filter(row => row.action === 'save').length === 2);
        expect(h.records.at(-1).payload.responses[0].rationale.text).toBe('Newer typing must survive'); ui.controller.destroy();
    });

    test.each(['ncsc_unavailable', 'ncsc_outcome_ambiguous', 'transport'])('uncertain %s retains its exact command and blocks managed discard until explicit retry/read', async code => {
        const h = await backend(); let lost = true;
        const save = jest.fn(async (...args) => {
            const result = await h.client.save(...args);
            if (lost) { lost = false; if (code === 'transport') throw new Error('connection lost');
                throw Object.assign(new Error(code), { code, statusCode: 503, ambiguous: true }); }
            return result;
        });
        const read = jest.fn((...args) => h.client.read(...args));
        const ui = await createInUi(h, { client: { ...h.client, save, read } }); choose(ui, 0, 'yes');
        control(ui, 'Save progress').click(); await until(() => control(ui, 'Retry same operation'));
        expect(ui.root.textContent).toMatch(/unconfirmed/); expect(await ui.controller.requestLeave()).toBe(false);
        expect(control(ui, 'Discard unsent changes')).toBeUndefined(); const original = clone(save.mock.calls[0][0]);
        control(ui, 'Retry same operation').click(); await until(() => read.mock.calls.length === 1 && !control(ui, 'Retry same operation'));
        expect(save).toHaveBeenCalledTimes(2); expect(save.mock.calls[1][0]).toEqual(original);
        expect(h.records.filter(row => row.action === 'save')).toHaveLength(1);
        expect(h.versions.values().next().value.envelope.revision).toBe(1); ui.controller.destroy();
    });

    test('new typing in a previously clean answer survives delayed required reconciliation and restores focus/selection', async () => {
        const h = await backend(); await h.execute(createCommand());
        const rows = allResponses('yes'); rows[0] = { ...rows[0], optionId: 'not_applicable', rationale: { text: 'Saved one' } };
        rows[1] = { ...rows[1], optionId: 'not_applicable', rationale: { text: 'Saved two' } };
        await h.execute(saveCommand('assessment-a', 0, 'seed', rows));
        let lose = true, holdRead = false, entered = false; const gate = deferred();
        const save = jest.fn(async (...args) => { const result = await h.client.save(...args); if (lose) { lose = false; throw Object.assign(new Error('lost'), { statusCode: 503, code: 'ncsc_unavailable' }); } return result; });
        const read = jest.fn(async (...args) => { if (holdRead) { entered = true; await gate.promise; } return h.client.read(...args); });
        const ui = await resumeUi(h, { client: { ...h.client, save, read } });
        choose(ui, 0, 'not_applicable', 'Draft one'); control(ui, 'Save progress').click(); await until(() => control(ui, 'Retry same operation'));
        holdRead = true; control(ui, 'Retry same operation').click(); await until(() => entered);
        choose(ui, 1, 'not_applicable', 'New text during current GET');
        const id = `ncsc-rationale-${metadata().questions[1].id}`; byId(ui, id).focus(); byId(ui, id).setSelectionRange(5, 8);
        await h.execute(saveCommand('assessment-a', 2, 'other-session', [{ ...rows[1], rationale: { text: 'Another saved change' } }]));
        gate.resolve(); await until(() => control(ui, 'Keep my draft on current revision'));
        expect(byId(ui, id).value).toBe('New text during current GET'); expect(ui.document.activeElement.id).toBe(id);
        expect(ui.document.activeElement.selectionStart).toBe(5); expect(h.records).toHaveLength(4);
        control(ui, 'Keep my draft on current revision').click(); control(ui, 'Save progress').click();
        await until(() => h.records.length === 5);
        expect(h.records.at(-1)).toMatchObject({ expectedRevision: 3, payload: { responses: [{ itemId: rows[1].itemId,
            optionId: 'not_applicable', rationale: { text: 'New text during current GET' } }] } }); ui.controller.destroy();
    });

    test('failed required GET after a successful retry prevents later writes until explicit successful reload', async () => {
        const h = await backend(); let lose = true, blockRead = false;
        const save = jest.fn(async (...args) => { const value = await h.client.save(...args); if (lose) { lose = false; throw Object.assign(new Error('lost'), { statusCode: 503 }); } return value; });
        const read = jest.fn(async (...args) => { if (blockRead) throw Object.assign(new Error('offline'), { statusCode: 503 }); return h.client.read(...args); });
        const ui = await createInUi(h, { client: { ...h.client, save, read } }); choose(ui, 0, 'yes');
        control(ui, 'Save progress').click(); await until(() => control(ui, 'Retry same operation'));
        blockRead = true; control(ui, 'Retry same operation').click(); await until(() => control(ui, 'Reload current saved answers'));
        const keep = control(ui, 'Keep my draft on current revision'); expect(keep.disabled).toBe(true);
        keep.click(); control(ui, 'Save progress')?.click(); await pause(); expect(save).toHaveBeenCalledTimes(2);
        blockRead = false; control(ui, 'Reload current saved answers').click(); await until(() => !control(ui, 'Keep my draft on current revision').disabled);
        ui.controller.destroy();
    });

    test.each(['Stay here', 'Discard unsent changes', 'Save and leave'])('managed leave uses one decision and the first commit: %s', async choice => {
        const h = await backend(), ui = await createInUi(h); choose(ui, 0, 'yes');
        const first = jest.fn(), later = jest.fn(), decision = ui.controller.requestLeave(first), repeated = ui.controller.requestLeave(later);
        expect(ui.root.querySelectorAll('[role="dialog"]')).toHaveLength(1);
        control(ui, choice).click(); await decision; await repeated; await pause();
        expect(later).not.toHaveBeenCalled(); expect(first).toHaveBeenCalledTimes(choice === 'Stay here' ? 0 : 1);
        expect(h.records.filter(row => row.action === 'save')).toHaveLength(choice === 'Save and leave' ? 1 : 0); ui.controller.destroy();
    });

    test('forced replacement with colliding IDs ignores delayed old list/detail and stale leave callbacks', async () => {
        const a = await backend({ tenantId: 'tenant-a' }), b = await backend({ tenantId: 'tenant-b' });
        await a.execute(createCommand('assessment-a', 'create-a', 'Tenant A secret draft')); await b.execute(createCommand('assessment-a', 'create-a', 'Tenant B retained text'));
        const gate = deferred(), pending = jest.fn(async (...args) => { await gate.promise; return a.client.read(...args); });
        const dom = interactiveDom(), old = mountUi(a, { dom, client: { ...a.client, read: pending } });
        await until(() => savedActions(old).length > 0);
        savedActions(old)[0].click(); await until(() => pending.mock.calls.length === 1);
        const fresh = await resumeUi(b, { dom }); const stable = fresh.root.textContent, focus = fresh.document.activeElement;
        gate.resolve(); await pause(); await pause(); old.controller.destroy();
        expect(fresh.root.textContent).toBe(stable); expect(fresh.document.activeElement).toBe(focus);
        expect(fresh.root.textContent).not.toContain('Tenant A'); expect(fresh.root.textContent).toContain('Tenant B retained text'); fresh.controller.destroy();
    });
});

describe('questionnaire boundary and navigation regressions', () => {
    test('JSONB profile key order on an exact committed replay preserves confirmation and the required fresh read', async () => {
        const h = await backend(); let attempts = 0;
        const fetch = jest.fn(async (url, init) => {
            const response = await h.fetch(url, init), value = await response.json();
            if (url.endsWith('/save')) {
                attempts += 1;
                if (attempts === 1) throw new Error('Synthetic response lost after commit');
                value.assessment.profileRef = Object.fromEntries(Object.entries(value.assessment.profileRef).reverse());
            }
            return reply(value, response.status, response.headers);
        });
        const client = clientModule.createClient({ metadata: metadata(), fetch }), ui = await createInUi(h, { client });
        choose(ui, 0, 'not_applicable', 'Exact rationale across a JSONB receipt replay.');
        control(ui, 'Save progress').click(); await until(() => control(ui, 'Retry same operation'));
        expect(await ui.controller.requestLeave()).toBe(false); control(ui, 'Retry same operation').click();
        await until(() => ui.root.textContent.includes('The operation is confirmed and the current saved version has been checked.'));
        const saves = fetch.mock.calls.filter(([url]) => url.endsWith('/save'));
        expect(saves).toHaveLength(2); expect(saves[1][1].body).toBe(saves[0][1].body);
        const assessmentId = h.records[0].assessmentId;
        expect(fetch.mock.calls.at(-1)[0]).toBe(`${PREFIX}/${encodeURIComponent(assessmentId)}`);
        expect(fetch.mock.calls.at(-1)[1].method).toBe('GET');
        expect(h.records).toHaveLength(2); expect(h.versions.get(assessmentId).envelope.revision).toBe(1);
        expect(byId(ui, `ncsc-rationale-${metadata().questions[0].id}`).value).toBe('Exact rationale across a JSONB receipt replay.');
        ui.controller.destroy();
    });

    test('JSONB profile key order on ordinary list and detail responses remains semantically valid', async () => {
        const h = await backend(); await h.execute(createCommand()); await h.execute(saveCommand());
        const fetch = jest.fn(async (...args) => {
            const response = await h.fetch(...args), value = await response.json();
            for (const assessment of value.assessments || [value.assessment]) {
                assessment.profileRef = Object.fromEntries(Object.entries(assessment.profileRef).reverse());
            }
            return reply(value, response.status, response.headers);
        });
        const client = clientModule.createClient({ metadata: metadata(), fetch });
        expect((await client.read('assessment-a')).assessment.profileRef).toEqual(metadata().profileRef);
        const ui = await resumeUi(h, { client });
        expect(byId(ui, `ncsc-answer-${metadata().questions[0].id}-yes`).checked).toBe(true);
        expect(control(ui, 'Submit assessment').disabled).toBe(false); ui.controller.destroy();
    });

    test.each(['changed', 'missing', 'extra', 'nonenumerable'])('profile semantic comparison still rejects %s pinned fields from a client adapter', async kind => {
        const h = await backend(); await h.execute(createCommand());
        const value = clone(await h.client.read('assessment-a'));
        if (kind === 'changed') value.assessment.profileRef.catalogueSha256 = 'f'.repeat(64);
        if (kind === 'missing') delete value.assessment.profileRef.frameworkId;
        if (kind === 'extra') value.assessment.profileRef.additionalProfile = 'unaccepted';
        if (kind === 'nonenumerable') Object.defineProperty(value.assessment.profileRef, 'frameworkId', { enumerable: false });
        const ui = mountUi(h, { client: { ...h.client, read: async () => value } });
        await until(() => savedActions(ui).length > 0);
        savedActions(ui)[0].click();
        await until(() => ui.root.textContent.includes('The saved assessment could not be loaded.'));
        expect(control(ui, 'Retry loading this assessment')).toBeDefined();
        expect(byId(ui, 'ncsc-question-index')).toBeUndefined();
        expect(control(ui, 'Save progress')).toBeUndefined(); expect(control(ui, 'Submit assessment')).toBeUndefined();
        expect(h.records).toHaveLength(1); ui.controller.destroy();
    });

    test('NCSC009 submit size413 at revision127 preserves answers and explains the exhausted save limit without cloning', async () => {
        const h = await backend(); await h.execute(createCommand()); await h.execute(saveCommand());
        const detail = clone((await h.client.read('assessment-a')).assessment); detail.revision = 127;
        const summary = clone(projectNcscSummary(h.versions.get('assessment-a'))); summary.revision = 127;
        const create = jest.fn(), save = jest.fn(), submit = jest.fn(async () => { throw Object.assign(new Error('size'), { code: 'ncsc_request_too_large', statusCode: 413, ambiguous: false }); });
        const ui = await resumeUi(h, { client: { ...h.client, create, save, submit,
            list: async () => ({ schemaVersion: 1, assessments: [summary], nextAfterAssessmentId: null }),
            read: async () => ({ schemaVersion: 1, assessment: detail }) } });
        control(ui, 'Submit assessment').click(); await until(() => ui.root.textContent.includes('This assessment has reached its save limit.'));
        expect(ui.root.textContent).toContain('Start a new assessment with shorter rationales.');
        expect(ui.root.textContent).not.toContain('Shorten one or more rationales, save the corrected draft');
        expect(control(ui, 'Retry same operation')).toBeUndefined();
        expect(byId(ui, `ncsc-answer-${metadata().questions[0].id}-yes`).checked).toBe(true);
        expect(submit).toHaveBeenCalledTimes(1); expect(submit.mock.calls[0][0].expectedRevision).toBe(127);
        expect(create).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); ui.controller.destroy();
    });

    test('NCSC009 save size413 preserves all unsent text, clears pending and accepts an explicit shorter draft', async () => {
        const h = await backend(); await h.execute(createCommand());
        const rows = allResponses('not_applicable').map(row => ({ ...row, rationale: { text: '\u0001'.repeat(4000) } }));
        for (let index = 0; index < 10; index += 2) await h.execute(saveCommand('assessment-a', index / 2, `seed-size-${index}`, rows.slice(index, index + 2)));
        const save = jest.fn((...args) => h.client.save(...args)), ui = await resumeUi(h, { client: { ...h.client, save } });
        for (let index = 10; index < rows.length; index += 1) choose(ui, index, 'not_applicable', rows[index].rationale.text);
        control(ui, 'Save progress').click(); await until(() => ui.root.textContent.includes('This assessment is too large for this operation.'));
        expect(ui.root.textContent).toContain('Shorten one or more rationales, save the corrected draft, then try again.');
        expect(control(ui, 'Retry same operation')).toBeUndefined(); expect(control(ui, 'Save progress').disabled).toBe(false);
        expect(h.records).toHaveLength(6); expect(save).toHaveBeenCalledTimes(1);
        const rejected = save.mock.calls[0][0];
        for (let index = 10; index < rows.length; index += 1) {
            const selector = byId(ui, 'ncsc-question-index'); selector.value = String(index); event(selector, 'change');
            expect(byId(ui, `ncsc-rationale-${metadata().questions[index].id}`).value).toBe(rows[index].rationale.text);
            enter(byId(ui, `ncsc-rationale-${metadata().questions[index].id}`), 'Shortened unsent claim.');
        }
        control(ui, 'Save progress').click(); await until(() => ui.root.textContent.includes('Saved revision 6.'));
        expect(save).toHaveBeenCalledTimes(2); expect(save.mock.calls[1][0].idempotencyKey).not.toBe(rejected.idempotencyKey);
        expect(save.mock.calls[1][0].expectedRevision).toBe(rejected.expectedRevision);
        const saved = (await h.client.read('assessment-a')).assessment;
        expect(saved.progress.answered).toBe(rows.length);
        expect(saved.responses.filter(row => rows.slice(10).some(item => item.itemId === row.itemId)).map(row => row.rationale.text))
            .toEqual(rows.slice(10).map(() => 'Shortened unsent claim.'));
        ui.controller.destroy();
    });

    test('NCSC009 submit size413 retains saved answers and permits shortening, saving and a fresh submit', async () => {
        const h = await backend(); await h.execute(createCommand());
        const rows = allResponses('not_applicable').map(row => ({ ...row, rationale: { text: '\u0001'.repeat(2800) } }));
        for (let index = 0; index < rows.length; index += 2) await h.execute(saveCommand('assessment-a', index / 2, `seed-submit-size-${index}`, rows.slice(index, index + 2)));
        const submit = jest.fn((...args) => h.client.submit(...args)), ui = await resumeUi(h, { client: { ...h.client, submit } });
        control(ui, 'Submit assessment').click(); await until(() => ui.root.textContent.includes('This assessment is too large for this operation.'));
        expect(control(ui, 'Retry same operation')).toBeUndefined(); expect(submit).toHaveBeenCalledTimes(1);
        expect(h.records).toHaveLength(8); const rejected = submit.mock.calls[0][0];
        expect(byId(ui, `ncsc-rationale-${metadata().questions[0].id}`).value).toBe(rows[0].rationale.text);
        choose(ui, 0, 'not_applicable', 'Shortened first claim.'); choose(ui, 1, 'not_applicable', 'Shortened second claim.');
        control(ui, 'Save progress').click(); await until(() => ui.root.textContent.includes('Saved revision 8.'));
        control(ui, 'Submit assessment').click(); await until(() => ui.root.textContent.includes('Answers below are the saved, read-only submission.'));
        expect(submit).toHaveBeenCalledTimes(2); expect(submit.mock.calls[1][0].idempotencyKey).not.toBe(rejected.idempotencyKey);
        expect(submit.mock.calls[1][0].expectedRevision).toBe(8);
        const sealed = (await h.client.read('assessment-a')).assessment;
        expect(sealed).toMatchObject({ status: 'submitted', revision: 9 });
        expect(sealed.responses.filter(row => rows.slice(2).some(item => item.itemId === row.itemId)).map(row => row.rationale.text))
            .toEqual(rows.slice(2).map(row => row.rationale.text));
        ui.controller.destroy();
    });

    test('an uncertain later batch keeps its exact key, acknowledged progress and remaining unsent answers', async () => {
        const h = await backend(); let attempt = 0;
        const save = jest.fn(async (...args) => {
            const result = await h.client.save(...args); attempt += 1;
            if (attempt === 2) throw Object.assign(new Error('lost later batch'), { code: 'ncsc_unavailable', statusCode: 503 });
            return result;
        });
        const ui = await createInUi(h, { client: { ...h.client, save } });
        metadata().questions.forEach((_question, index) => choose(ui, index, 'not_applicable', '界'.repeat(4000)));
        control(ui, 'Save progress').click(); await until(() => control(ui, 'Retry same operation'));
        expect(save).toHaveBeenCalledTimes(2);
        const first = save.mock.calls[0][0], pending = clone(save.mock.calls[1][0]);
        expect(first.idempotencyKey).not.toBe(pending.idempotencyKey);
        expect(ui.root.textContent).toContain(`Saved responses: ${first.payload.responses.length} of 14 selected`);
        expect(control(ui, 'Submit assessment').disabled).toBe(true);
        const leave = jest.fn(); expect(await ui.controller.requestLeave(leave)).toBe(false); expect(leave).not.toHaveBeenCalled();
        control(ui, 'Retry same operation').click();
        await until(() => ui.root.textContent.includes('The operation is confirmed and the current saved version has been checked.'));
        expect(save).toHaveBeenCalledTimes(3); expect(save.mock.calls[2][0]).toEqual(pending);
        expect(h.records.filter(row => row.action === 'save')).toHaveLength(2);
        expect(byId(ui, `ncsc-rationale-${metadata().questions.at(-1).id}`).value).toBe('界'.repeat(4000));
        control(ui, 'Save progress').click(); await until(() => ui.root.textContent.includes('Your progress is saved.'));
        expect(save).toHaveBeenCalledTimes(4);
        expect(h.records.filter(row => row.action === 'save')).toHaveLength(3);
        expect((await h.client.read(first.assessmentId)).assessment.responses.map(row => row.rationale.text)).toEqual(metadata().questions.map(() => '界'.repeat(4000)));
        ui.controller.destroy();
    });

    test.each(['assessment', 'module'])('actual renderer and shell share the first managed leave target: %s first', async firstTarget => {
        const h = await backend(), dom = interactiveDom();
        const shell = require('../api/shared/protectedAssets/dashboardShell');
        const renderer = require('../api/shared/protectedAssets/ncscQuestionnaire');
        const { projectDashboard } = require('../api/shared/appLifecycle/dashboardProjection');
        const { fixture } = require('./fixtures/dashboardFixture');
        const projection = clone(projectDashboard(fixture()));
        projection.modules.find(item => item.key === 'cyber_security').state = 'ready';
        let sequence = 0;
        const controller = shell.mount(dom.root, projection, { initialRoute: 'cyber-security', window: dom.window,
            mountCyber: (root, { generation }) => renderer.mount(root, { metadata: metadata(), client: h.client, organisationId: h.organisationId,
                presentationMode: 'editable', generation, window: dom.window,
                createId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}` }) });
        const ui = { ...dom, controller };
        await until(() => control(ui, 'Start an assessment')); control(ui, 'Start an assessment').click();
        enter(byId(ui, 'ncsc-scope'), 'Synthetic cross-module declaration'); control(ui, 'Create assessment').click();
        await until(() => control(ui, 'Save progress')); choose(ui, 0, 'unknown');
        let navigation;
        if (firstTarget === 'assessment') { control(ui, 'Back to assessments').click(); navigation = controller.navigate('services'); }
        else { navigation = controller.navigate('services'); control(ui, 'Back to assessments').click(); }
        expect(ui.root.querySelectorAll('dialog')).toHaveLength(1);
        control(ui, 'Discard unsent changes').click(); await navigation; await pause();
        expect(ui.root.querySelector('h1').textContent).toBe(firstTarget === 'assessment' ? 'Cyber Security' : 'Services');
        expect(Boolean(control(ui, 'Start an assessment'))).toBe(firstTarget === 'assessment');
        expect(h.records.filter(row => row.action === 'save')).toHaveLength(0); controller.destroy();
    });

    test('native modal invocation and cancel retain the draft and restore its focused control', async () => {
        const h = await backend(), ui = await createInUi(h); choose(ui, 0, 'not_applicable', 'Unsent rationale');
        const field = byId(ui, `ncsc-rationale-${metadata().questions[0].id}`); field.focus();
        const commit = jest.fn(), decision = ui.controller.requestLeave(commit), dialog = ui.root.querySelector('dialog');
        expect(dialog.showModal).toHaveBeenCalledTimes(1); expect(ui.document.modal).toBe(dialog);
        expect(dialog.getAttribute('aria-modal')).toBe('true'); event(dialog, 'cancel');
        expect(await decision).toBe(false); expect(commit).not.toHaveBeenCalled(); expect(dialog.close).toHaveBeenCalled();
        expect(ui.document.activeElement).toBe(field); expect(field.value).toBe('Unsent rationale'); ui.controller.destroy();
    });

    test('unavailable native modal refuses managed navigation without discarding unsent answers', async () => {
        const h = await backend(), dom = interactiveDom(), create = dom.document.createElement;
        dom.document.createElement = tag => { const element = create(tag); if (tag === 'dialog') delete element.showModal; return element; };
        const ui = await createInUi(h, { dom }); choose(ui, 0, 'no');
        const commit = jest.fn(); expect(await ui.controller.requestLeave(commit)).toBe(false);
        expect(commit).not.toHaveBeenCalled(); expect(h.records).toHaveLength(1);
        expect(byId(ui, `ncsc-answer-${metadata().questions[0].id}-no`).checked).toBe(true); ui.controller.destroy();
    });

    test.each(['Synthetic unsent declaration', ' '])('Save and leave handles a new declaration without losing its intent: %p', async description => {
        const h = await backend(), ui = mountUi(h); await until(() => control(ui, 'Start an assessment'));
        control(ui, 'Start an assessment').click(); enter(byId(ui, 'ncsc-scope'), description);
        const commit = jest.fn(), decision = ui.controller.requestLeave(commit); control(ui, 'Save and leave').click();
        expect(await decision).toBe(Boolean(description.trim()));
        expect(commit).toHaveBeenCalledTimes(description.trim() ? 1 : 0);
        expect(h.records).toHaveLength(description.trim() ? 1 : 0);
        if (description.trim()) expect(h.records[0].payload.scopePopulation.description).toBe(description);
        else {
            expect(byId(ui, 'ncsc-scope').value).toBe(description);
            expect(ui.document.activeElement).toBe(ui.root.querySelector('[role="alert"]'));
        }
        ui.controller.destroy();
    });

    test('invalid answer Save and leave retains the local claim and focuses validation after closing the modal', async () => {
        const h = await backend(); await h.execute(createCommand()); await h.execute(saveCommand());
        const ui = await resumeUi(h); choose(ui, 0, 'not_applicable', ' ');
        const commit = jest.fn(), decision = ui.controller.requestLeave(commit);
        control(ui, 'Save and leave').click(); expect(await decision).toBe(false);
        expect(commit).not.toHaveBeenCalled(); expect(ui.document.modal).toBeNull();
        expect(ui.document.activeElement).toBe(ui.root.querySelector('[role="alert"]'));
        expect(byId(ui, `ncsc-rationale-${metadata().questions[0].id}`).value).toBe(' ');
        expect(h.records).toHaveLength(2); ui.controller.destroy();
    });

    test('pending create makes its original declaration read-only and refuses later detached input edits', async () => {
        const h = await backend(), gate = deferred(); let entered = false;
        const create = jest.fn(async (...args) => { const result = await h.client.create(...args); entered = true; await gate.promise; return result; });
        const ui = mountUi(h, { client: { ...h.client, create } }); await until(() => control(ui, 'Start an assessment'));
        control(ui, 'Start an assessment').click(); enter(byId(ui, 'ncsc-scope'), 'Immutable initial scope');
        const old = byId(ui, 'ncsc-scope'); control(ui, 'Create assessment').click(); await until(() => entered);
        expect(byId(ui, 'ncsc-scope').readOnly).toBe(true); enter(old, 'Late attempted scope edit');
        gate.resolve(); await until(() => control(ui, 'Save progress'));
        expect(ui.root.textContent).toContain('Immutable initial scope'); expect(ui.root.textContent).not.toContain('Late attempted scope edit');
        expect(create).toHaveBeenCalledTimes(1); ui.controller.destroy();
    });

    test('pending Submit prevents edits, then seals the exact acknowledged answers', async () => {
        const h = await backend(); await h.execute(createCommand()); await h.execute(saveCommand());
        const gate = deferred(); let entered = false;
        const submit = jest.fn(async (...args) => { const result = await h.client.submit(...args); entered = true; await gate.promise; return result; });
        const ui = await resumeUi(h, { client: { ...h.client, submit } });
        const old = byId(ui, `ncsc-answer-${metadata().questions[0].id}-not_applicable`);
        control(ui, 'Submit assessment').click(); await until(() => entered);
        expect(ui.root.querySelectorAll('input').every(input => input.disabled)).toBe(true);
        old.checked = true; event(old, 'change'); gate.resolve(); await until(() => !control(ui, 'Submit assessment'));
        expect(byId(ui, `ncsc-answer-${metadata().questions[0].id}-yes`).checked).toBe(true);
        expect(ui.root.querySelectorAll('textarea')).toHaveLength(0); expect(submit).toHaveBeenCalledTimes(1); ui.controller.destroy();
    });

    test('remote submission shows only sealed server answers and labels divergent local text separately', async () => {
        const h = await backend(); await h.execute(createCommand()); await h.execute(saveCommand());
        const ui = await resumeUi(h); choose(ui, 0, 'not_applicable', 'Unsubmitted local claim');
        await h.execute(submitCommand('assessment-a', 1, 'other-session-submit'));
        control(ui, 'Save progress').click(); await until(() => ui.root.textContent.includes('Unsubmitted local changes'));
        expect(byId(ui, `ncsc-answer-${metadata().questions[0].id}-yes`).checked).toBe(true);
        expect(byId(ui, `ncsc-answer-${metadata().questions[0].id}-not_applicable`).checked).toBe(false);
        expect(ui.root.querySelectorAll('textarea')).toHaveLength(0);
        expect(ui.root.textContent).toContain('Unsubmitted local claim');
        expect(control(ui, 'Submit assessment')).toBeUndefined(); expect(h.records).toHaveLength(3);
        expect(ui.window.listenerCount('beforeunload')).toBe(1);
        control(ui, 'Use saved answers').click();
        expect(ui.window.listenerCount('beforeunload')).toBe(0);
        expect(h.records).toHaveLength(3); ui.controller.destroy();
    });

    test('near-ceiling multibyte save preflights all batches before making any mutation', async () => {
        const h = await backend(); await h.execute(createCommand()); await h.execute(saveCommand());
        const detail = clone((await h.client.read('assessment-a')).assessment); detail.revision = 126;
        const summary = clone(projectNcscSummary(h.versions.get('assessment-a'))); summary.revision = 126;
        const save = jest.fn(), client = { ...h.client, save,
            list: async () => ({ schemaVersion: 1, assessments: [summary], nextAfterAssessmentId: null }),
            read: async () => ({ schemaVersion: 1, assessment: detail }) };
        const ui = await resumeUi(h, { client });
        metadata().questions.forEach((_question, index) => choose(ui, index, 'not_applicable', '界'.repeat(4000)));
        control(ui, 'Save progress').click(); await pause();
        expect(save).not.toHaveBeenCalled(); expect(ui.root.textContent).toMatch(/not enough remaining save revisions/);
        expect(byId(ui, `ncsc-rationale-${metadata().questions.at(-1).id}`).value).toHaveLength(4000); ui.controller.destroy();
    });

    test('complete revision127 can submit128 while a new answer save is blocked', async () => {
        const h = await backend(); await h.execute(createCommand()); await h.execute(saveCommand());
        const detail = clone((await h.client.read('assessment-a')).assessment); detail.revision = 127;
        const summary = clone(projectNcscSummary(h.versions.get('assessment-a'))); summary.revision = 127;
        const save = jest.fn(), submit = jest.fn(async command => {
            const value = await h.execute(submitCommand()); const result = clone(value);
            result.assessment.revision = 128; result.assessment.submission.revision = 128;
            result.assessment.submission.evaluation.provenance.assessmentRevision = 'rev-128'; return result;
        });
        const client = { ...h.client, save, submit, list: async () => ({ schemaVersion: 1, assessments: [summary], nextAfterAssessmentId: null }),
            read: async () => ({ schemaVersion: 1, assessment: detail }) };
        const ui = await resumeUi(h, { client }); choose(ui, 0, 'unknown'); control(ui, 'Save progress').click(); await pause();
        expect(save).not.toHaveBeenCalled(); choose(ui, 0, 'yes'); control(ui, 'Submit assessment').click();
        await until(() => !control(ui, 'Submit assessment')); expect(submit).toHaveBeenCalledTimes(1);
        expect(submit.mock.calls[0][0]).toMatchObject({ action: 'submit', expectedRevision: 127 }); ui.controller.destroy();
    });

    test('a pending save retry stays exact at revision127 and reads remain available at the ceiling', async () => {
        const h = await backend(); await h.execute(createCommand()); await h.execute(saveCommand());
        const current = clone((await h.client.read('assessment-a')).assessment); current.revision = 126;
        const summary = clone(projectNcscSummary(h.versions.get('assessment-a'))); summary.revision = 126;
        let first = true;
        const save = jest.fn(async command => {
            if (first) { first = false; current.revision = 127; current.responses.find(row => row.itemId === metadata().questions[0].id).optionId = 'unknown'; current.progress.unknown = 1;
                throw Object.assign(new Error('lost'), { code: 'ncsc_unavailable', statusCode: 503 }); }
            return { schemaVersion: 1, action: 'save', assessment: clone(current) };
        });
        const read = jest.fn(async () => ({ schemaVersion: 1, assessment: clone(current) }));
        const ui = await resumeUi(h, { client: { ...h.client, save, read, list: async () => ({ schemaVersion: 1, assessments: [summary], nextAfterAssessmentId: null }) } });
        choose(ui, 0, 'unknown'); control(ui, 'Save progress').click(); await until(() => control(ui, 'Retry same operation'));
        const command = clone(save.mock.calls[0][0]); control(ui, 'Retry same operation').click();
        await until(() => ui.root.textContent.includes('The operation is confirmed and the current saved version has been checked.'));
        expect(save.mock.calls[1][0]).toEqual(command);
        expect(command.expectedRevision).toBe(126); expect(read).toHaveBeenCalledTimes(2); ui.controller.destroy();
    });

    test.each(['list', 'save', 'retry'])('forced replacement ignores delayed old %s completion, without a follow-up request', async method => {
        const a = await backend({ tenantId: 'tenant-a' }), b = await backend({ tenantId: 'tenant-b' });
        await a.execute(createCommand('assessment-a', 'create-a', 'Tenant A population')); await b.execute(createCommand('assessment-a', 'create-a', 'Tenant B population'));
        const gate = deferred(); let entered = false, attempts = 0;
        const read = jest.fn((...args) => a.client.read(...args));
        const save = jest.fn(async (...args) => { const value = await a.client.save(...args); attempts += 1;
            if (method === 'retry' && attempts === 1) throw Object.assign(new Error('lost'), { statusCode: 503 });
            entered = true; await gate.promise; return value; });
        const list = jest.fn(async (...args) => { if (method === 'list') { entered = true; await gate.promise; } return a.client.list(...args); });
        const dom = interactiveDom(), settings = { dom, client: { ...a.client, read, save, list } };
        const old = method === 'list' ? mountUi(a, settings) : await resumeUi(a, settings);
        if (method !== 'list') { choose(old, 0, 'yes'); control(old, 'Save progress').click();
            if (method === 'retry') { await until(() => control(old, 'Retry same operation')); control(old, 'Retry same operation').click(); } }
        await until(() => entered); const reads = read.mock.calls.length;
        const fresh = await resumeUi(b, { dom }), stable = fresh.root.textContent, focus = fresh.document.activeElement;
        gate.resolve(); await pause(); await pause(); old.controller.destroy();
        expect(fresh.root.textContent).toBe(stable); expect(fresh.document.activeElement).toBe(focus); expect(read).toHaveBeenCalledTimes(reads);
        expect(b.records).toHaveLength(1); fresh.controller.destroy();
    });

    test('forced replacement resolves an old modal false and ignores its retained Save and leave control', async () => {
        const h = await backend(), dom = interactiveDom(), old = await createInUi(h, { dom }); choose(old, 0, 'yes');
        const commit = jest.fn(), decision = old.controller.requestLeave(commit), oldSave = control(old, 'Save and leave');
        const b = await backend({ tenantId: 'tenant-b' }); await b.execute(createCommand('assessment-a', 'create-a', 'Tenant B population'));
        const fresh = await resumeUi(b, { dom }), stable = fresh.root.textContent;
        oldSave.click(); expect(await decision).toBe(false); await pause();
        expect(commit).not.toHaveBeenCalled(); expect(h.records).toHaveLength(1); expect(fresh.root.textContent).toBe(stable); fresh.controller.destroy();
    });
});

describe('additional closed client acknowledgment and transport contracts', () => {
    test('known no-policy submission response is a non-ambiguous client error', async () => {
        const fetch = jest.fn(async () => reply({ code: 'ncsc_submission_unavailable' }, 409));
        const client = clientModule.createClient({ metadata: metadata(), fetch });
        await expect(client.submit(submitCommand())).rejects.toMatchObject({
            code: 'ncsc_submission_unavailable', statusCode: 409, ambiguous: false
        });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    test.each(['create description', 'save option', 'save rationale', 'clear acknowledgment'])(
        'a shape-valid wrong %s remains an uncertain mutation', async kind => {
            const h = await backend(), itemId = allResponses()[0].itemId;
            let command;
            if (kind === 'create description') command = createCommand();
            else {
                await h.execute(createCommand());
                if (kind === 'clear acknowledgment') {
                    await h.execute(saveCommand('assessment-a', 0, 'initial-answer', [{ itemId, optionId: 'yes', rationale: null }]));
                    command = saveCommand('assessment-a', 1, 'clear-answer', [{ itemId, optionId: null, rationale: null }]);
                } else command = saveCommand('assessment-a', 0, 'requested-save', [{ itemId,
                    optionId: kind === 'save rationale' ? 'not_applicable' : 'yes',
                    rationale: kind === 'save rationale' ? { text: 'Requested pending rationale' } : null }]);
            }
            const different = clone(command);
            if (kind === 'create description') different.payload.scopePopulation.description = 'A different valid declaration';
            else if (kind === 'save rationale') different.payload.responses[0].rationale.text = 'A different valid pending rationale';
            else different.payload.responses[0].optionId = kind === 'clear acknowledgment' ? 'yes' : 'no';
            // Derive a fully valid server DTO from another intent. Its revision,
            // progress, digest and status all remain structurally consistent.
            const value = await h.execute(different), fetch = jest.fn(async () => reply(value, command.action === 'create' ? 201 : 200));
            const client = clientModule.createClient({ metadata: metadata(), fetch });
            await expect(client[command.action](command)).rejects.toMatchObject({ code: 'ncsc_unavailable', statusCode: 503, ambiguous: true });
            expect(fetch).toHaveBeenCalledTimes(1);
            expect(JSON.parse(fetch.mock.calls[0][1].body).idempotencyKey).toBe(command.idempotencyKey);
        });

    test.each([
        ['revision string', provenance => { provenance.assessmentRevision = 'rev-3'; }],
        ['numeric revision', provenance => { provenance.assessmentRevision = 2; }],
        ['time', provenance => { provenance.scoreAsOf = new Date(Date.parse(provenance.scoreAsOf) + 1000).toISOString(); }],
        ['profile digest', provenance => { provenance.profileRef.catalogueSha256 = 'f'.repeat(64); }],
        ['assessment identity', provenance => { provenance.assessmentId = 'another-assessment'; }],
        ['module identity', provenance => { provenance.moduleId = 'privacy'; }]
    ])('nested submitted provenance rejects a %s substitution', async (_kind, substitute) => {
        const h = await backend(); await h.execute(createCommand()); await h.execute(saveCommand());
        const command = submitCommand(), value = await h.execute(command);
        substitute(value.assessment.submission.evaluation.provenance);
        const fetch = jest.fn(async () => reply(value)), client = clientModule.createClient({ metadata: metadata(), fetch });
        await expect(client.submit(command)).rejects.toMatchObject({ code: 'ncsc_unavailable', statusCode: 503, ambiguous: true });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    function streamReply(chunks, status = 201) {
        const state = { cancelled: false, pulls: 0 }; let index = 0;
        const stream = new ReadableStream({
            pull(controller) {
                state.pulls += 1;
                if (index < chunks.length) controller.enqueue(chunks[index++]);
                else controller.close();
            },
            cancel() { state.cancelled = true; }
        });
        return { response: new Response(stream, { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } }), state };
    }

    test('a response of exactly 512 KiB accepts valid split UTF-8 without confusing the command bound', async () => {
        const h = await backend(), command = createCommand('assessment-a', 'create-a', 'Māori \uD83D\uDE80 日本語');
        const value = await h.execute(command), raw = Buffer.from(JSON.stringify(value), 'utf8');
        const boundary = raw.indexOf(Buffer.from('\uD83D\uDE80', 'utf8')) + 2;
        expect(boundary).toBeGreaterThan(2);
        const bytes = Buffer.concat([raw, Buffer.alloc(512 * 1024 - raw.length, 0x20)]);
        const transport = streamReply([bytes.subarray(0, boundary), bytes.subarray(boundary, bytes.length - 1), bytes.subarray(bytes.length - 1)]);
        const fetch = jest.fn(async () => transport.response), client = clientModule.createClient({ metadata: metadata(), fetch });
        expect(await client.create(command)).toEqual(value);
        expect(transport.state.cancelled).toBe(false); expect(fetch).toHaveBeenCalledTimes(1);
    });

    test('streamed response byte 524289 cancels consumption and leaves the mutation uncertain', async () => {
        const h = await backend(), command = createCommand(), value = await h.execute(command);
        // The third chunk would complete otherwise valid JSON. The first two
        // exceed the byte budget using whitespace, with no Content-Length hint.
        const transport = streamReply([Buffer.alloc(512 * 1024, 0x20), Buffer.from(' '), Buffer.from(JSON.stringify(value))]);
        const fetch = jest.fn(async () => transport.response), client = clientModule.createClient({ metadata: metadata(), fetch });
        await expect(client.create(command)).rejects.toMatchObject({ code: 'ncsc_unavailable', statusCode: 503, ambiguous: true });
        expect(transport.state.cancelled).toBe(true); expect(fetch).toHaveBeenCalledTimes(1);
    });

    test('invalid UTF-8 split between chunks is rejected without replacing retained declaration text', async () => {
        const h = await backend(); await h.execute(createCommand('assessment-a', 'create-a', 'Before UTF8_SENTINEL after'));
        const command = saveCommand(), value = await h.execute(command), raw = Buffer.from(JSON.stringify(value));
        const marker = Buffer.from('UTF8_SENTINEL'), offset = raw.indexOf(marker);
        expect(offset).toBeGreaterThan(0);
        // A permissive decoder would turn this into valid Unicode/JSON text and
        // otherwise pass the correct save acknowledgment. Fatal decoding must
        // reject the byte sequence instead of silently altering the declaration.
        const transport = streamReply([Buffer.concat([raw.subarray(0, offset), Buffer.from([0xc3])]),
            Buffer.concat([Buffer.from([0x28]), raw.subarray(offset + marker.length)])], 200);
        const fetch = jest.fn(async () => transport.response), client = clientModule.createClient({ metadata: metadata(), fetch });
        await expect(client.save(command)).rejects.toMatchObject({ code: 'ncsc_unavailable', statusCode: 503, ambiguous: true });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    test.each(['redirected response', 'opaque redirect', 'HTTP redirect'])(
        '%s never becomes a successful create or starts another request', async kind => {
            const h = await backend(), command = createCommand(), value = await h.execute(command);
            const response = reply(value, kind === 'HTTP redirect' ? 303 : 201);
            if (kind === 'redirected response') Object.defineProperty(response, 'redirected', { value: true });
            if (kind === 'opaque redirect') Object.defineProperty(response, 'type', { value: 'opaqueredirect' });
            const fetch = jest.fn(async () => response), client = clientModule.createClient({ metadata: metadata(), fetch });
            await expect(client.create(command)).rejects.toMatchObject({ code: 'ncsc_unavailable', statusCode: 503, ambiguous: true });
            expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0][1].redirect).toBe('error');
        });

    test('every operation uses a bounded transport signal without aborting its caller', async () => {
        const h = await backend(), controller = new AbortController(), signal = controller.signal;
        await h.client.create(createCommand(), { signal });
        await h.client.list({ limit: 50, afterAssessmentId: null, signal });
        await h.client.read('assessment-a', { signal });
        await h.client.save(saveCommand(), { signal });
        await h.client.submit(submitCommand(), { signal });
        expect(h.fetch).toHaveBeenCalledTimes(5);
        h.fetch.mock.calls.forEach(([, init]) => { expect(init.signal).toBeInstanceOf(AbortSignal); expect(init.signal.aborted).toBe(false); });
        expect(signal.aborted).toBe(false);
    });

    test.each(['list', 'create'])('aborted %s transport is sanitized with the correct uncertainty', async action => {
        const controller = new AbortController(), fetch = jest.fn((_url, init) => new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new DOMException('private-abort-detail', 'AbortError')), { once: true });
        }));
        const client = clientModule.createClient({ metadata: metadata(), fetch });
        const pending = action === 'list' ? client.list({ signal: controller.signal }) : client.create(createCommand(), { signal: controller.signal });
        controller.abort();
        await expect(pending).rejects.toMatchObject({ code: 'ncsc_unavailable', message: 'ncsc_unavailable',
            statusCode: 503, ambiguous: action === 'create' });
        expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    });
});


describe('bounded complete NCSC response lifetime', () => {
    test.each(['fetch', 'body'])('a stalled %s times out with ambiguous writes and retains exact retry bytes', async stage => {
        jest.useFakeTimers();
        try {
            const stuck = deferred();
            const fetch = jest.fn(() => stage === 'fetch' ? stuck.promise : Promise.resolve({
                status: 201, headers: { get: key => key.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null },
                text: () => stuck.promise
            }));
            const client = clientModule.createClient({ metadata: metadata(), fetch });
            const command = createCommand();
            const first = client.create(command);
            const rejected = expect(first).rejects.toMatchObject({ code: 'ncsc_unavailable', ambiguous: true });
            await jest.advanceTimersByTimeAsync(12000); await rejected;
            expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
            const retry = client.create(command);
            const retryRejected = expect(retry).rejects.toMatchObject({ code: 'ncsc_unavailable', ambiguous: true });
            expect(fetch.mock.calls[1][1].body).toBe(fetch.mock.calls[0][1].body);
            await jest.advanceTimersByTimeAsync(12000); await retryRejected;
            expect(fetch).toHaveBeenCalledTimes(2);
        } finally { jest.useRealTimers(); }
    });
    test('a stalled read is unavailable without implying a mutation', async () => {
        jest.useFakeTimers();
        try {
            const client = clientModule.createClient({ metadata: metadata(), fetch: () => new Promise(() => {}) });
            const rejected = expect(client.list()).rejects.toMatchObject({ code: 'ncsc_unavailable', ambiguous: false });
            await jest.advanceTimersByTimeAsync(12000); await rejected;
        } finally { jest.useRealTimers(); }
    });
});

// Native event contract only: actual browser activation/prompt delivery and
// layout belong to questionnaire-recovery-hierarchy-browser.cjs.
function observeUnload(dom) {
    const handlers = new Set(), retired = [], added = [];
    const window = { ...dom.window,
        addEventListener(name, handler) {
            if (name === 'beforeunload') { handlers.add(handler); added.push(handler); }
            else dom.window.addEventListener(name, handler);
        },
        removeEventListener(name, handler) {
            if (name === 'beforeunload') { handlers.delete(handler); retired.push(handler); }
            else dom.window.removeEventListener(name, handler);
        }
    };
    function fire(callbacks = handlers) {
        const native = { defaultPrevented: false, returnValue: undefined,
            preventDefault() { this.defaultPrevented = true; } };
        for (const handler of callbacks) handler(native);
        return native;
    }
    return { window, handlers, retired, added, fire };
}

describe('questionnaire native unload lifecycle and task hierarchy', () => {
    test('only meaningful scope text warns while managed leave keeps its existing whitespace decision', async () => {
        const h = await backend(), dom = interactiveDom(), unload = observeUnload(dom);
        const ui = mountUi(h, { dom, window: unload.window });
        try {
            await until(() => control(ui, 'Start an assessment'));
            expect(unload.handlers.size).toBe(0);
            control(ui, 'Start an assessment').click();
            enter(byId(ui, 'ncsc-scope'), ' \n\t');
            expect(unload.handlers.size).toBe(0);
            const decision = ui.controller.requestLeave();
            expect(control(ui, 'Stay here')).toBeDefined();
            control(ui, 'Stay here').click(); expect(await decision).toBe(false);
            enter(byId(ui, 'ncsc-scope'), 'A meaningful unsaved scope');
            expect(unload.handlers.size).toBe(1);
            expect(unload.fire()).toMatchObject({ defaultPrevented: true, returnValue: true });
            enter(byId(ui, 'ncsc-scope'), 'Another meaningful edit');
            expect(unload.handlers.size).toBe(1); expect(unload.added).toHaveLength(1);
            enter(byId(ui, 'ncsc-scope'), ''); expect(unload.handlers.size).toBe(0);
            expect(unload.fire(unload.retired).defaultPrevented).toBe(false);
            expect(h.records).toHaveLength(0);
        } finally { ui.controller.destroy(); }
    });

    test('one dirty-answer listener detaches when answers return exactly to the saved draft', async () => {
        const h = await backend(), dom = interactiveDom(), unload = observeUnload(dom);
        const ui = await createInUi(h, { dom, window: unload.window });
        try {
            expect(unload.handlers.size).toBe(0);
            const baselineAdds = unload.added.length;
            choose(ui, 0, 'yes'); choose(ui, 0, 'no');
            expect(unload.handlers.size).toBe(1); expect(unload.added.length - baselineAdds).toBe(1);
            control(ui, 'Clear answer').click(); expect(unload.handlers.size).toBe(0);
            choose(ui, 0, 'not_applicable', 'A pending local claim');
            expect(unload.fire()).toMatchObject({ defaultPrevented: true, returnValue: true });
            control(ui, 'Clear answer').click(); expect(unload.handlers.size).toBe(0);
            expect(h.records).toHaveLength(1);
        } finally { ui.controller.destroy(); }
        expect(unload.handlers.size).toBe(0);
    });

    test('a pending save warns and a successful acknowledgement retains protection for newer typing', async () => {
        const h = await backend(), dom = interactiveDom(), unload = observeUnload(dom), gate = deferred();
        const save = jest.fn(async (...args) => { await gate.promise; return h.client.save(...args); });
        const ui = await createInUi(h, { dom, window: unload.window, client: { ...h.client, save } });
        try {
            choose(ui, 0, 'not_applicable', 'Captured pending claim');
            control(ui, 'Save progress').click(); await until(() => save.mock.calls.length === 1);
            expect(unload.fire().defaultPrevented).toBe(true);
            enter(byId(ui, `ncsc-rationale-${metadata().questions[0].id}`), 'New typing during save');
            gate.resolve(); await until(() => ui.root.textContent.includes('Newer edits are still unsaved.'));
            expect(unload.handlers.size).toBe(1);
            expect(h.records.at(-1).payload.responses[0].rationale.text).toBe('Captured pending claim');
            control(ui, 'Save progress').click(); await until(() => ui.root.textContent.includes('Your progress is saved.'));
            expect(unload.handlers.size).toBe(0);
            expect(h.records.at(-1).payload.responses[0].rationale.text).toBe('New typing during save');
        } finally { gate.resolve(); ui.controller.destroy(); }
    });

    test('an unconfirmed committed save warns until its identical retry and reconciliation succeed', async () => {
        const h = await backend(), dom = interactiveDom(), unload = observeUnload(dom);
        const save = jest.fn(async (...args) => {
            const result = await h.client.save(...args);
            if (save.mock.calls.length === 1) throw { code: 'ncsc_unavailable', statusCode: 503, ambiguous: true };
            return result;
        });
        const ui = await createInUi(h, { dom, window: unload.window, client: { ...h.client, save } });
        try {
            choose(ui, 0, 'yes'); control(ui, 'Save progress').click();
            await until(() => control(ui, 'Retry same operation'));
            expect(unload.handlers.size).toBe(1); expect(unload.fire().defaultPrevented).toBe(true);
            expect(await ui.controller.requestLeave()).toBe(false);
            control(ui, 'Retry same operation').click();
            await until(() => ui.root.textContent.includes('operation is confirmed'));
            expect(save.mock.calls[1][0]).toEqual(save.mock.calls[0][0]);
            expect(h.records.filter(row => row.action === 'save')).toHaveLength(1);
            expect(unload.handlers.size).toBe(0);
        } finally { ui.controller.destroy(); }
    });

    test('even an otherwise clean draft warns while final submission is pending', async () => {
        const h = await backend(), dom = interactiveDom(), unload = observeUnload(dom), gate = deferred();
        await h.execute(createCommand()); await h.execute(saveCommand());
        const submit = jest.fn(async (...args) => { await gate.promise; return h.client.submit(...args); });
        const ui = await resumeUi(h, { dom, window: unload.window, client: { ...h.client, submit } });
        try {
            expect(unload.handlers.size).toBe(0);
            control(ui, 'Submit assessment').click(); await until(() => submit.mock.calls.length === 1);
            expect(unload.handlers.size).toBe(1); expect(unload.fire().defaultPrevented).toBe(true);
            gate.resolve(); await until(() => !control(ui, 'Submit assessment'));
            expect(unload.handlers.size).toBe(0);
            expect(h.records.filter(row => row.action === 'submit')).toHaveLength(1);
        } finally { gate.resolve(); ui.controller.destroy(); }
    });

    test.each(['Stay here', 'Discard unsent changes', 'Save and leave'])('managed %s keeps native protection correct before the destination commits', async choice => {
        const h = await backend(), dom = interactiveDom(), unload = observeUnload(dom);
        const ui = await createInUi(h, { dom, window: unload.window });
        try {
            choose(ui, 0, 'yes');
            const commit = jest.fn(() => { expect(unload.handlers.size).toBe(0); expect(unload.fire().defaultPrevented).toBe(false); });
            const decision = ui.controller.requestLeave(commit);
            control(ui, choice).click(); const allowed = await decision;
            expect(allowed).toBe(choice !== 'Stay here');
            expect(commit).toHaveBeenCalledTimes(choice === 'Stay here' ? 0 : 1);
            expect(unload.handlers.size).toBe(choice === 'Stay here' ? 1 : 0);
        } finally { ui.controller.destroy(); }
    });

    test.each([400, 413])('known write rejection %s retains unsent-answer protection', async statusCode => {
        const h = await backend(), dom = interactiveDom(), unload = observeUnload(dom);
        const save = jest.fn(async () => { throw { statusCode, code: 'ncsc_input_invalid', ambiguous: false }; });
        const ui = await createInUi(h, { dom, window: unload.window, client: { ...h.client, save } });
        try {
            choose(ui, 0, 'yes'); control(ui, 'Save progress').click();
            await until(() => save.mock.calls.length === 1); await pause();
            expect(unload.handlers.size).toBe(1); expect(unload.fire().defaultPrevented).toBe(true);
            expect(control(ui, 'Retry same operation')).toBeUndefined();
            expect(h.records).toHaveLength(1);
        } finally { ui.controller.destroy(); }
    });

    test('access denial clears the listener and makes a retained stale callback inert', async () => {
        const h = await backend(), dom = interactiveDom(), unload = observeUnload(dom);
        const ui = await createInUi(h, { dom, window: unload.window });
        try {
            choose(ui, 0, 'yes'); const stale = [...unload.handlers];
            h.deny(); control(ui, 'Save progress').click();
            await until(() => ui.root.textContent.includes('This assessment is not available.'));
            expect(unload.handlers.size).toBe(0); expect(unload.fire(stale).defaultPrevented).toBe(false);
            expect(control(ui, 'Save progress')).toBeUndefined();
        } finally { ui.controller.destroy(); }
    });

    test('replacement and delayed old acknowledgements cannot reattach an obsolete handler', async () => {
        const h = await backend(), dom = interactiveDom(), unload = observeUnload(dom), gate = deferred();
        const save = jest.fn(async (...args) => { await gate.promise; return h.client.save(...args); });
        const old = await createInUi(h, { dom, window: unload.window, client: { ...h.client, save } });
        choose(old, 0, 'yes'); const stale = [...unload.handlers];
        control(old, 'Save progress').click(); await until(() => save.mock.calls.length === 1);
        const fresh = mountUi(h, { dom, window: unload.window });
        try {
            expect(unload.handlers.size).toBe(0); expect(unload.fire(stale).defaultPrevented).toBe(false);
            gate.resolve(); await pause(); await pause();
            expect(unload.handlers.size).toBe(0);
            old.controller.destroy(); expect(unload.handlers.size).toBe(0);
            await until(() => control(fresh, 'Start an assessment'));
            control(fresh, 'Start an assessment').click(); enter(byId(fresh, 'ncsc-scope'), 'New mounted scope');
            expect(unload.handlers.size).toBe(1);
        } finally { gate.resolve(); fresh.controller.destroy(); }
        expect(unload.handlers.size).toBe(0); expect(unload.fire(stale).defaultPrevented).toBe(false);
    });

    test('workshop material follows the task and retains disclosure, focus and download provenance on rerender', async () => {
        const h = await backend(), ui = await createInUi(h);
        try {
            const content = ui.root.querySelector('.ncsc-content'), panel = ui.root.querySelector('.ncsc-workshop');
            expect(ui.root.children.indexOf(panel)).toBeGreaterThan(ui.root.children.indexOf(content));
            expect(panel.tagName).toBe('DETAILS'); expect(Boolean(panel.open)).toBe(false);
            expect(panel.textContent).toContain('Version 2 · Prepared 20 October 2026 (NZDT).');
            expect(panel.textContent).toContain('No endorsement is implied.');
            expect(panel.textContent).toContain('© Crown copyright, GCSB');
            expect(byId(ui, 'ncsc-workshop-pptx').getAttribute('download')).toBe('No_Fries_Questionnaire_Onsite_Companion_v2_NZISM.pptx');
            expect(byId(ui, 'ncsc-workshop-pdf').getAttribute('href')).toBe('/assets/workshops/No_Fries_Questionnaire_Onsite_Companion_v2_NZISM.pdf');
            panel.open = true; event(panel, 'toggle');
            const title = byId(ui, 'ncsc-workshop-title'); title.focus();
            choose(ui, 0, 'yes'); title.focus(); control(ui, 'Save progress').click();
            await until(() => ui.root.textContent.includes('Your progress is saved.'));
            expect(ui.root.querySelector('.ncsc-workshop').open).toBe(true);
            expect(ui.document.activeElement).toBe(byId(ui, 'ncsc-workshop-title'));
        } finally { ui.controller.destroy(); }
    });

    test('Save stays primary while final Submit carries its adjacent read-only consequence', async () => {
        const h = await backend(), ui = await createInUi(h);
        try {
            const save = control(ui, 'Save progress'), submit = control(ui, 'Submit assessment');
            expect(save.classList.contains('dashboard-button')).toBe(true);
            expect(submit.classList.contains('dashboard-text-button')).toBe(true);
            const warning = byId(ui, submit.getAttribute('aria-describedby'));
            expect(warning.textContent).toMatch(/read-only/);
            expect(warning.textContent).toMatch(/saved first/);
            expect(warning.parentElement).toBe(submit.parentElement);
            expect(warning.parentElement.children.indexOf(warning)).toBeLessThan(warning.parentElement.children.indexOf(submit));
            expect(h.records).toHaveLength(1);
        } finally { ui.controller.destroy(); }
    });
});
