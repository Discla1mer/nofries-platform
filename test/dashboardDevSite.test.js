'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { buildDevSite } = require('../scripts/build-dashboard-dev-site');
const { renderPreview } = require('../scripts/build-dashboard-preview');
const { buildJourney, createSyntheticTransport } = require('../scripts/dashboard-preview-journey');
const { createClient } = require('../api/shared/protectedAssets/ncscAssessmentClient');
const { resultModel } = require('../api/shared/protectedAssets/ncscQuestionnaire');
const { createCommand, saveCommand, submitCommand, allResponses } = require('./fixtures/ncscAssessmentFixture');
const root = path.resolve(__dirname, '..');
let directory;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-dev-test-')); });
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

test('packages only the existing synthetic UI and binds every served byte to a commit manifest', () => {
    const built = buildDevSite(path.join(directory, 'site'));
    const read = name => fs.readFileSync(path.join(built.output, name), 'utf8');
    expect(fs.readdirSync(built.output).sort()).toEqual(['index.html', 'preview-manifest.json', 'staticwebapp.config.json']);
    expect(built.commit).toMatch(/^[a-f0-9]{40}$/);
    const html = read('index.html');
    for (const file of ['dashboardShell', 'dashboardRegistry', 'ncscAssessmentClient', 'ncscQuestionnaire',
        'assessmentExplanation', 'organisationPicture', 'improvementActionPlanView'].map(name => 'api/shared/protectedAssets/' + name + '.js').concat('app/dashboard.css')) {
        expect(html).toContain(fs.readFileSync(path.join(root, file), 'utf8'));
    }
    expect(html).toContain('DEV / synthetic data');
    expect(html).toContain(built.commit + (built.dirty ? '-dirty' : ''));
    // API-shaped selectors are handled only by the injected memory transport.
    // Official reference URLs are text/disabled links, never production origins.
    expect(html).not.toMatch(/nofries\.nz|azurestaticapps\.net|\.auth\/|localStorage|sessionStorage|indexedDB|document\.cookie|window\.fetch|globalThis\.fetch/);
    expect(html).toContain('unrelated to entered answers');
    expect(html).toContain('Reload, Reset or changing scenario discards all practice work');
    for (const [file, digest] of Object.entries(built.files)) {
        expect(createHash('sha256').update(read(file)).digest('hex')).toBe(digest);
    }
    expect(buildDevSite(path.join(directory, 'repeat')).files).toEqual(built.files);
});

test('seeded results and read-only plan share a genuine build-time evaluation, without changing production module readiness', () => {
    const seed = buildJourney();
    expect(resultModel(seed.example, seed.metadata, seed.model.context.organisationId)).not.toBeNull();
    expect(seed.plan.source.evaluationOutputSha256).toBe(seed.example.submission.evaluation.outputSha256);
    expect(seed.plan.source.assessmentId).toBe(seed.example.assessmentId);
    expect(seed.plan.actions.length).toBeGreaterThan(0);
    const models = require('./fixtures/dashboardFixture').scenarios();
    expect(Object.values(models).flatMap(model => model.modules)
        .filter(module => ['cyber_security', 'improvement_plan'].includes(module.key))
        .every(module => module.state !== 'ready')).toBe(true);
});

test('practice transport saves and reopens only in memory; interactive submission never borrows the seeded score', async () => {
    const seed = buildJourney(), frozen = JSON.stringify(seed.example);
    const memory = () => createSyntheticTransport({ assessments: [] }, seed.metadata, seed);
    const transport = memory(), client = createClient({ metadata: seed.metadata, fetch: transport.fetch });
    const nativeFetch = jest.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Network forbidden'); });
    try {
        await client.create(createCommand());
        await client.save(saveCommand('assessment-a', 0, 'save-a', allResponses('no')));
        const reopened = await createClient({ metadata: seed.metadata, fetch: transport.fetch }).read('assessment-a');
        expect(reopened.assessment.responses.every(row => row.optionId === 'no')).toBe(true);
        const submitted = await client.submit(submitCommand());
        expect(resultModel(submitted.assessment, seed.metadata, seed.model.context.organisationId)).toBeNull();
        expect(JSON.stringify(seed.example)).toBe(frozen);
        await expect(createClient({ metadata: seed.metadata, fetch: memory().fetch }).read('assessment-a')).rejects.toThrow();
        for (const url of ['https://nofries.nz/api/dashboard/ncsc/assessments', '//nofries.nz/api/dashboard', '/api/dashboard/session', '/api/customer-signup/bootstrap']) {
            expect((await transport.fetch(url)).status).toBe(404);
        }
        expect(nativeFetch).not.toHaveBeenCalled();
    } finally { nativeFetch.mockRestore(); }
});

test('restricts all content and metadata to an invited role, with no API or fallback bypass', () => {
    const built = buildDevSite(path.join(directory, 'site'));
    const config = JSON.parse(fs.readFileSync(path.join(built.output, 'staticwebapp.config.json')));
    expect(config.routes).toEqual([
        { route: '/.auth/login/aad', statusCode: 404 },
        { route: '/.auth/login/aad/*', statusCode: 404 },
        { route: '/.auth/*', allowedRoles: ['anonymous'] },
        { route: '/api/*', statusCode: 404 },
        { route: '/*', allowedRoles: ['preview_reviewer'] }
    ]);
    expect(config).not.toHaveProperty('navigationFallback');
    expect(config).not.toHaveProperty('auth');
    const { html, contentSecurityPolicy } = renderPreview();
    for (const directive of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'"]) {
        expect(contentSecurityPolicy).toContain(directive);
    }
    for (const tag of ['script', 'style']) {
        const body = html.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'))[1];
        expect(contentSecurityPolicy).toContain("'sha256-" + createHash('sha256').update(body).digest('base64') + "'");
    }
    expect(config.globalHeaders['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(config.globalHeaders['Cache-Control']).toBe('private, no-store');
});

test('refuses to overwrite files, use production directories or traverse a symlink into the repository', () => {
    expect(() => buildDevSite('dist')).toThrow();
    expect(() => buildDevSite(root)).toThrow();
    expect(() => buildDevSite(path.join(root, 'dist'))).toThrow();
    fs.symlinkSync(root, path.join(directory, 'alias'), 'dir');
    expect(() => buildDevSite(path.join(directory, 'alias', 'dev-site'))).toThrow();
    fs.writeFileSync(path.join(directory, 'occupied'), 'keep');
    expect(() => buildDevSite(path.join(directory, 'occupied'))).toThrow();
    expect(fs.readFileSync(path.join(directory, 'occupied'), 'utf8')).toBe('keep');
    expect(() => renderPreview('<script>')).toThrow();
});
