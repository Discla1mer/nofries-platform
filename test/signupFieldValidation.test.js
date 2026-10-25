'use strict';

const { createDom } = require('./fixtures/dashboardDom');
const { mountSignupJourney } = require('../api/shared/customerSignup/signupJourney');
const { createSignupClient } = require('../api/shared/customerSignup/signupClient');
const { createCustomerSignupRuntime, customerSignupErrorResponse } = require('../api/shared/customerSignup/customerSignupRuntime');
const { starterRepresentativeDetails } = require('../api/shared/customerSignup/starterSetupDetails');
const { starterSetupSnapshot } = require('../api/shared/customerSignup/managedSignupProof');

const initial = { status: 'setup_details', email: 'synthetic@example.test' };
const text = { organisationName: '  Synthetic consultancy  ', name: '  Synthetic owner  ',
    role: '  Director  ', address: '  Synthetic address  ', registrationId: '  Synthetic-NZBN  ' };
const messages = { organisationName: 'Enter your company or consultancy name.', name: 'Enter your name.',
    role: 'Enter your role.', address: 'Enter your business address.', registrationId: 'Enter your NZBN, or leave this field empty.' };
const response = (state, token = 'a') => new Response(JSON.stringify({ state, csrfToken: token.repeat(43) }),
    { status: 200, headers: { 'content-type': 'application/json' } });
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate); };

async function fixture(state = initial, accountType = 'consultant', optionalDefault = false, suppliedFetch) {
    const dom = createDom(), create = dom.document.createElement;
    dom.document.createElement = tag => {
        const node = create(tag);
        if (tag === 'input') { node.value = ''; node.checked = false; }
        return node;
    };
    const fetch = suppliedFetch || jest.fn().mockResolvedValueOnce(response(state));
    let client = createSignupClient({ fetch, customerTransport: 'external', createAccount: jest.fn() });
    let view = mountSignupJourney(dom.root, client, { customerTransport: 'external' });
    await view.ready;
    const fields = () => Object.fromEntries(dom.root.querySelector('form').querySelectorAll('input').map(node => [node.name, node]));
    const form = () => {
        const node = dom.root.querySelector('form');
        if (!node.reportValidity) {
            // Deterministic model only: native required accepts whitespace.
            // Actual browser validity, focus and AX are verified separately.
            node.reportValidity = jest.fn(() => {
                const invalid = node.querySelectorAll('input').find(input => !input.disabled &&
                    (input.validationMessage || input.required && (input.type === 'checkbox' ? !input.checked : input.value === '')));
                if (invalid) invalid.focus();
                return !invalid;
            });
        }
        return node;
    };
    const fill = () => {
        dom.root.querySelector('select').value = state.reservation?.accountType || accountType;
        for (const [name, value] of Object.entries(text)) {
            if (!fields()[name].disabled && !(name === 'registrationId' && optionalDefault)) fields()[name].value = value;
        }
        fields().authorityConfirmed.checked = true;
    };
    const input = (name, value) => {
        const node = fields()[name]; node.value = value;
        for (const handler of node.events.input || []) handler({ currentTarget: node });
    };
    const submit = async (node = form()) => {
        for (const handler of node.events.submit) handler({ preventDefault() {} });
        await settle();
    };
    const navigate = async result => {
        view.dispose(); client.dispose();
        fetch.mockResolvedValueOnce(result);
        client = createSignupClient({ fetch, customerTransport: 'external', createAccount: jest.fn() });
        view = mountSignupJourney(dom.root, client, { customerTransport: 'external' });
        await view.ready; await settle();
    };
    const close = () => { view.dispose(); client.dispose(); };
    fill();
    return { ...dom, fetch, get client() { return client; }, get view() { return view; }, fields, form, fill, input, submit, navigate, close };
}

test.each(Object.keys(text).flatMap(name => ['   ', '\u00a0\u00a0'].map(value => [name, value])))(
    'submit identifies whitespace-only %s (%j) at its field without making a request', async (name, value) => {
        const f = await fixture();
        try {
            const form = f.form(); f.fields()[name].value = value;
            await f.submit();
            expect(f.fetch.mock.calls.map(([, options]) => options.method)).toEqual(['GET']);
            expect(f.fields()[name].validationMessage).toBe(messages[name]);
            expect(f.document.activeElement).toBe(f.fields()[name]);
            expect(f.root.querySelector('form')).toBe(form);
            expect(f.root.querySelector('h1').textContent).toBe('Set up your workspace');
            expect(f.fields().authorityConfirmed.checked).toBe(true);
            expect(f.root.getAttribute('aria-busy')).toBe('false');
        } finally { f.close(); }
    });

test.each(Object.keys(text))('input recomputes the %s error and correction permits one deliberate submission', async name => {
    const f = await fixture();
    try {
        f.input(name, '\u00a0 ');
        expect(f.fields()[name].validationMessage).toBe(messages[name]);
        expect(f.fetch).toHaveBeenCalledTimes(1);
        f.input(name, text[name]);
        expect(f.fields()[name].validationMessage).toBe('');
        expect(f.fetch).toHaveBeenCalledTimes(1);
        f.fetch.mockResolvedValueOnce(response({ status: 'continue_authentication' }));
        await f.submit();
        expect(f.fetch.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'POST']);
        const payload = JSON.parse(f.fetch.mock.calls[1][1].body);
        expect(payload.details[name] ?? payload.organisationName).toBe(name === 'organisationName' ? text[name].trim() : text[name]);
    } finally { f.close(); }
});

test.each(['organisationName', 'name', 'role', 'address'])('empty required %s retains native required validation', async name => {
    const f = await fixture();
    try {
        f.input(name, '   '); expect(f.fields()[name].validationMessage).toBe(messages[name]);
        f.input(name, ''); expect(f.fields()[name].validationMessage).toBe('');
        await f.submit();
        expect(f.document.activeElement).toBe(f.fields()[name]);
        expect(f.fields()[name].required).toBe(true);
        expect(f.fetch).toHaveBeenCalledTimes(1);
    } finally { f.close(); }
});

test('clearing optional NZBN removes its custom error and empty NZBN remains valid', async () => {
    const f = await fixture();
    try {
        f.input('registrationId', '   ');
        expect(f.fields().registrationId.validationMessage).toBe(messages.registrationId);
        f.input('registrationId', '');
        expect(f.fields().registrationId.validationMessage).toBe('');
        expect(f.fields().registrationId.required).toBe(false);
        f.fetch.mockResolvedValueOnce(response({ status: 'continue_authentication' })); await f.submit();
        expect(f.fetch).toHaveBeenCalledTimes(2);
        expect(JSON.parse(f.fetch.mock.calls[1][1].body).details.registrationId).toBe('');
    } finally { f.close(); }
});

test('an untouched optional NZBN retains its native empty default and permits submission', async () => {
    const f = await fixture(initial, 'company', true);
    try {
        expect(f.fields().registrationId.value).toBe('');
        expect(f.fields().registrationId.required).toBe(false);
        f.fetch.mockResolvedValueOnce(response({ status: 'continue_authentication' })); await f.submit();
        expect(f.fetch).toHaveBeenCalledTimes(2);
        expect(JSON.parse(f.fetch.mock.calls[1][1].body).details.registrationId).toBe('');
    } finally { f.close(); }
});

test.each(['company', 'consultant'])('meaningful padded values retain the existing %s payload and consent', async accountType => {
    const f = await fixture(initial, accountType);
    try {
        f.fetch.mockResolvedValueOnce(response({ status: 'continue_authentication' })); await f.submit();
        expect(JSON.parse(f.fetch.mock.calls[1][1].body)).toEqual({ accountType, organisationName: text.organisationName.trim(),
            details: { name: text.name, role: text.role, address: text.address, registrationId: text.registrationId, authorityConfirmed: true } });
    } finally { f.close(); }
});

test('reserved controls remain locked, are not validated and submit their captured canonical values', async () => {
    const reservation = { accountType: 'company', organisationName: 'Saved company' };
    const f = await fixture({ ...initial, reservation });
    try {
        const organisation = f.fields().organisationName;
        organisation.setCustomValidity = jest.fn(organisation.setCustomValidity.bind(organisation));
        f.input('organisationName', '   '); // Even an altered disabled DOM value cannot replace server data.
        f.root.querySelector('select').value = 'consultant';
        f.fetch.mockResolvedValueOnce(response({ status: 'continue_authentication' })); await f.submit();
        expect(organisation.setCustomValidity).not.toHaveBeenCalled();
        expect(organisation.disabled).toBe(true);
        expect(JSON.parse(f.fetch.mock.calls[1][1].body)).toMatchObject(reservation);
    } finally { f.close(); }
});

test('the form focuses the first invalid field and preserves the native authority check', async () => {
    const f = await fixture();
    try {
        f.fields().organisationName.value = '   '; f.fields().name.value = '   ';
        await f.submit(); expect(f.document.activeElement).toBe(f.fields().organisationName);
        f.input('organisationName', text.organisationName);
        await f.submit(); expect(f.document.activeElement).toBe(f.fields().name);
        f.input('name', text.name); f.fields().authorityConfirmed.checked = false;
        await f.submit(); expect(f.document.activeElement).toBe(f.fields().authorityConfirmed);
        expect(f.fields().authorityConfirmed.validationMessage).toBeUndefined();
        expect(f.fetch).toHaveBeenCalledTimes(1);
    } finally { f.close(); }
});

test('busy and stale submit handlers cannot validate or submit another request', async () => {
    const f = await fixture();
    try {
        const form = f.form(), name = f.fields().name; let finish;
        f.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        await f.submit(form);
        const validations = form.reportValidity.mock.calls.length;
        await f.submit(form);
        expect(form.reportValidity).toHaveBeenCalledTimes(validations);
        expect(f.fetch).toHaveBeenCalledTimes(2);
        finish(response({ status: 'continue_authentication' })); await settle();
        name.disabled = false; name.value = '   ';
        await f.submit(form);
        expect(form.reportValidity).toHaveBeenCalledTimes(validations);
        expect(name.validationMessage || '').toBe('');
        expect(f.fetch).toHaveBeenCalledTimes(2);
    } finally { f.close(); }
});

test('fresh navigation discards private text and still stops a new invalid value before POST', async () => {
    const f = await fixture();
    try {
        const stale = f.form();
        f.fetch.mockRejectedValueOnce(new TypeError('synthetic lost connection')); await f.submit();
        expect(f.root.querySelector('h1').textContent).toBe('Signup is unavailable');
        expect(f.root.querySelector('button')).toBeNull();
        expect(f.root.textContent).toContain('Error code: NF-SIGNUP-UNCONFIRMED');
        await f.navigate(response(initial, 'b'));
        for (const name of Object.keys(text)) expect(f.fields()[name].value).toBe('');
        expect(f.fields().authorityConfirmed.checked).toBe(false);
        await f.submit(stale);
        expect(f.fetch.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'POST', 'GET']);
        f.fill(); f.input('name', 'Freshly entered owner');
        f.fields().authorityConfirmed.checked = false; await f.submit();
        expect(f.document.activeElement).toBe(f.fields().authorityConfirmed);
        expect(f.fetch).toHaveBeenCalledTimes(3);
        f.fields().authorityConfirmed.checked = true;
        f.fields().role.value = '   '; await f.submit();
        expect(f.document.activeElement).toBe(f.fields().role);
        expect(f.fetch.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'POST', 'GET']);
        f.input('role', text.role);
        f.fetch.mockResolvedValueOnce(response({ status: 'continue_authentication' })); await f.submit();
        expect(f.fetch.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'POST', 'GET', 'POST']);
        expect(f.fetch.mock.calls[3][1].headers['X-CSRF-Token']).toBe('b'.repeat(43));
        expect(JSON.parse(f.fetch.mock.calls[3][1].body).details).toMatchObject({ name: 'Freshly entered owner', authorityConfirmed: true });
    } finally { f.close(); }
});

const textLabels = { organisationName: 'Company or consultancy name', name: 'Your name', role: 'Your role',
    address: 'Business address', registrationId: 'NZBN (optional)' };
const characterMessage = name => textLabels[name] + ': remove <, > and hidden control characters.';
const serverProof = organisationName => starterSetupSnapshot({ schemaVersion: 1, source: 'external-id-signup',
    requestId: '10000000-0000-4000-8000-000000000001',
    subjectKey: '10000000-0000-4000-8000-000000000002:10000000-0000-4000-8000-000000000003',
    providerKey: 'a'.repeat(64), authenticationSha256: 'b'.repeat(64), email: initial.email,
    accountType: 'consultant', organisationName, createdAt: 1000, verifiedAt: 1000, expiresAt: 2000 },
'10000000-0000-4000-8000-000000000001');
function serverText(name, value) {
    if (name === 'organisationName') return serverProof(value.trim().normalize('NFC'));
    return starterRepresentativeDetails({ name: 'Synthetic Owner', role: 'Director', address: 'Synthetic address',
        registrationId: '', authorityConfirmed: true, [name]: value });
}

test.each(Object.keys(text).flatMap(name => ['<Director>', 'A > B', 'A\u0001B', 'A\u007fB', 'A\u0085B'].map(value => [name, value])))(
    'existing server-rejected text in %s (%j) identifies its field and makes no POST', async (name, value) => {
        expect(() => serverText(name, value)).toThrow();
        const f = await fixture();
        try {
            const form = f.form(); f.fields()[name].value = value;
            await f.submit();
            expect(f.fetch.mock.calls.map(([, options]) => options.method)).toEqual(['GET']);
            expect(f.root.querySelector('form')).toBe(form);
            expect(f.fields()[name].value).toBe(value);
            expect(f.fields()[name].validationMessage).toBe(characterMessage(name));
            expect(f.document.activeElement).toBe(f.fields()[name]);
            expect(f.fields().authorityConfirmed.checked).toBe(true);
        } finally { f.close(); }
    });

test.each(Object.keys(text))('correcting unsupported %s text clears native feedback without submitting automatically', async name => {
    const f = await fixture();
    try {
        f.input(name, 'A\u0085B');
        expect(f.fields()[name].validationMessage).toBe(characterMessage(name));
        f.input(name, text[name]);
        expect(f.fields()[name].validationMessage).toBe('');
        expect(f.fetch).toHaveBeenCalledTimes(1);
        f.fetch.mockResolvedValueOnce(response({ status: 'continue_authentication' })); await f.submit();
        expect(f.fetch.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'POST']);
        const body = JSON.parse(f.fetch.mock.calls[1][1].body);
        expect(name === 'organisationName' ? body.organisationName : body.details[name]).toBe(
            name === 'organisationName' ? text[name].trim().normalize('NFC') : text[name]);
    } finally { f.close(); }
});

test.each(Object.keys(text).flatMap(name => ['\t Synthetic value \t', 'Māori e\u0301 & R&D — O’Neil', '👩‍💻 consulting (NZ) + A/B #1']
    .map(value => [name, value])))(
    'server-accepted %s text (%j) keeps the existing payload unchanged', async (name, value) => {
        expect(() => serverText(name, value)).not.toThrow();
        const f = await fixture();
        try {
            f.input(name, value);
            expect(f.fields()[name].validationMessage).toBe('');
            f.fetch.mockResolvedValueOnce(response({ status: 'continue_authentication' })); await f.submit();
            expect(f.fetch).toHaveBeenCalledTimes(2);
            const body = JSON.parse(f.fetch.mock.calls[1][1].body);
            expect(name === 'organisationName' ? body.organisationName : body.details[name]).toBe(
                name === 'organisationName' ? value.trim().normalize('NFC') : value);
        } finally { f.close(); }
    });

test('unsupported altered reserved text stays disabled and cannot replace the canonical organisation', async () => {
    const reservation = { accountType: 'company', organisationName: 'Saved company' };
    const f = await fixture({ ...initial, reservation });
    try {
        const organisation = f.fields().organisationName;
        organisation.setCustomValidity = jest.fn(organisation.setCustomValidity.bind(organisation));
        f.input('organisationName', '<Altered company>');
        f.fetch.mockResolvedValueOnce(response({ status: 'continue_authentication' })); await f.submit();
        expect(organisation.setCustomValidity).not.toHaveBeenCalled();
        expect(JSON.parse(f.fetch.mock.calls[1][1].body)).toMatchObject(reservation);
    } finally { f.close(); }
});

test('existing runtime and normalizer accept corrected text without entering the generic rejection path', async () => {
    let accepted = 0;
    const runtime = createCustomerSignupRuntime({ env: { NOFRIES_PUBLIC_URL: 'https://nofries.nz' },
        loadState: async () => initial, issueCsrfToken: async () => 'a'.repeat(43),
        validateCsrfToken: async (_req, token) => token === 'a'.repeat(43),
        acceptTerms: async () => { throw new Error('Out of scope'); },
        completeSetup: async ({ input }) => {
            serverProof(input.organisationName); starterRepresentativeDetails(input.details);
            accepted++; return { status: 'continue_authentication' };
        } });
    const results = [];
    const fetch = jest.fn(async (url, options) => {
        const req = { method: options.method, headers: { origin: 'https://nofries.nz', 'sec-fetch-site': 'same-origin',
            ...Object.fromEntries(Object.entries(options.headers).map(([key, value]) => [key.toLowerCase(), value])) },
        ...(options.body ? { body: JSON.parse(options.body) } : {}) };
        let result;
        try { result = await runtime.handle(req, url.endsWith('/state') ? 'state' : 'setup'); }
        catch (error) { result = customerSignupErrorResponse(error); }
        results.push({ method: req.method, status: result.status, code: result.body.code });
        return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json' } });
    });
    const f = await fixture(initial, 'consultant', false, fetch);
    try {
        // The existing runtime still maps the actual server normalizer's
        // rejection to its private generic error. The UI must catch it first.
        let rejected;
        try {
            await runtime.handle({ method: 'POST', headers: { origin: 'https://nofries.nz', 'x-csrf-token': 'a'.repeat(43) },
                body: { accountType: 'consultant', organisationName: 'Synthetic company',
                    details: { name: 'Synthetic Owner', role: '<Director>', address: 'Synthetic address', registrationId: '', authorityConfirmed: true } } }, 'setup');
        } catch (error) { rejected = customerSignupErrorResponse(error); }
        expect(rejected).toMatchObject({ status: 503, body: { code: 'signup_unavailable' } });
        expect(accepted).toBe(0);
        f.fields().role.value = '<Director>'; await f.submit();
        expect(results).toEqual([{ method: 'GET', status: 200, code: undefined }]);
        expect(f.fields().role.validationMessage).toBe(characterMessage('role'));
        f.input('role', 'Director'); await f.submit();
        expect(results.map(result => [result.method, result.status])).toEqual([['GET', 200], ['POST', 200]]);
        expect(accepted).toBe(1);
        expect(f.root.querySelector('h1').textContent).toBe('Continuing account setup');
    } finally { f.close(); }
});

test('fresh navigation retains authority and fresh CSRF rules when new unsupported text needs correction', async () => {
    const f = await fixture();
    try {
        f.fetch.mockRejectedValueOnce(new TypeError('Synthetic uncertain response')); await f.submit();
        expect(f.root.querySelector('button')).toBeNull();
        await f.navigate(response(initial, 'b'));
        for (const name of Object.keys(text)) expect(f.fields()[name].value).toBe('');
        expect(f.fields().authorityConfirmed.checked).toBe(false);
        f.fill(); f.fields().authorityConfirmed.checked = false; await f.submit();
        expect(f.document.activeElement).toBe(f.fields().authorityConfirmed);
        expect(f.fetch).toHaveBeenCalledTimes(3);
        f.fields().authorityConfirmed.checked = true;
        f.fields().role.value = '<Director>'; await f.submit();
        expect(f.document.activeElement).toBe(f.fields().role);
        expect(f.fetch.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'POST', 'GET']);
        f.input('role', 'Director');
        f.fetch.mockResolvedValueOnce(response({ status: 'continue_authentication' })); await f.submit();
        expect(f.fetch.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'POST', 'GET', 'POST']);
        expect(f.fetch.mock.calls[3][1].headers['X-CSRF-Token']).toBe('b'.repeat(43));
        expect(JSON.parse(f.fetch.mock.calls[3][1].body).details.authorityConfirmed).toBe(true);
    } finally { f.close(); }
});
