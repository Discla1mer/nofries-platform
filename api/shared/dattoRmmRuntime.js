const crypto = require('crypto');
const { getProductRequestIdentity } = require('./identity');
const { assertCapability, resolveTenantAccess } = require('./tenantAccess');
const { apiSecurityHeaders, assertSameOriginForMutation } = require('./securityHeaders');
const { checkRateLimit, getClientKeyFromHeaders, rateLimitHeaders } = require('./abuseProtection');
const { createDattoRmmClient, DattoRmmError } = require('./integrations/dattoRmmClient');
const { createDattoRmmAuthProvider, DattoRmmAuthError } = require('./integrations/dattoRmmAuthProvider');
const { createDattoRmmProvisioningClient } = require('./integrations/dattoRmmProvisioningClient');
const { LifecycleRepositoryError } = require('./appLifecycle/lifecycleRepository');
const { requestBodySize } = require('./requestLimits');

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_SYNC_DEVICES = 2500;
let client;
let authProvider;
let provisioningClient;

async function handleDattoRmmRequest(req, routeContext = {}, dependencies = {}) {
    if (requestBodySize(req) > MAX_REQUEST_BYTES) {
        throw dattoRmmError(413, 'Request body is too large', 'request_too_large');
    }
    assertSameOriginForMutation(req);
    const identity = await getProductRequestIdentity(req);
    const access = resolveTenantAccess(identity);
    if (!access.allowed) {
        throw dattoRmmError(403, 'This Microsoft identity has not been approved for a No Fries tenant', 'tenant_access_required', {
            reason: access.reason
        });
    }

    const method = String(req.method || 'GET').toUpperCase();
    const routePath = getDattoRmmPath(req, routeContext);
    const segments = routePath.split('/').filter(Boolean).map(decodeURIComponent);
    const body = getJsonBody(req);
    const datto = dependencies.client || getDattoRmmClient();
    const tenantBinding = dattoTenantBinding(access, dependencies.env || process.env);

    if (method === 'GET' && segments.length === 1 && segments[0] === 'status') {
        assertCapability(access, 'lifecycle:read');
        const providerStatus = datto.status();
        const tenantBound = tenantBinding.configured && tenantBinding.matches;
        return json(200, Object.assign({}, providerStatus, {
            configured: providerStatus.configured === true && tenantBound,
            writeOperationsEnabled: providerStatus.writeOperationsEnabled === true && tenantBound,
            state: !tenantBinding.configured
                ? 'tenant_binding_required'
                : !tenantBinding.matches ? 'tenant_binding_mismatch' : providerStatus.state,
            tenantBindingConfigured: tenantBinding.configured,
            tenantBindingMatches: tenantBinding.matches
        }));
    }
    assertDattoTenantBinding(tenantBinding);
    if (method === 'GET' && segments.length === 1 && segments[0] === 'health') {
        assertCapability(access, 'lifecycle:read');
        return json(200, await datto.health());
    }
    if (method === 'GET' && segments.length === 1 && segments[0] === 'sites') {
        assertCapability(access, 'integration:discover');
        const result = await datto.listSites();
        return json(200, {
            sites: result.sites,
            count: result.sites.length,
            truncated: result.truncated,
            mode: dattoMode(datto)
        });
    }
    if (method === 'POST' && segments.length === 2 && segments[0] === 'onboarding' && segments[1] === 'prepare') {
        assertCapability(access, 'integration:provision');
        assertCapability(access, 'lifecycle:write');
        assertCapability(access, 'lifecycle:transition');
        if (
            body.confirm !== true || body.confirmCustomerAuthority !== true ||
            body.confirmAuthorisedDevices !== true ||
            body.confirmNoConflictingManagement !== true ||
            body.confirmSupportedOperatingSystems !== true ||
            body.confirmNewDeviceApprovalEnabled !== true
        ) {
            throw dattoRmmError(
                400,
                'Confirm customer authority, the authorised device scope, supported operating systems, absence of unresolved conflicting management and Datto New Device Approval',
                'datto_rmm_provision_confirmation_required'
            );
        }
        const organisationId = cleanText(body.organisationId, 180);
        if (!organisationId) {
            throw dattoRmmError(400, 'A lifecycle organisation is required', 'organisation_required');
        }
        const lifecycle = dependencies.lifecycleService || getLifecycleService();
        const current = await lifecycle.getOrganisation(access, organisationId);
        assertExpectedRevision(body.expectedRevision, current.revision);
        const plan = controlledOnboardingPlan(current.organisation, body);
        if (plan.blockers.length) {
            throw dattoRmmError(
                409,
                'The Datto onboarding plan is not ready to execute',
                'datto_rmm_onboarding_not_ready',
                { blockers: plan.blockers }
            );
        }
        const provisioner = dependencies.provisioningClient || getDattoRmmProvisioningClient();
        const provisioningStatus = provisioner.status();
        if (
            !provisioningStatus || provisioningStatus.mode !== 'controlled_write' ||
            provisioningStatus.configured !== true || provisioningStatus.writeOperationsEnabled !== true
        ) {
            throw dattoRmmError(
                503,
                'Controlled Datto RMM onboarding is not enabled',
                'datto_rmm_provisioning_disabled',
                { state: provisioningStatus && provisioningStatus.state || 'unavailable' }
            );
        }
        const externalKey = `${access.tenant.key}:${organisationId}`;
        const provisioningKeyHash = crypto.createHash('sha256')
            .update(JSON.stringify({
                tenantKey: access.tenant.key,
                organisationId,
                planId: plan.planId,
                planVersion: plan.planVersion,
                siteName: plan.siteName,
                devices: plan.devices.map((device) => ({
                    id: device.id,
                    platform: device.platform,
                    owner: device.owner,
                    status: device.status
                })),
                confirmations: {
                    customerAuthority: true,
                    authorisedDevices: true,
                    noConflictingManagement: true,
                    supportedOperatingSystems: true,
                    newDeviceApprovalEnabled: true
                }
            }))
            .digest('hex');
        const claimResult = await lifecycle.claimDattoRmmProvisioning(access, organisationId, {
            expectedRevision: current.revision,
            provisioningKeyHash
        });
        const provisioningClaimId = cleanText(claimResult && claimResult.claim && claimResult.claim.claimId, 180);
        if (!provisioningClaimId) {
            throw dattoRmmError(500, 'No Fries could not acquire the Datto provisioning claim', 'datto_rmm_provisioning_claim_missing');
        }
        let claimCompleted = false;
        try {
            let prepared;
            let snapshot;
            const mappedSiteUid = cleanText(
                current.organisation.links && current.organisation.links.dattoRmmSiteUid ||
                current.organisation.integrations && current.organisation.integrations.dattoRmm && current.organisation.integrations.dattoRmm.siteUid,
                180
            );
            if (mappedSiteUid) {
                const verifiedSite = await provisioner.verifyManagedSite({
                    siteUid: mappedSiteUid,
                    name: plan.siteName,
                    externalKey
                });
                snapshot = await datto.getSiteSnapshot(mappedSiteUid);
                assertSnapshotSiteUid(snapshot, mappedSiteUid);
                prepared = { site: verifiedSite, created: false };
            } else {
                prepared = await provisioner.ensureManagedSite({
                    name: plan.siteName,
                    externalKey,
                    description: `No Fries governed onboarding · ${organisationId}`
                });
                snapshot = await datto.getSiteSnapshot(prepared.site.siteUid);
                assertSnapshotSiteUid(snapshot, prepared.site.siteUid);
            }
            if (normaliseManagedSiteName(snapshot && snapshot.site && snapshot.site.name) !== normaliseManagedSiteName(plan.siteName)) {
                throw dattoRmmError(
                    409,
                    'The mapped Datto site name does not match the governed lifecycle customer name',
                    'datto_rmm_site_name_mismatch',
                    {
                        expectedSiteName: plan.siteName,
                        providerSiteName: cleanText(snapshot && snapshot.site && snapshot.site.name, 300) || null
                    }
                );
            }
            if (snapshot.truncated) {
                throw dattoRmmError(
                    502,
                    'The Datto RMM snapshot exceeded the safe onboarding limit',
                    'datto_rmm_snapshot_truncated'
                );
            }
            let result = await lifecycle.syncDattoRmmSnapshot(access, organisationId, {
                expectedRevision: claimResult.revision,
                siteUid: prepared.site.siteUid,
                siteName: snapshot.site.name || prepared.site.name,
                deviceCount: snapshot.devices.length,
                openAlertCount: snapshot.openAlerts.length,
                capturedAt: normaliseIso(snapshot.capturedAt),
                truncated: snapshot.truncated === true,
                devices: normaliseSnapshotDevices(snapshot.devices),
                mode: 'controlled_write',
                provisioningDisposition: prepared.created ? 'created' : 'reused',
                provisioningKeyHash,
                provisioningClaimId,
                preflightConfirmations: {
                    customerAuthority: true,
                    authorisedDevices: true,
                    noConflictingManagement: true,
                    supportedOperatingSystems: true,
                    newDeviceApprovalEnabled: true
                }
            });
            claimCompleted = true;
            const installableDevices = plan.devices.filter((device) => (
                ['planned', 'installer_ready'].includes(device.status) &&
                ['windows', 'macos'].includes(device.platform)
            ));
            const handoffs = installableDevices.length ? provisioner.buildInstallerHandoffs(prepared.site, installableDevices.map((device) => ({
                deviceId: device.id,
                label: device.label,
                platform: device.platform
            }))) : [];
            for (const device of installableDevices) {
                const latest = (result.organisation.onboarding.devices || []).find((item) => item.id === device.id);
                if (!latest || latest.status !== 'planned') continue;
                result = await lifecycle.updateOnboardingDevice(access, organisationId, {
                    expectedRevision: result.revision,
                    deviceId: device.id,
                    status: 'installer_ready'
                });
            }
            const manualTasks = plan.devices.filter((device) => (
                ['planned', 'installer_ready'].includes(device.status) && device.platform === 'linux'
            )).map((device) => ({
                deviceId: device.id,
                label: device.label,
                platform: device.platform,
                title: 'Prepare the site-provided Linux installer in Datto',
                detail: 'Use Datto’s documented site-provided Linux installer or link. No Fries does not guess or synthesize a Linux download URL.',
                documentationUrl: 'https://rmm.datto.com/help/en/Content/3NEWUI/Devices/AddADevice/InstallLinux.htm'
            }));
            return json(200, {
                provider: 'datto_rmm',
                mode: 'controlled_write',
                revision: result.revision,
                site: Object.assign({}, prepared.site, { created: prepared.created }),
                handoffs,
                manualTasks,
                manualGates: [
                    {
                        id: 'pre_install_compatibility',
                        title: 'Recheck authority and operating-system support',
                        detail: 'Confirm the signed customer authority covers every named endpoint. Stop while any incumbent or other provider has an unresolved management claim. Confirm the exact Windows edition, macOS version or Linux distribution is currently supported by Datto immediately before install.'
                    },
                    {
                        id: 'endpoint_admin',
                        title: 'Run each installer locally with the required elevation',
                        detail: 'Windows requires administrator/UAC approval, macOS requires a local administrator, and Linux requires the documented terminal and sudo/root steps.'
                    },
                    {
                        id: 'macos_privacy',
                        title: 'Approve macOS privacy access',
                        detail: 'Approve Accessibility, Full Disk Access, Screen & System Audio Recording, Automation and Local Network.'
                    },
                    {
                        id: 'macos_post_reboot',
                        title: 'Check macOS restart behaviour',
                        detail: 'If FileVault is enabled, a user must log in after restart before the agent can run. On macOS Sequoia, review private Wi-Fi and any Agent Encryption Key Changed approval.'
                    },
                    {
                        id: 'datto_device_approval',
                        title: 'Sign in to Datto and approve the exact devices',
                        detail: 'New Device Approval must already be enabled. Keep each device pending until hostname, operating system and device identity match the plan.'
                    },
                    {
                        id: 'policy_and_psa_mapping',
                        title: 'Confirm policy and Autotask mappings',
                        detail: 'Datto policy assignment and the initial Autotask company mapping remain reviewed console steps.'
                    }
                ],
                organisation: result.organisation
            }, { 'Cache-Control': 'private, no-store, max-age=0' });
        } catch (error) {
            if (!claimCompleted && safeToReleaseProvisioningClaim(error)) {
                await lifecycle.releaseDattoRmmProvisioning(access, organisationId, {
                    expectedRevision: claimResult.revision,
                    claimId: provisioningClaimId,
                    provisioningKeyHash,
                    reasonCode: error && error.details && error.details.code || 'preparation_failed'
                }).catch(() => {});
            }
            throw error;
        }
    }
    if (method === 'GET' && segments.length === 3 && segments[0] === 'sites' && segments[2] === 'snapshot') {
        assertCapability(access, 'integration:discover');
        const organisationId = cleanText(
            body.organisationId || req && req.query && req.query.organisationId,
            180
        );
        if (!organisationId) {
            throw dattoRmmError(400, 'A lifecycle organisation is required', 'organisation_required');
        }
        const lifecycle = dependencies.lifecycleService || getLifecycleService();
        const organisation = await lifecycle.getSharedContext(access, organisationId);
        const mappedSiteUid = cleanText(
            organisation && organisation.links && organisation.links.dattoRmmSiteUid ||
            organisation && organisation.integrations && organisation.integrations.dattoRmm && organisation.integrations.dattoRmm.siteUid,
            180
        );
        if (!organisation || !mappedSiteUid || mappedSiteUid !== segments[1]) {
            throw dattoRmmError(
                403,
                'The Datto RMM site is not mapped to the requested lifecycle organisation',
                'datto_rmm_site_mapping_required'
            );
        }
        const snapshot = await datto.getSiteSnapshot(segments[1]);
        assertSnapshotSiteUid(snapshot, segments[1]);
        return json(200, snapshot);
    }
    if (method === 'POST' && segments.length === 3 && segments[0] === 'sites' && segments[2] === 'link') {
        assertCapability(access, 'integration:map');
        assertCapability(access, 'lifecycle:write');
        assertCapability(access, 'lifecycle:transition');
        const organisationId = cleanText(body.organisationId, 180);
        if (!organisationId) {
            throw dattoRmmError(400, 'A lifecycle organisation is required', 'organisation_required');
        }
        const snapshot = await datto.getSiteSnapshot(segments[1]);
        const providerSiteUid = assertSnapshotSiteUid(snapshot, segments[1]);
        if (snapshot.truncated) {
            throw dattoRmmError(
                502,
                'The Datto RMM snapshot exceeded the safe trial limit and was not linked',
                'datto_rmm_snapshot_truncated'
            );
        }
        if (!snapshot.site || !snapshot.site.name) {
            throw dattoRmmError(502, 'Datto RMM did not return a site name', 'datto_rmm_site_invalid');
        }
        const lifecycle = dependencies.lifecycleService || getLifecycleService();
        const result = await lifecycle.syncDattoRmmSnapshot(access, organisationId, {
            expectedRevision: body.expectedRevision,
            siteUid: providerSiteUid,
            siteName: snapshot.site.name,
            deviceCount: snapshot.devices.length,
            openAlertCount: snapshot.openAlerts.length,
            capturedAt: normaliseIso(snapshot.capturedAt),
            truncated: snapshot.truncated === true,
            devices: normaliseSnapshotDevices(snapshot.devices),
            mode: dattoMode(datto)
        });
        return json(200, Object.assign({
            provider: 'datto_rmm',
            mode: dattoMode(datto),
            capturedAt: snapshot.capturedAt
        }, result));
    }
    return json(404, { error: 'Datto RMM route not found', code: 'route_not_found' });
}

async function runDattoRmmFunction(context, req) {
    try {
        const method = String(req && req.method || 'GET').toUpperCase();
        const bucket = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? 'apiWrite' : 'apiRead';
        const clientKey = getClientKeyFromHeaders(req && req.headers || {}, 'unknown');
        const rateLimit = checkRateLimit(bucket, clientKey);
        if (!rateLimit.allowed) {
            context.res = json(429, { error: 'Too many requests. Please wait and try again.', code: 'rate_limited' }, rateLimitHeaders(rateLimit));
            return;
        }
        context.res = await handleDattoRmmRequest(req);
        context.res.headers = apiSecurityHeaders(Object.assign({}, rateLimitHeaders(rateLimit), context.res.headers || {}));
    } catch (error) {
        context.res = errorResponse(error, context.log);
    }
}

function getDattoRmmClient(options = {}) {
    if (options.reset) {
        client = null;
        authProvider = null;
        provisioningClient = null;
    }
    if (!authProvider) authProvider = createDattoRmmAuthProvider();
    if (!client) client = createDattoRmmClient({ authProvider });
    return client;
}

function getDattoRmmProvisioningClient() {
    if (!authProvider) authProvider = createDattoRmmAuthProvider();
    if (!provisioningClient) {
        provisioningClient = createDattoRmmProvisioningClient({
            authProvider,
            reader: getDattoRmmClient()
        });
    }
    return provisioningClient;
}

function getLifecycleService() {
    return require('./appLifecycleRuntime').getLifecycleService();
}

function resetDattoRmmRuntimeForTests() {
    client = null;
    authProvider = null;
    provisioningClient = null;
}

function getDattoRmmPath(req, context) {
    if (context.path != null) return String(context.path || '').replace(/^\/+|\/+$/g, '');
    const rawUrl = String(req.originalUrl || req.url || '');
    let pathname = rawUrl.split('?')[0];
    try {
        pathname = new URL(rawUrl, 'https://nofries.local').pathname;
    } catch (error) {
        // Keep the path-only value.
    }
    return pathname.replace(/^\/api\/datto-rmm\/?/, '').replace(/^\/+|\/+$/g, '');
}

function getJsonBody(req) {
    if (!req || req.body == null) return {};
    if (Buffer.isBuffer(req.body)) return parseJson(req.body.toString('utf8'));
    if (typeof req.body === 'string') return parseJson(req.body);
    return req.body;
}

function parseJson(value) {
    try {
        return JSON.parse(value || '{}');
    } catch (error) {
        throw dattoRmmError(400, 'Request body must contain valid JSON', 'invalid_json');
    }
}

function json(status, body, headers = {}) {
    return {
        status,
        headers: apiSecurityHeaders(Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers)),
        body
    };
}

function errorResponse(error, logger) {
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;
    const recognised = error instanceof DattoRmmError || error instanceof DattoRmmAuthError || error instanceof LifecycleRepositoryError;
    if (status >= 500 && !recognised && logger && typeof logger.error === 'function') logger.error(error);
    return json(status, Object.assign({
        error: status >= 500 && !recognised ? 'No Fries could not complete that request' : error.message
    }, error.details || {}));
}

function dattoRmmError(statusCode, message, code, details = {}) {
    return new DattoRmmError(statusCode, message, code, details);
}

function dattoTenantBinding(access, env = {}) {
    const configuredTenantId = cleanText(env.NOFRIES_DATTO_RMM_TENANT_ID, 180).toLowerCase();
    const identityTenantId = cleanText(access && access.user && access.user.identityTenantId, 180).toLowerCase();
    const localTenantId = cleanText(access && access.tenant && access.tenant.id, 180).toLowerCase();
    const requestTenantId = access && access.authentication && access.authentication.required
        ? identityTenantId
        : identityTenantId || localTenantId;
    return {
        configured: Boolean(configuredTenantId),
        matches: Boolean(configuredTenantId && requestTenantId && configuredTenantId === requestTenantId)
    };
}

function assertDattoTenantBinding(binding) {
    if (!binding.configured) {
        throw dattoRmmError(
            503,
            'The Datto RMM account is not bound to one No Fries tenant',
            'datto_rmm_tenant_binding_required'
        );
    }
    if (!binding.matches) {
        throw dattoRmmError(
            403,
            'This No Fries tenant is not authorised to use the configured Datto RMM account',
            'datto_rmm_tenant_binding_mismatch'
        );
    }
}

function cleanText(value, maxLength) {
    return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
}

function assertSnapshotSiteUid(snapshot, requestedSiteUid) {
    const requested = cleanText(requestedSiteUid, 180);
    const provider = cleanText(snapshot && snapshot.site && snapshot.site.siteUid, 180);
    if (!provider || provider !== requested) {
        throw dattoRmmError(
            502,
            'Datto RMM returned a site identity that does not match the requested site',
            'datto_rmm_site_uid_mismatch',
            {
                requestedSiteUid: requested,
                providerSiteUid: provider || null
            }
        );
    }
    return provider;
}

function normaliseSnapshotDevices(value) {
    return (Array.isArray(value) ? value : [])
        .slice(0, MAX_SYNC_DEVICES)
        .map((item) => {
            const source = item && typeof item === 'object' ? item : {};
            return {
                deviceUid: cleanText(source.deviceUid || source.uid, 180),
                hostname: cleanText(source.hostname, 300),
                operatingSystem: cleanText(source.operatingSystem || source.os, 300),
                lastSeen: normaliseIso(source.lastSeen),
                online: source.online === true
            };
        })
        .filter((item) => item.deviceUid);
}

function controlledOnboardingPlan(organisation, input = {}) {
    const source = organisation && typeof organisation === 'object' ? organisation : {};
    const onboarding = source.onboarding && typeof source.onboarding === 'object' ? source.onboarding : {};
    const acceptance = source.commercialAcceptance && typeof source.commercialAcceptance === 'object'
        ? source.commercialAcceptance
        : {};
    const devices = (Array.isArray(onboarding.devices) ? onboarding.devices : []).map((device) => ({
        id: cleanText(device && device.id, 180),
        label: cleanText(device && device.label, 180),
        platform: cleanText(device && device.platform, 40).toLowerCase(),
        owner: cleanText(device && device.owner, 180),
        status: cleanText(device && device.status, 80)
    })).filter((device) => device.id && device.label);
    const lifecycleName = cleanText(source.displayName, 300);
    const siteName = isNoFriesHqName(lifecycleName) ? 'No Fries Headquarters' : lifecycleName;
    const requestedSiteName = cleanText(input.siteName, 300);
    const blockers = [];
    if (source.lifecycleState !== 'onboarding') blockers.push('Move the accepted customer into governed onboarding first.');
    if (acceptance.status !== 'verified') blockers.push('Verified customer authority and commercial acceptance are required.');
    if (!cleanText(onboarding.planId, 180) || !onboarding.planVersion) blockers.push('A versioned G0-G5 onboarding plan is required.');
    if (!devices.length) blockers.push('At least one named planned device is required.');
    if (devices.some((device) => !device.owner)) blockers.push('Every planned device needs a recorded owner.');
    if (devices.some((device) => device.status === 'blocked')) blockers.push('Resolve every blocked device before preparing a Datto installer.');
    const unsupported = devices.filter((device) => !['windows', 'macos', 'linux'].includes(device.platform));
    if (unsupported.length) blockers.push(`Datto onboarding does not support these recorded platforms: ${unsupported.map((item) => item.label).join(', ')}.`);
    if (requestedSiteName && normaliseName(requestedSiteName) !== normaliseName(lifecycleName)) {
        blockers.push('The requested Datto site name must exactly match the governed lifecycle customer name.');
    }
    return {
        siteName,
        planId: cleanText(onboarding.planId, 180),
        planVersion: Number(onboarding.planVersion || 0),
        devices,
        blockers
    };
}

function assertExpectedRevision(value, currentRevision) {
    const expected = Number(value);
    if (!Number.isInteger(expected) || expected < 0) {
        throw dattoRmmError(400, 'The current lifecycle revision is required', 'expected_revision_required');
    }
    if (expected !== Number(currentRevision)) {
        throw dattoRmmError(409, 'The lifecycle record changed; refresh before preparing Datto onboarding', 'revision_conflict', {
            expectedRevision: expected,
            currentRevision: Number(currentRevision)
        });
    }
}

function normaliseName(value) {
    return cleanText(value, 300).toLocaleLowerCase('en-NZ').replace(/\s+/g, ' ');
}

function isNoFriesHqName(value) {
    return /^(no fries (?:hq|headquarters))(?: (?:workshop|internal pilot|pilot))?$/.test(normaliseName(value));
}

function normaliseManagedSiteName(value) {
    return isNoFriesHqName(value) ? 'no fries headquarters' : normaliseName(value);
}

function dattoMode(datto) {
    const current = datto && typeof datto.status === 'function' ? datto.status() : {};
    return current && current.mode === 'controlled_write' ? 'controlled_write' : 'readonly';
}

function safeToReleaseProvisioningClaim(error) {
    const code = cleanText(error && error.details && error.details.code, 120);
    return [
        'datto_rmm_site_ambiguous',
        'datto_rmm_site_discovery_truncated',
        'datto_rmm_site_ownership_unverified',
        'datto_rmm_auth_failed',
        'datto_rmm_access_denied',
        'datto_rmm_not_configured'
    ].includes(code);
}

function normaliseIso(value) {
    const timestamp = Date.parse(String(value || ''));
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

module.exports = {
    controlledOnboardingPlan,
    errorResponse,
    handleDattoRmmRequest,
    resetDattoRmmRuntimeForTests,
    runDattoRmmFunction
};
