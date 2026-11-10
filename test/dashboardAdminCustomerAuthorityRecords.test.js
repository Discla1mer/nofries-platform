'use strict';

const { normaliseCustomerAuthoritySource, inspectCustomerAuthority } = require('../api/shared/dashboardAdmin/customerAuthorityRecords');
const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { authority, subjectHash } = require('../api/shared/customerSignup/customerAuthority');
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = '2026-11-09T12:00:00.000Z', OLD = '2026-11-08T12:00:00.000Z', NEW = '2026-11-10T12:00:00.000Z';
const copy = value => JSON.parse(JSON.stringify(value));
function fixture({ schemaVersion = 1, accountType = 'consultant', kind = 'external_starter' } = {}) {
    const subjectKey = `${uuid(1)}:${uuid(2)}`;
    const source = { schemaVersion: 1, kind, storageAccount: 'syntheticstore', container: 'synthetic-authority',
        providerKind: kind === 'external_starter' ? 'external-id' : 'workforce-b2b', providerTenantId: uuid(1),
        providerConfigurationSha256: '1'.repeat(64) };
    const target = { sourceSha256: hash(source), subjectKey, tenantId: uuid(3), organisationId: uuid(4) };
    const record = { schemaVersion, subjectKey, email: 'synthetic@example.test', revision: 7, status: 'active',
        invitationDigest: '2'.repeat(64), invitationId: 'synthetic-invitation', tenantId: target.tenantId,
        organisationId: target.organisationId, termsVersion: 'synthetic-terms', termsDigest: '3'.repeat(64),
        ...(schemaVersion === 2 ? { scheduleId: 'synthetic-schedule', scheduleDigest: '4'.repeat(64) } : {}),
        bindingId: uuid(5), expiresAt: Date.parse(OLD), ...(accountType === undefined ? {} : { accountType }) };
    const observation = { source, blobName: `customer-subjects/${subjectHash(subjectKey)}.json`, etag: '"synthetic-etag"', observedAt: NOW, record };
    return { observation, command: { target } };
}
const inspect = f => inspectCustomerAuthority(f.observation, f.command.target, NOW);

describe('dormant customer authority inspection', () => {
    test.each(['legacy_admin', 'legacy_starter', 'external_starter'])('pins the exact %s source', kind => {
        const f = fixture({ kind }), result = inspect(f);
        expect(normaliseCustomerAuthoritySource(f.observation.source)).toEqual(f.observation.source);
        expect(result).toEqual({ status: 'expired', expiresAt: OLD, revision: 7, authoritySha256: hash(f.observation.record),
            etag: '"synthetic-etag"', observedAt: NOW });
        expect(Object.isFrozen(result)).toBe(true);
        expect(JSON.stringify(result)).not.toMatch(/email|invitation|terms|schedule|subjectKey/);
    });
    test.each([['active', Date.parse(NEW), 'active'], ['active', Date.parse(NOW), 'expired'],
        ['revoked', Date.parse(NEW), 'revoked'], ['revoked', Date.parse(OLD), 'revoked']])(
        'projects %s at %s as %s', (status, expiresAt, expected) => {
            const f = fixture(); Object.assign(f.observation.record, { status, expiresAt });
            expect(inspect(f).status).toBe(expected);
        });
    test('missing is explicit and cannot carry an ETag', () => {
        const f = fixture(); f.observation.record = null; f.observation.etag = null;
        expect(inspect(f)).toMatchObject({ status: 'missing', expiresAt: null, revision: null, authoritySha256: null, etag: null });
        f.observation.etag = '"unexpected"'; expect(() => inspect(f)).toThrow();
    });
    test.each([
        f => { f.observation.source.kind = 'legacy'; },
        f => { f.observation.source = [f.observation.source, f.observation.source]; },
        f => { f.observation.source.providerKind = 'workforce-b2b'; },
        f => { f.observation.source.container = 'another-authority'; },
        f => { f.observation.source.storageAccount = 'anotherstore'; },
        f => { f.observation.source.providerConfigurationSha256 = 'a'.repeat(64); },
        f => { f.observation.source.providerTenantId = uuid(99); f.command.target.sourceSha256 = hash(f.observation.source); },
        f => { f.observation.blobName = `customer-subjects/${'0'.repeat(64)}.json`; },
        f => { f.observation.etag = '*'; },
        f => { f.observation.etag = 'W/"etag"'; },
        f => { f.observation.observedAt = '2026-11-09T11:59:29.999Z'; },
        f => { f.observation.observedAt = '2026-11-09T12:00:00.001Z'; },
        f => { f.command.target.organisationId = uuid(99); },
        f => { f.command.target.tenantId = uuid(99); },
        f => { f.command.target.subjectKey = `${uuid(1)}:${uuid(99)}`; }
    ])('rejects wrong, ambiguous, stale or transplanted source #%#', alter => {
        const f = fixture(); alter(f); expect(() => inspect(f)).toThrow();
    });
    test.each([
        r => { r.schemaVersion = 3; }, r => { r.schemaVersion = 1; }, r => { delete r.scheduleDigest; },
        r => { r.status = 'suspended'; }, r => { r.revision = -1; }, r => { r.revision = -0; },
        r => { r.expiresAt = 0; }, r => { r.expiresAt = Number.MAX_SAFE_INTEGER; },
        r => { r.email = 'MixedCase@example.test'; }, r => { r.accountType = 'owner'; },
        r => { r.bindingId = '*'; }, r => { r.invitationDigest = 'bad'; },
        r => { r.invitationId = '\n'; }, r => { r.extra = true; },
        r => { Object.defineProperty(r, 'email', { get() { throw new Error('must not evaluate getter'); } }); },
        r => { r[Symbol('hidden')] = true; }, r => { r.termsVersion = 'x'.repeat(20000); }
    ])('rejects malformed authority #%#', alter => {
        const f = fixture({ schemaVersion: 2 }); alter(f.observation.record); expect(() => inspect(f)).toThrow();
    });
    test('does not authenticate revoked data through the live validator; a passed end date alone is not a refusal', () => {
        const f = fixture(); expect(inspect(f).status).toBe('expired');
        expect(() => authority(f.observation.record, f.command.target.subjectKey, Date.parse(NOW))).not.toThrow();
        Object.assign(f.observation.record, { status: 'revoked', expiresAt: Date.parse(NEW) });
        expect(inspect(f).status).toBe('revoked');
        expect(() => authority(f.observation.record, f.command.target.subjectKey, Date.parse(NOW))).toThrow();
    });
});
