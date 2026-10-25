'use strict';

// Operator-only coordinator. Nothing in the HTTP launcher imports this module.
// The deployed writers do not yet supply its required exclusive-target port.
const { createHash } = require('node:crypto');
const { types: { isProxy } } = require('node:util');
const { starterAccountKey, starterAccountRecord } = require('./starterAccountAllocation');
const { authority, subjectHash } = require('./customerAuthority');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SUBJECT = /^[a-f0-9-]{36}:[a-f0-9-]{36}$/;
const SHA = /^[a-f0-9]{64}$/;
const REQUEST_KEYS = ['schemaVersion', 'operationId', 'sourceSha', 'email', 'customerSubjectKey',
    'staffSubjectKey', 'providerKey', 'createdAt', 'expiresAt'];
const NAMES = ['account', 'authority'];
const LIMIT = { account: 32768, authority: 16384 };
const fail = code => { const error = new Error(code); error.resetCode = code; throw error; };
const result = (status, code, phase) => Object.freeze({ status, code, phase });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function exact(value, keys) {
    if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value) ||
        ![null, Object.prototype].includes(Object.getPrototypeOf(value)) ||
        Reflect.ownKeys(value).length !== keys.length) fail('invalid_input');
    for (const key of keys) {
        const d = Object.getOwnPropertyDescriptor(value, key);
        if (!d || !Object.hasOwn(d, 'value')) fail('invalid_input');
    }
    return value;
}
function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
        .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    return JSON.stringify(value);
}
function request(input, now, fresh = true) {
    exact(input, REQUEST_KEYS);
    if (input.schemaVersion !== 1 || !Number.isSafeInteger(now) || now < 0 ||
        typeof input.operationId !== 'string' || !UUID.test(input.operationId) ||
        typeof input.sourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(input.sourceSha) ||
        typeof input.email !== 'string' || input.email.length > 254 || input.email !== input.email.trim().toLowerCase() ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) ||
        ![input.customerSubjectKey, input.staffSubjectKey].every(v => typeof v === 'string' && SUBJECT.test(v) && v.split(':').every(p => UUID.test(p))) ||
        input.customerSubjectKey === input.staffSubjectKey || typeof input.providerKey !== 'string' || !SHA.test(input.providerKey) ||
        !Number.isSafeInteger(input.createdAt) || !Number.isSafeInteger(input.expiresAt) ||
        input.createdAt < 0 || input.expiresAt <= input.createdAt || input.expiresAt - input.createdAt > 3600000 ||
        fresh && (input.createdAt > now || input.expiresAt <= now)) fail('invalid_input');
    return Object.freeze(Object.fromEntries(REQUEST_KEYS.map(key => [key, input[key]])));
}
function expectedKeys(r) {
    return { account: 'customer-starter/' + starterAccountKey(r.email) + '.json',
        authority: 'customer-subjects/' + subjectHash(r.customerSubjectKey) + '.json' };
}
function pointer(input, key) {
    exact(input, ['key', 'etag', 'versionId', 'sha256']);
    if (input.key !== key || typeof input.etag !== 'string' || !/^"[^"\r\n]{1,200}"$/.test(input.etag) ||
        typeof input.versionId !== 'string' || !/^[A-Za-z0-9:._-]{1,128}$/.test(input.versionId) ||
        typeof input.sha256 !== 'string' || !SHA.test(input.sha256)) fail('invalid_plan');
    return Object.freeze({ key, etag: input.etag, versionId: input.versionId, sha256: input.sha256 });
}
function plan(input, r) {
    exact(input, ['schemaVersion', 'operationId', 'requestSha256', 'bindingSha256', 'containerSha256', 'dependencyDigest', 'records']);
    exact(input.records, NAMES);
    const keys = expectedKeys(r);
    if (input.schemaVersion !== 1 || input.operationId !== r.operationId || input.requestSha256 !== sha(canonical(r)) ||
        typeof input.containerSha256 !== 'string' || !SHA.test(input.containerSha256) ||
        typeof input.dependencyDigest !== 'string' || !SHA.test(input.dependencyDigest) ||
        typeof input.bindingSha256 !== 'string' || !SHA.test(input.bindingSha256)) fail('invalid_plan');
    const records = Object.freeze(Object.fromEntries(NAMES.map(name => [name, pointer(input.records[name], keys[name])])));
    const unsigned = { schemaVersion: 1, operationId: r.operationId, requestSha256: input.requestSha256,
        containerSha256: input.containerSha256, dependencyDigest: input.dependencyDigest, records };
    if (sha(canonical(unsigned)) !== input.bindingSha256) fail('invalid_plan');
    return Object.freeze({ ...unsigned, bindingSha256: input.bindingSha256 });
}
function makePlan(r, target) {
    exact(target, ['keys', 'account', 'authority', 'containerSha256', 'dependencyDigest']);
    const keys = expectedKeys(r);
    exact(target.keys, NAMES);
    for (const name of NAMES) exact(target[name], ['record', 'etag', 'versionId', 'sha256']);
    if (target.keys.account !== keys.account || target.keys.authority !== keys.authority) fail('invalid_inventory');
    const records = Object.fromEntries(NAMES.map(name => [name, {
        key: keys[name], etag: target[name].etag, versionId: target[name].versionId, sha256: target[name].sha256
    }]));
    const unsigned = { schemaVersion: 1, operationId: r.operationId, requestSha256: sha(canonical(r)),
        containerSha256: target.containerSha256, dependencyDigest: target.dependencyDigest, records };
    return plan({ ...unsigned, bindingSha256: sha(canonical(unsigned)) }, r);
}
function bytes(value, name) {
    if (!Buffer.isBuffer(value) || value.length < 1 || value.length > LIMIT[name]) fail('record_unavailable');
    return value;
}
function validateOriginals(originals, r, now) {
    let account, current;
    try {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        account = starterAccountRecord(JSON.parse(decoder.decode(originals.account)));
        const raw = JSON.parse(decoder.decode(originals.authority));
        // Recovery copies exact old bytes; it does not revive expired authority.
        current = authority(raw, r.customerSubjectKey, Math.min(now, raw.expiresAt - 1));
    } catch (_) { fail('recovery_unavailable'); }
    const slot = account.organisations[0];
    if (account.email !== r.email || account.identitySubjectKey !== r.customerSubjectKey || account.activation !== null ||
        account.organisations.length !== 1 || slot.kind !== 'own' || current.email !== r.email ||
        current.accountType !== account.accountType || current.tenantId !== slot.tenantId ||
        current.organisationId !== slot.organisationId || current.bindingId !== slot.bindingId) fail('recovery_unavailable');
}

function createEmptySignupReset({ inspect, inspectRecovery, blobs, withExclusiveTarget, now = Date.now }) {
    if (typeof inspect !== 'function' || typeof now !== 'function') fail('invalid_configuration');
    async function inventory(input) {
        try {
            const r = request(input, now()), found = await inspect(r);
            if (found?.status !== 'ready') return { ...result('blocked', 'inventory_blocked', 'inventory'),
                // The adapter's closed public projection is retained separately
                // by its caller. Arbitrary adapter text never becomes a code.
                plan: null };
            return Object.freeze({ ...result('ready', 'inventory_ready', 'inventory'), plan: makePlan(r, found.target) });
        } catch (_) { return result('blocked', 'inventory_unavailable', 'inventory'); }
    }
    async function run(input, suppliedPlan, recovery) {
        let phase = 'admission', touched = false, r, p;
        try { r = request(input, now(), !recovery); p = plan(suppliedPlan, r); }
        catch (_) { return result('blocked', 'invalid_plan', phase); }
        // This is deliberately not a boolean approval or timeout witness. The
        // trusted binding must serialize participating application writers and
        // retain an incomplete durable fence across process loss. No deployed
        // binding exists today, so ordinary construction is read-only.
        if (typeof withExclusiveTarget !== 'function') return result('blocked', 'writer_fence_unavailable', phase);
        if (recovery && typeof inspectRecovery !== 'function') return result('blocked', 'recovery_binding_unavailable', phase);
        if (!blobs || !['readCurrent', 'readVersion', 'remove', 'restore'].every(k => typeof blobs[k] === 'function')) {
            return result('blocked', 'storage_binding_unavailable', phase);
        }
        let calls = 0, finished = false, portSettled = false, callbackResult;
        try {
            const returned = await withExclusiveTarget(Object.freeze({ request: r, plan: p }), async fence => {
                if (portSettled || ++calls !== 1) return result('blocked', 'fence_outcome_unconfirmed', phase);
                if (!fence || !['assertCurrent', 'retain', 'complete'].every(k => typeof fence[k] === 'function')) {
                    finished = true;
                    return callbackResult = result('blocked', 'writer_fence_unavailable', phase);
                }
                const check = async () => {
                    const clockCheck = () => {
                        const at = now();
                        if (!Number.isSafeInteger(at) || at < r.createdAt || !recovery && at >= r.expiresAt) fail('plan_expired');
                    };
                    clockCheck();
                    await fence.assertCurrent();
                    clockCheck();
                    if (portSettled || calls !== 1) fail('fence_invalid');
                };
                try {
                    await check(); phase = 'recovery_read';
                    const originals = {};
                    for (const name of NAMES) {
                        await check();
                        originals[name] = bytes(await blobs.readVersion(p.records[name].key, p.records[name].versionId), name);
                        if (sha(originals[name]) !== p.records[name].sha256) fail('recovery_unavailable');
                    }
                    validateOriginals(originals, r, now());
                    phase = 'inventory_recheck'; await check();
                    const found = await (recovery ? inspectRecovery(r, p) : inspect(r));
                    if (found?.status !== 'ready' || makePlan(r, found.target).bindingSha256 !== p.bindingSha256) fail('inventory_changed');
                    // Refuse a known conflict before the first destructive or
                    // restorative effect, rather than discover it halfway.
                    for (const name of NAMES) {
                        await check();
                        const current = await blobs.readCurrent(p.records[name].key);
                        if (current !== null && (sha(bytes(current.bytes, name)) !== p.records[name].sha256 ||
                            !recovery && current.etag !== p.records[name].etag)) fail('record_changed');
                    }
                    // Delete account first and authority last. Rollback restores
                    // the account first and authority last. No SQL/directory or
                    // archive mutation exists on this port.
                    for (const name of NAMES) {
                        phase = recovery ? 'restore_' + name : 'delete_' + name;
                        await check();
                        let before = await blobs.readCurrent(p.records[name].key);
                        if (before !== null && (sha(bytes(before.bytes, name)) !== p.records[name].sha256 ||
                            !recovery && before.etag !== p.records[name].etag)) fail('record_changed');
                        if (recovery ? before !== null : before === null) continue;
                        await check(); touched = true;
                        try {
                            if (recovery) await blobs.restore(p.records[name].key, originals[name],
                                { conditions: { ifNoneMatch: '*' } });
                            else await blobs.remove(p.records[name].key, { conditions: { ifMatch: p.records[name].etag } });
                        } catch (_) { /* Reconcile this exact effect before any repeat. */ }
                        await check(); phase = 'reconcile_' + name;
                        const after = await blobs.readCurrent(p.records[name].key);
                        if (recovery) {
                            if (after === null) fail('mutation_unconfirmed');
                            if (sha(bytes(after.bytes, name)) !== p.records[name].sha256) fail('record_changed');
                        } else if (after !== null) {
                            if (sha(bytes(after.bytes, name)) !== p.records[name].sha256 || after.etag !== p.records[name].etag) fail('record_changed');
                            fail('mutation_not_applied');
                        }
                    }
                    phase = 'final_read'; await check();
                    for (const name of NAMES) {
                        const found = await blobs.readCurrent(p.records[name].key);
                        if (recovery ? found === null || sha(bytes(found.bytes, name)) !== p.records[name].sha256 : found !== null) fail('record_changed');
                    }
                    await check(); phase = 'fence_completion'; await fence.complete();
                    finished = true;
                    return callbackResult = result(recovery ? 'recovered' : 'reset', recovery ? 'originals_restored' : 'active_pointers_absent', 'complete');
                } catch (error) {
                    if (touched) {
                        try { await fence.retain(); } catch (_) {
                            finished = true;
                            return callbackResult = result('pending', 'fence_retention_unconfirmed', phase);
                        }
                    }
                    const allowed = ['plan_expired', 'recovery_unavailable', 'inventory_changed', 'record_changed',
                        'mutation_unconfirmed', 'mutation_not_applied'];
                    finished = true;
                    return callbackResult = result(touched ? 'pending' : 'blocked', allowed.includes(error?.resetCode) ? error.resetCode : 'operation_unavailable', phase);
                }
            });
            portSettled = true;
            if (calls !== 1 || !finished || returned !== callbackResult) return result(touched ? 'pending' : 'blocked', 'fence_outcome_unconfirmed', phase);
            return callbackResult;
        } catch (_) {
            portSettled = true;
            return result(touched ? 'pending' : 'blocked', 'fence_outcome_unconfirmed', phase);
        }
    }
    return Object.freeze({ inventory, reset: (input, p) => run(input, p, false),
        rollback: (input, p) => run(input, p, true) });
}

module.exports = { createEmptySignupReset };
