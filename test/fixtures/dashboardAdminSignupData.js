'use strict';

// Synthetic records produced by the existing domain services, then read through
// the actual Blob adapters. No Azure connection or real population is used.
const { Readable } = require('node:stream');
const { createStarterAccountAllocator, starterAccountKey } = require('../../api/shared/customerSignup/starterAccountAllocation');
const { createStarterSetupDetails, starterSetupKey } = require('../../api/shared/customerSignup/starterSetupDetails');
const { AzureStarterAccountStore } = require('../../api/shared/customerSignup/azureStarterAccountStore');
const { AzureStarterSetupStore } = require('../../api/shared/customerSignup/azureStarterSetupStore');
const { createSignupDataAdapter } = require('../../api/shared/dashboardAdmin/signupDataAdapter');

const START = Date.parse('2026-10-01T10:00:00.000Z');
const uid = n => '72000000-0000-4000-8000-' + String(n).padStart(12, '0');
const SUBJECT = uid(1) + ':' + uid(2);
const clone = value => JSON.parse(JSON.stringify(value));

async function fixture(provider = 'legacy', { accountType = 'consultant', seed = 0,
    email = seed ? 'synthetic-signup-' + seed + '@example.invalid' : 'synthetic-signup@example.invalid' } = {}) {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 1000000) throw new Error('invalid synthetic fixture seed');
    let time = START + 1000, serial = 10 + seed, sealed = false, etag = '"synthetic-etag"', duringRead = null;
    const subjectKey = uid(1 + seed) + ':' + uid(2 + seed);
    const blobs = new Map(), reads = [], writes = [];
    const container = { getBlockBlobClient(key) { return {
        async download() {
            reads.push(key);
            if (duringRead) await duringRead(key);
            if (!blobs.has(key)) throw Object.assign(new Error('synthetic missing'), { statusCode: 404, code: 'BlobNotFound' });
            const body = Buffer.from(JSON.stringify(blobs.get(key)));
            return { etag, contentLength: body.length, readableStreamBody: Readable.from([body]) };
        },
        async uploadData(body) {
            if (sealed) throw new Error('UNEXPECTED_SIGNUP_WRITE');
            writes.push(key); blobs.set(key, JSON.parse(body.toString()));
        }
    }; } };
    const accountStore = new AzureStarterAccountStore(container), setupStore = new AzureStarterSetupStore(container);
    const accounts = createStarterAccountAllocator({ store: accountStore, now: () => time, newId: () => uid(serial++),
        readActivation: async () => { throw new Error('unused'); }, captureOwner: async () => { throw new Error('unused'); } });
    const common = { schemaVersion: 1, requestId: uid(3 + seed), organisationName: 'Synthetic Signup Organisation' + (seed ? ' ' + seed : ''),
        email, accountType };
    const proof = provider === 'external' ? { ...common, source: 'external-id-signup', subjectKey,
        providerKey: 'a'.repeat(64), authenticationSha256: 'b'.repeat(64), createdAt: START,
        verifiedAt: START, expiresAt: START + 3600000 } : { ...common, status: 'verified', codeHash: null,
        attempts: 0, createdAt: START, codeExpiresAt: START + 600000, expiresAt: START + 86400000, verifiedAt: START + 1000 };
    await accounts.reserveInitial(proof);
    time += 1000;
    const detailsOptions = { accounts, store: setupStore, now: () => time, newId: () => uid(serial++),
        framework: async () => ({ moduleId: 'cyber_security', profileId: 'synthetic-cyber', version: '1.0', scoringVersion: '1.0' }) };
    const setupService = createStarterSetupDetails(detailsOptions);
    const details = { name: 'Private Synthetic Representative', role: 'Owner', address: 'Private Synthetic Street',
        registrationId: 'PRIVATE-SYNTHETIC-ID', authorityConfirmed: true };
    const setup = await setupService.save(proof, details);
    const accountKey = starterAccountKey(proof.email), accountPath = 'customer-starter/' + accountKey + '.json';
    const account = clone(blobs.get(accountPath)), slot = account.organisations[0];
    const setupPath = 'customer-starter/' + starterSetupKey(slot.organisationId) + '.json';
    const entry = { recordId: 'synthetic-record' + (seed ? '-' + seed : ''), binding: { provider, tenantId: slot.tenantId,
        organisationId: slot.organisationId, accountId: account.accountId, setupRequestId: account.setupRequestId,
        subjectKey: provider === 'external' ? subjectKey : null } };
    const reference = { entry, accountKey }, clock = () => new Date(time).toISOString();
    const options = { provider, sourceReferences: [reference], accountStore, setupStore, clock };
    time += 1000; sealed = true; reads.length = 0; writes.length = 0;
    return { options, entry, reference, account, setup, proof, details, blobs, reads, writes, accountPath, setupPath,
        accountStore, setupStore, clock, read: createSignupDataAdapter(options),
        setTime: value => { time = value; }, setEtag: value => { etag = value; },
        duringRead: value => { duringRead = value; },
        async renewedSetup() {
            blobs.delete(setupPath); sealed = false;
            const renewed = { ...proof, requestId: uid(999 + seed) };
            const saved = await setupService.save(renewed, details);
            sealed = true; reads.length = 0; writes.length = 0;
            return saved;
        }
    };
}

module.exports = { fixture, START, SUBJECT, uid, clone };
