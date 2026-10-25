const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const {
    answerLabel,
    getAssessmentBlueprint,
    getQuestionMap,
    isQuestionVisible
} = require('./salesBlueprint');
const { getProductRequestIdentity } = require('./identity');
const {
    SalesRepositoryError,
    createSalesWorkspaceRepository,
    enqueueDurableOperation,
    getDurableOperation,
    updateDurableOperation
} = require('./salesWorkspaceRepository');
const {
    assertCapability,
    resolveTenantAccess
} = require('./tenantAccess');
const {
    apiSecurityHeaders,
    assertSameOriginForMutation
} = require('./securityHeaders');
const {
    checkRateLimit,
    getClientKeyFromHeaders,
    rateLimitHeaders
} = require('./abuseProtection');
const { requestBodySize } = require('./requestLimits');
const { getLifecycleService } = require('./appLifecycleRuntime');
const {
    buildLifecycleScopingPreview,
    createAssessmentPrefill,
    mergePrefillAnswers
} = require('./scoping/lifecycleScopingMapper');
const { MANAGED_IT_POLICY, managedItPolicyIdentity } = require('./managedItPolicy');
const { PRICE_VERSION, STANDARD_PRICE, estimateManagedItPrice } = require('./mspPricing');
const { createProposalReviewAgent } = require('./agents/proposalReviewAgent');
const {
    assessProposalCommercialPolicy,
    createCommercialSummary,
    normaliseCommercialSummary,
    validateProposalDraft
} = require('./proposalQuality');
const {
    createProposalApprovalSeal,
    materialiseProposalApprovalSnapshot,
    verifyProposalApprovalSeal
} = require('./proposalApprovalSeal');

const DATA_DIR = process.env.NOFRIES_DATA_DIR || path.join(os.tmpdir(), 'nofries-data');
const MAX_CATALOGUE_BYTES = 2 * 1024 * 1024;
const MAX_CUSTOMERS = 250;
const MAX_REQUEST_BYTES = 3 * 1024 * 1024;
const CUSTOMER_DELETION_CLAIM_LEASE_MS = 5 * 60 * 1000;
const ALLOWED_CLASSIFICATIONS = new Set(['public', 'internal', 'restricted']);
const ALLOWED_RECOMMENDATION_DECISIONS = new Set(['pending', 'accepted', 'rejected', 'validate']);
const ALLOWED_ROADMAP_STAGES = new Set(['now', 'next', 'later']);
const ALLOWED_COMPONENT_STATUSES = new Set(['included', 'needs_confirmation', 'excluded']);
const MANAGED_IT_BUNDLE_KEY = 'managed-it-core';
const CATALOGUE_COLUMNS = [
    'service_key',
    'service_name',
    'category',
    'customer_outcome',
    'ideal_customer',
    'gap_indicators',
    'prerequisites',
    'disqualifiers',
    'discovery_questions',
    'evidence_required',
    'related_services',
    'sales_owner',
    'source_documents',
    'classification',
    'strong_fit_signals',
    'potential_fit_signals',
    'prerequisite_signals',
    'disqualifier_signals'
];

let repository;

async function handleSalesRequest(req, routeContext = {}) {
    assertSameOriginForMutation(req);
    const identity = await getProductRequestIdentity(req);
    const access = resolveTenantAccess(identity);
    if (!access.allowed) {
        throw salesError(403, 'This Microsoft identity has not been approved for a No Fries workspace', {
            code: 'tenant_access_required',
            reason: access.reason
        });
    }

    const method = String(req.method || 'GET').toUpperCase();
    const routePath = getSalesPath(req, routeContext);
    const segments = routePath.split('/').filter(Boolean).map(decodeURIComponent);

    if (method === 'GET' && segments.length === 1 && segments[0] === 'app.js') {
        assertCapability(access, 'customer:read');
        const body = protectedSalesApplicationSource();
        return raw(200, body, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'private, no-store, max-age=0',
            'X-Content-Type-Options': 'nosniff'
        });
    }

    if (method === 'GET' && segments.length === 1 && segments[0] === 'bootstrap') {
        assertCapability(access, 'customer:read');
        return json(200, buildBootstrap(await getRepository().read(access), access));
    }

    if (method === 'GET' && segments.length === 1 && segments[0] === 'blueprint') {
        assertCapability(access, 'assessment:read');
        return json(200, getAssessmentBlueprint());
    }

    if (segments[0] === 'catalogue') {
        return handleCatalogue(method, segments.slice(1), getJsonBody(req), access);
    }

    if (segments[0] === 'customers') {
        return handleCustomers(method, segments.slice(1), getJsonBody(req), access);
    }

    if (segments[0] === 'assessments') {
        return handleAssessments(method, segments.slice(1), getJsonBody(req), access);
    }

    if (segments[0] === 'lifecycle-handoffs') {
        return handleLifecycleHandoffs(method, segments.slice(1), getJsonBody(req), access);
    }

    if (segments[0] === 'proposals') {
        return handleProposals(method, segments.slice(1), getJsonBody(req), getQuery(req), access);
    }

    if (segments[0] === 'integrations' && segments[1] === 'dynamics') {
        return handleDynamics(method, segments.slice(2), getJsonBody(req), access);
    }

    if (segments[0] === 'operations') {
        assertCapability(access, 'integration:handoff');
        if (method !== 'GET') {
            return json(405, { error: 'Method not allowed', code: 'method_not_allowed' }, { Allow: 'GET' });
        }
        const state = await getRepository().read(access);
        if (segments.length === 1) {
            return json(200, {
                revision: state.revision,
                operations: Object.values(state.operationsById)
                    .filter((operation) => operation.status !== 'completed')
                    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
                    .slice(0, 200)
            });
        }
        if (segments.length === 2) {
            const operation = getDurableOperation(state, { operationId: cleanText(segments[1], 180) });
            if (!operation) throw salesError(404, 'Durable operation not found', { code: 'operation_not_found' });
            return json(200, { revision: state.revision, operation });
        }
    }

    if (method === 'GET' && segments.length === 1 && segments[0] === 'audit') {
        assertCapability(access, 'audit:read');
        const state = await getRepository().read(access);
        return json(200, {
            revision: state.revision,
            events: state.audit.slice(-250).reverse()
        });
    }

    return json(404, { error: 'Sales workspace route not found', code: 'route_not_found' });
}

async function handleCatalogue(method, segments, body, access) {
    if (method === 'GET' && !segments.length) {
        assertCapability(access, 'catalogue:read');
        const state = await getRepository().read(access);
        return json(200, {
            revision: state.revision,
            publishedVersionId: state.catalogue.publishedVersionId,
            published: getPublishedCatalogue(state),
            versions: state.catalogue.versions.map(publicCatalogueVersion)
        });
    }

    if (method === 'GET' && segments[0] === 'template') {
        assertCapability(access, 'catalogue:write');
        return raw(200, `${CATALOGUE_COLUMNS.join(',')}\n`, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="nofries-service-catalogue-template.csv"',
            'Cache-Control': 'private, no-store'
        });
    }

    if (method === 'POST' && segments[0] === 'import') {
        assertCapability(access, 'catalogue:write');
        const csv = String(body.csv || '');
        if (!csv.trim()) {
            return json(400, { error: 'Catalogue CSV content is required', code: 'catalogue_csv_required' });
        }
        if (Buffer.byteLength(csv, 'utf8') > MAX_CATALOGUE_BYTES) {
            return json(413, { error: 'Catalogue CSV is too large', code: 'catalogue_too_large' });
        }

        const validation = validateCatalogueCsv(csv);
        if (validation.errors.length) {
            return json(422, validation);
        }

        const versionId = createId('catalogue');
        const result = await getRepository().mutate(access, {
            expectedRevision: body.expectedRevision,
            action: 'catalogue.imported',
            targetType: 'catalogue_version',
            targetId: versionId,
            summary: `${validation.services.length} services imported as a draft`
        }, (state) => {
            const versionNumber = state.catalogue.versions.length + 1;
            const version = {
                id: versionId,
                versionNumber,
                label: cleanText(body.label || `Catalogue ${versionNumber}`, 120),
                status: 'draft',
                serviceCount: validation.services.length,
                services: validation.services,
                warnings: validation.warnings,
                importedBy: access.user.email,
                importedAt: new Date().toISOString(),
                publishedBy: '',
                publishedAt: ''
            };
            state.catalogue.versions.push(version);
            return version;
        });

        return json(201, {
            revision: result.state.revision,
            version: result.result,
            warnings: validation.warnings
        });
    }

    if (method === 'POST' && segments[0] === 'publish') {
        assertCapability(access, 'catalogue:publish');
        const versionId = cleanText(body.versionId, 180);
        const result = await getRepository().mutate(access, {
            expectedRevision: body.expectedRevision,
            action: 'catalogue.published',
            targetType: 'catalogue_version',
            targetId: versionId,
            summary: 'Service catalogue approved and published'
        }, (state) => {
            const version = state.catalogue.versions.find((candidate) => candidate.id === versionId);
            if (!version) {
                throw salesError(404, 'Catalogue version not found');
            }
            if (!version.services.length) {
                throw salesError(400, 'An empty catalogue cannot be published');
            }
            state.catalogue.versions.forEach((candidate) => {
                if (candidate.status === 'published') {
                    candidate.status = 'retired';
                }
            });
            version.status = 'published';
            version.publishedBy = access.user.email;
            version.publishedAt = new Date().toISOString();
            state.catalogue.publishedVersionId = version.id;
            return version;
        });
        return json(200, {
            revision: result.state.revision,
            published: result.result
        });
    }

    return json(405, { error: 'Method not allowed', code: 'method_not_allowed' }, { Allow: 'GET, POST' });
}

async function handleCustomers(method, segments, body, access) {
    if (method === 'GET' && !segments.length) {
        assertCapability(access, 'customer:read');
        const state = await getRepository().read(access);
        return json(200, {
            revision: state.revision,
            customers: state.customers.map(publicCustomer)
        });
    }

    if (method === 'POST' && !segments.length) {
        assertCapability(access, 'customer:write');
        const name = cleanText(body.name, 180);
        if (!name) {
            return json(400, { error: 'Customer name is required', code: 'customer_name_required' });
        }
        const customerId = createId('customer');
        const result = await getRepository().mutate(access, {
            expectedRevision: body.expectedRevision,
            action: 'customer.created',
            targetType: 'customer',
            targetId: customerId,
            summary: name
        }, (state) => {
            if (state.customers.length >= MAX_CUSTOMERS) {
                throw salesError(409, 'This pilot workspace has reached its customer limit', {
                    code: 'customer_limit'
                });
            }
            const now = new Date().toISOString();
            const customer = {
                id: customerId,
                name,
                industry: cleanText(body.industry, 120),
                region: cleanText(body.region, 120),
                segment: cleanText(body.segment, 120),
                accountOwner: cleanText(body.accountOwner, 160),
                dynamicsAccountId: cleanText(body.dynamicsAccountId, 180),
                notes: cleanText(body.notes, 4000),
                classification: normaliseClassification(body.classification || 'internal'),
                createdBy: access.user.email,
                createdAt: now,
                updatedBy: access.user.email,
                updatedAt: now
            };
            state.customers.push(customer);
            return customer;
        });
        return json(201, {
            revision: result.state.revision,
            customer: publicCustomer(result.result)
        });
    }

    const customerId = segments[0];
    if (!customerId) {
        return json(404, { error: 'Customer not found' });
    }

    if (method === 'GET' && segments.length === 1) {
        assertCapability(access, 'customer:read');
        const state = await getRepository().read(access);
        const customer = findCustomer(state, customerId);
        return json(200, {
            revision: state.revision,
            customer: publicCustomer(customer),
            assessments: state.assessments.filter((item) => item.customerId === customerId).map(publicAssessmentSummary),
            proposals: state.proposals.filter((item) => item.customerId === customerId).map(publicProposalSummary)
        });
    }

    if ((method === 'PATCH' || method === 'PUT') && segments.length === 1) {
        assertCapability(access, 'customer:write');
        const result = await getRepository().mutate(access, {
            expectedRevision: body.expectedRevision,
            action: 'customer.updated',
            targetType: 'customer',
            targetId: customerId,
            summary: 'Customer profile updated'
        }, (state) => {
            const customer = findCustomer(state, customerId);
            assignCustomerFields(customer, body, access.user.email);
            return customer;
        });
        return json(200, {
            revision: result.state.revision,
            customer: publicCustomer(result.result)
        });
    }

    if (method === 'DELETE' && segments.length === 1) {
        assertCapability(access, 'tenant:admin');
        const deletionState = await getRepository().read(access);
        const existingDeletionCustomer = deletionState.customers.find((customer) => customer.id === customerId);
        if (!existingDeletionCustomer) {
            const deletionReceipt = customerDeletionReceipt(deletionState, customerId);
            if (!deletionReceipt) findCustomer(deletionState, customerId);
            assertCustomerDeletionReceipt(deletionReceipt, customerId, body);
            if (deletionReceipt.status === 'target_completed') {
                return json(200, {
                    revision: deletionState.revision,
                    deleted: true,
                    recovered: true,
                    customerId,
                    lifecycleUnlink: {
                        status: cleanText(deletionReceipt.lifecycleOutcome || 'completed', 40),
                        lifecycleRevision: Number(deletionReceipt.lifecycleRevision || 0)
                    }
                });
            }
            let completedFence;
            try {
                completedFence = await getLifecycleService().completeScopingDeletion(
                    access,
                    deletionReceipt.lifecycleOrganisationId,
                    {
                        deletionClaimId: deletionReceipt.deletionClaimId,
                        deletionFenceGeneration: deletionReceipt.deletionFenceGeneration
                    }
                );
                const completedState = await markCustomerDeletionTargetCompleted(
                    getRepository(),
                    access,
                    customerId,
                    deletionReceipt.deletionClaimId,
                    deletionReceipt.deletionFenceGeneration,
                    completedFence.revision
                );
                return json(200, {
                    revision: completedState.revision,
                    deleted: true,
                    recovered: true,
                    customerId,
                    lifecycleUnlink: {
                        status: 'completed',
                        lifecycleRevision: completedFence.revision
                    }
                });
            } catch (completionError) {
                if (isLifecycleOrganisationNotFound(completionError)) {
                    try {
                        const completedState = await markCustomerDeletionTargetCompleted(
                            getRepository(),
                            access,
                            customerId,
                            deletionReceipt.deletionClaimId,
                            deletionReceipt.deletionFenceGeneration,
                            0,
                            'not_found'
                        );
                        return json(200, {
                            revision: completedState.revision,
                            deleted: true,
                            recovered: true,
                            customerId,
                            lifecycleUnlink: { status: 'not_found', lifecycleRevision: 0 }
                        });
                    } catch (receiptError) {
                        throw customerDeletionTargetCompletionError(deletionReceipt, receiptError);
                    }
                }
                throw customerDeletionTargetCompletionError(deletionReceipt, completionError);
            }
        }
        assertWorkspaceRevision(deletionState, body.expectedRevision);
        const deletionCustomer = existingDeletionCustomer;
        const claimAt = new Date();
        assertCustomerDeletionAllowed(deletionState, deletionCustomer, body, {
            allowExpiredDeletionClaim: true,
            at: claimAt
        });
        const deletionClaimId = createId('customer_deletion_claim');
        const claimed = await getRepository().mutate(access, {
            // Persist the source-side fence before touching Lifecycle. A concurrent
            // delete must fail this claim and therefore cannot enter the unlink gap.
            expectedRevision: deletionState.revision,
            action: 'customer.deletion_claimed',
            targetType: 'customer',
            targetId: customerId,
            summary: 'Customer deletion claimed before lifecycle unlink'
        }, (state) => {
            const customer = findCustomer(state, customerId);
            assertCustomerDeletionAllowed(state, customer, body, {
                allowExpiredDeletionClaim: true,
                at: claimAt
            });
            const lifecycleRelink = customer.lifecycleOrganisationId
                ? customerScopingRelink(state, customer)
                : null;
            const priorClaimId = cleanText(customer.deletionClaim && customer.deletionClaim.id, 180);
            const deletionFenceGeneration = Math.max(
                Number(customer.deletionFenceGeneration || 0),
                Number(customer.deletionClaim && customer.deletionClaim.generation || 0)
            ) + 1;
            customer.deletionClaim = {
                id: deletionClaimId,
                status: 'claimed',
                generation: deletionFenceGeneration,
                claimedAt: claimAt.toISOString(),
                claimedBy: access.user.email,
                leaseUntil: new Date(claimAt.getTime() + CUSTOMER_DELETION_CLAIM_LEASE_MS).toISOString(),
                priorClaimId,
                lifecycleOrganisationId: cleanText(customer.lifecycleOrganisationId, 180),
                assessmentId: lifecycleRelink && lifecycleRelink.assessmentId || ''
            };
            if (lifecycleRelink) {
                Object.assign(lifecycleRelink, {
                    deletionClaimId,
                    deletionFenceGeneration,
                    deletionClaimLeaseUntil: customer.deletionClaim.leaseUntil,
                    restoreDeletionClaim: true
                });
            }
            return { customer, lifecycleRelink };
        });
        const claimedCustomer = claimed.result.customer;
        const lifecycleRelink = claimed.result.lifecycleRelink;
        let lifecycleUnlink = { status: 'not_linked' };
        let lifecycleCompletionRequired = false;
        if (claimedCustomer.lifecycleOrganisationId) {
            try {
                const lifecycle = await getLifecycleService().unlinkScopingRecords(
                    access,
                    claimedCustomer.lifecycleOrganisationId,
                    {
                        salesCustomerId: claimedCustomer.id,
                        assessmentId: lifecycleRelink.assessmentId,
                        deletionClaimId,
                        deletionFenceGeneration: claimedCustomer.deletionClaim.generation,
                        deletionClaimLeaseUntil: claimedCustomer.deletionClaim.leaseUntil
                    }
                );
                lifecycleUnlink = { status: 'unlinked', lifecycleRevision: lifecycle.revision };
                lifecycleCompletionRequired = true;
            } catch (error) {
                if (isLifecycleOrganisationNotFound(error)) {
                    // A confirmed missing target cannot retain or rematerialise a
                    // scoping link. The exact source claim may therefore complete
                    // without attempting target compensation or completion.
                    lifecycleUnlink = { status: 'not_found', lifecycleRevision: 0 };
                } else {
                    let claimState;
                    try {
                        claimState = await getRepository().read(access);
                    } catch (readError) {
                        throw salesError(409, 'Lifecycle unlink failed and deletion-claim ownership could not be confirmed', {
                            code: 'customer_deletion_source_reconciliation_required',
                            sourceErrorCode: cleanText(error && error.details && error.details.code || 'lifecycle_unlink_failed', 120),
                            reconciliationErrorCode: cleanText(
                                readError && readError.details && readError.details.code || 'sales_state_read_failed',
                                120
                            ),
                            lifecycleOrganisationId: claimedCustomer.lifecycleOrganisationId,
                            salesCustomerId: claimedCustomer.id,
                            deletionClaimId
                        });
                    }
                    const claimCustomer = claimState.customers.find((customer) => customer.id === customerId);
                    if (
                        !claimCustomer ||
                        !claimCustomer.deletionClaim ||
                        cleanText(claimCustomer.deletionClaim.id, 180) !== deletionClaimId
                    ) {
                        throw salesError(409, 'This deletion attempt was superseded while Lifecycle unlink was in progress', {
                            code: 'customer_deletion_claim_superseded',
                            lifecycleOrganisationId: claimedCustomer.lifecycleOrganisationId,
                            salesCustomerId: claimedCustomer.id,
                            deletionClaimId,
                            currentDeletionClaimId: cleanText(
                                claimCustomer && claimCustomer.deletionClaim && claimCustomer.deletionClaim.id,
                                180
                            )
                        });
                    }
                    try {
                        const currentLifecycle = await getLifecycleService().getOrganisation(
                            access,
                            claimedCustomer.lifecycleOrganisationId
                        );
                        await restoreLifecycleScopingLink(
                            getLifecycleService(),
                            access,
                            claimedCustomer.lifecycleOrganisationId,
                            currentLifecycle.revision,
                            lifecycleRelink
                        );
                    } catch (compensationError) {
                        if (!isLifecycleOrganisationNotFound(compensationError)) {
                            throw salesError(409, 'Lifecycle unlink failed ambiguously and the exact source link could not be confirmed', {
                                code: 'customer_deletion_unlink_reconciliation_failed',
                                sourceErrorCode: cleanText(error && error.details && error.details.code || 'lifecycle_unlink_failed', 120),
                                compensationErrorCode: cleanText(
                                    compensationError && compensationError.details && compensationError.details.code || 'lifecycle_relink_failed',
                                    120
                                ),
                                lifecycleOrganisationId: claimedCustomer.lifecycleOrganisationId,
                                salesCustomerId: claimedCustomer.id,
                                deletionClaimId
                            });
                        }
                    }
                    await releaseCustomerDeletionClaim(
                        getRepository(),
                        access,
                        customerId,
                        deletionClaimId,
                        'Lifecycle unlink failed; customer deletion claim released'
                    );
                    throw error;
                }
            }
        }

        let result;
        try {
            result = await getRepository().mutate(access, {
                expectedRevision: claimed.state.revision,
                action: 'customer.deleted',
                targetType: 'customer',
                targetId: customerId,
                summary: 'Customer, assessments, proposals, handoff history, and durable handoff operations deleted'
            }, (state) => {
                const customer = findCustomer(state, customerId);
                assertCustomerDeletionAllowed(state, customer, body, { deletionClaimId });
                const assessmentIds = new Set(state.assessments.filter((item) => item.customerId === customerId).map((item) => item.id));
                const receiptAt = new Date().toISOString();
                state.customerDeletionReceiptsById[customerId] = {
                    customerId,
                    customerName: customer.name,
                    salesCustomerId: customer.id,
                    lifecycleOrganisationId: cleanText(customer.lifecycleOrganisationId, 180),
                    assessmentId: lifecycleRelink && lifecycleRelink.assessmentId || '',
                    deletionClaimId,
                    deletionFenceGeneration: Number(customer.deletionClaim.generation || 0),
                    status: lifecycleCompletionRequired ? 'source_deleted' : 'target_completed',
                    sourceDeletedAt: receiptAt,
                    sourceDeletedBy: access.user.email,
                    targetCompletedAt: lifecycleCompletionRequired ? '' : receiptAt,
                    targetCompletedBy: lifecycleCompletionRequired ? '' : access.user.email,
                    lifecycleOutcome: lifecycleUnlink.status,
                    lifecycleRevision: Number(lifecycleUnlink.lifecycleRevision || 0)
                };
                removeCustomerHandoffOperations(state, customer, assessmentIds);
                state.customers = state.customers.filter((item) => item.id !== customerId);
                state.assessments = state.assessments.filter((item) => item.customerId !== customerId);
                state.proposals = state.proposals.filter((item) => item.customerId !== customerId);
                state.dynamicsHandoffs = state.dynamicsHandoffs.filter((item) => !assessmentIds.has(item.assessmentId));
                return customer;
            });
        } catch (error) {
            let currentSalesState;
            try {
                currentSalesState = await getRepository().read(access);
            } catch (readError) {
                throw salesError(409, 'Sales deletion outcome could not be confirmed after Lifecycle was unlinked', {
                    code: 'customer_deletion_source_reconciliation_required',
                    sourceErrorCode: cleanText(error && error.details && error.details.code || 'sales_delete_failed', 120),
                    reconciliationErrorCode: cleanText(
                        readError && readError.details && readError.details.code || 'sales_state_read_failed',
                        120
                    ),
                    lifecycleOrganisationId: claimedCustomer.lifecycleOrganisationId,
                    salesCustomerId: claimedCustomer.id,
                    deletionClaimId
                });
            }
            const currentCustomer = currentSalesState.customers.find((customer) => customer.id === customerId);
            if (!currentCustomer) {
                // The conditional write may have committed before its response was
                // lost. The durable claim prevents a second application delete, so
                // absence here is an authoritative converged deletion outcome.
                assertCustomerDeletionReceipt(
                    customerDeletionReceipt(currentSalesState, customerId),
                    customerId,
                    body,
                    {
                        deletionClaimId,
                        deletionFenceGeneration: claimedCustomer.deletionClaim.generation
                    }
                );
                result = { state: currentSalesState, result: claimedCustomer };
            } else if (
                !currentCustomer.deletionClaim ||
                cleanText(currentCustomer.deletionClaim.id, 180) !== deletionClaimId
            ) {
                throw salesError(409, 'This deletion attempt was superseded by a newer fencing claim', {
                    code: 'customer_deletion_claim_superseded',
                    lifecycleOrganisationId: claimedCustomer.lifecycleOrganisationId,
                    salesCustomerId: claimedCustomer.id,
                    deletionClaimId,
                    currentDeletionClaimId: cleanText(
                        currentCustomer.deletionClaim && currentCustomer.deletionClaim.id,
                        180
                    )
                });
            } else {
                if (lifecycleCompletionRequired && lifecycleRelink) {
                    try {
                        await restoreLifecycleScopingLink(
                            getLifecycleService(),
                            access,
                            claimedCustomer.lifecycleOrganisationId,
                            lifecycleUnlink.lifecycleRevision,
                            lifecycleRelink
                        );
                    } catch (compensationError) {
                        if (!isLifecycleOrganisationNotFound(compensationError)) {
                            throw salesError(409, 'Sales changed after Lifecycle was unlinked and the exact link could not be restored automatically', {
                                code: 'customer_deletion_compensation_failed',
                                sourceErrorCode: cleanText(error && error.details && error.details.code || 'sales_delete_failed', 120),
                                compensationErrorCode: cleanText(
                                    compensationError && compensationError.details && compensationError.details.code || 'lifecycle_relink_failed',
                                    120
                                ),
                                lifecycleOrganisationId: claimedCustomer.lifecycleOrganisationId,
                                salesCustomerId: claimedCustomer.id,
                                assessmentId: lifecycleRelink.assessmentId
                            });
                        }
                    }
                }
                try {
                    await releaseCustomerDeletionClaim(
                        getRepository(),
                        access,
                        customerId,
                        deletionClaimId,
                        'Source deletion failed; compensated lifecycle link and released claim'
                    );
                } catch (releaseError) {
                    throw salesError(409, 'Lifecycle was restored but the source deletion claim requires reconciliation', {
                        code: 'customer_deletion_claim_release_failed',
                        sourceErrorCode: cleanText(error && error.details && error.details.code || 'sales_delete_failed', 120),
                        releaseErrorCode: cleanText(
                            releaseError && releaseError.details && releaseError.details.code || 'deletion_claim_release_failed',
                            120
                        ),
                        lifecycleOrganisationId: claimedCustomer.lifecycleOrganisationId,
                        salesCustomerId: claimedCustomer.id,
                        deletionClaimId
                    });
                }
                throw error;
            }
        }
        if (lifecycleCompletionRequired && lifecycleRelink) {
            try {
                const completedFence = await getLifecycleService().completeScopingDeletion(access, claimedCustomer.lifecycleOrganisationId, {
                    deletionClaimId,
                    deletionFenceGeneration: claimedCustomer.deletionClaim.generation
                });
                result.state = await markCustomerDeletionTargetCompleted(
                    getRepository(),
                    access,
                    customerId,
                    deletionClaimId,
                    claimedCustomer.deletionClaim.generation,
                    completedFence.revision
                );
                lifecycleUnlink = {
                    status: 'completed',
                    lifecycleRevision: completedFence.revision
                };
            } catch (completionError) {
                throw customerDeletionTargetCompletionError({
                    lifecycleOrganisationId: claimedCustomer.lifecycleOrganisationId,
                    salesCustomerId: claimedCustomer.id,
                    deletionClaimId,
                    deletionFenceGeneration: claimedCustomer.deletionClaim.generation
                }, completionError);
            }
        }
        return json(200, {
            revision: result.state.revision,
            deleted: true,
            customerId: result.result.id,
            lifecycleUnlink
        });
    }

    return json(405, { error: 'Method not allowed', code: 'method_not_allowed' });
}

async function handleLifecycleHandoffs(method, segments, body, access) {
    const organisationId = cleanText(segments[0], 180);
    if (!organisationId || segments.length !== 1) {
        return json(404, { error: 'Lifecycle handoff not found', code: 'lifecycle_handoff_not_found' });
    }

    assertCapability(access, 'lifecycle:read');
    assertCapability(access, 'customer:read');
    assertCapability(access, 'assessment:read');
    const lifecycle = getLifecycleService();
    const lifecycleResult = await lifecycle.getOrganisation(access, organisationId);
    const organisation = lifecycleResult.organisation;
    if (organisation.lifecycleState !== 'scoping') {
        throw salesError(409, 'Prepare this lifecycle record for scoping before opening the handoff', {
            code: 'scoping_state_required',
            lifecycleState: organisation.lifecycleState
        });
    }

    const salesState = await getRepository().read(access);
    const preview = buildLifecycleScopingPreview(organisation, salesState);
    if (method === 'GET') {
        return json(200, {
            revision: salesState.revision,
            lifecycleRevision: lifecycleResult.revision,
            preview
        });
    }

    if (method !== 'POST') {
        return json(405, { error: 'Method not allowed', code: 'method_not_allowed' }, { Allow: 'GET, POST' });
    }

    assertCapability(access, 'customer:write');
    assertCapability(access, 'assessment:write');
    assertCapability(access, 'lifecycle:write');
    if (cleanText(body.confirmOrganisationId, 180) !== organisationId) {
        throw salesError(400, 'Confirm the exact lifecycle organisation before creating or linking scoping records', {
            code: 'lifecycle_handoff_confirmation_required'
        });
    }
    const lifecycleRevision = Number(body.lifecycleRevision);
    if (!Number.isInteger(lifecycleRevision) || lifecycleRevision !== Number(lifecycleResult.revision)) {
        throw salesError(409, 'Lifecycle discovery changed while you were reviewing it. Reload before confirming.', {
            code: 'lifecycle_revision_conflict',
            currentRevision: lifecycleResult.revision
        });
    }

    const requestedMode = cleanText(body.mode, 40);
    const mode = preview.linked ? 'resume' : requestedMode;
    if (!['create', 'link', 'resume'].includes(mode)) {
        throw salesError(400, 'Choose whether to create or link the sales customer', {
            code: 'lifecycle_handoff_mode_required'
        });
    }
    if (mode === 'create' && preview.candidateCustomers.length && body.confirmDuplicate !== true) {
        throw salesError(409, 'A customer with the same name already exists. Confirm linking it or explicitly confirm a duplicate.', {
            code: 'customer_match_confirmation_required',
            candidates: preview.candidateCustomers
        });
    }
    if (mode === 'link' && !preview.candidateCustomers.some((customer) => customer.id === cleanText(body.customerId, 180))) {
        throw salesError(409, 'The selected customer is not one of the reviewed same-name candidates', {
            code: 'customer_match_selection_required',
            candidates: preview.candidateCustomers
        });
    }

    const now = new Date().toISOString();
    const prefill = createAssessmentPrefill(preview, {
        at: now,
        actorEmail: access.user.email
    });
    const result = await getRepository().mutate(access, {
        expectedRevision: body.expectedRevision,
        action: 'lifecycle.scoping_confirmed',
        targetType: 'lifecycle_organisation',
        targetId: organisationId,
        summary: 'Operator confirmed lifecycle discovery handoff into scoping'
    }, (state) => {
        let customer = state.customers.find((item) => item.lifecycleOrganisationId === organisationId) || null;
        if (!customer && preview.linked && preview.linked.customerId) {
            customer = state.customers.find((item) => item.id === preview.linked.customerId) || null;
        }
        if (!customer && mode === 'link') {
            customer = findCustomer(state, cleanText(body.customerId, 180));
        }
        if (!customer && mode === 'create') {
            if (state.customers.length >= MAX_CUSTOMERS) {
                throw salesError(409, 'This pilot workspace has reached its customer limit', {
                    code: 'customer_limit'
                });
            }
            customer = {
                id: createId('customer'),
                name: cleanText(preview.displayName, 180),
                industry: cleanText(organisation.context && organisation.context.company && organisation.context.company.industry, 120),
                region: '',
                segment: '',
                accountOwner: '',
                dynamicsAccountId: '',
                notes: 'Linked to structured lifecycle discovery. Use shared customer context for source facts and provenance.',
                classification: 'internal',
                createdBy: access.user.email,
                createdAt: now,
                updatedBy: access.user.email,
                updatedAt: now
            };
            state.customers.push(customer);
        }
        if (!customer) {
            throw salesError(404, 'The linked sales customer no longer exists', {
                code: 'linked_customer_not_found'
            });
        }
        assertCustomerNotDeletionClaimed(customer);
        if (customer.lifecycleOrganisationId && customer.lifecycleOrganisationId !== organisationId) {
            throw salesError(409, 'That sales customer is already linked to another lifecycle organisation', {
                code: 'customer_lifecycle_link_conflict'
            });
        }

        customer.lifecycleOrganisationId = organisationId;
        customer.lifecycleLinkedAt = customer.lifecycleLinkedAt || now;
        customer.updatedBy = access.user.email;
        customer.updatedAt = now;

        let assessment = state.assessments.find((item) => (
            item.lifecycleOrganisationId === organisationId ||
            item.prefill && item.prefill.organisationId === organisationId
        )) || null;
        if (!assessment && preview.linked && preview.linked.assessmentId) {
            assessment = state.assessments.find((item) => item.id === preview.linked.assessmentId) || null;
        }
        if (!assessment) {
            assessment = {
                id: createId('assessment'),
                customerId: customer.id,
                lifecycleOrganisationId: organisationId,
                title: 'Discovery details to confirm',
                blueprintVersion: getAssessmentBlueprint().version,
                status: 'draft',
                answers: preview.answers,
                prefill,
                recommendations: [],
                catalogueVersionId: null,
                createdBy: access.user.email,
                createdAt: now,
                updatedBy: access.user.email,
                updatedAt: now,
                completedAt: ''
            };
            state.assessments.push(assessment);
        } else {
            if (assessment.customerId !== customer.id) {
                throw salesError(409, 'The lifecycle assessment is linked to another sales customer', {
                    code: 'assessment_customer_link_conflict'
                });
            }
            assessment.lifecycleOrganisationId = organisationId;
            assessment.answers = mergePrefillAnswers(assessment.answers, preview.answers);
            assessment.prefill = Object.assign({}, assessment.prefill || {}, prefill, {
                importedAt: assessment.prefill && assessment.prefill.importedAt || now
            });
            assessment.updatedBy = access.user.email;
            assessment.updatedAt = now;
        }
        const enqueued = enqueueDurableOperation(state, {
            idempotencyKey: `${access.tenant.key}:lifecycle-scoping-link:${organisationId}`,
            kind: 'lifecycle.scoping.link',
            destination: 'lifecycle',
            aggregateType: 'lifecycle_organisation',
            aggregateId: organisationId,
            correlationId: access.requestContext && access.requestContext.correlationId,
            payload: {
                organisationId,
                salesCustomerId: customer.id,
                assessmentId: assessment.id,
                remainingGapCount: preview.questionGaps.length
            }
        }, { now });
        return { customer, assessment, operation: enqueued.operation };
    });

    let sourceRevision = result.state.revision;
    let claimedOperation = result.result.operation;
    if (claimedOperation.status === 'completed') {
        let replayed;
        try {
            replayed = await lifecycle.linkScopingRecords(access, organisationId, {
                expectedRevision: lifecycleRevision,
                salesCustomerId: result.result.customer.id,
                assessmentId: result.result.assessment.id,
                remainingGapCount: preview.questionGaps.length,
                operationId: claimedOperation.operationId,
                operationPayloadHash: claimedOperation.payloadHash
            });
        } catch (error) {
            return json(202, {
                revision: sourceRevision,
                lifecycleRevision,
                customer: publicCustomer(result.result.customer),
                assessment: result.result.assessment,
                lifecycle: organisation,
                gaps: preview.questionGaps,
                operation: claimedOperation,
                convergence: 'pending',
                targetReceipt: 'reconciliation_required',
                retrySafe: true,
                errorCode: cleanText(error && error.details && error.details.code || 'lifecycle_link_reconciliation_failed', 120)
            });
        }
        return json(200, {
            revision: sourceRevision,
            lifecycleRevision: replayed.revision,
            customer: publicCustomer(result.result.customer),
            assessment: result.result.assessment,
            lifecycle: replayed.organisation,
            gaps: preview.questionGaps,
            operation: claimedOperation,
            convergence: 'completed'
        });
    }
    try {
        const claimed = await getRepository().mutate(access, {
            expectedRevision: sourceRevision,
            action: 'operation.claimed',
            targetType: 'durable_operation',
            targetId: claimedOperation.operationId,
            summary: 'Lifecycle scoping handoff claimed for immediate internal delivery'
        }, (state) => updateDurableOperation(state, { operationId: claimedOperation.operationId }, {
            status: 'claimed',
            attemptCount: Number(claimedOperation.attemptCount || 0) + 1,
            lastAttemptAt: now,
            leaseOwner: `sales-request:${access.user.email}`,
            leaseUntil: new Date(Date.parse(now) + (5 * 60 * 1000)).toISOString()
        }, { expectedStatus: claimedOperation.status, now }));
        sourceRevision = claimed.state.revision;
        claimedOperation = claimed.result;
    } catch (error) {
        return json(202, {
            revision: sourceRevision,
            lifecycleRevision,
            customer: publicCustomer(result.result.customer),
            assessment: result.result.assessment,
            lifecycle: organisation,
            gaps: preview.questionGaps,
            operation: claimedOperation,
            convergence: 'pending'
        });
    }

    let linked;
    try {
        linked = await lifecycle.linkScopingRecords(access, organisationId, {
            expectedRevision: lifecycleRevision,
            salesCustomerId: result.result.customer.id,
            assessmentId: result.result.assessment.id,
            remainingGapCount: preview.questionGaps.length,
            operationId: claimedOperation.operationId,
            operationPayloadHash: claimedOperation.payloadHash
        });
    } catch (error) {
        const retryAt = new Date(Date.parse(now) + (60 * 1000)).toISOString();
        try {
            const retried = await getRepository().mutate(access, {
                expectedRevision: sourceRevision,
                action: 'operation.retry_scheduled',
                targetType: 'durable_operation',
                targetId: claimedOperation.operationId,
                summary: 'Lifecycle scoping handoff retained for retry'
            }, (state) => updateDurableOperation(state, { operationId: claimedOperation.operationId }, {
                status: 'retry',
                nextAttemptAt: retryAt,
                leaseOwner: '',
                leaseUntil: '',
                lastErrorCode: cleanText(error && error.details && error.details.code || 'lifecycle_link_failed', 120)
            }, { expectedStatus: 'claimed', now }));
            sourceRevision = retried.state.revision;
            claimedOperation = retried.result;
        } catch (updateError) {
            // The claimed operation remains durable and its lease can be recovered by a dispatcher.
        }
        return json(202, {
            revision: sourceRevision,
            lifecycleRevision,
            customer: publicCustomer(result.result.customer),
            assessment: result.result.assessment,
            lifecycle: organisation,
            gaps: preview.questionGaps,
            operation: claimedOperation,
            convergence: 'pending',
            retrySafe: true
        });
    }

    let sourceAcknowledged = true;
    try {
        const completed = await getRepository().mutate(access, {
            expectedRevision: sourceRevision,
            action: 'operation.completed',
            targetType: 'durable_operation',
            targetId: claimedOperation.operationId,
            summary: 'Lifecycle scoping handoff converged'
        }, (state) => updateDurableOperation(state, { operationId: claimedOperation.operationId }, {
            status: 'completed',
            completedAt: new Date().toISOString(),
            nextAttemptAt: '',
            leaseOwner: '',
            leaseUntil: '',
            lastErrorCode: '',
            resultReference: `lifecycle:${organisationId}`
        }, { expectedStatus: 'claimed' }));
        sourceRevision = completed.state.revision;
        claimedOperation = completed.result;
    } catch (error) {
        // Target inbox receipts make acknowledgement recovery safe without repeating the target effect.
        sourceAcknowledged = false;
    }

    if (!sourceAcknowledged) {
        return json(202, {
            revision: sourceRevision,
            lifecycleRevision: linked.revision,
            customer: publicCustomer(result.result.customer),
            assessment: result.result.assessment,
            lifecycle: linked.organisation,
            gaps: preview.questionGaps,
            operation: claimedOperation,
            convergence: 'pending',
            targetReceipt: 'recorded',
            retrySafe: true
        });
    }

    return json(mode === 'resume' ? 200 : 201, {
        revision: sourceRevision,
        lifecycleRevision: linked.revision,
        customer: publicCustomer(result.result.customer),
        assessment: result.result.assessment,
        lifecycle: linked.organisation,
        gaps: preview.questionGaps,
        operation: claimedOperation,
        convergence: 'completed'
    });
}

async function handleAssessments(method, segments, body, access) {
    if (method === 'GET' && !segments.length) {
        assertCapability(access, 'assessment:read');
        const state = await getRepository().read(access);
        return json(200, {
            revision: state.revision,
            assessments: state.assessments.map(publicAssessmentSummary)
        });
    }

    if (method === 'POST' && !segments.length) {
        assertCapability(access, 'assessment:write');
        const customerId = cleanText(body.customerId, 180);
        const assessmentId = createId('assessment');
        const blueprint = getAssessmentBlueprint();
        const result = await getRepository().mutate(access, {
            expectedRevision: body.expectedRevision,
            action: 'assessment.created',
            targetType: 'assessment',
            targetId: assessmentId,
            summary: '30-minute discovery started'
        }, (state) => {
            findCustomer(state, customerId);
            const now = new Date().toISOString();
            const assessment = {
                id: assessmentId,
                customerId,
                title: cleanText(body.title || '30-minute customer discovery', 180),
                blueprintVersion: blueprint.version,
                status: 'draft',
                answers: {},
                recommendations: [],
                catalogueVersionId: null,
                createdBy: access.user.email,
                createdAt: now,
                updatedBy: access.user.email,
                updatedAt: now,
                completedAt: ''
            };
            state.assessments.push(assessment);
            return assessment;
        });
        return json(201, {
            revision: result.state.revision,
            assessment: result.result
        });
    }

    const assessmentId = segments[0];
    if (!assessmentId) {
        return json(404, { error: 'Assessment not found' });
    }

    if (method === 'GET' && segments.length === 1) {
        assertCapability(access, 'assessment:read');
        const state = await getRepository().read(access);
        const assessment = findAssessment(state, assessmentId);
        const customer = findCustomer(state, assessment.customerId);
        const lifecycleOrganisation = await linkedLifecycleOrganisation(assessment, access);
        return json(200, {
            revision: state.revision,
            assessment,
            customer: publicCustomer(customer),
            servicePlan: buildServicePlanView(assessment, lifecycleOrganisation, access)
        });
    }

    if (method === 'PUT' && segments[1] === 'answers') {
        assertCapability(access, 'assessment:write');
        const answers = validateAnswers(body.answers || {});
        const status = body.status === 'completed' ? 'completed' : 'draft';
        const result = await getRepository().mutate(access, {
            expectedRevision: body.expectedRevision,
            action: status === 'completed' ? 'assessment.completed' : 'assessment.saved',
            targetType: 'assessment',
            targetId: assessmentId,
            summary: status === 'completed' ? 'Discovery completed' : 'Discovery draft saved'
        }, (state) => {
            const assessment = findAssessment(state, assessmentId);
            assessment.answers = answers;
            assessment.status = status;
            assessment.updatedBy = access.user.email;
            assessment.updatedAt = new Date().toISOString();
            if (status === 'completed') {
                assessment.completedAt = assessment.completedAt || assessment.updatedAt;
            }
            return assessment;
        });
        return json(200, {
            revision: result.state.revision,
            assessment: result.result
        });
    }

    if (method === 'POST' && segments[1] === 'match') {
        assertCapability(access, 'assessment:write');
        const result = await getRepository().mutate(access, {
            expectedRevision: body.expectedRevision,
            action: 'assessment.matched',
            targetType: 'assessment',
            targetId: assessmentId,
            summary: 'Explainable service recommendations generated'
        }, (state) => {
            const assessment = findAssessment(state, assessmentId);
            const catalogue = getPublishedCatalogue(state);
            if (!catalogue) {
                throw salesError(409, 'Publish a service catalogue before generating recommendations', {
                    code: 'catalogue_required'
                });
            }
            assessment.recommendations = matchServices(assessment, catalogue.services);
            assessment.catalogueVersionId = catalogue.id;
            assessment.updatedBy = access.user.email;
            assessment.updatedAt = new Date().toISOString();
            return assessment;
        });
        return json(200, {
            revision: result.state.revision,
            assessment: result.result
        });
    }

    if (method === 'POST' && segments[1] === 'service-plan' && segments.length === 2) {
        assertCapability(access, 'recommendation:review');
        const result = await getRepository().mutate(access, {
            expectedRevision: body.expectedRevision,
            action: 'service_plan.reviewed',
            targetType: 'assessment',
            targetId: assessmentId,
            summary: `${MANAGED_IT_POLICY.customerFacingServiceName} bundle reviewed`
        }, (state) => {
            const assessment = findAssessment(state, assessmentId);
            applyServicePlanReview(assessment, body, access);
            return assessment;
        });
        return json(200, {
            revision: result.state.revision,
            assessment: result.result,
            servicePlan: buildServicePlanView(result.result, null, access)
        });
    }

    if (method === 'POST' && segments[1] === 'recommendations' && segments[2]) {
        assertCapability(access, 'recommendation:review');
        const recommendationId = segments[2];
        const result = await getRepository().mutate(access, {
            expectedRevision: body.expectedRevision,
            action: 'recommendation.reviewed',
            targetType: 'recommendation',
            targetId: recommendationId,
            summary: cleanText(body.decision || 'pending', 40)
        }, (state) => {
            const assessment = findAssessment(state, assessmentId);
            const recommendation = assessment.recommendations.find((item) => item.id === recommendationId);
            if (!recommendation) {
                throw salesError(404, 'Recommendation not found');
            }
            applyRecommendationReview(recommendation, body, access);
            assessment.updatedBy = access.user.email;
            assessment.updatedAt = new Date().toISOString();
            return recommendation;
        });
        return json(200, {
            revision: result.state.revision,
            recommendation: result.result
        });
    }

    if (method === 'POST' && segments[1] === 'proposal') {
        assertCapability(access, 'proposal:write');
        const proposalId = createId('proposal');
        const result = await getRepository().mutate(access, {
            expectedRevision: body.expectedRevision,
            action: 'proposal.created',
            targetType: 'proposal',
            targetId: proposalId,
            summary: 'Customer-facing proposal draft generated'
        }, (state) => {
            const assessment = findAssessment(state, assessmentId);
            const customer = findCustomer(state, assessment.customerId);
            const accepted = assessment.recommendations.filter((item) => item.review && item.review.decision === 'accepted');
            if (!accepted.length) {
                throw salesError(409, 'Accept at least one recommendation before building a proposal', {
                    code: 'accepted_recommendation_required'
                });
            }
            if (assessment.bundleReview && !accepted.some((item) => item.serviceKey === MANAGED_IT_BUNDLE_KEY)) {
                throw salesError(409, `Include the ${MANAGED_IT_POLICY.customerFacingServiceName} bundle before building a proposal`, {
                    code: 'managed_it_bundle_required'
                });
            }
            const proposal = buildProposal(proposalId, customer, assessment, accepted, access);
            proposal.versionNumber = nextProposalVersionNumber(state.proposals, assessment.id);
            state.proposals.push(proposal);
            return proposal;
        });
        return json(201, {
            revision: result.state.revision,
            proposal: Object.assign({}, result.result, {
                commercialPolicyStatus: assessProposalCommercialPolicy(result.result)
            })
        });
    }

    return json(405, { error: 'Method not allowed', code: 'method_not_allowed' });
}

async function handleProposals(method, segments, body, query, access) {
    if (method === 'GET' && !segments.length) {
        assertCapability(access, 'proposal:write');
        const state = await getRepository().read(access);
        return json(200, {
            revision: state.revision,
            proposals: state.proposals.map(publicProposalSummary)
        });
    }

    const proposalId = segments[0];
    if (!proposalId) {
        return json(404, { error: 'Proposal not found' });
    }

    if (method === 'GET' && segments.length === 1) {
        assertCapability(access, 'proposal:write');
        const state = await getRepository().read(access);
        const proposal = findProposal(state, proposalId);
        const customer = findCustomer(state, proposal.customerId);
        const assessment = findAssessment(state, proposal.assessmentId);
        return json(200, {
            revision: state.revision,
            proposal: proposalForEditor(proposal, customer, assessment),
            customer: publicCustomer(customer)
        });
    }

    if (method === 'POST' && segments[1] === 'review') {
        assertCapability(access, 'proposal:write');
        const state = await getRepository().read(access);
        const proposal = findProposal(state, proposalId);
        const customer = findCustomer(state, proposal.customerId);
        const assessment = findAssessment(state, proposal.assessmentId);
        const reviewSource = proposalForEditor(proposal, customer, assessment);
        const agent = createProposalReviewAgent();
        const review = await agent.review({
            proposal: reviewSource,
            customer,
            assessment,
            evidence: proposalReviewEvidence(assessment)
        });
        const reviewedAt = new Date().toISOString();
        const reviewId = createId('proposal_review');
        const sourceSha256 = proposalReviewHash(reviewSource);
        const suggestionSha256 = proposalReviewHash(proposalReviewSuggestionView(review.suggestedProposal || {}));
        const auditResult = await getRepository().mutate(access, {
            expectedRevision: body.expectedRevision,
            action: 'proposal.ai_reviewed',
            targetType: 'proposal',
            targetId: proposalId,
            summary: `${review.blockingCount} proposal approval blockers found`
        }, (mutableState) => {
            const mutableProposal = findProposal(mutableState, proposalId);
            const persistedReview = {
                status: 'reviewed',
                reviewId,
                sourceRevision: state.revision,
                reviewRevision: Number(mutableState.revision || 0) + 1,
                sourceSha256,
                suggestionSha256,
                reviewedAt,
                reviewedBy: access.user.email,
                runtime: review.runtime.mode,
                model: review.model,
                providerModel: cleanText(review.providerModel, 120),
                promptVersion: cleanText(review.identities && review.identities.promptVersion, 120),
                toolSchemaVersion: cleanText(review.identities && review.identities.toolSchemaVersion, 120),
                outputSchemaVersion: cleanText(review.identities && review.identities.outputSchemaVersion, 120),
                policyId: cleanText(review.identities && review.identities.policyId, 120),
                policyVersion: cleanText(review.identities && review.identities.policyVersion, 120),
                policyEffectiveFrom: cleanText(review.identities && review.identities.policyEffectiveFrom, 40),
                releaseSha: cleanText(review.identities && review.identities.releaseSha, 64),
                releaseRunId: cleanText(review.identities && review.identities.releaseRunId, 80),
                reasoningEffort: cleanText(review.identities && review.identities.reasoningEffort, 40),
                blockingCount: review.blockingCount,
                warningCount: review.warnings.length,
                changedSections: review.changedSections,
                traceId: cleanText(review.traceId, 300),
                usage: normaliseReviewUsage(review.usage),
                approximateCostUsd: nonNegativeDecimal(review.approximateCostUsd, 6),
                latencyMs: nonNegativeInteger(review.latencyMs),
                feedback: null,
                feedbackHistory: []
            };
            mutableProposal.aiReview = persistedReview;
            mutableProposal.aiReviewHistory = (Array.isArray(mutableProposal.aiReviewHistory)
                ? mutableProposal.aiReviewHistory
                : []).concat([cloneJson(persistedReview)]).slice(-100);
            return persistedReview;
        });
        return json(200, {
            revision: auditResult.state.revision,
            review: Object.assign({}, review, {
                reviewId,
                sourceRevision: state.revision,
                sourceSha256,
                suggestionSha256
            })
        });
    }

    if (method === 'POST' && segments[1] === 'review-feedback') {
        assertCapability(access, 'proposal:write');
        const reviewId = cleanText(body.reviewId, 180);
        const outcome = normaliseChoice(body.outcome, ['accepted', 'edited', 'rejected'], '');
        const resultingProposalRevision = Number(body.resultingProposalRevision);
        if (!reviewId || !outcome || !Number.isInteger(resultingProposalRevision) || resultingProposalRevision < 0) {
            throw salesError(400, 'A current proposal review and accepted, edited, or rejected outcome are required', {
                code: 'proposal_review_feedback_invalid'
            });
        }
        const recordedAt = new Date().toISOString();
        const result = await getRepository().mutate(access, {
            expectedRevision: body.expectedRevision,
            action: 'proposal.ai_review_feedback_recorded',
            targetType: 'proposal',
            targetId: proposalId,
            summary: `Proposal AI review ${outcome}`
        }, (state) => {
            const proposal = findProposal(state, proposalId);
            if (Number(state.revision || 0) !== resultingProposalRevision) {
                throw salesError(409, 'Proposal review feedback must identify the persisted proposal revision it describes', {
                    code: 'proposal_review_feedback_revision_mismatch',
                    currentRevision: Number(state.revision || 0)
                });
            }
            return recordProposalReviewFeedback(proposal, {
                reviewId,
                outcome,
                resultingProposalRevision,
                changedSections: body.changedSections,
                reason: body.reason,
                recordedAt,
                recordedBy: access.user.email
            });
        });
        return json(200, { revision: result.state.revision, feedback: result.result });
    }

    if ((method === 'PUT' || method === 'PATCH') && segments.length === 1) {
        assertCapability(access, 'proposal:write');
        const result = await getRepository().mutate(access, {
            expectedRevision: body.expectedRevision,
            action: body.status === 'approved' ? 'proposal.approved' : 'proposal.updated',
            targetType: 'proposal',
            targetId: proposalId,
            summary: body.status === 'approved' ? 'Proposal approved for handoff' : 'Proposal draft updated'
        }, (state) => {
            const proposal = findProposal(state, proposalId);
            const customer = findCustomer(state, proposal.customerId);
            assertCustomerNotDeletionClaimed(customer);
            if (proposal.status === 'approved') {
                throw salesError(409, 'Approved proposal content is immutable. Create a new proposal version for amendments.', {
                    code: 'approved_proposal_immutable',
                    proposalId: proposal.id,
                    version: proposal.approvalSeal && proposal.approvalSeal.version || `v${proposal.versionNumber || 1}`
                });
            }
            applyProposalUpdate(proposal, body, access);
            const assessment = findAssessment(state, proposal.assessmentId);
            const warnings = validateProposalDraft({
                proposal,
                customer,
                assessment,
                requireCurrentCommercialPolicy: true
            });
            const blocking = warnings.filter((warning) => warning.blocking);
            proposal.approvalChecks = {
                checkedAt: new Date().toISOString(),
                blockingCount: blocking.length,
                warnings
            };
            if (body.status === 'approved' && blocking.length) {
                const policyBlocker = blocking.find((warning) => warning.code === 'commercial_policy_migration_required');
                if (policyBlocker) {
                    throw salesError(422, 'Migrate this proposal to the current commercial policy before approval', {
                        code: 'commercial_policy_migration_required',
                        policyStatus: assessProposalCommercialPolicy(proposal),
                        warnings: [policyBlocker]
                    });
                }
                throw salesError(422, 'Resolve the proposal approval blockers before approval', {
                    code: 'proposal_approval_blocked',
                    blockingCount: blocking.length,
                    warnings: blocking
                });
            }
            if (body.status === 'approved') {
                proposal.approvalSeal = createProposalApprovalSeal({
                    proposal,
                    customer,
                    tenant: state.tenant
                });
            }
            if (body.reviewFeedback && typeof body.reviewFeedback === 'object') {
                const outcome = normaliseChoice(body.reviewFeedback.outcome, ['accepted', 'edited'], '');
                if (!outcome) {
                    throw salesError(400, 'An accepted or edited proposal review outcome is required with this save', {
                        code: 'proposal_review_feedback_invalid'
                    });
                }
                recordProposalReviewFeedback(proposal, {
                    reviewId: cleanText(body.reviewFeedback.reviewId, 180),
                    outcome,
                    resultingProposalRevision: Number(state.revision || 0) + 1,
                    changedSections: body.reviewFeedback.changedSections,
                    reason: body.reviewFeedback.reason,
                    recordedAt: new Date().toISOString(),
                    recordedBy: access.user.email
                });
            }
            return proposal;
        });
        return json(200, {
            revision: result.state.revision,
            proposal: proposalForEditor(
                result.result,
                findCustomer(result.state, result.result.customerId),
                findAssessment(result.state, result.result.assessmentId)
            )
        });
    }

    if (method === 'GET' && segments[1] === 'export') {
        assertCapability(access, 'proposal:export');
        const state = await getRepository().read(access);
        const proposal = findProposal(state, proposalId);
        const customer = findCustomer(state, proposal.customerId);
        let exportView = { proposal, customer, tenant: state.tenant };
        if (proposal.status === 'approved') {
            const verification = verifyProposalApprovalSeal(proposal);
            if (!verification.verified) {
                throw salesError(409, 'The approved proposal does not have a valid immutable approval seal', {
                    code: verification.code,
                    proposalId: proposal.id
                });
            }
            exportView = materialiseProposalApprovalSnapshot(verification.seal);
        }
        const html = renderProposalDocument(exportView.proposal, exportView.customer, exportView.tenant);
        const format = String(query.format || 'html').toLowerCase();
        if (format === 'word') {
            return raw(200, html, {
                'Content-Type': 'application/msword; charset=utf-8',
                'Content-Disposition': `attachment; filename="${safeFileName(exportView.customer.name)}-service-proposal.doc"`,
                'Cache-Control': 'private, no-store'
            });
        }
        return raw(200, html, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'private, no-store'
        });
    }

    return json(405, { error: 'Method not allowed', code: 'method_not_allowed' });
}

async function handleDynamics(method, segments, body, access) {
    if (method === 'GET' && segments[0] === 'status') {
        assertCapability(access, 'integration:handoff');
        return json(200, dynamicsStatus());
    }

    if (method === 'POST' && (segments[0] === 'preview' || segments[0] === 'handoff')) {
        assertCapability(access, 'integration:handoff');
        const state = await getRepository().read(access);
        const proposal = findProposal(state, cleanText(body.proposalId, 180));
        const assessment = findAssessment(state, proposal.assessmentId);
        const customer = findCustomer(state, proposal.customerId);
        const payload = buildDynamicsPayload(state, customer, assessment, proposal);

        if (segments[0] === 'preview') {
            return json(200, {
                configured: dynamicsStatus().configured,
                payload
            });
        }

        if (proposal.status !== 'approved') {
            return json(409, {
                error: 'Approve the proposal before sending it to Dynamics',
                code: 'proposal_approval_required'
            });
        }
        const approvalVerification = verifyProposalApprovalSeal(proposal);
        if (!approvalVerification.verified) {
            throw salesError(409, 'The approved proposal does not have a valid immutable approval seal', {
                code: approvalVerification.code,
                proposalId: proposal.id
            });
        }
        if (body.confirmed !== true) {
            return json(400, {
                error: 'Explicit handoff confirmation is required',
                code: 'handoff_confirmation_required'
            });
        }

        const response = await sendDynamicsHandoff(payload);
        const result = await getRepository().mutate(access, {
            expectedRevision: body.expectedRevision,
            action: 'dynamics.handoff',
            targetType: 'proposal',
            targetId: proposal.id,
            summary: `${payload.opportunities.length} approved opportunities sent to Dynamics`
        }, (mutableState) => {
            const mutableProposal = findProposal(mutableState, proposal.id);
            const record = {
                id: createId('handoff'),
                assessmentId: assessment.id,
                proposalId: proposal.id,
                customerId: customer.id,
                sentBy: access.user.email,
                sentAt: new Date().toISOString(),
                opportunityCount: payload.opportunities.length,
                response: sanitiseIntegrationResponse(response)
            };
            mutableState.dynamicsHandoffs.push(record);
            mutableProposal.dynamics = {
                status: 'sent',
                sentAt: record.sentAt,
                handoffId: record.id,
                recordUrl: cleanText(response.recordUrl, 1000)
            };
            return record;
        });
        return json(200, {
            revision: result.state.revision,
            handoff: result.result
        });
    }

    return json(405, { error: 'Method not allowed', code: 'method_not_allowed' });
}

function buildBootstrap(state, access) {
    const published = getPublishedCatalogue(state);
    return {
        product: {
            name: 'No Fries',
            mode: 'discovery-to-proposal',
            schemaVersion: state.schemaVersion
        },
        revision: state.revision,
        tenant: state.tenant,
        user: access.user,
        counts: {
            customers: state.customers.length,
            activeAssessments: state.assessments.filter((item) => item.status !== 'completed').length,
            completedAssessments: state.assessments.filter((item) => item.status === 'completed').length,
            proposals: state.proposals.length,
            publishedServices: published ? published.services.length : 0,
            pendingOperations: Object.values(state.operationsById || {}).filter((item) => !['completed', 'cancelled'].includes(item.status)).length,
            openRepairs: Object.values(state.repairItemsById || {}).filter((item) => item.status === 'open').length
        },
        catalogue: {
            publishedVersionId: state.catalogue.publishedVersionId,
            publishedLabel: published ? published.label : '',
            publishedAt: published ? published.publishedAt : '',
            serviceCount: published ? published.services.length : 0,
            draftCount: state.catalogue.versions.filter((item) => item.status === 'draft').length
        },
        customers: state.customers.map(publicCustomer),
        assessments: state.assessments.map(publicAssessmentSummary),
        proposals: state.proposals.map(publicProposalSummary),
        pricing: standardPricingSummary(),
        integration: dynamicsStatus()
    };
}

function protectedSalesApplicationSource() {
    return fs.readFileSync(path.join(__dirname, 'protectedAssets', 'mssp.js'), 'utf8');
}

function validateCatalogueCsv(csv) {
    let rows;
    try {
        rows = parseCsv(csv);
    } catch (error) {
        return { errors: [{ row: 0, field: 'csv', message: error.message }], warnings: [], services: [] };
    }
    if (!rows.length) {
        return { errors: [{ row: 1, field: 'csv', message: 'CSV is empty' }], warnings: [], services: [] };
    }

    const headers = rows[0].map((value) => normaliseHeader(value));
    const errors = [];
    const warnings = [];
    CATALOGUE_COLUMNS.forEach((column) => {
        if (!headers.includes(column)) {
            errors.push({ row: 1, field: column, message: `Required column "${column}" is missing` });
        }
    });
    if (errors.length) {
        return { errors, warnings, services: [] };
    }

    const questionMap = getQuestionMap();
    const services = [];
    const serviceKeys = new Set();
    rows.slice(1).forEach((row, index) => {
        const rowNumber = index + 2;
        if (row.every((value) => !String(value || '').trim())) {
            return;
        }
        const record = {};
        headers.forEach((header, cellIndex) => {
            record[header] = row[cellIndex] == null ? '' : String(row[cellIndex]);
        });

        const serviceKey = slugify(record.service_key);
        const name = cleanText(record.service_name, 180);
        const category = cleanText(record.category, 120);
        const customerOutcome = cleanText(record.customer_outcome, 2000);
        const classification = normaliseClassification(record.classification || 'internal', errors, rowNumber);
        if (!serviceKey) {
            errors.push({ row: rowNumber, field: 'service_key', message: 'Service key is required' });
        } else if (serviceKeys.has(serviceKey)) {
            errors.push({ row: rowNumber, field: 'service_key', message: 'Service key must be unique' });
        }
        if (!name) {
            errors.push({ row: rowNumber, field: 'service_name', message: 'Service name is required' });
        }
        if (!category) {
            errors.push({ row: rowNumber, field: 'category', message: 'Category is required' });
        }
        if (!customerOutcome) {
            errors.push({ row: rowNumber, field: 'customer_outcome', message: 'Customer outcome is required' });
        }

        const rules = {
            strong: parseSignalRules(record.strong_fit_signals, rowNumber, 'strong_fit_signals', questionMap, errors),
            potential: parseSignalRules(record.potential_fit_signals, rowNumber, 'potential_fit_signals', questionMap, errors),
            prerequisites: parseSignalRules(record.prerequisite_signals, rowNumber, 'prerequisite_signals', questionMap, errors),
            disqualifiers: parseSignalRules(record.disqualifier_signals, rowNumber, 'disqualifier_signals', questionMap, errors)
        };
        if (!rules.strong.length && !rules.potential.length) {
            warnings.push({ row: rowNumber, field: 'signals', message: 'Service has no qualifying signals and will normally return insufficient information' });
        }
        serviceKeys.add(serviceKey);
        services.push({
            id: createId('service'),
            key: serviceKey,
            name,
            category,
            customerOutcome,
            idealCustomer: cleanText(record.ideal_customer, 2000),
            gapIndicators: splitList(record.gap_indicators),
            prerequisites: splitList(record.prerequisites),
            disqualifiers: splitList(record.disqualifiers),
            discoveryQuestions: splitList(record.discovery_questions),
            evidenceRequired: splitList(record.evidence_required),
            relatedServices: splitList(record.related_services).map(slugify).filter(Boolean),
            salesOwner: cleanText(record.sales_owner, 180),
            sourceDocuments: splitList(record.source_documents),
            classification,
            rules
        });
    });

    if (!services.length) {
        errors.push({ row: 2, field: 'service_name', message: 'Add at least one service row' });
    }
    return { errors, warnings, services };
}

function parseSignalRules(value, row, field, questionMap, errors) {
    return String(value || '')
        .split(';;')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((expression) => {
            const separator = expression.indexOf('=');
            if (separator <= 0 || separator === expression.length - 1) {
                errors.push({ row, field, message: `Invalid signal "${expression}". Use question_id=value1|value2` });
                return null;
            }
            const questionId = expression.slice(0, separator).trim();
            const values = expression.slice(separator + 1).split('|').map((item) => item.trim()).filter(Boolean);
            const question = questionMap.get(questionId);
            if (!question) {
                errors.push({ row, field, message: `Unknown assessment question "${questionId}"` });
                return null;
            }
            if (!question.options || !question.options.length) {
                errors.push({ row, field, message: `Question "${questionId}" cannot be used as a signal` });
                return null;
            }
            const allowed = new Set(question.options.map((item) => item.value));
            values.forEach((candidate) => {
                if (!allowed.has(candidate)) {
                    errors.push({ row, field, message: `Unknown value "${candidate}" for ${questionId}` });
                }
            });
            return { questionId, values };
        })
        .filter(Boolean);
}

function validateAnswers(value) {
    const questionMap = getQuestionMap();
    const answers = {};
    Object.entries(value || {}).forEach(([questionId, answer]) => {
        const question = questionMap.get(questionId);
        if (!question || !answer || typeof answer !== 'object') {
            return;
        }
        let answerValue = answer.value;
        if (question.type === 'multi') {
            const allowed = new Set((question.options || []).map((item) => item.value));
            answerValue = Array.isArray(answerValue) ? answerValue.filter((item) => allowed.has(item)).slice(0, 20) : [];
        } else if (question.type === 'single') {
            const allowed = new Set((question.options || []).map((item) => item.value));
            answerValue = allowed.has(answerValue) ? answerValue : '';
        } else {
            answerValue = cleanText(answerValue, 4000);
        }
        answers[questionId] = {
            value: answerValue,
            notes: cleanText(answer.notes, 4000),
            evidence: cleanText(answer.evidence, 2000),
            importance: normaliseChoice(answer.importance, ['low', 'medium', 'high'], 'medium'),
            confidence: normaliseChoice(answer.confidence, ['low', 'medium', 'high'], 'medium'),
            internalNotes: cleanText(answer.internalNotes, 4000)
        };
    });
    return answers;
}

function matchServices(assessment, services) {
    const questionMap = getQuestionMap();
    return services.map((service) => {
        const disqualifiers = evaluateRules(service.rules.disqualifiers, assessment.answers, questionMap);
        const prerequisites = evaluatePrerequisites(service.rules.prerequisites, assessment.answers, questionMap);
        const strong = evaluateRules(service.rules.strong, assessment.answers, questionMap);
        const potential = evaluateRules(service.rules.potential, assessment.answers, questionMap);
        const score = (strong.matches.length * 4) + (potential.matches.length * 2);
        const missing = unique([
            ...strong.missing,
            ...potential.missing,
            ...prerequisites.missing
        ]);
        let fit = 'not_currently_suitable';
        if (disqualifiers.matches.length || prerequisites.blockers.length) {
            fit = 'not_currently_suitable';
        } else if (strong.matches.length && !prerequisites.missing.length) {
            fit = 'strong_fit';
        } else if (strong.matches.length || potential.matches.length || score > 0) {
            fit = 'potential_fit';
        } else if (missing.length || (!service.rules.strong.length && !service.rules.potential.length)) {
            fit = 'insufficient_information';
        }

        return {
            id: createId('recommendation'),
            serviceId: service.id,
            serviceKey: service.key,
            serviceName: service.name,
            category: service.category,
            customerOutcome: service.customerOutcome,
            fit,
            score,
            reasons: [...strong.matches, ...potential.matches],
            prerequisites: service.prerequisites,
            prerequisiteEvidence: prerequisites.matches,
            blockers: [...disqualifiers.matches, ...prerequisites.blockers],
            missingInformation: missing,
            evidenceRequired: service.evidenceRequired,
            salesOwner: service.salesOwner,
            review: {
                decision: 'pending',
                roadmap: fit === 'strong_fit' ? 'now' : 'next',
                estimatedMrr: 0,
                oneOffRevenue: 0,
                owner: service.salesOwner || '',
                nextAction: '',
                consultantRationale: '',
                customerOutcome: service.customerOutcome,
                reviewedBy: '',
                reviewedAt: ''
            }
        };
    }).sort(sortRecommendations);
}

function evaluateRules(rules, answers, questionMap) {
    const matches = [];
    const missing = [];
    (rules || []).forEach((rule) => {
        const question = questionMap.get(rule.questionId);
        if (!question || !isQuestionVisible(question, answers)) {
            return;
        }
        const answer = answers[rule.questionId];
        if (!answer || isEmptyAnswer(answer.value)) {
            missing.push(question.prompt);
            return;
        }
        if (matchesRule(answer.value, rule.values)) {
            matches.push(`${question.prompt} — ${answerLabel(question, answer.value)}`);
        }
    });
    return { matches, missing };
}

function evaluatePrerequisites(rules, answers, questionMap) {
    const matches = [];
    const blockers = [];
    const missing = [];
    (rules || []).forEach((rule) => {
        const question = questionMap.get(rule.questionId);
        if (!question || !isQuestionVisible(question, answers)) {
            return;
        }
        const answer = answers[rule.questionId];
        if (!answer || isEmptyAnswer(answer.value) || prerequisiteAnswerIsUnknown(rule, answer.value)) {
            missing.push(`Confirm prerequisite: ${question.prompt}`);
            return;
        }
        const evidence = `${question.prompt} — ${answerLabel(question, answer.value)}`;
        if (matchesRule(answer.value, rule.values)) {
            matches.push(evidence);
        } else {
            blockers.push(`Prerequisite not met: ${evidence}`);
        }
    });
    return { matches, blockers, missing };
}

function prerequisiteAnswerIsUnknown(rule, value) {
    const values = Array.isArray(value) ? value : [value];
    const unknownValues = new Set(['unknown', 'undecided', 'unsure']);
    return values.length > 0 && values.every((item) => unknownValues.has(String(item || '').toLowerCase())) &&
        Boolean(rule && rule.questionId);
}

async function linkedLifecycleOrganisation(assessment, access) {
    if (!assessment || !assessment.lifecycleOrganisationId) {
        return null;
    }
    try {
        const result = await getLifecycleService().getOrganisation(access, assessment.lifecycleOrganisationId);
        return result && result.organisation || null;
    } catch (_error) {
        return null;
    }
}

function buildServicePlanView(assessment, lifecycleOrganisation, access = {}) {
    const recommendations = Array.isArray(assessment && assessment.recommendations)
        ? assessment.recommendations
        : [];
    const core = recommendations.find((item) => item.serviceKey === MANAGED_IT_BUNDLE_KEY);
    if (!core) {
        return {
            available: false,
            model: 'legacy_recommendations'
        };
    }

    const saved = assessment.bundleReview || {};
    const savedComponents = new Map((saved.components || []).map((item) => [item.serviceKey, item.status]));
    const lifecycleContext = lifecycleOrganisation && lifecycleOrganisation.context || {};
    const lifecycleLocations = lifecycleContext.locations && lifecycleContext.locations.items;
    const counts = {
        users: firstWholeNumber(saved.counts && saved.counts.users, lifecycleContext.users && lifecycleContext.users.estimatedCount),
        endpoints: firstWholeNumber(saved.counts && saved.counts.endpoints, lifecycleContext.endpoints && lifecycleContext.endpoints.estimatedCount),
        locations: firstWholeNumber(saved.counts && saved.counts.locations, Array.isArray(lifecycleLocations) && lifecycleLocations.length || 1) || 1
    };
    const pricing = managedItPricing(counts);
    const components = recommendations
        .filter((item) => item.serviceKey !== MANAGED_IT_BUNDLE_KEY)
        .filter((item) => (
            item.fit === 'strong_fit' ||
            item.fit === 'potential_fit' ||
            savedComponents.has(item.serviceKey) ||
            item.review && item.review.decision && item.review.decision !== 'pending'
        ))
        .map((item) => ({
            recommendationId: item.id,
            serviceKey: item.serviceKey,
            serviceName: item.serviceName,
            category: item.category,
            outcome: item.customerOutcome,
            fit: item.fit,
            status: savedComponents.get(item.serviceKey) || componentStatusFromRecommendation(item),
            reasons: item.reasons || [],
            missingInformation: item.missingInformation || [],
            blockers: item.blockers || []
        }));
    const inheritedRationale = recommendations
        .map((item) => item.review && item.review.consultantRationale)
        .find(Boolean) || '';
    const inheritedNextAction = recommendations
        .map((item) => item.review && item.review.nextAction)
        .find(Boolean) || 'Confirm the included components and prepare the draft proposal.';
    const inheritedOwner = recommendations
        .map((item) => item.review && item.review.owner)
        .find(Boolean) || access.user && access.user.email || '';

    return {
        available: true,
        model: 'bundled_managed_it',
        status: saved.status || 'not_saved',
        core: {
            recommendationId: core.id,
            serviceKey: core.serviceKey,
            serviceName: core.serviceName,
            outcome: core.customerOutcome,
            fit: core.fit,
            reasons: core.reasons || [],
            missingInformation: core.missingInformation || [],
            blockers: core.blockers || []
        },
        counts,
        pricing,
        components,
        includedCount: components.filter((item) => item.status === 'included').length,
        confirmationCount: components.filter((item) => item.status === 'needs_confirmation').length,
        owner: saved.owner || inheritedOwner,
        consultantRationale: saved.consultantRationale || inheritedRationale,
        nextAction: saved.nextAction || inheritedNextAction,
        reviewedBy: saved.reviewedBy || '',
        reviewedAt: saved.reviewedAt || ''
    };
}

function applyServicePlanReview(assessment, body, access) {
    const view = buildServicePlanView(assessment, null, access);
    if (!view.available) {
        throw salesError(409, `The published catalogue does not contain the ${MANAGED_IT_POLICY.customerFacingServiceName} bundle`, {
            code: 'managed_it_bundle_unavailable'
        });
    }

    const requestedComponents = Array.isArray(body.components) ? body.components : [];
    const recommendationsByKey = new Map(assessment.recommendations.map((item) => [item.serviceKey, item]));
    const requestedByKey = new Map();
    requestedComponents.forEach((item) => {
        const serviceKey = slugify(item && item.serviceKey);
        const status = cleanText(item && item.status, 60);
        if (!serviceKey || serviceKey === MANAGED_IT_BUNDLE_KEY || !recommendationsByKey.has(serviceKey)) {
            throw salesError(400, 'A service-plan component does not match this assessment', {
                code: 'invalid_service_plan_component'
            });
        }
        if (!ALLOWED_COMPONENT_STATUSES.has(status)) {
            throw salesError(400, 'Choose Included, Needs confirmation or Excluded for every component', {
                code: 'invalid_service_plan_status'
            });
        }
        requestedByKey.set(serviceKey, status);
    });

    const countsInput = body.counts || {};
    const counts = {
        users: requiredWholeNumber(countsInput.users, 'users', 10000),
        endpoints: requiredWholeNumber(countsInput.endpoints, 'devices', 10000),
        locations: requiredWholeNumber(countsInput.locations, 'locations', 50)
    };
    const pricing = managedItPricing(counts);
    if (pricing.status === 'needs_more_info') {
        throw salesError(400, 'Confirmed user, device and location counts are required for bundle pricing', {
            code: 'service_plan_counts_required'
        });
    }

    const componentStatuses = view.components.map((component) => ({
        serviceKey: component.serviceKey,
        status: requestedByKey.get(component.serviceKey) || component.status
    }));
    const now = new Date().toISOString();
    const owner = cleanText(body.owner, 180) || access.user.email;
    const consultantRationale = cleanText(body.consultantRationale, 4000);
    const nextAction = cleanText(body.nextAction, 1000) || 'Prepare and review the draft proposal.';
    assessment.bundleReview = {
        model: 'bundled_managed_it',
        status: 'reviewed',
        counts,
        pricing,
        components: componentStatuses,
        owner,
        consultantRationale,
        nextAction,
        reviewedBy: access.user.email,
        reviewedAt: now
    };

    const core = recommendationsByKey.get(MANAGED_IT_BUNDLE_KEY);
    core.review = Object.assign({}, core.review || {}, {
        decision: 'accepted',
        roadmap: 'now',
        estimatedMrr: pricing.monthly,
        oneOffRevenue: pricing.onboarding,
        owner,
        nextAction,
        consultantRationale,
        customerOutcome: core.customerOutcome,
        reviewedBy: access.user.email,
        reviewedAt: now
    });
    componentStatuses.forEach((component) => {
        const recommendation = recommendationsByKey.get(component.serviceKey);
        if (!recommendation) return;
        recommendation.review = Object.assign({}, recommendation.review || {}, {
            decision: component.status === 'included'
                ? 'accepted'
                : component.status === 'needs_confirmation' ? 'validate' : 'rejected',
            roadmap: component.status === 'included' ? 'now' : component.status === 'needs_confirmation' ? 'next' : 'later',
            reviewedBy: access.user.email,
            reviewedAt: now
        });
    });
    assessment.updatedBy = access.user.email;
    assessment.updatedAt = now;
}

function componentStatusFromRecommendation(recommendation) {
    const decision = recommendation && recommendation.review && recommendation.review.decision;
    if (decision === 'accepted') return 'included';
    if (decision === 'validate') return 'needs_confirmation';
    if (decision === 'rejected') return 'excluded';
    return recommendation && recommendation.fit === 'strong_fit' ? 'included' : 'needs_confirmation';
}

function managedItPricing(counts) {
    const estimate = estimateManagedItPrice({
        users: { estimatedCount: counts.users },
        endpoints: { estimatedCount: counts.endpoints },
        locations: {
            items: counts.locations == null
                ? []
                : Array.from({ length: counts.locations }, (_item, index) => `Location ${index + 1}`)
        }
    });
    return Object.assign(standardPricingSummary(), estimate);
}

function firstWholeNumber(...values) {
    for (const value of values) {
        const number = Number(value);
        if (Number.isInteger(number) && number >= 0) return number;
    }
    return null;
}

function requiredWholeNumber(value, label, maximum) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > maximum) {
        throw salesError(400, `Enter a whole number of ${label} between 1 and ${maximum}`, {
            code: 'invalid_service_plan_count',
            field: label
        });
    }
    return number;
}

function applyRecommendationReview(recommendation, body, access) {
    const decision = normaliseChoice(body.decision, Array.from(ALLOWED_RECOMMENDATION_DECISIONS), 'pending');
    recommendation.review = Object.assign({}, recommendation.review || {}, {
        decision,
        roadmap: normaliseChoice(body.roadmap, Array.from(ALLOWED_ROADMAP_STAGES), 'next'),
        estimatedMrr: nonNegativeMoney(body.estimatedMrr),
        oneOffRevenue: nonNegativeMoney(body.oneOffRevenue),
        owner: cleanText(body.owner, 180),
        nextAction: cleanText(body.nextAction, 1000),
        consultantRationale: cleanText(body.consultantRationale, 4000),
        customerOutcome: cleanText(body.customerOutcome || recommendation.customerOutcome, 2000),
        reviewedBy: access.user.email,
        reviewedAt: new Date().toISOString()
    });
}

function buildProposal(id, customer, assessment, accepted, access) {
    if (assessment.bundleReview && assessment.bundleReview.model === 'bundled_managed_it') {
        return buildBundledProposal(id, customer, assessment, access);
    }
    const now = new Date().toISOString();
    const questionMap = getQuestionMap();
    const answer = (idValue) => {
        const item = assessment.answers[idValue];
        return item ? answerLabel(questionMap.get(idValue), item.value) : '';
    };
    const recommendations = accepted.map((item) => ({
        recommendationId: item.id,
        serviceKey: item.serviceKey,
        serviceName: item.serviceName,
        outcome: item.review.customerOutcome || item.customerOutcome,
        why: item.review.consultantRationale || item.reasons.join(' '),
        confirm: item.missingInformation.concat(item.blockers).join(' '),
        roadmap: item.review.roadmap
    }));
    const pricing = standardPricingSummary();
    const proposal = {
        id,
        customerId: customer.id,
        assessmentId: assessment.id,
        versionNumber: 1,
        title: `${customer.name} — managed IT proposal`,
        status: 'draft',
        executiveSummary: `This proposal is based on the information ${customer.name} provided and the services reviewed with No Fries.`,
        objectives: listFromAnswer(assessment.answers['business.priorities'], questionMap.get('business.priorities')),
        observations: unique(accepted.flatMap((item) => item.reasons)).slice(0, 20),
        recommendations,
        pricing,
        commercialPolicy: proposalPolicyIdentity(),
        commercial: createCommercialSummary(assessment, pricing),
        roadmap: {
            now: recommendations.filter((item) => item.roadmap === 'now').map((item) => item.serviceName),
            next: recommendations.filter((item) => item.roadmap === 'next').map((item) => item.serviceName),
            later: recommendations.filter((item) => item.roadmap === 'later').map((item) => item.serviceName)
        },
        assumptions: [
            'We will check the current set-up, agree what is included and confirm the price before work starts.',
            'No passwords, access tokens or recovery codes were needed for this review.'
        ],
        nextStep: answer('priorities.next_step') || 'Agree the next validation step',
        createdBy: access.user.email,
        createdAt: now,
        updatedBy: access.user.email,
        updatedAt: now,
        approvedBy: '',
        approvedAt: '',
        aiReview: {
            status: 'not_reviewed',
            reviewId: '',
            sourceRevision: 0,
            reviewRevision: 0,
            sourceSha256: '',
            suggestionSha256: '',
            reviewedAt: '',
            reviewedBy: '',
            runtime: '',
            model: '',
            providerModel: '',
            promptVersion: '',
            toolSchemaVersion: '',
            outputSchemaVersion: '',
            policyId: '',
            policyVersion: '',
            policyEffectiveFrom: '',
            releaseSha: '',
            releaseRunId: '',
            reasoningEffort: '',
            blockingCount: 0,
            warningCount: 0,
            changedSections: [],
            traceId: '',
            usage: normaliseReviewUsage(),
            approximateCostUsd: 0,
            latencyMs: 0,
            feedback: null,
            feedbackHistory: []
        },
        aiReviewHistory: [],
        approvalChecks: { checkedAt: '', blockingCount: 0, warnings: [] },
        dynamics: { status: 'not_sent', sentAt: '', handoffId: '', recordUrl: '' }
    };
    const warnings = validateProposalDraft({ proposal, customer, assessment });
    proposal.approvalChecks = {
        checkedAt: now,
        blockingCount: warnings.filter((warning) => warning.blocking).length,
        warnings
    };
    return proposal;
}

function buildBundledProposal(id, customer, assessment, access) {
    const now = new Date().toISOString();
    const review = assessment.bundleReview;
    const recommendationsByKey = new Map(assessment.recommendations.map((item) => [item.serviceKey, item]));
    const core = recommendationsByKey.get(MANAGED_IT_BUNDLE_KEY);
    if (!core || !review || !review.pricing || review.pricing.status === 'needs_more_info') {
        throw salesError(409, `Save the ${MANAGED_IT_POLICY.customerFacingServiceName} service plan with confirmed counts before building a proposal`, {
            code: 'service_plan_review_required'
        });
    }

    const component = (item) => {
        const recommendation = recommendationsByKey.get(item.serviceKey);
        return recommendation ? {
            recommendationId: recommendation.id,
            serviceKey: recommendation.serviceKey,
            serviceName: recommendation.serviceName,
            category: recommendation.category,
            outcome: recommendation.customerOutcome
        } : null;
    };
    const includedComponents = review.components
        .filter((item) => item.status === 'included')
        .map(component)
        .filter(Boolean);
    const validationComponents = review.components
        .filter((item) => item.status === 'needs_confirmation')
        .map(component)
        .filter(Boolean);
    const excludedComponents = review.components
        .filter((item) => item.status === 'excluded')
        .map(component)
        .filter(Boolean);
    const includedRecommendations = [core].concat(includedComponents
        .map((item) => recommendationsByKey.get(item.serviceKey))
        .filter(Boolean));
    const why = review.consultantRationale || unique(includedRecommendations.flatMap((item) => item.reasons || [])).join(' ');
    const confirm = validationComponents.length
        ? `Confirm before the final agreement: ${validationComponents.map((item) => item.serviceName).join(', ')}.`
        : '';
    const recommendation = {
        recommendationId: core.id,
        serviceKey: core.serviceKey,
        serviceName: core.serviceName,
        outcome: core.customerOutcome,
        why,
        confirm,
        roadmap: 'now'
    };
    const pricing = Object.assign(standardPricingSummary(), review.pricing, {
        users: review.counts.users,
        endpoints: review.counts.endpoints,
        locations: review.counts.locations
    });

    const commercial = normaliseCommercialSummary({
        userCount: review.counts.users,
        managedEndpointCount: review.counts.endpoints,
        locationCount: review.counts.locations,
        onboardingFeeExGst: pricing.onboarding,
        termMonths: null,
        plannedStart: '',
        confirmed: false
    }, pricing);
    const proposal = {
        id,
        customerId: customer.id,
        assessmentId: assessment.id,
        versionNumber: 1,
        title: `${customer.name} — ${MANAGED_IT_POLICY.customerFacingServiceName} proposal`,
        status: 'draft',
        commercialModel: 'bundled_managed_it',
        executiveSummary: `This proposal sets out one ${MANAGED_IT_POLICY.customerFacingServiceName} service for ${customer.name}, with the included components and total price reviewed together.`,
        objectives: listFromAnswer(assessment.answers['business.priorities'], getQuestionMap().get('business.priorities')),
        observations: unique(includedRecommendations.flatMap((item) => item.reasons || [])).slice(0, 20),
        recommendations: [recommendation],
        bundle: {
            serviceKey: core.serviceKey,
            serviceName: core.serviceName,
            outcome: core.customerOutcome,
            why,
            confirm,
            owner: review.owner,
            nextAction: review.nextAction,
            includedComponents,
            validationComponents,
            excludedComponents
        },
        pricing,
        commercialPolicy: proposalPolicyIdentity(),
        commercial,
        roadmap: {
            now: [core.serviceName],
            next: validationComponents.map((item) => item.serviceName),
            later: []
        },
        assumptions: (review.pricing.assumptions || []).slice(),
        nextStep: review.nextAction,
        createdBy: access.user.email,
        createdAt: now,
        updatedBy: access.user.email,
        updatedAt: now,
        approvedBy: '',
        approvedAt: '',
        aiReview: {
            status: 'not_reviewed',
            reviewId: '',
            sourceRevision: 0,
            reviewRevision: 0,
            sourceSha256: '',
            suggestionSha256: '',
            reviewedAt: '',
            reviewedBy: '',
            runtime: '',
            model: '',
            providerModel: '',
            promptVersion: '',
            toolSchemaVersion: '',
            outputSchemaVersion: '',
            policyId: '',
            policyVersion: '',
            policyEffectiveFrom: '',
            releaseSha: '',
            releaseRunId: '',
            reasoningEffort: '',
            blockingCount: 0,
            warningCount: 0,
            changedSections: [],
            traceId: '',
            usage: normaliseReviewUsage(),
            approximateCostUsd: 0,
            latencyMs: 0,
            feedback: null,
            feedbackHistory: []
        },
        aiReviewHistory: [],
        approvalChecks: { checkedAt: '', blockingCount: 0, warnings: [] },
        dynamics: { status: 'not_sent', sentAt: '', handoffId: '', recordUrl: '' }
    };
    const warnings = validateProposalDraft({ proposal, customer, assessment });
    proposal.approvalChecks = {
        checkedAt: now,
        blockingCount: warnings.filter((warning) => warning.blocking).length,
        warnings
    };
    return proposal;
}

function applyProposalUpdate(proposal, body, access) {
    const commercialPolicyStatus = assessProposalCommercialPolicy(proposal);
    proposal.title = cleanText(body.title || proposal.title, 240);
    proposal.executiveSummary = cleanText(body.executiveSummary || proposal.executiveSummary, 6000);
    proposal.objectives = cleanStringList(body.objectives, 30, 1000, proposal.objectives);
    proposal.observations = cleanStringList(body.observations, 40, 1600, proposal.observations);
    proposal.assumptions = cleanStringList(body.assumptions, 40, 1600, proposal.assumptions);
    proposal.nextStep = cleanText(body.nextStep || proposal.nextStep, 2000);
    const proposalPricing = proposal.pricing || {};
    const commercialInput = proposal.commercialModel === 'bundled_managed_it'
        ? Object.assign({}, body.commercial || {}, {
            userCount: proposalPricing.users,
            managedEndpointCount: proposalPricing.endpoints,
            locationCount: proposalPricing.locations,
            onboardingFeeExGst: proposalPricing.onboarding
        })
        : body.commercial;
    proposal.commercial = normaliseCommercialSummary(
        commercialInput,
        proposalPricing,
        proposal.commercial || {},
        { allowPolicyDefaults: commercialPolicyStatus.approvalAllowed }
    );
    if (Array.isArray(body.recommendations)) {
        proposal.recommendations = body.recommendations.slice(0, 100).map((item) => ({
            recommendationId: cleanText(item.recommendationId, 180),
            serviceKey: slugify(item.serviceKey),
            serviceName: cleanText(item.serviceName, 240),
            outcome: cleanText(item.outcome, 3000),
            why: cleanText(item.why, 4000),
            confirm: cleanText(item.confirm, 3000),
            roadmap: normaliseChoice(item.roadmap, Array.from(ALLOWED_ROADMAP_STAGES), 'next')
        }));
    }
    proposal.roadmap = {
        now: proposal.recommendations.filter((item) => item.roadmap === 'now').map((item) => item.serviceName),
        next: proposal.recommendations.filter((item) => item.roadmap === 'next').map((item) => item.serviceName),
        later: proposal.recommendations.filter((item) => item.roadmap === 'later').map((item) => item.serviceName)
    };
    if (proposal.commercialModel === 'bundled_managed_it' && proposal.bundle && proposal.recommendations[0]) {
        const bundleRecommendation = proposal.recommendations[0];
        proposal.bundle.serviceName = bundleRecommendation.serviceName;
        proposal.bundle.outcome = bundleRecommendation.outcome;
        proposal.bundle.why = bundleRecommendation.why;
        proposal.bundle.confirm = bundleRecommendation.confirm;
        proposal.bundle.nextAction = proposal.nextStep;
        proposal.roadmap = {
            now: [bundleRecommendation.serviceName],
            next: (proposal.bundle.validationComponents || []).map((item) => item.serviceName),
            later: []
        };
    }
    proposal.status = body.status === 'approved' ? 'approved' : 'draft';
    proposal.updatedBy = access.user.email;
    proposal.updatedAt = new Date().toISOString();
    proposal.aiReview = Object.assign({}, proposal.aiReview || {}, {
        status: 'stale_after_edit'
    });
    const currentReviewHistory = (Array.isArray(proposal.aiReviewHistory) ? proposal.aiReviewHistory : [])
        .find((item) => item && item.reviewId === proposal.aiReview.reviewId);
    if (currentReviewHistory) currentReviewHistory.status = 'stale_after_edit';
    if (proposal.status === 'approved') {
        proposal.approvedBy = access.user.email;
        proposal.approvedAt = proposal.updatedAt;
    }
}

function nextProposalVersionNumber(proposals, assessmentId) {
    return (proposals || []).reduce((maximum, proposal) => {
        if (!proposal || proposal.assessmentId !== assessmentId) return maximum;
        const versionNumber = Number(proposal.versionNumber);
        return Number.isInteger(versionNumber) && versionNumber > maximum ? versionNumber : maximum;
    }, 0) + 1;
}

function buildDynamicsPayload(state, customer, assessment, proposal) {
    const acceptedById = new Map(assessment.recommendations.map((item) => [item.id, item]));
    const bundled = proposal.commercialModel === 'bundled_managed_it' && proposal.bundle;
    const opportunities = bundled ? [{
        deduplicationKey: `${state.tenant.key}:${assessment.id}:${MANAGED_IT_BUNDLE_KEY}`,
        serviceKey: MANAGED_IT_BUNDLE_KEY,
        name: proposal.bundle.serviceName,
        customerOutcome: proposal.bundle.outcome,
        discoverySummary: proposal.bundle.why,
        stage: 'Qualify',
        estimatedMonthlyRevenue: nonNegativeMoney(proposal.pricing && proposal.pricing.monthly),
        estimatedOneOffRevenue: nonNegativeMoney(proposal.pricing && proposal.pricing.onboarding),
        owner: proposal.bundle.owner || null,
        nextAction: proposal.nextStep,
        roadmap: 'now',
        includedComponents: (proposal.bundle.includedComponents || []).map((item) => ({
            serviceKey: item.serviceKey,
            serviceName: item.serviceName
        })),
        componentsToConfirm: (proposal.bundle.validationComponents || []).map((item) => ({
            serviceKey: item.serviceKey,
            serviceName: item.serviceName
        }))
    }] : proposal.recommendations.map((item) => {
        const recommendation = acceptedById.get(item.recommendationId);
        const review = recommendation && recommendation.review || {};
        return {
            deduplicationKey: `${state.tenant.key}:${assessment.id}:${item.serviceKey}`,
            serviceKey: item.serviceKey,
            name: item.serviceName,
            customerOutcome: item.outcome,
            discoverySummary: item.why,
            stage: 'Qualify',
            estimatedMonthlyRevenue: nonNegativeMoney(review.estimatedMrr),
            estimatedOneOffRevenue: nonNegativeMoney(review.oneOffRevenue),
            owner: review.owner || null,
            nextAction: review.nextAction || proposal.nextStep,
            roadmap: item.roadmap
        };
    });
    return {
        source: 'No Fries',
        schemaVersion: bundled ? '2026-08-2' : '2026-07-1',
        tenantKey: state.tenant.key,
        customer: {
            noFriesCustomerId: customer.id,
            dynamicsAccountId: customer.dynamicsAccountId || null,
            name: customer.name,
            accountOwner: customer.accountOwner || null
        },
        assessment: {
            id: assessment.id,
            completedAt: assessment.completedAt || assessment.updatedAt,
            proposalId: proposal.id
        },
        opportunities,
        task: {
            subject: proposal.nextStep,
            regardingAccountId: customer.dynamicsAccountId || null
        },
        approved: {
            by: proposal.approvedBy,
            at: proposal.approvedAt
        }
    };
}

async function sendDynamicsHandoff(payload) {
    const status = dynamicsStatus();
    if (!status.configured) {
        throw salesError(503, 'Dynamics handoff is not configured for this tenant', {
            code: 'dynamics_not_configured'
        });
    }
    if (!status.productionWriteEnabled) {
        throw salesError(503, 'Dynamics preview is available, but production writes are disabled', {
            code: 'dynamics_write_disabled'
        });
    }

    const endpoint = String(process.env.NOFRIES_DYNAMICS_FLOW_URL || '').trim();
    const headers = { 'Content-Type': 'application/json' };
    if (status.authentication === 'oauth_client_credentials') {
        const { ClientSecretCredential } = require('@azure/identity');
        const credential = new ClientSecretCredential(
            process.env.NOFRIES_DYNAMICS_TENANT_ID,
            process.env.NOFRIES_DYNAMICS_CLIENT_ID,
            process.env.NOFRIES_DYNAMICS_CLIENT_SECRET
        );
        const token = await credential.getToken(process.env.NOFRIES_DYNAMICS_SCOPE);
        headers.Authorization = `Bearer ${token.token}`;
    } else if (status.authentication === 'managed_identity') {
        const { DefaultAzureCredential } = require('@azure/identity');
        const token = await new DefaultAzureCredential().getToken(process.env.NOFRIES_DYNAMICS_SCOPE);
        headers.Authorization = `Bearer ${token.token}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        const responseBody = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw salesError(502, 'Dynamics rejected the approved handoff', {
                code: 'dynamics_handoff_failed',
                downstreamStatus: response.status
            });
        }
        return responseBody;
    } finally {
        clearTimeout(timeout);
    }
}

function dynamicsStatus() {
    const endpoint = String(process.env.NOFRIES_DYNAMICS_FLOW_URL || '').trim();
    const scope = String(process.env.NOFRIES_DYNAMICS_SCOPE || '').trim();
    const clientCredentials = Boolean(
        process.env.NOFRIES_DYNAMICS_TENANT_ID &&
        process.env.NOFRIES_DYNAMICS_CLIENT_ID &&
        process.env.NOFRIES_DYNAMICS_CLIENT_SECRET &&
        scope
    );
    const managedIdentity = Boolean(scope && String(process.env.NOFRIES_DYNAMICS_USE_MANAGED_IDENTITY || '').toLowerCase() === 'true');
    const signedUrlAllowed = String(process.env.NOFRIES_DYNAMICS_ALLOW_SIGNED_URL || '').toLowerCase() === 'true';
    return {
        configured: Boolean(endpoint && (clientCredentials || managedIdentity || signedUrlAllowed)),
        endpointConfigured: Boolean(endpoint),
        authentication: clientCredentials
            ? 'oauth_client_credentials'
            : managedIdentity
                ? 'managed_identity'
                : signedUrlAllowed
                    ? 'signed_url'
                    : 'not_configured',
        mode: 'one_way_user_initiated',
        productionWriteEnabled: String(process.env.NOFRIES_DYNAMICS_WRITE_ENABLED || '').toLowerCase() === 'true'
    };
}

function renderProposalDocument(proposal, customer, tenant) {
    const pricing = Object.assign({}, proposal.pricing || {});
    const bundled = proposal.commercialModel === 'bundled_managed_it' && proposal.bundle;
    const commercialSeed = bundled
        ? Object.assign({
            userCount: pricing.users,
            managedEndpointCount: pricing.endpoints,
            locationCount: pricing.locations,
            onboardingFeeExGst: pricing.onboarding
        }, proposal.commercial || {})
        : proposal.commercial;
    const commercial = normaliseCommercialSummary(
        commercialSeed,
        pricing,
        {},
        { allowPolicyDefaults: false }
    );
    const list = (values) => values && values.length
        ? `<ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join('')}</ul>`
        : '<p>Not captured.</p>';
    const legacyRecommendationHtml = proposal.recommendations.map((item) => [
        '<section class="recommendation">',
        `<h3>${escapeHtml(item.serviceName)}</h3>`,
        `<p><strong>What you get:</strong> ${escapeHtml(item.outcome)}</p>`,
        `<p><strong>Why this helps:</strong> ${escapeHtml(item.why)}</p>`,
        item.confirm ? `<p><strong>Still to confirm:</strong> ${escapeHtml(item.confirm)}</p>` : '',
        `<p><strong>Timing:</strong> ${escapeHtml(proposalTimingLabel(item.roadmap))}</p>`,
        '</section>'
    ].join('')).join('');
    const bundleComponentList = (items) => items && items.length
        ? `<ul>${items.map((item) => `<li><strong>${escapeHtml(item.serviceName)}</strong> — ${escapeHtml(item.outcome)}</li>`).join('')}</ul>`
        : '<p>No optional components selected.</p>';
    const recommendationHtml = bundled ? [
        '<section class="recommendation">',
        `<h3>${escapeHtml(proposal.bundle.serviceName)}</h3>`,
        `<p><strong>What you get:</strong> ${escapeHtml(proposal.bundle.outcome)}</p>`,
        proposal.bundle.why ? `<p><strong>Why this helps:</strong> ${escapeHtml(proposal.bundle.why)}</p>` : '',
        '<h4>Included components</h4>',
        bundleComponentList(proposal.bundle.includedComponents),
        proposal.bundle.validationComponents && proposal.bundle.validationComponents.length
            ? `<h4>To confirm before the final agreement</h4>${bundleComponentList(proposal.bundle.validationComponents)}`
            : '',
        '</section>'
    ].join('') : legacyRecommendationHtml;
    const agreementDetails = `${commercial.termMonths ? ` Proposed term: ${escapeHtml(commercial.termMonths)} months.` : ''}${commercial.plannedStart ? ` Planned start: ${escapeHtml(formatDate(commercial.plannedStart))}.` : ''}`;
    const pricingHtml = bundled ? [
        `<p><strong>NZ$${escapeHtml(Number(commercial.monthlyTotalExGst || pricing.monthly || 0).toLocaleString('en-NZ'))} + GST per month.</strong> Based on ${escapeHtml(commercial.userCount)} supported people, ${escapeHtml(commercial.managedEndpointCount)} managed computers and ${escapeHtml(commercial.locationCount)} supported location${commercial.locationCount === 1 ? '' : 's'}.</p>`,
        `<p><strong>NZ$${escapeHtml(Number(commercial.onboardingFeeExGst || pricing.onboarding || 0).toLocaleString('en-NZ'))} + GST initial set-up.</strong>${agreementDetails} The included components above form one managed service and are not priced as separate line items.</p>`
    ].join('') : commercial.monthlyTotalExGst == null ? [
        `<p><strong>NZ$${escapeHtml(pricing.perUserMonthly)} + GST per user each month.</strong> This includes support and device care for one main work computer per user.</p>`,
        `<p>Initial set-up starts at NZ$${escapeHtml(pricing.onboardingFrom.toLocaleString('en-NZ'))} + GST. Extra computers are NZ$${escapeHtml(pricing.additionalEndpointMonthly)} + GST each per month and extra locations are NZ$${escapeHtml(pricing.additionalLocationMonthly)} + GST each per month. The final total is confirmed before the service starts.</p>`
    ].join('') : [
        `<p><strong>NZ$${escapeHtml(commercial.monthlyTotalExGst.toLocaleString('en-NZ'))} + GST per month.</strong> Based on ${escapeHtml(commercial.userCount)} supported people, ${escapeHtml(commercial.managedEndpointCount)} managed computers and ${escapeHtml(commercial.locationCount)} supported location${commercial.locationCount === 1 ? '' : 's'}.</p>`,
        `<p>Initial set-up: NZ$${escapeHtml(commercial.onboardingFeeExGst.toLocaleString('en-NZ'))} + GST.${agreementDetails}</p>`
    ].join('');
    return [
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">',
        `<title>${escapeHtml(proposal.title)}</title>`,
        '<style>',
        '@page{margin:18mm}body{font-family:Arial,sans-serif;color:#14201f;line-height:1.45;max-width:900px;margin:0 auto}h1{font-size:32px;margin-bottom:6px}h2{margin-top:28px;border-bottom:2px solid #187b73;padding-bottom:6px}h3{margin-bottom:6px}.meta{color:#5d6f6c}.recommendation{break-inside:avoid;border:1px solid #d7e0de;padding:14px;margin:12px 0}li{margin:5px 0}.footer{margin-top:36px;color:#5d6f6c;font-size:12px}',
        '</style></head><body>',
        `<h1>${escapeHtml(proposal.title)}</h1>`,
        `<p class="meta">Prepared for ${escapeHtml(customer.name)} · ${escapeHtml(formatDate(proposal.updatedAt))}</p>`,
        '<h2>Executive summary</h2>',
        `<p>${escapeHtml(proposal.executiveSummary)}</p>`,
        '<h2>Your priorities</h2>',
        list(proposal.objectives),
        '<h2>What we heard</h2>',
        list(proposal.observations),
        bundled ? `<h2>Your ${escapeHtml(proposal.bundle.serviceName)} service</h2>` : '<h2>Recommended services</h2>',
        recommendationHtml,
        `<h2>${commercial.monthlyTotalExGst == null ? 'Indicative pricing' : 'Commercial summary'}</h2>`,
        pricingHtml,
        '<h2>Timing</h2>',
        '<h3>At service start</h3>', list(proposal.roadmap.now),
        '<h3>Planned next phase</h3>', list(proposal.roadmap.next),
        '<h3>Future options</h3>', list(proposal.roadmap.later),
        '<h2>Important notes</h2>',
        list(proposal.assumptions),
        '<h2>Next step</h2>',
        `<p>${escapeHtml(proposal.nextStep)}</p>`,
        `<p class="footer">Prepared from the approved ${escapeHtml(tenant.name)} customer review. Internal pricing notes are not included.</p>`,
        '</body></html>'
    ].join('');
}

function standardPricingSummary() {
    return {
        policyId: MANAGED_IT_POLICY.policyId,
        policyVersion: PRICE_VERSION,
        policyEffectiveFrom: MANAGED_IT_POLICY.effectiveFrom,
        serviceName: MANAGED_IT_POLICY.customerFacingServiceName,
        currency: STANDARD_PRICE.currency,
        gstExclusive: STANDARD_PRICE.gstExclusive,
        perUserMonthly: STANDARD_PRICE.perUserMonthly,
        includedEndpointsPerUser: STANDARD_PRICE.includedEndpointsPerUser,
        includedLocations: STANDARD_PRICE.includedLocations,
        onboardingFrom: STANDARD_PRICE.onboardingFrom,
        additionalEndpointMonthly: STANDARD_PRICE.additionalEndpointMonthly,
        additionalLocationMonthly: STANDARD_PRICE.additionalLocationMonthly,
        additionalEndpointOnboarding: STANDARD_PRICE.additionalEndpointOnboarding,
        additionalLocationOnboarding: STANDARD_PRICE.additionalLocationOnboarding
    };
}

function proposalPolicyIdentity() {
    return Object.assign(managedItPolicyIdentity(), { policyVersion: PRICE_VERSION });
}

function normaliseReviewUsage(value = {}) {
    return {
        inputTokens: nonNegativeInteger(value.inputTokens),
        cachedInputTokens: nonNegativeInteger(value.cachedInputTokens),
        cacheWriteTokens: nonNegativeInteger(value.cacheWriteTokens),
        outputTokens: nonNegativeInteger(value.outputTokens),
        reasoningTokens: nonNegativeInteger(value.reasoningTokens),
        totalTokens: nonNegativeInteger(value.totalTokens)
    };
}

function proposalTimingLabel(value) {
    return {
        now: 'At service start',
        next: 'Planned next phase',
        later: 'Future option'
    }[String(value || '').toLowerCase()] || 'Timing to confirm';
}

function getPublishedCatalogue(state) {
    return state.catalogue.versions.find((item) => item.id === state.catalogue.publishedVersionId && item.status === 'published') || null;
}

function publicCatalogueVersion(version) {
    return {
        id: version.id,
        versionNumber: version.versionNumber,
        label: version.label,
        status: version.status,
        serviceCount: version.serviceCount,
        warnings: version.warnings || [],
        importedBy: version.importedBy,
        importedAt: version.importedAt,
        publishedBy: version.publishedBy,
        publishedAt: version.publishedAt
    };
}

function publicCustomer(customer) {
    return Object.assign({}, customer);
}

function publicAssessmentSummary(assessment) {
    return {
        id: assessment.id,
        customerId: assessment.customerId,
        lifecycleOrganisationId: assessment.lifecycleOrganisationId || '',
        title: assessment.title,
        status: assessment.status,
        recommendationCount: assessment.recommendations.filter((item) => (
            item.fit === 'strong_fit' || item.fit === 'potential_fit'
        )).length,
        acceptedCount: assessment.recommendations.filter((item) => item.review && item.review.decision === 'accepted').length,
        servicePlanStatus: assessment.bundleReview && assessment.bundleReview.status || '',
        createdAt: assessment.createdAt,
        updatedAt: assessment.updatedAt,
        completedAt: assessment.completedAt
    };
}

function publicProposalSummary(proposal) {
    const approvalSeal = proposal.approvalSeal || {};
    const commercialPolicyStatus = assessProposalCommercialPolicy(proposal);
    return {
        id: proposal.id,
        customerId: proposal.customerId,
        assessmentId: proposal.assessmentId,
        versionNumber: proposal.versionNumber || 1,
        title: proposal.title,
        status: proposal.status,
        approvalSealStatus: approvalSeal.status || 'not_sealed',
        approvedVersion: approvalSeal.version || '',
        approvedSha256: approvalSeal.sha256 || '',
        commercialPolicyStatus: commercialPolicyStatus.status,
        commercialModel: proposal.commercialModel || 'service_recommendations',
        recommendationCount: proposal.recommendations.length,
        dynamics: proposal.dynamics,
        createdAt: proposal.createdAt,
        updatedAt: proposal.updatedAt,
        approvedAt: proposal.approvedAt
    };
}

function proposalForEditor(proposal, customer, assessment) {
    const result = Object.assign({}, proposal);
    const approvalSeal = proposal.approvalSeal || {};
    result.versionNumber = proposal.versionNumber || 1;
    result.approvalSealStatus = approvalSeal.status || 'not_sealed';
    result.approvedVersion = approvalSeal.version || '';
    result.approvedSha256 = approvalSeal.sha256 || '';
    const pricing = Object.assign({}, proposal.pricing || {});
    result.pricing = pricing;
    if (proposal.commercialPolicy && typeof proposal.commercialPolicy === 'object') {
        result.commercialPolicy = Object.assign({}, proposal.commercialPolicy);
    } else {
        delete result.commercialPolicy;
    }
    result.commercialPolicyStatus = assessProposalCommercialPolicy(proposal);
    const commercialSeed = proposal.commercialModel === 'bundled_managed_it'
        ? Object.assign({
            userCount: pricing.users,
            managedEndpointCount: pricing.endpoints,
            locationCount: pricing.locations,
            onboardingFeeExGst: pricing.onboarding,
            termMonths: null,
            plannedStart: '',
            confirmed: false
        }, proposal.commercial || {})
        : proposal.commercial || createCommercialSummary(assessment, pricing);
    result.commercial = normaliseCommercialSummary(
        commercialSeed,
        pricing,
        {},
        { allowPolicyDefaults: false }
    );
    const warnings = validateProposalDraft({
        proposal: result,
        customer,
        assessment,
        requireCurrentCommercialPolicy: true
    });
    result.approvalChecks = {
        checkedAt: proposal.approvalChecks && proposal.approvalChecks.checkedAt || '',
        blockingCount: warnings.filter((warning) => warning.blocking).length,
        warnings
    };
    result.aiReview = Object.assign({
        status: 'not_reviewed',
        reviewId: '',
        sourceRevision: 0,
        reviewRevision: 0,
        sourceSha256: '',
        suggestionSha256: '',
        reviewedAt: '',
        reviewedBy: '',
        runtime: '',
        model: '',
        providerModel: '',
        promptVersion: '',
        toolSchemaVersion: '',
        outputSchemaVersion: '',
        policyId: '',
        policyVersion: '',
        policyEffectiveFrom: '',
        releaseSha: '',
        releaseRunId: '',
        reasoningEffort: '',
        blockingCount: 0,
        warningCount: 0,
        changedSections: [],
        traceId: '',
        usage: normaliseReviewUsage(),
        approximateCostUsd: 0,
        latencyMs: 0,
        feedback: null,
        feedbackHistory: []
    }, proposal.aiReview || {});
    result.aiReviewHistory = Array.isArray(proposal.aiReviewHistory) ? proposal.aiReviewHistory : [];
    return result;
}

function proposalReviewEvidence(assessment) {
    const questionMap = getQuestionMap();
    return Object.entries(assessment.answers || {}).map(([questionId, answer]) => {
        const question = questionMap.get(questionId);
        return {
            questionId,
            question: question && question.prompt || questionId,
            answer: question
                ? answerLabel(question, answer && answer.value)
                : cleanText(answer && answer.value, 1000),
            notes: cleanText(answer && answer.notes, 2000),
            confidence: cleanText(answer && answer.confidence, 40)
        };
    }).filter((item) => item.answer || item.notes);
}

function proposalReviewHash(value) {
    return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function proposalReviewSuggestionView(proposal = {}) {
    return {
        title: cleanText(proposal.title, 240),
        executiveSummary: cleanText(proposal.executiveSummary, 6000),
        objectives: cleanStringList(proposal.objectives, 30, 1000, []),
        observations: cleanStringList(proposal.observations, 40, 1600, []),
        assumptions: cleanStringList(proposal.assumptions, 40, 1600, []),
        nextStep: cleanText(proposal.nextStep, 2000),
        recommendations: (Array.isArray(proposal.recommendations) ? proposal.recommendations : []).slice(0, 100).map((item) => ({
            recommendationId: cleanText(item.recommendationId, 180),
            serviceKey: slugify(item.serviceKey),
            serviceName: cleanText(item.serviceName, 240),
            outcome: cleanText(item.outcome, 3000),
            why: cleanText(item.why, 4000),
            confirm: cleanText(item.confirm, 3000),
            roadmap: normaliseChoice(item.roadmap, Array.from(ALLOWED_ROADMAP_STAGES), 'next')
        }))
    };
}

function recordProposalReviewFeedback(proposal, input = {}) {
    const currentReview = proposal.aiReview || {};
    if (!input.reviewId || currentReview.reviewId !== input.reviewId) {
        throw salesError(409, 'Feedback can only be recorded against the current proposal review', {
            code: 'proposal_review_feedback_stale',
            currentReviewId: cleanText(currentReview.reviewId, 180)
        });
    }
    if (input.outcome !== 'rejected'
        && input.resultingProposalRevision <= Number(currentReview.reviewRevision || currentReview.sourceRevision || 0)) {
        throw salesError(409, 'Apply or save the reviewed proposal before recording accepted or edited feedback', {
            code: 'proposal_review_feedback_requires_persisted_proposal'
        });
    }
    const persistedProposalSha256 = proposalReviewHash(proposalReviewSuggestionView(proposal));
    if (input.outcome === 'accepted' && persistedProposalSha256 !== cleanText(currentReview.suggestionSha256, 64)) {
        throw salesError(409, 'Accepted feedback requires the persisted proposal wording to match the reviewed suggestion', {
            code: 'proposal_review_feedback_content_mismatch',
            persistedProposalSha256
        });
    }
    const existingOutcome = currentReview.feedback && currentReview.feedback.outcome;
    const acceptedEdit = existingOutcome === 'accepted' && input.outcome === 'edited';
    if (existingOutcome && existingOutcome !== input.outcome && !acceptedEdit) {
        throw salesError(409, 'This proposal review already has a different recorded outcome', {
            code: 'proposal_review_feedback_conflict'
        });
    }
    if (existingOutcome === input.outcome) return currentReview.feedback;
    const feedback = {
        reviewId: input.reviewId,
        outcome: input.outcome,
        recordedAt: input.recordedAt,
        recordedBy: input.recordedBy,
        sourceSha256: cleanText(currentReview.sourceSha256, 64),
        suggestionSha256: cleanText(currentReview.suggestionSha256, 64),
        persistedProposalSha256,
        resultingProposalRevision: input.resultingProposalRevision,
        changedSections: cleanStringList(input.changedSections, 20, 120, []),
        reason: cleanText(input.reason, 1000)
    };
    currentReview.feedback = feedback;
    currentReview.feedbackHistory = (Array.isArray(currentReview.feedbackHistory)
        ? currentReview.feedbackHistory
        : []).concat([cloneJson(feedback)]);
    const historyEntry = (Array.isArray(proposal.aiReviewHistory) ? proposal.aiReviewHistory : [])
        .find((item) => item && item.reviewId === input.reviewId);
    if (historyEntry) {
        historyEntry.feedback = cloneJson(feedback);
        historyEntry.feedbackHistory = (Array.isArray(historyEntry.feedbackHistory)
            ? historyEntry.feedbackHistory
            : []).concat([cloneJson(feedback)]);
    }
    return feedback;
}

function canonicalJson(value) {
    if (value == null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function assertWorkspaceRevision(state, expectedRevision) {
    if (expectedRevision == null || expectedRevision === '') return;
    const expected = Number(expectedRevision);
    if (!Number.isInteger(expected) || expected < 0) {
        throw salesError(400, 'A valid workspace revision is required', {
            code: 'invalid_revision'
        });
    }
    if (Number(state.revision || 0) !== expected) {
        throw salesError(409, 'This workspace changed while you were editing it. Reload and try again.', {
            code: 'revision_conflict',
            currentRevision: Number(state.revision || 0)
        });
    }
}

function assertCustomerDeletionAllowed(state, customer, body, options = {}) {
    const deletionClaim = customer.deletionClaim && typeof customer.deletionClaim === 'object'
        ? customer.deletionClaim
        : null;
    const claimExpired = deletionClaim && customerDeletionClaimExpired(
        deletionClaim,
        options.at instanceof Date ? options.at.getTime() : Date.now()
    );
    if (
        deletionClaim &&
        deletionClaim.status === 'claimed' &&
        deletionClaim.id !== cleanText(options.deletionClaimId, 180) &&
        !(options.allowExpiredDeletionClaim === true && claimExpired)
    ) {
        throw salesError(409, 'This customer already has an active deletion claim', {
            code: 'customer_deletion_in_progress',
            deletionClaimId: cleanText(deletionClaim.id, 180),
            leaseUntil: cleanText(deletionClaim.leaseUntil, 80)
        });
    }
    if (cleanText(body.confirmName, 180) !== customer.name) {
        throw salesError(400, 'Type the exact customer name to confirm deletion', {
            code: 'deletion_confirmation_required'
        });
    }
    const retainedProposal = state.proposals.find((proposal) => (
        proposal.customerId === customer.id && (
            proposal.status === 'approved' ||
            proposal.approvalSeal && proposal.approvalSeal.status === 'sealed'
        )
    ));
    if (retainedProposal) {
        throw salesError(409, 'Approved and sealed proposal evidence must be retained', {
            code: 'approved_proposal_retention_required',
            proposalId: retainedProposal.id
        });
    }
}

function assertCustomerNotDeletionClaimed(customer) {
    const deletionClaim = customer && customer.deletionClaim;
    if (deletionClaim && deletionClaim.status === 'claimed') {
        throw salesError(409, 'This customer has an active deletion claim and cannot be changed or handed off', {
            code: 'customer_deletion_in_progress',
            deletionClaimId: cleanText(deletionClaim.id, 180),
            leaseUntil: cleanText(deletionClaim.leaseUntil, 80)
        });
    }
}

function customerDeletionClaimExpired(claim, atTime) {
    const leaseUntil = Date.parse(String(claim.leaseUntil || ''));
    if (Number.isFinite(leaseUntil)) return leaseUntil <= atTime;
    const claimedAt = Date.parse(String(claim.claimedAt || ''));
    return Number.isFinite(claimedAt) && claimedAt + CUSTOMER_DELETION_CLAIM_LEASE_MS <= atTime;
}

function customerDeletionReceipt(state, customerId) {
    const receipts = state && state.customerDeletionReceiptsById;
    return receipts && Object.prototype.hasOwnProperty.call(receipts, customerId)
        ? receipts[customerId]
        : null;
}

function assertCustomerDeletionReceipt(receipt, customerId, body = {}, options = {}) {
    const generation = Number(receipt && receipt.deletionFenceGeneration || 0);
    const status = cleanText(receipt && receipt.status, 40);
    const receiptIsValid = receipt && typeof receipt === 'object' &&
        cleanText(receipt.customerId, 180) === customerId &&
        cleanText(receipt.salesCustomerId, 180) === customerId &&
        cleanText(receipt.customerName, 180) &&
        cleanText(receipt.deletionClaimId, 180) &&
        Number.isInteger(generation) && generation > 0 &&
        ['source_deleted', 'target_completed'].includes(status) &&
        (status !== 'source_deleted' || (
            cleanText(receipt.lifecycleOrganisationId, 180) &&
            cleanText(receipt.assessmentId, 180)
        ));
    if (!receiptIsValid) {
        throw salesError(409, 'The durable customer-deletion receipt requires reconciliation', {
            code: 'customer_deletion_receipt_invalid',
            customerId
        });
    }
    const claimMismatch = options.deletionClaimId &&
        cleanText(receipt.deletionClaimId, 180) !== cleanText(options.deletionClaimId, 180);
    const generationMismatch = options.deletionFenceGeneration &&
        generation !== Number(options.deletionFenceGeneration);
    if (claimMismatch || generationMismatch) {
        throw salesError(409, 'The durable customer-deletion receipt belongs to a different fencing claim', {
            code: 'customer_deletion_receipt_conflict',
            customerId,
            deletionClaimId: cleanText(receipt.deletionClaimId, 180),
            deletionFenceGeneration: generation
        });
    }
    if (options.requireConfirmation !== false && cleanText(body.confirmName, 180) !== receipt.customerName) {
        throw salesError(400, 'Type the exact customer name to confirm deletion recovery', {
            code: 'deletion_confirmation_required'
        });
    }
    return receipt;
}

async function markCustomerDeletionTargetCompleted(
    repository,
    access,
    customerId,
    deletionClaimId,
    deletionFenceGeneration,
    lifecycleRevision,
    lifecycleOutcome = 'completed'
) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const current = await repository.read(access);
        const receipt = assertCustomerDeletionReceipt(
            customerDeletionReceipt(current, customerId),
            customerId,
            {},
            {
                deletionClaimId,
                deletionFenceGeneration,
                requireConfirmation: false
            }
        );
        if (receipt.status === 'target_completed') return current;
        try {
            const completed = await repository.mutate(access, {
                expectedRevision: current.revision,
                action: 'customer.deletion_target_completed',
                targetType: 'customer_deletion_receipt',
                targetId: customerId,
                summary: 'Lifecycle deletion fence completed for deleted Sales customer'
            }, (state) => {
                const mutableReceipt = assertCustomerDeletionReceipt(
                    customerDeletionReceipt(state, customerId),
                    customerId,
                    {},
                    {
                        deletionClaimId,
                        deletionFenceGeneration,
                        requireConfirmation: false
                    }
                );
                if (mutableReceipt.status === 'target_completed') return mutableReceipt;
                mutableReceipt.status = 'target_completed';
                mutableReceipt.targetCompletedAt = new Date().toISOString();
                mutableReceipt.targetCompletedBy = access.user.email;
                mutableReceipt.lifecycleOutcome = lifecycleOutcome;
                mutableReceipt.lifecycleRevision = Number(lifecycleRevision || mutableReceipt.lifecycleRevision || 0);
                return mutableReceipt;
            });
            return completed.state;
        } catch (error) {
            if (!(error && error.details && error.details.code === 'revision_conflict')) throw error;
        }
    }
    throw salesError(409, 'The Lifecycle completion receipt could not be recorded after concurrent workspace changes', {
        code: 'customer_deletion_receipt_completion_conflict',
        customerId,
        deletionClaimId,
        deletionFenceGeneration
    });
}

function customerDeletionTargetCompletionError(receipt, completionError) {
    return salesError(409, 'Sales deletion completed but the Lifecycle deletion fence requires reconciliation', {
        code: 'customer_deletion_target_completion_failed',
        completionErrorCode: cleanText(
            completionError && completionError.details && completionError.details.code || 'lifecycle_deletion_completion_failed',
            120
        ),
        lifecycleOrganisationId: cleanText(receipt.lifecycleOrganisationId, 180),
        salesCustomerId: cleanText(receipt.salesCustomerId, 180),
        deletionClaimId: cleanText(receipt.deletionClaimId, 180),
        deletionFenceGeneration: Number(receipt.deletionFenceGeneration || 0)
    });
}

function isLifecycleOrganisationNotFound(error) {
    return Number(error && error.statusCode || 0) === 404 &&
        cleanText(error && error.details && error.details.code, 120) === 'organisation_not_found';
}

async function releaseCustomerDeletionClaim(repository, access, customerId, deletionClaimId, summary) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const current = await repository.read(access);
        const customer = current.customers.find((candidate) => candidate.id === customerId);
        if (!customer || !customer.deletionClaim) return current;
        if (cleanText(customer.deletionClaim.id, 180) !== deletionClaimId) {
            throw salesError(409, 'The customer deletion claim changed during reconciliation', {
                code: 'customer_deletion_claim_conflict',
                customerId,
                deletionClaimId
            });
        }
        try {
            const released = await repository.mutate(access, {
                expectedRevision: current.revision,
                action: 'customer.deletion_claim_released',
                targetType: 'customer',
                targetId: customerId,
                summary
            }, (state) => {
                const mutableCustomer = findCustomer(state, customerId);
                if (!mutableCustomer.deletionClaim || mutableCustomer.deletionClaim.id !== deletionClaimId) {
                    throw salesError(409, 'The customer deletion claim changed during reconciliation', {
                        code: 'customer_deletion_claim_conflict',
                        customerId,
                        deletionClaimId
                    });
                }
                mutableCustomer.deletionFenceGeneration = Math.max(
                    Number(mutableCustomer.deletionFenceGeneration || 0),
                    Number(mutableCustomer.deletionClaim.generation || 0)
                );
                delete mutableCustomer.deletionClaim;
                return mutableCustomer;
            });
            return released.state;
        } catch (error) {
            if (!(error && error.details && error.details.code === 'revision_conflict')) throw error;
        }
    }
    throw salesError(409, 'The customer deletion claim could not be released after concurrent workspace changes', {
        code: 'customer_deletion_claim_release_conflict',
        customerId,
        deletionClaimId
    });
}

function customerScopingRelink(state, customer) {
    const lifecycleOrganisationId = cleanText(customer.lifecycleOrganisationId, 180);
    const assessments = state.assessments.filter((assessment) => assessment.customerId === customer.id);
    const assessmentIds = new Set(assessments.map((assessment) => assessment.id));
    const operation = Object.values(state.operationsById || {}).find((candidate) => {
        const payload = candidate && candidate.payload || {};
        return candidate &&
            candidate.kind === 'lifecycle.scoping.link' &&
            candidate.aggregateId === lifecycleOrganisationId &&
            payload.salesCustomerId === customer.id &&
            assessmentIds.has(payload.assessmentId);
    });
    const assessment = operation
        ? assessments.find((candidate) => candidate.id === operation.payload.assessmentId)
        : assessments.find((candidate) => (
            candidate.lifecycleOrganisationId === lifecycleOrganisationId ||
            candidate.prefill && candidate.prefill.organisationId === lifecycleOrganisationId
        ));
    if (!assessment) {
        throw salesError(409, 'The linked lifecycle customer has no exact Sales assessment available for safe deletion compensation', {
            code: 'customer_handoff_reconciliation_required',
            lifecycleOrganisationId,
            salesCustomerId: customer.id
        });
    }
    const relink = {
        salesCustomerId: customer.id,
        assessmentId: assessment.id,
        remainingGapCount: Number(operation && operation.payload && operation.payload.remainingGapCount || 0)
    };
    if (operation) {
        relink.operationId = operation.operationId;
        relink.operationPayloadHash = operation.payloadHash;
    }
    return relink;
}

async function restoreLifecycleScopingLink(lifecycle, access, organisationId, expectedRevision, relink) {
    const attempt = (revision) => lifecycle.linkScopingRecords(access, organisationId, Object.assign({}, relink, {
        expectedRevision: revision
    }));
    try {
        return await attempt(expectedRevision);
    } catch (error) {
        if (!(error && error.details && error.details.code === 'revision_conflict')) throw error;
        const current = await lifecycle.getOrganisation(access, organisationId);
        const organisation = current.organisation || {};
        const currentCustomerId = organisation.links && organisation.links.salesCustomerId ||
            organisation.scope && organisation.scope.salesCustomerId || '';
        if (currentCustomerId === relink.salesCustomerId &&
            organisation.scope && organisation.scope.assessmentId === relink.assessmentId) {
            return current;
        }
        return attempt(current.revision);
    }
}

function removeCustomerHandoffOperations(state, customer, assessmentIds) {
    const operations = state.operationsById && typeof state.operationsById === 'object'
        ? state.operationsById
        : {};
    const operationIndex = state.operationIdByIdempotencyKey && typeof state.operationIdByIdempotencyKey === 'object'
        ? state.operationIdByIdempotencyKey
        : {};
    const lifecycleOrganisationId = cleanText(customer.lifecycleOrganisationId, 180);
    const removedOperationIds = new Set();

    Object.entries(operations).forEach(([operationId, operation]) => {
        if (!operation || operation.kind !== 'lifecycle.scoping.link') return;
        const payload = operation.payload && typeof operation.payload === 'object'
            ? operation.payload
            : {};
        const belongsToDeletedHandoff = (
            payload.salesCustomerId === customer.id ||
            assessmentIds.has(payload.assessmentId) ||
            lifecycleOrganisationId && (
                operation.aggregateId === lifecycleOrganisationId ||
                payload.organisationId === lifecycleOrganisationId
            )
        );
        if (!belongsToDeletedHandoff) return;
        removedOperationIds.add(operationId);
        delete operations[operationId];
    });

    Object.entries(operationIndex).forEach(([idempotencyKey, operationId]) => {
        if (removedOperationIds.has(operationId)) {
            delete operationIndex[idempotencyKey];
        }
    });
}

function assignCustomerFields(customer, body, actorEmail) {
    if (body.name !== undefined) {
        const name = cleanText(body.name, 180);
        if (!name) {
            throw salesError(400, 'Customer name is required');
        }
        customer.name = name;
    }
    ['industry', 'region', 'segment', 'accountOwner', 'dynamicsAccountId', 'notes'].forEach((field) => {
        if (body[field] !== undefined) {
            customer[field] = cleanText(body[field], field === 'notes' ? 4000 : 180);
        }
    });
    if (body.classification !== undefined) {
        customer.classification = normaliseClassification(body.classification);
    }
    customer.updatedBy = actorEmail;
    customer.updatedAt = new Date().toISOString();
}

function findCustomer(state, id) {
    const customer = state.customers.find((item) => item.id === id);
    if (!customer) {
        throw salesError(404, 'Customer not found');
    }
    return customer;
}

function findAssessment(state, id) {
    const assessment = state.assessments.find((item) => item.id === id);
    if (!assessment) {
        throw salesError(404, 'Assessment not found');
    }
    return assessment;
}

function findProposal(state, id) {
    const proposal = state.proposals.find((item) => item.id === id);
    if (!proposal) {
        throw salesError(404, 'Proposal not found');
    }
    return proposal;
}

function parseCsv(value) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        const next = value[index + 1];
        if (quoted) {
            if (char === '"' && next === '"') {
                field += '"';
                index += 1;
            } else if (char === '"') {
                quoted = false;
            } else {
                field += char;
            }
        } else if (char === '"') {
            quoted = true;
        } else if (char === ',') {
            row.push(field);
            field = '';
        } else if (char === '\n') {
            row.push(field.replace(/\r$/, ''));
            rows.push(row);
            row = [];
            field = '';
        } else {
            field += char;
        }
    }
    if (quoted) {
        throw new Error('CSV contains an unclosed quoted field');
    }
    if (field || row.length) {
        row.push(field.replace(/\r$/, ''));
        rows.push(row);
    }
    return rows;
}

function matchesRule(answerValue, expectedValues) {
    const values = Array.isArray(answerValue) ? answerValue : [answerValue];
    return values.some((candidate) => expectedValues.includes(candidate));
}

function isEmptyAnswer(value) {
    return value == null || value === '' || (Array.isArray(value) && !value.length);
}

function sortRecommendations(a, b) {
    const rank = {
        strong_fit: 0,
        potential_fit: 1,
        insufficient_information: 2,
        not_currently_suitable: 3
    };
    return (rank[a.fit] - rank[b.fit]) || (b.score - a.score) || a.serviceName.localeCompare(b.serviceName);
}

function listFromAnswer(answer, question) {
    if (!answer || isEmptyAnswer(answer.value)) {
        return [];
    }
    const values = Array.isArray(answer.value) ? answer.value : [answer.value];
    return values.map((value) => answerLabel(question, value)).filter(Boolean);
}

function cleanStringList(value, maxItems, maxLength, fallback) {
    if (!Array.isArray(value)) {
        return fallback || [];
    }
    return value.slice(0, maxItems).map((item) => cleanText(item, maxLength)).filter(Boolean);
}

function splitList(value) {
    return String(value || '')
        .split(/\|\||\r?\n/)
        .map((item) => cleanText(item, 1000))
        .filter(Boolean)
        .slice(0, 100);
}

function cleanText(value, maxLength) {
    return String(value == null ? '' : value).trim().slice(0, maxLength);
}

function normaliseHeader(value) {
    return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function normaliseClassification(value, errors, row) {
    const classification = String(value || '').trim().toLowerCase();
    if (ALLOWED_CLASSIFICATIONS.has(classification)) {
        return classification;
    }
    if (errors) {
        errors.push({ row, field: 'classification', message: 'Classification must be public, internal, or restricted' });
        return 'internal';
    }
    throw salesError(400, 'Classification must be public, internal, or restricted');
}

function normaliseChoice(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
}

function nonNegativeMoney(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) {
        return 0;
    }
    return Math.max(0, Math.round(amount * 100) / 100);
}

function nonNegativeInteger(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

function nonNegativeDecimal(value, precision) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return 0;
    const factor = 10 ** precision;
    return Math.round(number * factor) / factor;
}

function sanitiseIntegrationResponse(value) {
    return {
        status: cleanText(value && value.status || 'accepted', 80),
        recordId: cleanText(value && value.recordId, 180),
        recordUrl: cleanText(value && value.recordUrl, 1000),
        correlationId: cleanText(value && value.correlationId, 180)
    };
}

function slugify(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 120);
}

function unique(values) {
    return Array.from(new Set(values.filter(Boolean)));
}

function createId(prefix) {
    const crypto = require('crypto');
    return `${prefix}_${typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(16).slice(2)}`}`;
}

function safeFileName(value) {
    return String(value || 'customer')
        .replace(/[^a-z0-9-_]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 100) || 'customer';
}

function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-NZ', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
}

function capitalise(value) {
    const text = String(value || '');
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function getSalesPath(req, context) {
    if (context.path != null) {
        return String(context.path || '').replace(/^\/+|\/+$/g, '');
    }
    if (req.params && req.params.path != null) {
        return String(req.params.path || '').replace(/^\/+|\/+$/g, '');
    }
    const rawUrl = String(req.originalUrl || req.url || '');
    let pathname = rawUrl.split('?')[0];
    try {
        pathname = new URL(rawUrl, 'https://nofries.local').pathname;
    } catch (error) {
        // Fall back to the path-only value above.
    }
    return pathname.replace(/^\/api\/sales\/?/, '').replace(/^\/+|\/+$/g, '');
}

function getJsonBody(req) {
    if (!req || req.body == null) {
        return {};
    }
    if (Buffer.isBuffer(req.body)) {
        return parseJson(req.body.toString('utf8'));
    }
    if (typeof req.body === 'string') {
        return parseJson(req.body);
    }
    return req.body;
}

function parseJson(value) {
    try {
        return JSON.parse(value || '{}');
    } catch (error) {
        return {};
    }
}

function getQuery(req) {
    if (req.query) {
        return req.query;
    }
    const url = String(req.url || '');
    const index = url.indexOf('?');
    return index === -1 ? {} : Object.fromEntries(new URLSearchParams(url.slice(index + 1)));
}

function getRepository() {
    if (!repository) {
        repository = createSalesWorkspaceRepository({ dataDir: DATA_DIR });
    }
    return repository;
}

function resetSalesRuntimeForTests() {
    repository = null;
}

function json(status, body, headers = {}) {
    return {
        status,
        headers: apiSecurityHeaders(Object.assign({
            'Content-Type': 'application/json; charset=utf-8',
        }, headers)),
        body
    };
}

function raw(status, body, headers = {}) {
    return {
        status,
        headers: apiSecurityHeaders(headers),
        body,
        isRaw: true
    };
}

function salesError(statusCode, message, details) {
    const error = new SalesRepositoryError(statusCode, message, details);
    return error;
}

function errorResponse(error, logger) {
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;
    if (status >= 500 && !error.details && logger && typeof logger.error === 'function') {
        logger.error(error);
    }
    return json(status, Object.assign({
        error: status >= 500 && !error.details ? 'No Fries could not complete that request' : error.message
    }, error.details || {}));
}

async function runSalesFunction(context, req) {
    try {
        const headers = req && req.headers || {};
        const method = String(req && req.method || 'GET').toUpperCase();
        const bucket = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? 'apiWrite' : 'apiRead';
        const clientKey = getClientKeyFromHeaders(headers, 'unknown');
        const rateLimit = checkRateLimit(bucket, clientKey);
        if (!rateLimit.allowed) {
            context.res = json(429, { error: 'Too many requests. Please wait and try again.', code: 'rate_limited' }, rateLimitHeaders(rateLimit));
            return;
        }
        if (requestBodySize(req) > MAX_REQUEST_BYTES) {
            context.res = json(413, { error: 'Request body is too large', code: 'request_too_large' }, rateLimitHeaders(rateLimit));
            return;
        }
        context.res = await handleSalesRequest(req, {
            path: context.bindingData && context.bindingData.path
        });
        context.res.headers = apiSecurityHeaders(Object.assign({}, rateLimitHeaders(rateLimit), context.res.headers || {}));
    } catch (error) {
        context.res = errorResponse(error, context.log);
    }
}

module.exports = {
    CATALOGUE_COLUMNS,
    applyServicePlanReview,
    buildProposal,
    buildServicePlanView,
    buildDynamicsPayload,
    dynamicsStatus,
    errorResponse,
    handleSalesRequest,
    matchServices,
    resetSalesRuntimeForTests,
    runSalesFunction,
    validateCatalogueCsv
};
