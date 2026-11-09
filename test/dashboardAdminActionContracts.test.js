'use strict';

const fs = require('node:fs');
const { ACTIONS, displayLabel, prepareInput, confirmationInput, operatorPrincipal, inspection,
    commandDigest, actionCommand, actionReceipt } = require('../api/shared/dashboardAdmin/accountActionRecords');
const { accountActionApproval } = require('../api/shared/dashboardAdmin/accountActionApproval');
const uid = n => '74000000-0000-4000-8000-' + String(n).padStart(12, '0');
const ACTOR = uid(1) + ':' + uid(2), SUBJECT = uid(3) + ':' + uid(4);
const NOW = '2026-11-09T00:00:00.000Z', LATER = '2026-11-09T00:05:00.000Z';
const selector = { provider: 'external', subjectKey: SUBJECT, tenantId: 'synthetic-tenant', organisationId: 'synthetic-org' };
const clone = value => JSON.parse(JSON.stringify(value));
function command(action = 'suspend') {
    const value = { schemaVersion: 1, operationId: uid(5), actorSubjectKey: ACTOR, selector: clone(selector),
        expectedVersion: 'a'.repeat(64), action, patch: null,
        preparedAt: NOW, expiresAt: LATER, witness: { nativeRevision: 1, restoreEpoch: uid(6) } };
    return { ...value, commandSha256: commandDigest(value) };
}
function approval() {
    return { schemaVersion: 1, bindingId: uid(7), revision: 1, status: 'active', purpose: 'account_support',
        operatorSubjectKey: ACTOR, instanceId: uid(8), restoreEpoch: uid(6), selector: clone(selector),
        actions: [...ACTIONS, 'list_members'].sort(), approvedAt: NOW, validFrom: NOW,
        validUntil: '2026-11-09T01:00:00.000Z', approvalReference: 'synthetic-independent-approval',
        identityPolicy: { policyId: 'synthetic-staff-policy', policyRevision: 1 },
        auditPolicy: { reference: 'synthetic-audit', revision: 1, agreementVersion: 'nf-dashboard-2026-09-r2',
            retention: { unit: 'calendar_months', count: 13 } } };
}
function view() {
    return { selector: clone(selector), version: 'b'.repeat(64), displayName: 'Accepted organisation', displayLabel: null,
        membership: { membershipId: 'synthetic-member', status: 'active', validFrom: NOW, validUntil: '2027-01-01T00:00:00.000Z' },
        actions: [...ACTIONS], witness: { nativeRevision: 1, restoreEpoch: uid(6) } };
}

test('only suspend and restore action names are supported', () => {
    expect(ACTIONS).toEqual(['suspend', 'restore']);
    expect(Object.isFrozen(ACTIONS)).toBe(true);
    for (const action of ['edit', 'delete', 'archive', 'unarchive', 'reset', 'extend_customer_authority', 'purge', 'change_role', '']) {
        expect(() => prepareInput({ selector, action, patch: null })).toThrow();
        const value = command(action);
        expect(() => actionCommand(value)).toThrow('dashboard_admin_unavailable');
        const grant = approval(); grant.actions = [action];
        expect(() => accountActionApproval(grant)).toThrow('dashboard_admin_access_denied');
    }
});
test.each(ACTIONS)('%s commands preserve exact actor, target, revision witness and digest', action => {
    const input = command(action), actual = actionCommand(input);
    expect(actual).toEqual(input); expect(Object.isFrozen(actual.selector)).toBe(true);
    input.selector.organisationId = 'changed'; input.witness.nativeRevision++;
    expect(actual.selector).toEqual(selector); expect(actual.witness.nativeRevision).toBe(1);
});
test.each(['schemaVersion', 'operationId', 'actorSubjectKey', 'selector', 'expectedVersion', 'action',
    'patch', 'preparedAt', 'expiresAt', 'witness', 'commandSha256'])('commands refuse missing %s', key => {
    const input = command(); delete input[key]; expect(() => actionCommand(input)).toThrow();
});
test.each(['actorSubjectKey', 'expectedVersion', 'operationId', 'expiresAt', 'witness', 'selector'])('digest binds %s', key => {
    const input = command(); input[key] = key === 'witness' ? {} : key === 'selector' ? { ...selector, tenantId: 'other' } : 'changed';
    expect(() => actionCommand(input)).toThrow();
});
test.each([NOW, '2026-11-08T23:59:59.999Z', '2026-11-09T00:05:00.001Z'])('confirmation lifetime refuses %s', expiresAt => {
    const input = command(); input.expiresAt = expiresAt; input.commandSha256 = commandDigest(input);
    expect(() => actionCommand(input)).toThrow();
});
test('unknown fields and accessor/proxy data are refused without invoking them', () => {
    expect(() => actionCommand({ ...command(), customerEmail: 'synthetic@example.invalid' })).toThrow();
    const getter = jest.fn(() => 'label'), patch = {};
    Object.defineProperty(patch, 'displayLabel', { get: getter, enumerable: true });
    expect(() => prepareInput({ selector, action: 'suspend', patch })).toThrow();
    expect(() => prepareInput({ selector, action: 'suspend', patch: new Proxy({}, { get: getter }) })).toThrow();
    expect(getter).not.toHaveBeenCalled();
});
test.each(['', ' name ', '<script>', 'name\u202e', 'e\u0301', 'x'.repeat(201)])('unsafe label is refused: %p', label => {
    expect(() => displayLabel(label)).toThrow();
});
test('labels cannot rename the organisation, change identity or grant a role', () => {
    for (const patch of [{ displayName: 'Rename' }, { email: 'synthetic@example.invalid' }, { displayLabel: 'Label', role: 'admin' }]) {
        expect(() => prepareInput({ selector, action: 'suspend', patch })).toThrow();
    }
    expect(displayLabel('Café Support')).toBe('Café Support');
    expect(() => prepareInput({ selector, action: 'suspend', patch: {} })).toThrow();
});
test('typed confirmation names are bounded plain data, not an authority grant', () => {
    expect(prepareInput({ selector, action: 'suspend', patch: null, confirmationName: 'Accepted organisation' }))
        .toEqual({ selector, action: 'suspend', patch: null, confirmationName: 'Accepted organisation' });
    expect(() => prepareInput({ selector, action: 'suspend', patch: null, confirmationName: 'x'.repeat(201) })).toThrow();
});
test('confirmation tokens require canonical bounded base64url', () => {
    const token = Buffer.alloc(32, 7).toString('base64url');
    expect(confirmationInput({ confirmationToken: token })).toEqual({ confirmationToken: token });
    for (const confirmationToken of [token + '=', token.slice(1), '../' + token, 'x'.repeat(43), null]) {
        expect(() => confirmationInput({ confirmationToken })).toThrow();
    }
});
test('principal must be an authenticated staff BFF identity', () => {
    const principal = { provider: 'entra-bff', isAuthenticated: true, subjectKey: ACTOR };
    expect(operatorPrincipal(principal)).toEqual(principal);
    for (const input of [null, {}, { ...principal, provider: 'external' }, { ...principal, isAuthenticated: false },
        { ...principal, subjectKey: 'staff@example.invalid' }]) expect(() => operatorPrincipal(input)).toThrow();
});
test('inspection binds the exact target and rejects reset-specific state', () => {
    const input = view(); expect(inspection(input, selector)).toEqual(input);
    expect(() => inspection(input, { ...selector, organisationId: 'other' })).toThrow();
    expect(() => inspection({ ...input, signup: { state: 'half_created', accountId: uid(10), hasAuthority: false } }, selector)).toThrow();
    expect(() => inspection({ ...input, actions: ['reset'] }, selector)).toThrow();
    expect(() => inspection({ ...input, membership: null }, selector)).toThrow();
    expect(() => inspection({ ...input, actions: ['suspend', 'suspend'] }, selector)).toThrow();
});
test('optional complete member disclosure remains a paired closed structure', () => {
    const input = view(); input.members = []; input.invitations = [];
    expect(inspection(input, selector)).toEqual(input);
    delete input.invitations; expect(() => inspection(input, selector)).toThrow();
});
test('expanded inspection rejects malformed status, invitation expiry and duplicate roles', () => {
    const input = view();
    input.members = [{ membershipId: 'synthetic-member', subjectKey: SUBJECT, status: 'active', roles: ['viewer'],
        validFrom: NOW, validUntil: '2027-01-01T00:00:00.000Z', effectiveStatus: 'active' }];
    input.invitations = [{ invitationId: 'synthetic-invitation', subjectKey: SUBJECT, status: 'pending', roles: ['viewer'],
        validFrom: NOW, validUntil: '2027-01-01T00:00:00.000Z', expiresAt: LATER }];
    expect(inspection(input, selector)).toEqual(input);
    for (const [key, patch] of [['members', { status: { secret: 'arbitrary' } }], ['members', { effectiveStatus: {} }],
        ['members', { status: 'suspended', effectiveStatus: 'active' }], ['members', { roles: ['viewer', 'viewer'] }],
        ['invitations', { status: 'bogus' }], ['invitations', { expiresAt: 'not-a-date' }],
        ['invitations', { expiresAt: '2027-01-01T00:00:00.001Z' }], ['invitations', { roles: ['viewer', 'viewer'] }]]) {
        const changed = clone(input); Object.assign(changed[key][0], patch);
        expect(() => inspection(changed, selector)).toThrow('dashboard_admin_unavailable');
    }
});
test('receipt is bound to the retained command and cannot predate preparation', () => {
    const input = command(), receipt = { operationId: input.operationId, commandSha256: input.commandSha256,
        status: 'succeeded', version: 'c'.repeat(64), occurredAt: NOW };
    expect(actionReceipt(receipt, input)).toEqual(receipt);
    for (const patch of [{ operationId: uid(99) }, { commandSha256: 'd'.repeat(64) }, { status: 'unknown' },
        { occurredAt: '2026-11-08T00:00:00.000Z' }, { customerLabel: 'not-audit-data' }]) {
        expect(() => actionReceipt({ ...receipt, ...patch }, input)).toThrow();
    }
});
test('independent approval retains exact scoped policies and detached immutable values', () => {
    const input = approval(), result = accountActionApproval(input);
    expect(result).toEqual(input); expect(Object.isFrozen(result.actions)).toBe(true);
    input.selector.organisationId = 'other'; expect(result.selector).toEqual(selector);
});
test.each(['bindingId', 'operatorSubjectKey', 'instanceId', 'restoreEpoch', 'selector', 'actions', 'approvedAt',
    'validFrom', 'validUntil', 'approvalReference', 'identityPolicy', 'auditPolicy'])('approval requires %s', key => {
    const input = approval(); delete input[key]; expect(() => accountActionApproval(input)).toThrow();
});
test.each([[], ['suspend', 'suspend'], ['suspend', 'restore'], ['edit'], ['delete'], ['archive'], ['unarchive'], ['lookup'], ['signupList'], ['reset'], ['extend_customer_authority'], ['purge']].map(actions => [actions]))('approval refuses action set %p', actions => {
    expect(() => accountActionApproval({ ...approval(), actions })).toThrow();
});
test.each([{ purpose: 'lookup' }, { status: 'revoked' }, { revision: -1 }, { schemaVersion: 2 },
    { validUntil: '2026-11-09T01:00:00.001Z' }, { validUntil: NOW }, { approvedAt: LATER }])('approval refuses invalid scope or time: %p', patch => {
    expect(() => accountActionApproval({ ...approval(), ...patch })).toThrow();
});
test('audit and identity policies cannot be omitted or silently changed', () => {
    const input = approval(); input.auditPolicy.retention.count = 12;
    expect(() => accountActionApproval(input)).toThrow();
    input.auditPolicy.retention.count = 13; input.auditPolicy.agreementVersion = 'unapproved';
    expect(() => accountActionApproval(input)).toThrow();
    input.auditPolicy = approval().auditPolicy; input.identityPolicy.policyRevision = -1;
    expect(() => accountActionApproval(input)).toThrow();
});
test('contracts remain unmounted in production and expose no fence/reset entry point', () => {
    for (const file of ['server.js', 'lib/productionApplication.js', 'api/shared/dashboardAdmin/handlers.js']) {
        expect(fs.readFileSync(file, 'utf8')).not.toMatch(/accountActionRecords|accountActionApproval|signupWriterFence/);
    }
});
