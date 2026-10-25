'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createRetainedTrialAssessmentReader } = require('../api/shared/customerSignup/retainedTrialAssessmentReader');
const { retainedTrialFixture, clone, NOW } = require('./fixtures/retainedTrialReadFixture');
const { resolveNcscAccess } = require('../api/shared/appLifecycle/dashboardResourceAuthority');
const ncsc = require('../api/shared/assessmentLifecycle/postgresNcscAssessmentStore');
const { LEGACY_PLAN_ID } = require('../api/shared/customerSignup/customerStarterPlan');
const { normaliseEntitlementState, resolveEntitlements } = require('../api/shared/appLifecycle/entitlementDomain');

function appendCurrentGrant(f, code) {
    for (const fact of f.scopes.values()) {
        const snapshot = fact.snapshot, product = code.startsWith('dashboard_');
        const grant = { ...clone(snapshot.entitlementState.grants[0]), grantId: crypto.randomUUID(), code,
            agreementRef: 'synthetic-separate-agreement', validFrom: f.account.activation.validUntil,
            validUntil: '2027-03-01T12:00:00.000Z',
            ...(!product ? { modules: code === 'managed_it_core' ? [] : ['services'], frameworks: [], limits: {},
                coverage: code === 'managed_it_core' ? [] : ['synthetic-target'],
                actions: code === 'managed_it_core' ? [] : ['support.read'] } : {}) };
        snapshot.entitlementState.grants.push(grant); snapshot.entitlementState.revision++;
        if (product) snapshot.usage.push({ ...clone(snapshot.usage[0]), grantId: grant.grantId });
    }
}

for (const client of [false, true]) for (const code of ['managed_it_core', 'tier1_support'])
    test(`unrelated current service preserves retained results (client=${client}, service=${code})`, async () => {
        const f = await retainedTrialFixture({ client }); appendCurrentGrant(f, code);
        for (const fact of f.scopes.values()) {
            normaliseEntitlementState(fact.snapshot.entitlementState, fact.snapshot.tenantAggregate);
            const current = resolveEntitlements(fact.snapshot.entitlementState, fact.snapshot.tenantAggregate,
                fact.binding.scope, NOW, fact.snapshot.flags);
            assert.equal(current.product, null); assert.equal(current.providerAccessGranted, false);
            assert.equal(current.services[code].entitled, code !== 'managed_it_core');
        }
        const before = JSON.stringify({ account: f.state.account, scopes: [...f.scopes] });
        const result = await createRetainedTrialAssessmentReader(f.options).read({}, f.input);
        assert.deepEqual(result.assessment, ncsc.projectNcscDetail(f.versions[2])); assert.equal(result.readOnly, true);
        assert.equal(JSON.stringify({ account: f.state.account, scopes: [...f.scopes] }), before);
        assert.throws(() => resolveNcscAccess(f.selected.snapshot, { scope: f.selected.binding.scope,
            identity: { subjectKey: f.actor }, resolvedAt: NOW }, 'assessment.write', NOW), /ncsc_access_denied/);
    });

for (const code of ['dashboard_score', 'dashboard_govern']) test(`a current ${code} product still routes away from retained-only reads`, async () => {
    const f = await retainedTrialFixture({ client: true }); appendCurrentGrant(f, code);
    const current = resolveEntitlements(f.original.snapshot.entitlementState, f.original.snapshot.tenantAggregate,
        f.original.binding.scope, NOW, f.original.snapshot.flags);
    assert.equal(current.product.code, code);
    await assert.rejects(createRetainedTrialAssessmentReader(f.options).read({}, f.input), { code: 'retained_read_denied' });
});

test('a future dashboard product is evaluated at the actual current clock', async () => {
    const f = await retainedTrialFixture(); appendCurrentGrant(f, 'dashboard_score');
    f.selected.snapshot.entitlementState.grants.at(-1).validFrom = '2027-02-03T12:00:00.000Z';
    const result = await createRetainedTrialAssessmentReader(f.options).read({}, f.input);
    assert.equal(result.readOnly, true);
});

for (const malformed of ['unknown code', 'authorising package parent']) test(`${malformed} cannot bypass retained-read grant validation`, async () => {
    const f = await retainedTrialFixture(); appendCurrentGrant(f, 'managed_it_core');
    const grant = f.selected.snapshot.entitlementState.grants.at(-1);
    if (malformed === 'unknown code') grant.code = 'unrecognised-product';
    else grant.actions = ['assessment.write'];
    assert.throws(() => normaliseEntitlementState(f.selected.snapshot.entitlementState, f.selected.snapshot.tenantAggregate));
    await assert.rejects(createRetainedTrialAssessmentReader(f.options).read({}, f.input), { code: 'retained_read_unavailable' });
    assert.ok(!f.queries.some(({ sql }) => sql.includes('dashboard_ncsc_assessment_revisions')));
});

for (const client of [false, true]) test(`one submitted result remains read-only after natural expiry (client=${client})`, async () => {
    const f = await retainedTrialFixture({ client }), reader = createRetainedTrialAssessmentReader(f.options);
    const before = JSON.stringify({ account: f.state.account, scopes: [...f.scopes], versions: f.versionRows });
    const result = await reader.read({}, f.input);
    assert.equal(result.readOnly, true); assert.equal(result.trialEndedAt, f.account.activation.validUntil);
    assert.deepEqual(result.assessment, ncsc.projectNcscDetail(f.versions[2]));
    assert.deepEqual(Object.keys(reader), ['read']);
    assert.equal(JSON.stringify({ account: f.state.account, scopes: [...f.scopes], versions: f.versionRows }), before);
    assert.ok(f.queries.every(({ sql }) => /^SELECT\b/.test(sql.trim())));
    assert.ok(!f.queries.some(({ sql }) => /INSERT|UPDATE\s+nofries|DELETE|usage\.reserve/.test(sql)));
    assert.throws(() => resolveNcscAccess(f.selected.snapshot, { scope: f.selected.binding.scope,
        identity: { subjectKey: f.actor }, resolvedAt: NOW }, 'assessment.write', NOW), /ncsc_access_denied/);
});

test('reads require fresh trusted capture rather than caller identity, plan, tenant or a write action', async () => {
    const f = await retainedTrialFixture(), reader = createRetainedTrialAssessmentReader(f.options);
    for (const extra of [{ tenantId: f.slot.tenantId }, { subjectKey: f.actor }, { planId: f.account.planId },
        { action: 'save' }, { authenticated: true }, { limit: 100 }]) {
        await assert.rejects(reader.read({}, { ...f.input, ...extra }), { code: 'retained_read_input_invalid' });
    }
    assert.equal(f.queries.length, 0);
    f.state.capture = null;
    await assert.rejects(reader.read({ authenticated: true }, f.input), { code: 'retained_read_denied' });
    assert.equal(f.queries.length, 0);
});

for (const [name, mutate] of [
    ['operator', f => { f.state.capture.kind = 'operator_dashboard'; }],
    ['expired session', f => { f.state.capture.expiresAt = NOW; }],
    ['expired request', f => { f.state.capture.deadline = NOW; }],
    ['revoked subject', f => { f.state.subject.status = 'revoked'; }],
    ['subject revision rebound', f => { f.state.subject.revision = 1; }],
    ['subject binding rebound', f => { f.state.subject.bindingId = crypto.randomUUID(); }],
    ['foreign account owner', f => { f.state.account.identitySubjectKey = crypto.randomUUID() + ':' + crypto.randomUUID(); }],
    ['foreign binding', f => { f.input.bindingId = crypto.randomUUID(); }],
    ['runtime fence', f => { f.state.instance.ingressStatus = 'fenced'; }],
    ['restore epoch', f => { f.state.instance.restoreEpoch = crypto.randomUUID(); }],
    ['revoked binding', f => { f.selected.binding.status = 'revoked'; f.selected.binding.revision = 1; }],
    ['changed binding identity', f => { f.selected.binding.identity.oid = crypto.randomUUID(); }],
    ['changed exact expiry', f => { f.selected.binding.validUntil = '2027-02-03T12:00:00.000Z'; }],
    ['suspended tenant', f => { f.selected.snapshot.tenantAggregate.tenant.recordStatus = 'suspended'; }],
    ['suspended organisation', f => { f.selected.snapshot.tenantAggregate.organisations[0].recordStatus = 'suspended'; }],
    ['revoked member', f => { f.selected.snapshot.membershipState.memberships[0].status = 'revoked'; }],
    ['suspended product', f => { f.selected.snapshot.entitlementState.grants[0].status = 'suspended'; }],
    ['disabled dashboard', f => { f.selected.snapshot.flags.enabled.dashboard = false; }],
    ['disabled cyber module', f => { f.selected.snapshot.flags.enabled.cyber_security = false; }],
    ['missing profile', f => { f.selected.snapshot.flags.frameworks = []; }]
]) test(`${name} fails closed without treating expiry as renewed authority`, async () => {
    const f = await retainedTrialFixture(); mutate(f);
    await assert.rejects(createRetainedTrialAssessmentReader(f.options).read({}, f.input), error => [403, 503].includes(error.statusCode));
});

test('a consultant parent revocation denies a still-active selected client record', async () => {
    const f = await retainedTrialFixture({ client: true }); f.original.binding.status = 'revoked'; f.original.binding.revision = 1;
    await assert.rejects(createRetainedTrialAssessmentReader(f.options).read({}, f.input), { code: 'retained_read_denied' });
});

test('foreign/missing exact assessments are not found only after current authorization', async () => {
    const f = await retainedTrialFixture();
    await assert.rejects(createRetainedTrialAssessmentReader(f.options).read({}, { ...f.input, assessmentId: 'foreign-assessment' }), { code: 'retained_read_not_found' });
});

test('malformed or incomplete history yields no result and no quota or record mutation', async () => {
    const f = await retainedTrialFixture(); f.versionRows[1].parent_sha256 = '0'.repeat(64);
    await assert.rejects(createRetainedTrialAssessmentReader(f.options).read({}, f.input), { code: 'retained_read_unavailable' });
});

for (const change of ['orphan history', 'oversized head']) test(`${change} fails within the existing technical history bound`, async () => {
    const f = await retainedTrialFixture();
    if (change === 'orphan history') f.state.missingHead = true;
    else f.head.revision = ncsc.MAX_REVISION + 1;
    await assert.rejects(createRetainedTrialAssessmentReader(f.options).read({}, f.input), { code: 'retained_read_unavailable' });
});

test('a valid retained legacy activation does not acquire the separately versioned read right', async () => {
    const f = await retainedTrialFixture({ planId: LEGACY_PLAN_ID });
    await assert.rejects(createRetainedTrialAssessmentReader(f.options).read({}, f.input), { code: 'retained_read_denied' });
    assert.equal(f.queries.length, 0);
});

test('valid saved drafts remain outside the submitted-result reader', async () => {
    const f = await retainedTrialFixture();
    f.versionRows.pop(); f.head.revision = 1; f.head.payload_sha256 = f.versions[1].revisionSha256;
    await assert.rejects(createRetainedTrialAssessmentReader(f.options).read({}, f.input), { code: 'retained_read_denied' });
});

test('an existing revoked customer gate denies despite a currently valid callback capture', async () => {
    const f = await retainedTrialFixture(), c = f.state.capture;
    f.state.gate = { schemaVersion: 1, sessionSha256: c.sessionSha256, kind: 'customer', parentSessionSha256: null,
        operatorIssuanceSha256: null, identitySha256: f.hash(c.identityPayload), identityPayload: c.identityPayload, subjectKey: f.actor, status: 'revoked', revision: 1,
        selectionGeneration: 1, generationToken: 'f'.repeat(64), selectedBindingId: f.slot.bindingId,
        selectedTenantId: f.slot.tenantId, selectedOrganisationId: f.slot.organisationId, discoveryCaseId: null, discoveryProofId: null,
        issuedAt: c.issuedAt, expiresAt: c.expiresAt, restoreEpoch: c.restoreEpoch, instanceId: c.instanceId,
        createdAt: c.issuedAt, updatedAt: NOW, revokedAt: NOW };
    await assert.rejects(createRetainedTrialAssessmentReader(f.options).read({}, f.input), { code: 'retained_read_denied' });
});

test('pre-expiry active assessments cannot use the retained-results interface', async () => {
    const f = await retainedTrialFixture(); f.state.now = '2027-01-31T12:00:00.000Z';
    f.state.capture.issuedAt = '2027-01-31T11:59:00.000Z'; f.state.capture.expiresAt = '2027-01-31T13:00:00.000Z'; f.state.capture.deadline = '2027-01-31T12:00:30.000Z';
    await assert.rejects(createRetainedTrialAssessmentReader(f.options).read({}, f.input), { code: 'retained_read_denied' });
});

for (const change of ['subject', 'capture', 'time', 'account']) test(`a ${change} change during history I/O prevents response release`, async () => {
    const f = await retainedTrialFixture(); let changed = false;
    f.state.hook = sql => { if (!changed && sql.includes('dashboard_ncsc_assessment_revisions')) {
        changed = true;
        if (change === 'subject') f.state.subject.status = 'revoked';
        if (change === 'capture') f.state.capture = null;
        if (change === 'time') f.state.now = f.state.capture.deadline;
        if (change === 'account') f.state.account.activation = null;
    } };
    await assert.rejects(createRetainedTrialAssessmentReader(f.options).read({}, f.input), error => [403, 503].includes(error.statusCode));
});

test('ambiguous completion releases no buffered result; a new read may safely retry', async () => {
    const f = await retainedTrialFixture(), reader = createRetainedTrialAssessmentReader(f.options);
    f.state.ambiguous = true;
    await assert.rejects(reader.read({}, f.input), { code: 'retained_read_unavailable' });
    f.state.ambiguous = false;
    assert.equal((await reader.read({}, f.input)).assessment.revision, 2);
});

test('current authentication is rechecked after transaction acknowledgement before releasing the buffer', async () => {
    const f = await retainedTrialFixture(), original = f.options.database;
    const reader = createRetainedTrialAssessmentReader({ ...f.options, database: {
        async withTenantTransaction(id, work) {
            const result = await original.withTenantTransaction(id, work); f.state.capture = null; return result;
        }
    } });
    await assert.rejects(reader.read({}, f.input), { code: 'retained_read_denied' });
});

test('a repeated request rechecks revocation instead of replaying a cached success', async () => {
    const f = await retainedTrialFixture(), reader = createRetainedTrialAssessmentReader(f.options), request = {};
    assert.equal((await reader.read(request, f.input)).readOnly, true);
    f.state.subject.status = 'revoked';
    await assert.rejects(reader.read(request, f.input), { code: 'retained_read_denied' });
});

test('simultaneous identical reads share only the in-flight operation and reject selection substitution', async () => {
    const f = await retainedTrialFixture(), reader = createRetainedTrialAssessmentReader(f.options), request = {};
    const first = reader.read(request, f.input), second = reader.read(request, clone(f.input));
    assert.equal(first, second);
    await assert.rejects(reader.read(request, { ...f.input, assessmentId: 'changed' }), { code: 'retained_read_denied' });
    assert.equal((await first).readOnly, true);
});

async function detachedClientFixture() {
    const f=await retainedTrialFixture({client:true});
    f.state.account.organisations=f.state.account.organisations.slice(0,1);
    const aliases=new Map([[f.account.accountId+'/'+f.slot.bindingId,clone(f.slot)]]),reads=[];
    f.options.accountStore.loadClientByBinding=async(accountId,bindingId)=>{
        reads.push({accountId,bindingId});return clone(aliases.get(accountId+'/'+bindingId)||null);
    };
    f.options.accountStore.listClients=async()=>{throw new Error('whole directory reads are forbidden');};
    return{...f,aliases,clientReads:reads};
}
test('reader predecessor opens a retained detached client result with exact binding lookup and no lifecycle repair',async()=>{
    const f=await detachedClientFixture(),before=JSON.stringify({account:f.state.account,aliases:[...f.aliases],scopes:[...f.scopes]});
    assert.equal(f.state.account.organisations.length,1);
    const result=await createRetainedTrialAssessmentReader(f.options).read({},f.input);
    assert.deepEqual(result.assessment,ncsc.projectNcscDetail(f.versions[2]));assert.equal(result.readOnly,true);
    assert.deepEqual(f.clientReads,Array(3).fill({accountId:f.account.accountId,bindingId:f.slot.bindingId}));
    assert.equal(JSON.stringify({account:f.state.account,aliases:[...f.aliases],scopes:[...f.scopes]}),before);
});
for(const variant of ['missing','foreign account','swapped binding','malformed'])test(`reader predecessor denies a ${variant} detached alias before data disclosure`,async()=>{
    const f=await detachedClientFixture(),key=f.account.accountId+'/'+f.slot.bindingId;
    if(variant==='missing')f.aliases.delete(key);
    if(variant==='foreign account'){f.aliases.delete(key);f.aliases.set(crypto.randomUUID()+'/'+f.slot.bindingId,clone(f.slot));}
    if(variant==='swapped binding')f.aliases.set(key,{...clone(f.slot),bindingId:crypto.randomUUID()});
    if(variant==='malformed')f.aliases.set(key,{...clone(f.slot),extra:true});
    await assert.rejects(createRetainedTrialAssessmentReader(f.options).read({},f.input),error=>[403,503].includes(error.statusCode));
    assert.equal(f.clientReads.length,1);assert.equal(f.queries.length,0);
});
test('reader predecessor withholds a detached result if its exact alias disappears during history I/O',async()=>{
    const f=await detachedClientFixture();f.state.hook=sql=>{if(sql.includes('dashboard_ncsc_assessment_revisions'))f.aliases.clear();};
    await assert.rejects(createRetainedTrialAssessmentReader(f.options).read({},f.input),{code:'retained_read_denied'});
    assert.equal(f.clientReads.length,2);
});
