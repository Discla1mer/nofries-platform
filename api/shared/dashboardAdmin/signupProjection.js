'use strict';

const { copy, fields, freeze, id, uuid, subject, instant, revision, equal, hash } = require('../appLifecycle/dashboardRuntimeRecords');
const { workEmail } = require('../organisationSetup');
const { validateAcceptanceReceipt } = require('../customerSignup/invitationAcceptance');
const fail = () => { throw new Error('dashboard_admin_signup_record_invalid'); };
const { FIELD_SET, normaliseSignupAuthority, normaliseSignupManifest, matchSignupManifest } = require('./signupAuthority');
const bindingKeys = ['provider', 'tenantId', 'organisationId', 'accountId', 'setupRequestId', 'subjectKey'];
function text(value, maximum = 180) {
    id(value);
    if (value.length > maximum || /[\u007f-\u009f<>]/u.test(value)) fail();
    return value;
}
function binding(value) {
    fields(value, bindingKeys);
    if (!['legacy', 'external'].includes(value.provider)) fail();
    id(value.tenantId); id(value.organisationId); uuid(value.accountId); uuid(value.setupRequestId);
    if (value.subjectKey !== null) subject(value.subjectKey);
    return value;
}
function prior(value, observedAt) { instant(value); if (value > observedAt) fail(); return value; }
function milestone(fact, at) { return { status: fact.state, at: fact.state === 'recorded' ? at : null }; }

// Strict evidence summaries, NOT a store adapter. The trusted adapter must first
// validate real domain records, exact source paths/references and current source
// revisions. A shared email never proves these bindings. No raw proof is accepted.
function projectSignupRecord(input, scope, observedAt) {
    const row = fields(copy(input, 16384), ['recordId', 'binding', 'account', 'setup', 'acceptance', 'registration']);
    id(row.recordId); binding(row.binding);
    if (row.binding.provider !== scope.provider || row.binding.tenantId !== scope.tenantId) fail();
    const fact = key => {
        const entry = row[key];
        if (entry?.state === 'recorded') {
            fields(entry, ['state', 'binding', 'revision', 'value']);
            if (!equal(binding(entry.binding), row.binding)) fail();
            text(entry.revision, 128);
            return entry;
        }
        fields(entry, ['state']);
        if (!['unknown', 'unavailable'].includes(entry.state)) fail();
        return entry;
    };
    const account = fact('account'), setup = fact('setup'), acceptance = fact('acceptance'), registration = fact('registration');
    const b = row.binding;
    let captured = { email: null, organisation: null, accountType: null }, activation;
    if (account.state === 'recorded') {
        const a = fields(account.value, ['accountId', 'setupRequestId', 'email', 'organisation', 'accountType', 'createdAt', 'identitySubjectKey', 'activation']);
        if (a.accountId !== b.accountId || a.setupRequestId !== b.setupRequestId || a.email !== workEmail(a.email) ||
            !['company', 'consultant'].includes(a.accountType)) fail();
        if (typeof a.organisation !== 'string' || !a.organisation || a.organisation.length > 120 ||
            a.organisation !== a.organisation.trim().normalize('NFC') || /[\u0000-\u001f\u007f-\u009f<>]/u.test(a.organisation)) fail();
        prior(a.createdAt, observedAt);
        if (a.identitySubjectKey !== null && (subject(a.identitySubjectKey), a.identitySubjectKey !== b.subjectKey)) fail();
        if (a.activation !== null) {
            activation = fields(a.activation, ['subjectKey', 'receiptId', 'activatedAt', 'validUntil']);
            subject(activation.subjectKey); uuid(activation.receiptId); instant(activation.validUntil);
            if (activation.subjectKey !== b.subjectKey || prior(activation.activatedAt, observedAt) < a.createdAt || activation.validUntil <= activation.activatedAt) fail();
        }
        captured = { email: a.email, organisation: a.organisation, accountType: a.accountType };
    }
    if (setup.state === 'recorded') {
        const s = fields(setup.value, ['accountId', 'setupRequestId', 'receivedAt']);
        if (s.accountId !== b.accountId || s.setupRequestId !== b.setupRequestId) fail();
        prior(s.receivedAt, observedAt);
        if (account.state === 'recorded' && s.receivedAt < account.value.createdAt) fail();
    }
    if (acceptance.state === 'recorded') {
        const a = validateAcceptanceReceipt(acceptance.value);
        if (a.subjectKey !== b.subjectKey || a.tenantId !== b.tenantId || a.organisationId !== b.organisationId ||
            a.acceptedAt > Date.parse(observedAt)) fail();
        if (setup.state === 'recorded' && a.acceptedAt < Date.parse(setup.value.receivedAt) ||
            account.state === 'recorded' && a.acceptedAt < Date.parse(account.value.createdAt)) fail();
    }
    if (registration.state === 'recorded') {
        const r = registration.value;
        const scheduled = Object.hasOwn(r, 'scheduleId');
        fields(r, ['subjectKey', 'tenantId', 'organisationId', 'invitationId', 'receiptId', 'termsVersion', 'termsDigest',
            ...(scheduled ? ['scheduleId', 'scheduleDigest'] : []), 'status', 'revision']);
        subject(r.subjectKey); revision(r.revision);
        ['tenantId', 'organisationId', 'invitationId', 'receiptId', 'termsVersion', ...(scheduled ? ['scheduleId'] : [])].forEach(key => id(r[key]));
        if (r.subjectKey !== b.subjectKey || r.tenantId !== b.tenantId || r.organisationId !== b.organisationId ||
            !['pending_admission', 'revoked'].includes(r.status) || !/^[a-f0-9]{64}$/.test(r.termsDigest) ||
            scheduled && !/^[a-f0-9]{64}$/.test(r.scheduleDigest)) fail();
        if (acceptance.state === 'recorded') {
            const a = acceptance.value;
            if (scheduled !== Object.hasOwn(a, 'scheduleId') || ['subjectKey', 'tenantId', 'organisationId', 'invitationId', 'receiptId',
                'termsVersion', 'termsDigest', ...(scheduled ? ['scheduleId', 'scheduleDigest'] : [])].some(key => a[key] !== r[key])) fail();
        }
    }
    if (activation && setup.state === 'recorded' && activation.activatedAt < setup.value.receivedAt) fail();
    if (activation && acceptance.state === 'recorded' &&
        Date.parse(activation.activatedAt) < acceptance.value.acceptedAt) fail();
    // Activation and revoked registration are historical facts, not a current
    // session/admission grant. Never invent a registration revocation timestamp.
    const admission = registration.state !== 'recorded' ? registration.state :
        registration.value.status === 'revoked' ? 'revoked' :
            account.state === 'recorded' && account.value.activation === null ? 'awaiting_admission' : 'unknown';
    return freeze({ ...captured, milestones: {
        accountSaved: milestone(account, account.value?.createdAt), setupSaved: milestone(setup, setup.value?.receivedAt),
        termsAccepted: milestone(acceptance, acceptance.state === 'recorded' ? new Date(acceptance.value.acceptedAt).toISOString() : null),
        accountActivated: activation ? { status: 'recorded', at: activation.activatedAt } :
            { status: account.state === 'unavailable' ? 'unavailable' : 'unknown', at: null },
        admission: { status: admission, at: null }
    } });
}

function projectSignupPage(input, scope, { now, limit, snapshotId = null, offset = 0 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) fail();
    const page = copy(input, 256 * 1024);
    if (![1, 2].includes(page.schemaVersion)) fail();
    fields(page, ['schemaVersion', 'provider', ...(page.schemaVersion === 1 ? ['tenantId'] : ['manifest']),
        'populationId', 'indexId', 'snapshotId', 'observedAt', 'status', 'records', 'nextCursor']);
    let expectedEntries = null, expectedCursor = null;
    if (page.schemaVersion === 1) {
        if (scope.schemaVersion === 2 || ['provider', 'tenantId', 'populationId', 'indexId'].some(key => page[key] !== scope[key])) fail();
    } else {
        // A matching digest supplied beside arbitrary rows proves nothing. Verify
        // the complete closed witness and its exact ordered slice independently.
        const authority = normaliseSignupAuthority(scope, { now });
        const manifest = matchSignupManifest(authority, normaliseSignupManifest(page.manifest));
        const manifestSha256 = hash(manifest);
        if (authority.schemaVersion !== 2 || ['provider', 'populationId', 'indexId'].some(key => page[key] !== authority[key]) ||
            page.snapshotId !== 'signup-index-v2:' + manifestSha256 || !Number.isSafeInteger(offset) || Object.is(offset, -0) ||
            offset < 0 || offset >= authority.maxRows || offset > 0 && offset >= manifest.entries.length ||
            limit > authority.maxPageSize || limit > authority.maxRows - offset) fail();
        expectedEntries = manifest.entries.slice(offset, Math.min(offset + limit, authority.maxRows));
        const nextOffset = offset + expectedEntries.length;
        expectedCursor = nextOffset < manifest.entries.length
            ? 'signup-index-v2:' + hash({ authoritySha256: hash(authority), manifestSha256 }) + ':' + nextOffset : null;
    }
    instant(now); prior(page.observedAt, now);
    if (Date.parse(now) - Date.parse(page.observedAt) > 30000) fail();
    text(page.snapshotId, 128);
    if (snapshotId !== null && page.snapshotId !== snapshotId) fail();
    if (!Array.isArray(page.records) || page.records.length > limit || !['available', 'unavailable'].includes(page.status)) fail();
    if (page.nextCursor !== null) text(page.nextCursor, 256);
    if (page.status === 'unavailable' && (page.records.length || page.nextCursor !== null) ||
        page.nextCursor !== null && !page.records.length) fail();
    if (expectedEntries && page.status === 'available' &&
        (page.records.length !== expectedEntries.length || page.nextCursor !== expectedCursor)) fail();
    const seen = new Set(), identities = new Set();
    const rows = page.records.map((record, position) => {
        const expected = expectedEntries && expectedEntries[position];
        if (expected && (record.recordId !== expected.recordId || !equal(record.binding, expected.binding))) fail();
        const result = projectSignupRecord(record, expected ? expected.binding : scope, page.observedAt);
        const identity = JSON.stringify([record.binding.provider, record.binding.tenantId, record.binding.accountId]);
        if (seen.has(record.recordId) || identities.has(identity)) fail();
        seen.add(record.recordId); identities.add(identity);
        return result;
    });
    return freeze({ status: page.status, rows, observedAt: page.observedAt, snapshotId: page.snapshotId,
        nextCursor: page.nextCursor, recordIds: [...seen], identities: [...identities] });
}
module.exports = { FIELD_SET, projectSignupRecord, projectSignupPage };
