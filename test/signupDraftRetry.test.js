'use strict';

const { createDom } = require('./fixtures/dashboardDom');
const { mountSignupJourney } = require('../api/shared/customerSignup/signupJourney');
const { createSignupClient } = require('../api/shared/customerSignup/signupClient');

const initial = { status: 'setup_details', email: 'synthetic@example.test' };
const reserved = { ...initial, reservation: { accountType: 'consultant', organisationName: 'Saved consultancy' } };
const text = { organisationName: '  Synthetic consultancy  ', name: '  Synthetic owner  ',
    role: 'Director', address: 'Synthetic address', registrationId: '9429000000000' };
const response = (state, token = 'a', status = 200) => new Response(JSON.stringify(status === 401
    ? { error: 'Signup is unavailable', code: 'signup_signin_required' }
    : { state, csrfToken: token.repeat(43) }), { status, headers: { 'content-type': 'application/json' } });
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(setImmediate); };

async function fixture(state = initial, wrap = client => client) {
    const dom = createDom(), fetch = jest.fn().mockResolvedValueOnce(response(state));
    // Native text inputs begin empty; this minimal DOM otherwise leaves value
    // undefined, which cannot exercise a fresh blank form's real validation.
    const create = dom.document.createElement;
    dom.document.createElement = tag => Object.assign(create(tag), tag === 'input' ? { value: '' } : {});
    let transport, client, view;
    const mount = () => {
        transport = createSignupClient({ fetch, customerTransport: 'external', createAccount: jest.fn() });
        client = wrap(transport);
        view = mountSignupJourney(dom.root, client, { customerTransport: 'external' });
        return view;
    };
    await mount().ready;
    const fields = () => Object.fromEntries(dom.root.querySelector('form').querySelectorAll('input').map(node => [node.name, node]));
    const form = () => {
        const node = dom.root.querySelector('form');
        node.reportValidity = () => fields().authorityConfirmed.checked && Object.entries(fields())
            .every(([name, input]) => !input.required || name === 'authorityConfirmed' || !!input.value);
        return node;
    };
    const fill = () => {
        const inputs = fields();
        dom.root.querySelector('select').value = 'consultant';
        for (const [name, value] of Object.entries(text)) if (!inputs[name].disabled) inputs[name].value = value;
        inputs.authorityConfirmed.checked = true;
    };
    const submit = async () => { for (const fn of form().events.submit) fn({ preventDefault() {} }); await settle(); };
    // A deliberate fresh page/navigation has a new view and client. It never
    // brings the private mount's unconfirmed text or prior CSRF material back.
    const navigate = async result => {
        view.dispose(); transport.dispose();
        if (result) fetch.mockResolvedValueOnce(result);
        const fresh = mount(); await fresh.ready; await settle();
    };
    const failSubmit = async () => { fill(); fetch.mockRejectedValueOnce(new TypeError('synthetic lost connection')); await submit(); };
    const close = () => { view.dispose(); transport.dispose(); };
    return { ...dom, fetch, get transport() { return transport; }, get client() { return client; }, get view() { return view; }, fields, fill, submit, navigate, failSubmit, close };
}

test.each([initial, reserved])('fresh navigation discards private text and requires fresh CSRF and authority (%j)', async state => {
    const f = await fixture(state);
    try {
        const staleForm = f.root.querySelector('form');
        await f.failSubmit();
        expect(f.root.querySelector('h1').textContent).toBe('Signup is unavailable');
        expect(f.root.querySelector('button')).toBeNull();
        expect(f.root.textContent).toContain('Error code: NF-SIGNUP-UNCONFIRMED');
        expect(f.root.textContent).not.toContain(text.name);
        await f.navigate(response(state, 'b'));
        const fields = f.fields();
        for (const name of Object.keys(text)) expect(fields[name].value || '').toBe(
            name === 'organisationName' && state.reservation ? state.reservation.organisationName : '');
        if (state.reservation) expect(f.root.querySelector('select').value).toBe('consultant');
        expect(!!fields.organisationName.disabled).toBe(!!state.reservation);
        expect(!!f.root.querySelector('select').disabled).toBe(!!state.reservation);
        expect(!!fields.authorityConfirmed.checked).toBe(false);
        expect(f.document.activeElement.tagName).toBe('H1');
        expect(f.root.getAttribute('aria-busy')).toBe('false');
        expect(f.fetch.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'POST', 'GET']);
        await f.submit(); // Fresh authority is required; this must not issue a request.
        expect(f.fetch).toHaveBeenCalledTimes(3);
        for (const handler of staleForm.events.submit) handler({ preventDefault() {} });
        expect(f.fetch).toHaveBeenCalledTimes(3);
        f.fill(); fields.name.value = 'Freshly entered owner';
        f.fetch.mockResolvedValueOnce(response({ status: 'continue_authentication' }));
        await f.submit();
        expect(f.fetch).toHaveBeenCalledTimes(4);
        const [, first] = f.fetch.mock.calls[1], [, second] = f.fetch.mock.calls[3];
        expect(first.headers['X-CSRF-Token']).toBe('a'.repeat(43));
        expect(second.headers['X-CSRF-Token']).toBe('b'.repeat(43));
        expect(JSON.parse(second.body)).toEqual({ accountType: 'consultant',
            organisationName: state.reservation?.organisationName || text.organisationName.trim(),
            details: { name: 'Freshly entered owner', role: text.role, address: text.address, registrationId: text.registrationId, authorityConfirmed: true } });
    } finally { f.close(); }
});

test('repeated fresh navigations after rejection or unavailable discard the draft without repeating POST', async () => {
    const f = await fixture();
    try {
        await f.failSubmit();
        f.fetch.mockRejectedValueOnce(new Error('synthetic read failure'));
        await f.navigate();
        expect(f.root.querySelector('button')).toBeNull();
        expect(f.root.textContent).toContain('NF-SIGNUP-UNCONFIRMED');
        await f.navigate(response({ status: 'unavailable' }));
        expect(f.root.querySelector('button')).toBeNull();
        await f.navigate(response(initial, 'c'));
        expect(f.fields().name.value || '').toBe('');
        expect(f.fetch.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
    } finally { f.close(); }
});

test.each([
    [initial, { ...initial, email: 'different@example.test' }],
    [initial, { ...initial, email: 'Synthetic@example.test' }],
    [initial, reserved], [reserved, initial],
    [reserved, { ...reserved, reservation: { ...reserved.reservation, organisationName: 'Different consultancy' } }],
    [reserved, { ...reserved, reservation: { ...reserved.reservation, accountType: 'company' } }]
])('fresh navigation cannot carry a private draft into another setup binding (%j -> %j)', async (before, after) => {
    const f = await fixture(before);
    try {
        await f.failSubmit(); await f.navigate(response(after));
        expect(f.fields().name.value || '').toBe('');
        if (after.reservation) expect(f.fields().organisationName.value).toBe(after.reservation.organisationName);
    } finally { f.close(); }
});

test.each([
    { status: 'resume_setup', email: initial.email, accountType: 'consultant', organisationName: 'Saved consultancy' },
    { status: 'signin_required' }, { status: 'continue_authentication' },
    { status: 'create_account' }, { status: 'pending_admission' },
    { status: 'terms', termsText: 'Synthetic agreement', termsVersion: 'v1', termsDigest: 'a'.repeat(64) }
])('concrete non-editable state discards the draft (%j)', async next => {
    let later;
    const f = await fixture(initial, transport => ({ ...transport, load: async options => later === undefined ? transport.load(options) : later }));
    try {
        await f.failSubmit(); later = next;
        // Override only this observation to cover every view state, including
        // typed session loss, without altering the real transport recovery tests.
        await f.navigate();
        expect(f.root.textContent).not.toContain(text.name);
        if (next.status === 'terms') expect(f.root.querySelector('input').checked).toBe(false);
        if (next.status === 'signin_required') expect(f.root.querySelector('form')).toBeNull();
    } finally { f.close(); }
});

test('typed 401 session loss clears the form without another setup POST', async () => {
    const f = await fixture();
    try {
        await f.failSubmit(); await f.navigate(response(null, 'a', 401));
        expect(f.root.querySelector('h1').textContent).toBe('Sign in again');
        expect(f.root.querySelector('input')).toBeNull();
        expect(f.fetch.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'POST', 'GET']);
    } finally { f.close(); }
});

test('a POST-returned editable state cannot restore the draft', async () => {
    const f = await fixture();
    try {
        f.fill(); f.fetch.mockResolvedValueOnce(response(initial, 'b')); await f.submit();
        expect(f.fields().name.value || '').toBe('');
        expect(!!f.fields().authorityConfirmed.checked).toBe(false);
        expect(f.fetch).toHaveBeenCalledTimes(2);
    } finally { f.close(); }
});

test('fresh navigation requires new explicit edits and never restores either failed submission', async () => {
    const f = await fixture();
    try {
        await f.failSubmit(); await f.navigate(response(initial, 'b'));
        expect(f.fields().name.value || '').toBe('');
        // Only a fresh deliberate entry/consent can submit; old text is gone.
        f.fill(); f.fields().name.value = 'Updated owner';
        f.fetch.mockResolvedValueOnce(response({ status: 'unavailable' })); await f.submit();
        await f.navigate(response(initial, 'c'));
        expect(f.fields().name.value || '').toBe('');
        expect(!!f.fields().authorityConfirmed.checked).toBe(false);
        expect(f.fetch.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(2);
    } finally { f.close(); }
});

test.each([null, { status: 'unexpected' }, { ...initial, reservation: null },
    { ...initial, email: 'not-an-email' }, { ...initial, untrusted: 'extra' }])(
    'concrete malformed view state clears draft before a later matching read (%j)', async malformed => {
        let override = false;
        const f = await fixture(initial, transport => ({ ...transport, load: options => override
            ? Promise.resolve(malformed) : transport.load(options) }));
        try {
            await f.failSubmit(); override = true;
            await f.navigate();
            expect(f.root.querySelector('h1').textContent).toBe('Signup is unavailable');
            expect(f.root.querySelector('button')).toBeNull();
            override = false; await f.navigate(response(initial, 'b'));
            expect(f.fields().name.value || '').toBe('');
            expect(!!f.fields().authorityConfirmed.checked).toBe(false);
        } finally { f.close(); }
    });

test('dispose ignores a late successful fresh-navigation observation and no mount receives the old draft', async () => {
    const f = await fixture();
    try {
        await f.failSubmit(); let finish;
        f.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const pendingNavigation = f.navigate(); await settle();
        f.view.dispose(); f.transport.dispose();
        finish(response(initial, 'b')); await pendingNavigation; await settle();
        expect(f.root.children).toHaveLength(0);
        await f.navigate(response(initial, 'c'));
        expect(f.fields().name.value || '').toBe('');
        expect(!!f.fields().authorityConfirmed.checked).toBe(false);
        expect(f.fetch.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
    } finally { f.close(); }
});
