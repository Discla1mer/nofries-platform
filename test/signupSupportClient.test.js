'use strict';
const { createSignupClient } = require('../api/shared/customerSignup/signupClient');
const report = require('../js/customer-report');
const reference = 'NF-0123456789ABCDEF', sha = 'a'.repeat(40), runId = '38380759572';
const metadata = { supportReference: reference, apiReleaseSha: sha, apiReleaseRunId: runId };
const headers = () => new Headers({ 'content-type': 'application/json',
    'X-NoFries-Support-Reference': reference, 'X-NoFries-Release-Sha': sha, 'X-NoFries-Release-Run-Id': runId,
    'X-Request-ID': 'private-client-id', 'Set-Cookie': 'private-cookie' });
function setup(result) {
    const fetch = jest.fn(async () => result), createAccount = jest.fn();
    return { fetch, createAccount, client: createSignupClient({ fetch, createAccount, customerTransport: 'external' }) };
}
const response = (status = 503, body = { error: 'Signup is unavailable' }, hdr = headers()) =>
    new Response(JSON.stringify(body), { status, headers: hdr });
const failure = async action => { try { await action; throw new Error('expected_failure'); }
    catch (error) { expect(error.message).toBe('signup_unavailable'); return error; } };

test('HTTP failure retains only bounded original-response metadata on a private error mapping', async () => {
    const f = setup(response()), error = await failure(f.client.load());
    expect(f.client.diagnostic(error)).toEqual(metadata);
    expect(Object.isFrozen(f.client.diagnostic(error))).toBe(true);
    expect(Object.keys(error)).toEqual([]);
    expect(error.message).toBe('signup_unavailable');
    expect(JSON.stringify(error)).not.toMatch(/private|cookie|reference/);
    expect(f.fetch).toHaveBeenCalledTimes(1);
});

test('unavailable200 preserves the unchanged frozen state and success receives no metadata', async () => {
    const f = setup(response(200, { state: { status: 'unavailable', supportReference: 'forged-provider' } }));
    const state = await f.client.load();
    expect(state).toEqual({ status: 'unavailable' }); expect(Object.isFrozen(state)).toBe(true);
    expect(f.client.diagnostic(state)).toEqual(metadata);
    f.fetch.mockResolvedValueOnce(response(200, { state: { status: 'pending_admission' } }));
    const success = await f.client.load();
    expect(success).toEqual({ status: 'pending_admission' }); expect(f.client.diagnostic(success)).toBeUndefined();
});

test.each(['NF-short', reference.toLowerCase(), reference + '\n', reference + '\r\n', reference + ', ' + reference,
    reference + ' ', 'Bearer private-token', 'x'.repeat(200)])('rejects malformed reference %j without exposing raw fields', async value => {
    const hdr = { get: name => name === 'content-type' ? 'application/json' : name === 'X-NoFries-Support-Reference' ? value : null };
    const f = setup({ status: 503, headers: hdr });
    const error = await failure(f.client.load()); expect(f.client.diagnostic(error)).toBeUndefined();
});

test.each([[sha, '0'], [sha, '01'], [sha, '1\n'], [sha, '1'.repeat(21)], [sha.toUpperCase(), runId],
    [sha + '\n', runId], [sha + ', ' + sha, runId], [sha, null], [null, runId]])('release fields validate as one strict pair %#', async (releaseSha, releaseRun) => {
    const hdr = { get: name => ({ 'X-NoFries-Support-Reference': reference, 'X-NoFries-Release-Sha': releaseSha,
        'X-NoFries-Release-Run-Id': releaseRun })[name] ?? null };
    const f = setup({ status: 503, headers: hdr });
    expect(f.client.diagnostic(await failure(f.client.load()))).toEqual({ supportReference: reference });
});

test('valid original release pair needs neither a support event nor another network read', async () => {
    const hdr = headers(); hdr.delete('X-NoFries-Support-Reference');
    const f = setup(response(503, {}, hdr));
    expect(f.client.diagnostic(await failure(f.client.load()))).toEqual({ apiReleaseSha: sha, apiReleaseRunId: runId });
    expect(f.fetch).toHaveBeenCalledTimes(1);
});

test('provider errors, incoming state properties and another client cannot impersonate observed metadata', async () => {
    const f = setup(response());
    const forged = Object.assign(new Error('private-provider-token'), metadata);
    f.createAccount.mockRejectedValueOnce(forged);
    expect(f.client.diagnostic(await failure(f.client.createAccount()))).toBeUndefined();
    expect(f.client.diagnostic(forged)).toBeUndefined(); expect(f.fetch).not.toHaveBeenCalled();
    const error = await failure(f.client.load());
    // Even an earlier genuine error cannot smuggle its old request into a
    // later provider operation that has not received a response.
    f.createAccount.mockRejectedValueOnce(error);
    expect(f.client.diagnostic(await failure(f.client.createAccount()))).toBeUndefined();
    expect(setup(response()).client.diagnostic(error)).toBeUndefined();
    expect(f.client.diagnostic({ ...metadata })).toBeUndefined();
    expect(f.client.diagnostic(null)).toBeUndefined();
});

test('a later recheck cannot reuse the original reference on lost or metadata-free responses', async () => {
    const f = setup(response()), original = await failure(f.client.load());
    f.fetch.mockRejectedValueOnce(new Error('private-network-token'));
    expect(f.client.diagnostic(await failure(f.client.load()))).toBeUndefined();
    f.fetch.mockResolvedValueOnce(response(503, {}, new Headers()));
    expect(f.client.diagnostic(await failure(f.client.load()))).toBeUndefined();
    expect(f.client.diagnostic(original)).toEqual(metadata); expect(f.fetch).toHaveBeenCalledTimes(3);
});

test('redirects and header access failures do not invent context', async () => {
    const redirected = response(); Object.defineProperty(redirected, 'redirected', { value: true });
    for (const res of [redirected, { status: 503, headers: { get() { throw new Error('private-token'); } } }]) {
        const f = setup(res); expect(f.client.diagnostic(await failure(f.client.load()))).toBeUndefined();
    }
});

test('headers received before a broken body preserve reference but assert no saved outcome', async () => {
    const f = setup({ status: 200, headers: headers(), body: { getReader: () => ({
        read: async () => { throw new Error('private-body-token'); }, cancel: jest.fn() }) } });
    expect(f.client.diagnostic(await failure(f.client.load()))).toEqual(metadata);
    expect(f.fetch).toHaveBeenCalledTimes(1);
});

test('headers received before stream cancellation survive while late reads cannot change the next result', async () => {
    jest.useFakeTimers();
    try {
        let finish;
        const f = setup({ status: 200, headers: headers(), body: { getReader: () => ({
            read: () => new Promise(resolve => { finish = resolve; }), cancel: jest.fn() }) } });
        const first = failure(f.client.load()); await jest.advanceTimersByTimeAsync(15000);
        expect(f.client.diagnostic(await first)).toEqual(metadata);
        f.fetch.mockResolvedValueOnce(response(503, {}, new Headers()));
        const second = await failure(f.client.load()); expect(f.client.diagnostic(second)).toBeUndefined();
        finish({ done: true }); await jest.advanceTimersByTimeAsync(0);
        expect(f.client.diagnostic(second)).toBeUndefined(); expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
});

test.each(['abort', 'dispose'])('response arriving after %s is ignored without inspecting its headers', async mode => {
    let finish;
    const f = setup(null), controller = new AbortController(), get = jest.fn(() => reference);
    f.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = failure(f.client.load({ signal: controller.signal }));
    if (mode === 'abort') controller.abort(); else f.client.dispose();
    const error = await pending; finish({ status: 503, headers: { get } });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(get).not.toHaveBeenCalled(); expect(f.client.diagnostic(error)).toBeUndefined();
});

test('report preview uses original API fields, separates the email reference and discards later-page metadata', () => {
    const context = report.readContext('#kind=error&screen=signup&reference=' + reference + '&apiReleaseSha=' + sha +
        '&apiReleaseRunId=' + runId + '&releaseSha=' + 'b'.repeat(40) + '&token=private-token');
    const draft = report.prepare({ kind: 'error', screen: 'signup', description: 'The status check did not finish.' },
        context, 'NF-FEDCBA9876543210', '2026-10-13T11:00:00.000Z');
    expect(draft.body).toContain('Support reference: ' + reference);
    expect(draft.body).toContain('Report reference: NF-FEDCBA9876543210');
    expect(draft.body).toContain('Original API release SHA: ' + sha);
    expect(draft.body).toContain('Original API release run: ' + runId);
    expect(draft.body).not.toMatch(/private|bbbbbbbb/);
    expect(new URL(draft.mailto).searchParams.get('body')).toBe(draft.body);
    expect(draft.copy.endsWith(draft.body)).toBe(true);
});

test.each(['apiReleaseSha', 'apiReleaseRunId'])('composer drops the release pair when %s is duplicated', key => {
    const params = new URLSearchParams({ kind: 'error', screen: 'signup', apiReleaseSha: sha, apiReleaseRunId: runId });
    params.append(key, key === 'apiReleaseSha' ? sha : runId);
    expect(report.readContext(params.toString())).not.toHaveProperty('apiReleaseSha');
    expect(report.readContext(params.toString())).not.toHaveProperty('apiReleaseRunId');
});

test('composer link validates new fields and changed type/screen removes stale original API identity', () => {
    const context = { kind: 'error', screen: 'signup', reference, apiReleaseSha: sha, apiReleaseRunId: runId };
    expect(report.link(context)).toContain('&apiReleaseSha=' + sha + '&apiReleaseRunId=' + runId);
    for (const selection of [{ kind: 'bug', screen: 'signup' }, { kind: 'error', screen: 'website' }]) {
        const draft = report.prepare({ ...selection, description: 'Useful description.' }, context, reference, '2026-10-13T11:00:00.000Z');
        expect(draft.body).not.toMatch(/Support reference:|Original API release/);
    }
    expect(report.readContext('#reference=' + reference + '%0A').reference).toBe('');
    expect(report.prepare({ kind: 'bug', screen: 'website', description: 'Useful.' }, {}, reference + '\n', '').body).not.toContain('Report reference:');
});
