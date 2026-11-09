'use strict';

const { normaliseCustomerAuthoritySource, inspectCustomerAuthority, customerAuthorityExpiryCommandHash,
    planCustomerAuthorityExpiry } = require('../api/shared/dashboardAdmin/customerAuthorityExpiry');
const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { authority, subjectHash } = require('../api/shared/customerSignup/customerAuthority');
const { approvedBinding } = require('../api/shared/dashboardAdmin/approvalRecords');
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
    const command = { schemaVersion: 1, purpose: 'customer_authority_expiry_extension', operationId: uuid(6), target,
        beforeSha256: hash(record), beforeEtag: observation.etag, beforeRevision: record.revision, beforeExpiresAt: OLD, newExpiresAt: NEW };
    const context = { operatorSubjectKey: `${uuid(10)}:${uuid(11)}`, sessionSha256: '5'.repeat(64), instanceId: uuid(12),
        restoreEpoch: uuid(13), identityPolicySha256: '6'.repeat(64), auditConfigurationSha256: '7'.repeat(64) };
    const approval = { schemaVersion: 1, purpose: command.purpose, status: 'active', approvalId: uuid(14), revision: 3,
        context: copy(context), commandSha256: customerAuthorityExpiryCommandHash(command, context), approvedExpiresAt: NEW,
        issuedAt: NOW, expiresAt: '2026-11-09T12:10:00.000Z' };
    return { observation, command, context, approval };
}
const inspect = f => inspectCustomerAuthority(f.observation, f.command.target, NOW);
const plan = f => planCustomerAuthorityExpiry(f, NOW);
const reapprove = f => { f.approval.commandSha256 = customerAuthorityExpiryCommandHash(f.command, f.context); return f; };

describe('90-day server-clock expiry cap', () => {
    const capMs = 90 * 24 * 60 * 60 * 1000;
    function cappedFixture(now, extensionMs, issuedOffsetMs = 0) {
        const f = fixture(), clock = Date.parse(now);
        f.observation.observedAt = now;
        f.command.newExpiresAt = new Date(clock + extensionMs).toISOString();
        Object.assign(f.approval, { approvedExpiresAt: f.command.newExpiresAt,
            issuedAt: new Date(clock + issuedOffsetMs).toISOString(),
            expiresAt: new Date(clock + issuedOffsetMs + 3600000).toISOString() });
        return reapprove(f);
    }
    test.each([
        '2026-11-09T12:00:00.000Z', '2027-01-31T23:59:59.999Z',
        '2028-02-29T00:00:00.000Z', '2100-02-01T00:00:00.001Z'
    ])('accepts exactly 90 elapsed days but rejects one millisecond more from %s', now => {
        for (const issuedOffsetMs of [-3599999, -1800000, 0]) {
            const f = cappedFixture(now, capMs, issuedOffsetMs), original = copy(f);
            const result = planCustomerAuthorityExpiry(f, now);
            expect(result.after.record).toEqual({ ...original.observation.record,
                expiresAt: Date.parse(now) + capMs, revision: original.observation.record.revision + 1 });
            expect(result).toMatchObject({ command: f.command, context: f.context, approval: f.approval,
                source: f.observation.source, blobName: f.observation.blobName,
                before: { sha256: hash(f.observation.record), etag: f.observation.etag,
                    revision: f.observation.record.revision, expiresAt: OLD },
                commandSha256: f.approval.commandSha256, approvalSha256: hash(f.approval), plannedAt: now });
            expect(f).toEqual(original);
            const over = cappedFixture(now, capMs + 1, issuedOffsetMs);
            expect(() => planCustomerAuthorityExpiry(over, now)).toThrow('dashboard_admin_customer_authority_expiry_invalid');
        }
    });
    test.each([1, 60000, capMs - 1])('preserves the exact approved %s millisecond extension without a default', duration => {
        const f = cappedFixture(NOW, duration);
        expect(plan(f).after.record.expiresAt).toBe(Date.parse(NOW) + duration);
    });
    test('rechecks the server clock rather than using an observation or approval clock', () => {
        const f = cappedFixture(NOW, capMs, -1);
        f.observation.observedAt = '2026-11-09T11:59:59.999Z';
        expect(plan(f).after.record.expiresAt).toBe(Date.parse(NOW) + capMs);
        expect(() => planCustomerAuthorityExpiry(f, f.observation.observedAt)).toThrow('dashboard_admin_customer_authority_expiry_invalid');
    });
    test.each([
        undefined, null, '', Date.parse(NOW), new Date(NOW), 'not-a-date',
        '2026-02-30T12:00:00.000Z', '2026-11-09T12:00:00+00:00',
        '0000-01-01T00:00:00.000Z', '+010000-01-01T00:00:00.000Z', '+275761-01-01T00:00:00.000Z'
    ])('rejects malformed or out-of-range server time and proposed expiry: %p', value => {
        const f = cappedFixture(NOW, capMs);
        expect(() => planCustomerAuthorityExpiry(f, value)).toThrow();
        f.command.newExpiresAt = value; f.approval.approvedExpiresAt = value;
        expect(() => customerAuthorityExpiryCommandHash(f.command, f.context)).toThrow();
        expect(() => plan(f)).toThrow();
    });
    test('fails closed when a 90-day expiry falls outside the supported date range', () => {
        const now = '9999-12-31T23:59:59.999Z', f = fixture();
        f.observation.observedAt = now;
        f.approval.issuedAt = '9999-12-31T23:59:59.998Z';
        f.approval.expiresAt = '+010000-01-01T00:00:00.000Z';
        f.command.newExpiresAt = new Date(Date.parse(now) + capMs).toISOString();
        f.approval.approvedExpiresAt = f.command.newExpiresAt;
        expect(() => customerAuthorityExpiryCommandHash(f.command, f.context)).toThrow();
        expect(() => planCustomerAuthorityExpiry(f, now)).toThrow();
    });
    test.each([
        f => { f.command.now = NOW; }, f => { f.command.maxExtensionDays = 91; },
        f => { f.context.now = NOW; }, f => { f.approval.now = NOW; },
        f => { f.command.entitlementUntil = f.command.newExpiresAt; },
        f => { f.command.termsVersion = 'replacement-terms'; },
        f => { f.command.scheduleDigest = 'a'.repeat(64); }
    ])('rejects client clock overrides and broader renewal fields #%#', alter => {
        const f = cappedFixture(NOW, capMs); alter(f); expect(() => plan(f)).toThrow();
    });
});

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
    test('missing is explicit and cannot carry an ETag or become a mutation plan', () => {
        const f = fixture(); f.observation.record = null; f.observation.etag = null;
        expect(inspect(f)).toMatchObject({ status: 'missing', expiresAt: null, revision: null, authoritySha256: null, etag: null });
        expect(() => plan(f)).toThrow(); f.observation.etag = '"unexpected"'; expect(() => inspect(f)).toThrow();
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

describe('exact independently approved expiry-only proposals', () => {
    test.each(['legacy_admin', 'legacy_starter', 'external_starter'])('preserves schema-1 %s authority fields except expiry and revision', kind => {
        const f = fixture({ kind }), original = copy(f), result = plan(f);
        expect(result.after.record).toEqual({ ...original.observation.record, expiresAt: Date.parse(NEW), revision: 8 });
        expect(f).toEqual(original);
        expect(result.before).toEqual({ sha256: hash(f.observation.record), etag: f.observation.etag, revision: 7, expiresAt: OLD });
        expect(result.after.sha256).toBe(hash(result.after.record)); expect(result.approvalSha256).toBe(hash(f.approval));
        expect(result.commandSha256).toBe(f.approval.commandSha256); expect(result.command.operationId).toBe(uuid(6));
        expect(result.source).toEqual(f.observation.source); expect(result.context).toEqual(f.context);
        expect(Object.isFrozen(result.after.record)).toBe(true); expect(Object.isFrozen(result.approval.context)).toBe(true);
        expect(plan(f)).toEqual(result);
        expect(authority(result.after.record, f.command.target.subjectKey, Date.parse(NOW))).toEqual(result.after.record);
    });
    test.each(['legacy_admin', 'legacy_starter', 'external_starter'])('inspects schema-2 %s records but refuses extension without changing them', kind => {
        for (const accountType of ['company', 'consultant']) for (const revision of [0, 7]) {
            const f = fixture({ schemaVersion: 2, accountType, kind });
            f.observation.record.revision = f.command.beforeRevision = revision;
            f.command.beforeSha256 = hash(f.observation.record); reapprove(f);
            const before = copy(f);
            expect(inspect(f)).toMatchObject({ status: 'expired', revision });
            expect(() => plan(f)).toThrow('dashboard_admin_customer_authority_expiry_invalid');
            expect(f).toEqual(before);
        }
    });
    test('preserves absent optional account type and null binding', () => {
        const f = fixture({ schemaVersion: 1 }); delete f.observation.record.accountType; f.observation.record.bindingId = null;
        f.command.beforeSha256 = hash(f.observation.record); reapprove(f);
        expect(plan(f).after.record).toEqual({ ...f.observation.record, revision: 8, expiresAt: Date.parse(NEW) });
    });
    test.each([
        f => { f.observation.record.status = 'revoked'; },
        f => { f.observation.record.expiresAt = Date.parse(NEW); },
        f => { f.observation.record.revision++; },
        f => { f.observation.record.termsVersion = 'changed'; },
        f => { f.observation.etag = '"changed"'; },
        f => { f.command.beforeExpiresAt = '2026-11-07T12:00:00.000Z'; reapprove(f); },
        f => { f.command.beforeRevision++; reapprove(f); },
        f => { f.command.beforeSha256 = 'f'.repeat(64); reapprove(f); },
        f => { f.command.beforeEtag = '"changed"'; reapprove(f); },
        f => { f.command.newExpiresAt = NOW; f.approval.approvedExpiresAt = NOW; reapprove(f); },
        f => { f.command.newExpiresAt = OLD; },
        f => { f.command.newExpiresAt = '2026-11-10T12:00:00+00:00'; },
        f => { f.command.newExpiresAt = '2026-02-30T12:00:00.000Z'; },
        f => { delete f.command.newExpiresAt; },
        f => { f.command.newExpiresAt = Date.parse(NEW); },
        f => { f.command.beforeRevision = Number.MAX_SAFE_INTEGER; },
        f => { f.command.purpose = 'signup_support'; },
        f => { f.command.operationId = uuid(99); },
        f => { f.command.entitlementUntil = NEW; },
        f => { f.approval = null; },
        f => { f.approval.status = 'revoked'; },
        f => { f.approval.purpose = 'signup_support'; },
        f => { f.approval.approvedExpiresAt = '2026-11-11T12:00:00.000Z'; },
        f => { f.approval.commandSha256 = '0'.repeat(64); },
        f => { f.approval.expiresAt = NOW; },
        f => { f.approval.issuedAt = '2026-11-09T12:00:00.001Z'; },
        f => { f.approval.expiresAt = '2026-11-09T13:00:00.001Z'; },
        ...['instanceId', 'restoreEpoch'].map(key => f => { f.context[key] = uuid(99); }),
        ...['sessionSha256', 'identityPolicySha256', 'auditConfigurationSha256'].map(key => f => { f.context[key] = 'e'.repeat(64); }),
        f => { f.context.operatorSubjectKey = `${uuid(10)}:${uuid(99)}`; }
    ])('rejects stale, unauthorised, malformed or broadened proposal #%#', alter => {
        const f = fixture(); alter(f); expect(() => plan(f)).toThrow();
    });
    test.each([undefined, null, '', 'a'.repeat(63), 'A'.repeat(64), 7, {}])(
        'requires a valid audit configuration digest in command and approval contexts: %p', value => {
            for (const key of ['context', 'approval']) {
                const f = fixture(), selected = key === 'context' ? f.context : f.approval.context;
                if (value === undefined) delete selected.auditConfigurationSha256;
                else selected.auditConfigurationSha256 = value;
                expect(() => plan(f)).toThrow();
                if (key === 'context') expect(() => customerAuthorityExpiryCommandHash(f.command, f.context)).toThrow();
            }
        });
    test('binds the approved audit digest in both context equality and the command hash', () => {
        const f = fixture(), originalHash = f.approval.commandSha256;
        f.context.auditConfigurationSha256 = 'a'.repeat(64);
        const changedHash = customerAuthorityExpiryCommandHash(f.command, f.context);
        expect(changedHash).not.toBe(originalHash); expect(() => plan(f)).toThrow();
        f.approval.commandSha256 = changedHash; expect(() => plan(f)).toThrow();
        f.approval.context.auditConfigurationSha256 = f.context.auditConfigurationSha256;
        f.approval.commandSha256 = originalHash; expect(() => plan(f)).toThrow();
        f.approval.commandSha256 = changedHash;
        expect(plan(f)).toMatchObject({ commandSha256: changedHash, context: f.context, approval: f.approval });
        f.approval.context.auditConfigurationSha256 = 'b'.repeat(64); expect(() => plan(f)).toThrow();
    });
    test('ordinary read approvals cannot approve an extension, and vice versa', () => {
        const f = fixture(); expect(() => approvedBinding(f.approval)).toThrow();
        f.approval = { schemaVersion: 1, purpose: 'signup_support', action: 'dashboard.authority.read' };
        expect(() => plan(f)).toThrow();
    });
    test('overflow is rejected even with matching source and fresh independent approval', () => {
        const f = fixture(); f.observation.record.revision = Number.MAX_SAFE_INTEGER;
        f.command.beforeRevision = Number.MAX_SAFE_INTEGER; f.command.beforeSha256 = hash(f.observation.record);
        expect(() => customerAuthorityExpiryCommandHash(f.command, f.context)).toThrow(); expect(() => plan(f)).toThrow();
    });
    test('exact-expiry boundary is eligible but an active unexpired authority is not', () => {
        const f = fixture(); f.observation.record.expiresAt = Date.parse(NOW); f.command.beforeExpiresAt = NOW;
        f.command.beforeSha256 = hash(f.observation.record); reapprove(f); expect(plan(f).after.record.revision).toBe(8);
        f.observation.record.expiresAt++; f.command.beforeExpiresAt = '2026-11-09T12:00:00.001Z';
        f.command.beforeSha256 = hash(f.observation.record); reapprove(f); expect(() => plan(f)).toThrow();
    });
});
