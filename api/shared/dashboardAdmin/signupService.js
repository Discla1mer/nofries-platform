'use strict';

const { randomBytes, randomUUID } = require('node:crypto');
const { isProxy } = require('node:util').types;
const { performance } = require('node:perf_hooks');
const { copy, fields, freeze, subject, instant, hash, equal } = require('../appLifecycle/dashboardRuntimeRecords');
const { DashboardAdminError } = require('./service');
const { projectSignupPage } = require('./signupProjection');
const { normaliseSignupAuthority } = require('./signupAuthority');
const fail = (status, suffix) => { throw new DashboardAdminError(status, 'dashboard_admin_' + suffix); };
const port = value => typeof value === 'function' && !isProxy(value);
const integer = (value, maximum) => Number.isSafeInteger(value) && value > 0 && value <= maximum;

function signupListInput(input) {
    try {
        const value = fields(copy(input, 256), ['cursor']);
        if (value.cursor !== null && (typeof value.cursor !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.cursor))) throw new Error();
        return freeze(value);
    } catch (_) { fail(400, 'input_invalid'); }
}
function principal(input) {
    try {
        const value = copy(input, 4096);
        if (value.provider !== 'entra-bff' || value.isAuthenticated !== true) throw new Error();
        subject(value.subjectKey);
        return freeze({ provider: value.provider, isAuthenticated: true, subjectKey: value.subjectKey });
    } catch (_) { fail(403, 'access_denied'); }
}

// Dormant trusted composition only: no actual index, operator policy or listing
// audit writer is supplied here. The exact-person approval adapter is unrelated.
function createSignupListService({ authoriseSignupList, readSignupPage = null, audit = null, clock,
    requestBudgetMs = 10000 } = {}) {
    if (![authoriseSignupList, clock].every(port) || readSignupPage !== null && !port(readSignupPage) ||
        audit !== null && !port(audit) || !integer(requestBudgetMs, 10000)) fail(503, 'unavailable');
    const cursors = new Map(), disclosures = new WeakMap();
    let lastTime = -Infinity;
    function now() {
        try {
            const value = instant(clock()), time = Date.parse(value);
            if (time < lastTime) throw new Error();
            lastTime = time;
            return value;
        } catch (_) { cursors.clear(); fail(503, 'unavailable'); }
    }
    function bounded(work) {
        let closed = false, timer;
        const start = performance.now(), controller = new AbortController();
        const check = () => {
            if (closed || performance.now() - start >= requestBudgetMs) fail(503, 'unavailable');
            return now();
        };
        return Promise.race([Promise.resolve().then(() => work(check, controller.signal)), new Promise((_, reject) => {
            timer = setTimeout(() => { closed = true; controller.abort(); reject(new DashboardAdminError(503, 'dashboard_admin_unavailable')); }, requestBudgetMs);
        })]).finally(() => { closed = true; controller.abort(); clearTimeout(timer); });
    }
    async function approved(actor, check, expected = null) {
        check();
        let result;
        try { result = await authoriseSignupList(freeze({ principal: actor, capability: 'signupList' })); }
        catch (error) {
            check();
            if (error instanceof DashboardAdminError && error.statusCode === 503 && error.code === 'dashboard_admin_unavailable') fail(503, 'unavailable');
            fail(403, 'access_denied');
        }
        const time = check();
        let grant;
        try {
            grant = normaliseSignupAuthority(result, { actorSubjectKey: actor.subjectKey, now: time });
            if (expected && !equal(grant, expected)) throw new Error();
        } catch (_) {
            for (const [key, cursor] of cursors) if (cursor.actor === actor.subjectKey) cursors.delete(key);
            fail(403, 'access_denied');
        }
        return grant;
    }
    function authorise(input) { return bounded(check => approved(principal(input), check)); }
    function capabilities(input) {
        return bounded(async check => {
            const actor = principal(input), grant = await approved(actor, check);
            await approved(actor, check, grant);
            return freeze({ signupList: readSignupPage !== null && audit !== null });
        });
    }
    function list(inputActor, input) {
        return bounded(async (check, signal) => {
            const actor = principal(inputActor), grant = await approved(actor, check);
            const request = signupListInput(input), authoritySha256 = hash(grant);
            if (!readSignupPage || !audit) fail(503, 'unavailable');
            const at = Date.parse(check());
            for (const [key, cursor] of cursors) if (cursor.expiresAt <= at || cursor.deadline <= performance.now()) cursors.delete(key);
            let continuation = { snapshotId: null, sourceCursor: null, count: 0, page: 0, ids: [], identities: [], sources: [] };
            if (request.cursor !== null) {
                const saved = cursors.get(request.cursor);
                if (!saved || saved.actor !== actor.subjectKey || saved.authoritySha256 !== authoritySha256) fail(400, 'input_invalid');
                cursors.delete(request.cursor); // one use, including uncertain failures
                continuation = saved;
            }
            if (cursors.size >= 256) fail(503, 'unavailable'); // finite process capacity, no eviction of valid handles
            const limit = Math.min(grant.maxPageSize, grant.maxRows - continuation.count);
            if (limit < 1 || continuation.page >= grant.maxPages) fail(400, 'input_invalid');
            const requestId = randomUUID();
            async function record(phase, outcome, count = 0) {
                const event = freeze({ schemaVersion: 1, category: 'dashboard_admin_signup_list', requestId,
                    actorSubjectKey: actor.subjectKey, authoritySha256, requestSha256: hash(request), page: continuation.page + 1,
                    phase, outcome, count, occurredAt: check() });
                let ack;
                try { ack = await audit(event, grant, { signal }); }
                catch (_) { check(); fail(503, 'unavailable'); }
                check();
                try {
                    const saved = fields(copy(ack, 1024), ['schemaVersion', 'durable', 'eventSha256']);
                    if (saved.schemaVersion !== 1 || saved.durable !== true || saved.eventSha256 !== hash(event)) throw new Error();
                } catch (_) { fail(503, 'unavailable'); }
            }
            await record('attempt', 'requested');
            let page, denied = false;
            try {
                await approved(actor, check, grant);
                const raw = await readSignupPage(freeze({ authority: grant, cursor: continuation.sourceCursor,
                    snapshotId: continuation.snapshotId, limit }), { signal });
                check(); await approved(actor, check, grant);
                page = projectSignupPage(raw, grant, { now: check(), limit, snapshotId: continuation.snapshotId, offset: continuation.count });
                if (page.recordIds.some(value => continuation.ids.includes(value)) || page.identities.some(value => continuation.identities.includes(value)) ||
                    page.nextCursor !== null && [...continuation.sources, continuation.sourceCursor].includes(page.nextCursor)) throw new Error();
            } catch (error) {
                check();
                denied = error?.statusCode === 403;
                page = { status: 'unavailable', rows: [], observedAt: null, nextCursor: null };
            }
            await record('outcome', denied ? 'denied' : page.status, page.rows.length);
            if (denied) fail(403, 'access_denied');
            await approved(actor, check, grant);
            // Recheck freshness after a slow audit/policy call before disclosure.
            if (page.observedAt && Date.parse(check()) - Date.parse(page.observedAt) > 30000) fail(503, 'unavailable');
            const count = continuation.count + page.rows.length, number = continuation.page + 1;
            const limited = page.nextCursor !== null && (count >= grant.maxRows || number >= grant.maxPages);
            let nextCursor = null;
            if (page.nextCursor !== null && !limited) {
                // Capacity may have changed during I/O. Never return an untracked cursor.
                if (cursors.size >= 256) fail(503, 'unavailable');
                nextCursor = randomBytes(32).toString('base64url');
                cursors.set(nextCursor, { actor: actor.subjectKey, authoritySha256, snapshotId: page.snapshotId,
                    sourceCursor: page.nextCursor, page: number, count, ids: [...continuation.ids, ...page.recordIds],
                    identities: [...continuation.identities, ...page.identities], sources: [...continuation.sources, continuation.sourceCursor],
                    expiresAt: Math.min(Date.parse(grant.expiresAt), Date.parse(check()) + 60000), deadline: performance.now() + 60000 });
            }
            const result = freeze({ status: page.status, rows: page.rows, observedAt: page.observedAt, nextCursor,
                continuation: page.status === 'unavailable' ? 'unavailable' : limited ? 'limit_reached' : nextCursor ? 'more' : 'end' });
            disclosures.set(result, grant);
            return result;
        });
    }
    function authoriseDisclosure(inputActor, result) {
        return bounded(async check => {
            const grant = disclosures.get(result);
            if (!grant) fail(403, 'access_denied');
            disclosures.delete(result);
            await approved(principal(inputActor), check, grant);
            if (result.observedAt && Date.parse(check()) - Date.parse(result.observedAt) > 30000) fail(503, 'unavailable');
        });
    }
    return Object.freeze({ authorise, capabilities, list, authoriseDisclosure });
}
module.exports = { createSignupListService, signupListInput };
