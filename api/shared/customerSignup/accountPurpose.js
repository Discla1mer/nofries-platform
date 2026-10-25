'use strict';

// Unmounted server composition only. readCustomer must be the real configured
// current-customer reader, not a body/flag/source-tag parser. Classification is
// a prerequisite fact, never QA entitlement, quota, Founder status or access.
const { isProxy } = require('node:util').types;
const { fields, copy, freeze, uuid, subject, instant, revision, equal, hash } = require('../appLifecycle/dashboardRuntimeRecords');
const { authority } = require('./customerAuthority');
const { starterAccountRecord, starterAccountKey } = require('./starterAccountAllocation');

class AccountPurposeError extends Error {
    constructor() {
        super('Account-purpose facts are unavailable.');
        this.name = 'AccountPurposeError';
        this.code = 'account_purpose_unavailable';
        this.statusCode = 503;
    }
}
const fail = () => { throw new AccountPurposeError(); };
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function data(object, key) {
    if (!object || typeof object !== 'object' || isProxy(object)) fail();
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !descriptor.enumerable || !own(descriptor, 'value')) fail();
    return descriptor.value;
}
function method(object, name) {
    if (!object || typeof object !== 'object' || isProxy(object)) fail();
    let current = object;
    while (current !== null) {
        if (isProxy(current)) fail();
        const descriptor = Object.getOwnPropertyDescriptor(current, name);
        if (descriptor) {
            if (!own(descriptor, 'value') || typeof descriptor.value !== 'function' || isProxy(descriptor.value)) fail();
            return descriptor.value.bind(object);
        }
        current = Object.getPrototypeOf(current);
    }
    fail();
}

// Proposed versioned enrollment read contract, not an existing provider schema.
// Its trusted producer must assign the stable UUID explicitly. No assignment
// method, actual account list or durable purpose store is included here.
function purposeSnapshot(raw, accountId) {
    if (raw === null) return { fact: { kind: 'unknown', reason: 'unassigned', revision: null }, fingerprint: hash(null) };
    const value = fields(copy(raw, 16384), ['schemaVersion', 'accountId', 'revision', 'assignments']);
    uuid(value.accountId); revision(value.revision);
    if (value.schemaVersion !== 1 || value.accountId !== accountId || !Array.isArray(value.assignments)) fail();
    const purposes = new Set();
    for (const assignment of value.assignments) {
        fields(assignment, ['accountId', 'purpose']); uuid(assignment.accountId);
        if (assignment.accountId !== accountId || !['genuine_customer', 'verified_test', 'unknown'].includes(assignment.purpose)) fail();
        purposes.add(assignment.purpose);
    }
    const kind = purposes.size === 1 ? [...purposes][0] : 'unknown';
    const reason = purposes.size > 1 ? 'conflicting_assignments' : kind === 'unknown' ? 'unassigned' : 'explicit_assignment';
    return { fact: { kind, reason, revision: value.revision }, fingerprint: hash(value) };
}

/**
 * Reuses readCustomer(cookieHeader), accountStore.load and optionally the current
 * database.withTenantTransaction. It accepts no request account ID or purpose.
 * database must be the existing configured nofries_runtime transaction wrapper,
 * not a new owner connection; this module grants or changes no database role.
 * Unknown purpose does not deny ordinary signup; this module is not its gate.
 * The existing current-customer reader can reject expired Blob authority even
 * with fresh SSO, and may retain its existing invalid-session cleanup behavior.
 */
function createAccountPurposeReader(options) {
    let readCustomer, loadAccount, readPurposeAssignments, transaction = null, now;
    try {
        if (!options || typeof options !== 'object' || isProxy(options)) fail();
        const optional = ['readPurposeAssignments', 'database', 'now'].filter(key => own(options, key));
        fields(options, ['readCustomer', 'accountStore', ...optional]);
        readCustomer = options.readCustomer;
        readPurposeAssignments = own(options, 'readPurposeAssignments') ? options.readPurposeAssignments : async () => null;
        now = own(options, 'now') ? options.now : Date.now;
        if ([readCustomer, readPurposeAssignments, now].some(fn => typeof fn !== 'function' || isProxy(fn))) fail();
        loadAccount = method(options.accountStore, 'load');
        if (own(options, 'database')) transaction = method(options.database, 'withTenantTransaction');
    } catch (_) { throw new TypeError('Trusted current-customer and account-store read ports are required'); }

    function time() {
        const at = now();
        if (!Number.isSafeInteger(at) || at < 0 || at > 8_640_000_000_000_000) fail();
        return at;
    }
    function fresh(customer, sample) {
        const at = sample();
        if (Date.parse(customer.expiresAt) <= at || customer.current.expiresAt <= at) fail();
    }
    async function capture(cookieHeader, sample) {
        sample();
        const raw = await readCustomer(cookieHeader);
        if (raw === null) return null;
        const details = data(raw, 'details'), identity = data(details, 'identity');
        const subjectKey = subject(data(identity, 'subjectKey'));
        if (data(identity, 'provider') !== 'entra-bff' || data(identity, 'isAuthenticated') !== true ||
            subjectKey !== uuid(data(identity, 'tenantId')) + ':' + uuid(data(identity, 'principalId'))) fail();
        const expiresAt = instant(data(details, 'expiresAt'));
        const current = authority(data(raw, 'current'), subjectKey, sample());
        if (Date.parse(expiresAt) <= sample()) fail();
        return freeze({ subjectKey, expiresAt, current });
    }
    async function accountFor(customer, sample) {
        // The verified authority's email is an existing technical locator only.
        fresh(customer, sample);
        const found = await loadAccount(starterAccountKey(customer.current.email));
        fresh(customer, sample);
        if (found === null) return null;
        const account = starterAccountRecord(data(found, 'record'));
        if (data(found, 'version') == null) fail();
        const current = customer.current, slot = account.organisations[0];
        const subjects = [account.identitySubjectKey, account.activation?.subjectKey].filter(value => value !== undefined);
        if (!subjects.length || subjects.some(value => value !== customer.subjectKey) ||
            account.email !== current.email || account.accountType !== current.accountType ||
            (account.activation && account.activation.receiptId !== slot.activationId) ||
            ['tenantId', 'organisationId', 'bindingId'].some(key => slot[key] !== current[key]) ||
            Date.parse(account.createdAt) > sample()) fail();
        return account;
    }
    async function preparationFor(customer, account, sample) {
        const result = { source: 'dashboard_starter_accounts.created_at', status: 'not_requested', createdAt: null };
        if (!transaction) return result;
        fresh(customer, sample);
        const raw = await transaction(account.organisations[0].tenantId, async tx => {
            fresh(customer, sample);
            await tx.query("SELECT set_config('nofries.subject_key', $1, true)", [customer.subjectKey]);
            fresh(customer, sample);
            return tx.query(
                'SELECT account_id, subject_key, account_type, created_at FROM nofries.dashboard_starter_accounts WHERE account_id = $1 AND subject_key = $2',
                [account.accountId, customer.subjectKey]);
        });
        fresh(customer, sample);
        const rows = data(raw, 'rows');
        if (!Array.isArray(rows) || isProxy(rows) || rows.length > 1) fail();
        if (rows.length === 0) return { ...result, status: 'not_found' };
        const row = data(rows, '0');
        fields(row, ['account_id', 'subject_key', 'account_type', 'created_at']);
        if (row.account_id !== account.accountId || row.subject_key !== customer.subjectKey || row.account_type !== account.accountType) fail();
        const rawTime = row.created_at;
        const createdAt = instant(rawTime instanceof Date && !isProxy(rawTime) ? Date.prototype.toISOString.call(rawTime) : rawTime);
        if (Date.parse(createdAt) > sample()) fail();
        return { ...result, status: 'recorded', createdAt };
    }
    return Object.freeze({
        async read(cookieHeader) {
            try {
                if (typeof cookieHeader !== 'string' || Buffer.byteLength(cookieHeader, 'utf8') > 4096) fail();
                let lastAt = -Infinity;
                const sample = () => { const at = time(); if (at < lastAt) fail(); lastAt = at; return at; };
                const customer = await capture(cookieHeader, sample);
                if (customer === null) return null;
                const account = await accountFor(customer, sample);
                if (account === null) return null;
                const preparation = await preparationFor(customer, account, sample);
                fresh(customer, sample);
                const purpose = purposeSnapshot(await readPurposeAssignments(account.accountId), account.accountId);
                fresh(customer, sample);
                const finalAccount = await accountFor(customer, sample);
                if (finalAccount === null || !equal(account, finalAccount)) fail();
                const finalPurpose = purposeSnapshot(await readPurposeAssignments(account.accountId), account.accountId);
                fresh(customer, sample);
                if (!equal(purpose, finalPurpose)) fail();
                const finalCustomer = await capture(cookieHeader, sample);
                if (finalCustomer === null || !equal(customer, finalCustomer)) fail();
                fresh(finalCustomer, sample);
                return freeze({
                    schemaVersion: 1, accountId: account.accountId, subjectKey: customer.subjectKey,
                    purpose: purpose.fact,
                    creation: {
                        reservation: { source: 'starter_account_reservation', createdAt: account.createdAt },
                        preparation,
                        canonical: { source: 'unresolved', createdAt: null },
                    },
                });
            } catch (_) { throw new AccountPurposeError(); }
        },
    });
}

module.exports = { createAccountPurposeReader, AccountPurposeError };
