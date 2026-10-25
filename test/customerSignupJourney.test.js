'use strict';
const { createDom } = require('./fixtures/dashboardDom');
const { mountSignupJourney } = require('../api/shared/customerSignup/signupJourney');
const { createSignupClient } = require('../api/shared/customerSignup/signupClient');
const reportComposer = require('../js/customer-report');
const TERMS = { status: 'terms', termsText: 'Synthetic terms only. No live pilot agreement.',
    termsVersion: 'pilot-1', termsDigest: 'a'.repeat(64) };
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function setup(state = { status: 'create_account' }, options, suppliedClient) {
    const dom = createDom(), create = dom.document.createElement;
    dom.document.createElement = tag => Object.assign(create(tag), { style: {} });
    const client = suppliedClient || { load: jest.fn(async () => state), createAccount: jest.fn(async () => TERMS),
        acceptTerms: jest.fn(async () => ({ status: 'pending_admission' })),
        resumeAcceptance: jest.fn(async () => ({ status: 'pending_admission' })),
        completeSetup: jest.fn(async () => ({ status: 'continue_authentication' })) };
    const view = mountSignupJourney(dom.root, client, options);
    return { ...dom, client, view };
}
test.each([
    [{ customerTransport: 'external' }, 'Login'],
    [{ customerTransport: 'external', signInRecovery: 'retry' }, 'Restart secure sign-in'],
    [{ customerTransport: 'external', chooseAccount: true }, 'Sign in with another account']
])('external entry omits the invitation alternative while retaining deliberate normal login: %j', async (options, label) => {
    const f = setup({ status: 'create_account' }, options);
    try {
        await f.view.ready;
        const links = [...f.root.querySelectorAll('a')];
        expect(links.some(link => link.href === '/login?provider=legacy')).toBe(false);
        expect(f.root.textContent).not.toContain('Use an existing invitation account');
        const login = f.root.querySelector('button');
        expect(login.textContent).toBe(label); expect(login.disabled).toBeFalsy();
        expect(f.client.createAccount).not.toHaveBeenCalled();
        login.click(); await flush();
        expect(f.client.createAccount).toHaveBeenCalledTimes(1);
        expect(f.client.createAccount).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
        expect(f.root.textContent).toContain('Review your terms');
        expect(f.root.querySelector('input').checked).toBe(false);
        expect(f.client.acceptTerms).not.toHaveBeenCalled();
    } finally { f.view.dispose(); }
});

test('renders create-account, unchecked terms and pending-admission in sequence', async () => {
    const f = setup(); await f.view.ready;
    expect(f.root.textContent).toContain('Sign up / Sign in');
    f.root.querySelector('button').click(); await flush();
    const box = f.root.querySelector('input'), submit = f.root.querySelector('button');
    expect(box.checked).toBe(false); expect(submit.disabled).toBe(true);
    submit.click(); await flush(); expect(f.client.acceptTerms).not.toHaveBeenCalled();
    box.checked = true; for (const fn of box.events.change) fn();
    submit.click(); await flush();
    expect(f.client.acceptTerms).toHaveBeenCalledWith({ termsVersion: 'pilot-1', termsDigest: 'a'.repeat(64), accepted: true }, { signal: expect.any(AbortSignal) });
    expect(f.root.textContent).toContain('You do not have dashboard access yet');
    expect(f.document.activeElement.tagName).toBe('H1');
    expect(f.root.getAttribute('aria-busy')).toBe('false');
});
test('renders terms as text, never HTML or a provider-supplied navigation link', async () => {
    const f = setup({ ...TERMS, termsText: '<script>steal()</script><img src=https://evil.invalid>' });
    await f.view.ready;
    expect(f.root.textContent).toContain('<script>steal()</script>');
    expect(f.root.querySelector('script')).toBeNull(); expect(f.root.querySelector('img')).toBeNull();
    expect(f.root.querySelector('a')).toBeNull();
});
test.each([null, { status: 'active', url: 'https://evil.invalid' }, { ...TERMS, termsDigest: 'wrong' },
    { ...TERMS, termsText: '' }, { ...TERMS, termsText: 'x'.repeat(32769) }])('invalid state fails closed', async state => {
    const f = setup(state); await f.view.ready;
    expect(f.root.textContent).toContain('Signup is unavailable');
    expect(f.root.querySelector('input')).toBeNull();
});
test('double click starts only one account operation and stale controls cannot submit', async () => {
    const f = setup(); await f.view.ready;
    let finish; f.client.createAccount.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const old = f.root.querySelector('button'); old.click(); old.click();
    expect(f.client.createAccount).toHaveBeenCalledTimes(1);
    finish(TERMS); await flush(); old.click(); await flush();
    expect(f.client.createAccount).toHaveBeenCalledTimes(1);
});
test('provider failure is retryable and never displays private exception text', async () => {
    const f = setup(); await f.view.ready;
    f.client.createAccount.mockRejectedValueOnce(new Error('private-token-value'));
    f.root.querySelector('button').click(); await flush();
    expect(f.root.textContent).toContain('Signup is unavailable');
    expect(f.root.textContent).not.toContain('private-token-value');
    f.root.querySelector('button').click(); await flush();
    expect(f.root.textContent).toContain('Sign up / Sign in');
});

test('an uncertain invitation refresh does not deny existing access and only reloads state', async () => {
    const f = setup({ status: 'continue_to_dashboard', accountType: 'company' }); await f.view.ready;
    try {
        // A later caller can lose its status read while durable access still
        // exists. Error copy must describe uncertainty rather than revoke it.
        f.view.dispose();
        f.client.load.mockRejectedValueOnce(new Error('synthetic-private-status-error'));
        const view = mountSignupJourney(f.root, f.client);
        try {
            await view.ready;
            expect(f.root.textContent).toContain('We could not confirm your current access');
            expect(f.root.textContent).not.toContain('No access has been granted');
            expect(f.root.textContent).not.toContain('synthetic-private-status-error');
            const report = f.root.querySelector('a');
            expect(report.href).toBe('/report.html#kind=error&screen=signup&code=signup_unavailable');
            expect(report.href).not.toMatch(/step=|synthetic-private-status-error|\?/);
            expect(report.target).toBe('_blank'); expect(report.rel).toBe('noopener noreferrer');
            expect(report.getAttribute('aria-label')).toBe('Report this problem (opens in a new tab)');
            expect(f.root.querySelector('button').textContent).toBe('Try again');
            f.root.querySelector('button').click(); await flush();
            expect(f.root.querySelector('a').href).toBe('/dashboard');
            expect(f.client.createAccount).not.toHaveBeenCalled(); expect(f.client.acceptTerms).not.toHaveBeenCalled();
        } finally { view.dispose(); }
    } finally { f.view.dispose(); }
});
test('dispose prevents late responses from repopulating the page', async () => {
    const f = setup(); await f.view.ready;
    let finish; f.client.createAccount.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    f.root.querySelector('button').click(); f.view.dispose(); finish(TERMS); await flush();
    expect(f.root.children).toHaveLength(0);
});

test('hung client times out, aborts and permits safe status reload; late result is ignored', async () => {
    jest.useFakeTimers();
    try {
        const f = setup(); await f.view.ready;
        let finish, signal;
        f.client.createAccount.mockImplementation(options => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); });
        f.root.querySelector('button').click();
        await jest.advanceTimersByTimeAsync(60000);
        expect(signal.aborted).toBe(false);
        expect(f.root.getAttribute('aria-busy')).toBe('true');
        await jest.advanceTimersByTimeAsync(570000);
        expect(signal.aborted).toBe(true);
        expect(f.root.getAttribute('aria-busy')).toBe('false');
        expect(f.root.textContent).toContain('Signup is unavailable');
        f.root.querySelector('button').click(); await flush();
        finish(TERMS); await flush();
        expect(f.root.textContent).toContain('Sign up / Sign in');
        expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
});

test('dispose settles ready even when client ignores cancellation', async () => {
    const dom = createDom();
    const view = mountSignupJourney(dom.root, { load: () => new Promise(() => {}), createAccount() {}, acceptTerms() {} });
    view.dispose(); await view.ready;
    expect(dom.root.children).toHaveLength(0);
    expect(dom.root.getAttribute('aria-busy')).toBeNull();
});
test('minute-long account flow completes into unchecked terms without the old view timeout', async () => {
    jest.useFakeTimers();
    try {
        const f = setup(); await f.view.ready; let finish;
        f.client.createAccount.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        f.root.querySelector('button').click();
        await jest.advanceTimersByTimeAsync(60000);
        finish(TERMS); await flush();
        expect(f.root.textContent).toContain('Review your terms');
        expect(f.root.querySelector('input').checked).toBe(false);
        expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
});
test('ordinary state loading retains the 30-second view backstop', async () => {
    jest.useFakeTimers();
    try {
        const dom = createDom(); let signal;
        const view = mountSignupJourney(dom.root, { load(options) { signal = options.signal; return new Promise(() => {}); },
            createAccount() {}, acceptTerms() {} });
        await jest.advanceTimersByTimeAsync(30000); await view.ready;
        expect(signal.aborted).toBe(true);
        expect(dom.root.textContent).toContain('Signup is unavailable');
        expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
});

test('renders the exact organisation schedule before combined consent', async () => {
    const scheduled = { ...TERMS, scheduleId: 'schedule-v1',
        scheduleText: 'Synthetic organisation schedule.', scheduleDigest: 'b'.repeat(64) };
    const f = setup(scheduled); await f.view.ready;
    expect(f.root.textContent).toContain('Organisation schedule');
    expect(f.root.textContent).toContain(scheduled.scheduleText);
    expect(f.root.textContent).toContain('I accept this organisation schedule and agreement.');
    const box = f.root.querySelector('input'); box.checked = true;
    for (const fn of box.events.change) fn();
    f.root.querySelector('button').click(); await flush();
    expect(f.client.acceptTerms).toHaveBeenCalledWith({
        termsVersion: scheduled.termsVersion, termsDigest: scheduled.termsDigest,
        scheduleId: scheduled.scheduleId, scheduleDigest: scheduled.scheduleDigest, accepted: true
    }, { signal: expect.any(AbortSignal) });
});

test('offers a distinct protected resume action without asking for consent again', async () => {
    const f = setup({ status: 'resume_acceptance' }); await f.view.ready;
    expect(f.root.textContent).toContain('without accepting again');
    expect(f.root.querySelector('input')).toBeNull();
    f.root.querySelector('button').click(); await flush();
    expect(f.client.resumeAcceptance).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
    expect(f.client.acceptTerms).not.toHaveBeenCalled();
    expect(f.root.textContent).toContain('You do not have dashboard access yet');
});


test.each([
    [undefined, '/dashboard'], ['company', '/dashboard'], ['consultant', '/dashboard#organisations']
])('completed account %p uses a fixed local destination', async (accountType, destination) => {
    const f = setup({ status: 'continue_to_dashboard', ...(accountType ? { accountType } : {}), destination: 'https://foreign.invalid' });
    await f.view.ready;
    expect(f.root.querySelector('a').href).toBe(destination);
    expect(f.root.querySelector('h1').textContent).toBe('Account setup complete');
    expect(f.root.textContent).not.toContain('NF-SIGNUP-UNCONFIRMED');
    if (accountType === 'consultant') expect(f.root.textContent).toContain('consultant dashboard');
    f.view.dispose();
});
test('invalid completed account type never exposes a dashboard link', async () => {
    const f = setup({ status: 'continue_to_dashboard', accountType: 'operator' }); await f.view.ready;
    expect(f.root.querySelectorAll('a').map(link => link.href))
        .toEqual(['/report.html#kind=error&screen=signup&code=signup_unavailable']);
    expect(f.root.textContent).toContain('Signup is unavailable');
    f.view.dispose();
});

const externalOptions = { customerTransport: 'external' };
const savedAccount = { accountType: 'consultant', organisationName: 'Synthetic retained workspace' };
const retained = { status: 'resume_setup', email: 'synthetic@example.test', ...savedAccount };

test.each([undefined, { ...savedAccount }])('setup identifies only supported input purposes with reservation %j', async reservation => {
    const f = setup({ status: 'setup_details', email: retained.email,
        ...(reservation ? { reservation } : {}) }, externalOptions);
    await f.view.ready;
    try {
        const form = f.root.querySelector('form');
        const inputs = Object.fromEntries(form.querySelectorAll('input').map(input => [input.name, input]));
        for (const [name, purpose, maximum] of [
            ['organisationName', 'organization', 120], ['name', 'name', 160],
            ['role', 'organization-title', 120], ['address', 'street-address', 500]
        ]) {
            expect(inputs[name].getAttribute('autocomplete')).toBe(purpose);
            expect(inputs[name].type).toBe('text');
            expect(inputs[name].maxLength).toBe(maximum); expect(inputs[name].required).toBe(true);
            expect(!!inputs[name].disabled).toBe(name === 'organisationName' && !!reservation);
        }
        expect(inputs.registrationId.getAttribute('autocomplete')).toBeNull();
        expect(inputs.authorityConfirmed.getAttribute('autocomplete')).toBeNull();
        expect(form.querySelector('select').getAttribute('autocomplete')).toBeNull();
        expect(inputs.authorityConfirmed.checked).toBe(false);
        expect(inputs.email).toBeUndefined();
        expect(f.client.completeSetup).not.toHaveBeenCalled();
        expect(f.client.createAccount).not.toHaveBeenCalled(); expect(f.client.acceptTerms).not.toHaveBeenCalled();
    } finally { f.view.dispose(); }
});

test.each(['company', 'consultant'])('setup presents the optional NZBN with associated help for %s', async accountType => {
    const f = setup({ status: 'setup_details', email: retained.email,
        reservation: { accountType, organisationName: 'Synthetic NZ workspace' } }, externalOptions);
    await f.view.ready;
    try {
        const form = f.root.querySelector('form');
        const input = form.querySelectorAll('input').find(node => node.name === 'registrationId');
        expect(input.parentElement.tagName).toBe('LABEL');
        expect(input.parentElement.textContent).toMatch(/^NZBN \(optional\)/);
        expect(input.getAttribute('aria-label')).toBe('NZBN (optional)');
        const help = f.root.querySelector('[id="' + input.getAttribute('aria-describedby') + '"]');
        expect(help).not.toBeNull();
        expect(help.textContent).toBe('Your New Zealand Business Number, if you have one.');
        expect(input.type).toBe('text'); expect(input.required).toBe(false); expect(input.maxLength).toBe(160);
        expect(input.getAttribute('pattern')).toBeNull();
        expect(f.root.textContent).not.toContain('Registration number');
        expect(f.client.completeSetup).not.toHaveBeenCalled();
    } finally { f.view.dispose(); }
});

test('reserved account fields stay locked and submission uses their captured canonical values', async () => {
    const state = { status: 'setup_details', email: retained.email, reservation: { ...savedAccount } };
    const f = setup(state, externalOptions); await f.view.ready;
    try {
        const form = f.root.querySelector('form'), select = form.querySelector('select');
        const inputs = Object.fromEntries(form.querySelectorAll('input').map(input => [input.name, input]));
        expect(select.value).toBe('consultant'); expect(select.disabled).toBe(true);
        expect(inputs.organisationName.value).toBe(savedAccount.organisationName); expect(inputs.organisationName.disabled).toBe(true);
        for (const name of ['name', 'role', 'address', 'registrationId', 'authorityConfirmed']) expect(inputs[name].disabled).toBeFalsy();
        expect(f.client.completeSetup).not.toHaveBeenCalled();
        // Disabled controls are presentation only; even altered DOM/client
        // records cannot replace the canonical account captured by this view.
        select.value = 'company'; inputs.organisationName.value = 'Altered DOM organisation';
        state.reservation.organisationName = 'Altered client record';
        Object.assign(inputs.name, { value: 'Synthetic name' }); Object.assign(inputs.role, { value: 'Owner' });
        Object.assign(inputs.address, { value: 'Synthetic address' }); Object.assign(inputs.registrationId, { value: '9429000000000' });
        inputs.authorityConfirmed.checked = true; form.reportValidity = () => true;
        for (const submit of form.events.submit) submit({ preventDefault() {} });
        await flush();
        expect(f.client.completeSetup).toHaveBeenCalledWith({ ...savedAccount,
            details: { name: 'Synthetic name', role: 'Owner', address: 'Synthetic address', registrationId: '9429000000000', authorityConfirmed: true } },
        { signal: expect.any(AbortSignal) });
        expect(f.root.textContent).toContain('Continuing account setup');
    } finally { f.view.dispose(); }
});

test('saved setup is resumed manually once with no edited detail form or automatic authentication', async () => {
    const f = setup(retained, externalOptions); await f.view.ready;
    try {
        expect(f.root.textContent).toContain('Your details are saved'); expect(f.root.textContent).toContain(savedAccount.organisationName);
        expect(f.root.textContent).toContain('Account type: Consultant');
        expect(f.root.querySelector('input')).toBeNull(); expect(f.root.querySelector('select')).toBeNull();
        expect(f.client.completeSetup).not.toHaveBeenCalled(); expect(f.client.createAccount).not.toHaveBeenCalled();
        expect(f.root.querySelector('form')).toBeNull();
        expect(f.root.querySelectorAll('a').map(link => link.href)).toEqual([
            '/api/external-customer-auth/login', '/api/external-customer-auth/login?account=choose']);
        let finish; f.client.completeSetup.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const resume = f.root.querySelector('button'); resume.click(); resume.click();
        expect(f.client.completeSetup).toHaveBeenCalledTimes(1);
        expect(f.client.completeSetup).toHaveBeenCalledWith({ resume: true }, { signal: expect.any(AbortSignal) });
        expect(resume.disabled).toBe(true);
        finish({ status: 'continue_authentication' }); await flush();
        resume.click(); await flush(); expect(f.client.completeSetup).toHaveBeenCalledTimes(1);
    } finally { f.view.dispose(); }
});

test('failed resume offers an unconfirmed code and manual sign-in without repeating setup or claiming sign-out', async () => {
    const f = setup(retained, externalOptions); await f.view.ready; let fresh;
    try {
        f.client.completeSetup.mockRejectedValueOnce(new Error('synthetic-private-error'));
        f.root.querySelector('button').click(); await flush();
        expect(f.root.textContent).toContain('Do not create another account or submit your details again.');
        expect(f.root.textContent).toContain('Error code: NF-SIGNUP-UNCONFIRMED'); expect(f.root.textContent).not.toContain('synthetic-private-error');
        expect(f.root.querySelector('form')).toBeNull(); expect(f.root.textContent).not.toContain('signed out');
        expect(f.root.querySelectorAll('a').map(link => link.href)).toEqual([
            '/report.html#kind=error&screen=signup&code=signup_unavailable',
            '/api/external-customer-auth/login', '/api/external-customer-auth/login?account=choose'
        ]);
        expect(f.client.completeSetup).toHaveBeenCalledTimes(1); expect(f.client.createAccount).not.toHaveBeenCalled();
        expect(f.root.querySelector('button')).toBeNull(); await flush();
        expect(f.client.load).toHaveBeenCalledTimes(1);
        f.view.dispose();
        fresh = mountSignupJourney(f.root, f.client, externalOptions); await fresh.ready;
        expect(f.client.load).toHaveBeenCalledTimes(2); expect(f.client.completeSetup).toHaveBeenCalledTimes(1);
        expect(f.root.textContent).toContain('Resume your workspace setup');
    } finally { fresh?.dispose(); f.view.dispose(); }
});

test('authentication-needed state offers cause-neutral manual sign-in and preserves saved setup without logout', async () => {
    const f = setup({ status: 'signin_required' }, externalOptions); await f.view.ready;
    try {
        expect(f.root.querySelector('h1').textContent).toBe('Sign in again');
        expect(f.root.textContent).toContain('Continue secure sign-in with the email linked to your account.');
        expect(f.root.textContent).toContain('Your saved setup and work are kept.');
        expect(f.root.textContent).not.toMatch(/no longer valid|invalid|expired|password/i);
        expect(f.root.querySelector('button')).toBeNull(); expect(f.root.querySelector('form')).toBeNull();
        expect(f.root.querySelectorAll('a').map(link => link.href)).toEqual([
            '/api/external-customer-auth/login', '/api/external-customer-auth/login?account=choose'
        ]);
        expect(f.client.createAccount).not.toHaveBeenCalled(); expect(f.client.completeSetup).not.toHaveBeenCalled();
        expect(f.client.acceptTerms).not.toHaveBeenCalled();
    } finally { f.view.dispose(); }
});

test.each([
    { ...retained, organisationName: '' }, { ...retained, accountType: 'operator' }, { ...retained, details: {} },
    { status: 'setup_details', email: retained.email, reservation: null },
    { status: 'setup_details', email: retained.email, reservation: { ...savedAccount, subjectKey: 'forged' } }
])('invalid retained state cannot present an editable/resume form %#', async state => {
    const f = setup(state, externalOptions); await f.view.ready;
    try {
        expect(f.root.textContent).toContain('Signup is unavailable'); expect(f.root.querySelector('form')).toBeNull();
        expect(f.root.querySelector('input')).toBeNull(); expect(f.client.completeSetup).not.toHaveBeenCalled();
    } finally { f.view.dispose(); }
});

test.each([{ status: 'pending_preparation' }, { status: 'pending_admission' }, { status: 'continue_to_dashboard', accountType: 'company' }])(
    'post-setup states do not offer provisional logout or resumption: %s', async state => {
        const f = setup(state, externalOptions); await f.view.ready;
        try {
            expect(f.root.querySelector('form')).toBeNull(); expect(f.root.textContent).not.toContain('Sign out and change account');
            expect(f.client.completeSetup).not.toHaveBeenCalled(); expect(f.client.createAccount).not.toHaveBeenCalled();
            expect(f.root.textContent).not.toContain('NF-SIGNUP-UNCONFIRMED');
            if (state.status === 'pending_preparation') {
                expect(f.root.querySelector('h1').textContent).toBe('Your organisation is being prepared');
                expect(f.root.querySelector('button').textContent).toBe('Check setup status');
            } else if (state.status === 'pending_admission') {
                expect(f.root.querySelector('h1').textContent).toBe('Account setup received');
                expect(f.root.querySelector('button').textContent).toBe('Check access status');
                expect(f.root.textContent).toContain('You do not have dashboard access yet');
            }
        } finally { f.view.dispose(); }
    });

// Synthetic native HTTP responses exercise the actual client/view/composer
// boundary. They do not establish a deployed header or diagnostic-log lookup.
const supportReference = 'NF-0123456789ABCDEF', apiReleaseSha = 'a'.repeat(40), apiReleaseRunId = '1234567';
function unavailableReport(f) {
    const link = f.root.querySelectorAll('a').find(node => node.textContent === 'Report this problem');
    expect(link).toBeDefined();
    expect(link.target).toBe('_blank'); expect(link.rel).toBe('noopener noreferrer');
    expect(link.getAttribute('aria-label')).toBe('Report this problem (opens in a new tab)');
    const url = new URL(link.href, 'https://synthetic.example.test');
    expect(url.origin).toBe('https://synthetic.example.test'); expect(url.pathname).toBe('/report.html');
    expect(url.search).toBe('');
    const params = new URLSearchParams(url.hash.slice(1));
    expect(params.get('kind')).toBe('error'); expect(params.get('screen')).toBe('signup');
    expect(params.get('code')).toBe('signup_unavailable'); expect(params.has('step')).toBe(false);
    return { link, params };
}

test.each([503, 200])('actual client/view carries only the original %s unavailable response into a report, then clears it on fresh navigation', async status => {
    const forged = { supportReference: 'NF-FFFFFFFFFFFFFFFF', apiReleaseSha: 'b'.repeat(40), token: 'synthetic-private-body' };
    const body = status === 200 ? { state: { status: 'unavailable', ...forged } } : { error: 'synthetic-private-body', ...forged };
    const fetch = jest.fn().mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers: {
        'content-type': 'application/json', 'X-NoFries-Support-Reference': supportReference,
        'X-NoFries-Release-Sha': apiReleaseSha, 'X-NoFries-Release-Run-Id': apiReleaseRunId,
        'X-Request-ID': 'synthetic-private-request', 'Set-Cookie': 'synthetic-private-cookie'
    } })).mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
    const createAccount = jest.fn(), client = createSignupClient({ fetch, createAccount, customerTransport: 'external' });
    const f = setup(undefined, externalOptions, client); let fresh, freshClient;
    try {
        await f.view.ready;
        const first = unavailableReport(f);
        expect(Object.fromEntries(first.params)).toEqual({ kind: 'error', screen: 'signup', code: 'signup_unavailable',
            reference: supportReference, apiReleaseSha, apiReleaseRunId });
        const draft = reportComposer.prepare({ kind: 'error', screen: 'signup', description: 'The status check did not finish.' },
            reportComposer.readContext(first.params.toString()), 'NF-FEDCBA9876543210', '2026-10-13T12:00:00.000Z');
        expect(draft.body).toContain('Support reference: ' + supportReference);
        expect(draft.body).toContain('Report reference: NF-FEDCBA9876543210');
        expect(draft.body).toContain('Original API release SHA: ' + apiReleaseSha);
        expect(draft.body).toContain('Original API release run: ' + apiReleaseRunId);
        expect(draft.body + first.link.href + f.root.textContent).not.toMatch(/synthetic-private|FFFFFFFFFFFFFFFF|bbbbbbbb|Failed step:/);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(f.root.querySelector('button')).toBeNull();
        expect(f.root.textContent).toContain('Error code: NF-SIGNUP-UNCONFIRMED');
        await flush(); expect(fetch).toHaveBeenCalledTimes(1);
        f.view.dispose(); client.dispose();
        freshClient = createSignupClient({ fetch, createAccount, customerTransport: 'external' });
        fresh = setup(undefined, externalOptions, freshClient); await fresh.view.ready;
        expect(Object.fromEntries(unavailableReport(fresh).params)).toEqual({ kind: 'error', screen: 'signup', code: 'signup_unavailable' });
        expect(fetch.mock.calls.map(([path, options]) => [path, options.method])).toEqual([
            ['/api/external-customer-signup/state', 'GET'], ['/api/external-customer-signup/state', 'GET']
        ]);
        expect(createAccount).not.toHaveBeenCalled();
        expect(fresh.root.textContent).toContain('Do not create another account or submit your details again.');
        expect(fresh.root.textContent).toContain('Error code: NF-SIGNUP-UNCONFIRMED');
        expect(fresh.root.querySelector('button')).toBeNull();
    } finally { fresh?.view.dispose(); freshClient?.dispose(); f.view.dispose(); client.dispose(); }
});

test('provider-forged reference and release fields cannot reach the actual journey report or trigger a refresh', async () => {
    const fetch = jest.fn(async () => new Response(JSON.stringify({ state: { status: 'create_account' } }),
        { headers: { 'content-type': 'application/json' } }));
    const createAccount = jest.fn(async () => { throw Object.assign(new Error('synthetic-private-provider'),
        { supportReference, apiReleaseSha, apiReleaseRunId, token: 'synthetic-private-token' }); });
    const client = createSignupClient({ fetch, createAccount, customerTransport: 'external' });
    const f = setup(undefined, externalOptions, client);
    try {
        await f.view.ready; f.root.querySelector('button').click(); await flush();
        const report = unavailableReport(f);
        expect(Object.fromEntries(report.params)).toEqual({ kind: 'error', screen: 'signup', code: 'signup_unavailable' });
        expect(report.link.href + f.root.textContent).not.toMatch(/synthetic-private|reference=|apiRelease/);
        expect(createAccount).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
    } finally { f.view.dispose(); client.dispose(); }
});

test.each([
    ['absent', undefined], ['throwing', () => { throw new Error('synthetic-private-diagnostic'); }],
    ['malformed', () => ({ supportReference: supportReference + '\n', apiReleaseSha, apiReleaseRunId: '01', token: 'synthetic-private-token' })]
])('an %s optional diagnostic port preserves the styled recovery link without trusting state fields', async (_label, diagnostic) => {
    const client = { load: jest.fn(async () => ({ status: 'unavailable', supportReference, apiReleaseSha, apiReleaseRunId })),
        createAccount: jest.fn(), acceptTerms: jest.fn(), diagnostic };
    const f = setup(undefined, externalOptions, client);
    try {
        await f.view.ready;
        const report = unavailableReport(f);
        expect(Object.fromEntries(report.params)).toEqual({ kind: 'error', screen: 'signup', code: 'signup_unavailable' });
        expect(report.link.href + f.root.textContent).not.toMatch(/synthetic-private|reference=|apiRelease/);
        expect(f.root.querySelector('button')).toBeNull();
        expect(f.root.textContent).toContain('Error code: NF-SIGNUP-UNCONFIRMED');
        expect(f.root.getAttribute('aria-busy')).toBe('false'); expect(f.document.activeElement.tagName).toBe('H1');
        expect(client.load).toHaveBeenCalledTimes(1); expect(client.createAccount).not.toHaveBeenCalled();
        expect(client.acceptTerms).not.toHaveBeenCalled();
    } finally { f.view.dispose(); }
});


test.each([['login', 'Log in to No Fries', 'Log in'], ['create', 'Create your account', 'Create account']])(
    'validated %s intent presents one clear manual fallback without acting at render time', async (entryIntent, heading, label) => {
        const f = setup({ status: 'create_account' }, { customerTransport: 'external', entryIntent });
        try {
            await f.view.ready;
            expect(f.root.textContent).toContain(heading); expect(f.root.querySelector('button').textContent).toBe(label);
            expect(f.client.createAccount).not.toHaveBeenCalled();
            f.root.querySelector('button').click(); await flush();
            expect(f.client.createAccount).toHaveBeenCalledTimes(1);
            expect(f.root.querySelector('input').checked).toBe(false);
            expect(f.client.acceptTerms).not.toHaveBeenCalled();
        } finally { f.view.dispose(); }
    });

test.each(['register', '', null, ['login']])('invalid entry intent %j is refused by the renderer', entryIntent => {
    expect(() => setup({ status: 'create_account' }, { entryIntent })).toThrow();
});


test.each(['network', '503', 'timeout', 'unavailable', 'malformed'])(
    'external %s observation is unconfirmed without a retry action or private error reflection', async kind => {
        if (kind === 'timeout') jest.useFakeTimers();
        const canary = 'synthetic-private-provider-or-account-detail';
        const fetch = jest.fn(() => {
            if (kind === 'network') return Promise.reject(new Error(canary));
            if (kind === 'timeout') return new Promise(() => {});
            const body = kind === 'malformed' ? '{invalid-json:' + canary
                : JSON.stringify(kind === 'unavailable' ? { state: { status: 'unavailable', reason: canary } } : { error: canary });
            return Promise.resolve(new Response(body, { status: kind === '503' ? 503 : 200,
                headers: { 'content-type': 'application/json' } }));
        });
        const createAccount = jest.fn(), client = createSignupClient({ fetch, createAccount, customerTransport: 'external' });
        const f = setup(undefined, externalOptions, client);
        try {
            if (kind === 'timeout') await jest.advanceTimersByTimeAsync(15000);
            await f.view.ready; await flush();
            expect(f.root.querySelector('h1').textContent).toBe('Signup is unavailable');
            expect(f.root.textContent).toContain('We could not confirm your account setup. Do not create another account or submit your details again.');
            expect(f.root.textContent).toContain('Error code: NF-SIGNUP-UNCONFIRMED');
            expect(f.root.textContent).toContain('Contact No Fries for help and include this error code.');
            expect(f.root.textContent).not.toContain('Check setup status');
            expect(f.root.textContent).not.toContain('This does not resubmit your details');
            expect(f.root.textContent).not.toContain(canary);
            expect(f.root.querySelector('button')).toBeNull(); expect(f.root.querySelector('form')).toBeNull();
            expect(f.root.getAttribute('aria-busy')).toBe('false'); expect(f.document.activeElement.tagName).toBe('H1');
            expect(f.root.querySelectorAll('a').map(link => link.href)).toEqual([
                '/report.html#kind=error&screen=signup&code=signup_unavailable',
                '/api/external-customer-auth/login', '/api/external-customer-auth/login?account=choose'
            ]);
            expect(fetch.mock.calls.map(([url, options]) => [url, options.method])).toEqual([['/api/external-customer-signup/state', 'GET']]);
            expect(createAccount).not.toHaveBeenCalled();
        } finally { f.view.dispose(); client.dispose(); if (kind === 'timeout') jest.useRealTimers(); }
    });
const readOnlySetup = { status: 'setup_read_only' };

test.each([undefined, externalOptions])('saved read-only setup exposes only a status read and fixed home navigation (%j)', async options => {
    const f = setup(readOnlySetup, options); await f.view.ready;
    try {
        expect(f.root.querySelector('h1').textContent).toBe('Workspace setup saved');
        expect(f.root.textContent).toContain('Further setup steps are unavailable right now.');
        expect(f.root.querySelector('form')).toBeNull(); expect(f.root.querySelector('input')).toBeNull();
        expect(f.root.querySelector('select')).toBeNull();
        expect(f.root.querySelectorAll('a').map(link => link.href)).toEqual(['/']);
        const buttons = f.root.querySelectorAll('button'); expect(buttons).toHaveLength(1);
        expect(buttons[0].textContent).toBe('Check setup status');
        expect(f.client.load).toHaveBeenCalledTimes(1);
        buttons[0].click(); await flush();
        expect(f.client.load).toHaveBeenCalledTimes(2);
        expect(f.client.load).toHaveBeenLastCalledWith({ signal: expect.any(AbortSignal) });
        expect(f.root.querySelector('h1').textContent).toBe('Workspace setup saved');
        expect(f.document.activeElement.tagName).toBe('H1'); expect(f.root.getAttribute('aria-busy')).toBe('false');
        for (const name of ['createAccount', 'completeSetup', 'acceptTerms', 'resumeAcceptance']) expect(f.client[name]).not.toHaveBeenCalled();
    } finally { f.view.dispose(); }
});

test.each([
    { ...readOnlySetup, email: 'synthetic-private@example.test' },
    { ...readOnlySetup, accepted: true }, { ...readOnlySetup, dashboardAccess: true },
    { ...readOnlySetup, action: 'resume' }, Object.assign([], readOnlySetup)
])('read-only setup rejects augmented or non-record states without trusting their authority %#', async state => {
    const f = setup(state, externalOptions); await f.view.ready;
    try {
        expect(f.root.querySelector('h1').textContent).toBe('Signup is unavailable');
        expect(f.root.textContent).not.toContain('synthetic-private');
        expect(f.root.querySelector('form')).toBeNull(); expect(f.root.querySelector('input')).toBeNull();
        expect(f.client.completeSetup).not.toHaveBeenCalled(); expect(f.client.acceptTerms).not.toHaveBeenCalled();
    } finally { f.view.dispose(); }
});

test('read-only setup clears a cached details draft and stale form before an explicit status read', async () => {
    const editable = { status: 'setup_details', email: retained.email };
    const f = setup(editable, externalOptions); await f.view.ready;
    try {
        const form = f.root.querySelector('form'), inputs = Object.fromEntries(form.querySelectorAll('input').map(node => [node.name, node]));
        f.root.querySelector('select').value = 'consultant';
        for (const name of ['organisationName', 'name', 'role', 'address']) inputs[name].value = 'Synthetic private ' + name;
        inputs.registrationId.value = ''; inputs.authorityConfirmed.checked = true; form.reportValidity = () => true;
        const submitOld = () => { for (const fn of form.events.submit) fn({ preventDefault() {} }); };
        f.client.completeSetup.mockResolvedValueOnce(readOnlySetup);
        submitOld(); await flush();
        expect(f.client.completeSetup).toHaveBeenCalledTimes(1);
        expect(f.root.querySelector('h1').textContent).toBe('Workspace setup saved');
        expect(f.root.querySelector('form')).toBeNull(); expect(f.root.textContent).not.toContain('Synthetic private');
        submitOld(); await flush(); expect(f.client.completeSetup).toHaveBeenCalledTimes(1);
        // A later explicit GET can observe ordinary editable historical state;
        // it must not revive the details cleared by the read-only projection.
        f.client.load.mockResolvedValueOnce(editable);
        f.root.querySelector('button').click(); await flush();
        const restored = Object.fromEntries(f.root.querySelector('form').querySelectorAll('input').map(node => [node.name, node]));
        for (const name of ['organisationName', 'name', 'role', 'address', 'registrationId']) expect(restored[name].value || '').toBe('');
        expect(restored.authorityConfirmed.checked).toBe(false);
        expect(f.client.completeSetup).toHaveBeenCalledTimes(1); expect(f.client.acceptTerms).not.toHaveBeenCalled();
        expect(f.client.resumeAcceptance).not.toHaveBeenCalled(); expect(f.client.createAccount).not.toHaveBeenCalled();
    } finally { f.view.dispose(); }
});

test('read-only setup replaces cached consent controls and prevents their later reuse', async () => {
    const f = setup(TERMS, externalOptions); await f.view.ready;
    try {
        const consent = f.root.querySelector('input'), accept = f.root.querySelector('button');
        consent.checked = true; for (const fn of consent.events.change) fn();
        f.client.acceptTerms.mockResolvedValueOnce(readOnlySetup); accept.click(); await flush();
        expect(f.root.querySelector('h1').textContent).toBe('Workspace setup saved');
        expect(f.root.querySelector('input')).toBeNull(); expect(f.root.querySelector('form')).toBeNull();
        accept.disabled = false; accept.click(); await flush();
        expect(f.client.acceptTerms).toHaveBeenCalledTimes(1); expect(f.client.resumeAcceptance).not.toHaveBeenCalled();
        expect(f.client.completeSetup).not.toHaveBeenCalled();
    } finally { f.view.dispose(); }
});

test('actual signup transport displays saved read-only setup and rechecks it using GET only', async () => {
    const fetch = jest.fn(async () => new Response(JSON.stringify({ state: readOnlySetup }),
        { headers: { 'content-type': 'application/json' } }));
    const createAccount = jest.fn(), client = createSignupClient({ fetch, createAccount, customerTransport: 'external' });
    const f = setup(undefined, externalOptions, client);
    try {
        await f.view.ready;
        expect(f.root.querySelector('h1').textContent).toBe('Workspace setup saved');
        f.root.querySelector('button').click(); await new Promise(setImmediate); await flush();
        expect(f.root.querySelector('h1').textContent).toBe('Workspace setup saved');
        expect(fetch.mock.calls.map(([path, options]) => [path, options.method])).toEqual([
            ['/api/external-customer-signup/state', 'GET'], ['/api/external-customer-signup/state', 'GET']
        ]);
        expect(f.root.querySelector('form')).toBeNull(); expect(f.root.querySelector('input')).toBeNull();
        expect(createAccount).not.toHaveBeenCalled();
    } finally { f.view.dispose(); client.dispose(); }
});
