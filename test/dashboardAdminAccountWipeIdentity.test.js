'use strict';
const { createAccountWipeIdentity } = require('../api/shared/dashboardAdmin/accountWipeIdentity');

const TENANT = '70000000-0000-4000-8000-000000000001', OBJECT = '70000000-0000-4000-8000-000000000002';
const STAFF_TENANT = '70000000-0000-4000-8000-000000000099';
const reply = status => ({ status, body: { cancel: jest.fn(async () => {}) } });
const make = (status = 204, token = 'synthetic-token') => {
    const fetch = jest.fn(async () => reply(status));
    return { fetch, identity: createAccountWipeIdentity({ tenantId: TENANT, getToken: async () => token, fetch }) };
};

test('deletes exactly the External ID user by object id on the fixed Graph origin', async () => {
    const m = make();
    await expect(m.identity.remove(`${TENANT}:${OBJECT}`)).resolves.toEqual({ removed: true, alreadyGone: false });
    expect(m.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = m.fetch.mock.calls[0];
    expect(url).toBe(`https://graph.microsoft.com/v1.0/users/${OBJECT}`);
    expect(options).toMatchObject({ method: 'DELETE', redirect: 'error', headers: { Authorization: 'Bearer synthetic-token' } });
});

test('an already removed user counts as removed', async () => {
    await expect(make(404).identity.remove(`${TENANT}:${OBJECT}`)).resolves.toEqual({ removed: true, alreadyGone: true });
});

test.each([[401, 'account_wipe_identity_forbidden'], [403, 'account_wipe_identity_forbidden'], [500, 'account_wipe_identity_unavailable'], [429, 'account_wipe_identity_unavailable']])
('Graph %i fails with %s', async (status, code) => {
    await expect(make(status).identity.remove(`${TENANT}:${OBJECT}`)).rejects.toMatchObject({ code });
});

test('a workforce (staff) subject or malformed subject is refused before any call', async () => {
    const m = make();
    await expect(m.identity.remove(`${STAFF_TENANT}:${OBJECT}`)).rejects.toMatchObject({ code: 'account_wipe_identity_wrong_tenant' });
    for (const bad of [`${TENANT}:../me`, `${TENANT}:${OBJECT}:x`, 'x', `${TENANT}`, null])
        await expect(m.identity.remove(bad)).rejects.toMatchObject({ code: 'account_wipe_identity_target_invalid' });
    expect(m.fetch).not.toHaveBeenCalled();
});

test('token or network failure is reported without detail', async () => {
    const noToken = make(204, ''), down = createAccountWipeIdentity({ tenantId: TENANT, getToken: async () => 't',
        fetch: async () => { throw new Error('PRIVATE_NETWORK_DETAIL'); } });
    await expect(noToken.identity.remove(`${TENANT}:${OBJECT}`)).rejects.toMatchObject({ code: 'account_wipe_identity_unavailable' });
    const error = await down.remove(`${TENANT}:${OBJECT}`).catch(e => e);
    expect(error.code).toBe('account_wipe_identity_unavailable'); expect(error.message).not.toContain('PRIVATE');
});

test('configuration must name the External ID tenant', () => {
    expect(() => createAccountWipeIdentity({ tenantId: 'x', getToken: async () => 't' })).toThrow('account_wipe_identity_configuration_invalid');
});
