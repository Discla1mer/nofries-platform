'use strict';

const { createPostgresDashboardRepository } = require('../api/shared/appLifecycle/postgresDashboardRepository');
const store = require('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { NcscAssessmentError } = require('../api/shared/ncscAssessmentService');
const { createNcscSubmissionQuotaResolver } = require('../lib/ncscSubmissionPolicy');
const { acceptedProfile } = require('../api/shared/assessmentLifecycle/ncscAssessmentSubmission');
const { ncscFixture, createClock, createContext, createNcscAdapters, initialiseNcsc, createCommand,
    saveCommand, submitCommand, allResponses, SUBJECT, NOW, EMPTY_REVISIONS, clone } = require('./fixtures/ncscAssessmentFixture');

const HEAD = 'dashboard_ncsc_assessments', VERSION = 'dashboard_ncsc_assessment_revisions',
    RECEIPT = 'dashboard_ncsc_assessment_receipts', USAGE = 'dashboard_usage';
const firstId = acceptedProfile.questions[0].id;
const failure = code => Object.assign(new Error('synthetic-private-driver-detail'), { code });
const JSONB_SIZE_SQL = 'SELECT octet_length($1::jsonb::text) AS payload_bytes';
function syntheticJsonbTextBytes(value) {
    // A contract-double approximation for these plain fixtures only. Actual
    // PostgreSQL serialization, numeric formatting and constraints are proved
    // independently by the hosted restricted-role integration cases.
    function separators(item) {
        if (!item || typeof item !== 'object') return 0;
        const items = Array.isArray(item) ? item : Object.values(item);
        return Math.max(0, items.length - 1) + (Array.isArray(item) ? 0 : items.length) + items.reduce((sum, child) => sum + separators(child), 0);
    }
    return Buffer.byteLength(JSON.stringify(value), 'utf8') + separators(value);
}

// Contract double only. Real PostgreSQL integration separately proves locking,
// RLS, privileges, migration constraints and restore behavior. This double models
// rollback and a serialized transaction fence, with inspectable fault boundaries.
function memoryDatabase(seed = {}) {
    let records = clone(seed), queue = Promise.resolve(), nextFailure = null;
    const queries = [], transactions = [];
    const hooks = { beforeQuery: async () => {}, afterQuery: async () => {}, beforeCommit: async () => {} };
    const database = { withTenantTransaction(tenantId, work) {
        const run = async () => {
            const draft = clone(records), transaction = { tenantId, statements: [], committed: false };
            const fault = nextFailure; nextFailure = null;
            transactions.push(transaction);
            if (fault?.stage === 'beforeWork') throw failure(fault.code);
            const result = await work({ query: async (sql, args = []) => {
                const call = { sql, args: clone(args), tenantId };
                queries.push(call); transaction.statements.push(sql);
                await hooks.beforeQuery(call, draft);
                if (fault?.stage === 'query' && fault.matches(sql)) throw failure(fault.code);
                if (sql === JSONB_SIZE_SQL) {
                    const answer = { rows: [{ payload_bytes: syntheticJsonbTextBytes(JSON.parse(args[0])) }], rowCount: 1 };
                    await hooks.afterQuery(call, draft, answer); return answer;
                }
                const table = sql.match(/nofries\.(dashboard_\w+)/)?.[1];
                if (!table) throw new Error('Unexpected SQL contract');
                const rows = draft[table] || (draft[table] = []);
                let answer;
                if (sql.startsWith('SELECT')) {
                    const where = sql.split(' WHERE ')[1].split(/ ORDER BY | FOR /)[0];
                    const equals = [...where.matchAll(/(\w+) = \$(\d+)/g)];
                    let selected = rows.filter(row => row.tenant_id === tenantId &&
                        equals.every(match => row[match[1]] === args[Number(match[2]) - 1]));
                    const fromRevision = where.match(/revision >= \$(\d+)/);
                    if (fromRevision) selected = selected.filter(row => row.revision >= args[Number(fromRevision[1]) - 1]);
                    if (where.includes('assessment_id COLLATE "C" > $3') && args[2] !== null) {
                        selected = selected.filter(row => row.assessment_id > args[2]);
                    }
                    const order = sql.match(/ ORDER BY (\w+)/)?.[1];
                    if (order) selected.sort((a, b) => a[order] < b[order] ? -1 : a[order] > b[order] ? 1 : 0);
                    const limit = sql.match(/ LIMIT (\$\d+|\d+)/)?.[1];
                    if (limit) selected = selected.slice(0, limit[0] === '$' ? args[Number(limit.slice(1)) - 1] : Number(limit));
                    answer = { rows: clone(selected), rowCount: selected.length };
                } else if (sql.startsWith('INSERT')) {
                    const columns = sql.match(/\(([^)]+)\) VALUES/)[1].split(', ');
                    const expressions = sql.match(/VALUES \((.+?)\)(?: ON CONFLICT|$)/)[1].split(', ');
                    const row = Object.fromEntries(columns.map((column, index) => {
                        const reference = expressions[index].match(/\$(\d+)/);
                        const value = reference ? args[Number(reference[1]) - 1] : Number(expressions[index]);
                        return [column, column === 'payload' ? JSON.parse(value) : value];
                    }));
                    if (row.tenant_id !== tenantId) throw new Error('Synthetic RLS denial');
                    const primary = ['tenant_id', ...(table === 'dashboard_tenants' ? [] : ['organisation_id']),
                        ...(table === HEAD ? ['assessment_id'] : table === VERSION ? ['assessment_id', 'revision']
                            : table === RECEIPT ? ['assessment_id', 'idempotency_key'] : table === USAGE ? ['grant_id']
                                : table === 'dashboard_advisor_assignments' ? ['assignment_id']
                                    : table === 'dashboard_operation_receipts' ? ['operation_id'] : [])];
                    const exists = rows.some(item => primary.every(key => item[key] === row[key]));
                    if (exists && table === 'dashboard_tenants' && sql.includes('ON CONFLICT')) answer = { rows: [], rowCount: 0 };
                    else {
                        if (exists) throw failure('23505');
                        rows.push(row); answer = { rows: sql.includes('RETURNING') ? [{ tenant_id: tenantId }] : [], rowCount: 1 };
                    }
                } else if (sql.startsWith('UPDATE')) {
                    const equals = [...sql.split(' WHERE ')[1].matchAll(/(\w+) = \$(\d+)/g)];
                    const matches = rows.filter(row => row.tenant_id === tenantId &&
                        equals.every(match => row[match[1]] === args[Number(match[2]) - 1]));
                    for (const row of matches) for (const match of sql.split(' SET ')[1].split(' WHERE ')[0].matchAll(/(\w+) = \$(\d+)/g)) {
                        const value = args[Number(match[2]) - 1]; row[match[1]] = match[1] === 'payload' ? JSON.parse(value) : value;
                    }
                    answer = { rows: [], rowCount: matches.length };
                } else throw new Error('Unexpected SQL contract');
                await hooks.afterQuery(call, draft, answer);
                return answer;
            } });
            await hooks.beforeCommit(transaction, draft);
            if (fault?.stage === 'beforeCommit') throw failure(fault.code);
            records = draft; transaction.committed = true;
            if (fault?.stage === 'afterCommit') throw failure(fault.code);
            return result;
        };
        const pending = queue.then(run);
        queue = pending.catch(() => {});
        return pending;
    } };
    return { database, queries, transactions, hooks, rows: table => records[table] || [], snapshot: () => clone(records),
        failNext: fault => { nextFailure = fault; } };
}

async function setup(options = {}, memory = memoryDatabase(), expectedTenantRevision = null) {
    const fixture = ncscFixture(options), clock = createClock(fixture.now), adapters = createNcscAdapters(clock);
    const policy = jest.fn(adapters.resolveSubmissionQuota), auditCreate = jest.fn(adapters.audit.createEvent),
        auditWrite = jest.fn(adapters.audit.writeEvent);
    const ncsc = { audit: { createEvent: auditCreate, writeEvent: auditWrite }, resolveSubmissionQuota: policy };
    const config = { database: memory.database, clock: clock.now, authoriseAdministration: () => true, ncsc };
    const repository = createPostgresDashboardRepository(config);
    const context = await createContext(fixture.scope, clock);
    if (expectedTenantRevision === null) await initialiseNcsc(repository, fixture, 'initialise-' + fixture.scope.tenantId);
    else await repository.initialiseOrganisation({ ...fixture.scope, operationId: 'initialise-' + fixture.scope.tenantId,
        actorSubjectKey: SUBJECT, type: 'organisation.initialise',
        expectedRevisions: { ...clone(EMPTY_REVISIONS), tenant: expectedTenantRevision }, payload: {} }, clone(fixture.state));
    return { fixture, clock, adapters, policy, auditCreate, auditWrite, config, repository, context, memory,
        create: (id = 'assessment-a', key = 'create-a') => repository.executeNcscAssessment(context, createCommand(id, key)),
        save: (id = 'assessment-a', revision = 0, key = 'save-a', responses = allResponses()) =>
            repository.executeNcscAssessment(context, saveCommand(id, revision, key, responses)),
        submit: (id = 'assessment-a', revision = 1, key = 'submit-a') =>
            repository.executeNcscAssessment(context, submitCommand(id, revision, key)),
        read: (id = 'assessment-a') => repository.readNcscAssessment(context, { assessmentId: id }),
        list: (limit = 50, afterAssessmentId = null) => repository.listNcscAssessments(context, { limit, afterAssessmentId }) };
}
async function ready(options = {}, memory) {
    const h = await setup(options, memory); await h.create(); await h.save(); return h;
}
function receipt(h, key = 'submit-a') { return h.memory.rows(RECEIPT).find(row => row.idempotency_key === key); }
function onlyReadsSince(h, count) { expect(h.memory.queries.slice(count).every(row => row.sql.startsWith('SELECT'))).toBe(true); }
function counts(h) { return [HEAD, VERSION, RECEIPT].map(table => h.memory.rows(table).length); }
function expectCode(pending, code) { return expect(pending).rejects.toMatchObject({ code }); }
function seedHistory(h, assessmentId, finalRevision, submitLast = false) {
    let previous = { envelope: clone(h.memory.rows(VERSION).find(row => row.assessment_id === assessmentId).payload),
        revisionSha256: h.memory.rows(VERSION).find(row => row.assessment_id === assessmentId).payload_sha256 };
    for (let revision = 1; revision <= finalRevision; revision += 1) {
        const command = submitLast && revision === finalRevision ? submitCommand(assessmentId, revision - 1, 'seed-submit')
            : saveCommand(assessmentId, revision - 1, 'seed-' + revision,
                revision === 1 ? allResponses() : [{ itemId: firstId, optionId: 'yes', rationale: null }]);
        const current = store.makeVersion(store.stableIntent(h.context, command), command.idempotencyKey,
            previous, h.fixture.state.tenantAggregate, NOW);
        h.memory.rows(VERSION).push({ tenant_id: h.fixture.scope.tenantId, organisation_id: h.fixture.scope.organisationId,
            assessment_id: assessmentId, revision, schema_version: 1, payload_sha256: current.revisionSha256,
            parent_revision: current.parentRevision, parent_sha256: current.parentSha256, payload: clone(current.envelope) });
        previous = current;
    }
    const head = h.memory.rows(HEAD).find(row => row.assessment_id === assessmentId);
    head.revision = finalRevision; head.payload_sha256 = previous.revisionSha256;
}
async function authorityCommand(h, type, payload, operationId = 'authority-change') {
    const authority = await h.repository.readAuthoritySnapshot(h.fixture.scope, { authenticated: true, subjectKey: SUBJECT });
    return h.repository.executeAuthorityCommand({ ...h.fixture.scope, actorSubjectKey: SUBJECT, type, operationId,
        expectedRevisions: authority.revisions, payload });
}

describe('NCSC assessment durable facade contract', () => {
    test('NCSC009 PostgreSQL size preflight rejects a candidate whose canonical JSON fits but stored text exceeds the existing cap', async () => {
        const h = await setup(); await h.create();
        const rows = allResponses('not_applicable').map((row, index) => ({ ...row, rationale: { text: '\u0001'.repeat(index === 0 ? 3800 : 2800) } }));
        for (let index = 0; index < 12; index += 2) await h.save('assessment-a', index / 2, `jsonb-${index}`, rows.slice(index, index + 2));
        const before = h.memory.snapshot(), auditCount = h.auditCreate.mock.calls.length;
        await expect(h.save('assessment-a', 6, 'jsonb-too-large', rows.slice(12))).rejects.toMatchObject({ code: 'ncsc_request_too_large', statusCode: 413 });
        const probe = h.memory.queries.filter(call => call.sql === JSONB_SIZE_SQL).at(-1);
        expect(probe.args).toHaveLength(1);
        expect(Buffer.byteLength(probe.args[0], 'utf8')).toBeLessThanOrEqual(262144);
        expect(syntheticJsonbTextBytes(JSON.parse(probe.args[0]))).toBeGreaterThan(262144);
        expect(h.memory.snapshot()).toEqual(before); expect(h.auditCreate).toHaveBeenCalledTimes(auditCount);
        expect(h.policy).not.toHaveBeenCalled(); expect(h.auditWrite).not.toHaveBeenCalled();
    });

    test.each([[], [{ payload_bytes: 1 }, { payload_bytes: 1 }], [{}], [{ payload_bytes: 0 }],
        [{ payload_bytes: '200' }], [{ payload_bytes: 1.5 }], [{ payload_bytes: Number.MAX_SAFE_INTEGER + 1 }]].map(rows => ({ rows })))
    ('NCSC009 malformed database size result stays503 without committing anything %#', async ({ rows }) => {
        const h = await setup(), before = h.memory.snapshot();
        h.memory.hooks.afterQuery = async ({ sql }, _draft, result) => { if (sql === JSONB_SIZE_SQL) result.rows = rows; };
        await expect(h.create()).rejects.toMatchObject({ code: 'ncsc_unavailable', statusCode: 503 });
        expect(h.memory.snapshot()).toEqual(before); expect(h.auditCreate).not.toHaveBeenCalled();
        expect(h.auditWrite).not.toHaveBeenCalled(); expect(h.policy).not.toHaveBeenCalled();
    });

    test('NCSC009 database size query failure remains503 and exact committed replay performs no candidate size query', async () => {
        const h = await setup(), before = h.memory.snapshot();
        h.memory.failNext({ stage: 'query', matches: sql => sql === JSONB_SIZE_SQL, code: 'XX000' });
        await expect(h.create()).rejects.toMatchObject({ code: 'ncsc_unavailable', statusCode: 503 });
        expect(h.memory.snapshot()).toEqual(before); expect(h.auditCreate).not.toHaveBeenCalled();
        const created = await h.create(), committed = h.memory.snapshot();
        const start = h.memory.queries.length;
        h.memory.hooks.beforeQuery = async ({ sql }) => { if (sql === JSONB_SIZE_SQL) throw failure('XX000'); };
        expect(await h.create()).toEqual(created); expect(h.memory.snapshot()).toEqual(committed);
        expect(h.memory.queries.slice(start).some(call => call.sql === JSONB_SIZE_SQL)).toBe(false);
    });

    test('NCSC009 candidate save overflow is definitive413 with no durable or audit effects and permits a shorter correction', async () => {
        const h = await setup(); await h.create();
        const responses = allResponses('not_applicable').map(row => ({ ...row, rationale: { text: '\u0001'.repeat(4000) } }));
        for (let index = 0; index < 10; index += 2) {
            const command = saveCommand('assessment-a', index / 2, `bounded-${index}`, responses.slice(index, index + 2));
            expect(Buffer.byteLength(JSON.stringify(command), 'utf8')).toBeLessThanOrEqual(65536);
            await h.repository.executeNcscAssessment(h.context, command);
        }
        const before = h.memory.snapshot(), auditCount = h.auditCreate.mock.calls.length;
        const overflow = saveCommand('assessment-a', 5, 'oversized-candidate', responses.slice(10, 12));
        expect(Buffer.byteLength(JSON.stringify(overflow), 'utf8')).toBeLessThanOrEqual(65536);
        await expect(h.repository.executeNcscAssessment(h.context, overflow)).rejects.toMatchObject({ code: 'ncsc_request_too_large', statusCode: 413 });
        expect(h.memory.snapshot()).toEqual(before); expect(h.auditCreate).toHaveBeenCalledTimes(auditCount);
        expect(h.auditWrite).not.toHaveBeenCalled(); expect(h.policy).not.toHaveBeenCalled();
        expect(h.memory.transactions.at(-1).committed).toBe(false);
        expect((await h.read()).assessment).toMatchObject({ revision: 5, progress: { answered: 10 } });
        const corrected = responses.slice(10, 12).map(row => ({ ...row, rationale: { text: 'Shortened pending claim.' } }));
        const saved = await h.save('assessment-a', 5, 'corrected-candidate', corrected);
        expect(saved.assessment).toMatchObject({ revision: 6, progress: { answered: 12 } });
        expect(saved.assessment.responses.filter(row => corrected.some(item => item.itemId === row.itemId)).map(row => row.rationale.text))
            .toEqual(corrected.map(row => row.rationale.text));
        expect(h.memory.rows(USAGE)[0].payload.counters.assessment_runs).toBe(0);
    });

    test('NCSC009 submit-only candidate overflow is definitive413 and a shorter saved rationale makes submission possible', async () => {
        const h = await setup(); await h.create();
        const responses = allResponses('not_applicable').map(row => ({ ...row, rationale: { text: '\u0001'.repeat(2800) } }));
        for (let index = 0; index < responses.length; index += 2) await h.save('assessment-a', index / 2, `submit-size-${index}`, responses.slice(index, index + 2));
        expect((await h.read()).assessment.progress.missing).toBe(0);
        const before = h.memory.snapshot(), auditCount = h.auditCreate.mock.calls.length, auditWrites = h.auditWrite.mock.calls.length;
        await expect(h.submit('assessment-a', 7, 'oversized-submit')).rejects.toMatchObject({ code: 'ncsc_request_too_large', statusCode: 413 });
        expect(h.memory.snapshot()).toEqual(before); expect(h.auditCreate).toHaveBeenCalledTimes(auditCount);
        expect(h.auditWrite).toHaveBeenCalledTimes(auditWrites); expect(h.policy).not.toHaveBeenCalled();
        const shortened = responses.slice(0, 2).map(row => ({ ...row, rationale: { text: 'Shortened pending claim.' } }));
        await h.save('assessment-a', 7, 'shorter-before-submit', shortened);
        const submitted = await h.submit('assessment-a', 8, 'corrected-submit');
        expect(submitted.assessment).toMatchObject({ revision: 9, status: 'submitted' });
        expect(h.memory.rows(USAGE)[0].payload.counters.assessment_runs).toBe(1);
        const committed = h.memory.snapshot(); expect(await h.submit('assessment-a', 8, 'corrected-submit')).toEqual(submitted);
        expect(h.memory.snapshot()).toEqual(committed);
    });

    test('NCSC009 supported CJK text at every answer limit remains exact through save and submission', async () => {
        const h = await setup(); await h.create();
        const responses = allResponses('not_applicable').map(row => ({ ...row, rationale: { text: '界'.repeat(4000) } }));
        for (let index = 0; index < responses.length; index += 2) await h.save('assessment-a', index / 2, `cjk-${index}`, responses.slice(index, index + 2));
        const submitted = await h.submit('assessment-a', 7, 'cjk-submit');
        expect(submitted.assessment.responses.map(row => row.rationale.text)).toEqual(responses.map(row => row.rationale.text));
        expect(submitted.assessment).toMatchObject({ revision: 8, status: 'submitted' });
        expect((await h.read()).assessment).toEqual(submitted.assessment);
    });

    test.each(['malformed', 'oversized'])('NCSC009 retained %s records still fail503 without repair or candidate reclassification', async kind => {
        const h = await ready();
        const retained = h.memory.rows(VERSION).find(row => row.revision === 1);
        if (kind === 'oversized') retained.payload.scopePopulation.body.description = 'x'.repeat(256 * 1024);
        else retained.payload.state.status = 'invalid-retained-status';
        const before = h.memory.snapshot(), auditCount = h.auditCreate.mock.calls.length;
        await expect(h.read()).rejects.toMatchObject({ code: 'ncsc_unavailable', statusCode: 503 });
        await expect(h.save('assessment-a', 1, 'cannot-repair')).rejects.toMatchObject({ code: 'ncsc_unavailable', statusCode: 503 });
        expect(h.memory.snapshot()).toEqual(before); expect(h.auditCreate).toHaveBeenCalledTimes(auditCount);
        expect(h.auditWrite).not.toHaveBeenCalled(); expect(h.policy).not.toHaveBeenCalled();
    });

    test('optional closed composition leaves NCSC unavailable and rejects partial configuration', async () => {
        const h = await setup(), { ncsc, ...base } = h.config;
        const disabled = createPostgresDashboardRepository(base), before = h.memory.queries.length;
        await expectCode(disabled.listNcscAssessments(h.context, { limit: 50, afterAssessmentId: null }), 'ncsc_unavailable');
        await expectCode(disabled.executeNcscAssessment(h.context, createCommand()), 'ncsc_unavailable');
        expect(h.memory.queries).toHaveLength(before);
        for (const value of [null, {}, { audit: ncsc.audit }, { ...ncsc, resolveSubmissionQuota: true },
            { ...ncsc, policy: {} }, { ...ncsc, audit: { createEvent: () => {} } }]) {
            expect(() => createPostgresDashboardRepository({ ...base, ncsc: value })).toThrow();
        }
        expect((await disabled.readAdmissionSnapshot(h.fixture.scope, { authenticated: true, subjectKey: SUBJECT })).tenantAggregate)
            .toEqual(h.fixture.state.tenantAggregate);
    });

    test('creation, bounded save and submit retain exact public state, supporting records, one quota charge and one audit per mutation', async () => {
        const h = await setup(), created = await h.create();
        expect(created).toMatchObject({ schemaVersion: 1, action: 'create', assessment: { revision: 0, status: 'created',
            progress: { total: 14, answered: 0, missing: 14 } } });
        const originalScope = clone(h.memory.rows(VERSION)[0].payload.scopePopulation);
        const rows = allResponses(); rows[0] = { itemId: firstId, optionId: 'not_applicable', rationale: { text: 'Synthetic pending claim' } };
        rows[1].optionId = 'unknown';
        const saved = await h.save('assessment-a', 0, 'save-a', rows), submitted = await h.submit();
        expect(saved.assessment).toMatchObject({ revision: 1, status: 'in-progress', progress: { unknown: 1, notApplicableClaims: 1 } });
        expect(submitted.assessment).toMatchObject({ revision: 2, status: 'submitted', submission: { revision: 2 } });
        expect(submitted.assessment.submission.evaluation.countsCompletion.claimedNotApplicableAtoms).toBe(1);
        expect(counts(h)).toEqual([1, 3, 3]);
        expect(h.memory.rows(USAGE)[0].payload.counters.assessment_runs).toBe(1);
        expect(h.policy).toHaveBeenCalledTimes(1);
        expect(h.auditCreate).toHaveBeenCalledTimes(3); expect(h.auditWrite).not.toHaveBeenCalled();
        for (const row of h.memory.rows(VERSION)) expect(row.payload.scopePopulation).toEqual(originalScope);
        const retained = receipt(h).payload;
        expect(retained.event).toMatchObject({ actorSubjectKey: SUBJECT, ...h.fixture.scope,
            action: 'assessment.write', module: 'cyber_security', result: 'succeeded' });
        expect(retained.result).toEqual(submitted);
        expect(retained.quota.after.counters.assessment_runs - retained.quota.before.counters.assessment_runs).toBe(1);
        expect((await h.read()).assessment).toEqual(submitted.assessment);
        expect(h.auditWrite).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(submitted)).not.toContain(SUBJECT);
        expect(Object.keys(submitted)).toEqual(['schemaVersion', 'action', 'assessment']);
    });

    test('empty submission policy retains partial draft after reconstruction and rejects submit without a write', async () => {
        const h = await setup();
        const resolve = createNcscSubmissionQuotaResolver({ schemaVersion: 1, policies: [] });
        h.policy.mockImplementation(resolve);
        await h.create();
        const partial = await h.save('assessment-a', 0, 'partial-a', allResponses().slice(0, 2));
        expect(partial.assessment).toMatchObject({ revision: 1, status: 'in-progress',
            progress: { answered: 2, missing: 12 } });
        expect(h.policy).not.toHaveBeenCalled();

        const restarted = createPostgresDashboardRepository(h.config);
        const returned = await restarted.readNcscAssessment(h.context, { assessmentId: 'assessment-a' });
        expect(returned.assessment).toEqual(partial.assessment);
        await h.save('assessment-a', 1, 'completed-a', allResponses().slice(2));
        const before = h.memory.snapshot();
        await expectCode(h.submit('assessment-a', 2, 'no-policy-submit'), 'ncsc_submission_unavailable');
        expect(h.memory.snapshot()).toEqual(before);
        expect(h.policy).toHaveBeenCalledTimes(1);
        expect(h.memory.rows(USAGE)[0].payload.counters.assessment_runs).toBe(0);
    });

    test.each([
        { optionId: 'no', complete: true, credit: 0, upperCredit: 0, percent: 0, upperPercent: 0 },
        { optionId: 'partial', complete: true, credit: 14, upperCredit: 14, percent: 500, upperPercent: 500 },
        { optionId: 'unknown', complete: false, credit: 0, upperCredit: 28, percent: 0, upperPercent: 1000 },
        { optionId: 'not_applicable', complete: false, credit: 0, upperCredit: 28, percent: 0, upperPercent: 1000 }
    ])('saved $optionId answers remain distinct from scoring completion and attainment after restart/replay', async example => {
        const h = await setup(); await h.create();
        const responses = allResponses(example.optionId);
        const partial = await h.save('assessment-a', 0, 'partial-a', responses.slice(0, 13));
        expect(partial.assessment).toMatchObject({ status: 'in-progress', submission: null,
            progress: { total: 14, answered: 13, missing: 1 } });
        const before = h.memory.snapshot();
        await expectCode(h.submit('assessment-a', 1, 'incomplete-submit'), 'ncsc_state_conflict');
        expect(h.memory.snapshot()).toEqual(before);
        expect(h.policy).not.toHaveBeenCalled();

        const saved = await h.save('assessment-a', 1, 'last-answer', responses.slice(13));
        expect(saved.assessment).toMatchObject({ status: 'in-progress', submission: null,
            progress: { total: 14, answered: 14, missing: 0,
                unknown: example.optionId === 'unknown' ? 14 : 0,
                notApplicableClaims: example.optionId === 'not_applicable' ? 14 : 0 } });
        const submitted = await h.submit('assessment-a', 2, 'complete-submit');
        expect(submitted.assessment.progress).toEqual(saved.assessment.progress);
        const result = submitted.assessment.submission.evaluation;
        expect(result.countsCompletion).toMatchObject({ totalAtoms: 14, applicableAtoms: 14,
            approvedNotApplicableAtoms: 0, claimedNotApplicableAtoms: example.optionId === 'not_applicable' ? 14 : 0,
            missing: 0, unknown: example.complete ? 0 : 14,
            directUnknown: example.optionId === 'unknown' ? 14 : 0,
            completionNumerator: example.complete ? 14 : 0, completionDenominator: 14,
            completionStatus: example.complete ? 'complete' : 'provisional',
            completionPercentTenths: example.complete ? 1000 : 0 });
        expect(result.attainment).toMatchObject({ status: 'scored', creditUnitScale: 2, denominatorWeight: 14,
            lowerCreditUnits: example.credit, upperCreditUnits: example.upperCredit,
            lowerPercentTenths: example.percent, upperPercentTenths: example.upperPercent });

        const committed = h.memory.snapshot(), policyCalls = h.policy.mock.calls.length;
        h.clock.advance(1000);
        const restarted = createPostgresDashboardRepository(h.config), context = await createContext(h.fixture.scope, h.clock);
        const queryStart = h.memory.queries.length;
        expect(await restarted.executeNcscAssessment(context, submitCommand('assessment-a', 2, 'complete-submit'))).toEqual(submitted);
        expect((await restarted.readNcscAssessment(context, { assessmentId: 'assessment-a' })).assessment).toEqual(submitted.assessment);
        onlyReadsSince(h, queryStart);
        expect(h.memory.snapshot()).toEqual(committed);
        expect(h.policy).toHaveBeenCalledTimes(policyCalls);
    });

    test('partial patch preserves untouched responses, null deletes one answer and retained older rationale remains immutable', async () => {
        const h = await setup(); await h.create();
        await h.save('assessment-a', 0, 'na', [{ itemId: firstId, optionId: 'not_applicable', rationale: { text: 'Original pending rationale' } },
            { itemId: acceptedProfile.questions[1].id, optionId: 'yes', rationale: null }]);
        const before = clone(h.memory.rows(VERSION)[1]);
        const removed = await h.save('assessment-a', 1, 'remove-na', [{ itemId: firstId, optionId: null, rationale: null }]);
        expect(removed.assessment.responses).toEqual([{ itemId: acceptedProfile.questions[1].id, optionId: 'yes', rationale: null }]);
        expect(h.memory.rows(VERSION)[1]).toEqual(before);
        expect(h.memory.rows(VERSION)[2].payload.rationales).toEqual([]);
        await expectCode(h.submit('assessment-a', 2), 'ncsc_state_conflict');
        expect(counts(h)).toEqual([1, 3, 3]);
    });

    test('invalid transitions, stale revisions, duplicate creates and sealed saves change nothing', async () => {
        const h = await setup();
        await expectCode(h.save(), 'ncsc_not_found');
        await h.create();
        await expectCode(h.create('assessment-a', 'create-other'), 'ncsc_state_conflict');
        await expectCode(h.submit('assessment-a', 0), 'ncsc_state_conflict');
        await h.save();
        await expectCode(h.save('assessment-a', 0, 'stale-save'), 'ncsc_revision_conflict');
        await h.submit();
        await expectCode(h.save('assessment-a', 2, 'sealed-save'), 'ncsc_state_conflict');
        await expectCode(h.submit('assessment-a', 2, 'again'), 'ncsc_state_conflict');
        expect(counts(h)).toEqual([1, 3, 3]);
        expect(h.memory.rows(USAGE)[0].payload.counters.assessment_runs).toBe(1);
    });

    test('exact retries return the original ancestor after later writes and restart with no fresh facts or policy call', async () => {
        const h = await setup(), original = await h.create();
        h.clock.advance(1000);
        const saved = await h.save(); h.clock.advance(1000);
        await h.save('assessment-a', 1, 'save-later', [{ itemId: firstId, optionId: 'partial', rationale: null }]);
        const submitted = await h.submit('assessment-a', 2);
        const evidence = clone(h.memory.rows(RECEIPT)), policyCalls = h.policy.mock.calls.length, auditCalls = h.auditCreate.mock.calls.length;
        h.policy.mockImplementation(() => { throw new Error('Retry must not select today’s policy'); });
        const restarted = createPostgresDashboardRepository(h.config), context = await createContext(h.fixture.scope, h.clock);
        const queryStart = h.memory.queries.length;
        expect(await restarted.executeNcscAssessment(context, createCommand())).toEqual(original);
        expect(await restarted.executeNcscAssessment(context, saveCommand())).toEqual(saved);
        expect(await restarted.executeNcscAssessment(context, submitCommand('assessment-a', 2))).toEqual(submitted);
        expect(h.policy).toHaveBeenCalledTimes(policyCalls); expect(h.auditCreate).toHaveBeenCalledTimes(auditCalls);
        expect(h.memory.rows(RECEIPT)).toEqual(evidence); onlyReadsSince(h, queryStart);
        expect((await restarted.readNcscAssessment(context, { assessmentId: 'assessment-a' })).assessment).toEqual(submitted.assessment);
    });

    test.each(['payload', 'revision', 'action', 'actor'])('idempotency binding rejects changed %s under a retained key', async kind => {
        const h = await ready(), command = saveCommand(); let context = h.context;
        if (kind === 'payload') command.payload.responses[0].optionId = 'no';
        if (kind === 'revision') command.expectedRevision = 1;
        if (kind === 'action') { command.action = 'submit'; command.payload = {}; }
        if (kind === 'actor') {
            const other = SUBJECT.replace(/1$/, '2');
            const row = h.memory.rows('dashboard_membership_states')[0];
            row.payload = JSON.parse(JSON.stringify(row.payload).split(SUBJECT).join(other));
            context = await createContext(h.fixture.scope, h.clock, other);
        }
        const start = h.memory.queries.length;
        await expectCode(h.repository.executeNcscAssessment(context, command), 'ncsc_idempotency_conflict');
        onlyReadsSince(h, start); expect(counts(h)).toEqual([1, 2, 2]);
    });

    test('canonical list uses bounded ASCII keysets and excludes every other tenant and organisation', async () => {
        const memory = memoryDatabase(), a = await setup({ tenantId: 'tenant-A', organisationId: 'shared-org' }, memory),
            b = await setup({ tenantId: 'tenant-B', organisationId: 'shared-org' }, memory);
        for (const id of ['a', 'Z', 'A', 'b']) await a.create(id, 'same-key');
        await b.create('A', 'same-key');
        const page = await a.list(2);
        expect(page.assessments.map(row => row.assessmentId)).toEqual(['A', 'Z']);
        expect(page.nextAfterAssessmentId).toBe('Z');
        expect((await a.list(2, 'Z')).assessments.map(row => row.assessmentId)).toEqual(['a', 'b']);
        expect((await a.list(2, 'Z')).nextAfterAssessmentId).toBeNull();
        expect((await b.list()).assessments.map(row => row.assessmentId)).toEqual(['A']);
        const foreign = await createContext({ ...a.fixture.scope, organisationId: 'foreign-org' }, a.clock);
        await expectCode(a.repository.readNcscAssessment(foreign, { assessmentId: 'A' }), 'ncsc_access_denied');
        expect(memory.rows(HEAD)).toHaveLength(5);
        expect(Object.keys(page.assessments[0])).not.toContain('responses');
        for (const call of memory.queries.filter(row => row.sql.includes(`FROM nofries.${VERSION}`))) expect(call.sql).toContain('LIMIT 16');
    });

    test('same-tenant organisations isolate colliding assessment IDs, retry keys, saved results and quota', async () => {
        const memory = memoryDatabase(), a = await setup({ tenantId: 'shared-tenant', organisationId: 'org-A', capacity: 1 }, memory),
            b = await setup({ tenantId: 'shared-tenant', organisationId: 'org-B', capacity: 1 }, memory,
                a.fixture.state.tenantAggregate.tenant.revision);
        for (const h of [a, b]) await h.create();
        const savedA = await a.save('assessment-a', 0, 'save-a', allResponses('yes'));
        const savedB = await b.save('assessment-a', 0, 'save-a', allResponses('no'));
        const submittedA = await a.submit(), submittedB = await b.submit();
        expect(submittedA.assessment.submission.evaluation).toMatchObject({
            provenance: { organisationId: 'org-A' }, attainment: { lowerPercentTenths: 1000, upperPercentTenths: 1000 } });
        expect(submittedB.assessment.submission.evaluation).toMatchObject({
            provenance: { organisationId: 'org-B' }, attainment: { lowerPercentTenths: 0, upperPercentTenths: 0 } });
        expect(submittedA.assessment.revisionSha256).not.toBe(submittedB.assessment.revisionSha256);
        expect(submittedA.assessment.submission.evaluation.outputSha256).not.toBe(submittedB.assessment.submission.evaluation.outputSha256);
        expect(counts(a)).toEqual([2, 6, 6]);
        expect(memory.rows(USAGE).map(row => [row.organisation_id, row.payload.counters.assessment_runs]).sort())
            .toEqual([['org-A', 1], ['org-B', 1]]);

        const committed = memory.snapshot(), queryStart = memory.queries.length;
        for (const [h, saved, submitted, optionId] of [[a, savedA, submittedA, 'yes'], [b, savedB, submittedB, 'no']]) {
            const restarted = createPostgresDashboardRepository(h.config), context = await createContext(h.fixture.scope, h.clock);
            expect(await restarted.executeNcscAssessment(context, saveCommand('assessment-a', 0, 'save-a', allResponses(optionId)))).toEqual(saved);
            expect(await restarted.executeNcscAssessment(context, submitCommand())).toEqual(submitted);
            expect((await restarted.readNcscAssessment(context, { assessmentId: 'assessment-a' })).assessment).toEqual(submitted.assessment);
            const page = await restarted.listNcscAssessments(context, { limit: 50, afterAssessmentId: null });
            expect(page.assessments).toHaveLength(1);
            expect(page.assessments[0]).toMatchObject({ assessmentId: 'assessment-a', revisionSha256: submitted.assessment.revisionSha256 });
            expect(page.nextAfterAssessmentId).toBeNull();
            expect(h.policy).toHaveBeenCalledTimes(1);
        }
        onlyReadsSince(a, queryStart);
        expect(memory.snapshot()).toEqual(committed);
    });

    test('same-operation concurrent requests return one result and stale saves commit once under the transaction fence', async () => {
        const h = await setup();
        const creates = await Promise.all([h.create(), h.create()]);
        expect(creates[1]).toEqual(creates[0]); expect(counts(h)).toEqual([1, 1, 1]);
        const outcomes = await Promise.allSettled([h.save('assessment-a', 0, 'save-one'), h.save('assessment-a', 0, 'save-two')]);
        expect(outcomes.filter(row => row.status === 'fulfilled')).toHaveLength(1);
        expect(outcomes.find(row => row.status === 'rejected').reason.code).toBe('ncsc_revision_conflict');
        expect(counts(h)).toEqual([1, 2, 2]);
        expect(h.memory.transactions.filter(row => row.statements.some(sql => sql.includes(`INSERT INTO nofries.${VERSION}`)))
            .every(row => row.statements[0].endsWith('FOR UPDATE'))).toBe(true);
    });

    test.each(['tenant', 'organisation', 'membership', 'dashboard', 'module', 'framework', 'product'])
    ('current %s revocation denies list/read/mutations and exact retry before disclosing stored evidence', async kind => {
        const h = await ready();
        const before = counts(h);
        if (kind === 'tenant') await authorityCommand(h, 'tenant.transition', { toStatus: 'suspended' });
        if (kind === 'organisation') await authorityCommand(h, 'organisation.transition', { toStatus: 'suspended' });
        if (kind === 'membership') await authorityCommand(h, 'membership.command', { action: 'suspend', payload: { membershipId: 'synthetic-membership' } });
        if (['dashboard', 'module', 'framework'].includes(kind)) {
            const flags = clone(h.fixture.state.flags); flags.revision += 1;
            if (kind === 'dashboard') flags.enabled.dashboard = false;
            if (kind === 'module') flags.enabled.cyber_security = false;
            if (kind === 'framework') flags.frameworks = [];
            await authorityCommand(h, 'flags.update', flags);
        }
        if (kind === 'product') {
            const entitlement = clone(h.fixture.state.entitlementState); entitlement.revision += 1;
            entitlement.grants[0].status = 'revoked';
            await authorityCommand(h, 'entitlement.update', entitlement);
        }
        const start = h.memory.queries.length;
        await expectCode(h.list(), 'ncsc_access_denied'); await expectCode(h.read(), 'ncsc_access_denied');
        await expectCode(h.create(), 'ncsc_access_denied'); await expectCode(h.submit(), 'ncsc_access_denied');
        expect(h.memory.queries.slice(start).some(row => row.sql.includes('dashboard_ncsc'))).toBe(false);
        onlyReadsSince(h, start); expect(counts(h)).toEqual(before);
    });

    test.each(['missing', 'disabled', 'expired', 'revoked', 'suspended', 'future', 'assignment-missing',
        'assignment-revoked', 'assignment-expired', 'assignment-future'])
    ('advisor-only access requires current exact purchased service and assignment: %s', async mode => {
        const h = await setup({ role: 'fractional_advisor', service: mode !== 'missing' });
        if (mode === 'disabled') h.memory.rows('dashboard_feature_flags')[0].payload.enabled['service:fractional_advisory'] = false;
        if (['expired', 'revoked', 'suspended', 'future'].includes(mode)) {
            const grant = h.memory.rows('dashboard_entitlement_states')[0].payload.grants.find(row => row.code === 'fractional_advisory');
            if (mode === 'expired') grant.validUntil = NOW;
            if (mode === 'revoked') grant.status = 'revoked';
            if (mode === 'suspended') grant.status = 'suspended';
            if (mode === 'future') grant.validFrom = new Date(Date.parse(NOW) + 1000).toISOString();
        }
        if (mode === 'assignment-revoked') {
            const row = h.memory.rows('dashboard_advisor_assignments')[0]; row.status = row.payload.status = 'revoked';
        }
        if (mode === 'assignment-expired') h.memory.rows('dashboard_advisor_assignments')[0].payload.validUntil = NOW;
        if (mode === 'assignment-future') h.memory.rows('dashboard_advisor_assignments')[0].payload.validFrom = new Date(Date.parse(NOW) + 1000).toISOString();
        if (mode === 'assignment-missing') h.memory.rows('dashboard_advisor_assignments').splice(0);
        await expectCode(h.list(), 'ncsc_access_denied'); await expectCode(h.create(), 'ncsc_access_denied');
        expect(counts(h)).toEqual([0, 0, 0]);
    });

    test.each(['fractional_advisor', 'admin', 'editor', 'viewer'])('role %s follows its current permission without inherited advisor restrictions', async role => {
        const h = await setup({ role, service: role === 'fractional_advisor' });
        if (['admin', 'editor'].includes(role)) {
            const member = h.memory.rows('dashboard_membership_states')[0].payload;
            member.memberships[0].roles.push('fractional_advisor'); member.memberships[0].roles.sort();
            member.invitations[0].roles.push('fractional_advisor'); member.invitations[0].roles.sort();
        }
        if (role === 'viewer') { await expectCode(h.list(), 'ncsc_access_denied'); await expectCode(h.create(), 'ncsc_access_denied'); }
        else {
            expect((await h.list()).assessments).toEqual([]);
            await h.create(); await h.save(); await h.submit(); expect(h.memory.rows(USAGE)[0].payload.counters.assessment_runs).toBe(1);
        }
    });

    test.each(['service-disabled', 'service-revoked', 'service-suspended', 'service-expired', 'assignment-revoked', 'assignment-expired'])
    ('changed advisor authority %s prevents exact successful receipt replay', async mode => {
        const expiry = new Date(Date.parse(NOW) + 1000).toISOString();
        const h = await ready({ role: 'fractional_advisor', service: true,
            ...(mode === 'service-expired' ? { serviceEndsAt: expiry } : {}) });
        await h.submit();
        if (mode === 'service-disabled') h.memory.rows('dashboard_feature_flags')[0].payload.enabled['service:fractional_advisory'] = false;
        if (['service-revoked', 'service-suspended'].includes(mode)) {
            h.memory.rows('dashboard_entitlement_states')[0].payload.grants.find(row => row.code === 'fractional_advisory').status = mode.slice(8);
        }
        if (mode === 'service-expired') h.clock.set(expiry);
        if (mode === 'assignment-revoked') {
            const row = h.memory.rows('dashboard_advisor_assignments')[0]; row.status = row.payload.status = 'revoked';
        }
        if (mode === 'assignment-expired') h.memory.rows('dashboard_advisor_assignments')[0].payload.validUntil = NOW;
        const before = h.memory.snapshot(), start = h.memory.queries.length;
        await expectCode(h.submit(), 'ncsc_access_denied'); onlyReadsSince(h, start);
        expect(h.memory.snapshot()).toEqual(before); expect(h.policy).toHaveBeenCalledTimes(1);
    });

    test('unsupported suspended assignment status is malformed durable evidence, never an implicit grant', async () => {
        const h = await setup({ role: 'fractional_advisor', service: true });
        const row = h.memory.rows('dashboard_advisor_assignments')[0]; row.status = row.payload.status = 'suspended';
        await expectCode(h.list(), 'ncsc_unavailable'); await expectCode(h.create(), 'ncsc_unavailable');
        expect(counts(h)).toEqual([0, 0, 0]);
    });

    test('facade rejects forged context, unsupported selected scope and getter-bearing intent before database I/O', async () => {
        const h = await setup(), start = h.memory.queries.length;
        await expectCode(h.repository.executeNcscAssessment(clone(h.context), createCommand()), 'ncsc_access_denied');
        const selected = await createContext({ ...h.fixture.scope, tenantId: 'synthetic-tenant-é' }, h.clock);
        await expectCode(h.repository.executeNcscAssessment(selected, createCommand()), 'ncsc_selected_scope_unsupported');
        let reads = 0; const command = createCommand();
        Object.defineProperty(command.payload.scopePopulation, 'description', { enumerable: true, get() { reads += 1; return 'forged'; } });
        await expect(h.repository.executeNcscAssessment(h.context, command)).rejects.toBeInstanceOf(NcscAssessmentError);
        expect(reads).toBe(0); expect(h.memory.queries).toHaveLength(start);
    });

    test.each([
        ['NUL', '\u0000'], ['lone high surrogate', '\uD800'], ['lone low surrogate', '\uDC00']
    ].flatMap(([label, invalid]) => ['create', 'save'].map(action => [action, label, invalid])))
    ('Unicode direct facade %s rejects %s before any database or audit access', async (action, _label, invalid) => {
        const h = await setup(), value = `Synthetic ${invalid} text`;
        if (action === 'save') await h.create();
        const command = action === 'create' ? createCommand('assessment-a', 'unicode-create', value)
            : saveCommand('assessment-a', 0, 'unicode-save', [{ itemId: firstId, optionId: 'not_applicable', rationale: { text: value } }]);
        const before = h.memory.snapshot(), queryCount = h.memory.queries.length, transactionCount = h.memory.transactions.length,
            auditCount = h.auditCreate.mock.calls.length;
        await expect(h.repository.executeNcscAssessment(h.context, command))
            .rejects.toMatchObject({ code: 'ncsc_input_invalid', statusCode: 400 });
        expect(h.memory.queries).toHaveLength(queryCount);
        expect(h.memory.transactions).toHaveLength(transactionCount);
        expect(h.memory.snapshot()).toEqual(before);
        expect(h.auditCreate).toHaveBeenCalledTimes(auditCount);
        expect(h.auditWrite).not.toHaveBeenCalled(); expect(h.policy).not.toHaveBeenCalled();
    });

    test.each([
        ['multilingual, astral and non-NUL controls', 'Māori 日本語 العربية e\u0301 \uD83D\uDE80\n\t\r\b\f\u0001\u007F unchanged'],
        ['exactly 4000 UTF-16 units', '\uD83D\uDE80'.repeat(2000)]
    ])('Unicode direct facade retains %s in descriptions and N/A rationales', async (_label, value) => {
        const h = await setup();
        const created = await h.repository.executeNcscAssessment(h.context, createCommand('assessment-a', 'unicode-create', value));
        expect(created.assessment.scopePopulation.description).toBe(value);
        const saved = await h.repository.executeNcscAssessment(h.context, saveCommand('assessment-a', 0, 'unicode-save',
            [{ itemId: firstId, optionId: 'not_applicable', rationale: { text: value } }]));
        expect(saved.assessment.responses[0].rationale.text).toBe(value);
        const read = await h.read();
        expect(read.assessment.scopePopulation.description).toBe(value);
        expect(read.assessment.responses[0].rationale.text).toBe(value);
        expect(h.memory.rows(VERSION)[1].payload.scopePopulation.body.description).toBe(value);
        expect(h.memory.rows(VERSION)[1].payload.rationales[0].body.text).toBe(value);

        const overLimit = '\uD83D\uDE80'.repeat(2000) + 'x', before = h.memory.snapshot(), queryCount = h.memory.queries.length,
            transactionCount = h.memory.transactions.length;
        const commands = [createCommand('assessment-b', 'oversized-create', overLimit), saveCommand('assessment-a', 1, 'oversized-save',
            [{ itemId: firstId, optionId: 'not_applicable', rationale: { text: overLimit } }])];
        for (const command of commands) {
            await expect(h.repository.executeNcscAssessment(h.context, command))
                .rejects.toMatchObject({ code: 'ncsc_input_invalid', statusCode: 400 });
        }
        expect(h.memory.queries).toHaveLength(queryCount); expect(h.memory.transactions).toHaveLength(transactionCount);
        expect(h.memory.snapshot()).toEqual(before);
    });

    test('two submissions competing for the last unit commit one sealed assessment and one charge', async () => {
        const h = await ready({ capacity: 1 });
        await h.create('assessment-b', 'create-b'); await h.save('assessment-b', 0, 'save-b');
        const results = await Promise.allSettled([h.submit(), h.submit('assessment-b', 1, 'submit-b')]);
        expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1);
        expect(results.find(row => row.status === 'rejected').reason.code).toBe('ncsc_quota_exceeded');
        expect(h.memory.rows(USAGE)[0].payload.counters.assessment_runs).toBe(1);
        expect(h.memory.rows(HEAD).map(row => row.revision).sort()).toEqual([1, 2]);
        expect(h.memory.rows(RECEIPT).filter(row => row.payload.action === 'submit')).toHaveLength(1);
    });

    test('an asynchronous approved policy charges once and exact replay never reloads it', async () => {
        const h = await ready(), before = h.memory.snapshot(); let release, entered;
        const started = new Promise(resolve => { entered = resolve; });
        h.policy.mockImplementation(selection => new Promise(resolve => {
            release = () => resolve(h.adapters.resolveSubmissionQuota(selection)); entered();
        }));
        const pending = h.submit(); await started;
        expect(h.memory.snapshot()).toEqual(before); release();
        const original = await pending;
        expect(h.memory.rows(USAGE)[0].payload.counters.assessment_runs).toBe(1);
        h.policy.mockImplementation(() => Promise.reject(new Error('Policy store is unavailable after commit')));
        expect(await h.submit()).toEqual(original);
        expect(h.policy).toHaveBeenCalledTimes(1);
        expect(h.memory.rows(USAGE)[0].payload.counters.assessment_runs).toBe(1);
    });
    test('authority expiring during asynchronous policy read rolls back before any assessment write', async () => {
        const h = await ready(), before = h.memory.snapshot(); let release, entered;
        const started = new Promise(resolve => { entered = resolve; });
        h.policy.mockImplementation(selection => new Promise(resolve => {
            const retained = h.adapters.resolveSubmissionQuota(selection);
            release = () => resolve(retained); entered();
        }));
        const queries = h.memory.queries.length, pending = h.submit(); await started;
        h.clock.set('2026-09-08T09:00:00.000Z'); release();
        await expectCode(pending, 'ncsc_access_denied');
        expect(h.memory.snapshot()).toEqual(before); onlyReadsSince(h, queries);
    });
    test('asynchronous missing policy is a no-write refusal and does not seal the draft', async () => {
        const h = await ready(), before = h.memory.snapshot();
        h.policy.mockImplementation(async () => {
            throw Object.assign(new Error('ncsc_submission_policy_unavailable'), { code: 'ncsc_submission_unavailable' });
        });
        await expectCode(h.submit(), 'ncsc_submission_unavailable');
        expect(h.memory.snapshot()).toEqual(before);
        expect((await h.read()).assessment.status).toBe('in-progress');
    });

    test('policy receives only detached frozen scope and original first-execution facts', async () => {
        const h = await ready();
        h.policy.mockImplementation(selection => {
            expect(Object.keys(selection).sort()).toEqual(['tenantId', 'organisationId', 'assessmentId', 'actorSubjectKey',
                'moduleId', 'profileRef', 'productGrantId', 'agreementRef', 'expectedRevision', 'submissionRevision', 'at'].sort());
            expect(Object.isFrozen(selection)).toBe(true); expect(Object.isFrozen(selection.profileRef)).toBe(true);
            expect(selection).toMatchObject({ ...h.fixture.scope, assessmentId: 'assessment-a', actorSubjectKey: SUBJECT,
                expectedRevision: 1, submissionRevision: 2, at: NOW });
            return h.adapters.resolveSubmissionQuota(selection);
        });
        await h.submit();
        expect(receipt(h).payload.quota.policy).toMatchObject({ policyId: 'synthetic-ncsc-policy', policyRevision: 1, amount: 1 });
    });

    test.each(['absent', 'rejected-promise', 'thenable', 'getter', 'scope', 'profile', 'grant', 'agreement',
        'zero', 'fraction', 'expired', 'future', 'extra'])('invalid explicit submission policy %s rolls back without a charge', async mode => {
        const h = await ready(); let hooks = 0;
        h.policy.mockImplementation(selection => {
            const policy = h.adapters.resolveSubmissionQuota(selection);
            if (mode === 'absent') return null;
            if (mode === 'rejected-promise') return Promise.reject(new Error('private-policy-failure'));
            if (mode === 'thenable') return { then() { hooks += 1; } };
            if (mode === 'getter') Object.defineProperty(policy, 'amount', { get() { hooks += 1; return 1; }, enumerable: true });
            if (mode === 'scope') policy.tenantId = 'foreign-tenant';
            if (mode === 'profile') policy.profileRef.profileVersion = 'other';
            if (mode === 'grant') policy.productGrantId = 'other-product';
            if (mode === 'agreement') policy.agreementRef = 'other-agreement';
            if (mode === 'zero') policy.amount = 0;
            if (mode === 'fraction') policy.amount = 0.5;
            if (mode === 'expired') policy.validUntil = NOW;
            if (mode === 'future') policy.validFrom = '2026-09-08T00:00:00.000Z';
            if (mode === 'extra') policy.approved = true;
            return policy;
        });
        await expectCode(h.submit(), 'ncsc_unavailable');
        expect(counts(h)).toEqual([1, 2, 2]); expect(h.memory.rows(USAGE)[0].payload.counters.assessment_runs).toBe(0);
        expect(hooks).toBe(0);
    });

    test.each(['version', 'head', 'usage', 'receipt'])('failure at %s write rolls back all assessment, quota and audit evidence', async boundary => {
        const h = await ready(), before = h.memory.snapshot();
        const table = { version: VERSION, head: HEAD, usage: USAGE, receipt: RECEIPT }[boundary];
        h.memory.failNext({ stage: 'query', code: 'synthetic_write_failed', matches: sql =>
            !sql.startsWith('SELECT') && sql.includes('nofries.' + table + ' ') });
        await expectCode(h.submit(), 'ncsc_unavailable');
        expect(h.memory.snapshot()).toEqual(before);
        expect(h.memory.rows(RECEIPT).filter(row => row.payload.action === 'submit')).toEqual([]);
    });

    test.each(['create', 'read'])('audit %s failure cannot yield assessment success or partial durable evidence', async mode => {
        const h = await ready(), before = h.memory.snapshot();
        if (mode === 'create') { h.auditCreate.mockImplementation(() => { throw new Error('private-audit-failure'); }); await expectCode(h.submit(), 'ncsc_unavailable'); }
        else { h.auditWrite.mockRejectedValue(new Error('private-sink-failure')); await expectCode(h.read(), 'ncsc_unavailable'); }
        expect(h.memory.snapshot()).toEqual(before);
    });

    test('read awaits its audit sink and rechecks expiry afterward', async () => {
        const h = await ready(); let release;
        h.auditWrite.mockImplementation(() => new Promise(resolve => { release = resolve; }));
        let finished = false; const pending = h.read().finally(() => { finished = true; });
        for (let i = 0; i < 100 && !release; i += 1) await new Promise(resolve => setImmediate(resolve));
        expect(release).toEqual(expect.any(Function)); expect(finished).toBe(false);
        h.clock.set('2026-09-08T09:00:00.000Z'); release();
        await expectCode(pending, 'ncsc_access_denied');
    });

    test.each(['postgres_commit_failed', 'postgres_rollback_failed'])('lost committed response %s reconciles the exact original result without another write', async code => {
        const h = await ready(); h.memory.failNext({ stage: 'afterCommit', code });
        const original = await h.submit();
        expect(original).toEqual(receipt(h).payload.result);
        expect(h.memory.rows(USAGE)[0].payload.counters.assessment_runs).toBe(1);
        expect(h.memory.transactions.at(-1).statements.every(sql => sql.startsWith('SELECT'))).toBe(true);
        expect(h.policy).toHaveBeenCalledTimes(1); expect(counts(h)).toEqual([1, 3, 3]);
    });

    test.each(['beforeWork', 'beforeCommit'])('ambiguous %s failure with absent committed evidence makes one read-only reconciliation', async stage => {
        const h = await ready(), before = h.memory.snapshot(), start = h.memory.transactions.length;
        h.memory.failNext({ stage, code: 'postgres_commit_failed' });
        await expectCode(h.submit(), 'ncsc_outcome_ambiguous');
        expect(h.memory.transactions.length - start).toBe(2);
        expect(h.memory.transactions.at(-1).statements.every(sql => sql.startsWith('SELECT'))).toBe(true);
        expect(h.memory.snapshot()).toEqual(before);
    });

    test.each(['list', 'read'])('%s COMMIT failure stays unavailable without mutation receipt reconciliation', async operation => {
        const h = await ready(), start = h.memory.transactions.length, queryStart = h.memory.queries.length;
        h.memory.failNext({ stage: 'afterCommit', code: 'postgres_commit_failed' });
        await expectCode(h[operation](), 'ncsc_unavailable');
        expect(h.memory.transactions.length - start).toBe(1); onlyReadsSince(h, queryStart);
        expect(h.memory.queries.slice(queryStart).some(row => row.sql.includes(`FROM nofries.${RECEIPT}`))).toBe(false);
    });

    test.each(['lock', 'receipt-read', 'last-write'])('expiry crossing at %s denies before the authorization linearization point', async when => {
        const h = await ready(), before = h.memory.snapshot();
        h.memory.hooks.afterQuery = async ({ sql }) => {
            if ((when === 'lock' && sql.endsWith('FOR UPDATE')) ||
                (when === 'receipt-read' && sql.startsWith(`SELECT * FROM nofries.${RECEIPT}`)) ||
                (when === 'last-write' && sql.startsWith(`INSERT INTO nofries.${RECEIPT}`))) h.clock.set('2026-09-08T09:00:00.000Z');
        };
        await expectCode(h.submit(), 'ncsc_access_denied');
        expect(h.memory.snapshot()).toEqual(before);
    });

    test('expiry beginning during successful COMMIT does not alter the already checked original result', async () => {
        const h = await ready();
        h.memory.hooks.beforeCommit = async () => { h.clock.set('2026-09-08T09:00:00.000Z'); };
        const result = await h.submit(); expect(result.assessment.status).toBe('submitted');
        await expectCode(h.submit(), 'ncsc_access_denied');
        expect(h.memory.rows(USAGE)[0].payload.counters.assessment_runs).toBe(1);
    });

    test('first submission rolls back when its selected product expires and a zero-capacity future product activates during receipt insertion', async () => {
        const rollover = new Date(Date.parse(NOW) + 1000).toISOString();
        const h = await ready({ capacity: 1, grantEndsAt: rollover });
        const entitlement = clone(h.fixture.state.entitlementState), original = entitlement.grants[0];
        entitlement.revision += 1;
        entitlement.grants.push({ ...clone(original), grantId: 'future-product', agreementRef: 'synthetic-future-agreement',
            validFrom: rollover, validUntil: '2026-09-08T09:00:00.000Z',
            limits: { ...original.limits, assessment_runs: 0 } });
        entitlement.grants.sort((a, b) => a.grantId < b.grantId ? -1 : 1);
        await authorityCommand(h, 'entitlement.update', entitlement, 'retain-future-product');
        const before = h.memory.snapshot(); let receiptInserted = false;
        h.memory.hooks.afterQuery = async ({ sql }) => {
            if (sql.startsWith(`INSERT INTO nofries.${RECEIPT}`)) {
                receiptInserted = true;
                h.clock.set(rollover);
            }
        };
        await expectCode(h.submit(), 'ncsc_access_denied');
        expect(receiptInserted).toBe(true);
        expect(h.policy).toHaveBeenCalledTimes(1);
        expect(h.policy.mock.calls[0][0]).toMatchObject({ productGrantId: 'synthetic-product', at: NOW });
        expect(h.memory.snapshot()).toEqual(before);
        expect(counts(h)).toEqual([1, 2, 2]);
        expect(h.memory.rows(USAGE).map(row => row.payload.counters.assessment_runs)).toEqual([0, 0]);
        expect(h.auditWrite).not.toHaveBeenCalled();
        expect(h.adapters.events).toEqual([]);
    });

    test('renewed current product retains original charge, old audit and original retry response', async () => {
        const h = await ready(), original = await h.submit();
        const retained = clone(receipt(h)), entitlement = clone(h.fixture.state.entitlementState);
        entitlement.revision += 1;
        const prior = entitlement.grants.find(row => row.grantId === 'synthetic-product');
        const renewed = { ...clone(prior), grantId: 'renewed-product', agreementRef: 'synthetic-renewed-agreement' };
        prior.status = 'revoked'; entitlement.grants.push(renewed);
        entitlement.grants.sort((a, b) => a.grantId < b.grantId ? -1 : 1);
        await authorityCommand(h, 'entitlement.update', entitlement, 'renew-product');
        const flags = clone(h.fixture.state.flags); flags.revision += 1;
        await authorityCommand(h, 'flags.update', flags, 'later-flags');
        h.policy.mockImplementation(() => { throw new Error('No new commercial policy on replay'); });
        const start = h.memory.queries.length;
        expect(await h.submit()).toEqual(original); onlyReadsSince(h, start);
        expect(receipt(h)).toEqual(retained);
        expect(h.memory.rows(USAGE).find(row => row.grant_id === 'synthetic-product').payload.counters.assessment_runs).toBe(1);
        expect(h.memory.rows(USAGE).find(row => row.grant_id === 'renewed-product').payload.counters.assessment_runs).toBe(0);
    });

    test.each(['older-usage-revision', 'same-revision-lower-counter', 'later-revision-lower-counter', 'missing-counter',
        'original-grant-missing', 'original-grant-repurposed', 'policy-amount', 'policy-hash', 'original-selection',
        'usage-after', 'authority-vector', 'audit-actor', 'original-command', 'result-body'])
    ('corrupt retained receipt or quota evidence %s never replays or repairs itself', async mode => {
        const h = await ready(); await h.submit();
        const row = receipt(h), retained = row.payload, usage = h.memory.rows(USAGE)[0];
        if (mode === 'older-usage-revision') { usage.revision = usage.payload.revision = 0; }
        if (mode === 'same-revision-lower-counter') usage.payload.counters.assessment_runs = 0;
        if (mode === 'later-revision-lower-counter') { usage.revision = usage.payload.revision = 2; usage.payload.counters.assessment_runs = 0; }
        if (mode === 'missing-counter') delete usage.payload.counters.assessment_runs;
        if (mode === 'original-grant-missing') {
            const entitlement = h.memory.rows('dashboard_entitlement_states')[0].payload;
            const current = entitlement.grants.find(grant => grant.grantId === 'synthetic-product');
            current.grantId = 'replacement-product'; usage.grant_id = usage.payload.grantId = 'replacement-product';
        }
        if (mode === 'original-grant-repurposed') h.memory.rows('dashboard_entitlement_states')[0].payload.grants[0].agreementRef = 'other-agreement';
        if (mode === 'policy-amount') { retained.quota.policy.amount = 2; retained.quota.policySha256 = store.digest('policy', retained.quota.policy); }
        if (mode === 'policy-hash') retained.quota.policySha256 = 'f'.repeat(64);
        if (mode === 'original-selection') retained.quota.selection.actorSubjectKey = SUBJECT.replace(/1$/, '2');
        if (mode === 'usage-after') retained.quota.after.counters.assessment_runs = 0;
        if (mode === 'authority-vector') retained.resultAuthority.flags = 99;
        if (mode === 'audit-actor') retained.event.actorSubjectKey = SUBJECT.replace(/1$/, '2');
        if (mode === 'original-command') retained.command.actorSubjectKey = SUBJECT.replace(/1$/, '2');
        if (mode === 'result-body') {
            retained.result.assessment.scopePopulation.description = 'Substituted private result';
            retained.resultSha256 = row.result_sha256 = store.digest('result', retained.result);
        }
        const before = h.memory.snapshot(), start = h.memory.queries.length;
        await expectCode(h.submit(), 'ncsc_unavailable'); onlyReadsSince(h, start);
        expect(h.memory.snapshot()).toEqual(before);
    });

    test('fully rehashed receipt pointing to a different valid ancestor fails exact original transition reconstruction', async () => {
        const h = await ready();
        await h.save('assessment-a', 1, 'later-save', [{ itemId: firstId, optionId: 'partial', rationale: null }]);
        const row = receipt(h, 'save-a'), wrongVersion = h.memory.rows(VERSION)[2];
        row.result_revision = row.payload.resultRevision = wrongVersion.revision;
        row.version_sha256 = row.payload.versionSha256 = wrongVersion.payload_sha256;
        row.payload.predecessorSha256 = wrongVersion.parent_sha256;
        row.payload.result = store.publicResult('save', { envelope: wrongVersion.payload, revisionSha256: wrongVersion.payload_sha256 });
        row.result_sha256 = row.payload.resultSha256 = store.digest('result', row.payload.result);
        const before = h.memory.snapshot(), start = h.memory.queries.length;
        await expectCode(h.repository.executeNcscAssessment(h.context, saveCommand()), 'ncsc_unavailable');
        onlyReadsSince(h, start); expect(h.memory.snapshot()).toEqual(before);
    });

    test.each(['head-older', 'head-future', 'head-missing', 'version-missing', 'parent-digest', 'parent-revision',
        'payload-digest', 'scope-owner', 'revision-jump', 'submitted-descendant', 'batch-overflow'])
    ('inconsistent history %s denies reads and retries with no repair write', async mode => {
        const h = await ready(); await h.submit();
        const versions = h.memory.rows(VERSION), head = h.memory.rows(HEAD)[0];
        if (mode === 'head-older') { head.revision = 1; head.payload_sha256 = versions[1].payload_sha256; }
        if (mode === 'head-future') head.revision = 129;
        if (mode === 'head-missing') h.memory.rows(HEAD).splice(0);
        if (mode === 'version-missing') versions.splice(1, 1);
        if (mode === 'parent-digest') versions[2].parent_sha256 = 'f'.repeat(64);
        if (mode === 'parent-revision') versions[2].parent_revision = 0;
        if (mode === 'payload-digest') versions[1].payload.state.responses[0].optionId = 'no';
        if (mode === 'scope-owner') versions[1].payload.tenantId = 'foreign-tenant';
        if (mode === 'revision-jump') versions[1].revision = 9;
        if (mode === 'submitted-descendant') {
            const extra = clone(versions[2]); extra.revision = 3; extra.parent_revision = 2; extra.parent_sha256 = versions[2].payload_sha256;
            extra.payload.revision = extra.payload.state.revision = extra.payload.state.submission.revision = 3;
            extra.payload.submission = require('../api/shared/assessmentLifecycle/ncscAssessmentSubmission').buildNcscSubmission({ ...extra.payload, submission: null });
            extra.payload_sha256 = store.digest('version', extra.payload);
            versions.push(extra); head.revision = 3; head.payload_sha256 = extra.payload_sha256;
        }
        if (mode === 'batch-overflow') h.memory.hooks.afterQuery = async ({ sql }, _draft, result) => {
            if (sql.includes(`FROM nofries.${VERSION}`)) result.rows = Array.from({ length: 17 }, () => clone(versions[0]));
        };
        const before = h.memory.snapshot(), start = h.memory.queries.length;
        await expectCode(h.read(), 'ncsc_unavailable'); await expectCode(h.create(), 'ncsc_unavailable');
        onlyReadsSince(h, start); expect(h.memory.snapshot()).toEqual(before);
    });

    test('complete logical snapshot restore into a fresh repository preserves seals, original retries and all three tables', async () => {
        const h = await ready(), original = await h.submit(), snapshot = h.memory.snapshot();
        const restoredMemory = memoryDatabase(snapshot), adapters = createNcscAdapters(h.clock);
        const policy = jest.fn(() => { throw new Error('Restore replay must not select quota'); });
        const restored = createPostgresDashboardRepository({ database: restoredMemory.database, clock: h.clock.now,
            authoriseAdministration: () => false, ncsc: { audit: adapters.audit, resolveSubmissionQuota: policy } });
        const context = await createContext(h.fixture.scope, h.clock);
        expect((await restored.readNcscAssessment(context, { assessmentId: 'assessment-a' })).assessment).toEqual(original.assessment);
        expect(await restored.executeNcscAssessment(context, submitCommand())).toEqual(original);
        expect(restoredMemory.snapshot()).toEqual(snapshot); expect(policy).not.toHaveBeenCalled();
        expect([HEAD, VERSION, RECEIPT].map(table => restoredMemory.rows(table).length)).toEqual([1, 3, 3]);
    });

    test('last save at revision127 and submission128 succeed; next writes fail while history and exact retries remain readable', async () => {
        const h = await setup(); await h.create();
        // Seed a synthetic, deterministically generated chain to isolate the
        // ceiling test from O(n²) repeated round-trip history reads.
        seedHistory(h, 'assessment-a', 126);
        const lastSave = await h.save('assessment-a', 126, 'last-save', [{ itemId: firstId, optionId: 'partial', rationale: null }]);
        expect(lastSave.assessment.revision).toBe(127);
        await expectCode(h.save('assessment-a', 127, 'over-save'), 'ncsc_state_conflict');
        const submitted = await h.submit('assessment-a', 127, 'last-submit');
        expect(submitted.assessment.revision).toBe(128); expect(h.memory.rows(VERSION)).toHaveLength(129);
        const before = h.memory.snapshot();
        await expectCode(h.submit('assessment-a', 128, 'over-submit'), 'ncsc_state_conflict');
        expect(await h.submit('assessment-a', 127, 'last-submit')).toEqual(submitted);
        expect((await h.read()).assessment).toEqual(submitted.assessment);
        expect(h.memory.snapshot()).toEqual(before);
        expect(h.memory.queries.filter(row => row.sql.includes(`FROM nofries.${VERSION}`)).every(row => row.sql.endsWith('LIMIT 16'))).toBe(true);
    }, 90000);

    test('page work budget returns two maximal histories across lossless cursors without truncating either chain', async () => {
        const h = await setup(); await h.create(); await h.create('assessment-b', 'create-b');
        seedHistory(h, 'assessment-a', 128, true); seedHistory(h, 'assessment-b', 128, true);
        const start = h.memory.queries.length, first = await h.list(100);
        expect(first.assessments.map(row => [row.assessmentId, row.revision])).toEqual([['assessment-a', 128]]);
        expect(first.nextAfterAssessmentId).toBe('assessment-a');
        const historyReads = h.memory.queries.slice(start).filter(row => row.sql.includes(`FROM nofries.${VERSION}`));
        expect(historyReads).toHaveLength(9);
        expect(historyReads.every(row => row.args[2] === 'assessment-a')).toBe(true);
        const second = await h.list(100, first.nextAfterAssessmentId);
        expect(second.assessments.map(row => [row.assessmentId, row.revision])).toEqual([['assessment-b', 128]]);
        expect(second.nextAfterAssessmentId).toBeNull();
        expect(h.memory.rows(VERSION)).toHaveLength(258);
        expect((await h.list(1)).nextAfterAssessmentId).toBe('assessment-a');
    }, 90000);
});
