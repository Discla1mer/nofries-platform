'use strict';

// Owner decision, 10 November 2026: customer accounts do not expire. A stored
// account end date never refuses sign-in; suspension/revocation still does, and
// provider tokens and sessions still end on their own short clocks.
const { authority, createCustomerIdentityPolicy } = require('../api/shared/customerSignup/customerAuthority');
const { createExternalCustomerIdentityPolicy } = require('../api/shared/customerSignup/externalCustomerIdentityPolicy');
const { starterAuthorityExpiry } = require('../api/shared/customerSignup/customerStarterPlan');
const { canonicalDigest } = require('../api/shared/appLifecycle/dashboardOnboardingDomain');

const NOW = Date.parse('2026-11-10T00:00:00.000Z'), DAY = 86400000, HOUR = 3600000;
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TENANT = uid(1), OID = uid(2), SUBJECT = `${TENANT}:${OID}`, APP = uid(3);
const identity = { tenantId: TENANT, principalId: OID, subjectKey: SUBJECT };
const profile = { kind: 'external-id', tenantId: TENANT, clientId: APP, authority: 'https://synthetic.ciamlogin.com/',
    issuer: `https://${TENANT}.ciamlogin.com/${TENANT}/v2.0`,
    authorizationEndpoint: `https://synthetic.ciamlogin.com/${TENANT}/oauth2/v2.0/authorize` };
// The shape production starter subjects hold today: schema 2, active, revision 0.
const record = (changes = {}) => ({ schemaVersion: 2, subjectKey: SUBJECT, email: 'owner@example.invalid', revision: 0,
    status: 'active', invitationDigest: 'a'.repeat(64), invitationId: uid(4), tenantId: uid(5), organisationId: uid(6),
    termsVersion: 'nf-dashboard-2026-09-r2', termsDigest: 'b'.repeat(64), scheduleId: uid(7), scheduleDigest: 'c'.repeat(64),
    bindingId: uid(8), accountType: 'company', expiresAt: NOW - 5 * DAY, ...changes });
const code = async work => { try { await work(); } catch (error) { return error.code; } return null; };

describe('stored account end date', () => {
    test('is validated for shape but never refuses an active account, however long ago it passed', () => {
        const stored = record({ expiresAt: NOW - 400 * DAY });
        expect(authority(stored, SUBJECT, NOW)).toEqual(stored);
        const { scheduleId, scheduleDigest, accountType, ...legacy } = record({ schemaVersion: 1, expiresAt: 1 });
        expect(scheduleId && scheduleDigest && accountType).toBeTruthy();
        expect(authority(legacy, SUBJECT, NOW).expiresAt).toBe(1);
        for (const expiresAt of [undefined, null, '2026-11-01', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            expect(() => authority(record({ expiresAt }), SUBJECT, NOW)).toThrow();
        }
    });

    test.each(['suspended', 'revoked', 'expired', ''])('status %j is still refused, with or without a future date', status => {
        for (const expiresAt of [NOW - DAY, NOW + 365 * DAY]) {
            expect(() => authority(record({ status, expiresAt }), SUBJECT, NOW)).toThrow(expect.objectContaining({
                statusCode: 401, code: 'browser_auth_customer_required' }));
        }
    });

    test('a new starter sign-up still records the plan date, and nothing enforces it afterwards', () => {
        const offerExpiresAt = NOW + 7 * DAY, written = starterAuthorityExpiry(offerExpiresAt);
        expect(written).toBe(offerExpiresAt + 14 * DAY); // Value retained for schema/digest compatibility only.
        const created = authority(record({ expiresAt: written }), SUBJECT, NOW);
        expect(authority(created, SUBJECT, written + 3650 * DAY)).toEqual(created);
    });
});

describe('email/password (External ID) sign-in', () => {
    function fixture(stored) {
        const state = { now: NOW, stored, proofTtl: HOUR, enforced: true };
        const policy = createExternalCustomerIdentityPolicy({ profile, now: () => state.now,
            records: { readSubject: async () => state.stored === null ? null : JSON.parse(JSON.stringify(state.stored)) },
            verifyAuthentication: async () => ({ subjectKey: SUBJECT, email: 'owner@example.invalid', verifiedAt: state.now,
                expiresAt: state.now + state.proofTtl, policySha256: 'd'.repeat(64) }),
            recheckAuthentication: async () => state.enforced });
        const claims = () => ({ iss: profile.issuer, tid: TENANT, oid: OID, aud: APP, exp: Math.floor(state.now / 1000) + 3600 });
        return { state, policy, verify: () => policy.verify({ identity, claims: claims(), context: { verifiedEmail: null } }) };
    }

    test('an active subject whose date has passed signs in; its session ends with the provider proof', async () => {
        const f = fixture(record()), assurance = await f.verify();
        expect(assurance).toMatchObject({ subjectKey: SUBJECT, revision: 0, expiresAt: NOW + HOUR,
            authoritySha256: canonicalDigest(record()) });
        expect(assurance.stage).toBeUndefined(); // An established customer, not a new setup.
        f.state.now = NOW + HOUR - 1;
        await expect(f.policy.recheck({ identity, assurance })).resolves.toBeUndefined();
        f.state.now = NOW + HOUR; // The proof, not the account, expires.
        expect(await code(() => f.policy.recheck({ identity, assurance }))).toBe('browser_auth_external_customer_required');
    });

    test('an unexpired account no longer shortens the session below its provider proof', async () => {
        const f = fixture(record({ expiresAt: NOW + 60000 }));
        expect((await f.verify()).expiresAt).toBe(NOW + HOUR);
    });

    test('suspension or revocation refuses sign-in and ends an issued session', async () => {
        for (const status of ['suspended', 'revoked']) {
            expect(await code(fixture(record({ status })).verify)).toBe('browser_auth_customer_required');
            const f = fixture(record()), assurance = await f.verify();
            f.state.stored = record({ status });
            expect(await code(() => f.policy.recheck({ identity, assurance }))).toBe('browser_auth_customer_required');
        }
    });

    test('a changed record, a lapsed provider policy and an already expired token are still refused', async () => {
        const changed = fixture(record()), assurance = await changed.verify();
        changed.state.stored = record({ revision: 1 });
        expect(await code(() => changed.policy.recheck({ identity, assurance }))).toBe('browser_auth_external_customer_required');
        const lapsed = fixture(record()); lapsed.state.enforced = false;
        expect(await code(lapsed.verify)).toBe('browser_auth_external_customer_required');
        const stale = fixture(record()); stale.state.proofTtl = 0;
        expect(await code(stale.verify)).toBe('browser_auth_external_customer_required');
    });
});

describe('invited (Entra B2B, MFA) sign-in', () => {
    function fixture(stored) {
        const state = { now: NOW, stored, mfa: true };
        const proof = { schemaVersion: 1, subjectKey: SUBJECT, invitationDigest: stored.invitationDigest,
            email: stored.email, method: 'entra-invitation-mailbox-capability' };
        const policy = createCustomerIdentityPolicy({ authenticationContext: 'c1', now: () => state.now,
            verifyMfaPolicy: async () => state.mfa,
            records: { readSubject: async () => JSON.parse(JSON.stringify(state.stored)), readEmailProof: async () => proof } });
        const verify = (exp = Math.floor(state.now / 1000) + 3600) => policy.verify({ identity,
            claims: { acrs: ['c1'], exp }, context: { invitationDigest: null } });
        return { state, policy, verify };
    }

    test('an active subject whose date has passed signs in until the token ends', async () => {
        const f = fixture(record()), assurance = await f.verify();
        expect(assurance.expiresAt).toBe(NOW + HOUR);
        f.state.now = NOW + HOUR;
        expect(await code(() => f.policy.recheck({ identity, assurance }))).toBe('browser_auth_customer_required');
    });

    test('revocation, an expired token and a removed MFA policy are still refused', async () => {
        expect(await code(() => fixture(record({ status: 'revoked' })).verify())).toBe('browser_auth_customer_required');
        const f = fixture(record());
        expect(await code(() => f.verify(Math.floor(NOW / 1000)))).toBe('browser_auth_customer_mfa_required');
        const assurance = await f.verify(); f.state.mfa = false;
        expect(await code(() => f.policy.recheck({ identity, assurance }))).toBe('browser_auth_customer_mfa_required');
    });
});
