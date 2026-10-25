'use strict';

const { createHash } = require('node:crypto');
const { createSavedSignupRecovery, prepareRecoveryAuthorization, recoveryAuthorization } =
    require('../api/shared/customerSignup/savedSignupRecovery');
const { createInvitation, validateAcceptanceReceipt, MAX_PROOF_AGE } =
    require('../api/shared/customerSignup/invitationAcceptance');
const { canonicalDigest } = require('../api/shared/appLifecycle/dashboardOnboardingDomain');

const AT = Date.parse('2026-10-07T01:00:00.000Z');
const ID = n => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const SUBJECT = `${ID(1)}:${ID(2)}`;
const OTHER_SUBJECT = `${ID(1)}:${ID(3)}`;
const REFERENCES = ['subjectKey', 'tenantId', 'organisationId', 'invitationId',
    'termsVersion', 'termsDigest', 'scheduleId', 'scheduleDigest'];
const clone = value => JSON.parse(JSON.stringify(value));
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));

// These strict ports model append-only consent and a registration tombstone.
// Production SQL behaviour is covered by the separate native integration suite.
function fixture() {
    const termsText = 'Original terms for the preserved signup.', scheduleText = 'Original consultant schedule.';
    const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
    const invitation = createInvitation({ email: 'saved@example.invalid', tenantId: 'original-tenant',
        organisationId: 'original-consultant', identityPolicyId: 'customer-mfa', mfaRequired: true,
        termsVersion: 'terms-v1', termsDigest: hash(termsText), scheduleId: 'original-schedule',
        scheduleDigest: hash(scheduleText), createdAt: AT - 1000, expiresAt: AT + 3600000 },
    { now: () => AT - 1000 }).record;
    const authority = { schemaVersion: 2, subjectKey: SUBJECT, email: invitation.expectedEmail,
        revision: 7, status: 'active', invitationDigest: invitation.tokenDigest,
        ...pick(invitation, REFERENCES.filter(key => key !== 'subjectKey')),
        bindingId: ID(4), expiresAt: AT + 3600000, accountType: 'consultant' };
    const context = { authority, accountId: ID(5), preparationSha256: 'c'.repeat(64), invitation,
        sessionId: 's'.repeat(43), verifiedAt: AT - 1000, expiresAt: AT + 1800000 };
    const approval = { schemaVersion: 1, recoveryId: ID(6), status: 'active',
        approvalRef: 'synthetic-explicit-scope-approval', ...pick(authority, REFERENCES),
        accountId: context.accountId, authoritySha256: canonicalDigest(authority),
        preparationSha256: context.preparationSha256, invitationDigest: authority.invitationDigest,
        bindingId: authority.bindingId, approvedAt: AT - 500, expiresAt: AT + 600000, receiptId: ID(7) };
    const terms = { ...pick(invitation, ['termsVersion', 'termsDigest', 'scheduleId', 'scheduleDigest']),
        termsText, scheduleText };
    const state = { at: AT, context, approval, invitation: null, terms, receipt: null, registered: null };
    const req = { headers: { cookie: 'synthetic-server-session' } };
    const journalReference = pick(approval, ['tenantId', 'organisationId', 'invitationId']);
    const registrationReference = { ...journalReference, subjectKey: SUBJECT };
    const journal = {
        readForInvitation: jest.fn(async reference => {
            expect(reference).toEqual(journalReference); return clone(state.receipt);
        }),
        persist: jest.fn(async raw => {
            const receipt = validateAcceptanceReceipt(raw);
            if (state.receipt !== null && JSON.stringify(state.receipt) !== JSON.stringify(receipt)) {
                throw new Error('immutable_receipt_conflict');
            }
            state.receipt = clone(receipt); return clone(receipt);
        })
    };
    const registrations = {
        readForInvitation: jest.fn(async reference => {
            expect(reference).toEqual(registrationReference); return clone(state.registered);
        }),
        registerAcceptance: jest.fn(async receipt => {
            expect(receipt).toEqual(state.receipt);
            const target = { ...pick(receipt, [...REFERENCES, 'receiptId']), status: 'pending_admission', revision: 1 };
            if (state.registered !== null) {
                if (state.registered.status === 'revoked') throw new Error('registration_revoked');
                if ([...REFERENCES, 'receiptId'].some(key => state.registered[key] !== target[key])) {
                    throw new Error('registration_conflict');
                }
            } else state.registered = target;
            return clone(state.registered);
        })
    };
    const ports = {
        readContext: jest.fn(async input => { expect(input).toBe(req); return clone(state.context); }),
        readApproval: jest.fn(async subject => { expect(subject).toBe(SUBJECT); return clone(state.approval); }),
        readInvitation: jest.fn(async digest => {
            expect(digest).toBe(invitation.tokenDigest); return clone(state.invitation);
        }),
        resolveTerms: jest.fn(async reference => {
            expect(reference).toEqual(pick(approval, REFERENCES.filter(key => !['subjectKey', 'invitationId'].includes(key))));
            return clone(state.terms);
        }), journal, registrations, now: () => state.at
    };
    const recovery = createSavedSignupRecovery(ports);
    const input = { accepted: true, ...pick(terms, ['termsVersion', 'termsDigest', 'scheduleId', 'scheduleDigest']) };
    return { state, req, ports, journal, registrations, recovery, input,
        accept: () => recovery.acceptTerms({ req, input }),
        load: () => recovery.loadState(req), resume: () => recovery.resumeAcceptance({ req }) };
}

function savedReceipt(f, overrides = {}) {
    return { receiptId: f.state.approval.receiptId, ...pick(f.state.approval, REFERENCES),
        acceptedAt: AT, status: 'pending_admission', dashboardAccess: false, ...overrides };
}
function savedRegistration(f, overrides = {}) {
    return { ...pick(savedReceipt(f), [...REFERENCES, 'receiptId']), status: 'pending_admission', revision: 1, ...overrides };
}
function expectNoWrites(f) {
    expect(f.journal.persist).not.toHaveBeenCalled();
    expect(f.registrations.registerAcceptance).not.toHaveBeenCalled();
}

test('approval compiler pins an explicit scope without publishing authority or accepting terms', () => {
    const f = fixture(), before = clone(f.state), expected = f.state.approval;
    const privateRetainedContext = pick(f.state.context, ['authority', 'accountId', 'preparationSha256', 'invitation']);
    const prepared = prepareRecoveryAuthorization({ context: privateRetainedContext,
        ...pick(expected, ['approvalRef', 'approvedAt', 'expiresAt', 'recoveryId', 'receiptId']) });
    expect(prepared).toEqual(expected);
    expect(recoveryAuthorization(prepared, f.state.context, AT)).toEqual(expected);
    expect(f.state).toEqual(before); expectNoWrites(f);
});

test('offline approval preparation never substitutes for a real authenticated customer session', async () => {
    const f = fixture();
    f.state.context = pick(f.state.context, ['authority', 'accountId', 'preparationSha256', 'invitation']);
    await expect(f.load()).rejects.toThrow('signup_recovery_unavailable');
    await expect(f.accept()).rejects.toThrow('signup_recovery_unavailable'); expectNoWrites(f);
});

test('GET displays the original offer read-only; actual consent POST records once and preserves its timestamp on retry', async () => {
    const f = fixture(), retained = clone({ context: f.state.context, approval: f.state.approval });
    await expect(f.load()).resolves.toEqual({ status: 'terms', ...f.state.terms });
    expectNoWrites(f); expect(f.state.receipt).toBeNull(); expect(f.state.registered).toBeNull();
    await expect(f.accept()).resolves.toEqual({ status: 'pending_admission' });
    expect(f.state.receipt).toEqual(savedReceipt(f));
    expect(f.state.registered).toEqual(savedRegistration(f));
    expect(f.journal.persist).toHaveBeenCalledTimes(1);
    f.state.at += 30000;
    await expect(f.accept()).resolves.toEqual({ status: 'pending_admission' });
    await expect(f.load()).resolves.toEqual({ status: 'pending_admission' });
    expect(f.state.receipt.acceptedAt).toBe(AT); expect(f.journal.persist).toHaveBeenCalledTimes(1);
    expect({ context: f.state.context, approval: f.state.approval }).toEqual(retained);
    expect(f.state.invitation).toBeNull();
});

test('resume without a durable acceptance receipt cannot manufacture consent', async () => {
    const f = fixture();
    await expect(f.resume()).rejects.toThrow('signup_recovery_unavailable');
    expectNoWrites(f); expect(f.ports.resolveTerms).not.toHaveBeenCalled();
});

test('existing exact consent can resume registration without accepting again', async () => {
    const f = fixture(); f.state.receipt = savedReceipt(f);
    await expect(f.load()).resolves.toEqual({ status: 'resume_acceptance' });
    expectNoWrites(f);
    await expect(f.resume()).resolves.toEqual({ status: 'pending_admission' });
    expect(f.state.receipt).toEqual(savedReceipt(f)); expect(f.journal.persist).not.toHaveBeenCalled();
    expect(f.ports.resolveTerms).not.toHaveBeenCalled();
});

test('a read-only registration guard blocks fresh recovery before persisting consent or registering', async () => {
    const f = fixture(), before = clone(f.state);
    f.registrations.assertAcceptanceWritable = jest.fn(async command => {
        expect(command).toEqual({ subjectKey: SUBJECT }); throw new Error('signup_registration_read_only');
    });
    await expect(f.accept()).rejects.toThrow('signup_registration_read_only');
    expect(f.registrations.assertAcceptanceWritable).toHaveBeenCalledTimes(1);
    expectNoWrites(f); expect(f.state).toEqual(before); expect(f.state.invitation).toBeNull();
});

test.each(['accept', 'resume'])('a read-only registration guard blocks receipt-present recovery %s without changing durable proof', async action => {
    const f = fixture(); f.state.receipt = savedReceipt(f);
    const before = clone(f.state);
    f.registrations.assertAcceptanceWritable = jest.fn(async command => {
        expect(command).toEqual({ subjectKey: SUBJECT }); throw new Error('signup_registration_read_only');
    });
    await expect(f.load()).resolves.toEqual({ status: 'resume_acceptance' });
    expect(f.registrations.assertAcceptanceWritable).not.toHaveBeenCalled();
    await expect(f[action]()).rejects.toThrow('signup_registration_read_only');
    expect(f.registrations.assertAcceptanceWritable).toHaveBeenCalledTimes(1);
    expectNoWrites(f); expect(f.state).toEqual(before); expect(f.ports.resolveTerms).not.toHaveBeenCalled();
});

test('recovery rechecks write admission after receipt persistence before attempting registration', async () => {
    const f = fixture();
    f.registrations.assertAcceptanceWritable = jest.fn().mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('signup_registration_read_only'));
    await expect(f.accept()).rejects.toThrow('signup_registration_read_only');
    expect(f.registrations.assertAcceptanceWritable.mock.calls).toEqual([[{ subjectKey: SUBJECT }], [{ subjectKey: SUBJECT }]]);
    expect(f.journal.persist).toHaveBeenCalledTimes(1); expect(f.state.receipt).toEqual(savedReceipt(f));
    expect(f.registrations.registerAcceptance).not.toHaveBeenCalled(); expect(f.state.registered).toBeNull();
    expect(f.state.invitation).toBeNull();
});

test('malformed optional recovery registration guards reject at construction without reading or writing ports', () => {
    const f = fixture(); let invoked = false;
    const proxied = new Proxy(async () => {}, { apply() { invoked = true; } });
    for (const guard of [undefined, null, false, 0, 'guard', {}, proxied]) {
        expect(() => createSavedSignupRecovery({ ...f.ports, registrations: {
            ...f.registrations, assertAcceptanceWritable: guard
        } })).toThrow('signup_registration_store_required');
    }
    expect(invoked).toBe(false); expectNoWrites(f);
    for (const name of ['readContext', 'readApproval', 'readInvitation', 'resolveTerms']) {
        expect(f.ports[name]).not.toHaveBeenCalled();
    }
    expect(f.journal.readForInvitation).not.toHaveBeenCalled();
    expect(f.registrations.readForInvitation).not.toHaveBeenCalled();
});

test.each(['load', 'accept', 'resume'])('%s has no recovery fallback without protected approval', async action => {
    const f = fixture(); f.state.approval = null;
    await expect(f[action]()).resolves.toBeNull();
    expectNoWrites(f); expect(f.journal.readForInvitation).not.toHaveBeenCalled();
    expect(f.ports.resolveTerms).not.toHaveBeenCalled();
});

test('an unrelated session without original starter context has no recovery fallback', async () => {
    const f = fixture(); f.state.context = null;
    await expect(f.load()).resolves.toBeNull();
    expect(f.ports.readApproval).not.toHaveBeenCalled(); expectNoWrites(f);
});

test.each(['invited', 'revoked'])('a present %s invitation cannot be bypassed using recovery approval', async status => {
    const f = fixture(); f.state.invitation = { ...f.state.context.invitation, status };
    for (const action of ['load', 'accept', 'resume']) await expect(f[action]()).resolves.toBeNull();
    expectNoWrites(f); expect(f.journal.readForInvitation).not.toHaveBeenCalled();
});

test.each([
    ['revoked approval', f => { f.state.approval.status = 'revoked'; }],
    ['missing approval reference', f => { f.state.approval.approvalRef = ''; }],
    ['malformed receipt identifier', f => { f.state.approval.receiptId = 'unbound-receipt'; }],
    ['extra authority in approval', f => { f.state.approval.operator = true; }],
    ['wrong immutable identity', f => { f.state.approval.subjectKey = OTHER_SUBJECT; }],
    ['wrong tenant', f => { f.state.approval.tenantId = 'other-tenant'; }],
    ['wrong organisation', f => { f.state.approval.organisationId = 'other-organisation'; }],
    ['wrong account', f => { f.state.approval.accountId = ID(8); }],
    ['wrong retained binding', f => { f.state.approval.bindingId = ID(8); }],
    ['wrong invitation', f => { f.state.approval.invitationId = 'other-invitation'; }],
    ['wrong invitation digest', f => { f.state.approval.invitationDigest = 'e'.repeat(64); }],
    ['changed authority revision', f => { f.state.context.authority.revision++; }],
    ['revoked authority', f => { f.state.context.authority.status = 'revoked'; }],
    ['changed retained preparation', f => { f.state.context.preparationSha256 = 'd'.repeat(64); }],
    ['wrong terms', f => { f.state.approval.termsDigest = 'd'.repeat(64); }],
    ['wrong schedule', f => { f.state.approval.scheduleDigest = 'd'.repeat(64); }],
    ['future approval', f => { f.state.approval.approvedAt = AT + 1; }],
    ['expired approval', f => { f.state.approval.expiresAt = AT; }],
    ['overlong approval', f => { f.state.approval.expiresAt = f.state.approval.approvedAt + 3600001; }],
    ['authority deadline extension', f => { f.state.context.authority.expiresAt = AT + 5000;
        f.state.approval.authoritySha256 = canonicalDigest(f.state.context.authority); }],
    ['expired authority', f => { f.state.context.authority.expiresAt = AT; }],
    ['invitation deadline extension', f => { f.state.context.invitation.expiresAt = AT + 5000; }],
    ['expired original invitation', f => { f.state.context.invitation.expiresAt = AT; }],
    ['future original invitation', f => { f.state.context.invitation.createdAt = AT + 1; }],
    ['revoked retained invitation', f => { f.state.context.invitation.status = 'revoked'; }],
    ['wrong retained mailbox', f => { f.state.context.invitation.expectedEmail = 'other@example.invalid'; }],
    ['wrong retained organisation', f => { f.state.context.invitation.organisationId = 'other'; }],
    ['wrong retained token', f => { f.state.context.invitation.tokenDigest = 'f'.repeat(64); }],
    ['invalid session', f => { f.state.context.sessionId = 'invalid'; }],
    ['future verification', f => { f.state.context.verifiedAt = AT + 1; }],
    ['stale verification', f => { f.state.context.verifiedAt = AT - MAX_PROOF_AGE - 1; }],
    ['expired session', f => { f.state.context.expiresAt = AT; }]
])('denies %s before any consent or registration write', async (_, change) => {
    const f = fixture(); change(f);
    await expect(f.accept()).rejects.toThrow(); expectNoWrites(f);
});

test.each([
    ['no affirmative consent', input => { input.accepted = false; }],
    ['string consent', input => { input.accepted = 'true'; }],
    ['missing consent', input => { delete input.accepted; }],
    ['changed terms version', input => { input.termsVersion = 'terms-v2'; }],
    ['changed terms digest', input => { input.termsDigest = 'f'.repeat(64); }],
    ['changed schedule', input => { input.scheduleId = 'another-schedule'; }],
    ['changed schedule digest', input => { input.scheduleDigest = 'f'.repeat(64); }],
    ['client-provided receipt', input => { input.receiptId = ID(9); }],
    ['client-provided timestamp', input => { input.acceptedAt = AT - 1000; }]
])('actual consent POST rejects %s', async (_, change) => {
    const f = fixture(); change(f.input);
    await expect(f.accept()).rejects.toThrow(); expectNoWrites(f);
});

test.each(['termsVersion', 'termsDigest', 'scheduleId', 'scheduleDigest'])('changed current offer %s denies GET and POST', async key => {
    const f = fixture(); f.state.terms[key] = 'changed';
    await expect(f.load()).rejects.toThrow(); await expect(f.accept()).rejects.toThrow(); expectNoWrites(f);
});

test.each(['termsText', 'scheduleText'])('tampered archive bytes in %s deny even with the expected digest fields', async key => {
    const f = fixture(); f.state.terms[key] += ' Altered legal text.';
    await expect(f.load()).rejects.toThrow(); await expect(f.accept()).rejects.toThrow(); expectNoWrites(f);
});

test('unavailable, revoked or expired current offer never falls back to archived terms', async () => {
    const f = fixture(); f.ports.resolveTerms.mockRejectedValue(new Error('current_offer_unavailable'));
    await expect(f.load()).rejects.toThrow('current_offer_unavailable');
    await expect(f.accept()).rejects.toThrow('current_offer_unavailable'); expectNoWrites(f);
});

test.each([
    ['another receipt ID', { receiptId: ID(9) }],
    ['another identity', { subjectKey: OTHER_SUBJECT }],
    ['another tenant', { tenantId: 'other' }],
    ['another organisation', { organisationId: 'other' }],
    ['another invitation', { invitationId: 'other' }],
    ['changed accepted terms', { termsDigest: 'e'.repeat(64) }],
    ['changed accepted schedule', { scheduleDigest: 'e'.repeat(64) }],
    ['consent predating approval', { acceptedAt: AT - 501 }],
    ['consent at approval expiry', { acceptedAt: AT + 600000 }],
    ['fabricated access grant', { dashboardAccess: true }]
])('conflicting durable proof with %s is never rewritten', async (_, overrides) => {
    const f = fixture(); f.state.receipt = savedReceipt(f, overrides); const before = clone(f.state.receipt);
    await expect(f.load()).rejects.toThrow(); await expect(f.accept()).rejects.toThrow();
    await expect(f.resume()).rejects.toThrow(); expectNoWrites(f); expect(f.state.receipt).toEqual(before);
});

test.each([false, true])('revoked registration denies even when durable receipt exists: %s', async receiptExists => {
    const f = fixture(); if (receiptExists) f.state.receipt = savedReceipt(f);
    f.state.registered = savedRegistration(f, { status: 'revoked', revision: 2 });
    const before = clone(f.state.registered);
    await expect(f.load()).rejects.toThrow(); await expect(f.accept()).rejects.toThrow();
    await expect(f.resume()).rejects.toThrow(); expectNoWrites(f); expect(f.state.registered).toEqual(before);
});

test('registration without any durable consent proof is inconsistent, never a reason to invent a receipt', async () => {
    const f = fixture(); f.state.registered = savedRegistration(f);
    await expect(f.accept()).rejects.toThrow(); expectNoWrites(f); expect(f.state.receipt).toBeNull();
});

test.each([
    ['another receipt', { receiptId: ID(9) }],
    ['another identity', { subjectKey: OTHER_SUBJECT }],
    ['another organisation', { organisationId: 'other' }],
    ['another schedule', { scheduleDigest: 'd'.repeat(64) }],
    ['invalid revision', { revision: -1 }]
])('existing registration referencing %s denies recovery without rewriting state', async (_, overrides) => {
    const f = fixture(); f.state.receipt = savedReceipt(f); f.state.registered = savedRegistration(f, overrides);
    const before = clone(f.state.registered);
    await expect(f.resume()).rejects.toThrow(); await expect(f.accept()).rejects.toThrow();
    expectNoWrites(f); expect(f.state.registered).toEqual(before);
});

test.each([
    ['identity revision', f => { f.state.context.authority.revision++; }],
    ['session switch', f => { f.state.context.sessionId = 't'.repeat(43); }],
    ['approval removal', f => { f.state.approval = null; }],
    ['approval replacement', f => { f.state.approval.recoveryId = ID(9); }],
    ['invitation reappears revoked', f => { f.state.invitation = { ...f.state.context.invitation, status: 'revoked' }; }],
    ['clock reaches expiry', f => { f.state.at = f.state.approval.expiresAt; }],
    ['retained preparation changes', f => { f.state.context.preparationSha256 = 'e'.repeat(64); }]
])('rechecks %s after awaited terms lookup before writing', async (_, change) => {
    const f = fixture();
    f.ports.resolveTerms.mockImplementationOnce(async () => { change(f); return clone(f.state.terms); });
    await expect(f.accept()).rejects.toThrow(); expectNoWrites(f);
});

test('GET detects approval revocation during its awaited journal read without writing', async () => {
    const f = fixture();
    f.journal.readForInvitation.mockImplementationOnce(async () => { f.state.approval = null; return null; });
    await expect(f.load()).rejects.toThrow(); expectNoWrites(f);
});

test('rechecks durable state after offer lookup and preserves a concurrent revoked registration', async () => {
    const f = fixture();
    f.ports.resolveTerms.mockImplementationOnce(async () => {
        f.state.registered = savedRegistration(f, { status: 'revoked', revision: 2 }); return clone(f.state.terms);
    });
    await expect(f.accept()).rejects.toThrow(); expectNoWrites(f); expect(f.state.registered.status).toBe('revoked');
});

test('concurrent genuine receipt from the same approval is reused with its original timestamp', async () => {
    const f = fixture();
    f.ports.resolveTerms.mockImplementationOnce(async () => {
        f.state.receipt = savedReceipt(f, { acceptedAt: AT - 100 }); return clone(f.state.terms);
    });
    await expect(f.accept()).resolves.toEqual({ status: 'pending_admission' });
    expect(f.journal.persist).not.toHaveBeenCalled(); expect(f.state.receipt.acceptedAt).toBe(AT - 100);
});

test('uncertain journal commit fails without registration, then explicit retry uses the original durable proof', async () => {
    const f = fixture(), persist = f.journal.persist.getMockImplementation();
    f.journal.persist.mockImplementationOnce(async receipt => { await persist(receipt); throw new Error('commit_response_lost'); });
    await expect(f.accept()).rejects.toThrow('commit_response_lost');
    expect(f.state.receipt).toEqual(savedReceipt(f)); expect(f.registrations.registerAcceptance).not.toHaveBeenCalled();
    f.state.at += 10000;
    await expect(f.load()).resolves.toEqual({ status: 'resume_acceptance' });
    await expect(f.accept()).resolves.toEqual({ status: 'pending_admission' });
    expect(f.state.receipt.acceptedAt).toBe(AT); expect(f.journal.persist).toHaveBeenCalledTimes(1);
});

test('failed journal write cannot advance registration or be repaired by resume', async () => {
    const f = fixture(); f.journal.persist.mockRejectedValueOnce(new Error('journal_unavailable'));
    await expect(f.accept()).rejects.toThrow('journal_unavailable');
    await expect(f.resume()).rejects.toThrow('signup_recovery_unavailable');
    expect(f.registrations.registerAcceptance).not.toHaveBeenCalled(); expect(f.state.receipt).toBeNull();
});

test('uncertain registration commit retains real consent and resumes without another acceptance or revision', async () => {
    const f = fixture(), register = f.registrations.registerAcceptance.getMockImplementation();
    f.registrations.registerAcceptance.mockImplementationOnce(async receipt => {
        await register(receipt); throw new Error('registration_response_lost');
    });
    await expect(f.accept()).rejects.toThrow('registration_response_lost');
    const before = clone({ receipt: f.state.receipt, registered: f.state.registered }); f.state.at += 10000;
    await expect(f.resume()).resolves.toEqual({ status: 'pending_admission' });
    expect({ receipt: f.state.receipt, registered: f.state.registered }).toEqual(before);
    expect(f.journal.persist).toHaveBeenCalledTimes(1);
});

test('failed registration before commit preserves consent so a later resume can finish without accepting again', async () => {
    const f = fixture(); f.registrations.registerAcceptance.mockRejectedValueOnce(new Error('registration_unavailable'));
    await expect(f.accept()).rejects.toThrow('registration_unavailable');
    expect(f.state.registered).toBeNull(); expect(f.state.receipt).toEqual(savedReceipt(f));
    f.state.at += 10000;
    await expect(f.resume()).resolves.toEqual({ status: 'pending_admission' });
    expect(f.state.receipt.acceptedAt).toBe(AT); expect(f.journal.persist).toHaveBeenCalledTimes(1);
});

test('receipt-only recovery cannot retry or resume after approval expiry and preserves its original consent', async () => {
    const f = fixture(); f.state.approval.expiresAt = AT + 30000;
    f.registrations.registerAcceptance.mockRejectedValueOnce(new Error('registration_unavailable'));
    await expect(f.accept()).rejects.toThrow('registration_unavailable');
    expect(f.state.receipt).toEqual(savedReceipt(f)); expect(f.state.registered).toBeNull();
    const before = clone({ receipt: f.state.receipt, registered: f.state.registered });
    // Session proof, invitation and authority remain current: only this
    // deliberately bounded recovery authorization has reached its deadline.
    f.state.at = f.state.approval.expiresAt;
    await expect(f.accept()).rejects.toThrow('signup_recovery_unavailable');
    await expect(f.resume()).rejects.toThrow('signup_recovery_unavailable');
    expect({ receipt: f.state.receipt, registered: f.state.registered }).toEqual(before);
    expect(f.state.receipt.acceptedAt).toBe(AT);
    expect(f.journal.persist).toHaveBeenCalledTimes(1);
    expect(f.registrations.registerAcceptance).toHaveBeenCalledTimes(1);
});

test('authority removed during journal persistence stops registration while preserving actual consent', async () => {
    const f = fixture(), persist = f.journal.persist.getMockImplementation();
    f.journal.persist.mockImplementationOnce(async receipt => { const result = await persist(receipt);
        f.state.approval = null; return result; });
    await expect(f.accept()).rejects.toThrow();
    expect(f.state.receipt.acceptedAt).toBe(AT); expect(f.registrations.registerAcceptance).not.toHaveBeenCalled();
});

test.each(['revoked', 'changed revision', 'missing'])('final registration readback rejects %s after its write', async change => {
    const f = fixture(), register = f.registrations.registerAcceptance.getMockImplementation();
    f.registrations.registerAcceptance.mockImplementationOnce(async receipt => {
        const result = await register(receipt);
        if (change === 'revoked') f.state.registered.status = 'revoked';
        else if (change === 'changed revision') f.state.registered.revision++;
        else f.state.registered = null;
        return result;
    });
    await expect(f.accept()).rejects.toThrow(); expect(f.state.receipt.acceptedAt).toBe(AT);
});

test.each(['readContext', 'readApproval', 'readInvitation'])('unavailable %s fails closed without treating an uncertain read as absence', async port => {
    const f = fixture(); f.ports[port].mockRejectedValueOnce(new Error('read_unavailable'));
    await expect(f.accept()).rejects.toThrow('read_unavailable'); expectNoWrites(f);
});

test.each(['journal', 'registrations'])('unavailable %s read fails closed before consent', async port => {
    const f = fixture(); f[port].readForInvitation.mockRejectedValueOnce(new Error('read_unavailable'));
    await expect(f.accept()).rejects.toThrow('read_unavailable'); expectNoWrites(f);
});
