'use strict';

// One durable, global budget shared by every email sender. No client identity or
// enquiry content enters this store. Missing state must never reset the budget.
const LIMIT = 20;
const WINDOW_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 5000;
const MAX_BYTES = 1024;
// Bound retained work even when an SDK credential ignores cancellation forever.
const MAX_IN_FLIGHT = 64;
const BLOB_PATH = '/enquiry-rate-limit/public-enquiry-v1.json';

function configuredClient(env) {
    const url = new URL(env.NOFRIES_ENQUIRY_RATE_LIMIT_BLOB_URL || '');
    if (url.protocol !== 'https:' || !/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(url.hostname) ||
        url.port || url.username || url.password || url.search || url.hash || url.pathname !== BLOB_PATH) {
        throw new Error('invalid limiter configuration');
    }
    const { BlockBlobClient } = require('@azure/storage-blob');
    const { ManagedIdentityCredential } = require('@azure/identity');
    const clientId = String(env.NOFRIES_MANAGED_IDENTITY_CLIENT_ID || '').trim();
    const credential = clientId ? new ManagedIdentityCredential({ clientId }) : new ManagedIdentityCredential();
    return new BlockBlobClient(url.href, credential, {
        retryOptions: { maxTries: 1, tryTimeoutInMs: TIMEOUT_MS }
    });
}

function createEnquiryRateLimiter({ env = process.env, client } = {}) {
    let blob = client;
    let active = 0;
    return {
        async reserve() {
            if (active >= MAX_IN_FLIGHT) throw new Error('enquiry_rate_limit_unavailable');
            active += 1;
            const started = performance.now();
            const controller = new AbortController();
            const abortSignal = controller.signal;
            let stream, timer;
            const disposeStream = () => { if (stream && !stream.destroyed) stream.destroy(); };
            const checkDeadline = () => {
                if (abortSignal.aborted || performance.now() - started >= TIMEOUT_MS) throw new Error('deadline');
            };
            const deadline = new Promise((_, reject) => {
                timer = setTimeout(() => {
                    reject(new Error('deadline'));
                    controller.abort();
                    disposeStream();
                }, TIMEOUT_MS);
            });
            const work = (async () => {
                blob ||= configuredClient(env);
                for (let attempt = 0; attempt < 8; attempt += 1) {
                    checkDeadline();
                    const response = await blob.download(0, MAX_BYTES + 1, { abortSignal, maxRetryRequests: 0 });
                    stream = response.readableStreamBody;
                    checkDeadline();
                    let raw = '';
                    for await (const chunk of stream) {
                        checkDeadline();
                        raw += chunk.toString('utf8');
                        if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('oversized state');
                    }
                    checkDeadline();
                    const at = response.date instanceof Date ? response.date.getTime() : NaN;
                    const state = JSON.parse(raw);
                    if (!response.etag || response.etag === '*' || !Number.isSafeInteger(at) ||
                        state.version !== 1 || !Number.isSafeInteger(state.lastObserved) || state.lastObserved > at ||
                        !Array.isArray(state.expires) || state.expires.length > LIMIT ||
                        state.expires.some((x, i) => !Number.isSafeInteger(x) || x < 0 || (i > 0 && x < state.expires[i - 1]))) {
                        throw new Error('invalid state');
                    }
                    const expires = state.expires.filter(x => x > at);
                    if (expires.length === LIMIT) {
                        return { allowed: false, retryAfter: Math.max(1, Math.ceil((expires[0] - at) / 1000)) };
                    }
                    // Service time avoids worker clock skew. Retain permits beyond
                    // the deadline + Date-header precision so delayed writes cannot
                    // shorten the rolling hour. Never refund ambiguous/failed sends.
                    expires.push(at + WINDOW_MS + TIMEOUT_MS + 1000);
                    const body = JSON.stringify({ version: 1, lastObserved: at, expires });
                    try {
                        await blob.upload(body, Buffer.byteLength(body), {
                            abortSignal, conditions: { ifMatch: response.etag },
                            blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' }
                        });
                        checkDeadline();
                        return { allowed: true };
                    } catch (error) {
                        // Only a definite CAS conflict is retried. A timeout may
                        // already have reserved capacity: fail closed in that case.
                        if (error.statusCode !== 412 || error.code !== 'ConditionNotMet') throw error;
                    }
                }
                throw new Error('contention');
            })().finally(() => {
                active -= 1;
                disposeStream();
            });
            try {
                // Observe both outcomes, including rejection/completion after the
                // caller has received 503. Late work can never authorise email.
                return await Promise.race([work, deadline]);
            } catch (_) {
                // SDK errors can include URLs, headers and response bodies.
                throw new Error('enquiry_rate_limit_unavailable');
            } finally {
                clearTimeout(timer);
                controller.abort();
                disposeStream();
            }
        }
    };
}

module.exports = { createEnquiryRateLimiter, LIMIT, WINDOW_MS, TIMEOUT_MS, MAX_IN_FLIGHT };
