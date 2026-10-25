'use strict';

// Reader-only binding of protected approval and complete current index records.
// No environment-created grant, archive publication, enumeration or cached grant.
const { performance } = require('node:perf_hooks');
const { TextDecoder, types: { isProxy } } = require('node:util');
const { addAbortListener } = require('node:events');
const { fields, copy, freeze, equal, canonical, hash, uuid, instant, id, digest } = require('../appLifecycle/dashboardRuntimeRecords');
const { normaliseSignupAuthority } = require('./signupAuthority');
const { listingTarget, listingHead, listingRevision, listingHeadKey, listingRevisionKey,
    completeListingIndex, listingDecision } = require('./signupListingRecords');
const { DashboardAdminError } = require('./service');
const unavailable = () => new DashboardAdminError(503, 'dashboard_admin_unavailable');
const denied = () => new DashboardAdminError(403, 'dashboard_admin_access_denied');
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const MAX_OBSERVED_OPERATORS = 1024;

function createDashboardAdminSignupListingReader(input) {
    let config;
    try {
        fields(input, ['authorityContainer', 'instanceId', 'clock', 'readExternalRuntimeEpoch', 'requestBudgetMs',
            'provider', 'populationId', 'indexId', 'sourceBindingSha256', 'readCurrentIndex']);
        config = { ...input };
        uuid(config.instanceId); id(config.populationId); id(config.indexId); digest(config.sourceBindingSha256);
        if (!['legacy', 'external'].includes(config.provider)) throw unavailable();
        if (!config.authorityContainer || isProxy(config.authorityContainer) ||
            typeof config.authorityContainer.getBlockBlobClient !== 'function' ||
            ![config.clock, config.readExternalRuntimeEpoch, config.readCurrentIndex].every(value => typeof value === 'function' && !isProxy(value)) ||
            !Number.isSafeInteger(config.requestBudgetMs) || config.requestBudgetMs < 1 || config.requestBudgetMs > 10000) throw unavailable();
    } catch (_) { throw unavailable(); }
    const observed = new Map(); let lastAt = null, observedIndex = null;
    function now() {
        const at = instant(config.clock());
        if (lastAt !== null && at < lastAt) throw unavailable();
        lastAt = at; return at;
    }
    function observeHead(key, head) {
        const prior = observed.get(key);
        if (prior && (head.revision < prior.revision || head.revision === prior.revision && !equal(head, prior)) ||
            !prior && observed.size >= MAX_OBSERVED_OPERATORS) throw unavailable();
        observed.set(key, head);
    }
    function observeIndex(index) {
        const current = { revision: index.revision, sha256: hash(index) };
        if (observedIndex && (current.revision < observedIndex.revision ||
            current.revision === observedIndex.revision && current.sha256 !== observedIndex.sha256)) throw unavailable();
        observedIndex = current;
    }
    async function current(query, options = {}) {
        const controller = new AbortController(), started = performance.now();
        let timer, listener, expired = false;
        function check() {
            if (expired || signalAborted.call(controller.signal) || performance.now() - started >= config.requestBudgetMs) throw unavailable();
            return now();
        }
        try {
            fields(query, ['operatorSubjectKey', 'capability']);
            if (query.capability !== 'signupList') throw unavailable();
            const target = listingTarget({ instanceId: config.instanceId, operatorSubjectKey: query.operatorSubjectKey,
                provider: config.provider, populationId: config.populationId, indexId: config.indexId,
                sourceBindingSha256: config.sourceBindingSha256 });
            fields(options, Object.hasOwn(options, 'signal') ? ['signal'] : []);
            if (Object.hasOwn(options, 'signal')) {
                const supplied = options.signal;
                if (!supplied || isProxy(supplied) || Object.getPrototypeOf(supplied) !== AbortSignal.prototype ||
                    ['aborted', 'reason', 'addEventListener', 'removeEventListener'].some(key => Object.hasOwn(supplied, key))) throw unavailable();
                if (signalAborted.call(supplied)) throw unavailable();
                listener = addAbortListener(supplied, () => controller.abort());
            }
            check();
            const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => { expired = true; controller.abort(); reject(unavailable()); }, config.requestBudgetMs);
                controller.signal.addEventListener('abort', () => reject(unavailable()), { once: true });
            });
            async function epoch() {
                check();
                const value = fields(copy(await config.readExternalRuntimeEpoch(), 1024), ['instanceId', 'restoreEpoch']);
                check(); uuid(value.instanceId); uuid(value.restoreEpoch);
                if (value.instanceId !== config.instanceId) throw unavailable();
                return freeze(value);
            }
            async function read(key, maximum, etag = null) {
                check(); let response;
                try {
                    response = await config.authorityContainer.getBlockBlobClient(key).download(0, maximum + 1, {
                        abortSignal: controller.signal, ...(etag === null ? {} : { conditions: { ifMatch: etag } }) });
                } catch (error) {
                    check();
                    if (etag === null && error?.statusCode === 404 && error?.code === 'BlobNotFound') return null;
                    throw unavailable();
                }
                const stream = response?.readableStreamBody, abort = () => stream?.destroy(unavailable());
                try {
                    check();
                    if (!stream || typeof stream.destroy !== 'function' ||
                        !Number.isSafeInteger(response.contentLength) || response.contentLength < 1 || response.contentLength > maximum ||
                        typeof response.etag !== 'string' || !/^"[\x21\x23-\x7e]{1,128}"$/.test(response.etag) ||
                        etag !== null && response.etag !== etag) throw unavailable();
                    controller.signal.addEventListener('abort', abort, { once: true });
                    const chunks = []; let size = 0;
                    for await (const chunk of stream) {
                        check(); const bytes = Buffer.from(chunk); size += bytes.length;
                        if (size > maximum || size > response.contentLength) throw unavailable();
                        chunks.push(bytes);
                    }
                    check(); if (size !== response.contentLength) throw unavailable();
                    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), value = JSON.parse(text);
                    if (canonical(value) !== text) throw unavailable();
                    return { value, etag: response.etag };
                } finally { controller.signal.removeEventListener('abort', abort); stream?.destroy(); }
            }
            async function index(restoreEpoch) {
                check();
                const value = completeListingIndex(await config.readCurrentIndex({ signal: controller.signal }), target, restoreEpoch);
                check(); observeIndex(value); return value;
            }
            const work = (async () => {
                const before = await epoch(), key = listingHeadKey(target), first = await read(key, 4096);
                if (!first) {
                    if (observed.has(key)) throw unavailable();
                    return null;
                }
                const head = listingHead(first.value, target); observeHead(key, head);
                if (head.restoreEpoch !== before.restoreEpoch) return null;
                const archive = await read(listingRevisionKey(target, head.recordSha256), 8192);
                if (!archive) throw unavailable();
                const record = listingRevision(archive.value, head);
                if (record.changedAt > check()) throw unavailable();
                if (record.status === 'revoked' || check() < record.policy.validFrom ||
                    record.policy.validUntil !== null && check() >= record.policy.validUntil) return null;
                const selected = await index(before.restoreEpoch), grant = listingDecision(record, selected, check());
                if (!equal(selected, await index(before.restoreEpoch))) throw unavailable();
                const second = await read(key, 4096, first.etag);
                if (!second || !equal(listingHead(second.value, target), head)) throw unavailable();
                observeHead(key, head);
                if (!equal(await epoch(), before)) throw unavailable();
                if (!equal(grant, listingDecision(record, selected, check()))) throw unavailable();
                observeHead(key, head); observeIndex(selected);
                return freeze({ authority: grant, index: selected });
            })();
            return await Promise.race([work, timeout]);
        } catch (_) { throw unavailable(); }
        finally { expired = true; clearTimeout(timer); controller.abort(); listener?.[Symbol.dispose](); }
    }
    async function expected(grant, options) {
        let value;
        try { value = normaliseSignupAuthority(grant, { now: now() }); }
        catch (_) { throw denied(); }
        const result = await current({ operatorSubjectKey: value.operatorSubjectKey, capability: 'signupList' }, options);
        if (!result || !equal(result.authority, value)) throw denied();
        return result;
    }
    return Object.freeze({
        async readApprovedAuthority(query) { const result = await current(query); return result?.authority ?? null; },
        async readApprovedState(query, options = {}) {
            const result = await current(query, options);
            return result === null ? null : freeze({ authority: result.authority,
                population: { authoritySha256: hash(result.authority), manifestSha256: hash(result.index.manifest) } });
        },
        async resolvePopulationBinding(grant, options = {}) {
            const result = await expected(grant, options);
            return freeze({ authoritySha256: hash(result.authority), manifestSha256: hash(result.index.manifest) });
        },
        async readApprovedIndex(grant, options = {}) { return (await expected(grant, options)).index; }
    });
}

// Operator-only publication capability. It is never returned by the production
// reader composition. The explicit callback must authorise this exact record
// before EACH write; construction or successful inspection confers no authority.
function createDashboardAdminSignupListingPublisher(input) {
    let config;
    try {
        fields(input, ['authorityContainer', 'instanceId', 'clock', 'readExternalRuntimeEpoch', 'requestBudgetMs',
            'provider', 'populationId', 'indexId', 'sourceBindingSha256', 'authorisePublication']);
        config = { ...input };
        uuid(config.instanceId); id(config.populationId); id(config.indexId); digest(config.sourceBindingSha256);
        if (!['legacy', 'external'].includes(config.provider) || !config.authorityContainer || isProxy(config.authorityContainer) ||
            typeof config.authorityContainer.getBlockBlobClient !== 'function' ||
            ![config.clock, config.readExternalRuntimeEpoch, config.authorisePublication].every(value => typeof value === 'function' && !isProxy(value)) ||
            !Number.isSafeInteger(config.requestBudgetMs) || config.requestBudgetMs < 1 || config.requestBudgetMs > 10000) throw unavailable();
    } catch (_) { throw unavailable(); }
    const conflict = () => new DashboardAdminError(409, 'dashboard_admin_publication_conflict');
    const observed = new Map(); let lastAt = null;
    function targetFor(actor) {
        return listingTarget({ instanceId: config.instanceId, operatorSubjectKey: actor, provider: config.provider,
            populationId: config.populationId, indexId: config.indexId, sourceBindingSha256: config.sourceBindingSha256 });
    }
    async function run(work) {
        const controller = new AbortController(), started = performance.now(); let expired = false, timer;
        function check() {
            if (expired || signalAborted.call(controller.signal) || performance.now() - started >= config.requestBudgetMs) throw unavailable();
            const at = instant(config.clock());
            if (lastAt !== null && at < lastAt) throw unavailable();
            lastAt = at; return at;
        }
        async function epoch() {
            check();
            const value = fields(copy(await config.readExternalRuntimeEpoch(), 1024), ['instanceId', 'restoreEpoch']);
            check(); uuid(value.instanceId); uuid(value.restoreEpoch);
            if (value.instanceId !== config.instanceId) throw unavailable();
            return freeze(value);
        }
        async function read(key, maximum, etag = null) {
            check(); let response;
            try {
                response = await config.authorityContainer.getBlockBlobClient(key).download(0, maximum + 1, {
                    abortSignal: controller.signal, ...(etag === null ? {} : { conditions: { ifMatch: etag } }) });
            } catch (error) {
                check();
                if (etag === null && error?.statusCode === 404 && error?.code === 'BlobNotFound') return null;
                throw unavailable();
            }
            const stream = response?.readableStreamBody, abort = () => stream?.destroy(unavailable());
            try {
                check();
                if (!stream || typeof stream.destroy !== 'function' ||
                    !Number.isSafeInteger(response.contentLength) || response.contentLength < 1 || response.contentLength > maximum ||
                    typeof response.etag !== 'string' || !/^"[\x21\x23-\x7e]{1,128}"$/.test(response.etag) ||
                    etag !== null && response.etag !== etag) throw unavailable();
                controller.signal.addEventListener('abort', abort, { once: true });
                const chunks = []; let size = 0;
                for await (const chunk of stream) {
                    check(); const bytes = Buffer.from(chunk); size += bytes.length;
                    if (size > maximum || size > response.contentLength) throw unavailable();
                    chunks.push(bytes);
                }
                check(); if (size !== response.contentLength) throw unavailable();
                const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), value = JSON.parse(text);
                if (canonical(value) !== text) throw unavailable();
                return { value, etag: response.etag };
            } finally { controller.signal.removeEventListener('abort', abort); stream?.destroy(); }
        }
        function observe(key, head) {
            const prior = observed.get(key);
            if (head === null) { if (prior) throw unavailable(); return; }
            if (prior && (head.revision < prior.revision || head.revision === prior.revision && !equal(head, prior)) ||
                !prior && observed.size >= MAX_OBSERVED_OPERATORS) throw unavailable();
            observed.set(key, head);
        }
        async function current(target) {
            const key = listingHeadKey(target), first = await read(key, 4096);
            if (!first) { observe(key, null); return null; }
            const head = listingHead(first.value, target); observe(key, head);
            const archive = await read(listingRevisionKey(target, head.recordSha256), 8192);
            if (!archive) throw unavailable();
            const record = listingRevision(archive.value, head);
            if (record.changedAt > check()) throw unavailable();
            const second = await read(key, 4096, first.etag);
            if (!second || !equal(listingHead(second.value, target), head)) throw unavailable();
            observe(key, head); return { head, record, etag: first.etag };
        }
        async function upload(key, value, conditions) {
            check();
            await config.authorityContainer.getBlockBlobClient(key).uploadData(Buffer.from(canonical(value)), {
                conditions, abortSignal: controller.signal,
                blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' } });
            check();
        }
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => { expired = true; controller.abort(); reject(unavailable()); }, config.requestBudgetMs);
        });
        try { return await Promise.race([work({ check, epoch, read, current, upload }), timeout]); }
        catch (error) {
            if (error instanceof DashboardAdminError) throw error;
            throw unavailable();
        } finally { expired = true; clearTimeout(timer); controller.abort(); }
    }
    return Object.freeze({
        async inspect(input) {
            return run(async io => {
                fields(input, ['operatorSubjectKey']); const target = targetFor(input.operatorSubjectKey);
                const before = await io.epoch(), value = await io.current(target);
                if (!equal(await io.epoch(), before)) throw unavailable();
                return freeze({ expectedRevision: value?.head.revision ?? null,
                    expectedRecordSha256: value?.head.recordSha256 ?? null, restoreEpoch: before.restoreEpoch });
            });
        },
        async publish(input) {
            return run(async io => {
                const command = fields(copy(input, 12288), ['record', 'expectedRevision', 'expectedRecordSha256']);
                const target = targetFor(command.record?.operatorSubjectKey), source = command.record;
                const head = listingHead({ schemaVersion: 1, recordType: 'dashboard_admin_signup_policy_head', ...target,
                    restoreEpoch: source.restoreEpoch, revision: source.revision, status: source.status, recordSha256: hash(source) }, target);
                const record = listingRevision(source, head), before = await io.epoch();
                if (before.restoreEpoch !== record.restoreEpoch || record.changedAt > io.check()) throw conflict();
                const initial = command.expectedRevision === null && command.expectedRecordSha256 === null;
                if (!initial) {
                    if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 || Object.is(command.expectedRevision, -0)) throw conflict();
                    digest(command.expectedRecordSha256);
                }
                const prior = await io.current(target), result = freeze({ schemaVersion: 1, targetSha256: hash(target),
                    revision: record.revision, recordSha256: head.recordSha256, status: record.status });
                if (prior && equal(prior.head, head)) {
                    if (!equal(await io.epoch(), before)) throw unavailable();
                    return result; // Exact acknowledged publication; no second write.
                }
                if (prior ? initial || prior.head.revision !== command.expectedRevision || prior.head.recordSha256 !== command.expectedRecordSha256 ||
                    record.revision !== prior.head.revision + 1 : !initial || record.revision !== 0) throw conflict();
                async function beforeWrite(phase) {
                    if (!equal(await io.epoch(), before)) throw conflict();
                    const at = io.check();
                    if (record.status === 'active' && record.policy.validUntil !== null && at >= record.policy.validUntil) throw conflict();
                    const approved = await config.authorisePublication(freeze({ phase, record,
                        expectedRevision: command.expectedRevision, expectedRecordSha256: command.expectedRecordSha256 }));
                    io.check();
                    if (approved !== true) throw denied();
                    if (!equal(await io.epoch(), before)) throw conflict();
                    if (record.status === 'active' && record.policy.validUntil !== null && io.check() >= record.policy.validUntil) throw conflict();
                }
                const archiveKey = listingRevisionKey(target, head.recordSha256), headKey = listingHeadKey(target);
                await beforeWrite('archive');
                try { await io.upload(archiveKey, record, { ifNoneMatch: '*' }); }
                catch (_) {
                    const archive = await io.read(archiveKey, 8192);
                    if (!archive || !equal(listingRevision(archive.value, head), record)) throw unavailable();
                }
                await beforeWrite('head');
                try { await io.upload(headKey, head, prior ? { ifMatch: prior.etag } : { ifNoneMatch: '*' }); }
                catch (_) {
                    const observed = await io.current(target);
                    if (!observed || !equal(observed.head, head)) throw conflict();
                }
                const observed = await io.current(target);
                if (!observed || !equal(observed.head, head) || !equal(await io.epoch(), before)) throw conflict();
                return result;
            });
        }
    });
}

module.exports = { createDashboardAdminSignupListingReader, createDashboardAdminSignupListingPublisher };
