'use strict';

const crypto = require('node:crypto');
const { fields, copy, freeze, uuid, equal, hash, normaliseBindingRow, normaliseAdmissionRows } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');
const { dataStorage } = require('../api/shared/appLifecycle/postgresDashboardBootstrap');
const { resolveActiveMembership } = require('../api/shared/appLifecycle/membershipDomain');
const { resolveEntitlements } = require('../api/shared/appLifecycle/entitlementDomain');
const { createStarterAccountAllocator, starterAccountRecord, starterAccountKey } = require('../api/shared/customerSignup/starterAccountAllocation');
const { AzureStarterAccountStore } = require('../api/shared/customerSignup/azureStarterAccountStore');
const { wrapDashboardAdminAccountStore } = require('./dashboardAdminBindings');
const { AzureStarterSetupStore } = require('../api/shared/customerSignup/azureStarterSetupStore');
const { createStarterSetupDetails, starterRepresentativeDetails, starterSetupRecord, starterSetupKey, ASSERTION_VERSION } = require('../api/shared/customerSignup/starterSetupDetails');
const { starterSetupSnapshot: verifiedSnapshot } = require('../api/shared/customerSignup/managedSignupProof');
const { approvedStarterPlan, starterAuthorityExpiry, compileStarterSchedule, LEGACY_PLAN_ID, THREE_MONTH_PLAN_ID, usesUnlimitedConsultantPolicy } = require('../api/shared/customerSignup/customerStarterPlan');
const { createInvitation, validateInvitationRecord, MAX_PROOF_AGE } = require('../api/shared/customerSignup/invitationAcceptance');
const { createJournaledSignupHandlers } = require('../api/shared/customerSignup/journaledTermsAcceptance');
const { createPostgresSignupAcceptanceJournal } = require('../api/shared/customerSignup/postgresSignupAcceptanceJournal');
const { createPostgresSignupRegistrationStore, readSignupRegistrationLayout } = require('../api/shared/customerSignup/postgresSignupRegistrationStore');
const { compileStarterProvisioning, retainedStarterPreparation, retainedStarterActivation } = require('../api/shared/customerSignup/starterProvisioning');
const { provisionCustomerInvitation } = require('../api/shared/customerSignup/provisionCustomerInvitation');
const { authority, subjectHash, termsOfferKey, scheduleArchiveKey, termsOffer, scheduleArchive } = require('../api/shared/customerSignup/customerAuthority');
const { createDashboardCustomerSession } = require('../api/shared/dashboardOperatorSession');
const { createPostgresDashboardRuntimeRepository } = require('../api/shared/appLifecycle/postgresDashboardRuntimeRepository');
const { ACCEPTED_PROFILE_REF, MODULE_ID } = require('../api/shared/assessmentEngine/ncscAssessmentEvaluator');
const { ASSESSMENT_EVALUATOR_VERSION } = require('../api/shared/assessmentEngine/assessmentEvaluatorVersion');
const { createNcscSubmissionQuotaResolver, normaliseNcscSubmissionSelection } = require('./ncscSubmissionPolicy');
const { createExternalStarterClaim, validateRetainedExternalStarterClaim } = require('../api/shared/customerSignup/externalStarterClaim');
const fail = () => { throw new Error('starter_signup_unavailable'); };
const LIMIT = 262144;

function createStarterSignupProduction({ env, dashboard, database, policy, readCustomer,
    container, legacyRecords, starterRecords, graph, invitations, sendMemberInvitation, external = null,
    starterPlanId = LEGACY_PLAN_ID }) {
    approvedStarterPlan(starterPlanId);
    const now = () => Date.parse(dashboard.clock());
    const identityPolicy = external ? external.identityPolicy : dashboard.identityPolicy;
    const accountStore = wrapDashboardAdminAccountStore({ env, dashboard, provider: external ? 'external' : 'legacy',
        sourceName: env.NOFRIES_STARTER_AUTHORITY_CONTAINER, source: container,
        accountStore: new AzureStarterAccountStore(container) }), setupStore = new AzureStarterSetupStore(container);
    const acceptanceJournal = createPostgresSignupAcceptanceJournal({ database });
    const signupRegistrations = createPostgresSignupRegistrationStore({ database });
    const preparations = new WeakMap();
    const framework = () => ({ moduleId: MODULE_ID, profileId: ACCEPTED_PROFILE_REF.profileId,
        version: ACCEPTED_PROFILE_REF.profileVersion, scoringVersion: ASSESSMENT_EVALUATOR_VERSION });
    async function readJson(key) {
        try {
            const response = await container.getBlockBlobClient(key).download(0, LIMIT + 1, { abortSignal: AbortSignal.timeout(5000) });
            if (!Number.isSafeInteger(response.contentLength) || response.contentLength < 1 || response.contentLength > LIMIT) fail();
            let bytes = 0; const chunks = [];
            try { for await (const chunk of response.readableStreamBody) { bytes += chunk.length; if (bytes > LIMIT) fail(); chunks.push(chunk); } }
            finally { response.readableStreamBody?.destroy(); }
            if (bytes !== response.contentLength) fail();
            return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        } catch (error) { if (error?.statusCode === 404 && error.code === 'BlobNotFound') return null; throw error; }
    }
    async function createExact(key, value) {
        const before = await readJson(key);
        if (before !== null) { if (!equal(before, value)) fail(); return before; }
        const bytes = Buffer.from(JSON.stringify(value)); if (bytes.length > LIMIT) fail();
        try { await container.getBlockBlobClient(key).uploadData(bytes, { conditions: { ifNoneMatch: '*' },
            abortSignal: AbortSignal.timeout(5000), blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-store' } }); }
        catch (error) { if (!equal(await readJson(key), value)) throw error; }
        const saved = await readJson(key); if (!equal(saved, value)) fail(); return saved;
    }
    const contextKey = slot => `customer-starter/contexts/${uuid(slot.organisationId)}.json`;
    async function accountFor(email) {
        const found = await accountStore.load(starterAccountKey(email));
        if (!found) return null;
        const account = starterAccountRecord(found.record); if (account.email !== email) fail(); return account;
    }
    async function owner(req) {
        const customer = await readCustomer(req.headers?.cookie || ''); if (!customer) fail();
        if (await legacyRecords.readSubject(customer.current.subjectKey) !== null ||
            !equal(await starterRecords.readSubject(customer.current.subjectKey), customer.current)) fail();
        const account = await accountFor(customer.current.email); if (!account) fail();
        const own = account.organisations[0];
        if (own.bindingId !== customer.current.bindingId || own.tenantId !== customer.current.tenantId ||
            own.organisationId !== customer.current.organisationId || account.accountType !== customer.current.accountType ||
            account.activation && account.activation.subjectKey !== customer.current.subjectKey) fail();
        return { customer, account };
    }
    async function retained(account, slot) {
        const raw = copy(await readJson(contextKey(slot)), LIMIT);
        const value = fields(raw, ['schemaVersion', 'accountId', 'source', ...(Object.hasOwn(raw, 'slot') ? ['slot'] : []),
            ...(slot.kind === 'client' ? ['invitation', 'declaration'] : [])]);
        if (value.schemaVersion !== 1 || value.accountId !== account.accountId) fail();
        if (Object.hasOwn(value, 'slot') && !equal(value.slot, slot)) fail();
        const provisioning = { account, requestId: slot.requestId, source: value.source,
            ...(Object.hasOwn(value, 'slot') ? { slot } : {}) };
        const p = compileStarterProvisioning(provisioning);
        if (slot.kind === 'client') {
            const invitation = validateInvitationRecord(value.invitation);
            const declaration = fields(value.declaration, ['version', 'subjectKey', 'confirmed', 'receivedAt', 'verifiedAt', 'expiresAt']);
            if (declaration.version !== ASSERTION_VERSION || declaration.subjectKey !== p.subjectKey || declaration.confirmed !== true ||
                declaration.receivedAt !== p.createdAt || declaration.verifiedAt > Date.parse(p.createdAt) || declaration.expiresAt <= Date.parse(p.createdAt) ||
                invitation.expectedEmail !== account.email || invitation.invitationId !== p.invitationId ||
                ['tenantId','organisationId'].some(k => invitation[k] !== p.scope[k]) ||
                invitation.scheduleId !== p.schedule.scheduleId || invitation.scheduleDigest !== p.schedule.scheduleDigest) fail();
        }
        return provisioning;
    }
    function readerOnly(provisioning) {
        return Object.hasOwn(provisioning, 'slot') || usesUnlimitedConsultantPolicy(provisioning.source.offerInput);
    }
    async function registrationReadOnly(subjectKey) {
        return await signupRegistrations.readStorageLayout({ subjectKey }) === 'scoped';
    }
    async function sqlScope(customer, slot, requireWorkspaceProduct = false) {
        return database.withTenantTransaction(slot.tenantId, async tx => {
            await tx.query("SELECT set_config('nofries.subject_key',$1,true),set_config('nofries.organisation_id',$2,true),set_config('nofries.binding_id',$3,true),set_config('nofries.authority_id',$4,true),set_config('nofries.runtime_instance_id',$5,true)",
                [customer.current.subjectKey, slot.organisationId, slot.bindingId, slot.authorityId, dashboard.instanceId]);
            const found = await tx.query('SELECT preparation,activation FROM nofries.dashboard_starter_scopes WHERE tenant_id=$1 AND organisation_id=$2 AND subject_key=$3',
                [slot.tenantId, slot.organisationId, customer.current.subjectKey]);
            if (!found.rows.length) return null; if (found.rows.length !== 1) fail();
            const p = retainedStarterPreparation(found.rows[0].preparation), a = found.rows[0].activation;
            if (!equal(p.slot, slot) || p.subjectKey !== customer.current.subjectKey) fail();
            if (a !== null) {
                retainedStarterActivation(p, a);
                const binding = await tx.query('SELECT * FROM nofries.dashboard_identity_bindings WHERE binding_id=$1 AND tenant_id=$2 AND organisation_id=$3 AND subject_key=$4',
                    [slot.bindingId, slot.tenantId, slot.organisationId, p.subjectKey]);
                if (binding.rows.length !== 1) fail();
                const actual = normaliseBindingRow(binding.rows[0]);
                if (actual.status !== 'active' || actual.bindingId !== slot.bindingId || actual.subjectKey !== p.subjectKey ||
                    actual.validUntil !== a.validUntil) fail();
                const snapshot = await dataStorage.loadSnapshotForShare(tx, p.scope), at = dashboard.clock();
                const member = resolveActiveMembership(snapshot.membershipState, snapshot.tenantAggregate, { ...p.scope, subjectKey: p.subjectKey }, at);
                const eligibility = resolveEntitlements(snapshot.entitlementState, snapshot.tenantAggregate, p.scope, at, snapshot.flags);
                if (requireWorkspaceProduct && (eligibility.product?.grantId !== slot.grantId ||
                    eligibility.product.agreementRef !== slot.scheduleId || !eligibility.modules.overview.eligible)) fail();
                if (['membershipId','invitationId','grantEvidenceId','validFrom','validUntil'].some(k => member[k] !== actual[k])) fail();
                const heads = await tx.query('SELECT * FROM nofries.dashboard_admission_authorities WHERE authority_id=$1', [slot.authorityId]);
                if (heads.rows.length !== 1) fail();
                const decisions = await tx.query('SELECT * FROM nofries.dashboard_admission_decisions WHERE authority_id=$1 AND revision=$2', [slot.authorityId, heads.rows[0].head_revision]);
                if (decisions.rows.length !== 1) fail();
                const admission = normaliseAdmissionRows({ head: heads.rows[0], decision: decisions.rows[0] });
                if (!equal(admission.scope, p.scope) || admission.payload.decision !== 'eligible' ||
                    admission.payload.validFrom > at || admission.payload.validUntil <= at ||
                    admission.payload.approvedEffectSha256 !== a.admission.payload.approvedEffectSha256 ||
                    !equal(admission.payload.identityPolicyRef, a.admission.payload.identityPolicyRef)) fail();
            }
            return { preparation: p, activation: a };
        });
    }
    // Read exact completed evidence. The activation and journal executors are
    // deliberately not used: even their replay paths can repair durable state.
    async function completed(req, customer, account, slot, provisioning) {
        const p = compileStarterProvisioning(provisioning), scope = await sqlScope(customer, slot, true);
        if (!scope?.activation || !account.activation || !equal(scope.preparation, p)) return false;
        const a = scope.activation, reference = { ...p.scope, invitationId: p.invitationId };
        const receipt = await acceptanceJournal.readForInvitation(reference);
        const registered = await signupRegistrations.readForInvitation({ ...reference, subjectKey: p.subjectKey });
        if (!receipt || !registered) return false;
        if (!equal(receipt, a.acceptance) || registered.status !== 'pending_admission' ||
            ['subjectKey','tenantId','organisationId','invitationId','receiptId','termsVersion','termsDigest','scheduleId','scheduleDigest']
                .some(key => registered[key] !== receipt[key]) ||
            account.activation.subjectKey !== p.subjectKey || account.activation.activatedAt !== a.validFrom ||
            account.activation.validUntil !== a.validUntil ||
            account.activation.receiptId !== account.organisations[0].activationId) fail();
        if (Object.hasOwn(provisioning, 'slot') &&
            !equal(await accountStore.loadClientByBinding(account.accountId, slot.bindingId), slot)) return false;
        const digest = slot.kind === 'own' ? customer.current.invitationDigest
            : (await readJson(contextKey(slot)))?.invitation?.tokenDigest;
        if (typeof digest !== 'string') fail();
        const invitation = await invitations.read(digest);
        if (invitation === null) return false;
        const record = validateInvitationRecord(invitation);
        if (record.invitationId !== p.invitationId || record.status !== 'accepted' || !equal(record.acceptance, receipt)) return false;
        const final = await owner(req);
        if (!equal(final.customer.current, customer.current) || !equal(final.account, account) ||
            a.validUntil <= dashboard.clock()) fail();
        const again = await sqlScope(final.customer, slot, true);
        if (!again?.activation || !equal(again, scope)) fail();
        const latestInvitation = await invitations.read(digest);
        const latestRegistration = await signupRegistrations.readForInvitation({ ...reference, subjectKey: p.subjectKey });
        if (!equal(latestInvitation, invitation) || !equal(latestRegistration, registered) ||
            a.validUntil <= dashboard.clock() || Date.parse(final.customer.details.expiresAt) <= now() ||
            final.customer.assurance.expiresAt <= now() ||
            slot.kind === 'client' && now() - final.customer.assurance.verifiedAt > MAX_PROOF_AGE) fail();
        return true;
    }
    async function readOnlyState(req, current) {
        const match = await matchCurrent(current); if (!match) return null;
        const provisioning = await retained(match.account, match.slot);
        if (!readerOnly(provisioning)) {
            // Preserve the historical preparation read boundary before the
            // additional registration classifier; neither path repairs state.
            await sqlScope({ current }, match.slot);
            if (!await registrationReadOnly(current.subjectKey)) return null;
        }
        const captured = await owner(req);
        if (!equal(captured.customer.current, current) || !equal(captured.account, match.account)) fail();
        return await completed(req, captured.customer, match.account, match.slot, provisioning)
            ? { status: 'continue_to_dashboard', accountType: match.account.accountType }
            : { status: 'setup_read_only' };
    }
    const accounts = createStarterAccountAllocator({ store: accountStore, now, planId: starterPlanId,
        async captureOwner(req) {
            const { customer, account } = await owner(req), scope = await sqlScope(customer, account.organisations[0], true);
            if (!scope?.activation || scope.activation.validUntil <= dashboard.clock()) fail();
            const final = await owner(req); if (!equal(final.customer.current, customer.current)) fail();
            return { subjectKey: customer.current.subjectKey, email: customer.current.email };
        },
        async readActivation(req) {
            const { customer, account } = await owner(req), slot = account.organisations[0], scope = await sqlScope(customer, slot);
            if (!scope?.activation || scope.activation.validUntil <= dashboard.clock()) fail();
            return { email: account.email, subjectKey: customer.current.subjectKey, accountId: account.accountId,
                organisationId: slot.organisationId, receiptId: slot.activationId, activatedAt: scope.activation.validFrom };
        } });
    const details = createStarterSetupDetails({ accounts, store: setupStore, framework, now });
    const session = createDashboardCustomerSession({ browserAuthOptions: { ...dashboard.browserAuthOptions,
        ...(external ? external.browserAuthOptions : {}), customerPolicy: policy },
        identityPolicy: { ...identityPolicy, audience: env.NOFRIES_CUSTOMER_ENTRA_CLIENT_ID || identityPolicy.audience },
        proofStore: dashboard.proofStore, clock: dashboard.clock,
        readExternalRuntimeEpoch: dashboard.readExternalRuntimeEpoch, newRequestId: dashboard.newRequestId, requestBudgetMs: dashboard.requestBudgetMs });
    const runtime = createPostgresDashboardRuntimeRepository({ pool: dashboard.pool, clock: dashboard.clock,
        instanceId: dashboard.instanceId, historyBudget: dashboard.historyBudget, readExternalRuntimeEpoch: dashboard.readExternalRuntimeEpoch,
        newId: dashboard.newId, newGenerationToken: dashboard.newGenerationToken, captureRequest: req => session.captureRequest(req),
        readVerifiedOnboardingProof: async () => null, readPreparedCaseCapability: async () => null, authoriseOperatorOperation: () => false,
        async readStarterProvisioning(req, selector) {
            let account, deadline, selectedSubject;
            if (preparations.has(req)) {
                const proof = preparations.get(req), snapshot = verifiedSnapshot(proof, proof.requestId);
                if (selector.phase !== 'prepare' || snapshot.verifiedAt > now() || snapshot.expiresAt <= now()) fail();
                account = await accounts.readInitial(proof); deadline = new Date(snapshot.expiresAt).toISOString();
            } else {
                const captured = await owner(req); account = captured.account; selectedSubject = captured.customer.current.subjectKey;
                deadline = captured.customer.details.expiresAt;
            }
            const slot = account?.organisations.find(s => s.requestId === selector.requestId) ||
                // The runtime repeats this read while owning its SQL
                // transaction. owner() has checked immutable identity here;
                // use exact Blob lookup rather than borrowing a second SQL
                // connection through the allocator's captureOwner callback.
                (selectedSubject ? await accountStore.loadClient(account.accountId, selector.requestId) : null);
            if (!slot) fail();
            const provisioning = await retained(account, slot);
            if (readerOnly(provisioning)) fail();
            if (selectedSubject && provisioning.source.subjectKey !== selectedSubject ||
                !selectedSubject && (slot.kind !== 'own' || await legacyRecords.readSubject(provisioning.source.subjectKey) !== null)) fail();
            return { provisioning, deadline };
        } });
    async function archiveOffer(offer, scope, effectiveAt, expiresAt) {
        // Retained offer terms select their own version, not today's default.
        const plan = [LEGACY_PLAN_ID, THREE_MONTH_PLAN_ID].map(id => approvedStarterPlan(id))
            .find(candidate => candidate.termsDigest === offer.terms.termsDigest && candidate.termsVersion === offer.terms.termsVersion);
        if (!plan) fail();
        const terms = await legacyRecords.readTerms(plan.termsDigest);
        fields(terms, ['termsText', 'termsVersion', 'termsDigest']);
        if (terms.termsVersion !== plan.termsVersion || terms.termsDigest !== plan.termsDigest ||
            crypto.createHash('sha256').update(terms.termsText).digest('hex') !== plan.termsDigest) fail();
        await createExact(`customer-terms/${plan.termsDigest}.json`, terms);
        await createExact(scheduleArchiveKey(offer.schedule.scheduleId, offer.schedule.scheduleDigest), { schemaVersion: 1, ...offer.schedule });
        await createExact(termsOfferKey(scope.tenantId, scope.organisationId), { schemaVersion: 1, status: 'active', ...scope,
            ...offer.terms, scheduleId: offer.schedule.scheduleId, scheduleDigest: offer.schedule.scheduleDigest, effectiveAt, expiresAt });
    }
    async function setupSave(proof, input) {
        // Legacy verified-mailbox setup has no immutable subject yet. The
        // configured identity partition scopes this metadata-only transaction.
        if (await database.withTenantTransaction(identityPolicy.identityTenantId,
            readSignupRegistrationLayout) === 'scoped') fail();
        const previous = await details.read(proof);
        if (previous && usesUnlimitedConsultantPolicy(previous.offerInput)) fail();
        if (external) {
            const snapshot = verifiedSnapshot(proof, proof?.requestId);
            if (snapshot.source !== 'external-id-signup' || snapshot.providerKey !== external.providerKey) fail();
            // Read-only collision check first. This durable subject fence then
            // precedes any account allocation, details or offer write. It has
            // no TTL and survives deletion of subject authority: a changed
            // contact email cannot mint a replacement account/claim fence.
            await accounts.readInitial(snapshot);
            await createExact(`customer-starter/external-subject-reservations/${subjectHash(snapshot.subjectKey)}.json`,
                { schemaVersion: 1, subjectKey: snapshot.subjectKey, providerKey: external.providerKey, email: snapshot.email });
        }
        const saved = await details.save(proof, input), account = await accounts.readInitial(proof), slot = account.organisations[0];
        if (usesUnlimitedConsultantPolicy(saved.offerInput)) fail();
        const declaredAt = Date.parse(saved.assertion.receivedAt), expiresAt = declaredAt + 7 * 86400000;
        if (expiresAt <= now()) fail();
        await archiveOffer(saved.offer, { tenantId: slot.tenantId, organisationId: slot.organisationId }, declaredAt, expiresAt);
        // Retain the genuine source proof and deliberate declaration. The
        // external caller claims ownership with its authenticated subject.
        if (external) return;
        // A new verified proof can resume the retained attempt, but never change
        // its IDs, legal offer, target mailbox or delivery uncertainty.
        await details.read(proof);
        const invitation = await provisionCustomerInvitation({ requestId: slot.requestId, initialBindingId: slot.bindingId,
            identityTenantId: env.NOFRIES_ENTRA_TENANT_ID, identityPolicyId: dashboard.identityPolicy.policyId,
            publicOrigin: env.NOFRIES_PUBLIC_URL, graph, invitations, authorityContainer: container, now, sendMemberInvitation,
            readOtherAuthority: legacyRecords.readSubject,
            async verifyDelivery() {
                if (await graph.verifyMfaPolicy(env.NOFRIES_CUSTOMER_MFA_CONTEXT) !== true) fail();
                await details.read(proof); return true;
            },
            approval: { email: account.email, displayName: saved.offerInput.contact.name, tenantId: slot.tenantId,
                organisationId: slot.organisationId, ...saved.offer.terms, scheduleId: slot.scheduleId,
                scheduleDigest: saved.offer.schedule.scheduleDigest, accountType: account.accountType,
                expiresAt, authorityExpiresAt: starterAuthorityExpiry(expiresAt, account.planId) } });
        await createExact(contextKey(slot), { schemaVersion: 1, accountId: account.accountId,
            source: { offerInput: saved.offerInput, subjectKey: invitation.subjectKey, invitationId: invitation.invitationId,
                issuerSubjectKey: invitation.subjectKey, createdAt: saved.assertion.receivedAt } });
        const request = Object.freeze({}); preparations.set(request, proof);
        try { await runtime.starterProvisioning(request, { requestId: slot.requestId, phase: 'prepare' }); }
        finally { preparations.delete(request); }
    }
    async function matchCurrent(current) {
        const selected = await starterRecords.readSubject(current.subjectKey);
        if (selected === null) return null;
        if (!equal(selected, current) || await legacyRecords.readSubject(current.subjectKey) !== null) fail();
        const account = await accountFor(current.email), slot = account?.organisations[0];
        if (!slot || slot.bindingId !== current.bindingId || slot.organisationId !== current.organisationId || slot.tenantId !== current.tenantId) fail();
        return { account, slot };
    }
    async function consultant(req) {
        const selected = await owner(req), { account } = selected;
        if (now() - selected.customer.assurance.verifiedAt > MAX_PROOF_AGE) {
            const error = new Error('starter_reauthentication_required'); error.code = error.message; throw error;
        }
        if (account.accountType !== 'consultant' || !account.activation || account.activation.validUntil <= dashboard.clock()) fail();
        const scope = await sqlScope(selected.customer, account.organisations[0], true);
        if (!scope?.activation || scope.activation.validUntil !== account.activation.validUntil) fail();
        return selected;
    }
    function clientOperations({ verifyIdentity }) {
        const contexts = new WeakMap(), registrations = createPostgresSignupRegistrationStore({ database });
        const journal = createPostgresSignupAcceptanceJournal({ database });
        async function selection(req) {
            const requestId = contexts.get(req); if (!requestId) fail();
            const selected = await consultant(req), slot = await accounts.readClient(req, requestId);
            if (!slot) fail();
            const provisioning = await retained(selected.account, slot), context = await readJson(contextKey(slot));
            if (provisioning.source.subjectKey !== selected.customer.current.subjectKey) fail();
            return { ...selected, slot, provisioning, context };
        }
        const handlers = createJournaledSignupHandlers({ database, store: invitations, registrationStore: registrations, now,
            contextMode: 'verified-digest', verifyIdentity,
            async resolveContext(req) {
                const selected = await selection(req), digest = selected.context.invitation.tokenDigest;
                return await invitations.read(digest) === null ? null : { invitationDigest: digest, identityProofHandle: selected.customer.id };
            },
            async loadContinuationState(req) {
                const s = await selection(req), ref = { tenantId: s.slot.tenantId, organisationId: s.slot.organisationId,
                    invitationId: s.provisioning.source.invitationId };
                const receipt = await journal.readForInvitation(ref), registered = await registrations.readForInvitation({ ...ref, subjectKey: s.customer.current.subjectKey });
                if (!receipt || !registered || registered.status !== 'pending_admission' || registered.receiptId !== receipt.receiptId) fail();
                return { status: 'pending_admission' };
            },
            async resolveTerms(ref) {
                const at = ref.acceptedAt ?? now(), offer = termsOffer(await starterRecords.readTermsOffer(ref.tenantId, ref.organisationId), ref, at);
                const schedule = scheduleArchive(await starterRecords.readSchedule(ref.scheduleId, ref.scheduleDigest), offer);
                return { ...await starterRecords.readTerms(ref.termsDigest), scheduleId: schedule.scheduleId,
                    scheduleText: schedule.scheduleText, scheduleDigest: schedule.scheduleDigest };
            } });
        async function state(req, requestId) {
            contexts.set(req, requestId);
            try {
                const s = await selection(req), scope = await sqlScope(s.customer, s.slot);
                if (readerOnly(s.provisioning) || await registrationReadOnly(s.customer.current.subjectKey)) return await completed(req, s.customer, s.account, s.slot, s.provisioning)
                    ? { status: 'ready', organisationName: s.slot.organisationName } : { status: 'setup_read_only' };
                const p = compileStarterProvisioning(s.provisioning), ref = { ...p.scope, invitationId: p.invitationId };
                await archiveOffer(compileStarterSchedule(p.source.offerInput), p.scope, Date.parse(p.createdAt), s.context.invitation.expiresAt);
                if (!await invitations.read(s.context.invitation.tokenDigest) && !await journal.readForInvitation(ref)) {
                    try { await invitations.create(s.context.invitation); }
                    catch (error) { if (!equal(await invitations.read(s.context.invitation.tokenDigest), s.context.invitation)) throw error; }
                }
                if (!scope) await runtime.starterProvisioning(req, { requestId, phase: 'prepare' });
                const result = await handlers.loadState(req);
                if (result.status === 'pending_admission') {
                    await runtime.starterProvisioning(req, { requestId, phase: 'activate' });
                    return { status: 'ready', organisationName: s.slot.organisationName };
                }
                return result;
            } finally { contexts.delete(req); }
        }
        return Object.freeze({
            async list(req, query = {}) {
                const s = await consultant(req), clients = [];
                let readOnly = readerOnly(await retained(s.account, s.account.organisations[0])) ||
                    await registrationReadOnly(s.customer.current.subjectKey);
                const page = query.requestId ? { clients: [await accounts.readClient(req, query.requestId)], nextCursor: null }
                    : await accounts.listClients(req, { cursor: query.cursor || null, limit: 50 });
                for (const slot of page.clients) {
                    if (!slot) fail();
                    const scope = await sqlScope(s.customer, slot);
                    const saved = await readJson(contextKey(slot));
                    if (!s.account.organisations.some(item => item.requestId === slot.requestId) ||
                        saved && readerOnly(await retained(s.account, slot))) readOnly = true;
                    clients.push({ requestId: slot.requestId, organisationName: slot.organisationName,
                        status: scope?.activation ? 'ready' : saved ? 'pending' : 'details_required' });
                }
                await consultant(req);
                return readOnly || page.nextCursor !== null
                    ? { status: 'clients_read_only', clients, remaining: null, nextCursor: page.nextCursor }
                    : { status: 'clients', clients, remaining: approvedStarterPlan(s.account.planId).consultantClientOrganisations -
                        (s.account.organisations.length - 1) };
            },
            async execute(req, raw) {
                const input = copy(raw, 8192);
                if (input.action === 'create') {
                    fields(input, ['action', 'requestId', 'organisationName', 'details']); uuid(input.requestId);
                    const contact = starterRepresentativeDetails(input.details);
                    // Reject an already stale proof before consuming a durable
                    // client slot; retain the subsequent check for races.
                    const before = await consultant(req), existingSlot = await accounts.readClient(req, input.requestId);
                    if (readerOnly(await retained(before.account, before.account.organisations[0])) ||
                        await registrationReadOnly(before.customer.current.subjectKey)) {
                        if (existingSlot) return state(req, input.requestId);
                        return { status: 'setup_read_only' };
                    }
                    if (existingSlot) {
                        const existingContext = await readJson(contextKey(existingSlot));
                        if (existingContext !== null && readerOnly(await retained(before.account, existingSlot))) return state(req, input.requestId);
                        if (existingContext === null && !before.account.organisations.some(item => item.requestId === existingSlot.requestId))
                            return { status: 'setup_read_only' };
                    }
                    const slot = await accounts.reserveClient(req, { requestId: input.requestId, organisationName: input.organisationName });
                    const s = await consultant(req);
                    let saved = await readJson(contextKey(slot));
                    if (!saved) {
                        const createdAt = dashboard.clock(), offerInput = {
                            ...Object.fromEntries(['tenantId','organisationId','organisationName','grantId','scheduleId','kind'].map(k => [k, slot[k]])),
                            ...(s.account.planId === THREE_MONTH_PLAN_ID ? { planId: s.account.planId } : {}),
                            accountType: 'consultant', contact: { ...contact, email: s.account.email, authorityEvidenceId: crypto.randomUUID() }, framework: framework() };
                        const offer = compileStarterSchedule(offerInput);
                        const invitation = createInvitation({ email: s.account.email, tenantId: slot.tenantId, organisationId: slot.organisationId,
                            identityPolicyId: identityPolicy.policyId, ...offer.terms, scheduleId: slot.scheduleId, scheduleDigest: offer.schedule.scheduleDigest,
                            mfaRequired: !external, createdAt: Date.parse(createdAt), expiresAt: Math.min(Date.parse(s.account.activation.validUntil), Date.parse(createdAt) + 7 * 86400000) }, { now });
                        const candidate = { schemaVersion: 1, accountId: s.account.accountId,
                            ...(!s.account.organisations.some(item => item.requestId === slot.requestId) ? { slot } : {}), invitation: invitation.record,
                            declaration: { version: ASSERTION_VERSION, subjectKey: s.customer.current.subjectKey, confirmed: true, receivedAt: createdAt,
                                verifiedAt: s.customer.assurance.verifiedAt, expiresAt: Math.min(s.customer.assurance.expiresAt, Date.parse(s.customer.details.expiresAt)) },
                            source: { offerInput, subjectKey: s.customer.current.subjectKey, issuerSubjectKey: s.customer.current.subjectKey,
                                invitationId: invitation.record.invitationId, createdAt } };
                        await consultant(req);
                        try { await createExact(contextKey(slot), candidate); }
                        catch (error) { if (!await readJson(contextKey(slot))) throw error; }
                        saved = await readJson(contextKey(slot));
                    }
                    const reconciled = await retained(s.account, slot);
                    if (readerOnly(reconciled)) return state(req, input.requestId);
                    const p = compileStarterProvisioning(reconciled);
                    const { email, authorityEvidenceId, ...originalContact } = p.source.offerInput.contact;
                    if (!equal(originalContact, contact)) throw new Error('starter_details_locked');
                    await archiveOffer(compileStarterSchedule(p.source.offerInput), p.scope, Date.parse(p.createdAt), saved.invitation.expiresAt);
                    const existing = await invitations.read(saved.invitation.tokenDigest);
                    if (!existing) {
                        try { await invitations.create(saved.invitation); }
                        catch (error) { if (!equal(await invitations.read(saved.invitation.tokenDigest), saved.invitation)) throw error; }
                    }
                    return state(req, input.requestId);
                }
                fields(input, input.action === 'accept' ? ['action','requestId','terms'] : ['action','requestId']); uuid(input.requestId);
                if (!['resume','accept','resume_acceptance'].includes(input.action)) fail();
                contexts.set(req, input.requestId);
                try {
                    const selected = await selection(req);
                    if (readerOnly(selected.provisioning) || await registrationReadOnly(selected.customer.current.subjectKey)) return await completed(req, selected.customer, selected.account, selected.slot, selected.provisioning)
                        ? { status: 'ready', organisationName: selected.slot.organisationName } : { status: 'setup_read_only' };
                    if (input.action === 'accept') await handlers.acceptTerms({ req, input: input.terms });
                    if (input.action === 'resume_acceptance') await handlers.resumeAcceptance({ req });
                } finally { contexts.delete(req); }
                return state(req, input.requestId);
            }
        });
    }
    async function readSetup(proof) {
        const saved = await details.read(proof); if (!saved) return 'details_required';
        if (usesUnlimitedConsultantPolicy(saved.offerInput)) return 'setup_review_required';
        if (external) return 'secure_sign_in';
        const account = await accounts.readInitial(proof), slot = account.organisations[0];
        const attempt = await readJson(`customer-invitation-attempts/${uuid(slot.requestId)}.json`);
        if (attempt?.phase === 'delivering') return 'setup_review_required';
        return await readJson(contextKey(slot)) ? 'check_invitation' : 'details_required';
    }
    async function readRetainedSetup({ identity, assurance }) {
        if (!external || assurance.providerKey !== external.providerKey ||
            assurance.subjectKey !== identity.subjectKey) fail();
        // Email selects an index only. The durable immutable subject/provider
        // fences must agree before even the organisation name is projected.
        const reservation = await readJson(`customer-starter/external-subject-reservations/${subjectHash(identity.subjectKey)}.json`);
        if (reservation !== null && !equal(reservation, { schemaVersion: 1, subjectKey: identity.subjectKey,
            providerKey: external.providerKey, email: assurance.email })) fail();
        const account = await accountFor(assurance.email);
        const current = await starterRecords.readSubject(identity.subjectKey);
        if (await legacyRecords.readSubject(identity.subjectKey) !== null) fail();
        if (!account) { if (current !== null) fail(); return null; }
        if (account.identitySubjectKey !== identity.subjectKey || reservation === null) fail();
        const slot = account.organisations[0];
        const claimKey = `customer-starter/external-claims/${uuid(account.accountId)}.json`;
        const claim = await readJson(claimKey), completion = await readJson(claimKey.replace('.json', '.complete.json'));
        if (claim !== null) {
            fields(claim, ['schemaVersion', 'intent', 'providerKey', 'context', 'invitation', 'entry']);
            if (claim.schemaVersion !== 1 || claim.providerKey !== external.providerKey) fail();
        }
        if (completion !== null && (claim === null || !equal(completion, { schemaVersion: 1, claimSha256: hash(claim) }))) fail();
        if (current !== null && claim === null) fail();
        if (account.activation !== null) {
            if (account.activation.subjectKey !== identity.subjectKey || current === null || completion === null) fail();
            const active = authority(current, identity.subjectKey, now());
            if (active.email !== account.email || active.accountType !== account.accountType ||
                ['tenantId', 'organisationId', 'bindingId'].some(key => active[key] !== slot[key])) fail();
        }
        const declaration = await setupStore.load(starterSetupKey(slot.organisationId));
        const input = { accountType: account.accountType, organisationName: slot.organisationName };
        if (declaration === null) {
            if (claim !== null || completion !== null || current !== null) fail();
            return { complete: false, input };
        }
        const saved = starterSetupRecord(declaration), original = saved.assertion.proof;
        const readOnly = usesUnlimitedConsultantPolicy(saved.offerInput);
        if (original.source !== 'external-id-signup' || original.subjectKey !== identity.subjectKey ||
            original.providerKey !== external.providerKey || saved.accountId !== account.accountId ||
            saved.requestId !== slot.requestId || saved.assertion.email !== account.email ||
            saved.offerInput.accountType !== account.accountType || saved.offerInput.kind !== 'own' ||
            ['tenantId', 'organisationId', 'organisationName', 'grantId', 'scheduleId'].some(key => saved.offerInput[key] !== slot[key]) ||
            completion === null && Date.parse(saved.assertion.receivedAt) + 7 * 86400000 <= now()) fail();
        const { email, authorityEvidenceId, ...contact } = saved.offerInput.contact;
        if (email !== assurance.email || authorityEvidenceId !== saved.representativeEvidenceId) fail();
        input.details = { ...contact, authorityConfirmed: true };
        if (claim !== null) {
            const originalAccount = { ...account, activation: null, organisations: [slot] };
            validateRetainedExternalStarterClaim(claim, { account: originalAccount, details: saved,
                subjectKey: identity.subjectKey, providerKey: external.providerKey,
                identityPolicyId: identityPolicy.policyId, now: now() });
        }
        const owned = assurance.stage !== 'setup' || account.activation !== null;
        if (current !== null && (!owned || completion === null) && !equal(current, claim.entry)) fail();
        if (completion !== null) {
            if (current === null) fail();
            const active = authority(current, identity.subjectKey, now());
            if (active.email !== account.email || active.accountType !== account.accountType ||
                ['tenantId', 'organisationId', 'bindingId'].some(key => active[key] !== slot[key])) fail();
            return { complete: true, ...(readOnly ? { readOnly: true } : {}), ...(account.activation === null ? { input } : {}) };
        }
        return { complete: false, input, ...(readOnly ? { readOnly: true } : {}) };
    }
    return Object.freeze({
        ...(external ? { async claim({ proof, identity, beforeMutation }) {
            await beforeMutation();
            if (await registrationReadOnly(identity.subjectKey)) fail();
            const account = await accountFor(proof.email); if (!account) fail();
            const saved = starterSetupRecord(await setupStore.load(starterSetupKey(account.organisations[0].organisationId)));
            if (usesUnlimitedConsultantPolicy(saved.offerInput)) fail();
            const slot = account.organisations[0], declaredAt = Date.parse(saved.assertion.receivedAt);
            // Details can survive a failed archive write. Reconcile the exact
            // retained offer before publishing any subject authority; retry
            // does not record consent or replace a withdrawn offer.
            await beforeMutation();
            await archiveOffer(saved.offer, { tenantId: slot.tenantId, organisationId: slot.organisationId },
                declaredAt, declaredAt + 7 * 86400000);
            const claim = createExternalStarterClaim({ container, invitations, identityPolicyId: identityPolicy.policyId,
                providerKey: external.providerKey, readOtherAuthority: legacyRecords.readSubject, now });
            return claim({ account, details: saved, subjectKey: identity.subjectKey, async beforeMutation() {
                await beforeMutation();
                const latest = await accountFor(proof.email), current = await setupStore.load(starterSetupKey(account.organisations[0].organisationId));
                if (!equal(current, saved) || !equal(latest, account)) fail();
                if (proof.expiresAt <= now()) fail();
            } });
        } } : {}),
        clientOperations,
        readOnlyState,
        async clientSetupAvailable(current) { return current.accountType === 'consultant' && await matchCurrent(current) !== null; },
        setup: Object.freeze({ save: setupSave, ...(external ? { readRetained: readRetainedSetup } : {}), async findAccount(proof) {
            // Called only after mailbox verification. Never allocate, rename,
            // replay an invitation or disclose another mailbox's account.
            const account = await accountFor(proof.email);
            if (!account) return null;
            const own = account.organisations[0];
            const context = await readJson(contextKey(own));
            if (external) {
                const staged = await setupStore.load(starterSetupKey(own.organisationId));
                if (staged) starterSetupRecord(staged);
                return { accountType: account.accountType, organisationName: own.organisationName,
                    nextStep: staged ? 'secure_sign_in' : proof.accountType === null ? 'setup_review_required' : 'details_required' };
            }
            // The original proof can resume a reservation whose invitation has
            // not started. Reuse proof-hash validation and the delivery fence;
            // another setup request cannot turn uncertainty into a retry.
            const nextStep = !context && account.setupRequestId === proof.requestId
                ? await readSetup(proof) : context ? 'account_found' : 'setup_review_required';
            return { accountType: account.accountType, organisationName: own.organisationName,
                nextStep };
        }, read: readSetup }),
        async readRecoveryContext(req, current) {
            if (external) return null;
            if (await registrationReadOnly(current.subjectKey)) return null;
            const match = await matchCurrent(current); if (!match) return null;
            // This is retained evidence only. Missing invitation state can hide
            // revocation, so a separate exact recovery authorization is required
            // before a caller may use this context to offer genuine new consent.
            async function capture() {
                const captured = await owner(req), { account } = captured, slot = account.organisations[0];
                if (!equal(captured.customer.current, current) || !equal(slot, match.slot) || slot.kind !== 'own') fail();
                // Activated accounts use the ordinary durable consent and
                // admission path, including recovery of a pending Blob mirror.
                if (account.activation !== null) return null;
                if (!equal(account, match.account)) fail();
                const preparation = compileStarterProvisioning(await retained(account, slot));
                if (readerOnly({ source: preparation.source })) return null;
                const references = { subjectKey: preparation.subjectKey, ...preparation.scope,
                    invitationId: preparation.invitationId, ...preparation.terms,
                    scheduleId: preparation.schedule.scheduleId, scheduleDigest: preparation.schedule.scheduleDigest };
                if (Object.entries(references).some(([key, value]) => current[key] !== value)) fail();
                const scope = await sqlScope(captured.customer, slot);
                if (!scope || !equal(scope.preparation, preparation)) fail();
                if (scope.activation !== null) return null;
                const attempt = fields(copy(await readJson(`customer-invitation-attempts/${uuid(slot.requestId)}.json`), LIMIT),
                    ['schemaVersion', 'intent', 'phase', 'record', 'prior', 'priorSubject', 'entry', 'result']);
                if (attempt.schemaVersion !== 1 || attempt.phase !== 'complete' || attempt.prior !== null ||
                    ![null, current.subjectKey].includes(attempt.priorSubject) ||
                    typeof attempt.intent !== 'string' || !/^[a-f0-9]{64}$/.test(attempt.intent) ||
                    !equal(attempt.entry, current) || !equal(attempt.result, { subjectKey: current.subjectKey,
                        invitationId: current.invitationId, status: 'pending_admission' })) fail();
                // Keep the detached plain-data snapshot from copy(); the
                // invitation validator's clone can belong to another JS realm.
                const invitation = attempt.record;
                validateInvitationRecord(invitation);
                if (invitation.status !== 'invited' || invitation.revision !== 0 || invitation.acceptance !== null ||
                    invitation.tokenDigest !== current.invitationDigest || invitation.expectedEmail !== account.email ||
                    invitation.identityPolicyId !== dashboard.identityPolicy.policyId || invitation.mfaRequired !== true ||
                    invitation.createdAt < Date.parse(preparation.createdAt) || invitation.createdAt > now() ||
                    invitation.expiresAt <= now() || Object.entries(references)
                        .filter(([key]) => key !== 'subjectKey').some(([key, value]) => invitation[key] !== value)) fail();
                const approval = { email: account.email, displayName: preparation.source.offerInput.contact.name,
                    ...preparation.scope, ...preparation.terms, scheduleId: preparation.schedule.scheduleId,
                    scheduleDigest: preparation.schedule.scheduleDigest, accountType: account.accountType,
                    expiresAt: invitation.expiresAt, authorityExpiresAt: current.expiresAt };
                if (attempt.intent !== hash({ approval, identityTenantId: env.NOFRIES_ENTRA_TENANT_ID,
                    identityPolicyId: dashboard.identityPolicy.policyId, publicOrigin: env.NOFRIES_PUBLIC_URL,
                    expectedAuthorityRevision: null, initialBindingId: slot.bindingId })) fail();
                return { accountId: account.accountId, preparationSha256: hash(preparation), invitation };
            }
            const before = await capture(); if (before === null) return null;
            const latest = await capture(); if (latest === null) return null;
            if (!equal(before, latest)) fail();
            // Provider/storage reads above may consume the session or invitation
            // window. The final owner read preserves the established live policy
            // check, and no asynchronous work follows the final time check.
            const final = await owner(req);
            if (!equal(final.customer.current, current)) fail();
            if (final.account.activation !== null) return null;
            if (!equal(final.account, match.account) || latest.invitation.expiresAt <= now()) fail();
            return freeze(latest);
        },
        async prepared(req, current) {
            const match = await matchCurrent(current); if (!match) return null;
            const provisioning = await retained(match.account, match.slot);
            if (readerOnly(provisioning) || await registrationReadOnly(current.subjectKey)) return (await readOnlyState(req, current))?.status === 'continue_to_dashboard';
            const captured = await owner(req);
            let scope = await sqlScope(captured.customer, match.slot);
            if (!scope) {
                await runtime.starterProvisioning(req, { requestId: match.slot.requestId, phase: 'prepare' });
                scope = await sqlScope(captured.customer, match.slot);
            }
            if (!scope) fail();
            if (!equal(scope.preparation, compileStarterProvisioning(await retained(match.account, match.slot)))) fail();
            return true;
        },
        async activate(req, current) {
            const match = await matchCurrent(current); if (!match) return false;
            const provisioning = await retained(match.account, match.slot);
            if (readerOnly(provisioning) || await registrationReadOnly(current.subjectKey)) return (await readOnlyState(req, current))?.status === 'continue_to_dashboard';
            await runtime.starterProvisioning(req, { requestId: match.slot.requestId, phase: 'activate' });
            await accounts.activate(req); return true;
        },
        async resolveQuota(input) {
            // Called while the assessment transaction already owns a SQL
            // connection. Read the durable policy/activation mirror through
            // Blob, never borrow another connection from the same pool. The
            // existing SQL transaction still decides membership, current grant,
            // feature eligibility and the atomic finite submission counter.
            const selection = normaliseNcscSubmissionSelection(input);
            const raw = await starterRecords.readSubject(selection.actorSubjectKey);
            if (raw === null) return null;
            const current = authority(raw, selection.actorSubjectKey, now());
            if (await legacyRecords.readSubject(selection.actorSubjectKey) !== null) fail();
            const account = await accountFor(current.email), own = account?.organisations[0];
            if (!own || own.bindingId !== current.bindingId || own.tenantId !== current.tenantId ||
                own.organisationId !== current.organisationId || account.accountType !== current.accountType ||
                !account.activation || account.activation.subjectKey !== current.subjectKey ||
                account.activation.receiptId !== own.activationId) fail();
            let slot = account.organisations.find(s => s.tenantId === selection.tenantId && s.organisationId === selection.organisationId);
            if (!slot && account.accountType === 'consultant') {
                // Exact scoped lookup, never a scan through the Consultant's
                // other organisations while holding an assessment connection.
                const context = await readJson(contextKey(selection));
                if (context?.accountId === account.accountId && context.slot) {
                    const saved = await accountStore.loadClient(account.accountId, uuid(context.slot.requestId));
                    if (!saved || !equal(saved, context.slot) || saved.tenantId !== selection.tenantId ||
                        saved.organisationId !== selection.organisationId) fail();
                    slot = saved;
                }
            }
            if (!slot) return null;
            // A separately approved replacement grant uses the ordinary durable
            // policy resolver. Only the original starter grant/schedule belongs
            // to this fixed policy, whose expiry must continue to fail closed.
            if (selection.productGrantId !== slot.grantId || selection.agreementRef !== slot.scheduleId) return null;
            const p = compileStarterProvisioning(await retained(account, slot));
            if (p.subjectKey !== current.subjectKey) fail();
            const policy = { schemaVersion: 1, ...p.scope, productGrantId: p.slot.grantId, agreementRef: p.slot.scheduleId,
                moduleId: MODULE_ID, profileRef: ACCEPTED_PROFILE_REF, policyId: p.slot.activationId, policyRevision: 0,
                validFrom: account.activation.activatedAt, validUntil: account.activation.validUntil, limit: 'assessment_runs', amount: 1 };
            return createNcscSubmissionQuotaResolver({ schemaVersion: 1, policies: [policy] })(selection);
        }
    });
}
module.exports = { createStarterSignupProduction };
