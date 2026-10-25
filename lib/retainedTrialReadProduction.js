'use strict';

const { BrowserAuthError, createBrowserAuthService, clearExternalCustomerTransactionCookie } = require('../api/shared/browserAuth');
const { createDashboardCustomerSession } = require('../api/shared/dashboardOperatorSession');
const { createRetainedTrialCustomerIdentityPolicy } = require('../api/shared/customerSignup/retainedTrialCustomerIdentityPolicy');
const { createRetainedTrialAssessmentReader, readRetainedTrialOwner } = require('../api/shared/customerSignup/retainedTrialAssessmentReader');
const { hash, normaliseSessionRow } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { createPostgresDashboardRuntimeRepository } = require('../api/shared/appLifecycle/postgresDashboardRuntimeRepository');

// Explicit server composition only. No environment flag, request hint, provider
// registration, new credential, store or runtime grant is introduced here.
function createRetainedTrialReadProduction({ env, dashboard, records, accountStore, database,
    profile, rawProfile, identityPolicy, client, authentication }) {
    const now = () => Date.parse(dashboard.clock());
    const policy = createRetainedTrialCustomerIdentityPolicy({ profile, records, accountStore, ...authentication, now });
    const auth = { env, store: dashboard.browserAuthOptions.store,
        ...Object.fromEntries(['cryptoProvider', 'randomBytes'].filter(key => Object.hasOwn(dashboard.browserAuthOptions, key))
            .map(key => [key, dashboard.browserAuthOptions[key]])),
        customerPolicy: policy, customerIdentityProvider: rawProfile, customerTransport: 'external', customerPurpose: 'retained_read',
        ...(Object.hasOwn(client, 'clientApplication') ? { clientApplication: client.clientApplication } : {}),
        ...(Object.hasOwn(client, 'clientAssertion') ? { clientAssertion: client.clientAssertion } : {}) };
    const session = createDashboardCustomerSession({ browserAuthOptions: auth, identityPolicy,
        proofStore: dashboard.proofStore, clock: dashboard.clock, readExternalRuntimeEpoch: dashboard.readExternalRuntimeEpoch,
        newRequestId: dashboard.newRequestId, requestBudgetMs: dashboard.requestBudgetMs });
    const browser = createBrowserAuthService({ ...auth, now });
    const reader = createRetainedTrialAssessmentReader({ captureRequest: session.captureRequest,
        readSubject: key => records.readSubject(key), accountStore, database, clock: dashboard.clock, auditRead: true });
    const runtime = createPostgresDashboardRuntimeRepository({ pool: dashboard.pool, clock: dashboard.clock,
        instanceId: dashboard.instanceId, historyBudget: dashboard.historyBudget, captureRequest: session.captureRequest,
        readExternalRuntimeEpoch: dashboard.readExternalRuntimeEpoch, newId: dashboard.newId,
        newGenerationToken: dashboard.newGenerationToken, readVerifiedOnboardingProof: async () => null,
        readPreparedCaseCapability: async () => null, authoriseOperatorOperation: () => false });
    const logouts = new WeakMap();
    async function logout(request) {
        const capture = await session.captureRequest(request);
        if (capture) {
            const actor = capture.identityPayload.identityTenantId + ':' + capture.identityPayload.oid;
            const owner = await readRetainedTrialOwner({ subjectKey: actor, readSubject: key => records.readSubject(key), accountStore });
            // An existing gate is revoked through the ordinary fenced runtime
            // transition and paired immutable receipt/audit. Before the first
            // read there may be no gate. Confirm that absence under the same
            // session fence; deleting the genuine browser record still makes
            // every concurrent/future read fail its final fresh capture.
            const exists = await database.withTenantTransaction(owner.index.tenantId, async tx => {
                await tx.query(`SELECT set_config('nofries.runtime_instance_id',$1,true),set_config('nofries.session_sha256',$2,true),
                    set_config('nofries.session_kind','customer',true),set_config('nofries.identity_sha256',$3,true),
                    set_config('nofries.subject_key',$4,true)`, [capture.instanceId, capture.sessionSha256, hash(capture.identityPayload), actor]);
                await tx.query('SELECT pg_advisory_xact_lock($1::integer,hashtext($2))', [71001, capture.sessionSha256]);
                const result = await tx.query('SELECT * FROM nofries.dashboard_session_gates WHERE session_sha256=$1', [capture.sessionSha256]);
                if (!Array.isArray(result?.rows) || result.rows.length > 1) throw new BrowserAuthError(503, 'retained_read_unavailable');
                if (!result.rows.length) return false;
                const gate = normaliseSessionRow(result.rows[0]);
                if (gate.sessionSha256 !== capture.sessionSha256 || gate.kind !== 'customer' || gate.subjectKey !== actor ||
                    gate.identitySha256 !== hash(capture.identityPayload) || gate.instanceId !== capture.instanceId ||
                    gate.restoreEpoch !== capture.restoreEpoch) throw new BrowserAuthError(401, 'retained_read_denied');
                return true;
            });
            if (exists) await runtime.revokeSession(request, { operationId: dashboard.newOperationId() });
        }
        return browser.logout({ cookieHeader: request.headers?.cookie || '', returnTo: '/' });
    }
    return Object.freeze({
        async beginLogin(input) {
            const result = await browser.beginLogin(input);
            return { ...result, cookie: [result.cookie, clearExternalCustomerTransactionCookie()] };
        },
        completeLogin: input => session.callbackService.completeLogin(input),
        async read(request, selection) {
            if (await session.captureRequest(request) === null) throw new BrowserAuthError(401, 'retained_read_signin_required');
            return reader.read(request, selection);
        },
        logout(request) {
            if (!request || typeof request !== 'object') return Promise.reject(new BrowserAuthError(400, 'retained_read_input_invalid'));
            if (!logouts.has(request)) logouts.set(request, Promise.resolve().then(() => logout(request)));
            return logouts.get(request);
        }
    });
}

module.exports = { createRetainedTrialReadProduction };
