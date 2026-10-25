const {
    DattoRmmError,
    buildApiUrl,
    createDattoRmmClient,
    normaliseSite
} = require('./dattoRmmClient');
const { createDattoRmmAuthProvider } = require('./dattoRmmAuthProvider');

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const SITE_MARKER_PREFIX = '[nofries:';

function createDattoRmmProvisioningClient(options = {}) {
    const env = options.env || process.env;
    const fetchImpl = options.fetch || globalThis.fetch;
    const now = options.now || (() => new Date());
    const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 30000);
    const auth = options.authProvider || createDattoRmmAuthProvider({
        env,
        fetch: fetchImpl,
        now,
        timeoutMs
    });
    const reader = options.reader || createDattoRmmClient({
        env,
        fetch: fetchImpl,
        now,
        timeoutMs,
        authProvider: auth
    });
    const connection = auth.connection();

    function status() {
        return auth.status();
    }

    async function ensureManagedSite(input = {}) {
        assertProvisioningEnabled();
        const name = requireSiteName(input.name);
        const externalKey = requireExternalKey(input.externalKey);
        const marker = siteMarker(externalKey);
        const discovered = await reader.listSites();
        if (discovered.truncated) {
            throw new DattoRmmError(
                409,
                'Datto site discovery was truncated, so No Fries will not create a possible duplicate',
                'datto_rmm_site_discovery_truncated'
            );
        }
        const matches = discovered.sites.filter((site) => normaliseManagedSiteName(site.name) === normaliseManagedSiteName(name));
        if (matches.length > 1) {
            throw new DattoRmmError(
                409,
                'More than one Datto site has this name; choose the correct site manually',
                'datto_rmm_site_ambiguous',
                { matchCount: matches.length }
            );
        }
        if (matches.length === 1) {
            const existing = await getSite(matches[0].siteUid);
            if (!existing.notes.includes(marker)) {
                throw new DattoRmmError(
                    409,
                    'The existing Datto site is not marked as owned by this No Fries lifecycle record',
                    'datto_rmm_site_ownership_unverified',
                    { siteUid: existing.siteUid, siteName: existing.name }
                );
            }
            return { site: requireProvisionableSite(existing), created: false };
        }

        const desired = {
            name,
            description: cleanText(input.description || 'Managed by No Fries governed onboarding', 500),
            notes: marker,
            onDemand: false,
            splashtopAutoInstall: false
        };
        const payload = await requestApi('/api/v2/site', { method: 'PUT', body: desired });
        let site = normaliseSite(payload && payload.site || payload);
        if (!site.siteUid || site.siteId == null) {
            const refreshed = await reader.listSites();
            const createdMatches = refreshed.sites.filter((item) => normaliseManagedSiteName(item.name) === normaliseManagedSiteName(name));
            if (refreshed.truncated || createdMatches.length !== 1) {
                throw new DattoRmmError(
                    502,
                    'Datto created the site but did not return a uniquely verifiable identity',
                    'datto_rmm_site_create_unverified'
                );
            }
            site = await getSite(createdMatches[0].siteUid);
        } else {
            site = await getSite(site.siteUid);
        }
        if (!site.notes.includes(marker)) {
            throw new DattoRmmError(
                502,
                'The new Datto site did not retain its No Fries ownership marker',
                'datto_rmm_site_marker_missing'
            );
        }
        return { site: requireProvisionableSite(site), created: true };
    }

    async function verifyManagedSite(input = {}) {
        assertProvisioningEnabled();
        const siteUid = requireUid(input.siteUid);
        const name = requireSiteName(input.name);
        const marker = siteMarker(requireExternalKey(input.externalKey));
        const site = requireProvisionableSite(await getSite(siteUid));
        if (normaliseManagedSiteName(site.name) !== normaliseManagedSiteName(name)) {
            throw new DattoRmmError(
                409,
                'The mapped Datto site name does not match this No Fries lifecycle record',
                'datto_rmm_site_name_mismatch',
                { siteUid: site.siteUid, siteName: site.name }
            );
        }
        if (!site.notes.includes(marker)) {
            throw new DattoRmmError(
                409,
                'The mapped Datto site is not marked as owned by this No Fries lifecycle record',
                'datto_rmm_site_ownership_unverified',
                { siteUid: site.siteUid, siteName: site.name }
            );
        }
        return site;
    }

    function buildInstallerHandoffs(siteValue, devicesValue) {
        assertProvisioningEnabled();
        const site = requireProvisionableSite(normaliseSite(siteValue));
        const devices = Array.isArray(devicesValue) ? devicesValue : [];
        if (!devices.length || devices.length > 50) {
            throw new DattoRmmError(400, 'One to 50 planned devices are required', 'datto_rmm_installer_devices_invalid');
        }
        return devices.map((value) => {
            const source = value && typeof value === 'object' ? value : {};
            const deviceId = cleanText(source.deviceId || source.id, 180);
            const label = cleanText(source.label || deviceId, 180);
            const platform = cleanText(source.platform, 40).toLowerCase();
            if (!deviceId) {
                throw new DattoRmmError(400, 'Every installer handoff needs a planned device ID', 'datto_rmm_installer_device_id_required');
            }
            if (!['windows', 'macos'].includes(platform)) {
                throw new DattoRmmError(
                    409,
                    `Datto installer automation is not enabled for ${platform || 'this platform'}`,
                    'datto_rmm_installer_platform_unsupported',
                    { deviceId, platform: platform || 'unknown' }
                );
            }
            const installerPlatform = platform === 'macos' ? 'mac' : 'windows';
            const downloadUrl = `${connection.installerBase}/download-agent/${installerPlatform}/${site.siteId}`;
            return {
                deviceId,
                label,
                platform,
                siteUid: site.siteUid,
                downloadUrl,
                requiresLocalAdmin: true,
                requiredApprovals: platform === 'windows'
                    ? ['Local administrator / UAC approval']
                    : [
                        'Local administrator approval',
                        'Accessibility',
                        'Full Disk Access',
                        'Screen & System Audio Recording',
                        'Automation → System Events',
                        'Local Network'
                    ]
            };
        });
    }

    async function getSite(siteUid) {
        const uid = requireUid(siteUid);
        const payload = await requestApi(`/api/v2/site/${encodeURIComponent(uid)}`, { method: 'GET' });
        const site = normaliseSite(payload && payload.site || payload);
        if (!site.siteUid) site.siteUid = uid;
        return site;
    }

    async function requestApi(path, init = {}, attempt = 0) {
        assertProvisioningEnabled();
        if (typeof fetchImpl !== 'function') {
            throw new DattoRmmError(503, 'The Datto RMM provisioning client is unavailable', 'datto_rmm_http_unavailable');
        }
        const method = String(init.method || 'GET').toUpperCase();
        const url = buildApiUrl(connection.apiBase, path);
        assertAllowedRequest(method, new URL(url).pathname);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response;
        try {
            const token = await auth.getAccessToken();
            response = await fetchImpl(url, {
                method,
                headers: Object.assign({
                    Accept: 'application/json',
                    Authorization: `Bearer ${token}`,
                    'User-Agent': 'NoFries-DattoRMM-Provisioner/1.0'
                }, init.body == null ? {} : { 'Content-Type': 'application/json' }),
                body: init.body == null ? undefined : JSON.stringify(init.body),
                redirect: 'error',
                signal: controller.signal
            });
        } catch (error) {
            if (error && error.details && /^datto_rmm_(auth|not_configured|rate_limited)/.test(String(error.details.code || ''))) {
                throw error;
            }
            if (error && error.name === 'AbortError') {
                throw new DattoRmmError(504, 'Datto RMM provisioning timed out', 'datto_rmm_timeout');
            }
            throw new DattoRmmError(502, 'No Fries could not reach Datto RMM provisioning', 'datto_rmm_unreachable');
        } finally {
            clearTimeout(timer);
        }
        if (response.status === 401 && attempt === 0 && connection.renewable) {
            auth.invalidate();
            return requestApi(path, init, 1);
        }
        if (!response.ok) throw provisioningHttpError(response);
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
            throw new DattoRmmError(502, 'Datto RMM returned more provisioning data than No Fries accepts', 'datto_rmm_response_too_large');
        }
        try {
            return text ? JSON.parse(text) : {};
        } catch (error) {
            throw new DattoRmmError(502, 'Datto RMM returned an invalid provisioning response', 'datto_rmm_response_invalid');
        }
    }

    function assertProvisioningEnabled() {
        const current = status();
        if (!current.configured || current.mode !== 'controlled_write' || !current.writeOperationsEnabled) {
            throw new DattoRmmError(503, 'Controlled Datto RMM onboarding is not enabled', 'datto_rmm_provisioning_disabled', {
                state: current.state,
                missing: current.missing
            });
        }
    }

    return { buildInstallerHandoffs, ensureManagedSite, status, verifyManagedSite };
}

function assertAllowedRequest(method, pathname) {
    const siteRead = method === 'GET' && /^\/api\/v2\/site\/[a-z0-9_-]{4,180}$/i.test(pathname);
    const siteCreate = method === 'PUT' && pathname === '/api/v2/site';
    if (!siteRead && !siteCreate) {
        throw new DattoRmmError(403, 'This Datto RMM operation is outside the onboarding allow-list', 'datto_rmm_operation_not_allowed');
    }
}

function requireProvisionableSite(site) {
    if (!site.siteUid || !Number.isInteger(site.siteId) || site.siteId < 1) {
        throw new DattoRmmError(502, 'Datto RMM did not return both site UID and numeric site ID', 'datto_rmm_site_identity_incomplete');
    }
    return site;
}

function requireUid(value) {
    const uid = cleanText(value, 180);
    if (!/^[a-z0-9_-]{4,180}$/i.test(uid)) {
        throw new DattoRmmError(400, 'A valid Datto RMM site UID is required', 'datto_rmm_site_uid_invalid');
    }
    return uid;
}

function requireSiteName(value) {
    const name = cleanText(value, 300);
    if (name.length < 2) {
        throw new DattoRmmError(400, 'A Datto RMM site name is required', 'datto_rmm_site_name_invalid');
    }
    return name;
}

function requireExternalKey(value) {
    const key = cleanText(value, 180).toLowerCase();
    if (!/^[a-z0-9:_-]{4,180}$/.test(key)) {
        throw new DattoRmmError(400, 'A stable No Fries lifecycle key is required', 'datto_rmm_external_key_invalid');
    }
    return key;
}

function siteMarker(externalKey) {
    return `${SITE_MARKER_PREFIX}${externalKey}]`;
}

function normaliseName(value) {
    return cleanText(value, 300).toLocaleLowerCase('en-NZ').replace(/\s+/g, ' ');
}

function normaliseManagedSiteName(value) {
    const name = normaliseName(value);
    return ['no fries hq', 'no fries headquarters'].includes(name) ? 'no fries headquarters' : name;
}

function provisioningHttpError(response) {
    const status = Number(response && response.status || 0);
    if (status === 401) return new DattoRmmError(502, 'The Datto RMM API identity could not authenticate', 'datto_rmm_auth_failed');
    if (status === 403) return new DattoRmmError(502, 'The Datto RMM API identity lacks Sites Manage permission', 'datto_rmm_access_denied');
    if (status === 409) return new DattoRmmError(409, 'Datto RMM reported a conflicting site operation', 'datto_rmm_site_conflict');
    if (status === 429) return new DattoRmmError(503, 'Datto RMM rate-limited onboarding; wait before retrying', 'datto_rmm_rate_limited', { retryAfterSeconds: 60 });
    return new DattoRmmError(502, 'Datto RMM could not complete the controlled site operation', 'datto_rmm_provider_error', { providerStatus: status });
}

function positiveInteger(value, fallback, minimum, maximum) {
    const number = Number(value);
    return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function cleanText(value, maxLength) {
    return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
}

module.exports = {
    createDattoRmmProvisioningClient,
    siteMarker
};
