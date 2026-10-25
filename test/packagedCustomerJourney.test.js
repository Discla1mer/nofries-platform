'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const request = require('supertest');

const root = path.resolve(__dirname, '..');
let buildRoot, directory, packageRoot;

beforeAll(() => {
    // Match dashboardPackaging's isolated real-build fixture: never rebuild
    // the shared root output while appServicePackage may inspect it in parallel.
    buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-customer-build-'));
    const { PUBLIC_ROOT_FILES } = require('../lib/publicAssets');
    for (const file of ['package.json', 'package-lock.json', 'app-service.js', 'server.js',
        'scripts/build-app-service.js', ...PUBLIC_ROOT_FILES]) {
        fs.mkdirSync(path.dirname(path.join(buildRoot, file)), { recursive: true });
        fs.copyFileSync(path.join(root, file), path.join(buildRoot, file));
    }
    for (const name of ['api', 'app', 'assets', 'images', 'js', 'lib']) {
        fs.cpSync(path.join(root, name), path.join(buildRoot, name), { recursive: true,
            filter: source => !path.relative(root, source).split(path.sep).includes('node_modules') });
    }
    execFileSync(process.execPath, ['scripts/build-app-service.js'], { cwd: buildRoot, stdio: 'pipe' });
});

afterAll(() => {
    if (buildRoot) fs.rmSync(buildRoot, { recursive: true, force: true });
});

beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-packaged-customer-'));
    packageRoot = path.join(directory, 'app');
    fs.cpSync(path.join(buildRoot, 'app-service-dist'), packageRoot, { recursive: true });
    // Same installed dependency graph as the existing packaging test. This is
    // package composition coverage, not an installed-production-closure claim.
    fs.symlinkSync(fs.realpathSync(path.join(root, 'node_modules')), path.join(directory, 'node_modules'), 'dir');
});

afterEach(() => {
    jest.dontMock('../lib/productionApplication');
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

function packagedHarness() {
    let h;
    jest.isolateModules(() => {
        // Redirect only the unchanged fixture's factory import. All application
        // handlers and their relative imports execute from the actual package.
        jest.doMock('../lib/productionApplication', () =>
            jest.requireActual(path.join(packageRoot, 'lib/productionApplication.js')));
        const { customerProductionHarness, uid } = require('./helpers/customerProductionHarness');
        h = customerProductionHarness({ starter: true, external: true, now: Date.now(), customerClientId: uid(105) });
    });
    return h;
}

test('built customer composition retains signed-in setup across fresh login and separates another subject', async () => {
    const h = packagedHarness();
    const first = await h.loginExternal();
    expect(first.response.status).toBe(303);
    const state = await request(h.app).get('/api/external-customer-signup/state').set('Cookie', first.cookie);
    expect(state.status).toBe(200);
    expect(state.body.state).toEqual({ status: 'setup_details', email: h.state.externalEmail });
    const setup = await h.sameOrigin(request(h.app).post('/api/external-customer-signup/setup'))
        .set('Cookie', first.cookie).set('X-CSRF-Token', state.body.csrfToken)
        .send({ accountType: 'company', organisationName: 'Synthetic packaged company',
            details: { name: 'Synthetic Representative', role: 'Owner', address: 'Synthetic address',
                registrationId: '', authorityConfirmed: true } });
    expect(setup.status).toBe(200);
    expect(setup.body.state).toEqual({ status: 'continue_authentication' });
    const records = h.getContainer('external-starter-authority').records;
    const retained = [...records].map(([key, bytes]) => [key, bytes.toString()]);
    const subjects = retained.filter(([key]) => key.startsWith('customer-subjects/'));
    expect(subjects).toHaveLength(1);
    expect(JSON.parse(subjects[0][1]).subjectKey).toBe(
        `${h.dependencies.externalCustomer.identityProvider.tenantId}:${h.state.externalOid}`);

    const returning = await h.loginExternal();
    expect(returning.response.status).toBe(303);
    expect(returning.cookie).not.toBe(first.cookie);
    expect([...records].map(([key, bytes]) => [key, bytes.toString()])).toEqual(retained);
    // Preparation, terms/admission and saved assessments need the separate
    // native PostgreSQL suite, not this bounded SDK/storage fixture.

    h.state.externalOid = '60000000-0000-4000-8000-000000000104';
    h.state.externalEmail = 'another@synthetic.example';
    const second = await h.loginExternal();
    expect(second.response.status).toBe(303);
    const separate = await request(h.app).get('/api/external-customer-signup/state').set('Cookie', second.cookie);
    expect(separate.status).toBe(200);
    expect(separate.body.state).toEqual({ status: 'setup_details', email: h.state.externalEmail });
    // The second subject can reserve its own setup, but cannot overwrite or
    // inherit any of the first subject's retained account/setup records.
    for (const [key, bytes] of retained) expect(records.get(key)?.toString()).toBe(bytes);
    // Setup/login cannot become an admitted dashboard merely through packaging.
    expect((await request(h.app).get('/api/dashboard/session').set('Cookie', second.cookie)).status).toBe(403);
    expect(h.pool.registrations.size).toBe(0);
    expect(h.pool.receipts.size).toBe(0);
    expect(h.state.delivered).toEqual([]);
}, 20000);

test('the fixture cannot fall back to source when packaged customer composition is omitted', () => {
    fs.unlinkSync(path.join(packageRoot, 'lib/customerSignupProduction.js'));
    expect(packagedHarness).toThrow(/Cannot find module '\.\/customerSignupProduction'/);
});
