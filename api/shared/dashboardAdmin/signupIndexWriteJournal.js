'use strict';

const { copy, fields, freeze, equal, hash, uuid, digest, revision } = require('../appLifecycle/dashboardRuntimeRecords');

const WRITER_HEAD_KEY = 'customer-starter/dashboard-admin-signup-index/writers/head.json';
const TICKET_PREFIX = 'customer-starter/dashboard-admin-signup-index/writers/accounts/';
const KEY = /^starter-accounts\/[a-f0-9]{64}$/;
const ETAG = /^"[^"\r\n]{1,200}"$/;
const MAX_TICKETS_PER_SCAN = 4096;

// Internal source-store protocol. This port has no authority, archive or native
// database dependency. Its mandatory writes establish invalidation BEFORE the
// original conditional account call; failures here cannot be failed open.
function createSignupIndexWriteJournal({ target, read, upload, container, newId, fail, checkpoint, reference, loadAccount }) {
    const targetKeys = Object.keys(target); let observed = null;
    const ticketKey = key => {
        if (!KEY.test(key)) fail();
        return TICKET_PREFIX + key.slice('starter-accounts/'.length) + '.json';
    };
    function head(raw) {
        const value = fields(copy(raw, 8192), ['schemaVersion', 'recordType', ...targetKeys,
            'writerEpoch', 'revision', 'generation', 'state', 'fenceId', 'checkpoint']);
        if (value.schemaVersion !== 2 || value.recordType !== 'dashboard_admin_signup_writer_head' ||
            !equal(Object.fromEntries(targetKeys.map(k => [k, value[k]])), target) ||
            !['dirty', 'rebuilding', 'idle'].includes(value.state)) fail();
        uuid(value.writerEpoch); revision(value.revision); revision(value.generation);
        if (value.state === 'rebuilding') uuid(value.fenceId); else if (value.fenceId !== null) fail();
        if (value.checkpoint !== null) {
            checkpoint(value.checkpoint);
            if (value.checkpoint.writerEpoch !== value.writerEpoch || value.checkpoint.writerGeneration > value.generation) fail();
        }
        if (value.state === 'idle' && (!value.checkpoint || value.checkpoint.writerGeneration !== value.generation)) fail();
        return freeze(value);
    }
    function ticket(raw, key, writerEpoch) {
        const value = fields(copy(raw, 8192), ['schemaVersion', 'recordType', ...targetKeys,
            'writerEpoch', 'accountKey', 'revision', 'latest', 'family']);
        if (value.schemaVersion !== 2 || value.recordType !== 'dashboard_admin_signup_write_ticket' ||
            !equal(Object.fromEntries(targetKeys.map(k => [k, value[k]])), target) ||
            value.writerEpoch !== writerEpoch || value.accountKey !== key || !KEY.test(key)) fail();
        revision(value.revision);
        if (value.latest !== null) {
            fields(value.latest, ['generation', 'reference']); revision(value.latest.generation);
            reference(value.latest.reference);
            if (value.latest.reference.accountKey !== key) fail();
        }
        if (value.family !== null) {
            const f = fields(value.family, ['familyId', 'kind', 'expectedVersion', 'initialCandidateSha256', 'phase', 'generation']);
            uuid(f.familyId); digest(f.initialCandidateSha256);
            if (!['create', 'replace'].includes(f.kind) || !['prepared', 'issued'].includes(f.phase) ||
                (f.kind === 'create' ? f.expectedVersion !== null : !ETAG.test(f.expectedVersion))) fail();
            if (f.phase === 'prepared') { if (f.generation !== null) fail(); }
            else revision(f.generation);
        }
        return freeze(value);
    }
    async function loadHead(context, optional = false) {
        const found = await read(context, WRITER_HEAD_KEY, 8192);
        if (!found) { if (!optional || observed) fail(); return null; }
        const value = head(found.value);
        if (observed && (value.writerEpoch !== observed.writerEpoch || value.revision < observed.revision ||
            value.revision === observed.revision && !equal(value, observed))) fail();
        observed = value; return { value, etag: found.etag };
    }
    async function cas(context, key, value, previous, validate) {
        let acknowledged = false;
        try {
            await upload(context, key, value, previous ? { ifMatch: previous.etag } : { ifNoneMatch: '*' });
            acknowledged = true;
        } catch (_) { context.check(); }
        // An ambiguous CAS must be reconciled to these exact immutable bytes.
        // Never infer success from existence or launch a source call on timeout.
        const found = await read(context, key, 8192);
        if (!found || !equal(validate(found.value), value)) fail();
        context.check();
        return { value, etag: found.etag, acknowledged };
    }
    async function changeHead(context, before, changes) {
        const value = head({ ...before.value, ...changes, revision: before.value.revision + 1 });
        return cas(context, WRITER_HEAD_KEY, value, before, head);
    }
    async function loadTicket(context, key, writerEpoch) {
        const found = await read(context, ticketKey(key), 8192);
        return found ? { value: ticket(found.value, key, writerEpoch), etag: found.etag } : null;
    }
    async function changeTicket(context, before, value) {
        const next = ticket({ ...value, revision: (before?.value.revision ?? -1) + 1 }, value.accountKey, value.writerEpoch);
        return cas(context, ticketKey(next.accountKey), next, before, raw => ticket(raw, next.accountKey, next.writerEpoch));
    }
    async function close(context, before) {
        const f = before.value.family;
        if (!f || f.phase !== 'issued') return before;
        const loaded = await loadAccount(context, before.value.accountKey);
        if (!loaded || f.kind === 'replace' && loaded.version === f.expectedVersion) return null;
        // Closure covers EVERY call in this exact conditional family, including
        // calls whose candidates differ. Only actual source facts are retained.
        const ref = loaded.reference;
        return changeTicket(context, before, { ...before.value, family: null,
            latest: { generation: f.generation, reference: ref } });
    }
    async function register(context, kind, key, expectedVersion, candidateSha256) {
        const first = await loadHead(context), writerEpoch = first.value.writerEpoch;
        let current = await loadTicket(context, key, writerEpoch);
        if (current?.value.family?.phase === 'issued') {
            const closed = await close(context, current);
            if (closed) current = closed;
            else if (current.value.family.kind !== kind || current.value.family.expectedVersion !== expectedVersion) fail();
        }
        if (current?.value.family?.phase !== 'issued') {
            current = await changeTicket(context, current, {
                schemaVersion: 2, recordType: 'dashboard_admin_signup_write_ticket', ...target,
                writerEpoch, accountKey: key, revision: 0, latest: current?.value.latest ?? null,
                family: { familyId: uuid(newId()), kind, expectedVersion, initialCandidateSha256: candidateSha256,
                    phase: 'prepared', generation: null }
            });
        }
        // Even an already issued same-predicate retry must invalidate a newer
        // checkpoint. It never downgrades the older in-flight family to prepared.
        let advanced;
        for (let attempt = 0; attempt < 8; attempt++) {
            const before = await loadHead(context);
            if (before.value.writerEpoch !== writerEpoch) fail();
            try {
                advanced = await changeHead(context, before, { generation: before.value.generation + 1,
                    state: 'dirty', fenceId: null }); break;
            } catch (_) { context.check(); }
        }
        if (!advanced) fail();
        const issued = await changeTicket(context, current, { ...current.value,
            family: { ...current.value.family, phase: 'issued', generation: advanced.value.generation } });
        return freeze({ accountKey: key, writerEpoch, familyId: issued.value.family.familyId });
    }
    async function settle(context, receipt) {
        const current = await loadTicket(context, receipt.accountKey, receipt.writerEpoch);
        if (!current || current.value.family?.familyId !== receipt.familyId || current.value.family.phase !== 'issued') return false;
        return Boolean(await close(context, current));
    }
    async function initialise(context) {
        const found = await loadHead(context, true); if (found) return found;
        const value = head({ schemaVersion: 2, recordType: 'dashboard_admin_signup_writer_head', ...target,
            writerEpoch: uuid(newId()), revision: 0, generation: 0, state: 'dirty', fenceId: null, checkpoint: null });
        return cas(context, WRITER_HEAD_KEY, value, null, head);
    }
    async function pin(context, expected = null) {
        const before = await loadHead(context);
        if (expected && (before.value.state !== 'rebuilding' || expected.headSha256 !== hash(before.value) ||
            expected.operationId !== before.value.fenceId)) fail();
        return changeHead(context, before, { state: 'rebuilding', fenceId: uuid(newId()) });
    }
    async function stable(context, pinned) {
        const found = await read(context, WRITER_HEAD_KEY, 8192, pinned.etag);
        if (!found || !equal(head(found.value), pinned.value)) fail();
    }
    async function scan(context, pinned) {
        const refs = [], seen = new Set();
        const iterable = container.listBlobsFlat({ prefix: TICKET_PREFIX, abortSignal: context.signal });
        for await (const item of iterable) {
            context.check();
            if (!item || typeof item.name !== 'string' || !item.name.startsWith(TICKET_PREFIX) ||
                !/^[a-f0-9]{64}\.json$/.test(item.name.slice(TICKET_PREFIX.length)) || seen.has(item.name) ||
                seen.size >= MAX_TICKETS_PER_SCAN) fail();
            seen.add(item.name);
            const key = 'starter-accounts/' + item.name.slice(TICKET_PREFIX.length, -5);
            let current = await loadTicket(context, key, pinned.value.writerEpoch); if (!current) fail();
            if (current.value.family?.phase === 'prepared') {
                // Registration preceded generation invalidation. The exact CAS
                // cancellation prevents any delayed issuer using that ticket.
                current = await changeTicket(context, current, { ...current.value, family: null });
            } else if (current.value.family?.phase === 'issued') {
                current = await close(context, current); if (!current) fail();
            }
            if (current.value.latest) {
                if (current.value.latest.generation > pinned.value.generation) fail();
                refs.push(current.value.latest);
            }
        }
        await stable(context, pinned); return refs;
    }
    async function publish(context, pinned, nextCheckpoint) {
        checkpoint(nextCheckpoint);
        if (nextCheckpoint.writerEpoch !== pinned.value.writerEpoch || nextCheckpoint.writerGeneration !== pinned.value.generation) fail();
        return changeHead(context, pinned, { state: 'idle', fenceId: null, checkpoint: nextCheckpoint });
    }
    return Object.freeze({ loadHead, initialise, register, settle, pin, stable, scan, publish, ticketKey });
}

module.exports = { createSignupIndexWriteJournal, WRITER_HEAD_KEY, TICKET_PREFIX, MAX_TICKETS_PER_SCAN };
