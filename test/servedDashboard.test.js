'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { createNoFriesApp } = require('../server');
const { fixture, NOW } = require('./fixtures/dashboardFixture');
const { projectDashboard } = require('../api/shared/appLifecycle/dashboardProjection');
const { createNcscQuestionnaireMetadata } = require('../api/shared/ncscQuestionnaireMetadata');
const { servedDashboard } = require('./helpers/servedDashboard');

// Only API state is synthetic. Serve the production entry document and actual
// protected assets so browser-client validation runs in the loader's VM realm.
function application(list = (_req, res) => res.json({ schemaVersion: 1, assessments: [], nextAfterAssessmentId: null }), consultant = false) {
    const app = express(), bindingId = '10000000-0000-4000-8000-000000000001';
    const generation = 'a'.repeat(64), model = JSON.parse(JSON.stringify(projectDashboard(fixture({ now: NOW }))));
    model.modules.find(item => item.key === 'cyber_security').state = 'ready';
    const session = { schemaVersion: 1, authenticated: true, purpose: 'customer',
        expiresAt: new Date(Date.parse(NOW) + 3600000).toISOString(), generation, selectedBindingId: bindingId,
        ...(consultant ? { accountType: 'consultant' } : {}) };
    let initialized = false;
    app.get('/api/dashboard/session', (_req, res) => initialized ? res.json(session)
        : res.status(409).json({ code: 'dashboard_initialization_required' }));
    app.post('/api/dashboard/session', express.json(), (req, res) => {
        expect(req.body).toEqual({ operationId: expect.any(String) });
        expect(req.headers.origin).toBe('https://nofries.example.test');
        initialized = true; res.json({ schemaVersion: 1, initialized: true });
    });
    app.post('/api/dashboard/selection', express.json(), (req, res) => {
        expect(req.body).toEqual({ bindingId, expectedGeneration: generation, operationId: expect.any(String) });
        expect(req.headers.origin).toBe('https://nofries.example.test');
        res.json({ schemaVersion: 1, generation, selectedBindingId: bindingId });
    });
    app.get('/api/dashboard/organisations', (_req, res) => res.json({ schemaVersion: 1,
        bindings: [{ bindingId, organisationLabel: 'Synthetic workshop' }], nextAfterBindingId: null }));
    app.get('/api/dashboard/bootstrap', (_req, res) => res.json(model));
    app.get('/api/dashboard/modules/cyber_security', (_req, res) => res.json({ schemaVersion: 1,
        context: model.context, generatedAt: model.generatedAt, module: model.modules.find(item => item.key === 'cyber_security'),
        summary: { state: 'empty', attention: [], metrics: [] }, services: [], admissionGranted: false,
        providerAccessGranted: false, metadata: createNcscQuestionnaireMetadata(), presentationMode: 'editable' }));
    app.get('/api/dashboard/ncsc/assessments', list);
    app.get('/api/dashboard/app.js', (_req, res) => res.type('js').send(
        ['dashboardRegistry.js', 'dashboardShell.js', 'ncscAssessmentClient.js', 'ncscQuestionnaire.js', 'assessmentExplanation.js', 'organisationPicture.js', 'improvementActionPlanView.js', 'improvementActionPlanClient.js']
            .map(file => fs.readFileSync(path.join(__dirname, '../api/shared/protectedAssets', file), 'utf8')).join('\n')));
    app.get('/api/dashboard/dashboard.css', (_req, res) => res.type('css').send(
        fs.readFileSync(path.join(__dirname, '../app/dashboard.css'), 'utf8')));
    app.use(createNoFriesApp());
    return app;
}

test.each(['', '#cyber-security'])('delivered dashboard initializes and renders ready Cyber metadata at %s', async hash => {
    const app = application();
    const rendered = await servedDashboard({ app, cookie: '', now: NOW, origin: 'https://nofries.example.test', hash });
    expect(rendered.trace).toEqual(expect.arrayContaining([
        { url: '/api/dashboard/session', method: 'get', status: 409 },
        { url: '/api/dashboard/session', method: 'post', status: 200 },
        { url: '/api/dashboard/app.js', method: 'get', status: 200 },
        { url: '/api/dashboard/modules/cyber_security', method: 'get', status: 200 }
    ]));
    expect({ state: rendered.state, hidden: rendered.hidden }).toEqual({ state: 'ready', hidden: false });
    if (hash) {
        expect(rendered.text).toContain('Start an assessment');
        expect(rendered.text).toContain('No saved assessments yet.');
        expect(rendered.trace).toContainEqual({ url: '/api/dashboard/ncsc/assessments?limit=50', method: 'get', status: 200 });
    }
});

test('a ready shell with an unsettled questionnaire request cannot pass the helper deadline', async () => {
    let listResponse, started;
    const listStarted = new Promise(resolve => { started = resolve; });
    const app = application((_req, res) => { listResponse = res; started(); });
    let clock = Date.now();
    const time = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
        const rendering = servedDashboard({ app, cookie: '', now: NOW,
            origin: 'https://nofries.example.test', hash: '#cyber-security' });
        const result = expect(rendering).rejects.toThrow('served_dashboard_did_not_settle');
        await listStarted;
        // Advance only the helper clock, leaving genuine client timeout behavior
        // unchanged. The HTTP list remains unresolved while the shell is ready.
        clock += 10001;
        await result;
    } finally {
        time.mockRestore();
        if (listResponse && !listResponse.destroyed) listResponse.json({ schemaVersion: 1, assessments: [], nextAfterAssessmentId: null });
    }
});

test('a returning consultant explicitly chooses an organisation through the delivered loader before opening its workspace', async () => {
    const app = application(undefined, true);
    const portfolio = await servedDashboard({ app, cookie: '', now: NOW, origin: 'https://nofries.example.test' });
    expect({ state: portfolio.state, hidden: portfolio.hidden }).toEqual({ state: 'selection', hidden: true });
    expect(portfolio.trace.some(entry => entry.url === '/api/dashboard/selection')).toBe(false);
    const selected = await servedDashboard({ app, cookie: '', now: NOW, origin: 'https://nofries.example.test',
        chooseOrganisationLabel: 'Synthetic workshop' });
    expect(selected.trace).toContainEqual({ url: '/api/dashboard/selection', method: 'post', status: 200 });
    expect({ state: selected.state, hidden: selected.hidden }).toEqual({ state: 'ready', hidden: false });
});
