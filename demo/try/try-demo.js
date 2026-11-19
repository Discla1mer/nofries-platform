(function (root, factory) {
    'use strict';
    // The demo engine is the real questionnaire metadata and ENG-003 scoring.
    // Node loads it directly; the page bundles the same files (document.js).
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(function () {
            const crypto = require('node:crypto');
            return { evaluator: require('../../api/shared/assessmentEngine/ncscAssessmentEvaluator'),
                core: require('../../api/shared/assessmentEngine/assessmentEvaluator'),
                metadata: require('../../api/shared/ncscQuestionnaireMetadata').createNcscQuestionnaireMetadata(),
                sha256: function (text) { return crypto.createHash('sha256').update(text, 'utf8').digest('hex'); } };
        });
    } else root.NoFriesTryDemo = factory(function () { return root.NoFriesTryEngine(); });
}(typeof globalThis !== 'undefined' ? globalThis : this, function (loadEngine) {
    'use strict';

    // Fictional demonstration only (#29). No real organisation, person or record.
    // Answers live in memory and in one browser-storage key; nothing is sent anywhere.
    const STORAGE_KEY = 'nofries.tryDemo.v2';
    // Earlier releases kept answers under this key. Nothing reads it now; reset and start remove it.
    const LEGACY_STORAGE_KEY = 'nofries.tryDemo.v1';
    const BUSINESS = 'Brightwater Joinery (fictional)';
    const ORGANISATION_ID = 'fictional-demo';
    const PREFIX = '/api/dashboard/ncsc/assessments';
    const EARLIER_ID = 'brightwater-july-2026';
    const EARLIER_AT = '2026-07-14T21:00:00.000Z';
    const EARLIER_SCOPE = 'Brightwater Joinery (fictional): 9 staff, the workshop and office laptops, Microsoft 365 email and files, and the online accounting and job-booking services.';
    // The fictional business's earlier answers, keyed by the real question-ID stem.
    const EARLIER_ANSWERS = Object.freeze({ RM: 'no', SA: 'partial', AI: 'no', SC: 'unknown', PA: 'partial', MF: 'partial', DU: 'no',
        LP: 'partial', DR: 'yes', RP: 'no', PM: 'no', SV: 'yes', AC: 'unknown', NS: 'no' });
    const MAX_LOG = 400;
    let engine = null;
    function getEngine() { if (!engine) engine = loadEngine(); return engine; }
    const clone = function (value) { return JSON.parse(JSON.stringify(value)); };
    const byId = function (a, b) { return a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0; };

    function projection(now) {
        return {
            schemaVersion: 1, context: { organisationId: ORGANISATION_ID, displayName: BUSINESS }, currentUser: { jobTitle: null },
            audience: 'IT manager', subscription: 'Score', admissionGranted: false, providerAccessGranted: false, generatedAt: now,
            modules: ['overview', 'ai_governance', 'cyber_security', 'it_optimisation', 'improvement_plan', 'evidence', 'board_reports', 'services']
                .map(function (key) { return { key: key, state: ['overview', 'cyber_security', 'services'].includes(key) ? 'ready' : 'planned' }; }),
            services: ['managed_endpoint', 'work_file_backup', 'microsoft_365_admin', 'fractional_advisory']
                .map(function (key) { return { key: key, state: 'not_included', operational: false }; }),
            summary: { state: 'empty', attention: [], metrics: [] }
        };
    }

    // In-memory stand-in for the assessment API. It answers the same routes and
    // shapes as the server, and a submission is scored by the real evaluator.
    function createServer(clock) {
        const parts = getEngine(), metadata = parts.metadata, sha256 = parts.sha256;
        const records = new Map(), receipts = new Map();
        let sequence = 0;
        function digest(label, value) { sequence += 1; return sha256('nofries:try-demo:' + label + ':' + sequence + '\n' + JSON.stringify(value)); }
        function progress(responses) {
            return { total: metadata.questions.length, answered: responses.length, missing: metadata.questions.length - responses.length,
                unknown: responses.filter(function (row) { return row.optionId === 'unknown'; }).length,
                notApplicableClaims: responses.filter(function (row) { return row.optionId === 'not_applicable'; }).length };
        }
        function summary(detail) {
            const characters = Array.from(detail.scopePopulation.description);
            const value = {};
            ['assessmentId', 'moduleId', 'profileRef', 'status', 'revision', 'revisionSha256', 'createdAt', 'updatedAt', 'progress']
                .forEach(function (key) { value[key] = clone(detail[key]); });
            value.scopePopulation = { description: characters.slice(0, 160).join('') + (characters.length > 160 ? '…' : '') };
            return value;
        }
        // Mirrors constructSubmission in ncscAssessmentSubmission.js: no evidence,
        // no stated impact, and any not applicable answer stays a pending claim.
        function evaluate(record, at) {
            const ids = metadata.questions.map(function (question) { return question.id; }).sort();
            const evidence = ids.map(function (itemId) { return { itemId: itemId, evidenceState: 'not_provided' }; });
            const risk = ids.map(function (itemId) { return { itemId: itemId, statedImpact: 'unspecified', priorityOverlay: 'none' }; });
            const answers = new Map(record.responses.map(function (row) { return [row.itemId, row]; }));
            const input = { schemaVersion: 1, scoreContractVersion: parts.core.SCORE_CONTRACT_VERSION, organisationId: ORGANISATION_ID,
                moduleId: metadata.moduleId, assessmentId: record.assessmentId, assessmentRevision: 'rev-' + record.revision,
                profileRef: clone(metadata.profileRef), scoreAsOf: at, scopePopulationSha256: sha256(record.scopePopulation.description),
                evidenceSnapshot: { id: 'evidence-' + sha256('evidence:' + record.assessmentId), sha256: parts.core.calculateEvidenceSnapshotSha256(evidence) },
                riskContextSnapshot: { id: 'risk-' + sha256('risk:' + record.assessmentId), sha256: parts.core.calculateRiskContextSnapshotSha256(risk) },
                atomInputs: metadata.questions.map(function (question) {
                    const answer = answers.get(question.id);
                    const atom = { itemId: question.id, response: { optionId: answer.optionId }, evidenceState: 'not_provided',
                        statedImpact: 'unspecified', priorityOverlay: 'none' };
                    if (answer.rationale) atom.applicabilityClaim = { rationaleSha256: sha256(answer.rationale.text) };
                    return atom;
                }) };
            return JSON.parse(parts.core.serialiseAssessmentEvaluation(parts.evaluator.evaluateAcceptedNcscAssessment(input)));
        }
        function problem(status, code) { return { status: status, body: { code: code } }; }
        function execute(command, at) {
            const key = JSON.stringify([command.assessmentId, command.idempotencyKey]), intent = JSON.stringify(command);
            const original = receipts.get(key);
            if (original) return original.intent === intent ? clone(original.response) : problem(409, 'ncsc_idempotency_conflict');
            const current = records.get(command.assessmentId);
            if (command.action === 'create' && current) return problem(409, 'ncsc_state_conflict');
            if (command.action !== 'create' && !current) return problem(404, 'ncsc_not_found');
            if (current && current.revision !== command.expectedRevision) return problem(409, 'ncsc_revision_conflict');
            if (current && (current.status === 'submitted' || current.revision >= 128 || (command.action === 'save' && current.revision >= 127))) {
                return problem(409, 'ncsc_state_conflict');
            }
            let next;
            if (command.action === 'create') {
                next = { assessmentId: command.assessmentId, moduleId: metadata.moduleId, profileRef: clone(metadata.profileRef),
                    status: 'created', revision: 0, revisionSha256: null, createdAt: at, updatedAt: at, progress: progress([]),
                    scopePopulation: clone(command.payload.scopePopulation), responses: [], submission: null };
            } else {
                next = clone(current); next.revision += 1; next.updatedAt = at;
                if (command.action === 'save') {
                    const answers = new Map(next.responses.map(function (row) { return [row.itemId, row]; }));
                    command.payload.responses.forEach(function (row) { if (row.optionId === null) answers.delete(row.itemId); else answers.set(row.itemId, clone(row)); });
                    next.responses = Array.from(answers.values()).sort(byId);
                    next.progress = progress(next.responses); next.status = 'in-progress';
                } else {
                    if (current.status !== 'in-progress' || current.progress.missing) return problem(409, 'ncsc_state_conflict');
                    next.status = 'submitted';
                    next.submission = { revision: next.revision, submittedAt: at, responseSetSha256: sha256(JSON.stringify(next.responses)),
                        evaluation: evaluate(next, at) };
                }
            }
            next.revisionSha256 = digest('revision', next);
            records.set(next.assessmentId, next);
            const response = { status: command.action === 'create' ? 201 : 200, body: { schemaVersion: 1, action: command.action, assessment: clone(next) } };
            receipts.set(key, { intent: intent, response: clone(response) });
            return response;
        }
        function route(url, options) {
            const target = new URL(url, 'https://try-demo.invalid');
            const match = /^\/api\/dashboard\/ncsc\/assessments(?:\/([A-Za-z0-9][A-Za-z0-9._:-]{0,119})(?:\/(save|submit))?)?$/.exec(target.pathname);
            if (target.origin !== 'https://try-demo.invalid' || !match) return { response: problem(404, 'ncsc_not_found') };
            const method = options.method || 'GET';
            if (method === 'GET') {
                if (match[2]) return { response: problem(405, 'ncsc_method_not_allowed') };
                if (match[1]) {
                    return { response: records.has(match[1]) ? { status: 200, body: { schemaVersion: 1, assessment: clone(records.get(match[1])) } }
                        : problem(404, 'ncsc_not_found') };
                }
                const limit = Number(target.searchParams.get('limit') || 50), after = target.searchParams.get('afterAssessmentId');
                const available = Array.from(records.values()).sort(function (a, b) { return a.assessmentId < b.assessmentId ? -1 : 1; })
                    .filter(function (item) { return after === null || item.assessmentId > after; });
                const page = available.slice(0, limit);
                return { response: { status: 200, body: { schemaVersion: 1, assessments: page.map(summary),
                    nextAfterAssessmentId: available.length > page.length ? page[page.length - 1].assessmentId : null } } };
            }
            if (method !== 'POST' || (match[1] && !match[2])) return { response: problem(405, 'ncsc_method_not_allowed') };
            let body;
            try { body = JSON.parse(options.body); } catch (_) { body = null; }
            if (!body || typeof body !== 'object' || Array.isArray(body)) return { response: problem(400, 'ncsc_input_invalid') };
            const command = { assessmentId: match[1] || body.assessmentId, action: match[2] || 'create',
                idempotencyKey: body.idempotencyKey, expectedRevision: body.expectedRevision, payload: body.payload };
            const at = clock();
            return { command: command, at: at, response: execute(command, at) };
        }
        function seed() {
            const responses = metadata.questions.map(function (question) {
                return { itemId: question.id, optionId: EARLIER_ANSWERS[question.id.split('-')[3]], rationale: null };
            });
            [{ action: 'create', expectedRevision: null, payload: { scopePopulation: { description: EARLIER_SCOPE } } },
                { action: 'save', expectedRevision: 0, payload: { responses: responses } },
                { action: 'submit', expectedRevision: 1, payload: {} }].forEach(function (step) {
                const result = execute(Object.assign({ assessmentId: EARLIER_ID, idempotencyKey: 'seed-' + step.action }, step), EARLIER_AT);
                if (result.status >= 300) throw new Error('try_demo_seed_failed');
            });
        }
        seed();
        return { metadata: metadata, route: route, execute: execute };
    }

    // Browser storage is optional. A blocked or throwing store falls back to memory.
    function createStore(storage) {
        let memory = null;
        function read() {
            if (memory) return clone(memory);
            try {
                const value = JSON.parse(storage.getItem(STORAGE_KEY) || 'null');
                return value && Array.isArray(value.log) && value.log.length <= MAX_LOG ? value.log : [];
            } catch (_) { return []; }
        }
        return {
            read: read,
            append: function (entry) {
                const log = read().concat([entry]).slice(-MAX_LOG);
                memory = null;
                try { storage.setItem(STORAGE_KEY, JSON.stringify({ log: log })); } catch (_) { memory = log; }
            },
            clear: function () {
                memory = null;
                [STORAGE_KEY, LEGACY_STORAGE_KEY].forEach(function (key) { try { storage.removeItem(key); } catch (_) { /* nothing stored */ } });
            },
            clearLegacy: function () { try { storage.removeItem(LEGACY_STORAGE_KEY); } catch (_) { /* nothing stored */ } }
        };
    }

    function createBackend(store, now) {
        let last = 0;
        const clock = function () { last = Math.max(last + 1, Date.parse(now())); return new Date(last).toISOString(); };
        let server = createServer(clock);
        // Replay the visitor's saved steps through the same engine. Anything that
        // no longer replays (an older format, a changed catalogue) starts afresh.
        const log = store.read();
        try {
            log.forEach(function (entry) {
                last = Math.max(last, Date.parse(entry.at));
                if (server.execute(entry.command, entry.at).status >= 300) throw new Error('replay');
            });
        } catch (_) { store.clear(); last = 0; server = createServer(clock); }
        function respond(response) {
            const text = JSON.stringify(response.body);
            return { status: response.status, ok: response.status >= 200 && response.status < 300, redirected: false, type: 'basic',
                headers: { get: function (name) { return String(name).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null; } },
                text: function () { return Promise.resolve(text); } };
        }
        return {
            metadata: server.metadata,
            fetch: function (url, options) {
                options = options || {};
                if (options.signal && options.signal.aborted) return Promise.reject(new Error('aborted'));
                const result = server.route(url, options);
                if (result.command && result.response.status < 300) store.append({ command: result.command, at: result.at });
                return Promise.resolve(respond(result.response));
            }
        };
    }

    // Overview asks the public enquiry status before showing "Get help closing
    // these gaps" (a link to /contact.html). Answer that here; refuse anything else.
    // Any other URL is logged as a console error before it is refused, so the
    // browser check's console guard fails on a request the demo did not expect.
    function pageFetch(url) {
        if (url === '/api/enquiry') {
            // Demo stub, not live status: the demo always reports enquiries as
            // available and never asks the real /api/enquiry endpoint.
            return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ available: true }); } });
        }
        if (typeof console !== 'undefined' && console.error) console.error('Try demo refused an unexpected request: ' + String(url));
        return Promise.reject(new TypeError('The demo makes no network requests.'));
    }

    function mountOptions(win, backend) {
        const dashboard = win.NoFriesNcscAssessmentClient, questionnaire = win.NoFriesNcscQuestionnaire, picture = win.NoFriesOrganisationPicture;
        const client = dashboard.createClient({ metadata: backend.metadata, fetch: backend.fetch });
        let pictureSelection = null;
        return {
            window: win,
            demoGuide: true,
            mountCyber: function (root, presentation) {
                return questionnaire.mount(root, { window: win, metadata: backend.metadata, client: client, presentationMode: 'editable',
                    organisationId: ORGANISATION_ID, initialAssessmentId: presentation && presentation.initialAssessmentId,
                    initialQuestionIndex: presentation && presentation.initialQuestionIndex, onLocation: presentation && presentation.onLocation,
                    startNew: !!(presentation && presentation.startNew === true) });
            },
            mountPicture: function (root, presentation) {
                return picture.mount(root, { metadata: backend.metadata, client: client, organisationId: ORGANISATION_ID,
                    displayName: presentation.displayName, initialAssessmentId: pictureSelection || undefined,
                    onSelection: function (assessmentId, source) { if (source === 'user') pictureSelection = assessmentId; },
                    openCyber: presentation.openCyber });
            }
        };
    }

    function start(win) {
        const doc = win.document;
        const root = doc.getElementById('try-demo-dashboard');
        const status = doc.getElementById('try-demo-status');
        let storage = null; try { storage = win.localStorage; } catch (_) { storage = null; }
        const store = createStore(storage);
        store.clearLegacy();
        const now = function () { return new Date().toISOString(); };
        win.fetch = pageFetch;
        function mountDashboard(route) {
            const options = mountOptions(win, createBackend(store, now));
            options.initialRoute = route;
            win.NoFriesDashboard.mount(root, projection(now()), options);
        }
        doc.getElementById('try-demo-reset').addEventListener('click', function () {
            store.clear();
            win.history.replaceState(null, '', win.location.pathname);
            mountDashboard('');
            status.textContent = (/^Demo reset\./.test(status.textContent) ? 'Demo reset again.' : 'Demo reset.') + ' Your demo answers were cleared.';
        });
        mountDashboard(null);
    }

    return Object.freeze({ STORAGE_KEY: STORAGE_KEY, LEGACY_STORAGE_KEY: LEGACY_STORAGE_KEY, BUSINESS: BUSINESS, ORGANISATION_ID: ORGANISATION_ID,
        EARLIER_ID: EARLIER_ID,
        projection: projection, createServer: createServer, createStore: createStore, createBackend: createBackend,
        pageFetch: pageFetch, mountOptions: mountOptions, start: start });
}));
