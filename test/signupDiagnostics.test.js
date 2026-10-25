'use strict';

const { createHash } = require('node:crypto');
const { createSignupDiagnostics } = require('../api/shared/customerSignup/signupDiagnostics');
const { createJournaledSignupHandlers } = require('../api/shared/customerSignup/journaledTermsAcceptance');
const { createSessionBoundSignupContinuation } = require('../api/shared/customerSignup/sessionBoundSignupContinuation');
const { RETENTION_POLICY_ID } = require('../api/shared/customerSignup/postgresSignupAcceptanceJournal');

// Synthetic data only. The sentinel represents information that must never reach
// diagnostics, including when a provider supplies it through an exception.
const PRIVATE = 'DO_NOT_LOG_SYNTHETIC_COOKIE_TOKEN_CUSTOMER_RECORD';
const AT = Date.parse('2026-10-06T01:00:00.000Z');
const TENANT = '11111111-1111-1111-1111-111111111111';
const PRINCIPAL = '22222222-2222-2222-2222-222222222222';
const SUBJECT = `${TENANT}:${PRINCIPAL}`;
const TERMS_TEXT = 'Synthetic diagnostic test terms.';
const TERMS_DIGEST = createHash('sha256').update(TERMS_TEXT).digest('hex');
const DIGEST = 'a'.repeat(64);
const unavailable = { status: 'unavailable' };
const req = () => ({ headers: { cookie: PRIVATE }, body: { customer: PRIVATE } });
const error = code => Object.assign(new Error(PRIVATE), { code, record: PRIVATE });
const settled = () => new Promise(resolve => setImmediate(resolve));

function receipt(overrides = {}) {
    return {
        receiptId: 'synthetic-receipt', invitationId: 'synthetic-invitation',
        subjectKey: SUBJECT, tenantId: TENANT, organisationId: 'synthetic-organisation',
        termsVersion: 'synthetic-v1', termsDigest: TERMS_DIGEST,
        acceptedAt: AT - 500, status: 'pending_admission', dashboardAccess: false,
        ...overrides
    };
}
function registration(saved = receipt(), overrides = {}) {
    const { dashboardAccess, acceptedAt, ...reference } = saved;
    return { ...reference, revision: 1, ...overrides };
}
function payload(saved) {
    const deleteAfter = new Date(saved.acceptedAt);
    deleteAfter.setUTCFullYear(deleteAfter.getUTCFullYear() + 7);
    return { schemaVersion: 1, retentionPolicyId: RETENTION_POLICY_ID,
        deleteAfter: deleteAfter.valueOf(), receipt: saved };
}
function database(saved = null) {
    const query = jest.fn(async () => ({ rows: saved ? [{ payload: payload(saved) }] : [] }));
    return { query, withTenantTransaction: jest.fn(async (_tenant, work) => work({ query })) };
}
function diagnosticEvent(stage, code = 'signup_state_unavailable', timestamp = expect.any(String)) {
    return { timestamp, code, stage };
}
function assertPrivateOutput(events) {
    expect(JSON.stringify(events)).not.toContain(PRIVATE);
    for (const event of events) {
        expect(Object.keys(event).sort()).toEqual(['code', 'stage', 'timestamp']);
        expect(Object.isFrozen(event)).toBe(true);
        expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
    }
}
function journalHarness({ accepted = false, ...overrides } = {}) {
    const saved = receipt();
    const record = {
        schemaVersion: 1, invitationId: saved.invitationId, tokenDigest: DIGEST,
        expectedEmail: 'synthetic@example.invalid', tenantId: TENANT,
        organisationId: saved.organisationId, identityPolicyId: 'synthetic-policy',
        termsVersion: saved.termsVersion, termsDigest: TERMS_DIGEST, mfaRequired: true,
        createdAt: AT - 1000, expiresAt: AT + 60000,
        status: accepted ? 'accepted' : 'invited', revision: accepted ? 1 : 0,
        acceptance: accepted ? saved : null
    };
    const events = [];
    const dependencies = {
        store: { read: jest.fn(async () => record), transact: jest.fn() },
        verifyIdentity: jest.fn(async () => ({ subjectKey: SUBJECT,
            email: 'synthetic@example.invalid', emailVerified: true,
            identityPolicyId: 'synthetic-policy', mfaSatisfied: true,
            invitationDigest: DIGEST, verifiedAt: AT - 1000, expiresAt: AT + 60000 })),
        database: database(accepted ? saved : null),
        resolveContext: jest.fn(async () => ({ invitationDigest: DIGEST, identityProofHandle: PRIVATE })),
        resolveTerms: jest.fn(async () => ({ termsText: TERMS_TEXT,
            termsVersion: saved.termsVersion, termsDigest: TERMS_DIGEST })),
        contextMode: 'verified-digest', now: () => AT,
        diagnostics: event => events.push(event), ...overrides
    };
    return { events, dependencies, saved, record,
        handlers: createJournaledSignupHandlers(dependencies) };
}
function continuationHarness(overrides = {}) {
    const events = [];
    const saved = receipt();
    const dependencies = {
        readSessionDetails: jest.fn(async () => ({ identity: { provider: 'entra-bff',
            isAuthenticated: true, tenantId: TENANT, principalId: PRINCIPAL, subjectKey: SUBJECT },
        expiresAt: new Date(AT + 60000).toISOString() })),
        readRegistration: jest.fn(async () => registration(saved)), database: database(saved),
        now: () => AT, diagnostics: event => events.push(event), ...overrides
    };
    return { events, dependencies, saved,
        load: createSessionBoundSignupContinuation(dependencies) };
}
function recoveryReference(saved = receipt()) {
    const { subjectKey, tenantId, organisationId, invitationId, termsVersion, termsDigest } = saved;
    return { subjectKey, tenantId, organisationId, invitationId, termsVersion, termsDigest };
}

describe('signup diagnostics privacy and failure isolation', () => {
    test('emits only a fixed timestamp, allowed code and stage as frozen data', () => {
        const events = [];
        createSignupDiagnostics({ now: () => AT, sink: event => events.push(event) })(
            'invitation_inspection', error('signup_invitation_unavailable'));
        expect(events).toEqual([diagnosticEvent('invitation_inspection', 'signup_invitation_unavailable', new Date(AT).toISOString())]);
        assertPrivateOutput(events);
    });

    test.each([
        ['unknown code', () => error(PRIVATE)],
        ['message-only error', () => new Error(PRIVATE)],
        ['string error', () => PRIVATE],
        ['inherited code', () => Object.create({ code: 'signup_invitation_unavailable' })],
        ['non-string code', () => ({ code: { toString() { throw new Error(PRIVATE); } } })],
        ['getter', () => Object.defineProperty({}, 'code', { get() { throw new Error(PRIVATE); } })],
        ['proxy', () => new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(PRIVATE); } })]
    ])('uses a fixed fallback for %s without serialising the error', (_name, makeError) => {
        const events = [];
        const report = createSignupDiagnostics({ now: () => AT, sink: event => events.push(event) });
        expect(() => report('signup_context', makeError())).not.toThrow();
        expect(events).toEqual([diagnosticEvent('signup_context', undefined, new Date(AT).toISOString())]);
        assertPrivateOutput(events);
    });

    test('does not execute a code getter or proxy trap', () => {
        const getter = jest.fn(() => 'signup_invitation_unavailable');
        const trap = jest.fn(() => ({ value: 'signup_invitation_unavailable', configurable: true }));
        const report = createSignupDiagnostics({ now: () => AT });
        report('signup_context', Object.defineProperty({}, 'code', { get: getter }));
        report('signup_context', new Proxy({}, { getOwnPropertyDescriptor: trap }));
        expect(getter).not.toHaveBeenCalled();
        expect(trap).not.toHaveBeenCalled();
    });

    test('invalid stages and fallbacks cannot carry arbitrary data into output', () => {
        const events = [];
        const report = createSignupDiagnostics({ now: () => AT, sink: event => events.push(event) });
        report(PRIVATE, error(PRIVATE), PRIVATE);
        expect(events).toEqual([diagnosticEvent('signup_state', undefined, new Date(AT).toISOString())]);
        assertPrivateOutput(events);
    });

    test('a broken diagnostic clock cannot break application failure handling', () => {
        for (const now of [() => NaN, () => -1, () => { throw new Error(PRIVATE); }]) {
            const sink = jest.fn();
            const report = createSignupDiagnostics({ now, sink });
            expect(() => report('signup_state', error('signup_store_unavailable'))).not.toThrow();
            expect(sink).not.toHaveBeenCalled();
        }
    });

    test('throwing and asynchronously rejecting sinks cannot change the caller outcome', async () => {
        for (const sink of [() => { throw new Error(PRIVATE); }, () => Promise.reject(new Error(PRIVATE))]) {
            const report = createSignupDiagnostics({ now: () => AT, sink });
            expect(() => report('signup_state', error('signup_store_unavailable'))).not.toThrow();
        }
        await settled();
    });
});

describe('journaled signup swallowed-failure diagnostics', () => {
    test('reports an inner invitation failure without changing the public unavailable state', async () => {
        const harness = journalHarness();
        harness.dependencies.store.read.mockResolvedValue(null);
        await expect(harness.handlers.loadState(req())).resolves.toEqual(unavailable);
        expect(harness.events).toEqual([diagnosticEvent('invitation_inspection', 'signup_invitation_unavailable')]);
        expect(harness.dependencies.store.transact).not.toHaveBeenCalled();
        assertPrivateOutput(harness.events);
    });

    test('distinguishes context resolution and unavailable continuation outcomes', async () => {
        const failedContext = journalHarness({ resolveContext: async () => { throw error('signup_identity_required'); } });
        await expect(failedContext.handlers.loadState(req())).resolves.toEqual(unavailable);
        expect(failedContext.events).toEqual([diagnosticEvent('signup_context', 'signup_identity_required')]);
        for (const status of ['unavailable', 'resume_acceptance']) {
            const missing = journalHarness({ resolveContext: async () => null,
                loadContinuationState: async () => ({ status }) });
            await expect(missing.handlers.loadState(req())).resolves.toEqual(unavailable);
            expect(missing.events).toEqual([diagnosticEvent('signup_continuation', 'signup_continuation_unavailable')]);
        }
    });

    test('reports the durable journal read after a successful invitation inspection', async () => {
        const harness = journalHarness({ accepted: true });
        // The invitation adapter hydrates from the journal during its own read.
        // Let that first read succeed, then fail the explicit acknowledgement read.
        harness.dependencies.database.query.mockReset()
            .mockResolvedValueOnce({ rows: [{ payload: payload(harness.saved) }] })
            .mockRejectedValueOnce(error('provider_private_error'));
        await expect(harness.handlers.loadState(req())).resolves.toEqual(unavailable);
        expect(harness.events).toEqual([diagnosticEvent('acceptance_journal', 'signup_acceptance_journal_unavailable')]);
        assertPrivateOutput(harness.events);
    });

    test('reports terms resolution failure while preserving its public unavailable state', async () => {
        const harness = journalHarness({ resolveTerms: async () => { throw error('provider_private_error'); } });
        await expect(harness.handlers.loadState(req())).resolves.toEqual(unavailable);
        expect(harness.events).toEqual([diagnosticEvent('terms_offer', 'signup_terms_unavailable')]);
    });

    test('registration, identity and registration rechecks identify the failed boundary', async () => {
        const makeRegistrationStore = () => ({ registerAcceptance: jest.fn(),
            readForInvitation: jest.fn(async () => registration()) });
        const first = journalHarness({ accepted: true, registrationStore: makeRegistrationStore() });
        first.dependencies.registrationStore.readForInvitation.mockRejectedValue(error('signup_registration_unavailable'));
        await expect(first.handlers.loadState(req())).resolves.toEqual(unavailable);
        expect(first.events).toEqual([diagnosticEvent('registration', 'signup_registration_unavailable')]);

        const identity = journalHarness({ accepted: true, registrationStore: makeRegistrationStore() });
        const validProof = await identity.dependencies.verifyIdentity();
        identity.dependencies.verifyIdentity.mockReset().mockResolvedValueOnce(validProof)
            .mockRejectedValueOnce(error('provider_private_error'));
        await expect(identity.handlers.loadState(req())).resolves.toEqual(unavailable);
        expect(identity.events).toEqual([diagnosticEvent('identity_recheck', 'signup_identity_required')]);

        const revision = journalHarness({ accepted: true, registrationStore: makeRegistrationStore() });
        revision.dependencies.registrationStore.readForInvitation.mockResolvedValueOnce(registration())
            .mockResolvedValueOnce(registration(receipt(), { revision: 2 }));
        await expect(revision.handlers.loadState(req())).resolves.toEqual(unavailable);
        expect(revision.events).toEqual([diagnosticEvent('registration_recheck')]);
        assertPrivateOutput([...first.events, ...identity.events, ...revision.events]);
    });

    test('proof expiry during terms retrieval is reported after I/O and cannot offer terms', async () => {
        let at = AT;
        const harness = journalHarness({ now: () => at, resolveTerms: async () => {
            at = AT + 60000;
            return { termsText: TERMS_TEXT, termsVersion: 'synthetic-v1', termsDigest: TERMS_DIGEST };
        } });
        await expect(harness.handlers.loadState(req())).resolves.toEqual(unavailable);
        expect(harness.events).toEqual([diagnosticEvent('proof_recheck', 'signup_identity_required')]);
    });

    test('successful terms and saved pending admission produce no failure event', async () => {
        const terms = journalHarness();
        await expect(terms.handlers.loadState(req())).resolves.toEqual({ status: 'terms',
            termsText: TERMS_TEXT, termsVersion: 'synthetic-v1', termsDigest: TERMS_DIGEST });
        expect(terms.events).toEqual([]);
        const pending = journalHarness({ accepted: true });
        await expect(pending.handlers.loadState(req())).resolves.toEqual({ status: 'pending_admission' });
        expect(pending.events).toEqual([]);
    });

    test('logger failures preserve the same fail-closed result', async () => {
        for (const diagnostics of [() => { throw new Error(PRIVATE); }, () => Promise.reject(new Error(PRIVATE))]) {
            const harness = journalHarness({ diagnostics });
            harness.dependencies.store.read.mockResolvedValue(null);
            await expect(harness.handlers.loadState(req())).resolves.toEqual(unavailable);
        }
        await settled();
    });

    test('concurrent requests cannot overwrite each other\'s failure stage', async () => {
        let rejectFirst;
        let firstStarted;
        const started = new Promise(resolve => { firstStarted = resolve; });
        const firstRead = new Promise((_resolve, reject) => { rejectFirst = reject; });
        const harness = journalHarness({ resolveContext: async request => {
            if (request.marker === 'context-failure') throw error('signup_identity_required');
            return { invitationDigest: DIGEST, identityProofHandle: PRIVATE };
        } });
        harness.dependencies.store.read.mockImplementationOnce(() => { firstStarted(); return firstRead; });
        const first = harness.handlers.loadState({ marker: 'invitation-failure' });
        await started;
        await expect(harness.handlers.loadState({ marker: 'context-failure' })).resolves.toEqual(unavailable);
        rejectFirst(error('provider_private_error'));
        await expect(first).resolves.toEqual(unavailable);
        expect(harness.events).toEqual([
            diagnosticEvent('signup_context', 'signup_identity_required'),
            diagnosticEvent('invitation_inspection', 'signup_store_unavailable')
        ]);
        assertPrivateOutput(harness.events);
    });
});

describe('saved signup continuation failure stages', () => {
    test('invalid request and session failures are distinguished', async () => {
        const invalid = continuationHarness();
        await expect(invalid.load({})).resolves.toEqual(unavailable);
        expect(invalid.events).toEqual([diagnosticEvent('continuation_request', 'signup_continuation_unavailable')]);
        const session = continuationHarness({ readSessionDetails: async () => { throw error('browser_auth_session_expired'); } });
        await expect(session.load(req())).resolves.toEqual(unavailable);
        expect(session.events).toEqual([diagnosticEvent('continuation_session', 'browser_auth_session_expired')]);
        assertPrivateOutput(session.events);
    });

    test('invalid business clock is identified without adding diagnostic clock reads', async () => {
        const now = jest.fn(() => NaN);
        const harness = continuationHarness({ now });
        await expect(harness.load(req())).resolves.toEqual(unavailable);
        expect(harness.events).toEqual([diagnosticEvent('continuation_clock', 'signup_continuation_unavailable')]);
        expect(now).toHaveBeenCalledTimes(1);
        assertPrivateOutput(harness.events);
    });

    test('registration read failures do not become invitation-expiry diagnostics', async () => {
        const harness = continuationHarness({ readRegistration: async () => { throw error('signup_registration_unavailable'); } });
        await expect(harness.load(req())).resolves.toEqual(unavailable);
        expect(harness.events).toEqual([diagnosticEvent('continuation_registration', 'signup_registration_unavailable')]);
    });

    test('failed journal reads and explicit receipt mismatch have separate stages', async () => {
        const journal = continuationHarness();
        journal.dependencies.database.query.mockRejectedValue(error('provider_private_error'));
        await expect(journal.load(req())).resolves.toEqual(unavailable);
        expect(journal.events).toEqual([diagnosticEvent('continuation_receipt', 'signup_acceptance_journal_unavailable')]);
        const mismatch = continuationHarness({ database: database(receipt({
            subjectKey: `${TENANT}:33333333-3333-3333-3333-333333333333`
        })) });
        await expect(mismatch.load(req())).resolves.toEqual(unavailable);
        expect(mismatch.events).toEqual([diagnosticEvent('continuation_receipt_match', 'signup_continuation_unavailable')]);
        assertPrivateOutput([...journal.events, ...mismatch.events]);
    });

    test('current session failure and registration revision drift remain fail-closed', async () => {
        const session = continuationHarness();
        session.dependencies.readSessionDetails.mockImplementationOnce(async () => ({
            identity: { provider: 'entra-bff', isAuthenticated: true, tenantId: TENANT,
                principalId: PRINCIPAL, subjectKey: SUBJECT }, expiresAt: new Date(AT + 60000).toISOString()
        })).mockRejectedValueOnce(error('browser_auth_session_expired'));
        await expect(session.load(req())).resolves.toEqual(unavailable);
        expect(session.events).toEqual([diagnosticEvent('continuation_session_recheck', 'browser_auth_session_expired')]);
        const changed = continuationHarness();
        changed.dependencies.readRegistration.mockResolvedValueOnce(registration())
            .mockResolvedValueOnce(registration(receipt(), { revision: 2 }));
        await expect(changed.load(req())).resolves.toEqual(unavailable);
        expect(changed.events).toEqual([diagnosticEvent('continuation_registration_recheck', 'signup_continuation_unavailable')]);
    });

    test('recovery reference failures and changes retain their own stages', async () => {
        const invalid = continuationHarness({ readRegistration: async () => null,
            readRecoveryReference: async () => null });
        await expect(invalid.load(req())).resolves.toEqual(unavailable);
        expect(invalid.events).toEqual([diagnosticEvent('continuation_recovery_reference', 'signup_continuation_unavailable')]);
        const readRecoveryReference = jest.fn().mockResolvedValueOnce(recoveryReference())
            .mockResolvedValueOnce({ ...recoveryReference(), termsVersion: 'synthetic-v2' });
        const changed = continuationHarness({ readRegistration: async () => null, readRecoveryReference });
        await expect(changed.load(req())).resolves.toEqual(unavailable);
        expect(changed.events).toEqual([diagnosticEvent('continuation_reference_recheck', 'signup_continuation_unavailable')]);
    });

    test('successful pending admission and receipt recovery do not log a failure', async () => {
        const pending = continuationHarness();
        await expect(pending.load(req())).resolves.toEqual({ status: 'pending_admission' });
        expect(pending.events).toEqual([]);
        const recovery = continuationHarness({ readRegistration: async () => null,
            readRecoveryReference: async () => recoveryReference() });
        await expect(recovery.load(req())).resolves.toEqual({ status: 'resume_acceptance' });
        expect(recovery.events).toEqual([]);
    });

    test('throwing and rejecting diagnostic sinks cannot allow or reject a continuation', async () => {
        for (const diagnostics of [() => { throw new Error(PRIVATE); }, () => Promise.reject(new Error(PRIVATE))]) {
            const harness = continuationHarness({ diagnostics, readRegistration: async () => null });
            await expect(harness.load(req())).resolves.toEqual(unavailable);
            const success = continuationHarness({ diagnostics });
            await expect(success.load(req())).resolves.toEqual({ status: 'pending_admission' });
        }
        await settled();
    });
});

describe('source-owned preparation failure codes', () => {
    const { createPostgresDatabase, PostgresDatabaseError } = require('../api/shared/database/postgres');
    const { AzureStarterAccountStore } = require('../api/shared/customerSignup/azureStarterAccountStore');
    const records = require('../api/shared/appLifecycle/dashboardRuntimeRecords');

    async function observeFailure(work) {
        const events = [];
        const report = createSignupDiagnostics({ now: () => AT, sink: event => events.push(event) });
        let caught;
        try { await work(); } catch (failure) {
            caught = failure;
            report('organisation_preparation', failure);
        }
        expect(caught).toBeDefined();
        assertPrivateOutput(events);
        return { caught, events };
    }

    test.each([
        ['connection', 'postgres_connection_failed'],
        ['begin', 'postgres_begin_failed'],
        ['tenant context', 'postgres_tenant_context_failed'],
        ['query', 'postgres_query_failed'],
        ['commit', 'postgres_commit_failed'],
        ['rollback', 'postgres_rollback_failed']
    ])('preserves the database adapter code when %s fails without exposing driver details', async (boundary, expectedCode) => {
        const driverFailure = error('SYNTHETIC_DRIVER_CODE_' + PRIVATE);
        const client = {
            query: jest.fn(async sql => {
                if (boundary === 'begin' && sql === 'BEGIN' ||
                    boundary === 'tenant context' && sql.startsWith('SELECT set_config(') ||
                    ['query', 'rollback'].includes(boundary) && sql === 'SELECT synthetic_value' ||
                    boundary === 'commit' && sql === 'COMMIT' ||
                    boundary === 'rollback' && sql === 'ROLLBACK') throw driverFailure;
                return { rows: [] };
            }),
            release: jest.fn()
        };
        const database = createPostgresDatabase({ pool: {
            connect: async () => {
                if (boundary === 'connection') throw driverFailure;
                return client;
            }, end: async () => {}
        } });
        const { caught, events } = await observeFailure(() => database.withTenantTransaction(TENANT,
            tx => tx.query('SELECT synthetic_value', [PRIVATE])));
        expect(caught).toBeInstanceOf(PostgresDatabaseError);
        expect(events).toEqual([diagnosticEvent('organisation_preparation', expectedCode, new Date(AT).toISOString())]);
        if (boundary !== 'connection') expect(client.release).toHaveBeenCalledTimes(1);
    });

    test('retains the starter adapter failure code after a synthetic download failure', async () => {
        const download = jest.fn(async () => { throw error('SYNTHETIC_PROVIDER_' + PRIVATE); });
        const store = new AzureStarterAccountStore({ getBlockBlobClient: () => ({ download }) });
        const { events } = await observeFailure(() => store.load('starter-accounts/' + DIGEST));
        expect(download).toHaveBeenCalledTimes(1);
        expect(events).toEqual([diagnosticEvent('organisation_preparation', 'starter_store_unavailable', new Date(AT).toISOString())]);
    });

    test.each([
        ['strict input fields', () => records.fields({ unexpected: PRIVATE }, ['required']), 'onboarding_input_invalid'],
        ['retained row codec', () => records.normaliseAdmissionRows({ unexpected: PRIVATE }), 'onboarding_record_invalid']
    ])('retains the source validator code for %s without retaining its input', async (_description, work, expectedCode) => {
        const { events } = await observeFailure(work);
        expect(events).toEqual([diagnosticEvent('organisation_preparation', expectedCode, new Date(AT).toISOString())]);
    });

    test('nearby unapproved source codes still use the fixed fallback', async () => {
        const database = createPostgresDatabase({ pool: {
            connect: jest.fn(), end: async () => {}
        } });
        await database.close();
        const store = new AzureStarterAccountStore({ getBlockBlobClient: jest.fn() });
        const works = [
            () => database.withTenantTransaction(TENANT, async () => {}),
            () => store.load(PRIVATE),
            () => records.copy({ synthetic: PRIVATE }, 1)
        ];
        for (const work of works) {
            const { events } = await observeFailure(work);
            expect(events).toEqual([diagnosticEvent('organisation_preparation', undefined, new Date(AT).toISOString())]);
        }
    });

    test('newly allowed codes cannot be supplied through getters or proxy exceptions', () => {
        const events = [];
        const report = createSignupDiagnostics({ now: () => AT, sink: event => events.push(event) });
        const getter = jest.fn(() => 'postgres_query_failed');
        const accessorError = new PostgresDatabaseError();
        Object.defineProperty(accessorError, 'code', { get: getter });
        const trap = jest.fn(() => ({ value: 'starter_store_unavailable', configurable: true }));
        const proxyError = new Proxy(new Error(PRIVATE), { getOwnPropertyDescriptor: trap });
        for (const failure of [accessorError, proxyError]) report('organisation_preparation', failure);
        expect(getter).not.toHaveBeenCalled();
        expect(trap).not.toHaveBeenCalled();
        expect(events).toEqual([
            diagnosticEvent('organisation_preparation', undefined, new Date(AT).toISOString()),
            diagnosticEvent('organisation_preparation', undefined, new Date(AT).toISOString())
        ]);
        assertPrivateOutput(events);
    });
});
