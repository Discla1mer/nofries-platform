'use strict';

// Test-only artifact construction. This script neither opens nor serves a browser.
// The production builders do not copy scripts or these external output artifacts.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const BUNDLE = ['api/shared/protectedAssets/dashboardRegistry.js',
    'api/shared/protectedAssets/dashboardShell.js',
    'api/shared/protectedAssets/ncscAssessmentClient.js',
    'api/shared/protectedAssets/ncscQuestionnaire.js',
    'api/shared/protectedAssets/organisationPicture.js'];
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const cspHash = value => `'sha256-${crypto.createHash('sha256').update(value).digest('base64')}'`;
const safeJson = value => JSON.stringify(value).replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

function buildFixtures() {
    const { createNcscQuestionnaireMetadata } = require('../api/shared/ncscQuestionnaireMetadata');
    const { fixture } = require('../test/fixtures/dashboardFixture');
    const { ncscFixture, createCommand, saveCommand, submitCommand, allResponses, SUBJECT, NOW } =
        require('../test/fixtures/ncscAssessmentFixture');
    const store = require('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
    const { projectNcscDetail } = require('../api/shared/ncscAssessmentService');
    const { projectDashboard } = require('../api/shared/appLifecycle/dashboardProjection');
    const metadata = createNcscQuestionnaireMetadata();
    const clone = value => JSON.parse(JSON.stringify(value));
    const tenants = ['A', 'B'].map(label => {
        const tenant = ncscFixture({ tenantId: 'synthetic-preview-' + label.toLowerCase(),
            organisationId: 'shared-preview-organisation' });
        function assessment(id, responses, submitted = false) {
            let previous = null;
            const commands = [createCommand(id, 'create-' + id, 'Synthetic population ' + label + ': office and cloud services.')];
            if (responses) commands.push(saveCommand(id, 0, 'save-' + id, responses));
            if (submitted) commands.push(submitCommand(id, 1, 'submit-' + id));
            for (const command of commands) previous = store.makeVersion({ ...tenant.scope,
                actorSubjectKey: SUBJECT, assessmentId: id, action: command.action,
                expectedRevision: command.expectedRevision, payload: command.payload },
            command.idempotencyKey, previous, tenant.state.tenantAggregate, NOW);
            return projectNcscDetail(previous);
        }
        const partial = allResponses().slice(0, 3);
        partial[0] = { ...partial[0], optionId: 'not_applicable', rationale: { text: 'Synthetic pending N/A claim for organisation ' + label + '.' } };
        partial[1] = { ...partial[1], optionId: 'unknown' };
        const model = clone(projectDashboard(fixture({ now: NOW, name: 'Synthetic organisation ' + label,
            organisationId: tenant.scope.organisationId, empty: true })));
        // Explicit preview-only composition. Shared fixture/projection defaults stay planned.
        model.modules.find(item => item.key === 'cyber_security').state = 'ready';
        return { label, model, assessments: [assessment('assessment-a', partial),
            assessment('assessment-b', allResponses('unknown')), assessment('assessment-submitted', allResponses(), true)] };
    });
    return { metadata, tenants, now: NOW,
        // Shape-valid test tokens only. Interactive transport does not verify durable hashes.
        digests: Array.from({ length: 256 }, (_, index) => sha256('synthetic-ncsc-preview-token-' + index)) };
}

// Serialized into the fixture document. Uses no network, browser storage or server.
function createSyntheticTransport(seed, metadata, settings) {
    const clone = value => JSON.parse(JSON.stringify(value));
    const records = new Map(seed.assessments.map(item => [item.assessmentId, clone(item)]));
    const receipts = new Map();
    const scenarios = ['normal', 'delay', 'unavailable', 'lost', 'conflict', 'denied', 'quota'];
    const prefix = '/api/dashboard/ncsc/assessments';
    let scenario = 'normal', sequence = 0;
    const digest = () => settings.digests[++sequence % settings.digests.length];
    const now = () => new Date(Date.parse(settings.now) + (sequence + 1) * 1000).toISOString();
    const problem = (status, code) => ({ status, body: { code } });
    function progress(responses) {
        return { total: metadata.questions.length, answered: responses.length,
            missing: metadata.questions.length - responses.length,
            unknown: responses.filter(row => row.optionId === 'unknown').length,
            notApplicableClaims: responses.filter(row => row.optionId === 'not_applicable').length };
    }
    function summary(detail) {
        return Object.fromEntries(['assessmentId', 'moduleId', 'profileRef', 'status', 'revision',
            'revisionSha256', 'createdAt', 'updatedAt', 'progress'].map(key => [key, clone(detail[key])]));
    }
    function execute(command) {
        const key = JSON.stringify([command.assessmentId, command.idempotencyKey]);
        const intent = JSON.stringify(command), original = receipts.get(key);
        if (original) return original.intent === intent ? clone(original.response) : problem(409, 'ncsc_idempotency_conflict');
        const current = records.get(command.assessmentId);
        if (command.action === 'create' && current) return problem(409, 'ncsc_state_conflict');
        if (command.action !== 'create' && !current) return problem(404, 'ncsc_not_found');
        if (current && current.revision !== command.expectedRevision) return problem(409, 'ncsc_revision_conflict');
        if (current && (current.status === 'submitted' || current.revision >= 128 ||
            (command.action === 'save' && current.revision >= 127))) return problem(409, 'ncsc_state_conflict');
        const at = now();
        let next;
        if (command.action === 'create') {
            next = { assessmentId: command.assessmentId, moduleId: metadata.moduleId,
                profileRef: clone(metadata.profileRef), status: 'created', revision: 0,
                revisionSha256: digest(), createdAt: at, updatedAt: at, progress: progress([]),
                scopePopulation: clone(command.payload.scopePopulation), responses: [], submission: null };
        } else {
            next = clone(current); next.revision++; next.updatedAt = at; next.revisionSha256 = digest();
            if (command.action === 'save') {
                const answers = new Map(next.responses.map(row => [row.itemId, row]));
                command.payload.responses.forEach(row => row.optionId === null
                    ? answers.delete(row.itemId) : answers.set(row.itemId, clone(row)));
                next.responses = [...answers.values()].sort((a, b) => a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0);
                next.progress = progress(next.responses); next.status = 'in-progress';
            } else {
                if (current.status !== 'in-progress' || current.progress.missing) return problem(409, 'ncsc_state_conflict');
                next.status = 'submitted';
                // The client treats evaluation as opaque. This fixture supplies only
                // synthetic provenance and never presents or simulates scoring arithmetic.
                next.submission = { revision: next.revision, submittedAt: at,
                    responseSetSha256: digest(), evaluation: { schemaVersion: 1, outputSha256: digest(),
                        provenance: { moduleId: metadata.moduleId, assessmentId: next.assessmentId,
                            profileRef: clone(metadata.profileRef), assessmentRevision: 'rev-' + next.revision, scoreAsOf: at } } };
            }
        }
        records.set(next.assessmentId, next);
        const response = { status: command.action === 'create' ? 201 : 200,
            body: { schemaVersion: 1, action: command.action, assessment: clone(next) } };
        receipts.set(key, { intent, response: clone(response) }); return response;
    }
    function route(url, options, mode) {
        const target = new URL(url, 'https://synthetic-preview.invalid');
        if (target.origin !== 'https://synthetic-preview.invalid') return problem(404, 'ncsc_not_found');
        const match = /^\/api\/dashboard\/ncsc\/assessments(?:\/([A-Za-z0-9][A-Za-z0-9._:-]{0,119})(?:\/(save|submit))?)?$/.exec(decodeURIComponent(target.pathname));
        if (!match) return problem(404, 'ncsc_not_found');
        const method = options.method || 'GET';
        if (method === 'GET') {
            if (match[2]) return problem(405, 'ncsc_method_not_allowed');
            if (match[1]) return records.has(match[1])
                ? { status: 200, body: { schemaVersion: 1, assessment: clone(records.get(match[1])) } }
                : problem(404, 'ncsc_not_found');
            const limit = Number(target.searchParams.get('limit') || 50), after = target.searchParams.get('afterAssessmentId');
            const available = [...records.values()].sort((a, b) => a.assessmentId < b.assessmentId ? -1 : 1)
                .filter(item => after === null || item.assessmentId > after);
            // A short page with a continuation exercises the actual bounded-page contract.
            const page = available.slice(0, Math.min(limit, 2));
            return { status: 200, body: { schemaVersion: 1, assessments: page.map(summary),
                nextAfterAssessmentId: available.length > page.length ? page[page.length - 1].assessmentId : null } };
        }
        if (method !== 'POST' || (match[1] && !match[2])) return problem(405, 'ncsc_method_not_allowed');
        if (mode === 'denied') return problem(403, 'ncsc_access_denied');
        if (mode === 'unavailable') return problem(503, 'ncsc_unavailable');
        const body = JSON.parse(options.body);
        const command = { assessmentId: match[1] || body.assessmentId, action: match[2] || 'create',
            idempotencyKey: body.idempotencyKey, expectedRevision: body.expectedRevision, payload: body.payload };
        if (mode === 'quota' && command.action === 'submit') return problem(409, 'ncsc_quota_exceeded');
        if (mode === 'conflict' && command.action !== 'create') {
            const current = records.get(command.assessmentId);
            if (current && current.status !== 'submitted' && current.revision < 127) execute({
                assessmentId: command.assessmentId, action: 'save', idempotencyKey: 'synthetic-other-writer-' + sequence,
                expectedRevision: current.revision, payload: { responses: [{ itemId: metadata.questions[0].id,
                    optionId: 'unknown', rationale: null }] } });
            return problem(409, 'ncsc_revision_conflict');
        }
        return execute(command);
    }
    return Object.freeze({
        setScenario(value) { if (!scenarios.includes(value)) throw new Error('Unknown synthetic scenario'); scenario = value; },
        async fetch(url, options = {}) {
            const signal = options.signal;
            const aborted = () => { const error = new Error('Synthetic request aborted'); error.name = 'AbortError'; return error; };
            if (signal?.aborted) throw aborted();
            const mode = (options.method || 'GET') === 'POST' ? scenario : 'normal';
            if ((options.method || 'GET') === 'POST') scenario = 'normal';
            const response = route(url, options, mode);
            if (mode === 'delay') await new Promise(resolve => setTimeout(resolve, 2000));
            if (signal?.aborted) throw aborted();
            if (mode === 'lost' && response.status < 300) throw new Error('Synthetic response lost after in-memory commit');
            const text = JSON.stringify(response.body);
            return { status: response.status, ok: response.status >= 200 && response.status < 300,
                redirected: false, url: prefix, headers: { get: key => key.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null },
                text: async () => text };
        }
    });
}

function fixtureApplication(fixtures, makeTransport) {
    const root = document.getElementById('dashboard');
    const picker = document.getElementById('tenant');
    const scenario = document.getElementById('scenario');
    const mode = document.getElementById('display-mode');
    const message = document.getElementById('fixture-status');
    const transports = fixtures.tenants.map(tenant => makeTransport(tenant, fixtures.metadata, fixtures));
    let controller, generation = 0, identifiers = 0;
    const createId = () => '00000000-0000-4000-8000-' + (++identifiers).toString(16).padStart(12, '0');
    fixtures.tenants.forEach((tenant, index) => {
        const option = document.createElement('option'); option.value = String(index);
        option.textContent = 'Synthetic organisation ' + tenant.label; picker.append(option);
    });
    function mount() {
        if (controller) controller.destroy();
        const index = Number(picker.value), tenant = fixtures.tenants[index];
        const currentGeneration = ++generation;
        const client = NoFriesNcscAssessmentClient.createClient({ metadata: fixtures.metadata, fetch: transports[index].fetch });
        let pictureSelection = null;
        controller = NoFriesDashboard.mount(root, tenant.model, { window, initialRoute: 'overview',
            generation: currentGeneration,
            mountPicture(childRoot, presentation) {
                return NoFriesOrganisationPicture.mount(childRoot, { metadata: fixtures.metadata, client,
                    organisationId: tenant.model.context.organisationId, displayName: tenant.model.context.displayName,
                    initialAssessmentId: pictureSelection, onSelection: id => { pictureSelection = id; },
                    openCyber: presentation.openCyber });
            },
            mountCyber(childRoot, host) {
                return NoFriesNcscQuestionnaire.mount(childRoot, { metadata: fixtures.metadata, client,
                    presentationMode: mode.value, window, generation: host.generation, createId,
                    organisationId: tenant.model.context.organisationId, initialAssessmentId: host.initialAssessmentId });
            } });
        message.textContent = 'Synthetic organisation ' + tenant.label + ' mounted. All data and save outcomes are in-memory fixtures.';
    }
    picker.addEventListener('change', mount);
    mode.addEventListener('change', mount);
    document.getElementById('arm-scenario').addEventListener('click', () => {
        transports[Number(picker.value)].setScenario(scenario.value);
        message.textContent = 'Next mutation scenario armed: ' + scenario.selectedOptions[0].textContent + '.';
    });
    document.getElementById('remount').addEventListener('click', mount);
    mount();
}

function viewportControls() {
    const frame = document.getElementById('questionnaire-frame');
    const status = document.getElementById('viewport-status');
    document.querySelectorAll('input[name="viewport"]').forEach(control => {
        control.addEventListener('change', () => {
            if (!control.checked) return;
            frame.style.width = control.value + 'px';
            status.textContent = 'Questionnaire document width: ' + control.value + ' CSS pixels. The existing mount is preserved.';
        });
    });
}

function htmlDocument(title, style, script, body, frame = false) {
    if (/<\/script/i.test(script) || /<\/style/i.test(style)) throw new Error('Unsafe preview closing tag');
    const csp = `default-src 'none'; script-src ${cspHash(script)}; style-src ${cspHash(style)}; base-uri 'none'; form-action 'none'; connect-src 'none'${frame ? "; frame-src 'self'" : ''}`;
    return `<!doctype html><html lang="en-NZ"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${title}</title><style>${style}</style></head><body>${body}<script>${script}</script></body></html>`;
}

function buildPreview(outputInput) {
    if (typeof outputInput !== 'string' || !outputInput) throw new Error('Usage: node scripts/build-ncsc-questionnaire-preview.js --output /absolute/external/path/questionnaire.html');
    const output = path.resolve(outputInput), relative = path.relative(ROOT, output);
    if (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw new Error('Preview output must be outside the repository and runtime package.');
    const basename = path.basename(output);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/.test(basename)) throw new Error('Use a plain ASCII .html output filename.');
    // Read the complete actual bundle before creating either output artifact.
    const sources = BUNDLE.map(file => ({ file, content: fs.readFileSync(path.join(ROOT, file), 'utf8') }));
    const fixtures = buildFixtures();
    const frameName = basename.slice(0, -5) + '-frame.html';
    const frameOutput = path.join(path.dirname(output), frameName);
    const frameScript = sources.map(source => source.content).join('\n') + '\n' +
        `(${fixtureApplication.toString()})(${safeJson(fixtures)}, ${createSyntheticTransport.toString()});`;
    const toolbarStyle = 'body{margin:0;font:1rem/1.5 system-ui;color:#102a43;background:#f3f8fc}.fixture-banner{padding:1rem;background:#fff2b8;display:flex;flex-wrap:wrap;gap:.75rem;align-items:center}.fixture-banner p{margin:0;flex-basis:100%}.fixture-banner select,.fixture-banner button{font:inherit;min-height:2.875rem;max-width:100%;padding:.4rem}.fixture-banner label{display:grid;gap:.25rem;min-width:0;max-width:100%}.fixture-banner select{min-width:0;width:100%;box-sizing:border-box}.fixture-banner :focus-visible{outline:3px solid #0069bc;outline-offset:3px}';
    const css = fs.readFileSync(path.join(ROOT, 'app/dashboard.css'), 'utf8');
    const frameStyle = css + '\n' + toolbarStyle;
    const frameBody = '<header class="fixture-banner"><strong>Synthetic development preview</strong><p>No customer data, network or persistent saving. Responses, digests and outcomes are test fixtures; this is not API, SQL, authentication, scoring or browser acceptance evidence.</p><label>Tenant replacement<select id="tenant"></select></label><label>Presentation<select id="display-mode"><option value="editable">Editable</option><option value="read-only">Read-only</option></select></label><label>Next mutation<select id="scenario"><option value="normal">Normal response</option><option value="delay">Response delayed 2 seconds</option><option value="unavailable">Unavailable (503, no simulated commit)</option><option value="lost">Response lost after simulated commit</option><option value="conflict">Another writer causes conflict</option><option value="denied">Access denied</option><option value="quota">Submission quota exceeded</option></select></label><button id="arm-scenario" type="button">Arm next mutation</button><button id="remount" type="button">Force remount from simulated saved state</button><p id="fixture-status" role="status" aria-live="polite"></p><p>Tenant, presentation and forced-remount controls replace the host immediately and clear unsent drafts. Both tenants deliberately share organisation and assessment identifiers. Module and assessment navigation uses the questionnaire leave decision.</p></header><div id="dashboard"></div>';
    const frameHtml = htmlDocument('No Fries · Synthetic NCSC questionnaire', frameStyle, frameScript, frameBody);
    const wrapperScript = `(${viewportControls.toString()})();`;
    const wrapperStyle = toolbarStyle + '.preview-viewport{max-width:100%;overflow:auto;padding:1rem 0}.preview-viewport iframe{display:block;width:1280px;height:1000px;border:1px solid #8aa5ba;background:white}.fixture-widths{display:flex;flex-wrap:wrap;gap:1rem;border:0;padding:0;margin:0}.fixture-widths label{display:flex;gap:.4rem;align-items:center;min-height:2.875rem}.fixture-widths legend{font-weight:700}';
    const body = '<header class="fixture-banner"><strong>Synthetic NCSC questionnaire viewport fixture</strong><p>Artifact generated only. No browser observation or physical-mobile test is implied. Width changes preserve the child document and its draft.</p><fieldset class="fixture-widths"><legend>Questionnaire viewport</legend><label><input type="radio" name="viewport" value="1280" checked>Desktop · 1280px</label><label><input type="radio" name="viewport" value="390">Mobile width · 390px</label><label><input type="radio" name="viewport" value="320">Narrow width · 320px</label></fieldset><p id="viewport-status" role="status">Questionnaire document width: 1280 CSS pixels.</p></header><main class="preview-viewport"><iframe id="questionnaire-frame" title="Synthetic NCSC questionnaire viewport" src="' + frameName + '"></iframe></main>';
    const html = htmlDocument('No Fries · Questionnaire viewport fixture', wrapperStyle, wrapperScript, body, true);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(frameOutput, frameHtml);
    fs.writeFileSync(output, html);
    return { output, sha256: sha256(html), frameOutput, frameSha256: sha256(frameHtml),
        sources: sources.map(source => ({ path: source.file, sha256: sha256(source.content) })).concat([
            { path: 'app/dashboard.css', sha256: sha256(css) },
            { path: 'api/shared/ncscQuestionnaireMetadata.js',
                sha256: sha256(fs.readFileSync(path.join(ROOT, 'api/shared/ncscQuestionnaireMetadata.js'))) }
        ]), metadataSha256: sha256(safeJson(fixtures.metadata)),
        browserObserved: false };
}

if (require.main === module) {
    try {
        if (process.argv.length !== 4 || process.argv[2] !== '--output') throw new Error('Expected --output and an external .html path.');
        console.log(JSON.stringify(buildPreview(process.argv[3]), null, 2));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { buildPreview, buildFixtures, createSyntheticTransport };
