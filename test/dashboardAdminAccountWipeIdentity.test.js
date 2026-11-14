'use strict';
const { createAccountWipeIdentity } = require('../api/shared/dashboardAdmin/accountWipeIdentity');

const TENANT = '70000000-0000-4000-8000-000000000001', OBJECT = '70000000-0000-4000-8000-000000000002';
const STAFF_TENANT = '70000000-0000-4000-8000-000000000099';
const jwt = payload => ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.');
const TOKEN = jwt({ tid: TENANT, aud: 'https://graph.microsoft.com' });
const reply = status => ({ status, body: { cancel: jest.fn(async () => {}) } });
const make = (statuses = [204, 204], token = TOKEN) => {
    const queue = [...statuses];
    const fetch = jest.fn(async () => reply(queue.shift()));
    return { fetch, identity: createAccountWipeIdentity({ tenantId: TENANT, getToken: async () => token, fetch }) };
};

test('deletes the External ID user, then permanently from deleted items, on the fixed Graph origin', async () => {
    const m = make();
    await expect(m.identity.remove(`${TENANT}:${OBJECT}`)).resolves.toEqual({ removed: true, alreadyGone: false });
    expect(m.fetch.mock.calls.map(([url]) => url)).toEqual([`https://graph.microsoft.com/v1.0/users/${OBJECT}`,
        `https://graph.microsoft.com/v1.0/directory/deletedItems/${OBJECT}`]);
    for (const [, options] of m.fetch.mock.calls)
        expect(options).toMatchObject({ method: 'DELETE', redirect: 'error', headers: { Authorization: `Bearer ${TOKEN}` } });
});

test.each([[[404, 404], true], [[404, 204], false], [[204, 404], false]])('statuses %j count as removed (alreadyGone %s)', async (statuses, gone) => {
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
