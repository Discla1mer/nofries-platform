'use strict';

const { performance } = require('node:perf_hooks');
const { TextDecoder, types: { isProxy } } = require('node:util');
const { copy, fields, freeze, equal, canonical, hash, id, uuid, digest, revision, instant } =
    require('../appLifecycle/dashboardRuntimeRecords');
const { starterAccountRecord, starterAccountKey } = require('../customerSignup/starterAccountAllocation');
const { normaliseSignupManifest } = require('./signupAuthority');
const { createSignupIndexWriteJournal, WRITER_HEAD_KEY, TICKET_PREFIX } = require('./signupIndexWriteJournal');

const WRITER_CONTRACT = 'all_application_account_writes_v2';
// The index is a projection. Every source writer must use the separate v2
// journal; old/alternate writers must be excluded before explicit initialization.
// Legacy heads and unresolved families are never silently migrated or reset.
const INDEX_HEAD_KEY = 'customer-starter/dashboard-admin-signup-index/head.json';
const ARCHIVE_PREFIX = 'customer-starter/dashboard-admin-signup-index/revisions/';
const SOURCE_PREFIX = 'customer-starter/starter-accounts/';
const MAX_RECORD_BYTES = 262144, MAX_ROWS = 100;
const TARGET_KEYS = ['provider', 'populationId', 'indexId', 'instanceId', 'sourceBindingSha256', 'writerContract'];
const KEY = /^starter-accounts\/[a-f0-9]{64}$/;
const ETAG = /^"[^"\r\n]{1,200}"$/;
const fail = () => { const e = new Error('dashboard_admin_signup_index_unavailable'); e.code = e.message; throw e; };
const fn = value => typeof value === 'function' && !isProxy(value);

function referenceFor(provider, key, raw) {
    const account = starterAccountRecord(raw), slot = account.organisations[0];
    if (!KEY.test(key) || starterAccountKey(account.email) !== key) fail();
    const subjectKey = account.identitySubjectKey ?? account.activation?.subjectKey ?? null;
    if (account.activation && (account.activation.subjectKey !== subjectKey || account.activation.receiptId !== slot.activationId)) fail();
    return freeze({ accountKey: key, entry: { recordId: 'signup-account:' + account.accountId, binding: {
        provider, tenantId: slot.tenantId, organisationId: slot.organisationId,
        accountId: account.accountId, setupRequestId: account.setupRequestId,
        subjectKey
    } } });
}

function createSignupIndexMaintenance(input) {
    let config, target;
    try {
        fields(input, ['container', 'accountStore', 'provider', 'populationId', 'indexId', 'instanceId',
            'sourceBindingSha256', 'writerContract', 'readExternalRuntimeEpoch', 'clock', 'newId',
            ...(Object.hasOwn(input, 'requestBudgetMs') ? ['requestBudgetMs'] : [])]);
        config = { ...input, requestBudgetMs: Object.hasOwn(input, 'requestBudgetMs') ? input.requestBudgetMs : 60000 };
        target = freeze(Object.fromEntries(TARGET_KEYS.map(key => [key, input[key]])));
        if (!['legacy', 'external'].includes(target.provider) || target.writerContract !== WRITER_CONTRACT) fail();
        id(target.populationId); id(target.indexId); uuid(target.instanceId); digest(target.sourceBindingSha256);
        if (!config.container || isProxy(config.container) || !fn(config.container.getBlockBlobClient) ||
            !config.accountStore || isProxy(config.accountStore) ||
            !['load', 'create', 'replace'].every(key => fn(config.accountStore[key])) ||
            !['readExternalRuntimeEpoch', 'clock', 'newId'].every(key => fn(config[key])) ||
            !Number.isSafeInteger(config.requestBudgetMs) || config.requestBudgetMs < 1 || config.requestBudgetMs > 60000) fail();
    } catch (_) { fail(); }
    let lastTime = null, observed = null;
    function now() {
        const at = instant(config.clock());
        if (lastTime !== null && at < lastTime) fail();
        lastTime = at; return at;
    }
    function manifest(references) {
        return normaliseSignupManifest({ schemaVersion: 2, provider: target.provider,
            populationId: target.populationId, indexId: target.indexId, entries: references.map(r => r.entry) });
    }
    function references(input) {
        const refs = copy(input, MAX_RECORD_BYTES);
        if (!Array.isArray(refs) || refs.length > MAX_ROWS) fail();
        const keys = new Set(); let previous = null;
        for (const ref of refs) {
            fields(ref, ['entry', 'accountKey']);
            if (!KEY.test(ref.accountKey) || keys.has(ref.accountKey) ||
                previous !== null && previous >= ref.accountKey || ref.entry.recordId !== 'signup-account:' + ref.entry.binding.accountId) fail();
            previous = ref.accountKey; keys.add(ref.accountKey);
        }
        manifest(refs); return refs;
    }
    function head(input) {
        const value = fields(copy(input, 4096), ['schemaVersion', 'recordType', ...TARGET_KEYS,
            'restoreEpoch', 'writerEpoch', 'writerGeneration', 'revision', 'state', 'recordSha256']);
        if (value.schemaVersion !== 2 || value.recordType !== 'dashboard_admin_signup_index_head' ||
            !equal(Object.fromEntries(TARGET_KEYS.map(k => [k, value[k]])), target) ||
            !['incomplete', 'complete', 'overflow'].includes(value.state)) fail();
        uuid(value.restoreEpoch); uuid(value.writerEpoch); revision(value.writerGeneration);
        revision(value.revision); digest(value.recordSha256); return freeze(value);
    }
    function record(input, currentHead) {
        const value = fields(copy(input, MAX_RECORD_BYTES), ['schemaVersion', 'recordType', ...TARGET_KEYS,
            'restoreEpoch', 'writerEpoch', 'writerGeneration', 'revision', 'state', 'changedAt', 'sourceReferences']);
        if (value.schemaVersion !== 2 || value.recordType !== 'dashboard_admin_signup_index_revision' ||
            !equal(Object.fromEntries(TARGET_KEYS.map(k => [k, value[k]])), target) ||
            value.restoreEpoch !== currentHead.restoreEpoch || value.writerEpoch !== currentHead.writerEpoch ||
            value.writerGeneration !== currentHead.writerGeneration || value.revision !== currentHead.revision ||
            value.state !== currentHead.state || hash(value) !== currentHead.recordSha256) fail();
        instant(value.changedAt); if (value.changedAt > now()) fail();
        references(value.sourceReferences);
        if (value.state !== 'complete' && value.sourceReferences.length) fail();
        return freeze(value);
    }
    function observe(value) {
        if (observed && (!value || value.revision < observed.revision ||
            value.revision === observed.revision && !equal(value, observed))) fail();
        if (value) observed = value;
    }
    async function run(work, readOptions = {}) {
        let timer, unlink;
        const controller = new AbortController(), started = performance.now();
        let expired = false;
        try {
            fields(readOptions, Object.hasOwn(readOptions, 'signal') ? ['signal'] : []);
            if (readOptions.signal !== undefined) {
                const signal = readOptions.signal;
                if (!(signal instanceof AbortSignal) || isProxy(signal) || Object.getPrototypeOf(signal) !== AbortSignal.prototype ||
                    ['aborted', 'reason', 'addEventListener', 'removeEventListener'].some(key => Object.hasOwn(signal, key))) fail();
                const abort = () => controller.abort();
                signal.addEventListener('abort', abort, { once: true });
                unlink = () => signal.removeEventListener('abort', abort);
                if (signal.aborted) controller.abort();
            }
            const check = () => {
                if (expired || controller.signal.aborted || performance.now() - started >= config.requestBudgetMs) fail();
                return now();
            };
            check();
            const timed = new Promise((_, reject) => {
                timer = setTimeout(() => { expired = true; controller.abort(); try { fail(); } catch (e) { reject(e); } }, config.requestBudgetMs);
                controller.signal.addEventListener('abort', () => { try { fail(); } catch (e) { reject(e); } }, { once: true });
            });
            return await Promise.race([work({ check, signal: controller.signal }), timed]);
        } catch (_) { fail(); }
        finally { expired = true; clearTimeout(timer); unlink?.(); controller.abort(); }
    }
    async function epoch(context) {
        context.check();
        const result = fields(copy(await config.readExternalRuntimeEpoch(), 1024), ['instanceId', 'restoreEpoch']);
        context.check(); uuid(result.restoreEpoch);
        if (result.instanceId !== target.instanceId) fail();
        return freeze(result);
    }
    async function read(context, key, maximum, expectedEtag = null) {
        context.check(); let response;
        try {
            response = await config.container.getBlockBlobClient(key).download(0, maximum + 1,
                { abortSignal: context.signal, ...(expectedEtag ? { conditions: { ifMatch: expectedEtag } } : {}) });
        } catch (e) {
            context.check();
            if (!expectedEtag && e?.statusCode === 404 && e?.code === 'BlobNotFound') return null;
            fail();
        }
        const stream = response?.readableStreamBody;
        const abort = () => stream?.destroy();
        try {
            context.check();
            if (!stream || !fn(stream.destroy) || !Number.isSafeInteger(response.contentLength) ||
                response.contentLength < 1 || response.contentLength > maximum || !ETAG.test(response.etag) ||
                expectedEtag && expectedEtag !== response.etag) fail();
            context.signal.addEventListener('abort', abort, { once: true });
            let size = 0; const chunks = [];
            for await (const chunk of stream) {
                context.check(); size += chunk.length;
                if (size > response.contentLength || size > maximum) fail();
                chunks.push(Buffer.from(chunk));
            }
            context.check(); if (size !== response.contentLength) fail();
            const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), value = JSON.parse(text);
            if (canonical(value) !== text) fail();
            return { value, etag: response.etag };
        } finally { context.signal.removeEventListener('abort', abort); stream?.destroy(); }
    }
    async function load(context, expectedEpoch) {
        const result = await read(context, INDEX_HEAD_KEY, 4096);
        if (!result) { observe(null); return null; }
        const h = head(result.value); observe(h);
        if (h.restoreEpoch !== expectedEpoch.restoreEpoch) fail();
        const archive = await read(context, ARCHIVE_PREFIX + h.recordSha256 + '.json', MAX_RECORD_BYTES);
        if (!archive) fail();
        return { head: h, record: record(archive.value, h), etag: result.etag };
    }
    async function stable(context, loaded, expectedEpoch) {
        const current = await read(context, INDEX_HEAD_KEY, 4096, loaded.etag);
        if (!current || !equal(head(current.value), loaded.head) || !equal(await epoch(context), expectedEpoch)) fail();
        observe(loaded.head); context.check();
    }
    async function upload(context, key, value, conditions) {
        context.check();
        await config.container.getBlockBlobClient(key).uploadData(Buffer.from(canonical(value)), {
            conditions, abortSignal: context.signal,
            blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' }
        });
        context.check();
    }
    const journal = createSignupIndexWriteJournal({ target, read, upload, container: config.container,
        newId: config.newId, fail, checkpoint: head,
        reference(value) { references([value]); },
        async loadAccount(context, key) {
            const raw = await config.accountStore.load(key); context.check(); if (!raw) return null;
            const loaded = fields(copy(raw, 33792), ['record', 'version']);
            if (!ETAG.test(loaded.version)) fail();
            return { version: loaded.version, reference: referenceFor(target.provider, key, loaded.record) };
        }
    });
    async function publish(context, previous, expectedEpoch, state, refs, pinned) {
        const nextRevision = (previous?.head.revision ?? -1) + 1; revision(nextRevision);
        const value = freeze({ schemaVersion: 2, recordType: 'dashboard_admin_signup_index_revision', ...target,
            restoreEpoch: expectedEpoch.restoreEpoch, writerEpoch: pinned.value.writerEpoch,
            writerGeneration: pinned.value.generation, revision: nextRevision, state, changedAt: context.check(),
            sourceReferences: references(refs) });
        const nextHead = head({ schemaVersion: 2, recordType: 'dashboard_admin_signup_index_head', ...target,
            restoreEpoch: expectedEpoch.restoreEpoch, writerEpoch: pinned.value.writerEpoch,
            writerGeneration: pinned.value.generation, revision: nextRevision, state, recordSha256: hash(value) });
        record(value, nextHead);
        if (!equal(await epoch(context), expectedEpoch)) fail();
        await journal.stable(context, pinned);
        const key = ARCHIVE_PREFIX + nextHead.recordSha256 + '.json';
        try { await upload(context, key, value, { ifNoneMatch: '*' }); }
        catch (_) {
            context.check(); const seen = await read(context, key, MAX_RECORD_BYTES);
            if (!seen || !equal(seen.value, value)) fail();
        }
        if (!equal(await epoch(context), expectedEpoch)) fail();
        await journal.stable(context, pinned);
        try { await upload(context, INDEX_HEAD_KEY, nextHead, previous ? { ifMatch: previous.etag } : { ifNoneMatch: '*' }); }
        catch (_) { context.check(); }
        const current = await load(context, expectedEpoch);
        if (!current || !equal(current.head, nextHead)) fail();
        await stable(context, current, expectedEpoch);
        await journal.publish(context, pinned, nextHead);
        return current;
    }
    async function write(kind, key, version, raw) {
        let candidate;
        try {
            candidate = starterAccountRecord(raw); referenceFor(target.provider, key, candidate);
            if (kind === 'create' && (candidate.activation !== null || candidate.organisations.length !== 1) ||
                kind === 'replace' && !ETAG.test(version)) fail();
        } catch (_) { fail(); }
        let acknowledged;
        try { return await run(async context => {
            if (kind === 'replace') {
                const loaded = await config.accountStore.load(key); context.check();
                if (!loaded || loaded.version !== version) return false;
                const { activation, organisations, ...identity } = starterAccountRecord(loaded.record);
                const { activation: nextActivation, organisations: nextOrganisations, ...nextIdentity } = candidate;
                if (!equal(identity, nextIdentity) || activation && !equal(activation, nextActivation) ||
                    nextOrganisations.length < organisations.length || nextOrganisations.length > organisations.length + 1 ||
                    !equal(nextOrganisations.slice(0, organisations.length), organisations) ||
                    !activation && nextOrganisations.length !== organisations.length) fail();
            }
            const receipt = await journal.register(context, kind, key, version, hash(candidate));
            context.check();
            const result = kind === 'create' ? await config.accountStore.create(key, candidate)
                : await config.accountStore.replace(key, version, candidate);
            if (typeof result !== 'boolean') fail(); acknowledged = result;
            // Source acknowledgement is authoritative. Settlement contains only
            // bounded source reads/ticket CAS; no archive/native/admin callback.
            try { context.check(); await journal.settle(context, receipt); } catch (_) { /* Retain the issued family. */ }
            return result;
        }); } catch (error) {
            if (typeof acknowledged === 'boolean') return acknowledged;
            throw error;
        }
    }
    async function build(context, explicit, authoriseMaintenance = null, expected = null) {
        const currentEpoch = await epoch(context);
        const request = freeze({ action: 'dashboard.signup_index.rebuild', ...target, expectedPendingRebuild: expected });
        if (explicit) {
            if (await authoriseMaintenance(request) !== true) fail(); context.check();
            const existing = await journal.loadHead(context, true);
            if (!existing) {
                // Explicit initialization only, before the v2 writer binding is
                // enabled. An old index may hide an in-flight v1 account call.
                if (await read(context, INDEX_HEAD_KEY, 4096)) fail();
                await journal.initialise(context);
            }
        }
        const before = await journal.loadHead(context);
        if (!explicit && before.value.checkpoint?.state !== 'complete') fail();
        if (before.value.checkpoint && before.value.checkpoint.restoreEpoch !== currentEpoch.restoreEpoch) fail();
        const pinned = await journal.pin(context, expected);
        // Refresh and rebuild use the SAME issuance fence. Ignoring a prepared
        // ticket would permit a delayed source call after complete publication.
        const settled = await journal.scan(context, pinned);
        let refs = [], overflow = false;
        if (explicit) {
            const names = new Set(), iterable = config.container.listBlobsFlat({ prefix: SOURCE_PREFIX, abortSignal: context.signal });
            for await (const item of iterable) {
                context.check();
                if (!item || typeof item.name !== 'string' ||
                    !/^customer-starter\/starter-accounts\/[a-f0-9]{64}\.json$/.test(item.name) || names.has(item.name)) fail();
                names.add(item.name);
                if (names.size > MAX_ROWS) { overflow = true; break; }
                const key = item.name.slice('customer-starter/'.length, -'.json'.length);
                const loaded = await config.accountStore.load(key); context.check();
                if (!loaded || !ETAG.test(loaded.version)) fail();
                refs.push(referenceFor(target.provider, key, loaded.record));
            }
        } else {
            const retained = head(pinned.value.checkpoint);
            const archived = await read(context, ARCHIVE_PREFIX + retained.recordSha256 + '.json', MAX_RECORD_BYTES);
            if (!archived) fail();
            refs = record(archived.value, retained).sourceReferences;
            const current = new Map(refs.map(ref => [ref.accountKey, ref]));
            for (const entry of settled) {
                if (entry.generation <= retained.writerGeneration) continue;
                const old = current.get(entry.reference.accountKey);
                if (old && old.entry.binding.accountId !== entry.reference.entry.binding.accountId) fail();
                current.set(entry.reference.accountKey, entry.reference);
            }
            refs = [...current.values()]; overflow = refs.length > MAX_ROWS;
        }
        if (explicit && await authoriseMaintenance(request) !== true) fail(); context.check();
        await journal.stable(context, pinned);
        const current = await publish(context, await load(context, currentEpoch), currentEpoch,
            overflow ? 'overflow' : 'complete', overflow ? [] : refs.sort((a, b) => a.accountKey.localeCompare(b.accountKey)), pinned);
        return freeze({ state: current.head.state, revision: current.head.revision, complete: !overflow, count: overflow ? null : refs.length });
    }
    const accountStore = Object.freeze({ load: key => config.accountStore.load(key),
        create: (key, value) => write('create', key, null, value),
        replace: (key, version, value) => write('replace', key, version, value) });
    return Object.freeze({ accountStore,
        inspect(readOptions = {}) { return run(async context => {
            const currentEpoch = await epoch(context), current = await journal.loadHead(context, true);
            if (current) {
                if (current.value.checkpoint && current.value.checkpoint.restoreEpoch !== currentEpoch.restoreEpoch) fail();
                await journal.stable(context, current);
            }
            if (!equal(await epoch(context), currentEpoch)) fail();
            return freeze({ state: current ? current.value.state === 'idle' ? current.value.checkpoint.state : 'pending' : 'absent',
                revision: current?.value.checkpoint?.revision ?? null,
                headSha256: current ? hash(current.value) : null, operationId: current?.value.fenceId ?? null,
                operationKind: current?.value.state === 'rebuilding' ? 'rebuild' : null,
                restoreEpoch: currentEpoch.restoreEpoch, sourceBindingSha256: target.sourceBindingSha256 });
        }, readOptions); },
        readCurrentIndex(readOptions = {}) { return run(async context => {
            let writer = await journal.loadHead(context);
            // Index-only maintenance on the administrator read path. Never
            // historical backfill, source replay or a customer-facing delay.
            if (writer.value.state !== 'idle') { await build(context, false); writer = await journal.loadHead(context); }
            const currentEpoch = await epoch(context), current = await load(context, currentEpoch);
            if (writer.value.state !== 'idle' || !current || current.head.state !== 'complete' ||
                !equal(writer.value.checkpoint, current.head)) fail();
            await stable(context, current, currentEpoch); await journal.stable(context, writer);
            if (!equal(await epoch(context), currentEpoch)) fail();
            return freeze({ manifest: manifest(current.record.sourceReferences), sourceReferences: current.record.sourceReferences,
                revision: current.head.revision, restoreEpoch: currentEpoch.restoreEpoch,
                sourceBindingSha256: target.sourceBindingSha256, complete: true });
        }, readOptions); },
        rebuild(options) { return run(async context => {
            fields(options, ['authoriseMaintenance', ...(Object.hasOwn(options, 'expectedPendingRebuild') ? ['expectedPendingRebuild'] : [])]);
            if (!fn(options.authoriseMaintenance) || !fn(config.container.listBlobsFlat)) fail();
            let expected = null;
            if (Object.hasOwn(options, 'expectedPendingRebuild')) {
                expected = fields(copy(options.expectedPendingRebuild, 1024), ['headSha256', 'operationId']);
                digest(expected.headSha256); uuid(expected.operationId);
            }
            return build(context, true, options.authoriseMaintenance, expected);
        }); }
    });
}

module.exports = { createSignupIndexMaintenance, INDEX_HEAD_KEY, WRITER_CONTRACT, WRITER_HEAD_KEY, TICKET_PREFIX };
