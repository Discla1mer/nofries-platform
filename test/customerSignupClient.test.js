'use strict';
const { createSignupClient } = require('../api/shared/customerSignup/signupClient');
const state = { status: 'terms', termsText: 'Synthetic terms', termsVersion: 'v1', termsDigest: 'a'.repeat(64) };
const token = 'x'.repeat(43);
function response(payload = { state, csrfToken: token }, options = {}) {
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' }, ...options });
}
function setup() {
    const fetch = jest.fn(async () => response()), createAccount = jest.fn(async () => ({ status: 'active' }));
    return { fetch, createAccount, client: createSignupClient({ fetch, createAccount }) };
}
const terms = { termsVersion: 'v1', termsDigest: 'a'.repeat(64), accepted: true };
test('interactive MFA can take a minute, then server refresh retains a fresh 15-second deadline', async () => {
    jest.useFakeTimers();
    try {
        const f = setup(); let finish;
        f.createAccount.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        f.fetch.mockImplementationOnce(() => new Promise(() => {}));
        const result = f.client.createAccount().catch(error => error.message);
        await jest.advanceTimersByTimeAsync(60000);
        expect(f.createAccount.mock.calls[0][0].signal.aborted).toBe(false);
        expect(f.fetch).not.toHaveBeenCalled();
        finish({ status: 'active' }); await jest.advanceTimersByTimeAsync(0);
        expect(f.fetch).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(14999);
        expect(f.fetch.mock.calls[0][1].signal.aborted).toBe(false);
        await jest.advanceTimersByTimeAsync(1);
        expect(await result).toBe('signup_unavailable');
        expect(f.fetch.mock.calls[0][1].signal.aborted).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
});
test('fixed same-origin state request strips provider-only and CSRF fields', async () => {
    const f = setup(); expect(await f.client.load()).toEqual(state);
    expect(f.fetch).toHaveBeenCalledWith('/api/customer-signup/state', expect.objectContaining({
        method: 'GET', mode: 'same-origin', credentials: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'same-origin'
    }));
});
test('terms require loaded CSRF and post only exact consent', async () => {
    const f = setup(); await expect(f.client.acceptTerms(terms)).rejects.toThrow('signup_unavailable');
    expect(f.fetch).not.toHaveBeenCalled(); await f.client.load();
    f.fetch.mockResolvedValueOnce(response({ state: { status: 'pending_admission' } }));
    expect(await f.client.acceptTerms(terms)).toEqual({ status: 'pending_admission' });
    expect(f.fetch).toHaveBeenLastCalledWith('/api/customer-signup/terms', expect.objectContaining({
        method: 'POST', body: JSON.stringify(terms), headers: expect.objectContaining({ 'X-CSRF-Token': token })
    }));
    await expect(f.client.acceptTerms(terms)).rejects.toThrow('signup_unavailable');
});
test('provider return cannot assert identity or access; refresh comes from fixed server endpoint', async () => {
    const f = setup(); expect(await f.client.createAccount()).toEqual(state);
    expect(f.createAccount).toHaveBeenCalledTimes(1); expect(f.fetch).toHaveBeenCalledTimes(1);
});
test.each([null, { state: { status: 'active', url: 'https://evil.invalid' } },
    { state }, { state, csrfToken: 'bad\r\nheader' }, { state: { ...state, termsText: 'x'.repeat(32769) }, csrfToken: token }])('malformed envelope rejects safely: %j', async payload => {
    const f = setup(); f.fetch.mockResolvedValueOnce(response(payload));
    await expect(f.client.load()).rejects.toThrow('signup_unavailable');
});
test.each([400, 401, 403, 429, 500])('HTTP %s is not retried or exposed', async status => {
    const f = setup(); f.fetch.mockResolvedValueOnce(response({ secret: 'private' }, { status }));
    await expect(f.client.load()).rejects.toThrow('signup_unavailable'); expect(f.fetch).toHaveBeenCalledTimes(1);
});
test('HTML, redirects, oversized and invalid UTF8 streams reject', async () => {
    for (const res of [response({}, { headers: { 'content-type': 'text/html' } }),
        { status: 200, redirected: true }, response({ padding: 'x'.repeat(131073) }),
        new Response(new Uint8Array([255]), { headers: { 'content-type': 'application/json' } })]) {
        const f = setup(); f.fetch.mockResolvedValueOnce(res);
        await expect(f.client.load()).rejects.toThrow('signup_unavailable');
    }
});
test.each([{ ...terms, accepted: false }, { ...terms, tenantId: 'not-authority' }, { ...terms, termsDigest: 'bad' }])('invalid consent cannot issue POST', async input => {
    const f = setup(); await f.client.load(); await expect(f.client.acceptTerms(input)).rejects.toThrow('signup_unavailable');
    expect(f.fetch).toHaveBeenCalledTimes(1);
});
test('failed POST clears CSRF and requires reload, not automatic duplicate submission', async () => {
    const f = setup(); await f.client.load(); f.fetch.mockRejectedValueOnce(new Error('private-secret'));
    await expect(f.client.acceptTerms(terms)).rejects.toThrow('signup_unavailable');
    await expect(f.client.acceptTerms(terms)).rejects.toThrow('signup_unavailable'); expect(f.fetch).toHaveBeenCalledTimes(2);
});
test('deadline aborts an ignoring transport and late result cannot restore CSRF', async () => {
    jest.useFakeTimers();
    try {
        const f = setup(); let finish;
        f.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const pending = expect(f.client.load()).rejects.toThrow('signup_unavailable');
        await jest.advanceTimersByTimeAsync(15000); await pending;
        expect(f.fetch.mock.calls[0][1].signal.aborted).toBe(true);
        finish(response()); await Promise.resolve(); await Promise.resolve();
        await expect(f.client.acceptTerms(terms)).rejects.toThrow('signup_unavailable');
        expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
});
test('abort/dispose settles a hung provider without issuing state request', async () => {
    const f = setup(); f.createAccount.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const p = expect(f.client.createAccount({ signal: controller.signal })).rejects.toThrow('signup_unavailable');
    await expect(f.client.load()).rejects.toThrow('signup_unavailable');
    controller.abort(); await p; f.client.dispose();
    await expect(f.client.load()).rejects.toThrow('signup_unavailable'); expect(f.fetch).not.toHaveBeenCalled();
});
test('stream timeout cancels the reader and does not hang', async () => {
    jest.useFakeTimers();
    try {
        const f = setup(), cancel = jest.fn();
        f.fetch.mockResolvedValueOnce({ status: 200, headers: new Headers({ 'content-type': 'application/json' }),
            body: { getReader: () => ({ read: () => new Promise(() => {}), cancel }) } });
        const pending = expect(f.client.load()).rejects.toThrow('signup_unavailable');
        await jest.advanceTimersByTimeAsync(15000); await pending; expect(cancel).toHaveBeenCalled();
    } finally { jest.useRealTimers(); }
});
test('ten-minute provider limit aborts, suppresses late refresh and permits reload', async () => {
    jest.useFakeTimers();
    try {
        const f = setup(); let finish;
        f.createAccount.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const result = f.client.createAccount().catch(error => error.message);
        await jest.advanceTimersByTimeAsync(599999);
        expect(f.createAccount.mock.calls[0][0].signal.aborted).toBe(false);
        await jest.advanceTimersByTimeAsync(1);
        expect(await result).toBe('signup_unavailable');
        expect(f.createAccount.mock.calls[0][0].signal.aborted).toBe(true);
        finish({ status: 'active' }); await jest.advanceTimersByTimeAsync(0);
        expect(f.fetch).not.toHaveBeenCalled();
        await expect(f.client.acceptTerms(terms)).rejects.toThrow('signup_unavailable');
        expect(await f.client.load()).toEqual(state);
        expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
});

test('bound schedule fields survive load and exact consent submission', async () => {
    const f = setup(), scheduled = { ...state, scheduleId: 'schedule-v1',
        scheduleText: 'Synthetic organisation schedule.', scheduleDigest: 'b'.repeat(64) };
    f.fetch.mockResolvedValueOnce(response({ state: scheduled, csrfToken: token }));
    expect(await f.client.load()).toEqual(scheduled);
    const consent = { termsVersion: scheduled.termsVersion, termsDigest: scheduled.termsDigest,
        scheduleId: scheduled.scheduleId, scheduleDigest: scheduled.scheduleDigest, accepted: true };
    f.fetch.mockResolvedValueOnce(response({ state: { status: 'pending_admission' } }));
    expect(await f.client.acceptTerms(consent)).toEqual({ status: 'pending_admission' });
    expect(f.fetch).toHaveBeenLastCalledWith('/api/customer-signup/terms',
        expect.objectContaining({ body: JSON.stringify(consent) }));
});

test('receipt reconciliation requires a fresh server state and one-use CSRF', async () => {
    const f = setup();
    f.fetch.mockResolvedValueOnce(response({ state: { status: 'resume_acceptance' }, csrfToken: token }));
    expect(await f.client.load()).toEqual({ status: 'resume_acceptance' });
    f.fetch.mockResolvedValueOnce(response({ state: { status: 'pending_admission' } }));
    expect(await f.client.resumeAcceptance()).toEqual({ status: 'pending_admission' });
    expect(f.fetch).toHaveBeenLastCalledWith('/api/customer-signup/terms',
        expect.objectContaining({ body: JSON.stringify({ resume: true }),
            headers: expect.objectContaining({ 'X-CSRF-Token': token }) }));
    await expect(f.client.resumeAcceptance()).rejects.toThrow('signup_unavailable');
});


test.each(['company', 'consultant'])('preserves only the server-approved %s destination discriminator', async accountType => {
    const f = setup(); f.fetch.mockResolvedValueOnce(response({ state: {
        status: 'continue_to_dashboard', accountType, destination: 'https://foreign.invalid'
    } }));
    expect(await f.client.load()).toEqual({ status: 'continue_to_dashboard', accountType });
});
test.each(['staff', null, {}, 'Consultant'])('rejects invalid completion account type %p', async accountType => {
    const f = setup(); f.fetch.mockResolvedValueOnce(response({ state: { status: 'continue_to_dashboard', accountType } }));
    await expect(f.client.load()).rejects.toThrow('signup_unavailable');
});

const reservation = { accountType: 'consultant', organisationName: 'Synthetic retained workspace' };
const savedSetup = { status: 'resume_setup', email: 'synthetic@example.test', ...reservation };
const reservedSetup = { status: 'setup_details', email: savedSetup.email, reservation };
function external(payload = { state: savedSetup, csrfToken: token }) {
    const fetch = jest.fn(async () => response(payload)), createAccount = jest.fn();
    return { fetch, createAccount, client: createSignupClient({ fetch, createAccount, customerTransport: 'external' }) };
}

test.each([savedSetup, reservedSetup])('retained external setup loads as a bounded frozen projection without a mutation: %s', async current => {
    const f = external({ state: current, csrfToken: token }), loaded = await f.client.load();
    expect(loaded).toEqual(current); expect(Object.isFrozen(loaded)).toBe(true);
    if (current.reservation) expect(Object.isFrozen(loaded.reservation)).toBe(true);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.fetch.mock.calls[0]).toEqual(['/api/external-customer-signup/state', expect.objectContaining({ method: 'GET' })]);
    expect(f.createAccount).not.toHaveBeenCalled();
});

test('explicit setup resume submits only resume:true with consumed CSRF', async () => {
    const f = external(); await f.client.load();
    f.fetch.mockResolvedValueOnce(response({ state: { status: 'continue_authentication' } }));
    expect(await f.client.completeSetup({ resume: true })).toEqual({ status: 'continue_authentication' });
    expect(f.fetch).toHaveBeenLastCalledWith('/api/external-customer-signup/setup', expect.objectContaining({ method: 'POST',
        body: '{"resume":true}', headers: expect.objectContaining({ 'X-CSRF-Token': token }) }));
    await expect(f.client.completeSetup({ resume: true })).rejects.toThrow('signup_unavailable');
    expect(f.fetch).toHaveBeenCalledTimes(2); expect(f.createAccount).not.toHaveBeenCalled();
});

test.each([{ resume: false }, { resume: 'true' }, { resume: true, details: {} }, { resume: true, organisationName: 'Replacement' }])(
    'resume cannot carry replacement details into a POST: %j', async input => {
        const f = external(); await f.client.load();
        await expect(f.client.completeSetup(input)).rejects.toThrow('signup_unavailable');
        expect(f.fetch).toHaveBeenCalledTimes(1);
    });

test.each([
    { state: savedSetup }, { state: { ...savedSetup, accountType: 'staff' }, csrfToken: token },
    { state: { ...savedSetup, email: savedSetup.email + '\n' }, csrfToken: token },
    { state: { ...savedSetup, organisationName: 'x'.repeat(121) }, csrfToken: token },
    { state: { ...savedSetup, organisationName: ' Untrimmed' }, csrfToken: token },
    { state: { ...savedSetup, organisationName: 'Synthetic\nname' }, csrfToken: token },
    { state: { ...savedSetup, details: { private: 'not-public' } }, csrfToken: token },
    { state: reservedSetup, csrfToken: token, customerId: 'untrusted' },
    { state: { ...reservedSetup, reservation: null }, csrfToken: token },
    { state: { ...reservedSetup, reservation: { ...reservation, subjectKey: 'forged' } }, csrfToken: token },
    { state: { ...reservedSetup, reservation: { accountType: 'company' } }, csrfToken: token }
])('malformed saved setup cannot enable resumption %#', async payload => {
    const f = external(payload); await expect(f.client.load()).rejects.toThrow('signup_unavailable');
    await expect(f.client.completeSetup({ resume: true })).rejects.toThrow('signup_unavailable');
    expect(f.fetch).toHaveBeenCalledTimes(1);
});

test.each([savedSetup, reservedSetup])('legacy transport cannot use the external recovery state %s', async current => {
    const f = setup(); f.fetch.mockResolvedValueOnce(response({ state: current, csrfToken: token }));
    await expect(f.client.load()).rejects.toThrow('signup_unavailable'); expect(f.createAccount).not.toHaveBeenCalled();
});

const signInError = { error: 'Signup is unavailable', code: 'signup_signin_required' };
test('only confirmed external JSON401 becomes sign-in-required, clearing mutation authority without retry', async () => {
    const f = external(); await f.client.load();
    f.fetch.mockResolvedValueOnce(response(signInError, { status: 401 }));
    expect(await f.client.completeSetup({ resume: true })).toEqual({ status: 'signin_required' });
    await expect(f.client.completeSetup({ resume: true })).rejects.toThrow('signup_unavailable');
    expect(f.fetch).toHaveBeenCalledTimes(2); expect(f.createAccount).not.toHaveBeenCalled();
    f.fetch.mockResolvedValueOnce(response({ state: savedSetup, csrfToken: token }));
    expect(await f.client.load()).toEqual(savedSetup);
});

test.each([
    [{ error: 'private-provider-error', code: 'signup_signin_required' }, 401],
    [{ ...signInError, token: 'synthetic-private-value' }, 401], [{ error: 'Signup is unavailable', code: 'signup_unavailable' }, 401],
    [signInError, 403], [{ state: { status: 'signin_required' } }, 200]
])('generic failures or forged successful states cannot claim sign-in-required %#', async (payload, status) => {
    const f = external(); f.fetch.mockResolvedValueOnce(response(payload, { status }));
    await expect(f.client.load()).rejects.toThrow('signup_unavailable');
    expect(f.fetch).toHaveBeenCalledTimes(1); expect(f.createAccount).not.toHaveBeenCalled();
});

test('confirmed401 still requires a bounded nonredirect JSON response', async () => {
    const redirected = response(signInError, { status: 401 }); Object.defineProperty(redirected, 'redirected', { value: true });
    for (const result of [redirected, response(signInError, { status: 401, headers: { 'content-type': 'text/html' } }),
        response({ ...signInError, padding: 'x'.repeat(131073) }, { status: 401 }),
        new Response(new Uint8Array([255]), { status: 401, headers: { 'content-type': 'application/json' } })]) {
        const f = external(); f.fetch.mockResolvedValueOnce(result);
        await expect(f.client.load()).rejects.toThrow('signup_unavailable'); expect(f.fetch).toHaveBeenCalledTimes(1);
    }
});

test('an ambiguous setup result must be observed again before another explicit resume', async () => {
    const f = external(); await f.client.load(); f.fetch.mockRejectedValueOnce(new Error('synthetic-private-provider-error'));
    await expect(f.client.completeSetup({ resume: true })).rejects.toThrow('signup_unavailable');
    await expect(f.client.completeSetup({ resume: true })).rejects.toThrow('signup_unavailable');
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(await f.client.load()).toEqual(savedSetup);
    expect(f.fetch.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'POST', 'GET']);
    expect(f.createAccount).not.toHaveBeenCalled();
});

const readOnlySetup = {status:'setup_read_only'};
test.each(['legacy','external'])('closed read-only setup state is returned frozen without retaining write CSRF (%s)',async transport=>{
    const f=transport==='external'?external():setup();
    await f.client.load();f.fetch.mockResolvedValueOnce(response({state:readOnlySetup}));
    const result=await f.client.load();expect(result).toEqual(readOnlySetup);expect(Object.isFrozen(result)).toBe(true);
    await expect(f.client.acceptTerms(terms)).rejects.toThrow('signup_unavailable');
    await expect(f.client.resumeAcceptance()).rejects.toThrow('signup_unavailable');
    if(transport==='external'){
        await expect(f.client.completeSetup({resume:true})).rejects.toThrow('signup_unavailable');
        await expect(f.client.completeSetup({accountType:'consultant',organisationName:'Saved',details:{}})).rejects.toThrow('signup_unavailable');
    }
    expect(f.fetch).toHaveBeenCalledTimes(2);expect(f.fetch.mock.calls.every(([,init])=>init.method==='GET')).toBe(true);
});
test('a deliberate write returning read-only clears the consumed token and cannot repeat the lifecycle action',async()=>{
    const f=external();await f.client.load();f.fetch.mockResolvedValueOnce(response({state:readOnlySetup}));
    expect(await f.client.completeSetup({resume:true})).toEqual(readOnlySetup);
    await expect(f.client.completeSetup({resume:true})).rejects.toThrow('signup_unavailable');
    await expect(f.client.acceptTerms(terms)).rejects.toThrow('signup_unavailable');
    await expect(f.client.resumeAcceptance()).rejects.toThrow('signup_unavailable');
    expect(f.fetch).toHaveBeenCalledTimes(2);expect(f.fetch.mock.calls.filter(([,init])=>init.method==='POST')).toHaveLength(1);
});
test.each([
    {state:readOnlySetup,csrfToken:token}, {state:readOnlySetup,csrfToken:null}, {state:readOnlySetup,csrfToken:'short'},
    {state:readOnlySetup,csrfToken:token,subjectKey:'foreign'},
    {state:{...readOnlySetup,accountType:'consultant'},csrfToken:token},
    {state:{...readOnlySetup,tenantId:'foreign'},csrfToken:token},
    {state:{...readOnlySetup,readOnly:true},csrfToken:token},
    {state:{...readOnlySetup,csrfToken:token},csrfToken:token},
    {state:{...readOnlySetup,termsDigest:'a'.repeat(64)},csrfToken:token},
    {state:readOnlySetup,csrfToken:'x'.repeat(129)}
])('malformed read-only setup envelope %# withholds state and write token',async payload=>{
    const f=external();await f.client.load();f.fetch.mockResolvedValueOnce(response(payload));
    await expect(f.client.load()).rejects.toThrow('signup_unavailable');
    await expect(f.client.completeSetup({resume:true})).rejects.toThrow('signup_unavailable');
    await expect(f.client.resumeAcceptance()).rejects.toThrow('signup_unavailable');
    expect(f.fetch).toHaveBeenCalledTimes(2);
});
test('read-only response does not prevent a later fresh normal state from authorising one deliberate action',async()=>{
    const f=external({state:readOnlySetup});expect(await f.client.load()).toEqual(readOnlySetup);
    await expect(f.client.completeSetup({resume:true})).rejects.toThrow('signup_unavailable');
    f.fetch.mockResolvedValueOnce(response({state:savedSetup,csrfToken:token}));await f.client.load();
    f.fetch.mockResolvedValueOnce(response({state:{status:'continue_authentication'}}));
    expect(await f.client.completeSetup({resume:true})).toEqual({status:'continue_authentication'});
    expect(f.fetch.mock.calls.filter(([,init])=>init.method==='POST')).toHaveLength(1);
});
