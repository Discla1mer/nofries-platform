'use strict';

const crypto = require('node:crypto');
const { createPostgresDatabase } = require('../api/shared/database/postgres');
const { BrowserAuthError, readBrowserSessionDetails, assertExactSameOriginRequest } = require('../api/shared/browserAuth');
const { CustomerSignupRuntimeError } = require('../api/shared/customerSignup/customerSignupRuntime');
const { AzureBlobSignupInvitationStore } = require('../api/shared/customerSignup/azureBlobInvitationStore');
const { createEntraB2bIdentityVerifier } = require('../api/shared/customerSignup/entraB2bIdentityProof');
const { createJournaledSignupHandlers } = require('../api/shared/customerSignup/journaledTermsAcceptance');
const { createPostgresSignupRegistrationStore } = require('../api/shared/customerSignup/postgresSignupRegistrationStore');
const { createPostgresSignupAcceptanceJournal } = require('../api/shared/customerSignup/postgresSignupAcceptanceJournal');
const { createSessionBoundSignupContinuation } = require('../api/shared/customerSignup/sessionBoundSignupContinuation');
const { createCustomerRecords, createCustomerIdentityPolicy, authority, termsOffer, scheduleArchive, opaqueCookie, COOKIE } = require('../api/shared/customerSignup/customerAuthority');
const { createEntraCustomerGraph } = require('../api/shared/customerSignup/entraCustomerGraph');
const { canonicalDigest } = require('../api/shared/appLifecycle/dashboardOnboardingDomain');
const { fields, uuid, copy } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { createBootstrapOperations, DashboardPersistenceError, dataStorage, dataCodec } = require('../api/shared/appLifecycle/postgresDashboardBootstrap');
const { buildActivationCommands, customerReference } = require('../api/shared/customerSignup/customerActivation');
const { createCustomerActivationPort } = require('./customerActivationProduction');
const { normaliseEntitlementState, TIERS } = require('../api/shared/appLifecycle/entitlementDomain');
const { combineCustomerRecords } = require('../api/shared/customerSignup/starterCustomerRecords');
const { createStarterSignupProduction } = require('./starterSignupProduction');
const { createStarterInvitationEmail } = require('./starterInvitationEmail');
const { AzureOrganisationSetupStore, AzureExternalSignupAdmissionStore } = require('./organisationSetupProduction');
const { createVerifiedSetupEmailReader } = require('../api/shared/customerSignup/verifiedSetupEmail');
const { COOKIE: SETUP_COOKIE } = require('../api/shared/organisationSetup');
const { createSignupDiagnostics } = require('../api/shared/customerSignup/signupDiagnostics');
const { createSavedSignupRecovery } = require('../api/shared/customerSignup/savedSignupRecovery');
const { createCustomerIdentityProviderProfile, customerProviderKey } = require('../api/shared/customerSignup/customerIdentityProviderProfile');
const { createExternalCustomerIdentityPolicy } = require('../api/shared/customerSignup/externalCustomerIdentityPolicy');
const { createExternalPasswordAuthentication } = require('../api/shared/customerSignup/externalPasswordAuthentication');
const { createExternalSignupAdmission } = require('../api/shared/customerSignup/externalSignupAdmission');
const { starterSetupSnapshot } = require('../api/shared/customerSignup/managedSignupProof');
const { LEGACY_PLAN_ID, THREE_MONTH_PLAN_ID, approvedStarterPlan } = require('../api/shared/customerSignup/customerStarterPlan');
const { AzureStarterAccountStore } = require('../api/shared/customerSignup/azureStarterAccountStore');
const { createRetainedTrialReadProduction } = require('./retainedTrialReadProduction');
const { createLunaProfileService } = require('../api/shared/customerSignup/lunaProfile');
const { createLunaProfileHandlers } = require('../api/shared/customerSignup/lunaProfileHandlers');
const fail = () => { throw new Error('customer_signup_production_unavailable'); };

function createProductionCustomerSignupConfiguration(env, dashboard, dependencies = {}, external = null) {
    if ([undefined, '', 'false'].includes(env.NOFRIES_CUSTOMER_SIGNUP_ENABLED)) return null;
    if (env.NOFRIES_CUSTOMER_SIGNUP_ENABLED !== 'true' || !dashboard) fail();
    const name = env.NOFRIES_CUSTOMER_AUTHORITY_CONTAINER;
    if (typeof name !== 'string' || !/^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name) ||
        [env.NOFRIES_BROWSER_AUTH_CONTAINER || 'nofries-browser-auth', env.NOFRIES_DASHBOARD_PROOF_CONTAINER, env.NOFRIES_DASHBOARD_EPOCH_CONTAINER].includes(name)) fail();
    const authorityAccount = env.AZURE_STORAGE_ACCOUNT_NAME, authAccount = env.NOFRIES_BROWSER_AUTH_STORAGE_ACCOUNT;
    if (![authorityAccount, authAccount].every(value => typeof value === 'string' && /^[a-z0-9]{3,24}$/.test(value)) ||
        authorityAccount === authAccount) fail();
    if (!external) uuid(env.NOFRIES_CUSTOMER_MFA_POLICY_ID);
    const ManagedIdentityCredential = dependencies.ManagedIdentityCredential || require('@azure/identity').ManagedIdentityCredential;
    const credential = env.NOFRIES_MANAGED_IDENTITY_CLIENT_ID
        ? new ManagedIdentityCredential({ clientId: env.NOFRIES_MANAGED_IDENTITY_CLIENT_ID }) : new ManagedIdentityCredential();
    const BlobServiceClient = dependencies.BlobServiceClient || require('@azure/storage-blob').BlobServiceClient;
    const authService = new BlobServiceClient(`https://${authAccount}.blob.core.windows.net`, credential,
        { retryOptions: { maxTries: 2, tryTimeoutInMs: 4000 } });
    const authorityService = new BlobServiceClient(`https://${authorityAccount}.blob.core.windows.net`, credential,
        { retryOptions: { maxTries: 2, tryTimeoutInMs: 4000 } });
    const sessionContainer = authService.getContainerClient(env.NOFRIES_BROWSER_AUTH_CONTAINER || 'nofries-browser-auth');
    const authorityContainer = authorityService.getContainerClient(name);
    if (![undefined, '', 'false', 'true'].includes(env.NOFRIES_STARTER_SIGNUP_ENABLED)) fail();
    const starterEnabled = env.NOFRIES_STARTER_SIGNUP_ENABLED === 'true';
    const starterName = env.NOFRIES_STARTER_AUTHORITY_CONTAINER;
    if (starterEnabled && (typeof starterName !== 'string' || !/^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(starterName) ||
        [name, env.NOFRIES_BROWSER_AUTH_CONTAINER || 'nofries-browser-auth', env.NOFRIES_DASHBOARD_PROOF_CONTAINER, env.NOFRIES_DASHBOARD_EPOCH_CONTAINER].includes(starterName))) fail();
    const legacyRecords = createCustomerRecords({ authorityContainer, sessionContainer });
    const starterContainer = starterEnabled ? authorityService.getContainerClient(starterName) : null;
    const starterRecords = starterEnabled ? createCustomerRecords({ authorityContainer: starterContainer, sessionContainer }) : null;
    const records = external ? starterRecords : starterEnabled ? combineCustomerRecords(legacyRecords, starterRecords) : legacyRecords;
    const preparation = createCustomerActivationPort({ authorityContainer,
        sessionContainer, now: () => Date.parse(dashboard.clock()) });
    const graph = external ? null : createEntraCustomerGraph({ credential, policyId: env.NOFRIES_CUSTOMER_MFA_POLICY_ID,
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) });
    const now = () => Date.parse(dashboard.clock());
    const diagnostics = Object.hasOwn(dependencies, 'signupDiagnostics') ? dependencies.signupDiagnostics
        : event => console.warn(JSON.stringify(event));
    const report = createSignupDiagnostics({ sink: diagnostics });
    const verifiedEmail = createVerifiedSetupEmailReader({ store: new AzureOrganisationSetupStore(sessionContainer), now });
    const policy = external ? createExternalCustomerIdentityPolicy({ records, profile: external.profile, now,
        ...external.authentication, allowNewSignup: external.allowNewSignup,
        signupAdmission: createExternalSignupAdmission({ store: new AzureOrganisationSetupStore(sessionContainer),
            permitStore: new AzureExternalSignupAdmissionStore(starterContainer),
            providerKey: customerProviderKey(external.profile), now }) }) : createCustomerIdentityPolicy({ records, verifyMfaPolicy: graph.verifyMfaPolicy, verifiedEmail,
            authenticationContext: env.NOFRIES_CUSTOMER_MFA_CONTEXT, now });
    const database = createPostgresDatabase({ pool: {
        end: () => dashboard.pool.end(),
        async connect() {
            const client = await dashboard.pool.connect();
            return { release: discard => client.release(discard), async query(sql, params) {
                const result = await client.query(sql, params);
                if (sql === 'BEGIN') await client.query('SET LOCAL ROLE nofries_runtime');
                return result;
            } };
        }
    } });
    const registrationStore = createPostgresSignupRegistrationStore({ database });
    const journal = createPostgresSignupAcceptanceJournal({ database });
    const invitations = new AzureBlobSignupInvitationStore({ containerClient: sessionContainer });
    const auth = dashboard.browserAuthOptions;
    const sessionCookie = external ? '__Host-nofries-external-customer' : '__Host-nofries-customer';
    const externalAuth = external ? { env, customerIdentityProvider: external.rawProfile, customerTransport: 'external',
        ...(Object.hasOwn(external.client, 'clientAssertion') ? { clientAssertion: external.client.clientAssertion } : {}) } : {};
    async function readAuthenticatedCustomer(cookieHeader) {
        let id;
        try { id = opaqueCookie(cookieHeader || '', sessionCookie); }
        catch (error) {
            // This catch covers only parsing this purpose's cookie, never an
            // authority/policy denial that happens to use the same code.
            if (external && error instanceof BrowserAuthError && error.statusCode === 401) {
                throw new CustomerSignupRuntimeError(401, 'signup_signin_required');
            }
            throw error;
        }
        if (!id) return null;
        let record;
        let details;
        try {
            details = await readBrowserSessionDetails(cookieHeader, { env, now, customerPolicy: policy, ...externalAuth,
                store: { async loadSession(key) {
                    record = await auth.store.loadSession(key);
                    // A transplanted SID must not let an external request run
                    // the shared reader's cleanup against a competing purpose.
                    if (external && record != null && (record.customerTransport !== 'external' ||
                        record.customerProviderKey !== customerProviderKey(external.profile) ||
                        !Object.hasOwn(record, 'customerAssurance'))) {
                        throw new BrowserAuthError(401, 'browser_auth_session_provider_invalid');
                    }
                    return record;
                },
                    deleteSession: key => auth.store.deleteSession(key) } });
        } catch (error) {
            if (external && error instanceof BrowserAuthError && error.statusCode === 401 &&
                ['browser_auth_cookie_invalid', 'browser_auth_session_invalid', 'browser_auth_session_expired'].includes(error.code)) {
                throw new CustomerSignupRuntimeError(401, 'signup_signin_required');
            }
            throw error;
        }
        if (!details || !record) fail();
        return { details, assurance: record.customerAssurance, id };
    }
    async function readCustomer(cookieHeader) {
        const session = await readAuthenticatedCustomer(cookieHeader);
        if (!session || session.assurance.stage === 'setup') return null;
        const { details, assurance, id } = session;
        const current = authority(await records.readSubject(details.identity.subjectKey), details.identity.subjectKey, now());
        if (assurance.authoritySha256 !== canonicalDigest(current) || assurance.revision !== current.revision || Date.parse(details.expiresAt) <= now()) fail();
        return { details, assurance, current, id };
    }
    const starter = starterEnabled ? createStarterSignupProduction({ env, dashboard, database, policy, readCustomer,
        container: starterContainer, legacyRecords, starterRecords, graph, invitations,
        ...(external ? { starterPlanId: external.trial.planId } : {}),
        ...(external ? { external: { identityPolicy: external.identityPolicy, browserAuthOptions: externalAuth,
            providerKey: customerProviderKey(external.profile) } }
            : { sendMemberInvitation: createStarterInvitationEmail({ env, ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) }) }) }) : null;
    const verifier = createEntraB2bIdentityVerifier({ expectedTenantId: external ? external.profile.tenantId : env.NOFRIES_ENTRA_TENANT_ID,
        identityPolicyId: external ? external.identityPolicy.policyId : dashboard.identityPolicy.policyId,
        async readIdentity({ handle }) {
            const customer = await readCustomer(`${sessionCookie}=${handle}`); if (!customer) fail();
            const { details, assurance } = customer;
            return { provider: 'entra-bff', isAuthenticated: true, tenantId: details.identity.tenantId,
                principalId: details.identity.principalId, subjectKey: details.identity.subjectKey, email: assurance.email,
                // External password authentication makes no MFA assertion.
                // Legacy assurance still comes from the unchanged c1 policy.
                emailVerified: true, mfaSatisfied: !external, verifiedAt: assurance.verifiedAt,
                expiresAt: Math.min(assurance.expiresAt, Date.parse(details.expiresAt)) };
        } });
    const cookie = req => req.headers?.cookie || '';
    const scopedRegistration = subjectKey => registrationStore.readStorageLayout({ subjectKey });
    async function passiveState(req, customer) {
        const starterState = starter ? await starter.readOnlyState(req, customer.current) : null;
        if (starterState !== null) return starterState;
        // Retain the ordinary durable-proof read before classifying this
        // historical non-starter context. Both operations are passive.
        await journal.readForInvitation({ tenantId: customer.current.tenantId,
            organisationId: customer.current.organisationId, invitationId: customer.current.invitationId });
        if (await scopedRegistration(customer.current.subjectKey) !== 'scoped') return null;
        if (customer.current.bindingId !== null && await existingOrganisationReady(customer.current)) {
            const binding = await resolveActivationBinding(req);
            if (binding.bindingId !== customer.current.bindingId ||
                binding.scope.tenantId !== customer.current.tenantId ||
                binding.scope.organisationId !== customer.current.organisationId) fail();
            return { status: 'continue_to_dashboard', ...(binding.accountType ? { accountType: binding.accountType } : {}) };
        }
        return { status: 'setup_read_only' };
    }
    const registrationFor = current => registrationStore.readForInvitation({ subjectKey: current.subjectKey,
        tenantId: current.tenantId, organisationId: current.organisationId, invitationId: current.invitationId });
    const recoveryReference = current => Object.freeze({ subjectKey: current.subjectKey, tenantId: current.tenantId,
        organisationId: current.organisationId, invitationId: current.invitationId,
        termsVersion: current.termsVersion, termsDigest: current.termsDigest,
        ...(Object.hasOwn(current, 'scheduleId') ? { scheduleId: current.scheduleId, scheduleDigest: current.scheduleDigest } : {}) });
    const continuation = createSessionBoundSignupContinuation({ database, now, diagnostics,
        readSessionDetails: async header => (await readCustomer(header))?.details || null,
        readRegistration: async ({ subjectKey }) => {
            const selected = authority(await records.readSubject(subjectKey), subjectKey, now());
            return registrationFor(selected);
        },
        readRecoveryReference: async ({ subjectKey }) => recoveryReference(
            authority(await records.readSubject(subjectKey), subjectKey, now())) });
    async function resolveTerms({ termsVersion, termsDigest, tenantId, organisationId, scheduleId, scheduleDigest, acceptedAt }) {
        const applicabilityAt = acceptedAt === undefined ? now() : acceptedAt;
        if (!Number.isSafeInteger(applicabilityAt) || applicabilityAt < 0 || Object.is(applicabilityAt, -0)) fail();
        const [terms, rawOffer, rawSchedule] = await Promise.all([
            records.readTerms(termsDigest), records.readTermsOffer(tenantId, organisationId), records.readSchedule(scheduleId, scheduleDigest)
        ]);
        fields(terms, ['termsText', 'termsVersion', 'termsDigest']);
        if (terms.termsVersion !== termsVersion || terms.termsDigest !== termsDigest) fail();
        // The immutable text archive proves historical bytes. This separate
        // organisation-scoped record determines whether new consent is
        // currently offered under an approved schedule.
        const offer = termsOffer(rawOffer, { tenantId, organisationId, termsVersion, termsDigest,
            scheduleId, scheduleDigest }, acceptedAt === undefined ? now() : applicabilityAt);
        const schedule = scheduleArchive(rawSchedule, offer);
        return { ...terms, scheduleId: schedule.scheduleId, scheduleText: schedule.scheduleText,
            scheduleDigest: schedule.scheduleDigest };
    }
    const handlers = createJournaledSignupHandlers({ database, store: invitations, registrationStore, now, diagnostics, contextMode: 'verified-digest',
        verifyIdentity: verifier.verifyIdentity,
        async resolveContext(req) {
            const customer = await readCustomer(cookie(req)); if (!customer) fail();
            // Absence alone selects the durable continuation. Revoked/expired
            // records are still sent through the domain's denial path.
            const sha = customer.assurance.invitationDigest;
            if (await invitations.read(sha) === null) return null;
            return { invitationDigest: customer.assurance.invitationDigest, identityProofHandle: customer.id };
        },
        resolveTerms, loadContinuationState: continuation });
    const recovery = createSavedSignupRecovery({ journal, registrations: registrationStore, now, resolveTerms,
        readApproval: subjectKey => legacyRecords.readSignupRecovery(subjectKey),
        readInvitation: sha => invitations.read(sha),
        async readContext(req) {
            if (!starter) return null;
            const customer = await readCustomer(cookie(req)); if (!customer) return null;
            if (await legacyRecords.readSignupRecovery(customer.current.subjectKey) === null ||
                await invitations.read(customer.current.invitationDigest) !== null) return null;
            const retained = await starter.readRecoveryContext(req, customer.current);
            if (!retained) return null;
            return { ...retained, authority: customer.current, sessionId: customer.id,
                verifiedAt: customer.assurance.verifiedAt,
                expiresAt: Math.min(customer.assurance.expiresAt, Date.parse(customer.details.expiresAt)) };
        } });
    async function recoverIfAuthorized(customer, method, input) {
        if (external || !starter || await legacyRecords.readSignupRecovery(customer.current.subjectKey) === null ||
            await registrationFor(customer.current) !== null) return null;
        return recovery[method](input);
    }
    async function resolveActivationBinding(req) {
        const customer = await readCustomer(cookie(req)); if (!customer || !customer.current.bindingId) fail();
        const reference = await registrationFor(customer.current);
        if (!reference || reference.status !== 'pending_admission') fail();
        const authorityKeys = ['subjectKey', 'tenantId', 'organisationId', 'invitationId', 'termsVersion', 'termsDigest',
            ...(Object.hasOwn(customer.current, 'scheduleId') ? ['scheduleId', 'scheduleDigest'] : [])];
        for (const key of authorityKeys) {
            if (reference[key] !== customer.current[key]) fail();
        }
        const receipt = await journal.readForInvitation({ tenantId: reference.tenantId,
            organisationId: reference.organisationId, invitationId: reference.invitationId });
        if (!receipt || [...authorityKeys, 'receiptId'].some(k => receipt[k] !== reference[k])) fail();
        const again = await registrationFor(customer.current);
        if (JSON.stringify(again) !== JSON.stringify(reference)) fail();
        const final = await readCustomer(cookie(req));
        if (!final || final.current.revision !== customer.current.revision || final.current.bindingId !== customer.current.bindingId) fail();
        return Object.freeze({ bindingId: final.current.bindingId, scope: Object.freeze({ tenantId: final.current.tenantId, organisationId: final.current.organisationId }),
            ...(Object.hasOwn(final.current, 'accountType') ? { accountType: final.current.accountType } : {}),
            ...(starter && await starter.clientSetupAvailable(final.current) ? { clientSetupAvailable: true } : {}) });
    }
    async function existingOrganisationReady(current) {
        try {
            return await database.withTenantTransaction(current.tenantId, async tx => {
                const state = await dataStorage.loadSnapshotForShare(tx, current);
                return state.tenantAggregate.tenant.recordStatus === 'active' &&
                    state.tenantAggregate.organisations[0].recordStatus === 'active' &&
                    state.membershipState.memberships.some(member => member.subjectKey === current.subjectKey &&
                        member.status === 'active' && Date.parse(member.validFrom) <= now() && now() < Date.parse(member.validUntil));
            });
        } catch (error) {
            if (error instanceof DashboardPersistenceError) return false;
            throw error;
        }
    }
    async function organisationPrepared(current, req) {
        if (starter) {
            const prepared = await starter.prepared(req, current);
            if (prepared !== null) return prepared;
        }
        // Existing durable consent may be resumed after activation or approval
        // expiry. It is validated again by the journalled handlers below.
        const accepted = await journal.readForInvitation({ tenantId: current.tenantId,
            organisationId: current.organisationId, invitationId: current.invitationId });
        if (accepted) {
            if (Object.entries(customerReference(current)).some(([key, value]) => accepted[key] !== value)) fail();
            return true;
        }
        if (current.bindingId !== null) {
            // Existing-member invitations do not initialise a new organisation.
            // Require their complete canonical state and an active membership.
            return existingOrganisationReady(current);
        }
        const approval = await preparation.readPreparation(current);
        if (!approval) return false;
        const command = buildActivationCommands(approval).bootstrap;
        const expectedState = { ...approval.initialState, entitlementState: normaliseEntitlementState(
            approval.initialState.entitlementState, approval.initialState.tenantAggregate) };
        const byGrant = (a, b) => a.grantId < b.grantId ? -1 : a.grantId > b.grantId ? 1 : 0;
        const expectedUsage = expectedState.entitlementState.grants.filter(grant => Object.hasOwn(TIERS, grant.code))
            .map(dataCodec.newUsage).sort(byGrant);
        const bootstrap = createBootstrapOperations({ clock: () => new Date(now()).toISOString(),
            authoriseAdministration(actual, snapshot) {
                const { usage, ...state } = snapshot;
                return canonicalDigest(actual) === canonicalDigest(command) &&
                    canonicalDigest(state) === canonicalDigest(expectedState) && Array.isArray(usage) &&
                    canonicalDigest([...usage].sort(byGrant)) === canonicalDigest(expectedUsage);
            } });
        const prepared = bootstrap.prepareInitialisation(command, approval.initialState);
        try {
            await database.withTenantTransaction(current.tenantId, tx => bootstrap.reconcileInTransaction(tx, prepared));
        } catch (error) {
            if (error instanceof DashboardPersistenceError) return false;
            throw error;
        }
        const final = await preparation.readPreparation(current);
        return final !== null && canonicalDigest(final) === canonicalDigest(approval);
    }
    async function projectedState(req, result) {
        if (result.status === 'pending_admission') {
            const current = await readCustomer(cookie(req));
            const passive = current ? await passiveState(req, current) : null;
            if (passive !== null) return passive;
            if (starter && current) await starter.activate(req, current.current);
            if (current?.current.bindingId) {
                const binding = await resolveActivationBinding(req);
                return { status: 'continue_to_dashboard', ...(binding.accountType ? { accountType: binding.accountType } : {}) };
            }
        }
        return result;
    }
    async function csrf(req) {
        const customer = await (external ? readAuthenticatedCustomer : readCustomer)(cookie(req));
        if (!customer) {
            if (external) throw new CustomerSignupRuntimeError(401, 'signup_signin_required');
            fail();
        }
        // Domain-separated hash of a server-generated opaque session secret;
        // returning this token does not disclose/reconstruct the session cookie.
        return crypto.createHash('sha256').update('nofries:signup-csrf:v1\0').update(customer.id).digest('base64url');
    }
    const clients = starter?.clientOperations({ verifyIdentity: verifier.verifyIdentity });
    async function findAccount(proof) {
        const account = starter ? await starter.setup.findAccount(proof) : null; if (account) return account;
        if (external) return null;
        // Recover a pre-starter customer only through a unique immutable
        // directory object and matching existing authority, after email verification.
        const users = await graph.findUsersByEmail(proof.email);
        if (!users.length) return null;
        const subject = env.NOFRIES_ENTRA_TENANT_ID + ':' + uuid(users[0].id);
        const raw = await records.readSubject(subject); if (raw === null) return null;
        const current = authority(raw, subject, now());
        if (current.email !== proof.email) fail();
        return { accountType: current.accountType || 'company', organisationName: 'Your existing organisation', nextStep: 'account_found' };
    }
    // Explicit server dependency only: no default store, environment activation,
    // route registration or new container selection. Preserve the normal shape.
    let lunaProfile = null;
    if (Object.hasOwn(dependencies, 'lunaProfileStore')) {
        if (!starter) fail();
        const service = createLunaProfileService({ store: dependencies.lunaProfileStore, now,
            accountReaderOptions: { readCustomer, accountStore: new AzureStarterAccountStore(starterContainer), now } });
        lunaProfile = createLunaProfileHandlers({ service, env, customerCookie: sessionCookie, issueCsrfToken: csrf });
    }
    return Object.freeze({
        ...(lunaProfile ? { lunaProfile } : {}),
        findAccount,
        ...(external?.trial.retainedRead === true ? { retainedTrialRead: createRetainedTrialReadProduction({
            env, dashboard, records, accountStore: new AzureStarterAccountStore(starterContainer), database,
            profile: external.profile, rawProfile: external.rawProfile, identityPolicy: external.identityPolicy,
            client: external.client, authentication: external.authentication
        }) } : {}),
        ...(starter ? { starterSetup: starter.setup, resolveStarterQuota: starter.resolveQuota,
            async starterClients(req) {
                if (!['GET','POST'].includes(req.method)) fail();
                const query = req.query || {}, keys = Object.keys(query);
                if (req.method === 'POST' && keys.length || keys.length > 1 ||
                    keys.some(key => !['cursor', 'requestId'].includes(key)) ||
                    Object.hasOwn(query, 'cursor') && (typeof query.cursor !== 'string' ||
                        !/^[A-Za-z0-9_-]{1,16384}$/.test(query.cursor)) ||
                    Object.hasOwn(query, 'requestId') && (typeof query.requestId !== 'string' ||
                        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(query.requestId))) fail();
                const csrfToken = await csrf(req);
                if (req.method === 'POST') {
                    assertExactSameOriginRequest(req, env);
                    const supplied = req.headers['x-csrf-token'];
                    if (typeof supplied !== 'string' || supplied.length !== csrfToken.length ||
                        !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(csrfToken)) ||
                        Buffer.byteLength(JSON.stringify(req.body)) > 8192) fail();
                }
                const state = req.method === 'GET' ? await clients.list(req, query) : await clients.execute(req, req.body);
                return { status: 200, headers: { 'Cache-Control': 'no-store' }, body: { state, csrfToken } };
            } } : {}),
        customer: Object.freeze({ policy, resolveActivationBinding, ...(external ? {
            identityProvider: external.rawProfile, identityPolicy: external.identityPolicy, client: external.client } : {}) }),
        customerSignup: Object.freeze({ env,
            ...(external ? { async completeSetup({ req, input }) {
                const captured = await readAuthenticatedCustomer(cookie(req));
                if (!captured) throw new CustomerSignupRuntimeError(401, 'signup_signin_required');
                if (await scopedRegistration(captured.details.identity.subjectKey) === 'scoped') return { status: 'setup_read_only' };
                let stage = 'setup_session';
                try {
                    stage = 'setup_retained_read';
                    const retained = await starter.setup.readRetained({ identity: captured.details.identity, assurance: captured.assurance });
                    const confirmed = await readAuthenticatedCustomer(cookie(req));
                    if (!confirmed || confirmed.id !== captured.id || canonicalDigest(confirmed.assurance) !== canonicalDigest(captured.assurance) ||
                        confirmed.details.identity.subjectKey !== captured.details.identity.subjectKey) fail();
                    if (retained?.readOnly) return { status: 'setup_read_only' };
                    if (Object.hasOwn(input, 'resume')) {
                        fields(input, ['resume']); if (input.resume !== true) fail();
                        if (!retained?.input?.details) fail();
                        if (retained.complete) return { status: 'continue_authentication' };
                        input = retained.input;
                    } else if (captured.assurance.stage !== 'setup' || retained?.complete && !retained.input?.details) fail();
                    fields(input, ['accountType', 'organisationName', 'details']);
                    const { assurance, details, id } = captured;
                    // Stable only for this opaque session. A retry cannot alter the
                    // declared account and the body cannot select identity/proof.
                    const hex = crypto.createHash('sha256').update('nofries:managed-setup:v1\0').update(id).digest('hex');
                    const requestId = `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
                    const proof = starterSetupSnapshot({ schemaVersion: 1, source: 'external-id-signup', requestId,
                        subjectKey: details.identity.subjectKey, providerKey: assurance.providerKey,
                        authenticationSha256: canonicalDigest(assurance.authentication), email: assurance.email,
                        accountType: input.accountType, organisationName: input.organisationName,
                        createdAt: assurance.verifiedAt, verifiedAt: assurance.verifiedAt,
                        expiresAt: Math.min(assurance.expiresAt, Date.parse(details.expiresAt)) }, requestId);
                    async function beforeMutation() {
                        const latest = await readAuthenticatedCustomer(cookie(req));
                        if (!latest || latest.id !== id || canonicalDigest(latest.assurance) !== canonicalDigest(assurance) ||
                            latest.details.identity.subjectKey !== proof.subjectKey || proof.expiresAt <= now()) fail();
                    }
                    await beforeMutation();
                    stage = 'setup_save';
                    await starter.setup.save(proof, input.details);
                    stage = 'setup_claim';
                    await starter.claim({ proof, identity: details.identity, beforeMutation });
                    return { status: 'continue_authentication' };
                } catch (error) { report(stage, error); throw error; }
            } } : {}),
            async loadState(req) {
                let stage = 'customer_session';
                try {
                    if (external) {
                        const session = await readAuthenticatedCustomer(cookie(req));
                        if (session) {
                            if (session.assurance.stage === 'setup' &&
                                await scopedRegistration(session.details.identity.subjectKey) === 'scoped') return { status: 'setup_read_only' };
                            stage = 'setup_retained_read';
                            const retained = await starter.setup.readRetained({ identity: session.details.identity, assurance: session.assurance });
                            const latest = await readAuthenticatedCustomer(cookie(req));
                            if (!latest || latest.id !== session.id || canonicalDigest(latest.assurance) !== canonicalDigest(session.assurance) ||
                                latest.details.identity.subjectKey !== session.details.identity.subjectKey) fail();
                            if (retained?.readOnly && (!retained.complete || retained.input)) return { status: 'setup_read_only' };
                            if (retained && !retained.complete) {
                                const reservation = { accountType: retained.input.accountType, organisationName: retained.input.organisationName };
                                return retained.input.details ? { status: 'resume_setup', email: session.assurance.email, ...reservation }
                                    : { status: 'setup_details', email: session.assurance.email, reservation };
                            }
                            if (session.assurance.stage === 'setup') {
                                if (retained?.complete) return { status: 'continue_authentication' };
                                if (await records.readSubject(session.details.identity.subjectKey) !== null) fail();
                                return { status: 'setup_details', email: session.assurance.email };
                            }
                        }
                    }
                    const customer = await readCustomer(cookie(req));
                    if (!customer) return { status: 'create_account' };
                    stage = 'signup_state';
                    // Completed registrations use the ordinary durable path even
                    // after recovery approval expires. Tombstones stay denied.
                    const recovered = await recoverIfAuthorized(customer, 'loadState', req);
                    if (recovered !== null) {
                        stage = 'admission_projection';
                        return await projectedState(req, recovered);
                    }
                    stage = 'organisation_preparation';
                    const passive = await passiveState(req, customer);
                    if (passive !== null) return passive;
                    if (!await organisationPrepared(customer.current, req)) return { status: 'pending_preparation' };
                    stage = 'signup_state';
                    const result = await handlers.loadState(req);
                    stage = 'admission_projection';
                    return await projectedState(req, result);
                } catch (error) {
                    report(stage, error);
                    throw error;
                }
            },
            async acceptTerms(input) {
                const customer = await readCustomer(cookie(input.req));
                if (!customer) fail();
                const passive = await passiveState(input.req, customer);
                if (passive !== null) return passive;
                const recovered = await recoverIfAuthorized(customer, 'acceptTerms', input);
                if (recovered !== null) return projectedState(input.req, recovered);
                if (!await organisationPrepared(customer.current, input.req)) return { status: 'pending_preparation' };
                return projectedState(input.req, await handlers.acceptTerms(input));
            },
            async resumeAcceptance(input) {
                const customer = await readCustomer(cookie(input.req)); if (!customer) fail();
                const passive = await passiveState(input.req, customer);
                if (passive !== null) return passive;
                const recovered = await recoverIfAuthorized(customer, 'resumeAcceptance', input);
                if (recovered !== null) return projectedState(input.req, recovered);
                if (!await organisationPrepared(customer.current, input.req)) return { status: 'pending_preparation' };
                return projectedState(input.req, await handlers.resumeAcceptance(input));
            },
            issueCsrfToken: csrf,
            async validateCsrfToken(req, token) {
                const expected = await csrf(req);
                return typeof token === 'string' && token.length === expected.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
            }
        }),
        async signupBootstrap(req) {
            assertExactSameOriginRequest(req, env);
            fields(req.body, ['invitationToken']);
            const value = req.body.invitationToken;
            // Validate canonical bytes without reading authority or exposing
            // whether a particular invitation exists.
            if (opaqueCookie(`${COOKIE}=${value}`, COOKIE) !== value) fail();
            return { status: 204, headers: { 'Cache-Control': 'no-store',
                // Opening an invitation is an explicit change of entry intent.
                // Clear only this browser's setup pointer; retain every saved
                // setup/account record and let a later fresh email proof work.
                'Set-Cookie': [`${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
                    `${SETUP_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`] }, body: '' };
        }
    });
}
// The launcher selects this only through explicit, default-off configuration.
// The separate container cannot be the existing legacy starter/authority store.
function createExternalCustomerSignupConfiguration(env, dashboard, dependencies, configuration) {
    fields(configuration, ['identityProvider', 'identityPolicy', 'client', 'starterAuthorityContainer', 'userFlowId', 'allowNewSignup',
        ...(Object.hasOwn(configuration, 'trial') ? ['trial'] : [])]);
    const trial = Object.hasOwn(configuration, 'trial')
        ? fields(copy(configuration.trial, 16384), ['planId', 'retainedRead']) : { planId: LEGACY_PLAN_ID, retainedRead: false };
    approvedStarterPlan(trial.planId);
    if (typeof trial.retainedRead !== 'boolean' || trial.planId === THREE_MONTH_PLAN_ID && !trial.retainedRead) fail();
    const rawProfile = Object.freeze({ ...configuration.identityProvider });
    const profile = createCustomerIdentityProviderProfile(rawProfile, { tenantId: env.NOFRIES_ENTRA_TENANT_ID, clientId: env.NOFRIES_ENTRA_CLIENT_ID });
    const identityPolicy = Object.freeze({ ...configuration.identityPolicy });
    fields(identityPolicy, ['policyId', 'policyRevision', 'issuer', 'identityTenantId', 'audience']);
    if (profile.kind !== 'external-id' || identityPolicy.issuer !== profile.issuer || identityPolicy.identityTenantId !== profile.tenantId ||
        identityPolicy.audience !== profile.clientId || typeof identityPolicy.policyId !== 'string' || !identityPolicy.policyId ||
        !Number.isSafeInteger(identityPolicy.policyRevision) || identityPolicy.policyRevision < 0 || typeof configuration.allowNewSignup !== 'boolean' ||
        [env.NOFRIES_STARTER_AUTHORITY_CONTAINER, env.NOFRIES_CUSTOMER_AUTHORITY_CONTAINER].includes(configuration.starterAuthorityContainer)) fail();
    const client = configuration.client;
    if (!client || typeof client !== 'object') fail();
    const assertion = Object.hasOwn(client, 'clientAssertion');
    fields(client, [assertion ? 'clientAssertion' : 'clientSecret',
        ...(Object.hasOwn(client, 'clientApplication') ? ['clientApplication'] : [])]);
    if (assertion ? typeof client.clientAssertion !== 'function' : typeof client.clientSecret !== 'string' || !client.clientSecret) fail();
    // Exclude the legacy credential before reading values, including accessors.
    const customerEnvironment = Object.fromEntries(Object.keys(env)
        .filter(key => key !== 'NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET').map(key => [key, env[key]]));
    const selected = { ...customerEnvironment, NOFRIES_CUSTOMER_SIGNUP_ENABLED: 'true', NOFRIES_STARTER_SIGNUP_ENABLED: 'true',
        NOFRIES_STARTER_AUTHORITY_CONTAINER: configuration.starterAuthorityContainer,
        NOFRIES_CUSTOMER_ENTRA_CLIENT_ID: profile.clientId };
    if (!assertion) selected.NOFRIES_CUSTOMER_ENTRA_CLIENT_SECRET = client.clientSecret;
    return createProductionCustomerSignupConfiguration(selected, dashboard, dependencies, {
        profile, rawProfile, identityPolicy, client, trial: Object.freeze(trial), allowNewSignup: configuration.allowNewSignup,
        authentication: createExternalPasswordAuthentication({ profile, userFlowId: configuration.userFlowId, now: () => Date.parse(dashboard.clock()) }) });
}
module.exports = { createProductionCustomerSignupConfiguration, createExternalCustomerSignupConfiguration };
