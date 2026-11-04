'use strict';

// Unwired operator command. Trusted ports must be supplied by a separately
// qualified host; no environment, Azure client or HTTP route is opened here.
const { createHash } = require('node:crypto');
const { fields, copy, freeze, hash, equal, uuid, subject, digest } = require('../appLifecycle/dashboardRuntimeRecords');
const { starterAccountRecord } = require('./starterAccountAllocation');
const { authority } = require('./customerAuthority');
const { createEmptySignupReset } = require('./emptySignupReset');
const { createFencedEmptySignupResetPorts } = require('./fencedEmptySignupResetPorts');
const ABSENT = Object.freeze(['registration', 'canonicalTenant', 'canonicalOrganisation', 'starterAccount',
    'starterScopes', 'acceptance', 'binding', 'admission', 'customerContent', 'acceptedInvitation', 'signupIndexReference']);
const fail = () => { throw new Error('guarded_reset_refused'); };
const sha = value => createHash('sha256').update(value).digest('hex');
const SHA = /^[a-f0-9]{40}$/;
const names = ['account', 'authority'];
const AUDIT_PREFIX = 'operator-empty-signup-reset/';
function requestValue(input) {
    const r = fields(copy(input, 4096), ['schemaVersion', 'operationId', 'sourceSha', 'email', 'customerSubjectKey',
        'staffSubjectKey', 'providerKey', 'createdAt', 'expiresAt']);
    uuid(r.operationId); subject(r.customerSubjectKey); subject(r.staffSubjectKey); digest(r.providerKey);
    if (r.schemaVersion !== 1 || !SHA.test(r.sourceSha) || r.customerSubjectKey === r.staffSubjectKey ||
        typeof r.email !== 'string' || r.email.length > 254 || r.email !== r.email.trim().toLowerCase() ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email) ||
        !Number.isSafeInteger(r.createdAt) || !Number.isSafeInteger(r.expiresAt) || r.createdAt < 0 ||
        r.expiresAt <= r.createdAt || r.expiresAt - r.createdAt > 3600000) fail();
    return freeze(r);
}
const auditKey = (phase, id) => AUDIT_PREFIX + id + '/' + phase + '.json';
const outcome = (pending = false) => Object.freeze({ status: pending ? 'pending' : 'blocked',
    code: pending ? 'reset_recovery_required' : 'reset_preparation_unavailable' });

function eligible(found, request, at) {
    fields(found, ['status', 'target', 'evidence']);
    if (found.status !== 'ready') fail();
    const e = fields(copy(found.evidence, 8192), ['provider', 'accountId', 'tenantId', 'organisationId',
        'subjectKey', 'incident', 'visibility', 'dependencies']);
    const incident = fields(e.incident, ['releaseSha', 'supportReference', 'stage', 'code']);
    fields(e.dependencies, ABSENT);
    if (e.provider !== 'external' || e.visibility !== 'complete' || e.subjectKey !== request.customerSubjectKey ||
        ABSENT.some(key => e.dependencies[key] !== 'absent') || !SHA.test(incident.releaseSha) ||
        !/^NF-[A-F0-9]{16}$/.test(incident.supportReference) || incident.stage !== 'organisation_preparation' ||
        incident.code !== 'signup_state_unavailable') fail();
    [e.accountId, e.tenantId, e.organisationId].forEach(uuid); subject(e.subjectKey);
    const a = starterAccountRecord(found.target.account.record), slot = a.organisations[0];
    // Current main's coordinator requires both versioned pointers. Missing
    // authority is deliberately refused until #47's extension is integrated.
    const raw = found.target.authority.record;
    const auth = authority(raw, request.customerSubjectKey, Math.min(at, raw.expiresAt - 1));
    if (a.activation !== null || a.organisations.length !== 1 || slot.kind !== 'own' ||
        a.email !== request.email || a.identitySubjectKey !== e.subjectKey || a.accountId !== e.accountId ||
        slot.tenantId !== e.tenantId || slot.organisationId !== e.organisationId || auth.status !== 'active' ||
        auth.email !== a.email || auth.accountType !== a.accountType || auth.tenantId !== slot.tenantId ||
        auth.organisationId !== slot.organisationId || auth.bindingId !== slot.bindingId) fail();
    return freeze({ status: 'ready', target: { ...copy(found.target), dependencyDigest: hash(e) }, evidence: e });
}
function manifestFor(request, plan, evidence, auditStoreSha256) {
    const body = { schemaVersion: 1, operationId: request.operationId, sourceSha: request.sourceSha,
        createdAt: request.createdAt, expiresAt: request.expiresAt, actorSubjectKey: request.staffSubjectKey,
        evidence, plan, auditStoreSha256,
        coordination: [
            { key: 'customer-starter/reset-writer-fence/control.json', action: 'hold_shared_writer_fence' },
            { key: 'customer-starter/empty-signup-reset-fences/' + sha(plan.records.account.key) + '.json', action: 'hold_target_fence' },
            ...['requested', 'reset', 'rollback'].map(phase => ({ key: auditKey(phase, request.operationId),
                action: 'append_receipt', when: phase === 'rollback' ? 'explicit_rollback' : 'execute' }))
        ], changes: names.map(name => ({ action: 'delete_active_pointer', record: name, ...plan.records[name] })) };
    return freeze({ ...body, manifestSha256: hash(body) });
}
function manifestValue(input, request, auditStoreSha256) {
    const m = fields(copy(input, 16384), ['schemaVersion', 'operationId', 'sourceSha', 'createdAt', 'expiresAt',
        'actorSubjectKey', 'evidence', 'plan', 'auditStoreSha256', 'coordination', 'changes', 'manifestSha256']);
    if (!equal(m, manifestFor(request, m.plan, m.evidence, auditStoreSha256))) fail();
    return freeze(m);
}

function createGuardedEmptySignupReset({ inspect, inspectRecovery, blobs, withExclusiveTarget, writerFence,
    checkAuthority, checkWriterAdoption, audit, auditStoreSha256, now = Date.now }) {
    digest(auditStoreSha256);
    if (![inspect, checkAuthority, now].every(f => typeof f === 'function')) fail();
    async function read(request, recoveryPlan) {
        const found = await (recoveryPlan ? inspectRecovery(request, recoveryPlan) : inspect(request));
        return eligible(found, request, now());
    }
    async function authorised(request) {
        // Assertion ports throw on denial and return no caller-controlled witness.
        if (await checkAuthority(request) !== undefined) fail();
    }
    async function save(phase, id, value) {
        try { await audit.write(auditKey(phase, id), value, { ifNoneMatch: '*' }); } catch (_) { /* Reconcile lost acknowledgement. */ }
        if (!equal(await audit.read(auditKey(phase, id)), value)) fail();
    }
    async function run(argv, input) {
        let pending = false;
        try {
            const flags = copy(argv, 256);
            if (!Array.isArray(flags) || ![[], ['--execute'], ['--execute', '--rollback']].some(v => equal(v, flags))) fail();
            const execute = flags.length > 0, rollback = flags.length === 2;
            const options = fields(copy(input, 32768), execute ? ['request', 'manifest', 'confirmSha256'] : ['request']);
            const r = requestValue(options.request);
            await authorised(r);
            if (!execute) {
                const found = await read(r);
                const inventory = await createEmptySignupReset({ inspect: async () => found, now }).inventory(r);
                if (inventory.status !== 'ready' || !blobs || typeof blobs.readVersion !== 'function') fail();
                for (const name of names) {
                    const p = inventory.plan.records[name], bytes = await blobs.readVersion(p.key, p.versionId);
                    if (!Buffer.isBuffer(bytes) || bytes.length > (name === 'account' ? 32768 : 16384) ||
                        sha(bytes) !== p.sha256 || !equal(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), found.target[name].record)) fail();
                }
                await authorised(r);
                if (now() < r.createdAt || now() >= r.expiresAt) fail();
                return freeze({ status: 'ready', mode: 'dry_run', manifest: manifestFor(r, inventory.plan, found.evidence, auditStoreSha256) });
            }
            const m = manifestValue(options.manifest, r, auditStoreSha256);
            if (options.confirmSha256 !== m.manifestSha256 || ![inspectRecovery, withExclusiveTarget, checkWriterAdoption,
                audit?.read, audit?.write].every(f => typeof f === 'function')) fail();
            // No caller flag can replace the host's current source/instance/epoch,
            // old-writer drainage, version recovery and writer-participation checks.
            const adoption = async () => { await authorised(r); if (await checkWriterAdoption(r, m) !== undefined) fail(); };
            await adoption();
            const intent = freeze({ schemaVersion: 1, operationId: r.operationId, sourceSha: m.sourceSha,
                actorSubjectKey: r.staffSubjectKey, manifestSha256: m.manifestSha256 });
            const protectedPorts = createFencedEmptySignupResetPorts({ writerFence, withExclusiveTarget, blobs });
            let calls = 0, settled = false, answer;
            let returned;
            try { returned = await protectedPorts.withExclusiveTarget({ request: r, plan: m.plan }, async fence => {
                if (settled || ++calls !== 1) fail();
                pending = true; // Unknown retained intent must never release exclusion on an audit-read failure.
                const check = async () => {
                    if (settled || calls !== 1) fail();
                    await adoption(); await fence.assertCurrent(); await adoption();
                    if (settled || calls !== 1) fail();
                };
                try {
                    await check();
                    const requested = await audit.read(auditKey('requested', r.operationId));
                    if (requested !== null && !equal(requested, intent)) fail();
                    const restored = await audit.read(auditKey('rollback', r.operationId));
                    const completed = await audit.read(auditKey('reset', r.operationId));
                    const receipt = action => freeze({ ...intent, action, status: 'succeeded' });
                    if (restored !== null && !equal(restored, receipt('rollback')) ||
                        completed !== null && !equal(completed, receipt('reset')) ||
                        (restored !== null || completed !== null) && requested === null) fail();
                    if (restored !== null && !rollback) fail();
                    const previous = rollback ? restored : completed;
                    if (previous !== null) { await check(); await fence.complete(); return answer = freeze(copy(previous)); }
                    if (rollback && requested === null) fail();
                    const fresh = await read(r, requested ? m.plan : null);
                    if (!equal(m, manifestFor(r, m.plan, fresh.evidence, auditStoreSha256))) fail();
                    // The core validates plan/request hashes, original version bytes,
                    // ETags and dependency digest again under this same exclusion.
                    if (requested === null) {
                        const inventory = await createEmptySignupReset({ inspect: async () => fresh, now }).inventory(r);
                        if (inventory.status !== 'ready' || !equal(inventory.plan, m.plan)) fail();
                        await check(); pending = true; await save('requested', r.operationId, intent);
                    }
                    let coreCompleted = false;
                    const coordinator = createEmptySignupReset({ now, blobs: protectedPorts.blobs,
                        inspect: () => read(r, requested ? m.plan : null), inspectRecovery: () => read(r, m.plan),
                        withExclusiveTarget: async (_, work) => work({ assertCurrent: check,
                            retain: async () => {}, complete: async () => { coreCompleted = true; } }) });
                    const result = await coordinator[rollback ? 'rollback' : 'reset'](r, m.plan);
                    if (!coreCompleted || result.status !== (rollback ? 'recovered' : 'reset')) fail();
                    await check();
                    const saved = receipt(rollback ? 'rollback' : 'reset');
                    await save(saved.action, r.operationId, saved);
                    await check(); await fence.complete();
                    return answer = saved;
                } catch (_) {
                    // Intent, uncertain effects or uncertain receipt publication must
                    // retain common creator intent and request target retention. A
                    // faulty target port cannot authorize release of the common fence.
                    if (pending) { try { await fence.retain(); } catch (_) {} }
                    return answer = outcome(pending);
                }
            }); } finally { settled = true; }
            if (calls !== 1 || returned !== answer) return outcome(pending);
            return answer;
        } catch (_) { return outcome(pending); }
    }
    return Object.freeze({ run });
}
module.exports = { createGuardedEmptySignupReset, ABSENT };
