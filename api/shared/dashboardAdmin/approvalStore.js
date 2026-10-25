'use strict';

// Reader-only capability for the separately approved private record class.
// No upload/list/delete, fallback policy, environment grant or cached approval.
const { performance } = require('node:perf_hooks');
const { TextDecoder, types: { isProxy } } = require('node:util');
const { fields, copy, freeze, equal, canonical, uuid, instant } = require('../appLifecycle/dashboardRuntimeRecords');
const { approvalTarget, approvalHead, approvalRevision, headKey, revisionKey } = require('./approvalRecords');
const { DashboardAdminError } = require('./service');
const unavailable = () => new DashboardAdminError(503, 'dashboard_admin_unavailable');
const MAX_OBSERVED_SUBJECTS = 1024;

function createDashboardAdminApprovalReader(input) {
    let container, instanceId, clock, readEpoch, budget;
    try {
        fields(input, ['authorityContainer', 'instanceId', 'clock', 'readExternalRuntimeEpoch', 'requestBudgetMs']);
        ({ authorityContainer: container, instanceId, clock, readExternalRuntimeEpoch: readEpoch, requestBudgetMs: budget } = input);
        uuid(instanceId);
        if (!container || isProxy(container) || typeof container.getBlockBlobClient !== 'function' ||
            typeof clock !== 'function' || typeof readEpoch !== 'function' ||
            !Number.isSafeInteger(budget) || budget < 1 || budget > 10000) throw unavailable();
    } catch (_) { throw unavailable(); }
    const observed = new Map();
    let lastAt = null;
    function now() {
        const at = instant(clock());
        if (lastAt !== null && at < lastAt) throw unavailable();
        lastAt = at; return at;
    }
    function observe(key, head) {
        const previous = observed.get(key);
        if (previous && (head.revision < previous.revision ||
            head.revision === previous.revision && !equal(head, previous))) throw unavailable();
        if (!previous && observed.size >= MAX_OBSERVED_SUBJECTS) throw unavailable();
        observed.set(key, head);
    }
    return Object.freeze({ async readApprovedBinding(input) {
        const controller = new AbortController(), started = performance.now();
        let timer, expired = false;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => { expired = true; controller.abort(); reject(unavailable()); }, budget);
        });
        function check() {
            if (expired || performance.now() - started >= budget) throw unavailable();
            return now();
        }
        async function epoch() {
            check();
            const value = fields(copy(await readEpoch(), 1024), ['instanceId', 'restoreEpoch']);
            check(); uuid(value.instanceId); uuid(value.restoreEpoch);
            if (value.instanceId !== instanceId) throw unavailable();
            return freeze(value);
        }
        async function read(key, maximum, etag = null) {
            check(); let response;
            try {
                response = await container.getBlockBlobClient(key).download(0, maximum + 1, {
                    abortSignal: controller.signal, ...(etag === null ? {} : { conditions: { ifMatch: etag } })
                });
            } catch (error) {
                check();
                if (etag === null && error?.statusCode === 404 && error?.code === 'BlobNotFound') return null;
                throw unavailable();
            }
            const stream = response?.readableStreamBody;
            const abort = () => stream?.destroy(unavailable());
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
                check();
                if (size !== response.contentLength) throw unavailable();
                const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
                const value = JSON.parse(text);
                // Canonical bytes reject duplicate keys and ambiguous encodings.
                if (canonical(value) !== text) throw unavailable();
                return { value, etag: response.etag };
            } finally { controller.signal.removeEventListener('abort', abort); stream?.destroy(); }
        }
        const work = (async () => {
            fields(input, ['operatorSubjectKey', 'purpose']);
            const target = approvalTarget({ ...input, instanceId }), key = headKey(target);
            const before = await epoch(), first = await read(key, 2048);
            if (!first) {
                if (observed.has(key)) throw unavailable();
                return null;
            }
            const head = approvalHead(first.value, target);
            observe(key, head);
            if (head.restoreEpoch !== before.restoreEpoch) return null;
            const archive = await read(revisionKey(target, head.recordSha256), 16384);
            if (!archive) throw unavailable();
            const record = approvalRevision(archive.value, head);
            if (record.changedAt > check()) throw unavailable();
            const second = await read(key, 2048, first.etag);
            if (!second || !equal(approvalHead(second.value, target), head)) throw unavailable();
            observe(key, head);
            if (!equal(await epoch(), before)) throw unavailable();
            const at = check();
            if (record.status === 'revoked' || at < record.binding.validFrom || at >= record.binding.validUntil) return null;
            // Another concurrent read may have observed a newer revision while
            // the final epoch read was pending. Never release the older grant.
            observe(key, head);
            return record.binding;
        })();
        try { return await Promise.race([work, timeout]); }
        catch (_) { throw unavailable(); }
        finally { expired = true; clearTimeout(timer); controller.abort(); }
    } });
}

module.exports = { createDashboardAdminApprovalReader };
