'use strict';
// External SDK fixtures; real application provider verification and admission
// ports only; these do not establish live mailbox/MFA acceptance. Application
// handlers, journal, registration, dashboard runtime and permissions are genuine.
const { Readable } = require('node:stream');
const crypto = require('node:crypto');
const request = require('supertest');
const { createInvitation } = require('../../api/shared/customerSignup/invitationAcceptance');
const { subjectHash, scheduleArchiveKey, termsOfferKey } = require('../../api/shared/customerSignup/customerAuthority');
const { createProductionApplication } = require('../../lib/productionApplication');
const { preparationFixture } = require('./customerPreparationFixture');
const { activationKey, activationReferenceKey, activationReference } = require('../../api/shared/customerSignup/customerActivation');
const uid = n => `60000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const clone = value => JSON.parse(JSON.stringify(value));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function container() {
    const records = new Map(), versions = new Map(); let serial = 0;
    return { records, async getProperties() { return {}; },
        listBlobsFlat({ prefix, abortSignal }) {
            return { async *byPage({ continuationToken, maxPageSize }) {
                abortSignal?.throwIfAborted();
                const keys = [...records.keys()].filter(key => key.startsWith(prefix)).sort();
                let offset = continuationToken === undefined ? 0 : Number(continuationToken);
                if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxPageSize) || maxPageSize < 1) {
                    throw new Error('Invalid synthetic Blob page request');
                }
                do {
                    abortSignal?.throwIfAborted();
                    const names = keys.slice(offset, offset + maxPageSize); offset += names.length;
                    yield { segment: { blobItems: names.map(name => ({ name })) },
                        continuationToken: offset < keys.length ? String(offset) : '' };
                } while (offset < keys.length);
            } };
        }, getBlockBlobClient(key) {
        const missing = () => Object.assign(new Error('synthetic missing blob'), { statusCode: 404, code: 'BlobNotFound' });
        return {
            async download() { if (!records.has(key)) throw missing(); const bytes = records.get(key);
                return { contentLength: bytes.length, etag: versions.get(key) || '"0"', readableStreamBody: Readable.from([bytes]) }; },
            async uploadData(bytes, options) {
                if (options?.conditions?.ifNoneMatch === '*' && records.has(key)) throw Object.assign(new Error('exists'), { statusCode: 412, code: 'ConditionNotMet' });
                if (options?.conditions?.ifMatch && options.conditions.ifMatch !== (versions.get(key) || '"0"')) throw Object.assign(new Error('changed'), { statusCode: 412, code: 'ConditionNotMet' });
                records.set(key, Buffer.from(bytes)); versions.set(key, JSON.stringify(String(++serial)));
            },
            async delete() { records.delete(key); }, async deleteIfExists() { records.delete(key); },
            getBlobLeaseClient(id = crypto.randomUUID()) { return {
                async acquireLease() { if (!records.has(key)) throw missing(); return { leaseId: id }; }, async releaseLease() {}
            }; }
        };
    } };
}
function signupSql() {
    const registrations = new Map(), receipts = new Map(), organisations = new Set(), preparations = new Map();
    return { registrations, receipts, organisations, preparations, async end() {}, async connect() {
        return { release() {}, async query(sql, params = []) {
            let rows = [];
            if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.startsWith('SET LOCAL') || sql.includes('set_config')) return { rows };
            // This small port simulation retains the historical SQL layout.
            // Native fixtures exercise the additive scoped registration shape.
            if (sql.includes('FROM pg_catalog.pg_attribute')) return { rows };
            if (sql.startsWith('SELECT organisation_id FROM nofries.dashboard_organisations')) {
                rows = organisations.has(`${params[0]}|${params[1]}`) ? [{ organisation_id: params[1] }] : [];
            } else if (sql.startsWith('SELECT * FROM nofries.dashboard_')) {
                const table = sql.match(/FROM nofries\.(\w+)/)[1], key = `${params[0]}|${params[1]}`;
                const prepared = table === 'dashboard_tenants'
                    ? [...preparations.values()].find(value => value.approval.scope.tenantId === params[0]) : preparations.get(key);
                rows = clone(prepared?.tables[table] || []);
                if (table === 'dashboard_organisations' && !organisations.has(key)) rows = [];
                if (table === 'dashboard_operation_receipts') rows = rows.filter(row => row.operation_id === params[2]);
            } else if (sql.includes('nofries.signup_acceptance_receipts')) {
                if (sql.trimStart().startsWith('INSERT')) {
                    const value = JSON.parse(params[12]); const key = `${params[0]}|${params[1]}|${params[2]}`;
                    if (!receipts.has(key)) { receipts.set(key, value); rows = [{ payload: clone(value) }]; }
                } else rows = [...receipts.values()].filter(v => v.receipt.tenantId === params[0] && v.receipt.organisationId === params[1] &&
                    (sql.includes('AND invitation_id=') ? v.receipt.invitationId : v.receipt.receiptId) === params[2]).map(payload => ({ payload: clone(payload) }));
            } else if (sql.includes('nofries.signup_registrations')) {
                const key = params[1];
                if (sql.startsWith('INSERT')) { if (!registrations.has(key)) registrations.set(key, { identity_tenant_id: params[0], subject_key: key, revision: '0', payload: JSON.parse(params[2]) }); }
                else if (sql.startsWith('UPDATE')) {
                    const before = registrations.get(key);
                    if (before && String(before.revision) === String(params[4])) {
                        const value = { ...before, revision: String(params[2]), payload: JSON.parse(params[3]) };
                        registrations.set(key, value); rows = [clone(value)];
                    }
                } else rows = registrations.has(key) ? [clone(registrations.get(key))] : [];
            } else throw new Error('Unexpected synthetic SQL: ' + sql.slice(0, 100));
            return { rows, rowCount: rows.length };
        } };
    } };
}
function customerProductionHarness({ pool = signupSql(), identity, instanceId = uid(4), restoreEpoch = uid(5), now = Date.parse('2026-09-19T00:00:00.000Z'), adminSubject = null, starter = false, organisationSetup = starter, customerSignup = true, customerClientId = null, external = false, configureExternal = null, applicationFactory = createProductionApplication } = {}) {
    identity ||= { identityTenantId: uid(1), oid: uid(3), audience: uid(2), policyId: 'customer-policy', policyRevision: 0 };
    const state = { now, oid: identity.oid, acrs: ['c1'], delivered: [], authRequests: [], policyEnabled: true, containers: new Map(), blobServiceUrls: [], blobContainerClients: [] };
    const getContainer = (name, account) => {
        account ||= ['customer-authority','starter-authority','external-starter-authority'].includes(name) ? env.AZURE_STORAGE_ACCOUNT_NAME : env.NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT;
        const key = account + '/' + name;
        if (!state.containers.has(key)) state.containers.set(key, container());
        return state.containers.get(key);
    };
    const env = { NODE_ENV: 'production', NOFRIES_REQUIRE_AUTH: 'true', NOFRIES_BROWSER_AUTH_MODE: 'entra_bff',
        NOFRIES_TRUSTED_AUTH_PROXY: 'false', NOFRIES_BROWSER_SESSION_STORE: 'azure',
        NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT: 'syntheticauth123', AZURE_STORAGE_ACCOUNT_NAME: 'syntheticdata123',
        NOFRIES_PUBLIC_URL: 'https://nofries.example.test', NOFRIES_ENTRA_CLIENT_SECRET: 'synthetic-secret',
        NOFRIES_SCOPE_SIGNING_SECRET: 's'.repeat(32), NOFRIES_PROSPECT_SIGNING_SECRET: 'p'.repeat(32),
        NOFRIES_ENTRA_TENANT_ID: identity.identityTenantId, NOFRIES_ENTRA_CLIENT_ID: identity.audience,
        NOFRIES_ALLOWED_SUBJECTS: `${identity.identityTenantId}:${uid(99)}`, NOFRIES_DASHBOARD_RUNTIME_ENABLED: 'true',
        NOFRIES_DASHBOARD_INSTANCE_ID: instanceId, NOFRIES_DASHBOARD_IDENTITY_POLICY_ID: identity.policyId,
        NOFRIES_DASHBOARD_IDENTITY_POLICY_REVISION: String(identity.policyRevision), NOFRIES_DASHBOARD_PROOF_CONTAINER: 'dashboard-proofs',
        NOFRIES_DASHBOARD_EPOCH_CONTAINER: 'dashboard-epochs', NOFRIES_POSTGRES_HOST: 'synthetic.postgres.database.azure.com',
        NOFRIES_POSTGRES_DATABASE: 'nofries', NOFRIES_POSTGRES_USER: 'nofries_app',
        NOFRIES_CUSTOMER_SIGNUP_ENABLED: String(customerSignup), NOFRIES_CUSTOMER_AUTHORITY_CONTAINER: 'customer-authority',
        NOFRIES_CUSTOMER_MFA_POLICY_ID: '1bf6dbaa-b7f2-4571-a490-e6117f72b284', NOFRIES_CUSTOMER_MFA_CONTEXT: 'c1',
        ...(adminSubject ? { NOFRIES_ADMIN_SUBJECTS: adminSubject } : {}) };
    if (customerClientId) Object.assign(env, { NOFRIES_CUSTOMER_ENTRA_CLIENT_ID: customerClientId, NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET: 'synthetic-customer-secret' });
    if (starter) Object.assign(env, { NOFRIES_STARTER_SIGNUP_ENABLED: 'true', NOFRIES_STARTER_AUTHORITY_CONTAINER: 'starter-authority',
        NOFRIES_ORGANISATION_SETUP_ENABLED: 'true', NOFRIES_DASHBOARD_NCSC_ENABLED: 'true', NOFRIES_PUBLIC_URL: 'https://nofries.nz',
        RESEND_API_KEY: 'synthetic-test-only', NOFRIES_SCOPE_EMAIL_FROM: 'synthetic@nofries.example.test' });
    if (organisationSetup) Object.assign(env, { NOFRIES_ORGANISATION_SETUP_ENABLED: 'true', NOFRIES_PUBLIC_URL: 'https://nofries.nz',
        RESEND_API_KEY: 'synthetic-test-only', NOFRIES_SCOPE_EMAIL_FROM: 'synthetic@nofries.example.test' });
    getContainer('dashboard-epochs').records.set(`runtime-epochs/${instanceId}.json`, Buffer.from(JSON.stringify({ instanceId, restoreEpoch })));
    const dependencies = {
        ManagedIdentityCredential: class { async getToken() { return { token: 'synthetic-not-a-real-token' }; } },
        BlobServiceClient: class {
            constructor(url) { state.blobServiceUrls.push(url); this.account = new URL(url).hostname.split('.')[0]; }
            getContainerClient(name) { state.blobContainerClients.push({ name, account: this.account }); return getContainer(name, this.account); }
        },
        createPostgresPool: () => pool, clock: () => new Date(starter || organisationSetup ? Date.now() + (state.clockOffset || 0) : state.now).toISOString(),
        cryptoProvider: { async generatePkceCodes() { return { verifier: 'v'.repeat(43), challenge: 'c'.repeat(43) }; } },
        clientApplication: {
            async getAuthCodeUrl(input) {
                state.authRequests.push(clone(input));
                const url = new URL(`https://login.microsoftonline.com/${env.NOFRIES_ENTRA_TENANT_ID}/oauth2/v2.0/authorize`);
                for (const [key, value] of Object.entries({ client_id: input.redirectUri.endsWith('/customer-auth/callback') && customerClientId || env.NOFRIES_ENTRA_CLIENT_ID, redirect_uri: input.redirectUri,
                    response_mode: input.responseMode, state: input.state, nonce: input.nonce, code_challenge: input.codeChallenge,
                    code_challenge_method: input.codeChallengeMethod })) url.searchParams.set(key, value);
                return url.href;
            },
            async acquireTokenByCode(input) { return { idTokenClaims: {
                iss: `https://login.microsoftonline.com/${env.NOFRIES_ENTRA_TENANT_ID}/v2.0`, aud: state.tokenAudience || (input.redirectUri.endsWith('/customer-auth/callback') && customerClientId || env.NOFRIES_ENTRA_CLIENT_ID),
                tid: env.NOFRIES_ENTRA_TENANT_ID, oid: state.oid, nonce: input.nonce, exp: Math.floor(state.now / 1000) + 3600,
                email: 'untrusted-display@example.test', acrs: state.acrs
            }, account: { homeAccountId: 'synthetic' } }; },
            getTokenCache() { return { async removeAccount() {} }; }
        },
        async fetch(url, options) {
            if ((starter || organisationSetup) && url === 'https://api.resend.com/emails') {
                const body = JSON.parse(options.body);
                state.delivered.push({ kind: body.subject === 'Verify your email for No Fries' ? 'code' : 'member_invitation', ...body });
                if (state.failMemberDelivery && body.subject !== 'Verify your email for No Fries') throw new Error('synthetic ambiguous delivery');
                return new Response('{}', { status: 200 });
            }
            if ((starter || organisationSetup) && url.startsWith('https://graph.microsoft.com/v1.0/users?')) return new Response(JSON.stringify({ value: state.directoryUsers || [] }));
            if (starter && url === 'https://graph.microsoft.com/v1.0/invitations') {
                const body = JSON.parse(options.body); state.delivered.push({ kind: 'invitation', ...body });
                state.guest = { id: state.oid, mail: body.invitedUserEmailAddress, userType: 'Guest' };
                return new Response(JSON.stringify({ status: 'PendingAcceptance', invitedUser: { id: state.oid } }));
            }
            if (starter && url.startsWith('https://graph.microsoft.com/v1.0/users/')) return new Response(JSON.stringify(state.guest));
            if (url !== `https://graph.microsoft.com/v1.0/identity/conditionalAccess/policies/${env.NOFRIES_CUSTOMER_MFA_POLICY_ID}`) throw new Error('Unexpected Graph request');
            const policy = { id: env.NOFRIES_CUSTOMER_MFA_POLICY_ID, displayName: 'No Fries - Customer signup MFA context',
                state: state.policyEnabled ? 'enabled' : 'disabled',
                conditions: { users: { includeUsers: ['All'], excludeUsers: [], excludeGroups: [], excludeRoles: [] },
                    applications: { includeApplications: [], includeUserActions: [], includeAuthenticationContextClassReferences: ['c1'], excludeApplications: [] },
                    clientAppTypes: ['all'], signInRiskLevels: [], userRiskLevels: [], servicePrincipalRiskLevels: [] },
                grantControls: { builtInControls: ['mfa'], operator: 'OR' } };
            if (state.changePolicy) state.changePolicy(policy);
            return new Response(JSON.stringify(policy), { status: 200 });
        }
    };
    if (external) {
        const profile = { kind: 'external-id', tenantId: uid(101), clientId: uid(102), authority: 'https://synthetic-customer.ciamlogin.com/',
            issuer: `https://${uid(101)}.ciamlogin.com/${uid(101)}/v2.0`,
            authorizationEndpoint: `https://synthetic-customer.ciamlogin.com/${uid(101)}/oauth2/v2.0/authorize` };
        state.externalOid = uid(103); state.externalEmail = 'synthetic@gmail.com'; state.externalAuthenticationAllowed = true;
        dependencies.externalCustomer = { identityProvider: profile, userFlowId: 'SyntheticEmailPassword', allowNewSignup: true,
            identityPolicy: { policyId: 'synthetic-managed-customer-policy', policyRevision: 1, issuer: profile.issuer,
                identityTenantId: profile.tenantId, audience: profile.clientId }, starterAuthorityContainer: 'external-starter-authority',
            client: { clientSecret: 'synthetic-external-secret', clientApplication: {
                async getAuthCodeUrl(input) {
                    const url = new URL(profile.authorizationEndpoint);
                    for (const [key, value] of Object.entries({ client_id: profile.clientId, redirect_uri: input.redirectUri,
                        response_mode: input.responseMode, state: input.state, nonce: input.nonce, code_challenge: input.codeChallenge,
                        code_challenge_method: input.codeChallengeMethod })) url.searchParams.set(key, value);
                    return url.href;
                },
                async acquireTokenByCode(input) {
                    if (!state.externalAuthenticationAllowed) throw new Error('synthetic provider denied');
                    return { idTokenClaims: { aud: profile.clientId, tid: profile.tenantId,
                    oid: state.externalOid, iss: profile.issuer, nonce: input.nonce, exp: Math.floor(Date.now() / 1000) + 3600,
                    email: state.externalEmail, ...(state.externalClaims || {}) }, account: { localAccountId: state.externalOid, tenantId: profile.tenantId } }; },
                getTokenCache() { return { async removeAccount() {} }; }
            } }
        };
    }
    const termsText = starter ? require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../../docs/legal/drafts/nf-dashboard-2026-09-r2.txt'), 'utf8')
        : 'Synthetic test terms only. This fixture is not an agreement.';
    const termsVersion = starter ? 'nf-dashboard-2026-09-r2' : 'synthetic-v1', termsDigest = sha(termsText);
    getContainer('customer-authority').records.set(`customer-terms/${termsDigest}.json`, Buffer.from(JSON.stringify({ termsText, termsVersion, termsDigest })));
    function prepareUser(user) {
        if (!pool.preparations) throw new Error('Native tests must prepare through the genuine operator route');
        const current = user.authority, prepared = preparationFixture(current, identity, state.now,
            (adminSubject || `${identity.identityTenantId}:${uid(99)}`).split(/[;,\n]/)[0]);
        const key = `${current.tenantId}|${current.organisationId}`;
        pool.organisations.add(key); pool.preparations.set(key, prepared);
        const saved = getContainer('customer-authority').records;
        saved.set(activationKey(prepared.approval.activationId), Buffer.from(JSON.stringify(prepared.approval)));
        saved.set(activationReferenceKey(current), Buffer.from(JSON.stringify(activationReference(prepared.approval))));
        return prepared;
    }
    function addUser({ oid = identity.oid, email = `${oid}@example.test`, tenantId = 'logical-customer', organisationId = 'org-one', bindingId = null,
        scheduleText: requestedScheduleText = null, prepared = true } = {}) {
        // This SQL-only fixture can explicitly represent an already prepared
        // organisation. The native suite must create it through the real route.
        if (prepared && pool.organisations) pool.organisations.add(`${tenantId}|${organisationId}`);
        const subjectKey = `${identity.identityTenantId}:${oid}`;
        const scheduleId = `synthetic-schedule-${organisationId}`;
        const scheduleText = requestedScheduleText ?? `Synthetic schedule for ${organisationId}. Not a customer agreement.`;
        const scheduleDigest = sha(scheduleText);
        const invitation = createInvitation({ email, tenantId, organisationId, identityPolicyId: identity.policyId,
            termsVersion, termsDigest, scheduleId, scheduleDigest,
            mfaRequired: true, createdAt: state.now, expiresAt: state.now + 86400000 }, { now: () => state.now });
        const record = { schemaVersion: 2, subjectKey, email: invitation.record.expectedEmail, revision: 0, status: 'active',
            invitationDigest: invitation.record.tokenDigest, invitationId: invitation.record.invitationId, tenantId, organisationId,
            termsVersion, termsDigest, scheduleId, scheduleDigest, bindingId, expiresAt: state.now + 86400000 };
        const key = `customer-subjects/${subjectHash(subjectKey)}.json`;
        const save = () => getContainer('customer-authority').records.set(key, Buffer.from(JSON.stringify(record)));
        save();
        const invitationKey = `browser-auth/customer-signup/invitations/${invitation.record.tokenDigest}.json`;
        getContainer('nofries-browser-auth').records.set(invitationKey, Buffer.from(JSON.stringify(invitation.record)));
        const offer = { schemaVersion: 1, status: 'active', tenantId, organisationId,
            scheduleId, scheduleDigest, termsVersion, termsDigest,
            effectiveAt: state.now - 1000, expiresAt: state.now + 86400000 };
        const offerKey = termsOfferKey(tenantId, organisationId);
        const saveOffer = () => getContainer('customer-authority').records.set(offerKey, Buffer.from(JSON.stringify(offer)));
        const scheduleKey = scheduleArchiveKey(scheduleId, scheduleDigest);
        getContainer('customer-authority').records.set(scheduleKey,
            Buffer.from(JSON.stringify({ schemaVersion: 1, scheduleId, scheduleText, scheduleDigest })));
        saveOffer();
        const user = { ...invitation, authority: record, save, offer, saveOffer, scheduleId, scheduleText, scheduleDigest,
            scheduleArchiveKey: scheduleKey,
            withdrawOffer() { offer.status = 'withdrawn'; saveOffer(); },
            deleteBootstrap: () => getContainer('nofries-browser-auth').records.delete(invitationKey) };
        if (prepared && pool.preparations) prepareUser(user);
        return user;
    }
    // Configure external SDK/credential boundaries before the genuine launcher;
    // never replace signup, session, admission or logout handlers.
    if (configureExternal) configureExternal({ env, dependencies, state });
    if (typeof applicationFactory !== 'function') throw new Error('Synthetic application factory is required');
    let app = applicationFactory(env, dependencies);
    function recomposeWithApplication(replacementFactory, { pool: replacementPool = pool } = {}) {
        if (typeof replacementFactory !== 'function' || !replacementPool || typeof replacementPool.connect !== 'function') {
            throw new Error('Synthetic reconstruction requires an application factory and database pool');
        }
        // Recovery compatibility tests switch actual source factories over the
        // same provider/Blob state. No application-owned handler is substituted.
        applicationFactory = replacementFactory;
        pool = replacementPool;
        app = applicationFactory(env, dependencies);
        return app;
    }
    function recomposeWithPool(replacementPool) {
        if (!replacementPool || replacementPool === pool || typeof replacementPool.connect !== 'function') {
            throw new Error('Synthetic reconstruction requires a distinct database pool');
        }
        // Rebuild genuine application-owned handlers over retained synthetic
        // provider/Blob state; this is not an OS restart or live provider proof.
        pool = replacementPool;
        app = applicationFactory(env, dependencies);
        return app;
    }
    const sameOrigin = call => call.set('Origin', env.NOFRIES_PUBLIC_URL).set('Sec-Fetch-Site', 'same-origin');
    async function login(user, { bootstrap = true, setupCookie = '', html = false } = {}) {
        let cookie = setupCookie;
        if (bootstrap) {
            const start = await sameOrigin(request(app).post('/api/customer-signup/bootstrap')).send({ invitationToken: user.invitationToken });
            if (start.status !== 204) throw new Error('Bootstrap failed: ' + start.status);
            cookie = start.headers['set-cookie'][0].split(';')[0];
        }
        state.oid = user.authority.subjectKey.split(':')[1];
        const login = await request(app).get('/api/customer-auth/login').set('Cookie', cookie);
        if (login.status !== 302) throw new Error('Login failed: ' + JSON.stringify(login.body));
        const tx = login.headers['set-cookie'][0].split(';')[0];
        const result = await request(app).post('/api/customer-auth/callback').set('Cookie', tx).set('Accept', html ? 'text/html' : 'application/json').type('form')
            .send({ state: new URL(login.headers.location).searchParams.get('state'), code: 'synthetic-code' });
        return { response: result, cookie: result.headers['set-cookie']?.[0]?.split(';')[0] || '', tx };
    }
    async function consent(cookie) {
        const before = await request(app).get('/api/customer-signup/state').set('Cookie', cookie);
        const response = await sameOrigin(request(app).post('/api/customer-signup/terms')).set('Cookie', cookie)
            .set('X-CSRF-Token', before.body.csrfToken || 'missing').send({ accepted: true, termsVersion, termsDigest,
                ...(before.body.state?.scheduleId ? { scheduleId: before.body.state.scheduleId,
                    scheduleDigest: before.body.state.scheduleDigest } : {}) });
        return { before, response };
    }
    async function loginExternal(setupCookie = '') {
        const started = await request(app).get('/api/external-customer-auth/login').set('Cookie', setupCookie);
        if (started.status !== 302) throw new Error('Synthetic external handoff failed: ' + JSON.stringify(started.body));
        const response = await request(app).post('/api/external-customer-auth/callback')
            .set('Cookie', started.headers['set-cookie'][0].split(';')[0]).type('form')
            .send({ code: 'synthetic-managed-code', state: new URL(started.headers.location).searchParams.get('state') });
        return { response, cookie: response.headers['set-cookie']?.[0]?.split(';')[0] || '' };
    }
    async function consentExternal(cookie) {
        const before = await request(app).get('/api/external-customer-signup/state').set('Cookie', cookie);
        const offered = before.body.state;
        const response = await sameOrigin(request(app).post('/api/external-customer-signup/terms')).set('Cookie', cookie)
            .set('X-CSRF-Token', before.body.csrfToken || 'missing').send({ accepted: true,
                termsVersion: offered?.termsVersion, termsDigest: offered?.termsDigest,
                scheduleId: offered?.scheduleId, scheduleDigest: offered?.scheduleDigest });
        return { before, response };
    }
    return { get app() { return app; }, get pool() { return pool; }, recomposeWithPool, recomposeWithApplication,
        env, dependencies, state, getContainer, addUser, prepareUser, login, consent, loginExternal, consentExternal,
        sameOrigin, termsText, termsVersion, termsDigest };
}
module.exports = { customerProductionHarness, uid, signupSql };
