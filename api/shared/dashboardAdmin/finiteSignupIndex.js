'use strict';

const { isProxy } = require('node:util').types;
const { performance } = require('node:perf_hooks');
const { addAbortListener } = require('node:events');
const { copy, fields, freeze, instant, digest, hash, equal } = require('../appLifecycle/dashboardRuntimeRecords');
const { DashboardAdminError } = require('./service');
const { projectSignupRecord, projectSignupPage } = require('./signupProjection');
const { normaliseSignupAuthority, normaliseSignupManifest, matchSignupManifest } = require('./signupAuthority');

const fail = (status = 503) => { throw new DashboardAdminError(status, status === 403 ? 'dashboard_admin_access_denied' : 'dashboard_admin_unavailable'); };
const port = value => typeof value === 'function' && !isProxy(value);
const integer = (value, maximum) => Number.isSafeInteger(value) && value > 0 && value <= maximum;
const scopeKeys = ['provider', 'tenantId', 'populationId', 'indexId'];
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;

// Dormant pure paging over already validated evidence summaries. No real manifest,
// approval resolver, domain/store reader, audit writer or host composition exists
// here. resolvePopulationBinding must independently establish CURRENT approval;
// echoing the supplied grant's hash and the manifest hash is not authorisation.
function createFiniteSignupPageReader(options) {
    let config, manifest;
    try {
        if (!options || isProxy(options)) fail();
        fields(options, ['manifest', 'resolvePopulationBinding', 'readEntrySummary', 'clock',
            ...(Object.hasOwn(options, 'requestBudgetMs') ? ['requestBudgetMs'] : [])]);
        config = { ...options, requestBudgetMs: Object.hasOwn(options, 'requestBudgetMs') ? options.requestBudgetMs : 10000 };
        if (![config.resolvePopulationBinding, config.readEntrySummary, config.clock].every(port) ||
            !integer(config.requestBudgetMs, 10000)) fail();
        manifest = normaliseSignupManifest(config.manifest);
    } catch (_) { fail(); }
    const manifestSha256 = hash(manifest), prefix = 'signup-index-v' + manifest.schemaVersion + ':', snapshotId = prefix + manifestSha256;
    let lastTime = -Infinity;
    function now() {
        try {
            const value = instant(config.clock()), time = Date.parse(value);
            if (time < lastTime) fail();
            lastTime = time;
            return value;
        } catch (_) { fail(); }
    }
    function bounded(externalSignal, work) {
        let closed = false, timer, listener;
        const controller = new AbortController(), started = performance.now();
        const check = () => {
            if (closed || externalSignal && signalAborted.call(externalSignal) || performance.now() - started >= config.requestBudgetMs) fail();
            return now();
        };
        const stopped = new Promise((_, reject) => {
            const stop = () => { closed = true; controller.abort(); reject(new DashboardAdminError(503, 'dashboard_admin_unavailable')); };
            timer = setTimeout(stop, config.requestBudgetMs);
            try {
                if (externalSignal) {
                    listener = addAbortListener(externalSignal, stop);
                    if (signalAborted.call(externalSignal)) stop();
                }
            } catch (_) { stop(); } // Registration failure must close before work is queued.
        });
        return Promise.race([stopped, Promise.resolve().then(() => work(check, controller.signal))])
            .finally(() => { closed = true; controller.abort(); clearTimeout(timer); listener?.[Symbol.dispose](); });
    }
    return async function readSignupPage(input, options = {}) {
        try {
            const request = fields(copy(input, 8192), ['authority', 'cursor', 'snapshotId', 'limit']);
            if (isProxy(options)) fail();
            fields(options, Object.hasOwn(options, 'signal') ? ['signal'] : []);
            let externalSignal = options.signal;
            if (Object.hasOwn(options, 'signal')) {
                if (!externalSignal || isProxy(externalSignal) || Object.getPrototypeOf(externalSignal) !== AbortSignal.prototype ||
                    ['aborted', 'reason', 'addEventListener', 'removeEventListener'].some(key => Object.hasOwn(externalSignal, key))) fail();
                signalAborted.call(externalSignal);
                // Capture a private native dependent signal: later caller mutations
                // cannot replace listener registration/cleanup or hide cancellation.
                externalSignal = AbortSignal.any([externalSignal]);
            }
            return await bounded(externalSignal, async (check, signal) => {
                const startedAt = check();
                let grant;
                try { grant = normaliseSignupAuthority(request.authority, { now: startedAt }); matchSignupManifest(grant, manifest); } catch (_) { fail(403); }
                const authoritySha256 = hash(grant), cursorPrefix = prefix + hash({ authoritySha256, manifestSha256 }) + ':';
                if (!integer(request.limit, grant.maxPageSize) || request.limit > grant.maxRows) fail();
                let offset = 0;
                if (request.cursor === null) {
                    if (request.snapshotId !== null) fail();
                } else {
                    if (request.snapshotId !== snapshotId || typeof request.cursor !== 'string' || !request.cursor.startsWith(cursorPrefix)) fail();
                    const position = request.cursor.slice(cursorPrefix.length);
                    if (!/^[1-9][0-9]{0,2}$/.test(position)) fail();
                    offset = Number(position);
                    if (offset >= manifest.entries.length || offset >= grant.maxRows) fail();
                }
                let observedAt = null;
                function current() {
                    const time = check();
                    if (grant.issuedAt > time || grant.expiresAt <= time) fail(403);
                    if (observedAt && (observedAt > time || Date.parse(time) - Date.parse(observedAt) > 30000)) fail();
                    return time;
                }
                async function approved() {
                    current();
                    let raw;
                    try { raw = await config.resolvePopulationBinding(grant, { signal }); }
                    catch (_) { current(); fail(403); }
                    current();
                    try {
                        const binding = fields(copy(raw, 1024), ['authoritySha256', 'manifestSha256']);
                        digest(binding.authoritySha256); digest(binding.manifestSha256);
                        if (binding.authoritySha256 !== authoritySha256 || binding.manifestSha256 !== manifestSha256) fail(403);
                    } catch (_) { fail(403); }
                }
                await approved();
                const selected = manifest.entries.slice(offset, Math.min(offset + request.limit, grant.maxRows)), records = [];
                for (const entry of selected) {
                    current();
                    let raw;
                    try { raw = await config.readEntrySummary(entry, { signal }); }
                    catch (_) { current(); fail(); }
                    const receivedAt = current();
                    // Snapshot evidence before any further await. A future timestamp
                    // at receipt cannot become valid during a slow approval callback.
                    const evidence = fields(copy(raw, 17408), ['record', 'observedAt']);
                    instant(evidence.observedAt);
                    if (evidence.observedAt > receivedAt || Date.parse(receivedAt) - Date.parse(evidence.observedAt) > 30000 ||
                        evidence.record.recordId !== entry.recordId || !equal(evidence.record.binding, entry.binding)) fail();
                    projectSignupRecord(evidence.record, entry.binding, evidence.observedAt);
                    observedAt = observedAt === null || evidence.observedAt < observedAt ? evidence.observedAt : observedAt;
                    current(); await approved();
                    records.push(evidence.record);
                }
                observedAt ??= startedAt;
                const nextOffset = offset + records.length;
                const page = freeze({ schemaVersion: manifest.schemaVersion,
                    ...Object.fromEntries(scopeKeys.filter(key => manifest.schemaVersion === 1 || key !== 'tenantId').map(key => [key, manifest[key]])),
                    ...(manifest.schemaVersion === 2 ? { manifest } : {}),
                    snapshotId, observedAt, status: 'available', records,
                    nextCursor: nextOffset < manifest.entries.length ? cursorPrefix + nextOffset : null });
                await approved();
                // Validate all milestones at the oldest observation, never at a new
                // clock stamp after slow I/O. Incoherent pages are withheld whole.
                projectSignupPage(page, grant, { now: current(), limit: request.limit, snapshotId: request.snapshotId, offset });
                current();
                return page;
            });
        } catch (error) {
            fail(error instanceof DashboardAdminError && error.statusCode === 403 ? 403 : 503);
        }
    };
}

module.exports = { createFiniteSignupPageReader };
