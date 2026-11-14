'use strict';

// Signed-in email settings page (#151, slice E7b). GET shows each lifecycle
// email type for the signed-in customer's own starter account; a native form
// POST turns one type off or back on through emailSettingsStore, which keeps a
// link unsubscribe off. Answers are generic and nothing identifying is logged.
const { apiSecurityHeaders } = require('../securityHeaders');

const PATH = '/api/account/email';
const MAX_BODY_BYTES = 256;
const MAX_IN_FLIGHT = 4;
const SUBJECT_KEY = /^[a-f0-9-]{36}:[a-f0-9-]{36}$/;
// Welcome is sent once at activation, before this page can be reached, so it
// is shown for information only and has no control.
const TYPES = Object.freeze([
    { type: 'welcome', label: 'Welcome email', detail: 'Sent once, when your account was set up.', toggle: false },
    { type: 'result_summary', label: 'Result summaries', detail: 'A summary after you submit an assessment.', toggle: true },
    { type: 'nudge_unfinished', label: 'Reminders to finish an assessment', detail: 'A reminder if an assessment is left unfinished.', toggle: true },
    { type: 'reassess_reminder', label: 'Reminders to reassess', detail: 'A reminder when it is time to check again.', toggle: true }
]);
const { TOGGLE_TYPES } = require('./emailSettingsStore');

const escape = value => String(value).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

function page(status, title, body) {
    const html = `<!DOCTYPE html>
<html lang="en-NZ">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>${escape(title)} | No Fries</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/home.css"></head>
<body class="access-page">
<a class="skip-link" href="#email-settings-title">Skip to email settings</a>
<header class="site-header shell"><a class="brand" href="/">No Fries</a><a class="text-link" href="/dashboard">Back to dashboard</a></header>
<main class="shell"><article class="organisation-card">
<h1 id="email-settings-title" tabindex="-1">${escape(title)}</h1>
${body}
</article></main>
<footer class="home-footer"><a href="/privacy.html">Privacy</a><a href="/contact.html">Contact us</a></footer>
</body>
</html>
`;
    return { status, isRaw: true, body: html, headers: apiSecurityHeaders({ 'Content-Type': 'text/html; charset=utf-8',
        // No script; styles are the site's own; the forms post back here only.
        'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; style-src 'self'; img-src 'self'" }) };
}

const message = (status, title, text, extra = '') => page(status, title, `<p>${escape(text)}</p>${extra}`);
const signIn = () => message(401, 'Please sign in', 'Sign in to your No Fries account to change your email settings.',
    '<p><a class="button" href="/dashboard">Go to your dashboard</a></p>');
function unavailable() {
    const result = message(503, 'Please try again later', 'We could not open your email settings just now.');
    return { ...result, headers: { ...result.headers, 'Retry-After': '60' } };
}

function settingsPage(status, preferences, notice = '') {
    if (preferences === null) {
        return message(status, 'Email settings', 'There are no No Fries emails set up for this account.');
    }
    const items = TYPES.map(item => {
        const row = preferences.find(entry => entry.type === item.type);
        const off = !!(row && row.off);
        const id = `email-${item.type.replace(/_/g, '-')}`;
        let control = '';
        if (item.toggle && off && row.source === 'link') {
            control = '<p>You unsubscribed from these using the link in an email. <a href="/contact.html">Contact us</a> to turn them back on.</p>';
        } else if (item.toggle) {
            control = `<form method="post" action="${PATH}"><input type="hidden" name="type" value="${item.type}">` +
                `<input type="hidden" name="action" value="${off ? 'on' : 'off'}">` +
                `<button class="button" type="submit" aria-describedby="${id}">${off ? 'Turn on' : 'Turn off'}</button></form>`;
        }
        return `<li><h2>${escape(item.label)}</h2><p id="${id}">${escape(item.label)}: <strong>${off ? 'Off' : 'On'}</strong>. ` +
            `${escape(item.detail)}</p>${control}</li>`;
    }).join('\n');
    const live = notice ? `<p role="status">${escape(notice)}</p>` : '';
    return page(status, 'Email settings', `<p>Choose which of these No Fries emails we send you.</p>
${live}<ul class="email-settings-list">
${items}
</ul>`);
}

// Native forms send "Origin: null" under the site's no-referrer policy, so,
// like the sign-out form, a POST must carry Sec-Fetch-Site: same-origin, and any
// real Origin must be the configured public origin.
function sameOrigin(req, env) {
    const headers = (req && req.headers) || {};
    const origin = String(headers.origin || '').trim();
    if (String(headers['sec-fetch-site'] || '').trim().toLowerCase() !== 'same-origin') return false;
    if (!origin || origin === 'null') return true;
    try {
        const expected = new URL(String(env.NOFRIES_PUBLIC_URL || '')).origin;
        return new URL(origin).origin === origin && origin === expected;
    } catch (_) { return false; }
}

function readCommand(req) {
    const body = req && req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
    const keys = Object.keys(body);
    if (keys.length !== 2 || !keys.includes('type') || !keys.includes('action')) return null;
    if (!TOGGLE_TYPES.includes(body.type) || !['on', 'off'].includes(body.action)) return null;
    return { type: body.type, action: body.action };
}

let inFlight = 0;
function resetEmailSettingsForTests() { inFlight = 0; }

/**
 * readSubject(cookieHeader) returns the signed-in customer's subject key, null
 * when nobody is signed in, or throws (statusCode 401 means sign in again).
 */
async function handleEmailSettingsRequest(req, { env = process.env, readSubject = null, store = null, log = null } = {}) {
    const method = String(req && req.method || '').toUpperCase();
    if (method !== 'GET' && method !== 'POST') {
        const result = message(405, 'Method not allowed', 'Open email settings from your dashboard.');
        return { ...result, headers: { ...result.headers, Allow: 'GET, POST' } };
    }
    if (typeof readSubject !== 'function' || !store) return unavailable();
    let command = null;
    if (method === 'POST') {
        if (!sameOrigin(req, env)) return message(403, 'Request not allowed', 'Open email settings from your dashboard and try again.');
        command = readCommand(req);
        if (!command) return message(400, 'That change was not recognised', 'Open email settings from your dashboard and try again.');
    }
    let subjectKey;
    try {
        subjectKey = await readSubject(String((req.headers && req.headers.cookie) || ''));
    } catch (error) {
        if (error && error.statusCode === 401) return signIn();
        if (log && typeof log.warn === 'function') log.warn('email_settings_session_failed');
        return unavailable();
    }
    if (subjectKey === null || subjectKey === undefined) return signIn();
    if (typeof subjectKey !== 'string' || !SUBJECT_KEY.test(subjectKey)) return unavailable();
    if (inFlight >= MAX_IN_FLIGHT) return unavailable();
    inFlight += 1;
    try {
        if (method === 'GET') {
            const saved = req.query && req.query.saved === '1';
            return settingsPage(200, await store.read(subjectKey), saved ? 'Your email settings are saved.' : '');
        }
        const outcome = await store.change(subjectKey, command.type, command.action);
        if (outcome === 'link_locked') {
            return settingsPage(409, await store.read(subjectKey),
                'That email stays off because you unsubscribed using the link in an email.');
        }
        if (outcome === null) return settingsPage(404, null);
        return { status: 303, isRaw: true, body: '', headers: apiSecurityHeaders({ Location: `${PATH}?saved=1` }) };
    } catch (_) {
        // Fixed text only: no subject, account, driver error or request detail.
        if (log && typeof log.warn === 'function') log.warn('email_settings_write_failed');
        return unavailable();
    } finally {
        inFlight -= 1;
    }
}

module.exports = { PATH, MAX_BODY_BYTES, MAX_IN_FLIGHT, TYPES, handleEmailSettingsRequest, resetEmailSettingsForTests };
