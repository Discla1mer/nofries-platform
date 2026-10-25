'use strict';

const { withSignupSupportContext, annotateSignupDiagnostic } = require('../api/shared/customerSignup/signupSupportContext');
const { createSignupDiagnostics } = require('../api/shared/customerSignup/signupDiagnostics');
const { createSignupClient } = require('../api/shared/customerSignup/signupClient');
const { mountSignupJourney } = require('../api/shared/customerSignup/signupJourney');
const { createDom } = require('./fixtures/dashboardDom');

const REFERENCE = 'NF-0123456789ABCDEF', OTHER = 'NF-FEDCBA9876543210';
const STAGE = 'X-NoFries-Signup-Stage', REASON = 'X-NoFries-Signup-Reason', SUPPORT = 'X-NoFries-Support-Reference';
const PRIVATE = '<script>SYNTHETIC_PRIVATE_SQL_TOKEN_CUSTOMER</script>';
const options = reference => ({ newReference: () => reference || REFERENCE, readReleaseIdentity: () => null });
const failureBody = () => Object.freeze({ state: Object.freeze({ status: 'unavailable' }) });
const report = createSignupDiagnostics({ now: () => Date.parse('2026-10-22T00:00:00.000Z') });
const publicPair = { signupStage: 'workspace_preparation', signupReason: 'setup_information_unavailable' };
const headerValues = (extra = {}) => ({ 'content-type': 'application/json', [SUPPORT]: REFERENCE,
    [STAGE]: publicPair.signupStage, [REASON]: publicPair.signupReason, ...extra });
const clientFor = response => createSignupClient({ fetch: jest.fn(async () => response), createAccount: jest.fn(), customerTransport: 'external' });
async function failed(action) {
    try { await action; throw new Error('expected_failure'); }
    catch (error) { expect(error.message).toBe('signup_unavailable'); return error; }
}
function mount(client, customerTransport = 'external') {
    const dom = createDom(), view = mountSignupJourney(dom.root,
        { createAccount: jest.fn(), acceptTerms: jest.fn(), ...client }, { customerTransport });
    return { ...dom, view, client };
}
const projections = [];
for (const [internal, projected] of [
    ['organisation_preparation', 'workspace_preparation'], ['setup_claim', 'workspace_preparation'],
    ['setup_retained_read', 'workspace_details'], ['setup_save', 'workspace_details'], ['signup_state', 'signup_status']
]) {
    projections.push([internal, 'signup_state_unavailable', projected, 'step_unconfirmed']);
    for (const code of ['signup_store_unavailable', 'starter_store_unavailable', 'starter_details_store_unavailable', 'signup_acceptance_journal_unavailable']) {
        projections.push([internal, code, projected, 'setup_information_unavailable']);
    }
}
projections.push(['terms_offer', 'signup_state_unavailable', 'terms_review', 'step_unconfirmed'],
    ['terms_offer', 'signup_terms_unavailable', 'terms_review', 'terms_unavailable']);

test.each(projections)('first existing diagnostic projects only public metadata: %s/%s', async (stage, code, projectedStage, projectedReason) => {
    const body = failureBody(), original = { status: 200, body };
    const result = await withSignupSupportContext(() => { report(stage, { code, message: PRIVATE }); return original; }, options());
    expect(result.status).toBe(200); expect(result.body).toBe(body);
    expect(result.headers).toEqual({ [SUPPORT]: REFERENCE, [STAGE]: projectedStage, [REASON]: projectedReason });
    expect(JSON.stringify(result.headers)).not.toContain(PRIVATE);
    const client = clientFor(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', ...result.headers } }));
    const state = await client.load();
    expect(state).toEqual({ status: 'unavailable' }); expect(Object.isFrozen(state)).toBe(true);
    expect(client.diagnostic(state)).toEqual({ supportReference: REFERENCE, signupStage: projectedStage, signupReason: projectedReason });
});

test.each([
    ['organisation_preparation', 'starter_account_exists'], ['organisation_preparation', 'starter_request_changed'],
    ['organisation_preparation', 'external_starter_claim_reconciliation_required'], ['setup_save', 'starter_details_locked'],
    ['signup_state', 'signup_registration_not_found'], ['signup_state', 'signup_registration_revoked'],
    ['signup_state', 'signup_registration_conflict'], ['signup_state', 'signup_identity_required'],
    ['signup_state', 'signup_record_invalid'], ['signup_state', 'postgres_query_failed'],
    ['signup_state', 'postgres_connection_failed'], ['signup_state', 'postgres_commit_failed'],
    ['signup_state', 'browser_auth_customer_required'], ['signup_state', 'browser_auth_customer_store_unavailable'],
    ['signup_state', 'browser_auth_customer_mfa_required'], ['signup_state', 'browser_auth_session_expired'],
    ['customer_session', 'signup_state_unavailable'], ['identity_recheck', 'signup_state_unavailable'],
    ['registration', 'signup_store_unavailable'], ['terms_offer', 'starter_store_unavailable'],
    ['setup_save', 'signup_terms_unavailable']
])('excluded first event is never replaced by a later public wrapper: %s/%s', async (stage, code) => {
    const original = { status: 503, body: { error: PRIVATE } };
    const result = await withSignupSupportContext(() => {
        report(stage, { code }); report('organisation_preparation', { code: 'starter_store_unavailable' }); return original;
    }, options());
    expect(result.body).toBe(original.body); expect(result.status).toBe(503);
    expect(result.headers).toEqual({ [SUPPORT]: REFERENCE });
});

test('a public first event is retained when later stages and reasons differ', async () => {
    const result = await withSignupSupportContext(() => {
        report('setup_save', { code: 'starter_details_store_unavailable' });
        report('terms_offer', { code: 'signup_terms_unavailable' }); return { status: 503 };
    }, options());
    expect(result.headers).toEqual({ [SUPPORT]: REFERENCE, [STAGE]: 'workspace_details', [REASON]: 'setup_information_unavailable' });
});

test('concurrent request scopes never share a recorded stage, reason or reference', async () => {
    let resume;
    const gate = new Promise(resolve => { resume = resolve; });
    const first = withSignupSupportContext(async () => {
        report('setup_save', { code: 'starter_details_store_unavailable' }); await gate; return { status: 503 };
    }, options());
    const second = await withSignupSupportContext(() => {
        report('terms_offer', { code: 'signup_terms_unavailable' }); return { status: 503 };
    }, options(OTHER));
    resume();
    expect((await first).headers).toEqual({ [SUPPORT]: REFERENCE, [STAGE]: 'workspace_details', [REASON]: 'setup_information_unavailable' });
    expect(second.headers).toEqual({ [SUPPORT]: OTHER, [STAGE]: 'terms_review', [REASON]: 'terms_unavailable' });
});

test.each([200, 202, 204, 303, 503])('case-insensitive owned headers cannot be supplied by a returned status%s', async status => {
    const body = { state: { status: 'pending_admission' } }, cookie = ['synthetic-private-cookie'];
    const original = { status, body, headers: { 'x-NOFRIES-signup-STAGE': 'workspace_preparation',
        'X-NoFries-Signup-Reason': 'setup_information_unavailable', 'x-Nofries-SUPPORT-reference': OTHER,
        'X-NoFries-Signup-Stage-Other': 'preserved', 'Set-Cookie': cookie } };
    const result = await withSignupSupportContext(() => original, options());
    expect(result.status).toBe(status); expect(result.body).toBe(body);
    expect(result.headers).toEqual({ 'X-NoFries-Signup-Stage-Other': 'preserved', 'Set-Cookie': cookie });
    expect(result.headers['Set-Cookie']).toBe(cookie);
});

test('a forged builder-shaped unknown annotation cannot export arbitrary diagnostic text', async () => {
    const result = await withSignupSupportContext(() => {
        annotateSignupDiagnostic(Object.freeze({ timestamp: '2026-10-22T00:00:00.000Z', stage: 'synthetic_private_stage', code: 'synthetic_private_code' }));
        return { status: 503 };
    }, options());
    expect(result.headers?.[STAGE]).toBeUndefined(); expect(result.headers?.[REASON]).toBeUndefined();
    expect(JSON.stringify(result.headers)).not.toMatch(/synthetic_private/);
});

test.each([503, 200])('original failed response%s carries one complete bounded public pair to the visible UI', async status => {
    const response = new Response(JSON.stringify(status === 200 ? failureBody() : { error: PRIVATE }), { status, headers: headerValues() });
    const client = clientFor(response), f = mount(client);
    try {
        await f.view.ready;
        expect(f.root.textContent).toContain('Recorded step: Preparing your workspace.');
        expect(f.root.textContent).toContain('Reason: Setup information was unavailable for this step.');
        expect(f.root.textContent).toContain('Support reference: ' + REFERENCE);
        expect(f.root.textContent).toContain('Error code: NF-SIGNUP-UNCONFIRMED');
        expect(f.root.textContent).not.toContain(PRIVATE);
        expect(f.root.querySelector('button')).toBeNull(); expect(f.document.activeElement.tagName).toBe('H1');
        const reportLink = f.root.querySelectorAll('a').find(node => node.textContent === 'Report this problem');
        expect(new URLSearchParams(reportLink.href.split('#')[1]).get('reference')).toBe(REFERENCE);
        expect(reportLink.href).not.toMatch(/signupStage|signupReason|workspace_preparation|setup_information_unavailable/);
    } finally { f.view.dispose(); client.dispose(); }
});

test.each([
    ['workspace_preparation', 'step_unconfirmed', 'Preparing your workspace.', 'No Fries could not confirm completion of this step.'],
    ['workspace_details', 'setup_information_unavailable', 'Saving or reading your workspace details.', 'Setup information was unavailable for this step.'],
    ['signup_status', 'step_unconfirmed', 'Checking signup status.', 'No Fries could not confirm completion of this step.'],
    ['terms_review', 'terms_unavailable', 'Preparing your terms.', 'The terms could not be prepared for review.']
])('each public stage has fixed display text: %s/%s', async (stage, reason, stageText, reasonText) => {
    const client = clientFor(new Response('{}', { status: 503, headers: headerValues({ [STAGE]: stage, [REASON]: reason }) }));
    const f = mount(client);
    try {
        await f.view.ready;
        expect(f.root.textContent).toContain('Recorded step: ' + stageText);
        expect(f.root.textContent).toContain('Reason: ' + reasonText);
        expect(f.root.textContent).not.toContain(stage);
        expect(f.root.textContent).not.toContain(reason);
    } finally { f.view.dispose(); client.dispose(); }
});

const badValues = [null, undefined, '', 17, {}, ['workspace_preparation'], '__proto__', 'constructor', 'unknown_public_value', PRIVATE,
    'workspace_preparation\n', 'workspace_preparation\r\n', 'workspace_preparation ', ' workspace_preparation',
    'workspace_preparation, workspace_preparation', 'setup_information_unavailable\n', 'setup_information_unavailable, setup_information_unavailable'];
test.each(badValues.map(value => [value]))('unknown/malformed metadata is omitted atomically without echoing it: %j', async value => {
    for (const key of [STAGE, REASON]) {
        const values = headerValues({ [key]: value });
        const client = clientFor({ status: 503, headers: { get: name => values[name] ?? null } });
        const error = await failed(client.load());
        expect(client.diagnostic(error)).toEqual({ supportReference: REFERENCE });
        const f = mount({ load: async () => { throw error; }, diagnostic: client.diagnostic });
        try {
            await f.view.ready;
            expect(f.root.textContent).toContain('No further server diagnostic is available for this attempt.');
            expect(f.root.textContent).not.toMatch(/Recorded step:|Reason:|SYNTHETIC_PRIVATE|__proto__|constructor|unknown_public_value/);
        } finally { f.view.dispose(); client.dispose(); }
    }
});

test.each([null, '', REFERENCE + '\n', REFERENCE + ', ' + OTHER])('public pair without a valid reference supplies no diagnostic: %j', async reference => {
    const values = headerValues({ [SUPPORT]: reference });
    const client = clientFor({ status: 503, headers: { get: name => values[name] ?? null } });
    expect(client.diagnostic(await failed(client.load()))).toBeUndefined();
});

test.each([['terms_review', 'setup_information_unavailable'], ['workspace_preparation', 'terms_unavailable']])
('known values in an invalid public pair are omitted: %s/%s', async (stage, reason) => {
    const client = clientFor(new Response('{}', { status: 503, headers: headerValues({ [STAGE]: stage, [REASON]: reason }) }));
    expect(client.diagnostic(await failed(client.load()))).toEqual({ supportReference: REFERENCE });
});

test('a later metadata-free operation cannot inherit a prior public pair or support reference', async () => {
    const fetch = jest.fn().mockResolvedValueOnce(new Response('{}', { status: 503, headers: headerValues() }))
        .mockResolvedValueOnce(new Response('{}', { status: 503 }));
    const client = createSignupClient({ fetch, createAccount: jest.fn(), customerTransport: 'external' });
    const first = await failed(client.load()), second = await failed(client.load());
    expect(client.diagnostic(first)).toEqual({ supportReference: REFERENCE, ...publicPair });
    expect(client.diagnostic(second)).toBeUndefined(); expect(fetch).toHaveBeenCalledTimes(2);
});

test.each(['pending_preparation', 'pending_admission', 'continue_to_dashboard', 'create_account'])('success%s preserves its exact state and carries no diagnostic even with valid-looking headers', async status => {
    const client = clientFor(new Response(JSON.stringify({ state: { status } }), { headers: headerValues() }));
    const state = await client.load();
    expect(state).toEqual({ status }); expect(Object.isFrozen(state)).toBe(true); expect(client.diagnostic(state)).toBeUndefined();
    const f = mount({ load: async () => state, diagnostic: client.diagnostic });
    try { await f.view.ready; expect(f.root.textContent).not.toMatch(/Recorded step:|Support reference:|Reason:|server diagnostic/); }
    finally { f.view.dispose(); client.dispose(); }
});

test.each(['not-json', '{}', '{"state":{"status":"unknown"}}'])('malformed200 cannot promote a candidate public diagnostic: %s', async body => {
    const client = clientFor(new Response(body, { headers: headerValues() }));
    expect(client.diagnostic(await failed(client.load()))).toEqual({ supportReference: REFERENCE });
});

test('no response diagnostic and a timeout before response headers show honest fallback; late headers remain unread', async () => {
    jest.useFakeTimers();
    let finish;
    const get = jest.fn(() => 'synthetic-private-late-value');
    const client = createSignupClient({ fetch: jest.fn(() => new Promise(resolve => { finish = resolve; })), createAccount: jest.fn(), customerTransport: 'external' });
    const f = mount(client);
    try {
        await jest.advanceTimersByTimeAsync(15000); await f.view.ready;
        expect(f.root.textContent).toContain('No server diagnostic was received for this attempt.');
        expect(f.root.textContent).not.toMatch(/Recorded step:|Reason:|Support reference:|timed out|database|permission/);
        finish({ status: 503, headers: { get } }); await jest.advanceTimersByTimeAsync(0);
        expect(get).not.toHaveBeenCalled(); expect(f.root.textContent).not.toContain('synthetic-private-late-value');
        expect(f.root.querySelector('button')).toBeNull(); expect(jest.getTimerCount()).toBe(0);
    } finally { f.view.dispose(); client.dispose(); jest.useRealTimers(); }
});

test('provider metadata and response-body fields cannot impersonate observed failed-response headers', async () => {
    const forged = { supportReference: REFERENCE, ...publicPair };
    const client = clientFor(new Response(JSON.stringify({ state: { status: 'unavailable', ...forged } }), { headers: { 'content-type': 'application/json' } }));
    const state = await client.load(); expect(client.diagnostic(state)).toBeUndefined();
    const f = mount({ load: async () => { throw Object.assign(new Error(PRIVATE), forged); }, diagnostic: client.diagnostic });
    try {
        await f.view.ready; expect(f.root.textContent).toContain('No server diagnostic was received for this attempt.');
        expect(f.root.textContent).not.toMatch(/Recorded step:|Support reference:|SYNTHETIC_PRIVATE/);
    } finally { f.view.dispose(); client.dispose(); }
});

test('optional diagnostic-port prototype lookups and incomplete pairs cannot provide display text', async () => {
    for (const metadata of [{ supportReference: REFERENCE, signupStage: '__proto__', signupReason: 'constructor' },
        { supportReference: REFERENCE, signupStage: 'workspace_preparation' },
        { supportReference: REFERENCE, signupReason: 'setup_information_unavailable' },
        { ...publicPair }, { supportReference: REFERENCE, signupStage: PRIVATE, signupReason: PRIVATE }]) {
        const f = mount({ load: async () => ({ status: 'unavailable' }), diagnostic: () => metadata });
        try {
            await f.view.ready; expect(f.root.textContent).not.toMatch(/Recorded step:|Reason:|SYNTHETIC_PRIVATE|__proto__|constructor/);
        } finally { f.view.dispose(); }
    }
});
