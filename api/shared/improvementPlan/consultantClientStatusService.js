'use strict';

const { isProxy } = require('node:util').types;
const { copy, fields, freeze, instant, digest, uuid } = require('../appLifecycle/dashboardRuntimeRecords');

// One row per authorised client: where its cyber assessment stands and which
// existing dashboard view a consultant should open next. Every field comes from
// a retained server record; nothing is estimated. Unknown stays unknown.
// MAX_CLIENTS matches the portfolio binder's listBindings page limit.
const MAX_CLIENTS = 10, ASSESSMENT_PAGE = 20, MAX_ASSESSMENT_PAGES = 3, MAX_OUTPUT_BYTES = 131072;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const DRAFT = ['created', 'in-progress'], SUBMITTED = ['submitted'];
// Existing dashboard routes. A consultant must still select the client; the
// existing selection flow rechecks membership before any view opens.
const ROUTE = Object.freeze({ assessment: '#cyber-security', plan: '#improvement-plan' });

class ConsultantClientStatusError extends Error {
    constructor(code = 'client_status_unavailable', statusCode = 503) {
        super(code); this.name = 'ConsultantClientStatusError'; this.code = code; this.statusCode = statusCode;
        delete this.stack; Object.freeze(this);
    }
}
const invalid = () => { throw new ConsultantClientStatusError('client_status_input_invalid', 400); };
const broken = () => { throw new ConsultantClientStatusError(); };

function normaliseConsultantClientStatusPage(input) {
    try {
        const value = fields(copy(input, 1024), ['limit', 'afterBindingId']);
        if (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > MAX_CLIENTS) invalid();
        if (value.afterBindingId !== null) uuid(value.afterBindingId);
        return freeze(value);
    } catch { invalid(); }
}
function knownUnavailable(error) {
    if (isProxy(error)) return false;
    return error && typeof error === 'object' && [403, 404, 503].includes(Object.getOwnPropertyDescriptor(error, 'statusCode')?.value);
}
function id(value) { if (typeof value !== 'string' || !ID.test(value)) broken(); return value; }
function count(value) { if (!Number.isSafeInteger(value) || value < 0) broken(); return value; }

// Only the fields a status needs leave this module; profile, digests and
// responses are dropped. Progress is the server's own answered/total count.
function summary(input) {
    const row = input && typeof input === 'object' && !Array.isArray(input) && !isProxy(input) ? input : broken();
    const status = row.status;
    if (![...DRAFT, ...SUBMITTED].includes(status)) broken();
    const progress = row.progress && typeof row.progress === 'object' && !isProxy(row.progress) ? row.progress : broken();
    const total = count(progress.total), answered = count(progress.answered);
    if (answered > total) broken();
    return { assessmentId: id(row.assessmentId), status, revision: count(row.revision), updatedAt: instant(row.updatedAt),
        progress: { answered, total } };
}
const latest = rows => rows.reduce((best, row) => !best || row.updatedAt > best.updatedAt ||
    row.updatedAt === best.updatedAt && row.assessmentId > best.assessmentId ? row : best, null);

async function readAssessments(port, bindingId) {
    if (port === null) return { coverage: 'not_checked', draft: null, submitted: null, draftCount: 0, submittedCount: 0 };
    const rows = [], seen = new Set();
    let after = null, pages = 0, complete = false;
    while (pages < MAX_ASSESSMENT_PAGES) {
        const page = await port(bindingId, { limit: ASSESSMENT_PAGE, afterAssessmentId: after }); pages++;
        if (!page || !Array.isArray(page.assessments) || page.assessments.length > ASSESSMENT_PAGE) broken();
        for (const item of page.assessments) {
            const row = summary(item);
            if (seen.has(row.assessmentId)) broken();
            seen.add(row.assessmentId); rows.push(row);
        }
        if (page.nextAfterAssessmentId === null) { complete = true; break; }
        // A cursor that does not advance would hide records; refuse it.
        if (id(page.nextAfterAssessmentId) === after || !page.assessments.length && after === null) broken();
        after = page.nextAfterAssessmentId;
    }
    const drafts = rows.filter(row => DRAFT.includes(row.status)), submitted = rows.filter(row => SUBMITTED.includes(row.status));
    // "Latest" is only meaningful once every assessment has been seen. A
    // partial scan reports lower-bound counts and names no record.
    return { coverage: complete ? 'complete' : 'partial', draft: complete ? latest(drafts) : null,
        submitted: complete ? latest(submitted) : null, draftCount: drafts.length, submittedCount: submitted.length };
}
async function readPlans(port, bindingId) {
    const page = await port(bindingId, { limit: 1, afterPlanId: null });
    if (!page || !Array.isArray(page.plans) || page.plans.length > 1) broken();
    if (!page.plans.length) {
        if (page.nextAfterPlanId !== null) broken();
        return { state: 'none_found', planId: null };
    }
    return { state: 'found', planId: id(page.plans[0].planId) };
}

// Precedence: an existing plan, then results awaiting a plan, then saved work,
// then not started. Saved work alongside newer stages stays as a second action.
// Stages are only claimed from complete evidence; otherwise they are hedged.
function classify(assessment, plan) {
    const actions = [];
    const resume = assessment.draft && { kind: 'resume_assessment', route: ROUTE.assessment, assessmentId: assessment.draft.assessmentId };
    const review = assessment.submitted && { kind: 'review_results', route: ROUTE.assessment, assessmentId: assessment.submitted.assessmentId };
    let stage;
    if (plan.state === 'found') {
        stage = 'plan_ready';
        actions.push({ kind: 'open_plan', route: ROUTE.plan, planId: plan.planId });
        if (review) actions.push(review);
        if (resume) actions.push(resume);
    } else if (assessment.coverage === 'not_checked') {
        stage = 'assessment_not_checked';
        actions.push({ kind: 'open_client', route: ROUTE.assessment });
    } else if (assessment.coverage === 'partial') {
        // Too many assessments to classify safely; the client's own view
        // lists them all.
        stage = 'assessment_partial';
        actions.push({ kind: 'open_client', route: ROUTE.assessment });
    } else if (review) {
        stage = 'results_ready';
        actions.push(review);
        if (resume) actions.push(resume);
    } else if (resume) {
        stage = 'in_progress';
        actions.push(resume);
    } else {
        stage = 'not_started';
        actions.push({ kind: 'start_assessment', route: ROUTE.assessment });
    }
    if (plan.state === 'unavailable' && stage === 'results_ready') stage = 'results_ready_plan_unknown';
    return { stage, actions };
}

// Ports are server-owned, request-bound capabilities, as in the work queue.
// `assessments` may be null when portfolio assessment reads are not admitted;
// the service then reports assessment status as not checked.
function createConsultantClientStatusService(options) {
    let ports;
    try {
        fields(options, ['generation', 'clock', 'listBindings', 'assessments', 'plans', 'finish', 'assertDisclosure']);
        digest(options.generation);
        for (const name of ['clock', 'listBindings', 'plans', 'finish', 'assertDisclosure']) {
            if (typeof options[name] !== 'function' || isProxy(options[name])) invalid();
        }
        if (options.assessments !== null && (typeof options.assessments !== 'function' || isProxy(options.assessments))) invalid();
        ports = Object.freeze({ ...options });
    } catch { invalid(); }
    return Object.freeze({ async read(input) {
        const page = normaliseConsultantClientStatusPage(input), asOf = instant(ports.clock());
        const directory = await ports.listBindings({ afterBindingId: page.afterBindingId, limit: page.limit });
        if (!directory || !Array.isArray(directory.bindings) || directory.bindings.length > page.limit) broken();
        const clients = [], seen = new Set();
        let unavailableClients = 0, bytes = 0;
        for (const binding of directory.bindings) {
            if (seen.has(uuid(binding.bindingId))) broken();
            seen.add(binding.bindingId);
            if (typeof binding.organisationLabel !== 'string' || !binding.organisationLabel) broken();
            let assessment, plan;
            try {
                assessment = await readAssessments(ports.assessments, binding.bindingId);
                try { plan = await readPlans(ports.plans, binding.bindingId); }
                catch (error) {
                    // Only an assessment read that already passed this
                    // client's resource authority lets a row survive a failed
                    // plan read. Without one (plans-only mode) nothing about
                    // the client, label included, is disclosed.
                    if (error instanceof ConsultantClientStatusError || !knownUnavailable(error) ||
                        ports.assessments === null ||
                        Object.getOwnPropertyDescriptor(error, 'statusCode').value === 403) throw error;
                    plan = { state: 'unavailable', planId: null };
                }
            } catch (error) {
                if (error instanceof ConsultantClientStatusError) throw error;
                // Unknown failures withhold the page without passing detail on.
                if (!knownUnavailable(error)) throw new ConsultantClientStatusError();
                // A denied or unavailable client contributes neither its label
                // nor any partial status.
                unavailableClients++; continue;
            }
            const { stage, actions } = classify(assessment, plan);
            const row = { bindingId: binding.bindingId, organisationLabel: binding.organisationLabel, stage, actions,
                assessment: { coverage: assessment.coverage, draftCount: assessment.draftCount, submittedCount: assessment.submittedCount,
                    latestDraft: assessment.draft, latestSubmitted: assessment.submitted && { assessmentId: assessment.submitted.assessmentId,
                        revision: assessment.submitted.revision, updatedAt: assessment.submitted.updatedAt } },
                plan: { state: plan.state } };
            const size = Buffer.byteLength(JSON.stringify(row));
            if (bytes + size > MAX_OUTPUT_BYTES) broken();
            clients.push(row); bytes += size;
        }
        const next = directory.nextAfterBindingId === null ? null : uuid(directory.nextAfterBindingId);
        const result = freeze({ schemaVersion: 1, asOf, clients,
            coverage: { basis: 'current_page', checkedClients: clients.length, unavailableClients,
                assessmentStatus: ports.assessments === null ? 'not_checked' : 'checked', complete: next === null },
            nextAfterBindingId: next });
        // No payload escapes until the whole portfolio read survives a final
        // authority check, exactly as the work queue requires.
        await ports.finish();
        ports.assertDisclosure();
        return result;
    } });
}

module.exports = Object.freeze({ ConsultantClientStatusError, normaliseConsultantClientStatusPage,
    createConsultantClientStatusService, CLIENT_STATUS_ROUTES: ROUTE });
