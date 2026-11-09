'use strict';
const { createMembershipRead } = require('../api/shared/dashboardAdmin/accountActionsMembershipRead');
const { fixture, actor, clone } = require('./fixtures/dashboardAdminMembershipActions');
const invoke = h => createMembershipRead(h.config)(actor, { selector: h.selector }, { request: {}, signal: new AbortController().signal });
test('membership read returns the native status/revision after durable audit without changing customer data', async () => {
    const h = fixture(), before = clone(h.state.snapshot);
    const result = await invoke(h);
    expect(result).toEqual({ selector: h.selector, membershipStatus: 'active', expectedMembershipRevision: before.membershipState.revision });
    expect(h.state.snapshot).toEqual(before); expect(h.state.committed).toBe(0);
    expect([...h.state.rows.values()].map(row => [row.action, row.phase, row.outcome])).toEqual([
        ['read-membership', 'attempt', 'attempt'], ['read-membership', 'terminal', 'succeeded']]);
    await h.run('suspend');
    expect(await invoke(h)).toMatchObject({ membershipStatus: 'suspended', expectedMembershipRevision: before.membershipState.revision + 1 });
});
test.each(['scope', 'audit attempt', 'audit terminal', 'revoked', 'malformed', 'ambiguous', 'input'])('%s cannot release membership state', async mode => {
    const h = fixture();
    if (mode === 'scope') h.config.readContext.mockRejectedValue(new Error('PRIVATE_DENIED'));
    if (mode === 'audit attempt') h.state.fail = 'attempt.json';
    if (mode === 'audit terminal') h.state.fail = 'terminal.json';
    if (mode === 'revoked') {
        const get = h.config.auditContainer.getBlockBlobClient;
        h.config.auditContainer.getBlockBlobClient = key => { const blob = get(key); return { ...blob, async uploadData(...args) {
            const result = await blob.uploadData(...args);
            if (key.endsWith('terminal.json')) h.config.readContext.mockRejectedValue(new Error('PRIVATE_REVOKED')); return result;
        } }; };
    }
    if (mode === 'malformed') h.state.snapshot.membershipState.memberships[0].status = 'unknown';
    if (mode === 'ambiguous') h.state.snapshot.membershipState.memberships.push(clone(h.state.snapshot.membershipState.memberships[0]));
    if (mode === 'input') h.selector.extra = true;
    await expect(invoke(h)).rejects.toBeDefined(); expect(h.state.committed).toBe(0);
    if (mode === 'scope' || mode === 'input') expect(h.state.rows.size).toBe(0);
});
test('read capability cannot issue a membership write and ignores historical removed memberships', async () => {
    const h = fixture(), factory = h.config.createRepository;
    h.state.snapshot.membershipState.memberships.push({ ...h.state.snapshot.membershipState.memberships[0], status: 'removed' });
    h.config.createRepository = (guard, allowed, context) => {
        expect(allowed({ ...h.f.scope, actorSubjectKey: actor.subjectKey, type: 'authority.read' })).toBe(true);
        expect(allowed({ ...h.f.scope, actorSubjectKey: actor.subjectKey, type: 'membership.command' })).toBe(false);
        expect(allowed({ ...h.f.scope, organisationId: 'other', actorSubjectKey: actor.subjectKey, type: 'authority.read' })).toBe(false);
        return factory(guard, allowed, context);
    };
    expect(await invoke(h)).toMatchObject({ membershipStatus: 'active' }); expect(h.state.committed).toBe(0);
});
