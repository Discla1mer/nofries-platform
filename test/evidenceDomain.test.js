'use strict';

const nativeAssert = require('node:assert/strict');
const test = global.test || require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const util = require('node:util');
const domain = require('../api/shared/evidenceLifecycle/evidenceDomain');
const { SCHEMA_VERSION, EVIDENCE_LIMITS, EvidenceDomainError,
    normaliseEvidenceSelector, normaliseEvidenceCommand, normaliseEvidenceState,
    createEvidence, applyEvidenceCommand, evidenceCommandFingerprint } = domain;

// Count executed assertion calls, separately from the 34 registered cases.
let assertionCalls = 0;
const assert = Object.fromEntries(['equal', 'notEqual', 'deepEqual', 'notDeepEqual',
    'ok', 'throws', 'doesNotThrow', 'match'].map(name => [name, (...args) => {
    assertionCalls += 1;
    return nativeAssert[name](...args);
}]));

const NOW = '2026-09-09T00:00:00.000Z';
const LATER = '2026-09-09T01:00:00.000Z';
const LATEST = '2026-09-09T02:00:00.000Z';
const ACTOR = '11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222';
const OTHER_ACTOR = '11111111-1111-1111-1111-111111111111:33333333-3333-3333-3333-333333333333';
const SCOPE = { tenantId: 'tenant:A', organisationId: 'org:A', artefactId: 'evidence:A' };
const SHA = 'a'.repeat(64), OTHER_SHA = 'b'.repeat(64);
const ERROR_STATUSES = Object.freeze(Object.fromEntries([
    ...['shape_invalid', 'collection_invalid', 'identifier_invalid', 'subject_invalid',
        'time_invalid', 'revision_invalid', 'digest_invalid', 'content_invalid', 'policy_invalid',
        'classification_invalid', 'governance_invalid', 'schema_unsupported', 'history_invalid',
        'action_invalid', 'payload_too_large'].map(code => [`evidence_${code}`, 400]),
    ['evidence_not_found', 404],
    ...['organisation_inactive', 'revision_conflict', 'time_regression', 'version_duplicate',
        'policy_conflict', 'governance_conflict', 'capacity_reached'].map(code => [`evidence_${code}`, 409])
]));
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value !== null && typeof value === 'object'
        ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
        : JSON.stringify(value);
const byteSize = value => Buffer.byteLength(canonical(value), 'utf8');
const at = (value, path) => path.reduce((object, key) => object[key], value);
function setAt(value, path, replacement) { at(value, path.slice(0, -1))[path.at(-1)] = replacement; }
function rejects(fn, suffix, status) {
    assert.throws(fn, error => error instanceof EvidenceDomainError &&
        Object.hasOwn(ERROR_STATUSES, error.code) && (!suffix || error.code === `evidence_${suffix}`) &&
        error.statusCode === (status || ERROR_STATUSES[error.code]) &&
        error.name === 'EvidenceDomainError' && error.message === error.code);
}
function ref(recordId = 'purpose:A', revision = 0, recordSha256 = SHA) {
    return { recordId, revision, recordSha256 };
}
function ownership(scope = SCOPE) {
    return { schemaVersion: 1,
        tenant: { schemaVersion: 1, tenantId: scope.tenantId, displayName: 'Synthetic tenant', recordStatus: 'active', revision: 0 },
        organisations: [{ schemaVersion: 1, tenantId: scope.tenantId, organisationId: scope.organisationId,
            displayName: 'Synthetic organisation', domains: [], recordStatus: 'active', revision: 0 }] };
}
function payload(versionId = 'version:0') {
    return { versionId, declaredContent: { sha256: SHA, contentType: 'application/pdf', sizeBytes: 100 },
        source: { kind: 'operator-declaration', sourceId: 'source:A', sourceRevision: 'source-revision:0',
            observedAt: NOW, sourceMetadataSha256: OTHER_SHA },
        classification: { level: 'Internal', tags: [] },
        policySnapshot: { policyId: 'policy:A', policyVersion: 'policy-version:0', maximumDeclaredBytes: 100,
            allowedDeclaredContentTypes: ['application/pdf', 'text/plain'] },
        governanceRefs: { purposeDecisionRef: ref(), metadataRetentionPolicyRef: ref('metadata-retention:A'),
            bytesRetentionPolicyRef: ref('bytes-retention:A'), legalHoldRefs: [] } };
}
function command(overrides = {}) {
    return { ...SCOPE, action: 'create', expectedRevision: null, actorSubjectKey: ACTOR,
        now: NOW, idempotencyKey: 'operation:0', payload: payload(), ...overrides };
}
function append(state, overrides = {}) {
    return command({ tenantId: state.tenantId, organisationId: state.organisationId, artefactId: state.artefactId,
        action: 'append-version', expectedRevision: state.revision, now: LATER,
        idempotencyKey: `operation:${state.revision + 1}`, payload: payload(`version:${state.revision + 1}`), ...overrides });
}
function created() { return createEvidence(ownership(), command()); }
function withHolds(value, count = 2, prefix = 'hold:') {
    value.classification.tags = ['legal-hold', 'personal'];
    value.governanceRefs.legalHoldRefs = Array.from({ length: count }, (_, i) => ref(`${prefix}${String(i).padStart(2, '0')}`));
    return value;
}
// Construct stored values from the published schema, without calling the module.
function stored(count = 1, makePayload = i => payload(`version:${i}`)) {
    const versions = Array.from({ length: count }, (_, i) => ({ ...makePayload(i), introducedRevision: i,
        previousVersionId: i ? `version:${i - 1}` : null, recordedAt: NOW, recordedBy: ACTOR,
        quarantine: { state: 'quarantined', reason: 'content-unverified' } }));
    return { schemaVersion: 1, ...SCOPE, revision: count - 1, createdAt: NOW, createdBy: ACTOR,
        updatedAt: NOW, updatedBy: ACTOR, currentVersionId: versions.at(-1).versionId, versions };
}
function assertFrozen(value) {
    if (!value || typeof value !== 'object') return;
    assert.ok(Object.isFrozen(value));
    for (const child of Object.values(value)) assertFrozen(child);
}
function reordered(value) {
    if (Array.isArray(value)) return value.map(reordered);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).reverse().map(key => [key, reordered(value[key])]));
    return value;
}
// The descriptors only extend schema-valid strings; no unknown padding field is used.
function fillExactly(value, targetBytes, descriptors) {
    let remaining = targetBytes - byteSize(value);
    assert.ok(remaining >= 0, 'boundary fixture must initially fit');
    for (const [path, maxLength] of descriptors) {
        if (!remaining) break;
        const current = at(value, path), room = maxLength - current.length;
        const wideCount = Math.min(room, Math.floor(remaining / 3));
        const asciiCount = Math.min(room - wideCount, remaining - wideCount * 3);
        setAt(value, path, current + '界'.repeat(wideCount) + 'x'.repeat(asciiCount));
        remaining -= wideCount * 3 + asciiCount;
    }
    assert.equal(remaining, 0, 'closed schema must reach the stated boundary');
    assert.equal(byteSize(value), targetBytes);
    const extra = clone(value);
    const spare = descriptors.find(([path, maxLength]) => at(extra, path).length < maxLength);
    assert.ok(spare, 'a valid one-byte-over fixture must remain reachable');
    setAt(extra, spare[0], at(extra, spare[0]) + 'x');
    assert.equal(byteSize(extra), targetBytes + 1);
    return extra;
}

test('E01 create records explicit policy, revision zero and constant quarantine without mutating inputs', () => {
    const aggregate = ownership(), input = command(), before = canonical({ aggregate, input });
    const state = createEvidence(aggregate, input);
    assert.equal(state.schemaVersion, 1);
    assert.equal(state.revision, 0);
    assert.equal(state.versions.length, 1);
    assert.equal(state.currentVersionId, input.payload.versionId);
    assert.deepEqual(state.versions[0].quarantine, { state: 'quarantined', reason: 'content-unverified' });
    assert.deepEqual(state.versions[0].policySnapshot, input.payload.policySnapshot);
    assert.deepEqual([state.createdAt, state.updatedAt, state.createdBy, state.updatedBy], [NOW, NOW, ACTOR, ACTOR]);
    assert.equal(canonical({ aggregate, input }), before);
});

test('E02 append links the new immutable version and preserves every previous field', () => {
    const initial = created(), input = append(initial), before = canonical(initial);
    const next = applyEvidenceCommand(initial, ownership(), input);
    assert.equal(next.revision, 1);
    assert.equal(next.currentVersionId, 'version:1');
    assert.deepEqual(next.versions[0], initial.versions[0]);
    assert.deepEqual([next.versions[1].introducedRevision, next.versions[1].previousVersionId], [1, 'version:0']);
    assert.deepEqual([next.createdAt, next.createdBy, next.updatedAt, next.updatedBy], [NOW, ACTOR, LATER, ACTOR]);
    assert.equal(canonical(initial), before);
    assert.notEqual(next, initial);
});

test('E03 a second append retains original lineage even when declared bytes have the same digest', () => {
    const initial = createEvidence(ownership(), command({ payload: withHolds(payload()) }));
    const firstInput = append(initial, { actorSubjectKey: OTHER_ACTOR });
    firstInput.payload.source.kind = 'system-derivation';
    firstInput.payload.classification = { level: 'Confidential', tags: ['customer-confidential'] };
    const second = applyEvidenceCommand(initial, ownership(), firstInput);
    const third = applyEvidenceCommand(second, ownership(), append(second, { now: LATEST }));
    assert.deepEqual(third.versions.slice(0, 2), second.versions);
    assert.deepEqual(third.versions[0], initial.versions[0]);
    assert.deepEqual(third.versions.map(v => v.declaredContent.sha256), [SHA, SHA, SHA]);
    assert.deepEqual(third.versions.map(v => v.previousVersionId), [null, 'version:0', 'version:1']);
    assert.equal(third.revision, 2);
});

test('E04 tenant collisions retain composite identity and cannot authorize another tenant artefact', () => {
    const first = command(), other = command({ tenantId: 'tenant:B' });
    const a = createEvidence(ownership(), first), b = createEvidence(ownership(other), other);
    assert.notEqual(evidenceCommandFingerprint(first), evidenceCommandFingerprint(other));
    assert.equal(a.organisationId, b.organisationId);
    assert.equal(a.artefactId, b.artefactId);
    assert.equal(a.versions[0].versionId, b.versions[0].versionId);
    rejects(() => applyEvidenceCommand(a, ownership(other), append(b, { expectedRevision: 999 })), 'not_found', 404);
    rejects(() => applyEvidenceCommand(b, ownership(), append(a, { expectedRevision: 999 })), 'not_found', 404);
    const left = command({ tenantId: 'a:b', organisationId: 'c' });
    const right = command({ tenantId: 'a', organisationId: 'b:c' });
    assert.notEqual(evidenceCommandFingerprint(left), evidenceCommandFingerprint(right));
});

test('E05 organisation and artefact mismatch fail identically before revision conflict', () => {
    const state = created();
    for (const field of ['organisationId', 'artefactId']) {
        rejects(() => applyEvidenceCommand(state, ownership(), append(state, { [field]: 'different', expectedRevision: 999 })), 'not_found', 404);
    }
});

test('E06 missing canonical ownership fields are rejected without invented defaults', () => {
    for (const path of [[], ['tenant'], ['organisations', 0]]) {
        for (const key of Object.keys(at(ownership(), path))) {
            const aggregate = ownership();
            delete at(aggregate, path)[key];
            rejects(() => createEvidence(aggregate, command()), 'shape_invalid', 400);
        }
    }
});

test('E07 suspended and closed ownership denies create and append while active ownership works', () => {
    const state = created();
    for (const path of [['tenant'], ['organisations', 0]]) for (const status of ['suspended', 'closed']) {
        const aggregate = ownership();
        at(aggregate, path).recordStatus = status;
        rejects(() => createEvidence(aggregate, command()), 'organisation_inactive', 409);
        rejects(() => applyEvidenceCommand(state, aggregate, append(state)), 'organisation_inactive', 409);
    }
    assert.equal(applyEvidenceCommand(state, ownership(), append(state)).revision, 1);
});

test('E08 expected revision is action-specific and stale writes preserve state', () => {
    const state = created(), before = canonical(state);
    rejects(() => applyEvidenceCommand(state, ownership(), append(state, { expectedRevision: 1 })), 'revision_conflict', 409);
    for (const bad of [0, 1, -0, undefined]) rejects(() => normaliseEvidenceCommand(command({ expectedRevision: bad })), 'revision_invalid');
    for (const bad of [null, -1, -0, 0.5, Number.MAX_SAFE_INTEGER + 1, '0']) {
        rejects(() => normaliseEvidenceCommand(append(state, { expectedRevision: bad })), 'revision_invalid');
    }
    assert.equal(canonical(state), before);
});

test('E09 duplicate version identity never overwrites immutable history', () => {
    const initial = created(), next = applyEvidenceCommand(initial, ownership(), append(initial));
    for (const versionId of ['version:0', 'version:1']) {
        const input = append(next); input.payload.versionId = versionId;
        const before = canonical(next);
        rejects(() => applyEvidenceCommand(next, ownership(), input), 'version_duplicate', 409);
        assert.equal(canonical(next), before);
    }
});

test('E10 recording times allow equality and reject regression or future observations', () => {
    const initial = created();
    assert.equal(applyEvidenceCommand(initial, ownership(), append(initial, { now: NOW })).updatedAt, NOW);
    const later = applyEvidenceCommand(initial, ownership(), append(initial));
    rejects(() => applyEvidenceCommand(later, ownership(), append(later, { now: NOW })), 'time_regression', 409);
    const bad = command(); bad.payload.source.observedAt = LATER;
    rejects(() => normaliseEvidenceCommand(bad), 'time_invalid');
    const exact = command(); exact.payload.source.observedAt = exact.now;
    assert.equal(normaliseEvidenceCommand(exact).payload.source.observedAt, NOW);
});

test('E11 every closed layer rejects missing or unknown fields and invented capabilities', () => {
    const cases = [
        [() => command({ payload: withHolds(payload(), 1) }), normaliseEvidenceCommand, [[], ['payload'], ['payload', 'declaredContent'], ['payload', 'source'],
            ['payload', 'classification'], ['payload', 'policySnapshot'], ['payload', 'governanceRefs'],
            ...['purposeDecisionRef', 'metadataRetentionPolicyRef', 'bytesRetentionPolicyRef'].map(k => ['payload', 'governanceRefs', k]),
            ['payload', 'governanceRefs', 'legalHoldRefs', 0]]],
        [() => ({ ...SCOPE }), normaliseEvidenceSelector, [[]]],
        [stored, normaliseEvidenceState, [[], ['versions', 0], ['versions', 0, 'quarantine']]],
        [ownership, value => createEvidence(value, command()), [[], ['tenant'], ['organisations', 0]]]
    ];
    for (const [make, normalise, paths] of cases) for (const path of paths) {
        const original = make();
        for (const key of Object.keys(at(original, path))) {
            const missing = make(); delete at(missing, path)[key];
            rejects(() => normalise(missing));
        }
        const extra = make(); at(extra, path).unexpected = 'synthetic';
        rejects(() => normalise(extra));
    }
    for (const key of ['ready', 'safe', 'download', 'sas', 'deleted', 'bytes', 'filename', 'url', 'scannerResult']) {
        const input = command(); input.payload[key] = 'synthetic';
        rejects(() => normaliseEvidenceCommand(input), 'shape_invalid');
    }
    for (const action of ['delete', 'release-quarantine', 'replace', 'reassign-tenant', 'CREATE', '']) {
        rejects(() => normaliseEvidenceCommand(command({ action })), 'action_invalid');
    }
});

test('E12 behavior-bearing objects fail without executing getters, coercion or serializers', () => {
    let calls = 0;
    for (const mutate of [
        value => Object.defineProperty(value, 'tenantId', { enumerable: true, get() { calls++; return SCOPE.tenantId; } }),
        value => Object.defineProperty(value, 'tenantId', { enumerable: true, set(_) { calls++; } }),
        value => { value[Symbol('hidden')] = 'x'; },
        value => Object.defineProperty(value, 'tenantId', { enumerable: false, value: SCOPE.tenantId }),
        value => Object.setPrototypeOf(value, { toJSON() { calls++; return {}; } }),
        value => { value.toJSON = () => { calls++; return {}; }; },
        value => { value.tenantId = { valueOf() { calls++; return 'x'; }, toString() { calls++; return 'x'; } }; }
    ]) {
        const value = command(); mutate(value);
        rejects(() => normaliseEvidenceCommand(value));
    }
    for (const bad of [undefined, () => 'x', 1n, NaN, Infinity, -Infinity, new Date(NOW), new Map(), new Set(), Buffer.from('synthetic')]) {
        const value = command(); value.payload.source = bad;
        rejects(() => normaliseEvidenceCommand(value));
    }
    const nullPrototype = command();
    Object.setPrototypeOf(nullPrototype, null);
    Object.setPrototypeOf(nullPrototype.payload, null);
    assert.deepEqual(normaliseEvidenceCommand(nullPrototype), normaliseEvidenceCommand(command()));
    assert.equal(calls, 0);
});

test('E13 direct nested and revoked proxies are rejected before any reflection trap executes', () => {
    let traps = 0;
    const handler = Object.fromEntries(['get', 'getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor', 'has'].map(name => [name, () => {
        traps++; throw new Error('proxy trap must not execute');
    }]));
    for (const path of [[], ['payload'], ['payload', 'policySnapshot'], ['payload', 'policySnapshot', 'allowedDeclaredContentTypes'],
        ['payload', 'governanceRefs', 'purposeDecisionRef']]) {
        const value = command(), target = at(value, path), proxy = new Proxy(target, handler);
        if (!path.length) rejects(() => normaliseEvidenceCommand(proxy));
        else { setAt(value, path, proxy); rejects(() => normaliseEvidenceCommand(value)); }
        const revoked = Proxy.revocable(target, handler); revoked.revoke();
        const other = command();
        if (!path.length) rejects(() => normaliseEvidenceCommand(revoked.proxy));
        else { setAt(other, path, revoked.proxy); rejects(() => normaliseEvidenceCommand(other)); }
    }
    const aggregate = ownership(); aggregate.organisations = new Proxy(aggregate.organisations, handler);
    rejects(() => createEvidence(aggregate, command()), 'shape_invalid');
    const state = stored(); state.versions[0] = new Proxy(state.versions[0], handler);
    rejects(() => normaliseEvidenceState(state));
    assert.equal(traps, 0);
});

test('E14 finite malformed arrays duplicates and cycles reject without truncation', () => {
    const paths = [['payload', 'policySnapshot', 'allowedDeclaredContentTypes'], ['payload', 'classification', 'tags'],
        ['payload', 'governanceRefs', 'legalHoldRefs']];
    for (const path of paths) for (const kind of ['sparse', 'custom', 'extra', 'symbol', 'accessor']) {
        const value = command({ payload: withHolds(payload()) }), array = at(value, path);
        if (kind === 'sparse') delete array[0];
        if (kind === 'custom') Object.setPrototypeOf(array, Object.create(Array.prototype));
        if (kind === 'extra') array.extra = 'x';
        if (kind === 'symbol') array[Symbol('x')] = 'x';
        if (kind === 'accessor') Object.defineProperty(array, '0', { enumerable: true, get() { throw new Error('array getter executed'); } });
        rejects(() => normaliseEvidenceCommand(value));
    }
    for (const path of paths) {
        const value = command({ payload: withHolds(payload()) }), array = at(value, path);
        array.push(clone(array[0])); rejects(() => normaliseEvidenceCommand(value));
    }
    const mime = command(); mime.payload.policySnapshot.allowedDeclaredContentTypes = Array.from({ length: 33 }, (_, i) => `application/x-${i}`);
    rejects(() => normaliseEvidenceCommand(mime));
    const holds = command({ payload: withHolds(payload(), 17) }); rejects(() => normaliseEvidenceCommand(holds));
    rejects(() => normaliseEvidenceState(stored(129)));
    const circular = command(); circular.payload.source.sourceId = circular;
    rejects(() => normaliseEvidenceCommand(circular));
    const shared = command(); shared.payload.governanceRefs.bytesRetentionPolicyRef = shared.payload.governanceRefs.purposeDecisionRef;
    assert.doesNotThrow(() => normaliseEvidenceCommand(shared));
});

test('E15 opaque identifiers retain exact 180-unit strings and reject malformed or padded values', () => {
    for (const valid of ['A'.repeat(180), '界'.repeat(180), '😀'.repeat(90), 'Opaque:Case|/path?like#id']) {
        const selector = { tenantId: valid, organisationId: valid, artefactId: valid };
        assert.deepEqual(normaliseEvidenceSelector(selector), selector);
        const input = command(); input.payload.source.sourceId = valid;
        assert.equal(normaliseEvidenceCommand(input).payload.source.sourceId, valid);
    }
    for (const invalid of ['', ' x', 'x ', 'x\n', 'x\u0000y', '\u007f', '\ud800', '\udc00', 'x'.repeat(181), '😀'.repeat(91), 1, null]) {
        for (const field of Object.keys(SCOPE)) rejects(() => normaliseEvidenceSelector({ ...SCOPE, [field]: invalid }), 'identifier_invalid');
        const input = command(); input.payload.governanceRefs.purposeDecisionRef.recordId = invalid;
        rejects(() => normaliseEvidenceCommand(input), 'identifier_invalid');
    }
});

test('E16 actor identifiers and UTC millisecond timestamps use exact canonical forms', () => {
    assert.equal(normaliseEvidenceCommand(command()).actorSubjectKey, ACTOR);
    for (const bad of ['operator@example.invalid', ACTOR.toUpperCase().replace('11111111', 'ABCDEFAB'), ACTOR.split(':')[1],
        ` ${ACTOR}`, `${ACTOR}:extra`, `${ACTOR}\n`, `${ACTOR}\r`, `${ACTOR}\u2028`, 'urn:synthetic:actor', null]) {
        rejects(() => normaliseEvidenceCommand(command({ actorSubjectKey: bad })), 'subject_invalid');
    }
    for (const bad of ['2026-09-09', '2026-09-09T00:00:00Z', '2026-09-09T00:00:00.000+00:00',
        '2026-02-30T00:00:00.000Z', '2026-09-09T24:00:00.000Z', '2026-09-09T00:00:60.000Z',
        '2026-09-09T00:00:00.000z', ' 2026-09-09T00:00:00.000Z', 0, null]) {
        rejects(() => normaliseEvidenceCommand(command({ now: bad })), 'time_invalid');
    }
});

test('E17 digest MIME and declared byte size syntax rejects noncanonical declarations', () => {
    for (const bad of [SHA.toUpperCase(), 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), `${SHA}\n`, `${SHA}\r`, `${SHA}\u2028`, '', null]) {
        const input = command(); input.payload.declaredContent.sha256 = bad;
        rejects(() => normaliseEvidenceCommand(input), 'digest_invalid');
    }
    for (const bad of ['Application/pdf', 'application/pdf; charset=utf-8', '*/*', 'application/*', ' application/pdf',
        'application//pdf', 'a'.repeat(64) + '/b', 'a/' + 'b'.repeat(64), 'a/😀', 'a/b\n', 'a/b\r', 'a/b\u2028']) {
        const input = command(); input.payload.declaredContent.contentType = bad;
        rejects(() => normaliseEvidenceCommand(input), 'content_invalid');
    }
    for (const bad of [-1, -0, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '0', null]) {
        const input = command(); input.payload.declaredContent.sizeBytes = bad;
        rejects(() => normaliseEvidenceCommand(input), 'content_invalid');
    }
});

test('E18 declaration constraints require explicit policy and accept exact size and type boundaries', () => {
    for (const bad of [null, {}, undefined]) {
        const input = command(); input.payload.policySnapshot = bad;
        rejects(() => normaliseEvidenceCommand(input));
    }
    for (const maximum of [0, -0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, null]) {
        const input = command(); input.payload.policySnapshot.maximumDeclaredBytes = maximum;
        rejects(() => normaliseEvidenceCommand(input), 'policy_invalid');
    }
    for (const size of [0, 100]) {
        const input = command(); input.payload.declaredContent.sizeBytes = size;
        assert.equal(normaliseEvidenceCommand(input).payload.declaredContent.sizeBytes, size);
    }
    const excess = command(); excess.payload.declaredContent.sizeBytes = 101;
    rejects(() => normaliseEvidenceCommand(excess), 'content_invalid');
    const missingType = command(); missingType.payload.declaredContent.contentType = 'image/png';
    rejects(() => normaliseEvidenceCommand(missingType), 'content_invalid');
    const empty = command(); empty.payload.policySnapshot.allowedDeclaredContentTypes = [];
    rejects(() => normaliseEvidenceCommand(empty), 'collection_invalid');
    const longest = command(); longest.payload.declaredContent.contentType = 'a'.repeat(63) + '/' + 'b'.repeat(63);
    longest.payload.policySnapshot.allowedDeclaredContentTypes = [longest.payload.declaredContent.contentType];
    assert.equal(normaliseEvidenceCommand(longest).payload.declaredContent.contentType.length, 127);
});

test('E19 documented sets normalize identically and changed policies need a distinct policy version', () => {
    const first = command({ payload: withHolds(payload()) }), second = reordered(first);
    second.payload.policySnapshot.allowedDeclaredContentTypes.reverse();
    second.payload.classification.tags.reverse();
    second.payload.governanceRefs.legalHoldRefs.reverse();
    assert.deepEqual(normaliseEvidenceCommand(first), normaliseEvidenceCommand(second));
    const state = createEvidence(ownership(), first), update = append(state);
    update.payload.policySnapshot.maximumDeclaredBytes = 101;
    rejects(() => applyEvidenceCommand(state, ownership(), update), 'policy_conflict', 409);
    const corrupt = stored(2); corrupt.versions[1].policySnapshot.maximumDeclaredBytes = 101;
    rejects(() => normaliseEvidenceState(corrupt), 'policy_conflict', 409);
    update.payload.policySnapshot.policyVersion = 'policy-version:1';
    const next = applyEvidenceCommand(state, ownership(), update);
    assert.deepEqual(next.versions[0], state.versions[0]);
    assert.equal(next.versions[1].policySnapshot.maximumDeclaredBytes, 101);
});

test('E20 explicit classifications preserve four levels and enforce orthogonal tag constraints', () => {
    for (const level of ['Public', 'Internal', 'Confidential', 'Restricted']) {
        const input = command(); input.payload.classification.level = level;
        assert.deepEqual(normaliseEvidenceCommand(input).payload.classification, { level, tags: [] });
    }
    for (const tags of [['personal'], ['customer-confidential', 'security-sensitive'], ['credential-secret'],
        ['high-risk-personal', 'personal'], ['credential-secret', 'high-risk-personal', 'personal']]) {
        const input = command(); input.payload.classification = { level: 'Restricted', tags };
        assert.deepEqual(normaliseEvidenceCommand(input).payload.classification.tags, [...tags].sort());
    }
    for (const level of ['Public', 'Internal', 'Confidential']) for (const tags of [['credential-secret'], ['high-risk-personal', 'personal']]) {
        const input = command(); input.payload.classification = { level, tags };
        rejects(() => normaliseEvidenceCommand(input), 'classification_invalid');
    }
    for (const classification of [{ level: 'Restricted', tags: ['high-risk-personal'] }, { level: 'public', tags: [] },
        { level: 'Internal', tags: ['ai-approved'] }, { level: null, tags: [] }, { tags: [] }]) {
        const input = command(); input.payload.classification = classification;
        rejects(() => normaliseEvidenceCommand(input));
    }
});

const REFERENCE_ROLES = ['purposeDecisionRef', 'metadataRetentionPolicyRef', 'bytesRetentionPolicyRef', 'legalHoldRefs'];
function roleRef(value, role) { return role === 'legalHoldRefs' ? value.governanceRefs.legalHoldRefs[0] : value.governanceRefs[role]; }
function setRoleRef(value, role, reference) {
    if (role === 'legalHoldRefs') value.governanceRefs.legalHoldRefs[0] = reference;
    else value.governanceRefs[role] = reference;
}

test('E21 governance references enforce one tuple digest across every pair of roles in a command', () => {
    for (let i = 0; i < REFERENCE_ROLES.length; i++) for (let j = i + 1; j < REFERENCE_ROLES.length; j++) {
        for (const action of ['create', 'append-version']) {
            const input = command({ action, expectedRevision: action === 'create' ? null : 0, payload: withHolds(payload(), 1) });
            setRoleRef(input.payload, REFERENCE_ROLES[j], clone(roleRef(input.payload, REFERENCE_ROLES[i])));
            assert.doesNotThrow(() => normaliseEvidenceCommand(input));
            const changed = clone(input); roleRef(changed.payload, REFERENCE_ROLES[j]).recordSha256 = OTHER_SHA;
            rejects(() => normaliseEvidenceCommand(changed), 'governance_conflict', 409);
            roleRef(changed.payload, REFERENCE_ROLES[j]).revision += 1;
            assert.doesNotThrow(() => normaliseEvidenceCommand(changed));
        }
    }
    for (const bad of [null, { recordId: 'x', revision: 0 }, { ...ref(), recordSha256: 'wrong' },
        { ...ref(), revision: -0 }, { ...ref(), revision: -1 }, { ...ref(), url: 'synthetic.invalid' }]) {
        const input = command(); input.payload.governanceRefs.purposeDecisionRef = bad;
        rejects(() => normaliseEvidenceCommand(input));
    }
    const duplicate = command({ payload: withHolds(payload(), 1) });
    duplicate.payload.governanceRefs.legalHoldRefs.push({ ...duplicate.payload.governanceRefs.legalHoldRefs[0], revision: 1 });
    rejects(() => normaliseEvidenceCommand(duplicate), 'governance_invalid');
    for (const input of [command(), command({ payload: withHolds(payload(), 1) })]) {
        input.payload.classification.tags = input.payload.governanceRefs.legalHoldRefs.length ? [] : ['legal-hold'];
        rejects(() => normaliseEvidenceCommand(input), 'governance_invalid');
    }
});

test('E22 retention references remain metadata and confer no erasure access or current authority', () => {
    const input = command({ payload: withHolds(payload()) }), state = createEvidence(ownership(), input);
    const nextInput = append(state); nextInput.payload.governanceRefs = clone(input.payload.governanceRefs);
    nextInput.payload.classification.tags = ['legal-hold', 'personal'];
    const next = applyEvidenceCommand(state, ownership(), nextInput), roundTrip = normaliseEvidenceState(clone(next));
    assert.deepEqual(roundTrip.versions.map(v => v.governanceRefs), [input.payload.governanceRefs, input.payload.governanceRefs]);
    const forbidden = ['expiresAt', 'deleteAt', 'holdReleased', 'erased', 'currentAuthority', 'aiEligible', 'downloadUrl', 'authorized'];
    function inspect(value) {
        if (!value || typeof value !== 'object') return;
        for (const key of forbidden) assert.equal(Object.hasOwn(value, key), false);
        for (const child of Object.values(value)) inspect(child);
    }
    inspect(roundTrip);
    assert.deepEqual(roundTrip.versions.map(v => v.quarantine.state), ['quarantined', 'quarantined']);
});

test('E23 stored state round trips and rejects corrupt schema lineage identity and time order', () => {
    const valid = stored(3);
    assert.deepEqual(normaliseEvidenceState(valid), valid);
    const mutations = [
        value => { value.schemaVersion = 2; }, value => { value.revision = 1; },
        value => { value.currentVersionId = 'version:1'; }, value => { value.versions[1].previousVersionId = 'missing'; },
        value => { value.versions[0].previousVersionId = 'invented'; }, value => { value.versions[1].introducedRevision = 0; },
        value => { value.versions[1].versionId = 'version:0'; }, value => { value.versions[1].recordedAt = LATER; },
        value => { value.versions = []; }, value => { value.versions[0].quarantine.state = 'ready'; },
        value => { value.versions[0].quarantine.reason = 'scanner-clean'; }
    ];
    for (const mutate of mutations) { const value = clone(valid); mutate(value); rejects(() => normaliseEvidenceState(value)); }
});

test('E24 history preserves retained policy stamps and governance digest identity across roles and versions', () => {
    for (const mutate of [
        value => { value.versions[0].declaredContent.sizeBytes = 101; },
        value => { value.createdAt = LATER; }, value => { value.createdBy = OTHER_ACTOR; },
        value => { value.updatedAt = LATER; }, value => { value.updatedBy = OTHER_ACTOR; },
        value => { value.versions[0].recordedBy = OTHER_ACTOR; },
        value => { value.versions[0].source.observedAt = LATER; }
    ]) { const value = stored(2); mutate(value); rejects(() => normaliseEvidenceState(value)); }
    const originalPayload = withHolds(payload(), 1);
    const initial = createEvidence(ownership(), command({ payload: originalPayload })), before = canonical(initial);
    for (const oldRole of REFERENCE_ROLES) for (const newRole of REFERENCE_ROLES) {
        const newPayload = withHolds(payload('version:1'), 1, 'new-hold:');
        for (const role of REFERENCE_ROLES.slice(0, 3)) newPayload.governanceRefs[role].recordId = `new:${role}`;
        setRoleRef(newPayload, newRole, clone(roleRef(originalPayload, oldRole)));
        const consistent = append(initial, { payload: newPayload });
        const accepted = applyEvidenceCommand(initial, ownership(), consistent);
        assert.deepEqual(accepted.versions[0], initial.versions[0]);
        assert.deepEqual(normaliseEvidenceState(clone(accepted)), accepted);
        const conflicting = clone(consistent); roleRef(conflicting.payload, newRole).recordSha256 = OTHER_SHA;
        assert.doesNotThrow(() => normaliseEvidenceCommand(conflicting), 'incoming payload alone is internally consistent');
        rejects(() => applyEvidenceCommand(initial, ownership(), conflicting), 'governance_conflict', 409);
        const corrupt = stored(2, i => i ? clone(conflicting.payload) : clone(originalPayload));
        rejects(() => normaliseEvidenceState(corrupt), 'governance_conflict', 409);
        assert.equal(canonical(initial), before);
        roleRef(conflicting.payload, newRole).revision = 1;
        const revised = applyEvidenceCommand(initial, ownership(), conflicting);
        assert.deepEqual(revised.versions[0], initial.versions[0]);
        assert.deepEqual(normaliseEvidenceState(clone(revised)), revised);
    }
});

test('E25 callers cannot mutate detached frozen selectors commands state or fingerprints', () => {
    const selectorInput = { ...SCOPE }, selector = normaliseEvidenceSelector(selectorInput);
    const input = command({ payload: withHolds(payload()) }), aggregate = ownership();
    const normalizedCommand = normaliseEvidenceCommand(input), digest = evidenceCommandFingerprint(input);
    const initial = createEvidence(aggregate, input), nextInput = append(initial);
    const next = applyEvidenceCommand(initial, aggregate, nextInput), importedInput = clone(next), imported = normaliseEvidenceState(importedInput);
    const before = canonical({ selector, normalizedCommand, initial, next, imported, digest });
    selectorInput.tenantId = 'changed'; input.payload.source.sourceId = 'changed';
    input.payload.governanceRefs.legalHoldRefs[0].recordId = 'changed'; aggregate.tenant.displayName = 'changed';
    nextInput.payload.declaredContent.sha256 = OTHER_SHA; importedInput.versions[0].classification.level = 'Public';
    assert.equal(canonical({ selector, normalizedCommand, initial, next, imported, digest }), before);
    assert.notEqual(evidenceCommandFingerprint(input), digest);
    for (const value of [selector, normalizedCommand, initial, next, imported, EVIDENCE_LIMITS]) assertFrozen(value);
    assert.throws(() => { imported.versions[0].source.sourceId = 'changed'; }, TypeError);
    assert.throws(() => { imported.versions.push({}); }, TypeError);
});

test('E26 object and set order agree with an independently calculated fixed fingerprint vector', () => {
    // Transcribed schema fixture hashed with Python json/hashlib, independently of this module.
    const expected = '33e536c4f60d04fe0f13651db1f67deef2b6b2df4ae5d16e0ec7429debc35457';
    const first = command({ payload: withHolds(payload()) }), second = reordered(first);
    second.payload.policySnapshot.allowedDeclaredContentTypes.reverse();
    second.payload.classification.tags.reverse(); second.payload.governanceRefs.legalHoldRefs.reverse();
    assert.equal(evidenceCommandFingerprint(first), expected);
    assert.equal(evidenceCommandFingerprint(second), expected);
});

test('E27 every intent dimension contributes to the command fingerprint', () => {
    const base = command({ action: 'append-version', expectedRevision: 0, payload: withHolds(payload(), 1) });
    const baseline = evidenceCommandFingerprint(base);
    const dimensions = [
        [['tenantId'], 'tenant:B'], [['organisationId'], 'org:B'], [['artefactId'], 'evidence:B'],
        [['actorSubjectKey'], OTHER_ACTOR], [['expectedRevision'], 1], [['payload', 'versionId'], 'version:1'],
        [['payload', 'declaredContent', 'sha256'], OTHER_SHA], [['payload', 'declaredContent', 'contentType'], 'text/plain'],
        [['payload', 'declaredContent', 'sizeBytes'], 99], [['payload', 'source', 'kind'], 'system-derivation'],
        [['payload', 'source', 'kind'], 'provider-observation'], [['payload', 'source', 'sourceId'], 'source:B'],
        [['payload', 'source', 'sourceRevision'], 'source-revision:1'],
        [['payload', 'source', 'observedAt'], '2026-09-08T23:00:00.000Z'], [['payload', 'source', 'sourceMetadataSha256'], SHA],
        [['payload', 'classification', 'level'], 'Confidential'], [['payload', 'classification', 'tags'], ['legal-hold', 'security-sensitive']],
        [['payload', 'policySnapshot', 'policyId'], 'policy:B'], [['payload', 'policySnapshot', 'policyVersion'], 'policy-version:1'],
        [['payload', 'policySnapshot', 'maximumDeclaredBytes'], 101],
        [['payload', 'policySnapshot', 'allowedDeclaredContentTypes'], ['application/pdf', 'image/png', 'text/plain']]
    ];
    for (const role of REFERENCE_ROLES) for (const [field, replacement] of [['recordId', `changed:${role}`], ['revision', 1], ['recordSha256', OTHER_SHA]]) {
        dimensions.push([['payload', 'governanceRefs', role, ...(role === 'legalHoldRefs' ? [0] : []), field], replacement]);
    }
    for (const [path, replacement] of dimensions) {
        const changed = clone(base); setAt(changed, path, replacement);
        assert.notEqual(evidenceCommandFingerprint(changed), baseline, path.join('.'));
    }
    // Action and its required revision shape must change together to form another valid intent.
    const create = clone(base); create.action = 'create'; create.expectedRevision = null;
    assert.notEqual(evidenceCommandFingerprint(create), baseline);
});

test('E28 service execution time and operation key are excluded but observed source time is included', () => {
    const input = command(), fingerprint = evidenceCommandFingerprint(input);
    assert.equal(evidenceCommandFingerprint({ ...input, now: LATER }), fingerprint);
    assert.equal(evidenceCommandFingerprint({ ...input, idempotencyKey: 'retry:1' }), fingerprint);
    assert.equal(evidenceCommandFingerprint({ ...input, now: LATER, idempotencyKey: 'retry:2' }), fingerprint);
    const observed = clone(input); observed.payload.source.observedAt = '2026-09-08T23:59:59.999Z';
    assert.notEqual(evidenceCommandFingerprint(observed), fingerprint);
    assert.equal(typeof fingerprint, 'string'); assert.match(fingerprint, /^[a-f0-9]{64}$/);
});

test('E29 deterministic repetition has no durable receipt and advanced-state retry conflicts', () => {
    const initial = created(), input = append(initial), first = applyEvidenceCommand(initial, ownership(), input);
    const repeated = applyEvidenceCommand(clone(initial), ownership(), clone(input));
    assert.equal(canonical(first), canonical(repeated));
    rejects(() => applyEvidenceCommand(first, ownership(), input), 'revision_conflict', 409);
    for (const key of ['receipt', 'replayed', 'idempotencyKey', 'committedAt']) assert.equal(Object.hasOwn(first, key), false);
});

test('E30 exactly 128 versions fit and capacity failure never truncates or evicts history', () => {
    const input = stored(128), before = canonical(input), state = normaliseEvidenceState(input);
    assert.equal(state.versions.length, 128); assert.equal(state.revision, 127);
    rejects(() => applyEvidenceCommand(state, ownership(), append(state)), 'capacity_reached', 409);
    assert.equal(canonical(input), before); assert.equal(canonical(state), before);
});

test('E31 exact command state and ownership UTF-8 byte ceilings accept while one byte over rejects', () => {
    assert.deepEqual(EVIDENCE_LIMITS, { commandBytes: 16384, stateBytes: 262144, ownershipBytes: 1048576,
        versions: 128, policyContentTypes: 32, legalHoldReferences: 16, ownershipOrganisations: 1024,
        ownershipDomainsPerOrganisation: 64 });
    const input = command({ payload: withHolds(payload(), 16) });
    input.payload.policySnapshot.allowedDeclaredContentTypes = Array.from({ length: 32 }, (_, i) =>
        'a'.repeat(63) + '/' + String(i).padStart(2, '0') + 'b'.repeat(61));
    input.payload.declaredContent.contentType = input.payload.policySnapshot.allowedDeclaredContentTypes[0];
    const commandFields = input.payload.governanceRefs.legalHoldRefs.map((_, i) => [['payload', 'governanceRefs', 'legalHoldRefs', i, 'recordId'], 180]);
    commandFields.push(...['tenantId', 'organisationId', 'artefactId', 'idempotencyKey'].map(key => [[key], 180]),
        [['payload', 'versionId'], 180], [['payload', 'source', 'sourceId'], 180], [['payload', 'source', 'sourceRevision'], 180],
        [['payload', 'policySnapshot', 'policyId'], 180], [['payload', 'policySnapshot', 'policyVersion'], 180]);
    const oversizedCommand = fillExactly(input, 16384, commandFields);
    assert.equal(byteSize(normaliseEvidenceCommand(input)), 16384);
    rejects(() => normaliseEvidenceCommand(oversizedCommand), 'payload_too_large');

    const stateInput = stored(80, i => withHolds(payload(`version:${i}`), 8, `hold:${i}:`));
    const stateFields = stateInput.versions.flatMap((version, i) => version.governanceRefs.legalHoldRefs
        .map((_, j) => [['versions', i, 'governanceRefs', 'legalHoldRefs', j, 'recordId'], 180]));
    const oversizedState = fillExactly(stateInput, 262144, stateFields);
    assert.equal(byteSize(normaliseEvidenceState(stateInput)), 262144);
    rejects(() => normaliseEvidenceState(oversizedState), 'payload_too_large');

    const aggregate = ownership();
    aggregate.organisations = Array.from({ length: 256 }, (_, i) => ({ ...ownership().organisations[0],
        organisationId: i === 0 ? SCOPE.organisationId : `org:${String(i).padStart(4, '0')}`,
        domains: Array.from({ length: 8 }, (_, j) => `domain-${i}-${j}.invalid`) }));
    const ownershipFields = aggregate.organisations.flatMap((org, i) => org.domains.map((_, j) => [['organisations', i, 'domains', j], 253]));
    const oversizedOwnership = fillExactly(aggregate, 1048576, ownershipFields);
    assert.equal(createEvidence(aggregate, command()).tenantId, SCOPE.tenantId);
    rejects(() => createEvidence(oversizedOwnership, command()), 'payload_too_large');
});

test('E32 ownership captures actual canonical facts and bounds arrays without using display metadata as authority', () => {
    const aggregate = ownership();
    aggregate.tenant.displayName = '  Synthetic tenant  ';
    aggregate.organisations[0].domains = ['EXAMPLE.INVALID', 'example.invalid'];
    assert.equal(createEvidence(aggregate, command()).organisationId, SCOPE.organisationId);
    const atCapacity = ownership();
    atCapacity.organisations = Array.from({ length: 1024 }, (_, i) => ({ ...ownership().organisations[0],
        organisationId: i === 0 ? SCOPE.organisationId : `org:${i}` }));
    atCapacity.organisations[0].domains = Array.from({ length: 64 }, (_, i) => `domain-${i}.invalid`);
    assert.equal(createEvidence(atCapacity, command()).organisationId, SCOPE.organisationId);
    const ownerMismatch = ownership(); ownerMismatch.organisations[0].tenantId = 'other-tenant';
    rejects(() => createEvidence(ownerMismatch, command()), 'not_found', 404);
    const missing = ownership(); missing.organisations[0].organisationId = 'different';
    missing.organisations[0].displayName = SCOPE.organisationId; missing.organisations[0].domains = [SCOPE.organisationId];
    rejects(() => createEvidence(missing, command()), 'not_found', 404);
    const duplicate = ownership(); duplicate.organisations.push(clone(duplicate.organisations[0]));
    rejects(() => createEvidence(duplicate, command()), 'shape_invalid');
    for (const collection of ['organisations', 'domains']) for (const kind of ['sparse', 'extra', 'custom', 'oversized']) {
        const value = ownership(), path = collection === 'organisations' ? ['organisations'] : ['organisations', 0, 'domains'];
        if (collection === 'domains') value.organisations[0].domains = ['example.invalid'];
        const array = at(value, path);
        if (kind === 'sparse') delete array[0];
        if (kind === 'extra') array.extra = 'x';
        if (kind === 'custom') Object.setPrototypeOf(array, Object.create(Array.prototype));
        if (kind === 'oversized') {
            if (collection === 'organisations') setAt(value, path, Array.from({ length: 1025 }, (_, i) => ({ ...array[0], organisationId: `org:${i}` })));
            else setAt(value, path, Array.from({ length: 65 }, (_, i) => `domain-${i}.invalid`));
        }
        rejects(() => createEvidence(value, command()), 'shape_invalid');
    }
    for (const [path, bad] of [[['tenant', 'displayName'], 'x'.repeat(201)], [['tenant', 'displayName'], '\ud800'],
        [['organisations', 0, 'domains'], ['x'.repeat(254)]], [['organisations', 0, 'domains'], ['bad\ud800.invalid']],
        [['tenant', 'revision'], -0], [['organisations', 0, 'revision'], -0]]) {
        const value = ownership(); setAt(value, path, bad); rejects(() => createEvidence(value, command()), 'shape_invalid');
    }
});

test('E33 exact exports and isolated execution use only hashing proxy detection and existing ownership resolution', () => {
    assert.deepEqual(Object.keys(domain).sort(), ['SCHEMA_VERSION', 'EVIDENCE_LIMITS', 'EvidenceDomainError',
        'normaliseEvidenceSelector', 'normaliseEvidenceCommand', 'normaliseEvidenceState', 'createEvidence',
        'applyEvidenceCommand', 'evidenceCommandFingerprint'].sort());
    assert.equal(SCHEMA_VERSION, 1);
    const source = fs.readFileSync(require.resolve('../api/shared/evidenceLifecycle/evidenceDomain'), 'utf8');
    const imports = [], effects = [];
    const forbidden = name => () => { effects.push(name); throw new Error(`forbidden synthetic effect: ${name}`); };
    class ExplicitDate extends Date {
        constructor(...args) { if (!args.length) forbidden('clock-constructor')(); super(...args); }
        static now() { return forbidden('clock-now')(); }
    }
    const context = vm.createContext({ Buffer, Date: ExplicitDate, module: { exports: {} },
        fixtureJson: JSON.stringify({ aggregate: ownership(), input: command() }),
        fetch: forbidden('network'), setTimeout: forbidden('timer'), setInterval: forbidden('timer'),
        require(name) {
            imports.push(name);
            if (name === 'node:crypto') return { createHash: crypto.createHash };
            if (name === 'node:util') return { types: { isProxy: util.types.isProxy } };
            if (name === '../appLifecycle/tenantDomain') return { resolveOrganisation(aggregate, selector) {
                return aggregate.organisations.find(org => org.tenantId === selector.tenantId && org.organisationId === selector.organisationId);
            } };
            return forbidden(`import:${name}`)();
        } });
    new vm.Script('Math.random = () => { throw new Error("random forbidden"); };').runInContext(context);
    new vm.Script(`(function (require, module) { ${source}\n})(require, module);`).runInContext(context, { timeout: 1000 });
    new vm.Script(`const fixture = JSON.parse(fixtureJson);
        const result = module.exports.createEvidence(fixture.aggregate, fixture.input);
        const digest = module.exports.evidenceCommandFingerprint(fixture.input);
        outputJson = JSON.stringify({ result, digest });`).runInContext(context, { timeout: 1000 });
    const output = JSON.parse(context.outputJson);
    assert.equal(output.result.versions[0].quarantine.state, 'quarantined');
    assert.match(output.digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(imports.sort(), ['node:crypto', 'node:util', '../appLifecycle/tenantDomain'].sort());
    assert.deepEqual(effects, []);
});

test('E34 finite errors expose fixed status and message without input identifiers or stack payloads', () => {
    const secretMarker = 'SYNTHETIC-UNTRUSTED-MARKER';
    const attempts = [
        () => normaliseEvidenceSelector({ ...SCOPE, tenantId: `${secretMarker}\n` }),
        () => normaliseEvidenceCommand(command({ actorSubjectKey: secretMarker })),
        () => normaliseEvidenceCommand(command({ action: secretMarker })),
        () => { const input = command(); input.payload.source.sourceMetadataSha256 = secretMarker; return normaliseEvidenceCommand(input); },
        () => { const input = command(); input.payload.policySnapshot.maximumDeclaredBytes = secretMarker; return normaliseEvidenceCommand(input); },
        () => createEvidence(ownership(), command({ organisationId: secretMarker }))
    ];
    for (const attempt of attempts) {
        let error; try { attempt(); } catch (caught) { error = caught; }
        assert.ok(error instanceof EvidenceDomainError);
        assert.equal(error.name, 'EvidenceDomainError'); assert.equal(error.message, error.code);
        assert.equal(error.statusCode, ERROR_STATUSES[error.code]);
        assert.deepEqual(Reflect.ownKeys(error).sort(), ['name', 'code', 'statusCode', 'message'].sort());
        assert.equal(Object.hasOwn(error, 'stack'), false);
        assert.equal(JSON.stringify(error).includes(secretMarker), false);
        assert.equal(String(error).includes(secretMarker), false);
    }
    // Output is an executed assertion-call count, not a claim about table rows or live controls.
    console.info(`Evidence domain executed assertion calls: ${assertionCalls}`);
});
