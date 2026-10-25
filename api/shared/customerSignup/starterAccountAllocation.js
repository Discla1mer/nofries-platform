'use strict';

// Durable reservation, separate from identity provisioning and membership. A
// reservation grants no access and is never deleted/refunded after uncertainty.
const crypto = require('node:crypto');
const { fields, copy, freeze, uuid, subject, instant, hash } = require('../appLifecycle/dashboardRuntimeRecords');
const { starterSetupSnapshot: verifiedSnapshot } = require('./managedSignupProof');
const { workEmail } = require('../organisationSetup');
const { approvedStarterPlan, accountWindow, LEGACY_PLAN_ID } = require('./customerStarterPlan');
const ACCOUNT_FIELDS = ['schemaVersion', 'accountId', 'planId', 'planSha256', 'email', 'accountType',
    'setupRequestId', 'setupSha256', 'createdAt', 'activation', 'organisations'];
const SLOT_FIELDS = ['requestId', 'kind', 'organisationName', 'tenantId', 'organisationId', 'grantId',
    'scheduleId', 'activationId', 'bootstrapOperationId', 'acceptOperationId', 'publicationOperationId', 'bindingId',
    'authorityId', 'membershipId', 'admissionOperationId'];
const IDS = SLOT_FIELDS.filter(key => !['kind', 'organisationName'].includes(key));
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const clone = value => copy(value, 32768);
const key = email => 'starter-accounts/' + crypto.createHash('sha256').update('nofries:starter-account:v1\0' + workEmail(email)).digest('hex');
function name(value) {
    if (typeof value !== 'string') fail('starter_name_invalid');
    const result = value.trim().normalize('NFC');
    if (!result || result.length > 120 || /[\u0000-\u001f\u007f-\u009f<>]/u.test(result)) fail('starter_name_invalid');
    return result;
}
// Each new client has its own bounded immutable record; the historical account
// format remains unchanged so accepted plan hashes and recovery readers survive.
function clientRecord(accountId, input) {
    uuid(accountId);
    const value = fields(copy(input, 8192), SLOT_FIELDS);
    if (value.kind !== 'client' || name(value.organisationName) !== value.organisationName) fail('starter_record_invalid');
    const used = new Set([accountId]);
    for (const field of IDS) { uuid(value[field]); if (used.has(value[field])) fail('starter_record_invalid'); used.add(value[field]); }
    return freeze(value);
}
function encodeCursor(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decodeCursor(value) {
    if (typeof value !== 'string' || !value.length || value.length > 16384 || !/^[A-Za-z0-9_-]+$/.test(value)) fail('starter_cursor_invalid');
    try {
        const bytes = Buffer.from(value, 'base64url');
        if (bytes.toString('base64url') !== value) fail('starter_cursor_invalid');
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch { fail('starter_cursor_invalid'); }
}
function record(input) {
    const value = fields(clone(input), [...ACCOUNT_FIELDS, ...(Object.hasOwn(input, 'identitySubjectKey') ? ['identitySubjectKey'] : [])]);
    const plan = approvedStarterPlan(value.planId);
    if (Object.hasOwn(value, 'identitySubjectKey')) subject(value.identitySubjectKey);
    uuid(value.accountId); uuid(value.setupRequestId); instant(value.createdAt);
    if (value.schemaVersion !== 1 || value.planId !== plan.planId || value.planSha256 !== plan.sha256 ||
        value.email !== workEmail(value.email) || !['company', 'consultant'].includes(value.accountType) ||
        !/^[a-f0-9]{64}$/.test(value.setupSha256) || !Array.isArray(value.organisations)) fail('starter_record_invalid');
    if (!value.organisations.length || value.organisations.length > 1 + (value.accountType === 'consultant' ? plan.consultantClientOrganisations : 0)) fail('starter_record_invalid');
    const used = new Set([value.accountId]);
    for (const [index, raw] of value.organisations.entries()) {
        const slot = fields(raw, SLOT_FIELDS);
        if (slot.kind !== (index === 0 ? 'own' : 'client') || name(slot.organisationName) !== slot.organisationName ||
            index === 0 && slot.requestId !== value.setupRequestId) fail('starter_record_invalid');
        for (const field of IDS) { uuid(slot[field]); if (used.has(slot[field])) fail('starter_record_invalid'); used.add(slot[field]); }
    }
    if (value.activation !== null) {
        const activation = fields(value.activation, ['subjectKey', 'receiptId', 'activatedAt', 'validUntil']);
        subject(activation.subjectKey); uuid(activation.receiptId); instant(activation.activatedAt);
        if (activation.activatedAt < value.createdAt || activation.validUntil !== accountWindow(activation.activatedAt, plan.planId).validUntil) fail('starter_record_invalid');
    } else if (value.organisations.length !== 1) fail('starter_record_invalid');
    return freeze(value);
}
function createStarterAccountAllocator({ store, readActivation, captureOwner, now = Date.now, newId = crypto.randomUUID, planId = LEGACY_PLAN_ID }) {
    if (!store || !['load', 'create', 'replace'].every(method => typeof store[method] === 'function') ||
        typeof readActivation !== 'function' || typeof captureOwner !== 'function') fail('starter_configuration_invalid');
    const plan = approvedStarterPlan(planId);
    const time = () => { const at = now(); if (!Number.isSafeInteger(at) || at < Date.parse(approvedStarterPlan().approvedAt)) fail('starter_clock_invalid'); return at; };
    function slot(requestId, kind, organisationName) {
        return Object.fromEntries(SLOT_FIELDS.map(field => [field, field === 'requestId' ? requestId : field === 'kind' ? kind :
            field === 'organisationName' ? organisationName : uuid(newId())]));
    }
    async function load(email) {
        const found = await store.load(key(email));
        if (!found) return null;
        const checked = record(found.record);
        if (checked.email !== email || found.version === undefined || found.version === null) fail('starter_record_invalid');
        return { version: found.version, record: checked };
    }
    async function owner(request) {
        // The composition root supplies a fresh authenticated/MFA/authority read.
        const captured = fields(clone(await captureOwner(request)), ['subjectKey', 'email']);
        subject(captured.subjectKey);
        if (captured.email !== workEmail(captured.email)) fail('starter_owner_invalid');
        return captured;
    }
    async function activationFact(request) {
        const fact = fields(clone(await readActivation(request)), ['email', 'subjectKey', 'accountId',
            'organisationId', 'receiptId', 'activatedAt']);
        if (fact.email !== workEmail(fact.email)) fail('starter_activation_invalid');
        subject(fact.subjectKey); uuid(fact.accountId); uuid(fact.organisationId); uuid(fact.receiptId); instant(fact.activatedAt);
        if (Date.parse(fact.activatedAt) > time()) fail('starter_activation_invalid');
        return fact;
    }
    function current(value, actor) {
        if (value.accountType !== 'consultant' || !value.activation || value.activation.subjectKey !== actor.subjectKey ||
            value.email !== actor.email || time() < Date.parse(value.activation.activatedAt) ||
            time() >= Date.parse(value.activation.validUntil)) fail('starter_client_setup_denied');
    }
    async function currentAccount(request, actor, expected) {
        const loaded = await load(actor.email); if (!loaded) fail('starter_account_missing');
        current(loaded.record, actor);
        if (expected && hash(loaded.record) !== hash(expected)) fail('starter_owner_changed');
        if (hash(await owner(request)) !== hash(actor)) fail('starter_owner_changed');
        current(loaded.record, actor);
        return loaded.record;
    }
    async function client(account, requestId) {
        const legacy = account.organisations.find(item => item.requestId === requestId);
        if (legacy) { if (legacy.kind !== 'client') fail('starter_request_changed'); return legacy; }
        if (typeof store.loadClient !== 'function') fail('starter_configuration_invalid');
        const found = await store.loadClient(account.accountId, requestId);
        if (found === null) return null;
        const checked = clientRecord(account.accountId, found);
        if (checked.requestId !== requestId) fail('starter_record_invalid');
        return checked;
    }
    function initialProof(proofInput) {
        const proof = verifiedSnapshot(proofInput, proofInput?.requestId), at = time();
        if (!Object.hasOwn(proof, 'accountType') || proof.verifiedAt > at || proof.expiresAt <= at) fail('starter_proof_invalid');
        return proof;
    }
    function matchInitial(proof, value) {
        if (value.identitySubjectKey !== proof.subjectKey) fail('starter_account_exists');
        if (value.setupRequestId === proof.requestId) {
            if (value.setupSha256 !== hash(proof)) fail('starter_request_changed');
        } else if (value.accountType !== proof.accountType || value.organisations[0].organisationName !== proof.organisationName) {
            fail('starter_account_exists');
        }
        if (value.email !== proof.email || proof.expiresAt <= time()) fail('starter_proof_invalid');
        return value;
    }
    return Object.freeze({
        async readInitial(proofInput) {
            const proof = initialProof(proofInput), stored = await load(proof.email);
            if (proof.expiresAt <= time()) fail('starter_proof_invalid');
            return stored ? matchInitial(proof, stored.record) : null;
        },
        async reserveInitial(proofInput) {
            const proof = initialProof(proofInput), at = time();
            const stored = await load(proof.email);
            function same(value) {
                // A new, still-live mailbox proof may resume this same account.
                // Keep the original scope/operation IDs and activation window;
                // the caller still authenticates its real immutable subject.
                return matchInitial(proof, value);
            }
            if (stored) return same(stored.record);
            if (at < Date.parse(plan.approvedAt)) fail('starter_clock_invalid');
            if (proof.expiresAt <= time()) fail('starter_proof_invalid');
            const candidate = record({ schemaVersion: 1, accountId: uuid(newId()), planId: plan.planId, planSha256: plan.sha256,
                email: proof.email, accountType: proof.accountType, setupRequestId: proof.requestId, setupSha256: hash(proof),
                ...(proof.subjectKey ? { identitySubjectKey: proof.subjectKey } : {}),
                createdAt: new Date(at).toISOString(), activation: null,
                organisations: [slot(proof.requestId, 'own', proof.organisationName)] });
            try { await store.create(key(proof.email), candidate); }
            catch (error) { const observed = await load(proof.email); if (!observed) throw error; return same(observed.record); }
            const observed = await load(proof.email); if (!observed) fail('starter_reconciliation_required');
            return same(observed.record);
        },
        async activate(request) {
            // This port must reconcile the genuine canonical acceptance/binding;
            // it accepts no browser acceptance boolean or caller-selected clock.
            const fact = await activationFact(request);
            for (let attempt = 0; attempt < 8; attempt++) {
                const loaded = await load(fact.email); if (!loaded) fail('starter_account_missing');
                const value = loaded.record;
                const activation = { subjectKey: fact.subjectKey, receiptId: fact.receiptId, activatedAt: fact.activatedAt,
                    validUntil: accountWindow(fact.activatedAt, value.planId).validUntil };
                if (value.accountId !== fact.accountId || value.organisations[0].organisationId !== fact.organisationId) fail('starter_activation_invalid');
                if (value.activation) { if (hash(value.activation) !== hash(activation)) fail('starter_activation_changed'); return value; }
                if (hash(await activationFact(request)) !== hash(fact)) fail('starter_activation_changed');
                const next = record({ ...value, activation });
                try { if (!await store.replace(key(fact.email), loaded.version, next)) continue; }
                catch (error) { const observed = await load(fact.email); if (observed?.record.activation && hash(observed.record.activation) === hash(activation)) return observed.record; throw error; }
                const observed = await load(fact.email);
                if (!observed?.record.activation || hash(observed.record.activation) !== hash(activation)) fail('starter_reconciliation_required');
                return observed.record;
            }
            fail('starter_changed');
        },
        async readClient(request, requestId) {
            uuid(requestId);
            const actor = await owner(request), account = await currentAccount(request, actor);
            const found = await client(account, requestId);
            await currentAccount(request, actor, account);
            return found;
        },
        async listClients(request, input = {}) {
            const command = fields(clone(input), [...(Object.hasOwn(input, 'cursor') ? ['cursor'] : []), ...(Object.hasOwn(input, 'limit') ? ['limit'] : [])]);
            const limit = command.limit === undefined ? 50 : command.limit;
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail('starter_cursor_invalid');
            const actor = await owner(request), account = await currentAccount(request, actor);
            const accountSha256 = hash(account), legacy = account.organisations.slice(1);
            let legacyOffset = 0, sidecarCursor = null;
            if (command.cursor !== undefined && command.cursor !== null) {
                const cursor = fields(decodeCursor(command.cursor), ['schemaVersion', 'accountId', 'accountSha256', 'legacyOffset', 'sidecarCursor']);
                if (cursor.schemaVersion !== 1 || cursor.accountId !== account.accountId || cursor.accountSha256 !== accountSha256 ||
                    !Number.isSafeInteger(cursor.legacyOffset) || cursor.legacyOffset < 0 || cursor.legacyOffset > legacy.length ||
                    cursor.sidecarCursor !== null && typeof cursor.sidecarCursor !== 'string') fail('starter_cursor_invalid');
                legacyOffset = cursor.legacyOffset; sidecarCursor = cursor.sidecarCursor;
                if (legacyOffset < legacy.length && sidecarCursor !== null) fail('starter_cursor_invalid');
            }
            const clients = legacy.slice(legacyOffset, legacyOffset + limit);
            legacyOffset += clients.length;
            let nextCursor = null;
            if (legacyOffset === legacy.length && clients.length < limit) {
                if (typeof store.listClients !== 'function') fail('starter_configuration_invalid');
                const page = fields(copy(await store.listClients(account.accountId, { cursor: sidecarCursor, limit: limit - clients.length }), 131072), ['clients', 'nextCursor']);
                if (!Array.isArray(page.clients) || page.clients.length > limit - clients.length ||
                    page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor.length > 8192)) fail('starter_record_invalid');
                const seen = new Set(account.organisations.map(slot => slot.requestId));
                for (const raw of page.clients) {
                    const saved = clientRecord(account.accountId, raw);
                    if (seen.has(saved.requestId)) fail('starter_record_invalid');
                    seen.add(saved.requestId); clients.push(saved);
                }
                sidecarCursor = page.nextCursor;
                if (sidecarCursor !== null) nextCursor = encodeCursor({ schemaVersion: 1, accountId: account.accountId, accountSha256, legacyOffset, sidecarCursor });
            } else {
                // The next request checks the sidecar page even when legacy rows
                // exactly fill this page. No full-directory prefetch is needed.
                nextCursor = encodeCursor({ schemaVersion: 1, accountId: account.accountId, accountSha256, legacyOffset, sidecarCursor });
            }
            await currentAccount(request, actor, account);
            return freeze({ clients, nextCursor });
        },
        async reserveClient(request, input) {
            const command = fields(clone(input), ['requestId', 'organisationName']); uuid(command.requestId);
            command.organisationName = name(command.organisationName);
            const actor = await owner(request);
            for (let attempt = 0; attempt < 8; attempt++) {
                const loaded = await load(actor.email); if (!loaded) fail('starter_account_missing');
                current(loaded.record, actor);
                const original = loaded.record.organisations.find(item => item.requestId === command.requestId);
                if (original) {
                    if (original.kind !== 'client' || original.organisationName !== command.organisationName) fail('starter_request_changed');
                    if (hash(await owner(request)) !== hash(actor)) fail('starter_owner_changed');
                    current(loaded.record, actor); return original;
                }
                if (loaded.record.organisations.length - 1 >= approvedStarterPlan(loaded.record.planId).consultantClientOrganisations) fail('starter_client_limit');
                const next = record({ ...loaded.record, organisations: [...loaded.record.organisations,
                    slot(command.requestId, 'client', command.organisationName)] });
                if (hash(await owner(request)) !== hash(actor)) fail('starter_owner_changed'); current(loaded.record, actor);
                try { if (!await store.replace(key(actor.email), loaded.version, next)) continue; }
                catch (error) {
                    const observed = await load(actor.email);
                    if (!observed?.record.organisations.some(item => item.requestId === command.requestId)) throw error;
                    // A committed but unacknowledged reservation is reconciled below;
                    // never refund it or perform its external provisioning here.
                }
                const observed = await load(actor.email); if (!observed) fail('starter_reconciliation_required');
                current(observed.record, actor);
                if (hash(await owner(request)) !== hash(actor)) fail('starter_owner_changed');
                current(observed.record, actor);
                const saved = observed.record.organisations.find(item => item.requestId === command.requestId);
                if (!saved || saved.kind !== 'client' || saved.organisationName !== command.organisationName) fail('starter_reconciliation_required');
                return saved;
            }
            fail('starter_changed');
        }
    });
}
module.exports = { createStarterAccountAllocator, starterAccountRecord: record, starterClientRecord: clientRecord,
    starterAccountKey: key, STARTER_SLOT_FIELDS: Object.freeze(SLOT_FIELDS) };
