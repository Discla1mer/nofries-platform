'use strict';

const { isProxy } = require('node:util').types;

class EntraB2bInvitationError extends Error {
    constructor(code = 'signup_provider_unavailable') {
        super(code);
        this.code = code;
    }
}

const fail = code => { throw new EntraB2bInvitationError(code); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function plain(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) fail();
    const output = {};
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== 'string' || !descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) fail();
        output[key] = descriptor.value;
    }
    return output;
}

function exact(value, keys) {
    const record = plain(value);
    if (Object.keys(record).sort().join(',') !== [...keys].sort().join(',')) fail('signup_provider_response_invalid');
    return record;
}

function uuid(value) {
    const result = String(value || '').trim().toLowerCase();
    if (!UUID.test(result)) fail('signup_provider_response_invalid');
    return result;
}

function email(value) {
    const result = String(value || '').normalize('NFC').trim().toLowerCase();
    if (!result || result.length > 254 || Buffer.byteLength(result, 'utf8') > 254 || !EMAIL.test(result)) {
        fail('signup_invitation_input_invalid');
    }
    return result;
}

function displayName(value) {
    const result = String(value || '').normalize('NFC').trim();
    if (!result || result.length > 160 || Buffer.byteLength(result, 'utf8') > 320 || /[\u0000-\u001f\u007f]/.test(result)) {
        fail('signup_invitation_input_invalid');
    }
    return result;
}

function redirect(value) {
    let result;
    try { result = new URL(value); } catch (_) { fail('signup_provider_configuration_invalid'); }
    if (result.protocol !== 'https:' || result.username || result.password || result.search || result.hash ||
        result.pathname !== '/signup' || result.origin === 'null') fail('signup_provider_configuration_invalid');
    return result.href;
}

function guest(value, expectedEmail) {
    const record = exact(value, ['id', 'mail', 'userType']);
    if (record.userType !== 'Guest' || email(record.mail) !== expectedEmail) fail('signup_provider_response_invalid');
    return Object.freeze({ id: uuid(record.id), mail: expectedEmail, userType: 'Guest' });
}

function result(tenantId, account, source) {
    const principalId = uuid(account.id);
    return Object.freeze({
        provider: 'entra-b2b',
        status: source === 'existing' ? (account.userType === 'Member' ? 'existing_member' : 'existing_guest') : 'invited',
        subjectKey: `${tenantId}:${principalId}`,
        tenantId,
        principalId,
        email: account.mail
    });
}

function createEntraB2bInvitationService(options = {}) {
    const dependencies = plain(options);
    if (Object.keys(dependencies).filter(k => !['bootstrapToken', 'sendMemberInvitation'].includes(k)).sort().join(',') !== ['createInvitation', 'findGuestsByEmail', 'redirectUrl', 'tenantId'].sort().join(',')) {
        fail('signup_provider_configuration_invalid');
    }
    if (typeof dependencies.findGuestsByEmail !== 'function' || isProxy(dependencies.findGuestsByEmail) ||
        typeof dependencies.createInvitation !== 'function' || isProxy(dependencies.createInvitation)) {
        fail('signup_provider_configuration_invalid');
    }
    const tenantId = uuid(dependencies.tenantId);
    let redirectUrl = redirect(dependencies.redirectUrl);
    const deliveredCapability = Object.hasOwn(dependencies, 'bootstrapToken');
    if (Object.hasOwn(dependencies, 'sendMemberInvitation') && (!deliveredCapability ||
        typeof dependencies.sendMemberInvitation !== 'function' || isProxy(dependencies.sendMemberInvitation))) {
        fail('signup_provider_configuration_invalid');
    }
    if (deliveredCapability) {
        const token = dependencies.bootstrapToken;
        if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) ||
            Buffer.from(token, 'base64url').toString('base64url') !== token) fail('signup_provider_configuration_invalid');
        redirectUrl += '#invitation=' + token;
    }

    return Object.freeze({
        async resolveOrInvite(input) {
            const request = exact(input, ['displayName', 'email']);
            const invitedEmail = email(request.email);
            const invitedDisplayName = displayName(request.displayName);
            let matches;
            try { matches = await dependencies.findGuestsByEmail(invitedEmail); }
            catch (_) { fail(); }
            if (!Array.isArray(matches) || matches.length > 1) fail('signup_provider_response_invalid');
            if (matches.length === 1 && matches[0]?.userType === 'Member' && dependencies.sendMemberInvitation) {
                const member = exact(matches[0], ['id', 'mail', 'userType']);
                const account = { id: uuid(member.id), mail: email(member.mail), userType: 'Member' };
                if (account.mail !== invitedEmail) fail('signup_provider_response_invalid');
                try { await dependencies.sendMemberInvitation(Object.freeze({ email: invitedEmail,
                    displayName: invitedDisplayName, redirectUrl })); }
                catch (_) { fail(); }
                return result(tenantId, account, 'existing');
            }
            const existing = matches.length === 1 ? guest(matches[0], invitedEmail) : null;
            if (existing && !deliveredCapability) return result(tenantId, existing, 'existing');

            let invitation;
            try {
                invitation = await dependencies.createInvitation(Object.freeze({
                    invitedUserEmailAddress: invitedEmail,
                    invitedUserDisplayName: invitedDisplayName,
                    inviteRedirectUrl: redirectUrl,
                    sendInvitationMessage: true
                }));
            } catch (_) { fail(); }
            const response = exact(invitation, ['invitedUser', 'status']);
            if (response.status !== 'PendingAcceptance' &&
                !(deliveredCapability && existing && response.status === 'Completed')) fail('signup_provider_response_invalid');
            const invited = guest(response.invitedUser, invitedEmail);
            if (existing && invited.id !== existing.id) fail('signup_provider_response_invalid');
            return result(tenantId, invited, 'invited');
        }
    });
}

module.exports = Object.freeze({ EntraB2bInvitationError, createEntraB2bInvitationService });
