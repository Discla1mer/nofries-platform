'use strict';

const { tenantStorageKey } = require('./tenantAccess');
const { parseCanonicalProviderId } = require('./serviceDesk/providerIds');

const SUBJECT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function resolveCustomerPortalAccess(identity, env = process.env) {
    const safeIdentity = identity && typeof identity === 'object' ? identity : {};
    const subjectKey = canonicalIdentitySubject(safeIdentity);
    const memberships = parseCustomerPortalMemberships(env.NOFRIES_CUSTOMER_PORTAL_MEMBERSHIPS);
    const membership = subjectKey
        ? memberships.find((candidate) => candidate.subjectKey === subjectKey)
        : null;

    if (!safeIdentity.isAuthenticated) {
        return denied('authentication_required');
    }
    if (!subjectKey) {
        return denied('immutable_subject_required');
    }
    if (!membership) {
        return denied(memberships.length ? 'customer_membership_required' : 'customer_membership_not_configured');
    }
    const configuredIdentityTenant = cleanText(env.NOFRIES_ENTRA_TENANT_ID, 36).toLowerCase();
    const configuredWorkspaceTenant = cleanText(env.NOFRIES_DEFAULT_TENANT_ID || env.NOFRIES_TENANT_SLUG, 180).toLowerCase();
    const configuredProviderScope = cleanText(env.NOFRIES_AUTOTASK_PROVIDER_SCOPE_ID, 180).toLowerCase();
    if (!configuredIdentityTenant || !configuredWorkspaceTenant || !configuredProviderScope) {
        return denied('customer_deployment_binding_not_configured');
    }
    if (configuredIdentityTenant && subjectKey.split(':')[0] !== configuredIdentityTenant) {
        return denied('identity_tenant_mismatch');
    }
    if (configuredWorkspaceTenant && membership.workspaceTenantId !== configuredWorkspaceTenant) {
        return denied('customer_workspace_mismatch');
    }
    if (configuredProviderScope && membership.providerScopeId.toLowerCase() !== configuredProviderScope) {
        return denied('customer_provider_scope_mismatch');
    }

    const email = cleanText(safeIdentity.email, 254).toLowerCase();
    if (!isVerifiedRequesterEmail(email)) {
        return denied('verified_requester_email_required');
    }
    const name = cleanText(safeIdentity.name, 160);
    const tenantId = membership.workspaceTenantId;
    return {
        allowed: true,
        reason: 'approved',
        authentication: {
            authenticated: true,
            provider: safeIdentity.provider || 'unknown',
            immutableSubject: true
        },
        user: {
            actorId: subjectKey,
            subjectKey,
            principalId: subjectKey.split(':')[1],
            identityTenantId: subjectKey.split(':')[0],
            email,
            name,
            role: membership.role
        },
        tenant: {
            id: tenantId,
            key: tenantStorageKey(tenantId),
            name: membership.workspaceName || 'No Fries customer services',
            slug: slugify(tenantId)
        },
        customer: {
            id: membership.customerId,
            companyId: membership.companyId,
            providerScopeId: membership.providerScopeId,
            contactId: membership.contactId,
            displayName: membership.displayName,
            timezone: membership.timezone
        }
    };
}

function parseCustomerPortalMemberships(value) {
    if (!String(value || '').trim()) return [];

    let parsed;
    try {
        parsed = JSON.parse(value);
    } catch (error) {
        return [];
    }

    if (!Array.isArray(parsed)) return [];
    const rows = parsed;
    const memberships = rows.map(normaliseMembership).filter(Boolean);
    const seen = new Set();
    for (const membership of memberships) {
        if (seen.has(membership.subjectKey)) return [];
        seen.add(membership.subjectKey);
    }
    return memberships;
}

function normaliseMembership(value) {
    const source = value && typeof value === 'object' ? value : {};
    const subjectKey = String(source.subjectKey || source.subject || '').trim().toLowerCase();
    const workspaceTenantId = cleanText(source.workspaceTenantId || source.tenantId, 180).toLowerCase();
    const customerId = cleanText(source.customerId || source.organisationId, 180);
    const companyId = parseCanonicalProviderId(source.companyId || source.autotaskCompanyId);
    const providerScopeId = cleanText(source.providerScopeId || source.autotaskProviderScopeId, 180).toLowerCase();
    const contactId = parseCanonicalProviderId(source.contactId || source.autotaskContactId);
    if (!SUBJECT_PATTERN.test(subjectKey) || !workspaceTenantId || !customerId || !companyId || !contactId || !providerScopeId || source.role !== 'customer_admin') return null;
    return {
        subjectKey,
        workspaceTenantId,
        workspaceName: cleanText(source.workspaceName, 120),
        customerId,
        companyId,
        providerScopeId,
        contactId,
        displayName: cleanText(source.displayName || source.customerName, 180) || 'Customer',
        timezone: cleanText(source.timezone, 80) || 'Pacific/Auckland',
        // This membership grants company-wide customer visibility. A future
        // contact-limited role must have an independently verified contact
        // crosswalk and provider-side contact filtering before it is accepted.
        role: 'customer_admin'
    };
}

function canonicalIdentitySubject(identity) {
    if (identity.provider !== 'entra-bff') return '';
    const tenantId = String(identity.tenantId || '').trim().toLowerCase();
    const principalId = String(identity.principalId || '').trim().toLowerCase();
    const subjectKey = String(identity.subjectKey || '').trim().toLowerCase();
    const derived = `${tenantId}:${principalId}`;
    if (!SUBJECT_PATTERN.test(derived) || subjectKey !== derived) return '';
    return derived;
}

function denied(reason) {
    return {
        allowed: false,
        reason,
        authentication: {
            authenticated: reason !== 'authentication_required',
            immutableSubject: false
        },
        user: null,
        tenant: null,
        customer: null
    };
}

function cleanText(value, maximum) {
    return String(value == null ? '' : value).trim().slice(0, maximum);
}

function isVerifiedRequesterEmail(value) {
    const email = String(value || '').trim().toLowerCase();
    return Boolean(
        email.length >= 3 && email.length <= 254 &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
        !/[\u0000-\u001f\u007f]/.test(email)
    );
}

function slugify(value) {
    return String(value || '').trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'customer';
}

module.exports = {
    parseCustomerPortalMemberships,
    resolveCustomerPortalAccess
};
