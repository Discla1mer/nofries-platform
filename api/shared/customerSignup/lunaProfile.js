'use strict';

const { createLunaAccountFactsReader } = require('./lunaAccountFacts');
const { copy, fields, freeze, uuid, revision, instant } = require('../appLifecycle/dashboardRuntimeRecords');
const MAX_BYTES = 4096;
const ETAG = /^"[^"\r\n]{1,200}"$/;

class LunaProfileError extends Error {
    constructor(code = 'luna_profile_unavailable', statusCode = 503) {
        super('Luna profile request could not be completed.');
        this.name = 'LunaProfileError'; this.code = code; this.statusCode = statusCode;
    }
}
const fail = (code, status) => { throw new LunaProfileError(code, status); };
function nickname(value) {
    if (typeof value !== 'string') throw new Error('Invalid nickname');
    const result = value.normalize('NFC').trim();
    if (!result || [...result].length > 40 || /[\p{Cc}\p{Cf}\u2028\u2029<>]/u.test(result)) throw new Error('Invalid nickname');
    return result;
}
function lunaProfileRecord(input) {
    try {
        const value = copy(input, MAX_BYTES);
        fields(value, ['schemaVersion', 'accountId', 'revision', 'nickname', 'profileCreatedAt', 'updatedAt', 'lastMutation']);
        if (value.schemaVersion !== 1 || revision(value.revision) < 1 || nickname(value.nickname) !== value.nickname) throw new Error();
        uuid(value.accountId); instant(value.profileCreatedAt); instant(value.updatedAt);
        fields(value.lastMutation, ['operationId', 'expectedRevision']); uuid(value.lastMutation.operationId);
        if (revision(value.lastMutation.expectedRevision) + 1 !== value.revision ||
            value.profileCreatedAt > value.updatedAt || value.revision === 1 && value.profileCreatedAt !== value.updatedAt) throw new Error();
        return freeze(value);
    } catch (_) { fail(); }
}
function command(input) {
    try {
        const value = copy(input, MAX_BYTES);
        fields(value, ['nickname', 'expectedRevision', 'operationId']);
        value.nickname = nickname(value.nickname); revision(value.expectedRevision); uuid(value.operationId);
        if (!Number.isSafeInteger(value.expectedRevision + 1)) throw new Error();
        return freeze(value);
    } catch (_) { fail('luna_profile_input_invalid', 400); }
}
function publicProfile(record) {
    if (!record) return null;
    const { accountId, revision: version, nickname: name, profileCreatedAt, updatedAt } = record;
    return freeze({ accountId, revision: version, nickname: name, profileCreatedAt, updatedAt });
}
function sameMutation(record, request) {
    return record.lastMutation.operationId === request.operationId &&
        record.lastMutation.expectedRevision === request.expectedRevision && record.nickname === request.nickname;
}

// Source-only composition. No route, browser token, account creation, score or
// Founder authority is provided. The injected store is a trusted server port.
function createLunaProfileService({ accountReaderOptions, store, now = Date.now, ...extra } = {}) {
    if (Object.keys(extra).length || !store || ['load', 'create', 'replace'].some(key => typeof store[key] !== 'function') ||
        typeof now !== 'function') throw new TypeError('Invalid Luna profile configuration');
    const reader = createLunaAccountFactsReader(accountReaderOptions);
    function clock() {
        let previous = -Infinity;
        return () => {
            const value = now();
            if (!Number.isSafeInteger(value) || value < previous) fail();
            let timestamp; try { timestamp = instant(new Date(value).toISOString()); } catch (_) { fail(); }
            previous = value; return timestamp;
        };
    }
    async function owner(header, expected, tick) {
        tick();
        let facts;
        try { facts = await reader.read(header); } catch (_) { fail(); }
        tick();
        if (!facts) fail('luna_profile_unauthenticated', 401);
        if (expected && facts.accountId !== expected) fail();
        return facts.accountId;
    }
    async function load(accountId, tick) {
        let result;
        try {
            result = await store.load(accountId);
            if (result === null) { tick(); return null; }
            fields(result, ['record', 'version']);
            if (typeof result.version !== 'string' || !ETAG.test(result.version)) throw new Error();
            const record = lunaProfileRecord(result.record);
            if (record.accountId !== accountId || record.updatedAt > tick()) throw new Error();
            return { record, version: result.version };
        } catch (_) { fail(); }
    }
    async function read(header) {
        const tick = clock(), accountId = await owner(header, null, tick);
        const current = await load(accountId, tick);
        await owner(header, accountId, tick);
        return publicProfile(current?.record);
    }
    async function save(header, input) {
        const request = command(input), tick = clock(), accountId = await owner(header, null, tick);
        const current = await load(accountId, tick), before = current?.record;
        await owner(header, accountId, tick);
        if (before?.lastMutation.operationId === request.operationId) {
            if (!sameMutation(before, request)) fail('luna_profile_conflict', 409);
            return publicProfile(before);
        }
        if ((before?.revision || 0) !== request.expectedRevision) fail('luna_profile_conflict', 409);
        const updatedAt = tick(), next = lunaProfileRecord({ schemaVersion: 1, accountId,
            revision: request.expectedRevision + 1, nickname: request.nickname,
            profileCreatedAt: before?.profileCreatedAt || updatedAt, updatedAt,
            lastMutation: { operationId: request.operationId, expectedRevision: request.expectedRevision } });
        let written;
        try {
            const beforeWrite = () => owner(header, accountId, tick);
            written = current ? await store.replace(accountId, current.version, next, beforeWrite) :
                await store.create(accountId, next, beforeWrite);
        } catch (_) { written = null; }
        if (written !== true) {
            // Reconcile a lost acknowledgement once. Never reapply on a newer
            // version or turn a failed write into an unconditional replacement.
            const observed = await load(accountId, tick);
            await owner(header, accountId, tick);
            // Concurrent retries can generate different timestamps for the same
            // command. Acknowledge the stored mutation, returning its actual
            // timestamps rather than this attempt's uncommitted candidate.
            if (observed && sameMutation(observed.record, request)) return publicProfile(observed.record);
            if (written === false) fail('luna_profile_conflict', 409);
            fail();
        }
        await owner(header, accountId, tick);
        return publicProfile(next);
    }
    return Object.freeze({ read, save });
}

module.exports = { LunaProfileError, lunaProfileRecord, createLunaProfileService, MAX_BYTES };
