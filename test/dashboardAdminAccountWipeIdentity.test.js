'use strict';
const { createAccountWipeIdentity } = require('../api/shared/dashboardAdmin/accountWipeIdentity');

const TENANT = '70000000-0000-4000-8000-000000000001', OBJECT = '70000000-0000-4000-8000-000000000002';
const STAFF_TENANT = '70000000-0000-4000-8000-000000000099';
const jwt = payload => ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.');
const TOKEN = jwt({ tid: TENANT, aud: 'https://graph.microsoft.com' });
const reply = status => ({ status, body: { cancel: jest.fn(async () => {}) } });
const make = (statuses = [204, 204], token = TOKEN, options = {}) => {
    const queue = [...statuses], sleeps = [];
    const fetch = jest.fn(async () => reply(queue.shift()));
    return { fetch, sleeps, identity: createAccountWipeIdentity({ tenantId: TENANT, getToken: async () => token, fetch,
        sleep: async ms => { sleeps.push(ms); }, ...options }) };
};

test('deletes the External ID user, then permanently from deleted items, on the fixed Graph origin', async () => {
    const m = make();
    await expect(m.identity.remove(`${TENANT}:${OBJECT}`)).resolves.toEqual({ removed: true, alreadyGone: false });
    expect(m.fetch.mock.calls.map(([url]) => url)).toEqual([`https://graph.microsoft.com/v1.0/users/${OBJECT}`,
        `https://graph.microsoft.com/v1.0/directory/deletedItems/${OBJECT}`]);
    for (const [, options] of m.fetch.mock.calls)
        expect(options).toMatchObject({ method: 'DELETE', redirect: 'error', headers: { Authorization: `Bearer ${TOKEN}` } });
});

test.each([[[404, 404], true], [[404, 204], false], [[204, 404, 404, 204], false]])('statuses %j count as removed (alreadyGone %s)', async (statuses, gone) => {
    await expect(make(statuses).identity.remove(`${TENANT}:${OBJECT}`)).resolves.toEqual({ removed: true, alreadyGone: gone });
});

test.each([[[401], 'account_wipe_identity_forbidden'], [[403], 'account_wipe_identity_forbidden'], [[500], 'account_wipe_identity_unavailable'],
    [[429], 'account_wipe_identity_unavailable'], [[204, 403], 'account_wipe_identity_forbidden'], [[204, 500], 'account_wipe_identity_unavailable']])
('Graph %j fails with %s', async (statuses, code) => {
    await expect(make(statuses).identity.remove(`${TENANT}:${OBJECT}`)).rejects.toMatchObject({ code });
});

test.each([
    ['a workforce-tenant token', jwt({ tid: STAFF_TENANT, aud: 'https://graph.microsoft.com' })],
    ['a token for another API', jwt({ tid: TENANT, aud: 'api://something-else' })],
    ['a malformed token', 'not-a-jwt'],
    ['an empty token', '']
])('%s is refused before any Graph call, so a 404 can never be mistaken for removal', async (_, token) => {
    const m = make([404, 404], token);
    await expect(m.identity.remove(`${TENANT}:${OBJECT}`)).rejects.toMatchObject({ code: 'account_wipe_identity_configuration_invalid' });
    expect(m.fetch).not.toHaveBeenCalled();
});

test('the Graph application id audience is accepted', async () => {
    const m = make([204, 204], jwt({ tid: TENANT, aud: '00000003-0000-0000-c000-000000000000' }));
    await expect(m.identity.remove(`${TENANT}:${OBJECT}`)).resolves.toMatchObject({ removed: true });
});

test('a workforce (staff) subject or malformed subject is refused before any call', async () => {
    const m = make();
    await expect(m.identity.remove(`${STAFF_TENANT}:${OBJECT}`)).rejects.toMatchObject({ code: 'account_wipe_identity_wrong_tenant' });
    for (const bad of [`${TENANT}:../me`, `${TENANT}:${OBJECT}:x`, 'x', `${TENANT}`, null])
        await expect(m.identity.remove(bad)).rejects.toMatchObject({ code: 'account_wipe_identity_target_invalid' });
    expect(m.fetch).not.toHaveBeenCalled();
});

test('token or network failure is reported without detail', async () => {
    const noToken = createAccountWipeIdentity({ tenantId: TENANT, getToken: async () => { throw new Error('PRIVATE'); }, fetch: jest.fn() });
    await expect(noToken.remove(`${TENANT}:${OBJECT}`)).rejects.toMatchObject({ code: 'account_wipe_identity_unavailable' });
    const down = createAccountWipeIdentity({ tenantId: TENANT, getToken: async () => TOKEN, fetch: async () => { throw new Error('PRIVATE_NETWORK_DETAIL'); } });
    const error = await down.remove(`${TENANT}:${OBJECT}`).catch(e => e);
    expect(error.code).toBe('account_wipe_identity_unavailable'); expect(error.message).not.toContain('PRIVATE');
});

test('configuration must name the External ID tenant', () => {
    expect(() => createAccountWipeIdentity({ tenantId: 'x', getToken: async () => 't' })).toThrow('account_wipe_identity_configuration_invalid');
});

describe('review fixes', () => {
    test('204 then a failing permanent delete is marked soft-deleted, so a later 404/404 stays pending', async () => {
        const first = make([204, 500]);
        await expect(first.identity.remove(`${TENANT}:${OBJECT}`)).rejects.toMatchObject({ code: 'account_wipe_identity_unavailable', softDeleted: true });
        const second = make([404, 404, 404, 404, 404, 404]);
        await expect(second.identity.remove(`${TENANT}:${OBJECT}`, { pendingPermanent: true })).rejects.toMatchObject({ code: 'account_wipe_identity_pending' });
        // A failure before anything was deleted is not marked.
        const before = make([500]);
        const error = await before.identity.remove(`${TENANT}:${OBJECT}`).catch(e => e);
        expect(error.softDeleted).toBeUndefined();
    });

    test('204 then persistent 404 across two invocations stays pending; only a confirmed permanent delete succeeds', async () => {
        const first = make([204, 404, 404, 404, 404, 404]);
        await expect(first.identity.remove(`${TENANT}:${OBJECT}`)).rejects.toMatchObject({ code: 'account_wipe_identity_pending' });
        const second = make([404, 404, 404, 404, 404, 404]);
        await expect(second.identity.remove(`${TENANT}:${OBJECT}`, { pendingPermanent: true })).rejects.toMatchObject({ code: 'account_wipe_identity_pending' });
        expect(second.sleeps).toEqual([500, 1000, 2000, 4000]);
        const third = make([404, 404, 204]);
        await expect(third.identity.remove(`${TENANT}:${OBJECT}`, { pendingPermanent: true })).resolves.toEqual({ removed: true, alreadyGone: false });
    });

    test('a just-deleted user missing from deleted items is retried with backoff, then reported pending, never removed', async () => {
        const m = make([204, 404, 404, 404, 404, 404]);
        await expect(m.identity.remove(`${TENANT}:${OBJECT}`)).rejects.toMatchObject({ code: 'account_wipe_identity_pending' });
        expect(m.sleeps).toEqual([500, 1000, 2000, 4000]);
        expect(m.fetch).toHaveBeenCalledTimes(6);
    });

    test('the backoff stays inside the run deadline', async () => {
        let clock = 0;
        const m = make([204, 404, 404], TOKEN, { now: () => clock });
        m.identity = createAccountWipeIdentity({ tenantId: TENANT, getToken: async () => TOKEN, fetch: m.fetch, now: () => clock,
            sleep: async ms => { m.sleeps.push(ms); clock += ms; } });
        await expect(m.identity.remove(`${TENANT}:${OBJECT}`, { deadline: 6000 })).rejects.toMatchObject({ code: 'account_wipe_identity_pending' });
        expect(m.sleeps).toEqual([500]);
    });

    test('the run signal reaches the token request and every Graph call', async () => {
        const controller = new AbortController(), seen = [];
        const fetch = jest.fn(async (url, options) => { seen.push(options.signal); return reply(204); });
        const identity = createAccountWipeIdentity({ tenantId: TENANT, fetch, getToken: async ({ signal }) => { seen.push(signal); return TOKEN; } });
        await identity.remove(`${TENANT}:${OBJECT}`, { signal: controller.signal });
        expect(seen[0]).toBe(controller.signal);
        controller.abort();
        expect(seen.slice(1).every(signal => signal.aborted)).toBe(true);
    });

    test('check() acquires and validates a token before anything irreversible', async () => {
        await expect(make([], TOKEN).identity.check()).resolves.toBe(true);
        await expect(make([], jwt({ tid: STAFF_TENANT, aud: 'https://graph.microsoft.com' })).identity.check()).rejects.toMatchObject({ code: 'account_wipe_identity_unavailable' });
        const failing = createAccountWipeIdentity({ tenantId: TENANT, fetch: jest.fn(), getToken: async () => { throw new Error('PRIVATE'); } });
        await expect(failing.check()).rejects.toMatchObject({ code: 'account_wipe_identity_unavailable' });
    });
});
