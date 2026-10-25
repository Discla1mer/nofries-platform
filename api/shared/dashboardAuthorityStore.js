'use strict';

const { TextDecoder, isDeepStrictEqual } = require('node:util');
const { normaliseOperatorIssuanceProof } = require('./appLifecycle/dashboardOnboardingDomain');
const { fields, copy, freeze, uuid, digest } = require('./appLifecycle/dashboardRuntimeRecords');

function normaliseIssuanceProof(input) {
    const value = copy(input, 16384);
    const customer = value && ['customer_dashboard_issuance', 'customer_retained_read_issuance'].includes(value.kind);
    const proof = normaliseOperatorIssuanceProof(customer ? { ...value, kind: 'operator_dashboard_issuance' } : value);
    return customer ? freeze({ ...proof, kind: value.kind }) : proof;
}

const LIMIT = 16384;
const MISSING = Symbol('missing');
const unavailable = () => new Error('dashboard_authority_store_unavailable');

// The caller supplies two separately authorized containers. The runtime may
// create proofs but has only read access to the independently maintained epoch.
function createDashboardAuthorityStore({ proofContainer, epochContainer, instanceId }) {
    try { uuid(instanceId); } catch (_) { throw unavailable(); }
    async function bounded(work) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        try { return await work(controller.signal); }
        catch (_) { throw unavailable(); }
        finally { clearTimeout(timer); }
    }
    async function read(blob, signal, missingAllowed) {
        let response;
        try { response = await blob.download(0, LIMIT + 1, { abortSignal: signal }); }
        catch (error) {
            if (missingAllowed && error && error.statusCode === 404 && error.code === 'BlobNotFound') return MISSING;
            throw error;
        }
        const stream = response.readableStreamBody;
        if (!stream || !Number.isSafeInteger(response.contentLength) ||
            response.contentLength <= 0 || response.contentLength > LIMIT) {
            if (stream && typeof stream.destroy === 'function') stream.destroy();
            throw unavailable();
        }
        const chunks = []; let size = 0;
        const abort = () => stream.destroy(unavailable());
        signal.addEventListener('abort', abort, { once: true });
        try {
            if (signal.aborted) throw unavailable();
            for await (const chunk of stream) {
                if (signal.aborted) throw unavailable();
                const bytes = Buffer.from(chunk); size += bytes.length;
                if (size > LIMIT) throw unavailable();
                chunks.push(bytes);
            }
            if (size !== response.contentLength) throw unavailable();
            return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        } finally { signal.removeEventListener('abort', abort); stream.destroy(); }
    }
    const proofStore = Object.freeze({
        async createOriginalProof(sessionSha256, input) {
            return bounded(async signal => {
                digest(sessionSha256);
                const proof = normaliseIssuanceProof(input);
                if (proof.sessionSha256 !== sessionSha256 || proof.instanceId !== instanceId) throw unavailable();
                const bytes = Buffer.from(JSON.stringify(proof));
                const blob = proofContainer.getBlockBlobClient(`dashboard-proofs/${sessionSha256}.json`);
                try {
                    await blob.uploadData(bytes, {
                        abortSignal: signal, conditions: { ifNoneMatch: '*' },
                        blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' }
                    });
                } catch (error) {
                    if (!error || ![409, 412].includes(error.statusCode)) throw error;
                    // A committed write can lose its response. Reconcile only an
                    // identical immutable proof; never replace an existing one.
                    const existing = normaliseIssuanceProof(await read(blob, signal, false));
                    if (!isDeepStrictEqual(existing, proof)) throw unavailable();
                }
            });
        },
        async readOriginalProof(sessionSha256) {
            return bounded(async signal => {
                digest(sessionSha256);
                const raw = await read(proofContainer.getBlockBlobClient(`dashboard-proofs/${sessionSha256}.json`), signal, true);
                if (raw === MISSING) return null;
                const proof = normaliseIssuanceProof(raw);
                if (proof.sessionSha256 !== sessionSha256 || proof.instanceId !== instanceId) throw unavailable();
                return proof;
            });
        }
    });
    return Object.freeze({ proofStore,
        async readExternalRuntimeEpoch() {
            return bounded(async signal => {
                const value = fields(copy(await read(epochContainer.getBlockBlobClient(`runtime-epochs/${instanceId}.json`), signal, false), LIMIT),
                    ['instanceId', 'restoreEpoch']);
                uuid(value.instanceId); uuid(value.restoreEpoch);
                if (value.instanceId !== instanceId) throw unavailable();
                return freeze(value);
            });
        }
    });
}

module.exports = { createDashboardAuthorityStore };
