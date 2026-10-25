const crypto = require('crypto');

const ROLES = Object.freeze({
    ADMIN: 'admin',
    SERVICE_OWNER: 'service_owner',
    CONSULTANT: 'consultant',
    MCP_READER: 'mcp_reader'
});

const ROLE_CAPABILITIES = Object.freeze({
    admin: [
        'customer:read',
        'customer:write',
        'assessment:read',
        'assessment:write',
        'recommendation:review',
        'proposal:write',
        'proposal:export',
        'catalogue:read',
        'catalogue:write',
        'catalogue:publish',
        'integration:handoff',
        'integration:discover',
        'integration:map',
        'integration:provision',
        'audit:read',
        'lifecycle:read',
        'lifecycle:write',
        'lifecycle:transition',
        'customer:accept',
        'onboarding:write',
        'onboarding:approve',
        'onboarding:execute',
        'proof:write',
        'proof:approve',
        'service-status:write',
        'customer-controls:run',
        'lifecycle:audit:read',
        'service-desk:read',
        'service-desk:create',
        'service-desk:investigate',
        'service-desk:approve',
        'service-desk:execute',
        'service-desk:audit:read',
        'tenant:admin'
    ],
    service_owner: [
        'customer:read',
        'customer:write',
        'assessment:read',
        'assessment:write',
        'recommendation:review',
        'proposal:write',
        'proposal:export',
        'catalogue:read',
        'catalogue:write',
        'catalogue:publish',
        'integration:handoff',
        'integration:discover',
        'integration:map',
        'integration:provision',
        'lifecycle:read',
        'lifecycle:write',
        'lifecycle:transition',
        'customer:accept',
        'onboarding:write',
        'onboarding:approve',
        'onboarding:execute',
        'proof:write',
        'proof:approve',
        'service-status:write',
        'lifecycle:audit:read',
        'service-desk:read',
        'service-desk:create',
        'service-desk:investigate',
        'service-desk:approve',
        'service-desk:execute',
        'service-desk:audit:read'
    ],
    consultant: [
        'customer:read',
        'customer:write',
        'assessment:read',
        'assessment:write',
        'recommendation:review',
        'proposal:write',
        'proposal:export',
        'catalogue:read',
        'integration:handoff',
        'lifecycle:read',
        'lifecycle:write',
        'onboarding:write',
        'proof:write',
        'service-desk:read',
        'service-desk:create',
        'service-desk:investigate'
    ],
    mcp_reader: [
        'lifecycle:read'
    ]
});

function resolveTenantAccess(identity, env = process.env) {
    const safeIdentity = identity || {};
    const email = normaliseEmail(safeIdentity.email);
    const identityTenantId = normaliseIdentifier(safeIdentity.tenantId);
    const principalId = normaliseIdentifier(safeIdentity.principalId);
    const clientId = normaliseIdentifier(safeIdentity.clientId);
    const hosted = String(env.NOFRIES_REQUIRE_AUTH || '').trim().toLowerCase() !== 'false';
    const immutableBrowserIdentity = safeIdentity.provider === 'entra-bff';
    const immutableMcpApplication = safeIdentity.provider === 'mcp-oauth-application';
    const applicationClientId = isGuid(clientId) ? clientId : '';
    const subjectKey = immutableBrowserIdentity
        ? canonicalSubjectKey(safeIdentity.subjectKey, identityTenantId, principalId)
        : immutableMcpApplication
            ? canonicalApplicationSubjectKey(
                safeIdentity.subjectKey, identityTenantId, principalId, applicationClientId)
            : '';
    const applicationTenantBindings = immutableMcpApplication
        ? parseMcpApplicationSubjectTenants(env.NOFRIES_MCP_APPLICATION_SUBJECT_TENANTS)
        : new Map();
    const applicationTenantId = subjectKey && applicationTenantBindings.get(subjectKey) || '';
    const allowedSubjects = unique(parseList(env.NOFRIES_ALLOWED_SUBJECTS).map(normaliseSubjectKey));
    const exactEmails = unique([
        ...parseList(env.NOFRIES_ALLOWED_EMAILS),
        ...parseList(env.NOFRIES_PILOT_EMAILS)
    ].map(normaliseEmail));
    const allowedTenantIds = unique(parseList(env.NOFRIES_ALLOWED_TENANT_IDS).map(normaliseIdentifier));
    const emailAllowed = Boolean(email && exactEmails.includes(email));
    const tenantAllowed = Boolean(identityTenantId && allowedTenantIds.includes(identityTenantId));
    const tenantWideAccess = Boolean(
        !immutableBrowserIdentity && !immutableMcpApplication && tenantAllowed &&
        parseBoolean(env.NOFRIES_ALLOW_TENANT_WIDE)
    );
    const localDevelopment = !hosted && Boolean(email);
    const localSubjectDevelopment = !hosted && Boolean(subjectKey);
    const authenticated = Boolean(safeIdentity.isAuthenticated);
    const subjectAllowed = Boolean(subjectKey && allowedSubjects.includes(subjectKey));
    const allowed = immutableMcpApplication
        ? Boolean(subjectKey && applicationClientId && authenticated && applicationTenantId)
        : immutableBrowserIdentity
            ? Boolean(subjectKey && authenticated && (localSubjectDevelopment || subjectAllowed))
            : Boolean(email && (localDevelopment || (authenticated && (emailAllowed || tenantWideAccess))));

    const tenantId = immutableMcpApplication
        ? applicationTenantId || 'unassigned'
        : resolveTenantId({
            identityTenantId,
            tenantAllowed,
            email,
            subjectKey,
            env
        });
    const tenantName = String(env.NOFRIES_TENANT_NAME || 'Pilot workspace').trim().slice(0, 120);
    const role = resolveRole({ email, subjectKey }, {
        env,
        exactEmails,
        localDevelopment,
        localSubjectDevelopment,
        immutableBrowserIdentity,
        immutableMcpApplication
    });
    const identityPresent = immutableMcpApplication || immutableBrowserIdentity
        ? Boolean(subjectKey)
        : Boolean(email);
    const configured = immutableMcpApplication
        ? Boolean(applicationTenantBindings.size)
        : immutableBrowserIdentity
            ? Boolean(allowedSubjects.length)
            : Boolean(exactEmails.length || (allowedTenantIds.length && parseBoolean(env.NOFRIES_ALLOW_TENANT_WIDE)));

    return {
        allowed,
        reason: allowed ? 'approved' : resolveDeniedReason({
            identityPresent,
            hosted,
            authenticated,
            configured
        }),
        user: identityPresent ? {
            email,
            name: String(safeIdentity.name || '').trim().slice(0, 160),
            principalId: principalId || null,
            identityTenantId: identityTenantId || null,
            subjectKey: subjectKey || null,
            ...(immutableMcpApplication ? { clientId: applicationClientId || null } : {}),
            actorId: subjectKey || email,
            role,
            capabilities: ROLE_CAPABILITIES[role].slice()
        } : null,
        tenant: {
            id: tenantId,
            key: tenantStorageKey(tenantId),
            name: tenantName,
            slug: slugify(String(env.NOFRIES_TENANT_SLUG || tenantName || tenantId))
        },
        authentication: {
            required: hosted,
            authenticated,
            provider: safeIdentity.provider || 'unknown',
            tenantWideAccess,
            immutableSubject: immutableBrowserIdentity || immutableMcpApplication
        }
    };
}

function assertCapability(access, capability) {
    if (!access || !access.allowed) {
        throw accessError(403, 'This identity has not been approved for a No Fries tenant', {
            code: 'tenant_access_required',
            reason: access && access.reason || 'not_approved'
        });
    }

    const capabilities = access.user && access.user.capabilities || [];
    if (!capabilities.includes(capability)) {
        throw accessError(403, 'Your No Fries role does not permit this action', {
            code: 'capability_required',
            capability
        });
    }
}

function accessError(statusCode, message, details) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.details = details || {};
    return error;
}

function resolveRole(identity, options) {
    const env = options.env;
    if (options.immutableMcpApplication) {
        return ROLES.MCP_READER;
    }
    if (options.immutableBrowserIdentity) {
        const adminSubjects = unique(parseList(env.NOFRIES_ADMIN_SUBJECTS).map(normaliseSubjectKey));
        const serviceOwnerSubjects = unique(parseList(env.NOFRIES_SERVICE_OWNER_SUBJECTS).map(normaliseSubjectKey));

        if (adminSubjects.includes(identity.subjectKey)) {
            return ROLES.ADMIN;
        }
        if (serviceOwnerSubjects.includes(identity.subjectKey)) {
            return ROLES.SERVICE_OWNER;
        }
        if (options.localSubjectDevelopment) {
            return ROLES.ADMIN;
        }
        return ROLES.CONSULTANT;
    }

    const adminEmails = parseList(env.NOFRIES_ADMIN_EMAILS).map(normaliseEmail);
    const serviceOwnerEmails = parseList(env.NOFRIES_SERVICE_OWNER_EMAILS).map(normaliseEmail);

    if (adminEmails.includes(identity.email)) {
        return ROLES.ADMIN;
    }
    if (serviceOwnerEmails.includes(identity.email)) {
        return ROLES.SERVICE_OWNER;
    }
    if (!adminEmails.length && (options.localDevelopment || options.exactEmails.includes(identity.email))) {
        return ROLES.ADMIN;
    }
    return ROLES.CONSULTANT;
}

function parseMcpApplicationSubjectTenants(value) {
    const bindings = new Map();
    for (const entry of parseList(value)) {
        const separator = entry.indexOf('=');
        if (separator < 1 || separator !== entry.lastIndexOf('=')) {
            throw applicationTenantConfigurationError();
        }
        const subject = normaliseApplicationSubjectKey(entry.slice(0, separator));
        const tenantId = normaliseInternalTenantId(entry.slice(separator + 1));
        if (!subject || !tenantId || bindings.has(subject)) {
            throw applicationTenantConfigurationError();
        }
        bindings.set(subject, tenantId);
    }
    return bindings;
}

function normaliseInternalTenantId(value) {
    const result = normaliseIdentifier(value);
    return /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/.test(result) ? result : '';
}

function applicationTenantConfigurationError() {
    return accessError(503, 'The MCP application tenant mapping is invalid', {
        code: 'tenant_access_configuration_invalid'
    });
}

function resolveTenantId(options) {
    const configured = normaliseIdentifier(
        options.env.NOFRIES_DEFAULT_TENANT_ID ||
        options.env.NOFRIES_TENANT_SLUG
    );
    if (configured) {
        return configured;
    }
    if (options.tenantAllowed && options.identityTenantId) {
        return options.identityTenantId;
    }
    if (options.email || options.subjectKey) {
        return 'founding-pilot';
    }
    return 'unassigned';
}

function resolveDeniedReason(options) {
    if (options.hosted && !options.authenticated) {
        return 'authentication_required';
    }
    if (!options.identityPresent) {
        return 'identity_missing';
    }
    if (!options.configured) {
        return 'access_not_configured';
    }
    return 'identity_not_approved';
}

function tenantStorageKey(value) {
    return crypto.createHash('sha256').update(String(value || 'unassigned')).digest('hex').slice(0, 32);
}

function parseList(value) {
    return String(value || '')
        .split(/[\n,;]/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function parseBoolean(value) {
    return String(value || '').trim().toLowerCase() === 'true';
}

function normaliseEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function normaliseIdentifier(value) {
    return String(value || '').trim().toLowerCase();
}

function normaliseSubjectKey(value) {
    const result = normaliseIdentifier(value);
    const parts = result.split(':');
    if (parts.length !== 2 || !isGuid(parts[0]) || !isGuid(parts[1])) {
        return '';
    }
    return `${parts[0]}:${parts[1]}`;
}

function canonicalSubjectKey(value, tenantId, principalId) {
    const canonical = normaliseSubjectKey(value);
    if (!canonical || !isGuid(tenantId) || !isGuid(principalId)) {
        return '';
    }
    return canonical === `${tenantId}:${principalId}` ? canonical : '';
}

function normaliseApplicationSubjectKey(value) {
    const result = normaliseIdentifier(value);
    const parts = result.split(':');
    if (parts.length !== 3 || parts.some((part) => !isGuid(part))) {
        return '';
    }
    return parts.join(':');
}

function canonicalApplicationSubjectKey(value, tenantId, principalId, clientId) {
    const canonical = normaliseApplicationSubjectKey(value);
    if (!canonical || !isGuid(tenantId) || !isGuid(principalId) || !isGuid(clientId)) {
        return '';
    }
    return canonical === `${tenantId}:${principalId}:${clientId}` ? canonical : '';
}

function isGuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(value || ''));
}

function slugify(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'workspace';
}

function unique(values) {
    return Array.from(new Set(values.filter(Boolean)));
}

module.exports = {
    ROLES,
    ROLE_CAPABILITIES,
    assertCapability,
    parseMcpApplicationSubjectTenants,
    resolveTenantAccess,
    tenantStorageKey
};
