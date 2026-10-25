'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const report = require('../js/customer-report');
const root = path.resolve(__dirname, '..');
const reference = 'NF-0123456789ABCDEF';
const at = '2026-10-13T09:30:00.000Z';

function fixture(options = {}) {
    const names = ['form', 'kind', 'screen', 'description', 'title', 'preview-button', 'preview', 'preview-title',
        'body', 'subject', 'masking', 'reviewed', 'open', 'copy', 'edit', 'status'];
    const nodes = Object.fromEntries(names.map(name => [name, { value: '', checked: false, disabled: false,
        hidden: false, textContent: '', events: {},
        addEventListener(type, fn) { this.events[type] = fn; }, focus: jest.fn(), select: jest.fn() }]));
    nodes.form.reportValidity = jest.fn(() => true);
    const assigned = [], copied = [];
    const browser = { document: { getElementById: id => nodes[id.replace('report-', '')] },
        location: { hash: options.hash || '#kind=error&screen=signup&step=setup&code=signup_unavailable',
            pathname: '/report.html', assign: jest.fn(value => { assigned.push(value); if (options.assignFailure) throw new Error('SENSITIVE_RUNTIME_ERROR'); }) },
        history: { replaceState: jest.fn() }, crypto: { getRandomValues: data => { data.fill(1); return data; } },
        navigator: { clipboard: options.clipboard === null ? null : { writeText: jest.fn(value => {
            copied.push(value); return options.copyFailure ? Promise.reject(new Error('SENSITIVE_CLIPBOARD_ERROR')) : options.copyPromise || Promise.resolve();
        }) } } };
    report.mount(browser);
    const click = name => nodes[name].events.click();
    const preview = (description = 'The setup screen did not finish.') => { nodes.description.value = description; click('preview-button'); };
    const review = () => { nodes.reviewed.checked = true; nodes.reviewed.events.change(); };
    return { nodes, browser, assigned, copied, click, preview, review };
}

test('one safe fragment context is accepted and fixed recipient is not configurable', () => {
    expect(report.readContext('#kind=error&screen=signup&step=setup&code=signup_unavailable&reference=' + reference +
        '&recipient=other@example.test&token=synthetic-private')).toEqual({ kind: 'error', screen: 'signup', step: 'setup',
        code: 'signup_unavailable', reference });
    const result = report.prepare({ kind: 'error', screen: 'signup', description: 'Could not finish.' },
        { recipient: 'other@example.test', code: 'signup_unavailable' }, reference, at);
    expect(result.mailto).toMatch(/^mailto:joel@nofries\.nz\?/);
    expect(result.copy).not.toMatch(/other@|synthetic-private/);
});

test.each(['kind', 'screen', 'step', 'code', 'reference'])('duplicate %s values fail closed', key => {
    const safe = { kind: 'error', screen: 'signup', step: 'setup', code: 'signup_unavailable', reference };
    const result = report.readContext(new URLSearchParams(safe) + '&' + key + '=' + safe[key]);
    expect(result[key]).toBe(key === 'kind' ? 'bug' : key === 'screen' ? 'unspecified' : '');
});

test.each(['#screen=https://private.example.test/path?token=secret', '#kind=<img/src=x>', '#step=subject-123',
    '#code=private_record_failure', '#reference=NF-short', '#reference=NF-0123456789ABCDEF%0Aother'])('rejects unsafe context %s', fragment => {
    expect(report.readContext(fragment)).toEqual({ kind: 'bug', screen: 'unspecified', step: '', code: '', reference: '' });
});

test('link helper retains only the closed context contract in a fragment', () => {
    const value = report.link({ kind: 'feedback', screen: 'portal', step: 'load', code: 'signup_unavailable', reference,
        cookie: 'private-cookie', email: 'private@example.test', returnTo: 'https://attacker.example.test' });
    expect(value).toBe('/report.html#kind=feedback&screen=portal&step=load&code=signup_unavailable&reference=' + reference);
    expect(value).not.toMatch(/cookie|private|attacker|\?/);
});

test.each([
    ['Password: super private secret', 'super private secret'], ['otp=123456', '123456'],
    ['verification code: 98765432', '98765432'], ['Cookie: sid=private; second=private', 'sid=private'],
    ['access_token=private-token', 'private-token'], ['refresh token: private-token', 'private-token'],
    ['Authorization: Bearer synthetic-private-token', 'synthetic-private-token'], ['Bearer synthetic-private-token', 'synthetic-private-token'],
    ['eyJhbGciOiJub25lIn0.eyJzdWIiOiJzZWNyZXQifQ.syntheticSignature', 'eyJhbGci'],
    ['sk-proj-syntheticprivatecredentialvalue', 'sk-proj-'], ['re_syntheticprivatecredentialvalue', 're_'],
    ['https://private.example.test/callback?token=synthetic-secret', 'synthetic-secret'],
    ['mailto:owner@example.test', 'owner@example.test'], ['owner@example.test', 'owner@example.test'],
    ['0123456789abcdef0123456789abcdef', '0123456789abcdef0123456789abcdef']
])('masks recognized private content %s', (input, excluded) => {
    const masked = report.maskText(input);
    expect(masked.masked).toBe(true);
    expect(masked.text).not.toContain(excluded);
});

test('ordinary descriptive text remains useful, bounded and well formed', () => {
    expect(report.maskText('The button did not respond. I expected the next step.')).toEqual({
        text: 'The button did not respond. I expected the next step.', masked: false });
    expect(report.maskText('a'.repeat(600)).text.length).toBeLessThanOrEqual(500);
    const result = report.prepare({ kind: 'bug', screen: 'website', description: 'Broken emoji \ud800' }, {}, reference, at);
    expect(decodeURIComponent(result.mailto)).toContain('Broken emoji �');
    expect(report.maskText('first\u0000\u0007\nsecond').text).toBe('first\nsecond');
});

test('preview, mail draft and copied report contain the same reviewed report', () => {
    const result = report.prepare({ kind: 'feedback', screen: 'dashboard', description: 'Make the next action clearer.' },
        { step: 'load', code: 'dashboard_unavailable', reference }, reference, at);
    const uri = new URL(result.mailto);
    expect(uri.searchParams.get('body')).toBe(result.body);
    expect(uri.searchParams.get('subject')).toBe(result.subject);
    expect(result.copy.endsWith(result.body)).toBe(true);
    expect(result.body).toContain('Prepared (UTC): ' + at);
    expect(result.body).not.toMatch(/browser|tenant|email|cookie|token/i);
});

test('oversized encoded email uses copy instead of silently truncating the report', () => {
    const result = report.prepare({ kind: 'bug', screen: 'website', description: '😀'.repeat(250) }, {}, reference, at);
    expect(result.mailto).toBe('');
    expect(result.body).toContain('😀'.repeat(250));
    expect(result.copy).toContain(result.body);
});

test.each([{ kind: 'feedback', screen: 'signup' }, { kind: 'bug', screen: 'signup' },
    { kind: 'error', screen: 'portal' }])('changing the report type or screen drops stale failed-step context %j', selection => {
    const result = report.prepare({ ...selection, description: 'A clear description.' },
        { screen: 'signup', step: 'setup', code: 'signup_unavailable', reference }, reference, at);
    expect(result.body).not.toMatch(/Failed step:|Error code:|Support reference:/);
    expect(result.body).toContain('Report reference: ' + reference);
});

test('unreviewed drafts cannot be handed off or copied, and blank descriptions cannot be prepared', () => {
    const h = fixture();
    h.click('open'); h.click('copy');
    h.preview(); h.click('open'); h.click('copy');
    expect(h.assigned).toEqual([]); expect(h.copied).toEqual([]);
    h.preview('   ');
    expect(h.nodes.status.textContent).toContain('Add a short description');
});

test('handoff repeats, re-preview and edit/revert cannot open a second identical draft', () => {
    const h = fixture(); h.preview(); h.review();
    h.click('open'); h.click('open');
    expect(h.assigned).toHaveLength(1);
    expect(h.nodes.open.disabled).toBe(true);
    expect(h.nodes.status.textContent).toContain('delivery are not confirmed');
    h.preview(); h.review(); h.click('open');
    h.nodes.description.events.input(); h.preview(); h.review(); h.click('open');
    expect(h.assigned).toHaveLength(1);
});

test('changing a draft invalidates the prior review and leaves report content unsubmitted', () => {
    const h = fixture(); h.preview(); h.review();
    h.nodes.description.value = 'A different description.'; h.nodes.description.events.input();
    expect(h.nodes.reviewed.checked).toBe(false);
    expect(h.nodes.preview.hidden).toBe(true); expect(h.nodes.open.disabled).toBe(true);
    h.click('open'); expect(h.assigned).toEqual([]);
    h.preview('A different description.'); h.review(); h.click('open');
    expect(h.assigned).toHaveLength(1);
});

test('review has one primary action and editing restores the original in-memory draft for fresh review', () => {
    const h = fixture(); h.preview(); h.review();
    expect(h.nodes.form.hidden).toBe(true); expect(h.nodes.preview.hidden).toBe(false);
    h.click('edit');
    expect(h.nodes.form.hidden).toBe(false); expect(h.nodes.preview.hidden).toBe(true);
    expect(h.nodes.description.value).toBe('The setup screen did not finish.');
    expect(h.nodes.description.focus).toHaveBeenCalled(); expect(h.nodes.reviewed.checked).toBe(false);
    expect(h.nodes.open.disabled).toBe(true);
});

test('a failed email handoff is ambiguous and preserves copy fallback without an automatic retry', () => {
    const h = fixture({ assignFailure: true }); h.preview(); h.review(); h.click('open'); h.click('open');
    expect(h.nodes.status.textContent).toContain('could not confirm');
    expect(h.nodes.status.textContent).not.toContain('SENSITIVE_RUNTIME_ERROR');
    expect(h.assigned).toHaveLength(1); expect(h.nodes.open.disabled).toBe(true);
    expect(h.nodes.copy.disabled).toBe(false); expect(h.nodes.body.value).toContain('setup screen');
});

test.each([{ copyFailure: true }, { clipboard: null }])('clipboard failure provides manual selection and honest status', async options => {
    const h = fixture(options); h.preview(); h.review(); await h.click('copy');
    expect(h.nodes.status.textContent).toContain('Copy was not confirmed');
    expect(h.nodes.status.textContent).toContain('delivery are not confirmed');
    expect(h.nodes.status.textContent).not.toContain('SENSITIVE_CLIPBOARD_ERROR');
    expect(h.nodes.body.focus).toHaveBeenCalled(); expect(h.nodes.body.select).toHaveBeenCalled();
    expect(h.nodes.copy.disabled).toBe(false);
});

test('repeated copy clicks coalesce while pending and completion cannot overwrite a changed draft', async () => {
    let resolve;
    const h = fixture({ copyPromise: new Promise(done => { resolve = done; }) }); h.preview(); h.review();
    const first = h.click('copy'); const second = h.click('copy');
    expect(h.copied).toHaveLength(1); expect(h.nodes.copy.disabled).toBe(true);
    h.nodes.description.events.input(); resolve(); await Promise.all([first, second]);
    expect(h.nodes.status.textContent).toBe('Your draft changed. Review it again before sharing.');
    expect(h.nodes.copy.disabled).toBe(true);
});

test('open then copy or re-preview never claims knowledge of external email delivery', async () => {
    const h = fixture(); h.preview(); h.review(); h.click('open'); await h.click('copy');
    expect(h.nodes.status.textContent).toContain('delivery are not confirmed');
    expect(h.nodes.status.textContent).not.toContain('Nothing has been sent');
    h.preview();
    expect(h.nodes.status.textContent).toContain('This page does not send email');
    expect(h.nodes.status.textContent).not.toContain('Nothing has been sent');
});

test('mount clears URL parameters, uses only text/value projections and does not capture browser state', () => {
    const h = fixture({ hash: '#kind=error&screen=signup&cookie=private&token=private&body=private' });
    expect(h.browser.history.replaceState).toHaveBeenCalledWith(null, '', '/report.html');
    h.preview('<img src=x onerror=alert(1)>'); h.review();
    expect(h.nodes.body.value).toContain('<img src=x onerror=alert(1)>');
    expect(h.nodes.subject.textContent).toMatch(/^Subject: No Fries/);
    expect(h.nodes['preview-title'].focus).toHaveBeenCalled();
    expect(Object.values(h.nodes).some(node => Object.hasOwn(node, 'innerHTML'))).toBe(false);
    const source = fs.readFileSync(path.join(root, 'js/customer-report.js'), 'utf8');
    expect(source).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|document\.cookie|console\.|userAgent|document\.referrer|innerHTML/);
});

test('report document and script are publicly packaged with inherited strict CSP and accessible labels', async () => {
    const request = require('supertest'); const app = require('../server');
    const response = await request(app).get('/report.html');
    expect(response.status).toBe(200);
    expect(response.headers['content-security-policy']).toContain("script-src 'self'; script-src-attr 'none'");
    expect(response.text).toContain('This page does not send email.');
    expect(response.text).toContain('role="status" aria-live="polite"');
    expect(response.text).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    for (const id of ['kind', 'screen', 'description', 'body', 'reviewed']) expect(response.text).toContain('for="report-' + id + '"');
    expect(response.text).not.toMatch(/<(?:form|input|select|textarea)[^>]*\s(?:name|action)=|\sstyle=|\son\w+=/);
    expect((await request(app).get('/js/customer-report.js')).status).toBe(200);
    expect((await request(app).get('/customer-report.css')).status).toBe(200);
    expect((await request(app).post('/report.html').send({ message: 'Not a write channel' })).status).toBe(404);
});

test('generic error and missing-page help use the same report composer and preserve the primary return action', async () => {
    const request = require('supertest'); const app = require('../server');
    const missing = await request(app).get('/synthetic-missing-report-page');
    expect(missing.status).toBe(404);
    expect(missing.text).toContain('href="/report.html#kind=bug&amp;screen=website"');
    const error = await request(app).get('/error.html');
    expect(error.status).toBe(200);
    expect(error.text).toContain('Error code: website_request_unavailable');
    expect(error.text).toContain('code=website_request_unavailable');
    expect(error.text).not.toContain('mailto:hello@nofries.nz');
    for (const html of [missing.text, error.text]) {
        expect(html.match(/class="button"/g)).toHaveLength(1);
        expect(html).toContain('Return to No Fries');
    }
});

test('real static and App Service builders include identical reporting sources without routing changes', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-report-package-'));
    try {
        const { PUBLIC_ROOT_FILES } = require('../lib/publicAssets');
        for (const file of ['package.json', 'package-lock.json', 'app-service.js', 'server.js', 'staticwebapp.config.json',
            'scripts/build-static.js', 'scripts/build-app-service.js', ...PUBLIC_ROOT_FILES]) {
            fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
            fs.copyFileSync(path.join(root, file), path.join(directory, file));
        }
        for (const name of ['api', 'app', 'assets', 'images', 'js', 'lib']) fs.cpSync(path.join(root, name), path.join(directory, name),
            { recursive: true, filter: source => !path.relative(root, source).split(path.sep).includes('node_modules') });
        execFileSync(process.execPath, ['scripts/build-static.js'], { cwd: directory, stdio: 'pipe' });
        execFileSync(process.execPath, ['scripts/build-app-service.js'], { cwd: directory, stdio: 'pipe' });
        for (const name of ['report.html', 'js/customer-report.js', 'customer-report.css']) {
            const source = fs.readFileSync(path.join(root, name));
            const staticBytes = name === 'report.html'
                ? Buffer.from(require('../lib/withSharedAssistantDocument').withSharedAssistantDocument(source.toString('utf8'), 'dashboard'))
                : source;
            expect(fs.readFileSync(path.join(directory, 'dist', name))).toEqual(staticBytes);
            expect(fs.readFileSync(path.join(directory, 'app-service-dist', name))).toEqual(source);
        }
        const config = JSON.parse(fs.readFileSync(path.join(directory, 'dist/staticwebapp.config.json')));
        expect(Buffer.byteLength(JSON.stringify(config))).toBeLessThanOrEqual(20000);
        expect(config.routes.some(route => String(route.route).startsWith('/report'))).toBe(false);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
