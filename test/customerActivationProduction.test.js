'use strict';

// In-memory Blob protocol tests for the real production port. No Azure, SQL,
// account, email, customer acceptance or production effects are performed.
const { Readable } = require('node:stream');
const { createCustomerActivationPort, createProductionCustomerActivation } = require('../lib/customerActivationProduction');
const { buildActivationCommands, activationKey, completionKey, activationReferenceKey, activationReference } = require('../api/shared/customerSignup/customerActivation');
const { subjectHash } = require('../api/shared/customerSignup/customerAuthority');
const { canonicalDigest } = require('../api/shared/appLifecycle/dashboardOnboardingDomain');
const { createBootstrapOperations } = require('../api/shared/appLifecycle/postgresDashboardBootstrap');
const { createMembershipState, applyMembershipCommand } = require('../api/shared/appLifecycle/membershipDomain');
const { fixture, NOW, SUBJECT } = require('./fixtures/dashboardFixture');
const { activationReservationFixture } = require('./helpers/activationReservationFixture');
const AT = Date.parse(NOW), START = AT - 3600000, END = AT + 3600000;
const SHA = 'a'.repeat(40), uuid = n => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OPERATOR = `${uuid(1)}:${uuid(2)}`;
const iso = at => new Date(at).toISOString(), clone = value => JSON.parse(JSON.stringify(value));
const subjectKey = subject => `customer-subjects/${subjectHash(subject)}.json`;
const storageError = (statusCode, code) => Object.assign(new Error('synthetic_storage_failure'), { statusCode, code });

function sample() {
    const f = fixture();
    const membershipState = applyMembershipCommand(createMembershipState(f.tenantAggregate, f.scope, iso(START)), f.tenantAggregate,
        { ...f.scope, expectedRevision: 0, actorSubjectKey: OPERATOR, now: iso(START), action: 'invite',
            payload: { invitationId: uuid(3), subjectKey: SUBJECT, roles: ['admin'], validFrom: iso(START),
                validUntil: iso(END), grantEvidenceId: 'synthetic-approval', expiresAt: iso(END) } });
    const current = { schemaVersion: 2, subjectKey: SUBJECT, email: 'synthetic@example.test', revision: 0, status: 'active',
        invitationDigest: 'a'.repeat(64), invitationId: uuid(3), ...f.scope, termsVersion: 'synthetic-terms',
        termsDigest: 'b'.repeat(64), scheduleId: 'synthetic-schedule', scheduleDigest: 'c'.repeat(64), bindingId: null, expiresAt: END };
    const approval = { schemaVersion: 1, activationId: uuid(4), approvalRef: 'synthetic-approval', approvedBy: OPERATOR,
        approvedAt: iso(START), expiresAt: iso(END), authoritySha256: canonicalDigest(current), authorityRevision: 0,
        subjectKey: SUBJECT, invitationId: uuid(3), membershipId: 'synthetic-member', termsVersion: current.termsVersion,
        termsDigest: current.termsDigest, scheduleId: current.scheduleId, scheduleDigest: current.scheduleDigest,
        scope: f.scope, identity: { policyId: 'synthetic-policy', policyRevision: 0, issuer: 'https://identity.example.test/v2.0',
            identityTenantId: SUBJECT.slice(0, 36), oid: SUBJECT.slice(37), audience: 'synthetic-client' },
        bootstrapOperationId: uuid(5), acceptOperationId: uuid(6), publicationOperationId: uuid(7), bindingId: uuid(8),
        authorityRef: { authorityId: uuid(9), revision: 0, sha256: 'd'.repeat(64) },
        bootstrapExpectedRevisions: { tenant: null, organisation: null, membership: null, entitlement: null,
            flags: null, advisorAssignments: [], usage: [] },
        initialState: { tenantAggregate: f.tenantAggregate, membershipState, entitlementState: f.entitlementState,
            flags: f.flags, advisorAssignments: [] } };
    return clone({ approval, current });
}
function resultFor(a, observedAt = AT) {
    return { schemaVersion: 2, activationId: a.activationId, phase: 'activated', approvalSha256: canonicalDigest(a),
        bootstrapReference: createBootstrapOperations({ clock: () => a.approvedAt, authoriseAdministration: () => false })
            .prepareInitialisation(buildActivationCommands(a).bootstrap, a.initialState).expectedReference,
        membershipOperationId: a.acceptOperationId, membershipResultSha256: 'a'.repeat(64),
        membershipReservationOperationId: buildActivationCommands(a).reserveMembership.operationId,
        membershipReservationResultSha256: canonicalDigest(activationReservationFixture(a)),
        membershipReservationResult: activationReservationFixture(a),
        publicationOperationId: a.publicationOperationId, publicationResultSha256: 'b'.repeat(64), bindingId: a.bindingId,
        acceptanceReceiptId: uuid(10), acceptanceSha256: 'c'.repeat(64), authorityRevision: a.authorityRevision,
        authoritySha256: a.authoritySha256, observedAt: iso(observedAt) };
}
function memory(initial = {}) {
    const rows = new Map(), reads = new Map(), writes = [], streams = [];
    let version = 0;
    const state = { rows, reads, writes, streams, beforeRead: null, transformRead: null, beforeUpload: null, afterUpload: null };
    state.put = (key, value) => { rows.set(key, { value: clone(value), etag: `"${++version}"` }); };
    Object.entries(initial).forEach(([key, value]) => state.put(key, value));
    state.container = { getBlockBlobClient(key) { return {
        async download(offset, count, options) {
            expect(offset).toBe(0); expect(count).toBe(524289); expect(options.abortSignal).toBeDefined();
            const calls = (reads.get(key) || 0) + 1; reads.set(key, calls);
            await state.beforeRead?.(key, calls);
            const row = rows.get(key); if (!row) throw storageError(404, 'BlobNotFound');
            const bytes = Buffer.from(JSON.stringify(row.value)), readableStreamBody = Readable.from([bytes]);
            streams.push(readableStreamBody);
            const response = { contentLength: bytes.length, etag: row.etag, readableStreamBody };
            return state.transformRead ? state.transformRead(response, key, calls) : response;
        },
        async uploadData(bytes, options) {
            const value = JSON.parse(bytes.toString('utf8')); writes.push({ key, value, options });
            await state.beforeUpload?.(key, value, options);
            const row = rows.get(key);
            if (options.conditions.ifNoneMatch === '*' && row || options.conditions.ifMatch && row?.etag !== options.conditions.ifMatch) {
                throw storageError(412, 'ConditionNotMet');
            }
            state.put(key, value); await state.afterUpload?.(key, value, options);
        }
    }; } };
    return state;
}
function harness(change) {
    const s = sample(); change?.(s);
    const records = memory({ [activationKey(s.approval.activationId)]: s.approval, [subjectKey(SUBJECT)]: s.current });
    const sessions = memory(), time = { at: AT }, source = { sha: SHA };
    const reservation = { result: clone(activationReservationFixture(s.approval)) };
    const readMembershipReservation = jest.fn(async () => clone(reservation.result));
    const port = createCustomerActivationPort({ authorityContainer: records.container, sessionContainer: sessions.container,
        now: () => time.at, readSourceSha: () => source.sha, readMembershipReservation });
    return { ...s, records, sessions, time, source, reservation, readMembershipReservation, port,
        result: clone(resultFor(s.approval)), key: completionKey(s.approval.activationId) };
}

describe('production activation Blob port', () => {
    test.each(['missing operation', 'wrong operation', 'missing digest', 'invalid digest', 'wrong valid digest', 'missing result', 'legacy result'])
    ('rejects completion with %s quota evidence before a Blob write', async defect => {
        const h = harness();
        if (defect === 'missing operation') delete h.result.membershipReservationOperationId;
        if (defect === 'wrong operation') h.result.membershipReservationOperationId = `initial-member:${uuid(99)}`;
        if (defect === 'missing digest') delete h.result.membershipReservationResultSha256;
        if (defect === 'invalid digest') h.result.membershipReservationResultSha256 = 'invalid';
        if (defect === 'wrong valid digest') h.result.membershipReservationResultSha256 = 'f'.repeat(64);
        if (defect === 'missing result') delete h.result.membershipReservationResult;
        if (defect === 'legacy result') h.result.schemaVersion = 1;
        await expect(h.port.writeCompletion(h.result)).rejects.toThrow();
        expect(h.sessions.writes).toEqual([]);
    });
    test.each(['missing receipt', 'wrong scope', 'wrong operation', 'wrong amount', 'unavailable SQL'])
    ('rejects %s from the independent committed quota reader before a completion write', async defect => {
        const h = harness();
        if (defect === 'missing receipt') h.reservation.result = null;
        if (defect === 'wrong scope') h.reservation.result.usage.organisationId = 'foreign-org';
        if (defect === 'wrong operation') h.reservation.result.operationId = 'foreign-operation';
        if (defect === 'wrong amount') h.reservation.result.usage.counters.memberships = 0;
        if (defect === 'unavailable SQL') h.readMembershipReservation.mockRejectedValue(new Error('synthetic SQL failure'));
        await expect(h.port.writeCompletion(h.result)).rejects.toThrow();
        expect(h.readMembershipReservation).toHaveBeenCalledWith(h.approval);
        expect(h.sessions.writes).toEqual([]);
    });
    test('preparation lookup requires the exact owner-published reference and current approval', async () => {
        const h = harness();
        await expect(h.port.readPreparation(h.current)).resolves.toBeNull();
        const key = activationReferenceKey(h.current);
        h.records.put(key, activationReference(h.approval));
        await expect(h.port.readPreparation(h.current)).resolves.toEqual(h.approval);
    });
    test.each(['wrong digest', 'wrong activation', 'extra field', 'expired approval', 'changed authority'])
    ('preparation lookup rejects %s without writes', async defect => {
        const h = harness(), key = activationReferenceKey(h.current), reference = clone(activationReference(h.approval));
        if (defect === 'wrong digest') reference.approvalSha256 = 'f'.repeat(64);
        if (defect === 'wrong activation') reference.activationId = uuid(99);
        if (defect === 'extra field') reference.approved = true;
        if (defect === 'expired approval') h.time.at = Date.parse(h.approval.expiresAt);
        if (defect === 'changed authority') h.records.put(subjectKey(SUBJECT), { ...h.current, revision: h.current.revision + 1 });
        h.records.put(key, reference);
        await expect(h.port.readPreparation(h.current)).rejects.toThrow();
        expect(h.records.writes).toEqual([]); expect(h.sessions.writes).toEqual([]);
    });
    test('reads exact detached authority and writes only a bounded transient completion', async () => {
        const h = harness(), loaded = await h.port.read(h.approval.activationId);
        expect(loaded).toEqual({ approval: h.approval, authority: h.current });
        expect(Object.isFrozen(loaded.approval.initialState)).toBe(true);
        await h.port.writeCompletion(h.result);
        expect(h.records.writes).toEqual([]);
        const record = h.sessions.rows.get(h.key).value, write = h.sessions.writes[0];
        expect(record).toEqual({ schemaVersion: 1, sourceSha: SHA, result: h.result, expiresAt: iso(AT + 300000) });
        expect(write.options.conditions).toEqual({ ifNoneMatch: '*' });
        expect(write.options.blobHTTPHeaders).toEqual({ blobContentType: 'application/json', blobCacheControl: 'no-store' });
        expect(h.sessions.streams.every(stream => stream.destroyed)).toBe(true);
    });

    test('caps evidence expiry at the earlier approval expiry and original observation plus five minutes', async () => {
        const h = harness(s => { s.approval.expiresAt = iso(AT + 120000); });
        h.result.observedAt = iso(AT - 50000);
        await h.port.writeCompletion(h.result);
        expect(h.sessions.rows.get(h.key).value.expiresAt).toBe(iso(AT + 120000));
        const other = harness(); other.result.observedAt = iso(AT - 50000);
        await other.port.writeCompletion(other.result);
        expect(other.sessions.rows.get(other.key).value.expiresAt).toBe(iso(AT + 250000));
    });

    test.each([
        ['revised authority', current => { current.revision += 1; }],
        ['revoked authority', current => { current.status = 'revoked'; }],
        ['published pointer', current => { current.bindingId = uuid(8); }],
        ['different terms', current => { current.termsDigest = 'e'.repeat(64); }]
    ])('denies %s that changes between the first read and write boundary', async (_, change) => {
        const h = harness();
        h.records.beforeRead = (key, count) => {
            if (key === subjectKey(SUBJECT) && count === 2) {
                const next = clone(h.current); change(next); h.records.put(key, next);
            }
        };
        await expect(h.port.writeCompletion(h.result)).rejects.toThrow();
        expect(h.sessions.writes).toEqual([]);
    });

    test('denies immutable approval changes at the final read', async () => {
        const h = harness();
        h.records.beforeRead = (key, count) => {
            if (key === activationKey(h.approval.activationId) && count === 2) {
                const next = clone(h.approval); next.approvalRef = 'replacement'; h.records.put(key, next);
            }
        };
        await expect(h.port.writeCompletion(h.result)).rejects.toThrow(); expect(h.sessions.writes).toEqual([]);
    });

    test('recreates lifecycle-deleted evidence from a fresh canonical result and CAS-updates existing evidence', async () => {
        const h = harness(); await h.port.writeCompletion(h.result);
        const etag = h.sessions.rows.get(h.key).etag;
        h.time.at += 20000;
        await h.port.writeCompletion({ ...h.result, observedAt: iso(h.time.at) });
        expect(h.sessions.writes[1].options.conditions).toEqual({ ifMatch: etag });
        h.sessions.rows.delete(h.key); h.time.at += 20000;
        await h.port.writeCompletion({ ...h.result, observedAt: iso(h.time.at) });
        expect(h.sessions.writes[2].options.conditions).toEqual({ ifNoneMatch: '*' });
        expect(h.sessions.rows.get(h.key).value.expiresAt).toBe(iso(h.time.at + 300000));
    });

    test('an ambiguous upload succeeds only when exact persisted bytes are read back', async () => {
        const h = harness(); h.sessions.afterUpload = () => { throw new Error('synthetic_transport_ambiguity'); };
        await expect(h.port.writeCompletion(h.result)).resolves.toBeUndefined();
        expect(h.sessions.rows.get(h.key).value.result).toEqual(h.result);
        const changed = harness();
        changed.sessions.afterUpload = (key, value) => {
            changed.sessions.put(key, { ...value, sourceSha: 'b'.repeat(40) }); throw new Error('synthetic_transport_ambiguity');
        };
        await expect(changed.port.writeCompletion(changed.result)).rejects.toThrow();
        const missing = harness(); missing.sessions.beforeUpload = () => { throw new Error('synthetic_transport_ambiguity'); };
        await expect(missing.port.writeCompletion(missing.result)).rejects.toThrow();
        expect(missing.sessions.rows.has(missing.key)).toBe(false);
    });

    test('does not overwrite a concurrent conflicting completion or completion from another approval', async () => {
        const h = harness();
        h.sessions.beforeUpload = (key, value) => h.sessions.put(key, { ...value, sourceSha: 'b'.repeat(40) });
        await expect(h.port.writeCompletion(h.result)).rejects.toThrow();
        expect(h.sessions.rows.get(h.key).value.sourceSha).toBe('b'.repeat(40));
        const prior = harness(); prior.sessions.put(prior.key, { result: { approvalSha256: 'e'.repeat(64) } });
        await expect(prior.port.writeCompletion(prior.result)).rejects.toThrow(); expect(prior.sessions.writes).toEqual([]);
    });

    test.each([undefined, null, '', 'not-a-source', 'a'.repeat(39), 'A'.repeat(40)])('denies missing or malformed source manifest identity %s', async sha => {
        const h = harness(); h.source.sha = sha;
        await expect(h.port.writeCompletion(h.result)).rejects.toThrow(); expect(h.sessions.writes).toEqual([]);
    });

    test.each([
        ['future observation', result => { result.observedAt = iso(AT + 1); }],
        ['stale observation', result => { result.observedAt = iso(AT - 60001); }],
        ['wrong binding', result => { result.bindingId = uuid(20); }],
        ['foreign scope', result => { result.bootstrapReference.organisationId = 'foreign'; }],
        ['wrong authority hash', result => { result.authoritySha256 = 'e'.repeat(64); }],
        ['unknown field', result => { result.accessGranted = true; }]
    ])('denies %s before upload', async (_, mutate) => {
        const h = harness(); mutate(h.result);
        await expect(h.port.writeCompletion(h.result)).rejects.toThrow(); expect(h.sessions.writes).toEqual([]);
    });

    test('expiry during I/O denies completion without an upload', async () => {
        const h = harness(s => { s.approval.expiresAt = iso(AT + 1); });
        h.records.beforeRead = (key, count) => { if (key === subjectKey(SUBJECT) && count === 2) h.time.at = AT + 1; };
        await expect(h.port.writeCompletion(h.result)).rejects.toThrow(); expect(h.sessions.writes).toEqual([]);
    });

    test.each([
        ['oversized response', response => ({ ...response, contentLength: 524289 })],
        ['truncated body', response => ({ ...response, contentLength: response.contentLength + 1 })],
        ['missing ETag', response => ({ ...response, etag: '' })]
    ])('bounds stored reads and closes the stream for %s', async (_, change) => {
        const h = harness(); h.records.transformRead = change;
        await expect(h.port.read(h.approval.activationId)).rejects.toThrow();
        expect(h.records.streams.length).toBeGreaterThan(0);
        expect(h.records.streams.every(stream => stream.destroyed)).toBe(true);
    });

    test('missing authority is not treated as optional absence', async () => {
        const h = harness(); h.records.rows.delete(subjectKey(SUBJECT));
        await expect(h.port.read(h.approval.activationId)).rejects.toThrow();
    });
});

describe('production activation factory', () => {
    const env = { NOFRIES_CUSTOMER_SIGNUP_ENABLED: 'true', NOFRIES_ADMIN_SUBJECTS: OPERATOR,
        AZURE_STORAGE_ACCOUNT_NAME: 'syntheticdata', NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT: 'syntheticauth',
        NOFRIES_CUSTOMER_AUTHORITY_CONTAINER: 'customer-authority', NOFRIES_BROWSER_AUTH_CONTAINER: 'browser-sessions' };
    test('is absent when signup, runtime or administrative identity is absent', () => {
        expect(createProductionCustomerActivation({ ...env, NOFRIES_CUSTOMER_SIGNUP_ENABLED: 'false' }, {})).toBeNull();
        expect(createProductionCustomerActivation(env, null)).toBeNull();
        expect(createProductionCustomerActivation({ ...env, NOFRIES_ADMIN_SUBJECTS: '' }, {})).toBeNull();
    });
    test.each([
        ['same account', value => { value.AZURE_STORAGE_ACCOUNT_NAME = value.NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT; }],
        ['same container', value => { value.NOFRIES_CUSTOMER_AUTHORITY_CONTAINER = value.NOFRIES_BROWSER_AUTH_CONTAINER; }],
        ['invalid account', value => { value.AZURE_STORAGE_ACCOUNT_NAME = 'unsafe/path'; }],
        ['invalid container', value => { value.NOFRIES_CUSTOMER_AUTHORITY_CONTAINER = 'unsafe--container'; }]
    ])('denies %s before constructing cloud clients', (_, mutate) => {
        const value = { ...env }; mutate(value);
        const ManagedIdentityCredential = jest.fn(), BlobServiceClient = jest.fn();
        expect(() => createProductionCustomerActivation(value, {}, { ManagedIdentityCredential, BlobServiceClient })).toThrow();
        expect(ManagedIdentityCredential).not.toHaveBeenCalled(); expect(BlobServiceClient).not.toHaveBeenCalled();
    });
});
