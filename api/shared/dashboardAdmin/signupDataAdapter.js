'use strict';

const { isProxy } = require('node:util').types;
const { addAbortListener } = require('node:events');
const { copy, fields, freeze, id, uuid, subject, instant, hash, equal } = require('../appLifecycle/dashboardRuntimeRecords');
const { starterAccountRecord, starterAccountKey } = require('../customerSignup/starterAccountAllocation');
const { starterSetupRecord, starterSetupKey } = require('../customerSignup/starterSetupDetails');
const { projectSignupRecord } = require('./signupProjection');
const { DashboardAdminError } = require('./service');

const unavailable = () => { throw new DashboardAdminError(503, 'dashboard_admin_unavailable'); };
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const unknown = () => ({ state: 'unknown' });
function entry(input, provider) {
    const value = fields(copy(input, 2048), ['recordId', 'binding']);
    id(value.recordId);
    const b = fields(value.binding, ['provider', 'tenantId', 'organisationId', 'accountId', 'setupRequestId', 'subjectKey']);
    if (b.provider !== provider) unavailable();
    id(b.tenantId); id(b.organisationId); uuid(b.accountId); uuid(b.setupRequestId);
    if (b.subjectKey !== null) subject(b.subjectKey);
    return freeze(value);
}

// Read-only domain mapping, not an authority resolver. The trusted composition
// supplies provider-specific stores and exact finite references. Its enclosing
// finite reader/service must establish current population/operator authority and
// durable audit before invoking this port. No production references are supplied.
function createSignupDataAdapter(options) {
    let provider, references, loadAccount, loadSetup, clock;
    try {
        fields(options, ['provider', 'sourceReferences', 'accountStore', 'setupStore', 'clock']);
        provider = options.provider;
        if (!['legacy', 'external'].includes(provider) || typeof options.clock !== 'function' || isProxy(options.clock)) unavailable();
        clock = options.clock;
        for (const store of [options.accountStore, options.setupStore]) {
            if (!store || isProxy(store) || typeof store.load !== 'function' || isProxy(store.load)) unavailable();
        }
        loadAccount = options.accountStore.load.bind(options.accountStore);
        loadSetup = options.setupStore.load.bind(options.setupStore);
        const values = copy(options.sourceReferences, 262144);
        if (!Array.isArray(values) || values.length > 100) unavailable();
        references = new Map();
        const keys = new Set(), accounts = new Set();
        for (const raw of values) {
            fields(raw, ['entry', 'accountKey']);
            const selected = entry(raw.entry, provider), account = selected.binding.accountId;
            if (typeof raw.accountKey !== 'string' || !/^starter-accounts\/[a-f0-9]{64}$/.test(raw.accountKey) ||
                references.has(selected.recordId) || keys.has(raw.accountKey) || accounts.has(account)) unavailable();
            references.set(selected.recordId, freeze({ entry: selected, accountKey: raw.accountKey }));
            keys.add(raw.accountKey); accounts.add(account);
        }
    } catch (_) { unavailable(); }
    let lastTime = -Infinity;
    function now() {
        const value = instant(clock()), time = Date.parse(value);
        if (time < lastTime) unavailable();
        lastTime = time;
        return value;
    }
    return async function readEntrySummary(input, readOptions = {}) {
        let timer, listener;
        const controller = new AbortController();
        try {
            const selected = entry(input, provider), reference = references.get(selected.recordId);
            if (!reference || !equal(reference.entry, selected)) unavailable();
            fields(readOptions, Object.hasOwn(readOptions, 'signal') ? ['signal'] : []);
            let signal = controller.signal;
            if (Object.hasOwn(readOptions, 'signal')) {
                const supplied = readOptions.signal;
                if (!supplied || isProxy(supplied) || Object.getPrototypeOf(supplied) !== AbortSignal.prototype ||
                    ['aborted', 'reason', 'addEventListener', 'removeEventListener'].some(key => Object.hasOwn(supplied, key))) unavailable();
                aborted.call(supplied);
                signal = AbortSignal.any([supplied, signal]);
            }
            const observedAt = now();
            function check() {
                if (aborted.call(signal) || Date.parse(now()) - Date.parse(observedAt) > 30000) unavailable();
            }
            check();
            const stopped = new Promise((_, reject) => {
                listener = addAbortListener(signal, () => reject(new DashboardAdminError(503, 'dashboard_admin_unavailable')));
                timer = setTimeout(() => controller.abort(), 10000);
            });
            return await Promise.race([stopped, (async () => {
                check();
                // Existing Azure stores own a five-second download timeout. The
                // caller signal stops continuation/disclosure, not in-flight I/O.
                const raw = await loadAccount(reference.accountKey);
                check();
                const loaded = fields(copy(raw, 33792), ['record', 'version']);
                const account = starterAccountRecord(loaded.record), slot = account.organisations[0], b = selected.binding;
                if (typeof loaded.version !== 'string' || !/^"[^"\r\n]{1,200}"$/.test(loaded.version) ||
                    starterAccountKey(account.email) !== reference.accountKey || account.accountId !== b.accountId ||
                    account.setupRequestId !== b.setupRequestId || slot.tenantId !== b.tenantId || slot.organisationId !== b.organisationId) unavailable();
                const accountSubject = account.identitySubjectKey ?? account.activation?.subjectKey ?? null;
                if (accountSubject !== b.subjectKey || account.activation &&
                    (account.activation.subjectKey !== b.subjectKey || account.activation.receiptId !== slot.activationId)) unavailable();
                const recorded = (revision, value) => ({ state: 'recorded', binding: b, revision, value });
                const record = { ...selected, account: recorded('account-etag-sha256:' + hash({ etag: loaded.version }), {
                    accountId: account.accountId, setupRequestId: account.setupRequestId, email: account.email,
                    organisation: slot.organisationName, accountType: account.accountType, createdAt: account.createdAt,
                    identitySubjectKey: account.identitySubjectKey ?? null, activation: account.activation
                }), setup: unknown(), acceptance: unknown(), registration: unknown() };
                // Validate the detached account before any further read, including
                // its chronology against the original observation, not completion.
                projectSignupRecord(record, b, observedAt);
                check();
                const rawSetup = await loadSetup(starterSetupKey(slot.organisationId));
                check();
                if (rawSetup !== null) {
                    const setup = starterSetupRecord(rawSetup), offer = setup.offerInput, proof = setup.assertion.proof;
                    if (setup.accountId !== account.accountId || setup.planId !== account.planId || setup.planSha256 !== account.planSha256 ||
                        setup.requestId !== slot.requestId || offer.kind !== 'own' || offer.accountType !== account.accountType ||
                        setup.assertion.email !== account.email ||
                        ['tenantId', 'organisationId', 'organisationName', 'grantId', 'scheduleId'].some(key => offer[key] !== slot[key]) ||
                        setup.assertion.setupRequestId === account.setupRequestId && setup.assertion.setupSha256 !== account.setupSha256 ||
                        proof.accountType !== account.accountType || proof.organisationName !== slot.organisationName ||
                        Object.hasOwn(proof, 'subjectKey') && proof.subjectKey !== b.subjectKey ||
                        (proof.source === 'external-id-signup') !== (provider === 'external')) unavailable();
                    record.setup = recorded('setup-sha256:' + hash(setup), { accountId: setup.accountId,
                        setupRequestId: setup.requestId, receivedAt: setup.assertion.receivedAt });
                }
                projectSignupRecord(record, b, observedAt);
                check();
                return freeze({ record, observedAt });
            })()]);
        } catch (_) { unavailable(); }
        finally { clearTimeout(timer); listener?.[Symbol.dispose](); controller.abort(); }
    };
}

module.exports = { createSignupDataAdapter };
