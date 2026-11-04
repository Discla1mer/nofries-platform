'use strict';

// One bounded aggregate document. No request metadata or visitor identifiers are stored.
const PAGES = ['home', 'managed-it', 'roadmap', 'privacy', 'terms', 'login'];
const REFERRERS = ['direct', 'search', 'social', 'other', 'unknown'];
const DEVICES = ['desktop', 'mobile', 'tablet', 'unknown'];
const EVENTS = ['view', 'create-click', 'signup-entry'];
const KEY = 'website-analytics/v1/aggregate.json';
const MAX_BYTES = 65536;
const MAX_COUNT = 1000000000;
const day = date => date.toISOString().slice(0, 10);
const validDate = value => typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z')) && day(new Date(value + 'T00:00:00Z')) === value;
const emptyDay = () => ({ pages: {}, referrers: {}, devices: {}, createClicks: 0, signupEntries: 0 });
const keysValid = (object, allowed) => object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).every(k => allowed.includes(k) && Number.isSafeInteger(object[k]) && object[k] >= 0 && object[k] <= MAX_COUNT);
function validate(doc) {
    if (!doc || Object.keys(doc).sort().join(',') !== 'days,home,start,version' || doc.version !== 1 || !validDate(doc.start) || !Number.isSafeInteger(doc.home) || doc.home < 0 || doc.home > MAX_COUNT || !doc.days || typeof doc.days !== 'object' || Array.isArray(doc.days) || Object.keys(doc.days).length > 90) throw Error('invalid aggregate');
    for (const [date, row] of Object.entries(doc.days)) {
        if (!validDate(date) || !row || Object.keys(row).sort().join(',') !== 'createClicks,devices,pages,referrers,signupEntries' || !keysValid(row.pages, PAGES) || !keysValid(row.referrers, REFERRERS) || !keysValid(row.devices, DEVICES) || !Number.isSafeInteger(row.createClicks) || row.createClicks < 0 || row.createClicks > MAX_COUNT || !Number.isSafeInteger(row.signupEntries) || row.signupEntries < 0 || row.signupEntries > MAX_COUNT) throw Error('invalid aggregate');
    }
    return doc;
}
function validEvent(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || !EVENTS.includes(body.event)) return false;
    if (body.event === 'view') return Object.keys(body).sort().join(',') === 'device,event,page,referrer' && PAGES.includes(body.page) && REFERRERS.includes(body.referrer) && DEVICES.includes(body.device);
    return Object.keys(body).join(',') === 'event';
}
function increment(doc, event, now) {
    validate(doc);
    const today = day(now), cutoff = day(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 89)));
    if (doc.start > today || Object.keys(doc.days).some(d => d > today || d < doc.start)) throw Error('invalid aggregate date');
    for (const d of Object.keys(doc.days)) if (d < cutoff) delete doc.days[d];
    const row = doc.days[today] ||= emptyDay();
    const add = (obj, key) => { obj[key] = (obj[key] || 0) + 1; if (obj[key] > MAX_COUNT) throw Error('count limit'); };
    if (event.event === 'view') { add(row.pages, event.page); add(row.referrers, event.referrer); add(row.devices, event.device); if (event.page === 'home') { doc.home++; if (doc.home > MAX_COUNT) throw Error('count limit'); } }
    else if (event.event === 'create-click') add(row, 'createClicks');
    else add(row, 'signupEntries');
    return validate(doc);
}
function isMissing(error) { return error && error.statusCode === 404 && error.code === 'BlobNotFound'; }
function isConflict(error) { return Boolean(error && (error.statusCode === 412 && error.code === 'ConditionNotMet' || error.statusCode === 409 && error.code === 'BlobAlreadyExists'));  }
async function bytes(stream, signal) {
    if (signal.aborted) { stream.destroy(); throw Error('aggregate timeout'); }
    const abort = () => stream.destroy(Error('aggregate timeout'));
    signal.addEventListener('abort', abort, { once: true });
    const chunks = []; let size = 0;
    try {
        for await (const chunk of stream) { size += chunk.length; if (size > MAX_BYTES) { stream.destroy(); throw Error('aggregate too large'); } chunks.push(chunk); }
        return Buffer.concat(chunks).toString('utf8');
    } finally { signal.removeEventListener('abort', abort); }
}
function createStore(container, clock = () => new Date()) {
    const blob = container.getBlockBlobClient(KEY);
    async function read(signal) {
        await container.getProperties({ abortSignal: signal });
        if (signal.aborted) throw Error('aggregate timeout');
        let response;
        try { response = await blob.download(0, undefined, { abortSignal: signal }); }
        catch (e) { if (isMissing(e)) return null; throw e; }
        const text = await bytes(response.readableStreamBody, signal);
        if (!response.etag) throw Error('missing etag');
        const doc = validate(JSON.parse(text));
        const today = day(clock());
        if (doc.start > today || Object.keys(doc.days).some(d => d > today || d < doc.start)) throw Error('invalid aggregate date');
        return { doc, etag: response.etag };
    }
    async function bounded(work) {
        const controller = new AbortController();
        let timer;
        try {
            return await Promise.race([work(controller.signal), new Promise((_, reject) => {
                timer = setTimeout(() => { controller.abort(); reject(Error('aggregate timeout')); }, 5000);
            })]);
        } finally { clearTimeout(timer); controller.abort(); }
    }
    return {
        async read() { return bounded(async signal => { const result = await read(signal); if (!result) return null;
            const now = clock(), cutoff = day(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 89)));
            for (const date of Object.keys(result.doc.days)) if (date < cutoff) delete result.doc.days[date];
            return result.doc; }); },
        async record(event) {
            return bounded(async signal => {
            if (!validEvent(event)) throw Error('invalid event');
            for (let attempt = 0; attempt < 3; attempt++) {
                if (signal.aborted) throw Error('aggregate timeout');
                const now = clock(), current = await read(signal);
                if (signal.aborted) throw Error('aggregate timeout');
                const doc = current ? current.doc : { version: 1, start: day(now), home: 0, days: {} };
                const data = Buffer.from(JSON.stringify(increment(doc, event, now)));
                if (data.length > MAX_BYTES) throw Error('aggregate too large');
                try { await blob.uploadData(data, { conditions: current ? { ifMatch: current.etag } : { ifNoneMatch: '*' }, blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' }, abortSignal: signal }); return; }
                catch (e) { if (signal.aborted || !isConflict(e) || attempt === 2) throw e; }
            }
            });
        }
    };
}
function productionStore(env, dependencies = {}) {
    if (env.NOFRIES_WEBSITE_ANALYTICS_ENABLED !== 'true') return null;
    const account = String(env.AZURE_STORAGE_ACCOUNT_NAME || '').trim().toLowerCase(), authAccount = String(env.NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT || '').trim().toLowerCase(), name = (env.NOFRIES_AZURE_CONTAINER || 'nofries-workspace').trim();
    if (!/^[a-z0-9]{3,24}$/.test(account) || account === authAccount || !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(name || '') || name.includes('--')) return null;
    const Credential = dependencies.ManagedIdentityCredential || require('@azure/identity').ManagedIdentityCredential;
    const BlobServiceClient = dependencies.BlobServiceClient || require('@azure/storage-blob').BlobServiceClient;
    const credential = env.NOFRIES_MANAGED_IDENTITY_CLIENT_ID ? new Credential({ clientId: env.NOFRIES_MANAGED_IDENTITY_CLIENT_ID }) : new Credential();
    const service = new BlobServiceClient(`https://${account}.blob.core.windows.net`, credential, { retryOptions: { maxTries: 1, tryTimeoutInMs: 4000 } });
    return createStore(service.getContainerClient(name));
}
module.exports = { createStore, productionStore, validEvent, increment };
