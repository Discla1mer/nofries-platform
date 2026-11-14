'use strict';

const { createHash } = require('node:crypto');

// Only source-owned markup enters this shell. Customer terms and state remain
// text nodes in the separately reviewed journey renderer.
function signupShell(content, script = '', customerTransport) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">` +
        `<title>No Fries | Account setup</title><link rel="icon" href="/images/nofrieslogo.png" type="image/png">` +
        `<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/home.css"></head>` +
        `<body class="access-page signup-page"><a class="skip-link" id="signup-skip" href="#signup">Skip to account setup</a>` +
        `<header class="site-header shell"><a class="brand" href="/" aria-label="No Fries home">` +
        `<img class="brand-logo" src="/images/nofrieslogo.png" width="44" height="44" alt="">` +
        `<span class="brand-copy"><strong>No Fries</strong><span>Dashboard</span></span></a>` +
        `<a class="text-link" href="/">Back to home</a></header>` +
        `<main class="shell access-layout"><div class="access-intro signup-intro">` +
        `<p class="eyebrow">Your No Fries Dashboard</p><h2>Start here.<br><span class="access-highlight">Return here.</span></h2>` +
        `<p>One place for your organisations, assessments and progress.</p>` +
        `<ol class="gateway-steps"><li><span aria-hidden="true">1</span><div><strong>Sign in securely</strong>` +
        `<p>Use your work email. If you were invited, use the email the invitation went to.</p></div></li>` +
        `<li><span aria-hidden="true">2</span><div><strong>Set up your organisation</strong>` +
        `<p>Complete your details and review your organisation’s terms.</p></div></li>` +
        `<li><span aria-hidden="true">3</span><div><strong>Continue your work</strong>` +
        `<p>Continue with the organisations you have access to.</p></div></li></ol></div>` +
        `<div class="signup-card-wrap"><p class="eyebrow signup-card-label">Account access</p>` +
        `<section class="organisation-card signup-card" id="signup" aria-live="polite" aria-atomic="false" tabindex="-1">${content}</section>` +
        `<p class="signup-help">Need to sign in with another account? <a id="signup-return-to-login" href="${customerTransport ? '/api/external-customer-auth/login?account=choose' : '/login'}">Return to sign in</a>.</p>` +
        `<p class="signup-recovery-help"><a href="/account-help.html">Forgot your password or need help signing in?</a></p>` +
        `<p class="signup-report-help"><a href="/report.html#kind=feedback&amp;screen=signup" target="_blank" rel="noopener noreferrer" aria-label="Report a bug or give feedback (opens in a new tab)">Report a bug or give feedback</a></p></div></main>` +
        `<footer class="home-footer"><span>© 2026 No Fries</span><nav aria-label="Footer links">` +
        `<a href="/privacy.html">Privacy</a><a href="/terms.html">Terms</a></nav></footer>${script}</body></html>`;
}

function buildSignupUnavailableDocument() {
    return signupShell('<h1>Signup is unavailable</h1><p>Account setup is not available right now. Please try again later.</p>' +
        '<a class="button" href="/">Return to No Fries</a>');
}

// The opening placeholder heading. The runtime backstop replaces the page
// only while this heading is still showing, so both must use the same text.
const OPENING_HEADING = 'Signing you in';

function buildSignupDocument({ clientSource, journeySource, customerLogin = false, customerTransport }) {
    if (customerTransport !== undefined && (customerTransport !== 'external' || customerLogin !== true)) {
        throw new Error('signup_document_transport_invalid');
    }
    for (const source of [clientSource, journeySource]) {
        if (typeof source !== 'string' || !source.trim() || /<\/script/i.test(source)) {
            throw new Error('signup_document_source_invalid');
        }
    }
    const runtime = `'use strict';\n(() => {\n` +
        // Focus navigation must not overwrite the invitation-only fragment.
        `document.getElementById('signup-skip')?.addEventListener('click', event => {\n` +
        `event.preventDefault(); document.getElementById('signup').focus();\n});\n` +
        `const transport = (() => { const module = { exports: {} };\n${clientSource}\nreturn module.exports; })();\n` +
        `const view = (() => { const module = { exports: {} };\n${journeySource}\nreturn module.exports; })();\n` +
        // A caller may forge this hint. It changes unauthenticated wording only;
        // the existing server-state read still owns progress and admission.
        `const recoveryHints = window.location.search ? new URLSearchParams(window.location.search).getAll('signin') : [];\n` +
        `const signInRecovery = recoveryHints.length === 1 && ['retry', 'expired', 'account'].includes(recoveryHints[0]) ? recoveryHints[0] : undefined;\n` +
        `const referenceHints = window.location.search ? new URLSearchParams(window.location.search).getAll('ref') : [];\n` +
        `const supportReference = signInRecovery && referenceHints.length === 1 && /^NF-[A-Z2-9]{6}$/.test(referenceHints[0]) ? referenceHints[0] : undefined;\n` +
        `const accountHints = window.location.search ? new URLSearchParams(window.location.search).getAll('account') : [];\n` +
        `const chooseAccount = ${customerTransport ? 'true' : 'false'} && accountHints.length === 1 && accountHints[0] === 'choose';\n` +
        `const entryQuery = new URLSearchParams(window.location.search || '');\n` +
        `const intents = entryQuery.getAll('intent'), providers = entryQuery.getAll('provider');\n` +
        `const entryIntent = intents.length === 1 && ['login', 'create'].includes(intents[0]) &&\n` +
        `!recoveryHints.length && !accountHints.length && !entryQuery.has('reauthenticate') && !window.location.hash &&\n` +
        `providers.length <= 1 && (!providers.length || providers[0] === '${customerTransport ? 'external' : 'legacy'}') &&\n` +
        `${customerTransport ? 'true' : "intents[0] === 'login'"}\n` +
        `? intents[0] : undefined;\n` +
        `let automaticEntry = entryIntent === 'login';\n` +
        // Invitation authentication remains available when public email setup
        // is disabled; the main public entry is still /login.
        (customerTransport
            ? `const destination = chooseAccount ? '/api/external-customer-auth/login?account=choose' : entryIntent === 'create' ? '/api/external-customer-auth/login?intent=create' : '/api/external-customer-auth/login';\n`
            : `const destination = '${customerLogin ? '/api/customer-auth/login' : '/api/auth/login?returnTo=%2Fsignup'}';\n`) +
        `const transportClient = transport.createSignupClient({ fetch: window.fetch.bind(window),\n` +
        (customerTransport ? `customerTransport: 'external',\n` : '') +
        `createAccount: ({ signal }) => new Promise((resolve, reject) => {\n` +
        `if (signal.aborted) { reject(new Error('signup_cancelled')); return; }\n` +
        `signal.addEventListener('abort', () => reject(new Error('signup_cancelled')), { once: true });\n` +
        (customerTransport ? `window.location.assign(destination);\n` : `window.location.assign('${customerLogin ? '/api/customer-auth/login' : '/api/auth/login?returnTo=%2Fsignup'}');\n`) +
        `}) });\n` +
        // Return to the dashboard page the person left before signing in again.
        // Only a fixed fragment from this allowlist is used, on the fixed
        // /dashboard path, so this cannot send anyone to another page or site.
        `const dashboardRoutes = ['#overview', '#ai-governance', '#cyber-security', '#it-optimisation', '#improvement-plan', '#evidence', '#board-reports', '#services'];\n` +
        `function dashboardDestination() {\n` +
        `let route = '';\n` +
        `try {\n` +
        `const raw = window.sessionStorage.getItem('nofries-return-route'); window.sessionStorage.removeItem('nofries-return-route');\n` +
        `const saved = typeof raw === 'string' && raw.length <= 200 ? JSON.parse(raw) : null;\n` +
        `const age = saved && Number.isSafeInteger(saved.at) ? Date.now() - saved.at : -1;\n` +
        `if (saved && typeof saved.route === 'string' && dashboardRoutes.includes(saved.route) && age >= 0 && age < 3600000) route = saved.route;\n` +
        `} catch (_) { route = ''; }\n` +
        `return '/dashboard' + route;\n}\n` +
        `const client = { ...transportClient };\n` +
        `for (const method of ['load', 'createAccount', 'acceptTerms', 'resumeAcceptance', 'completeSetup']) {\n` +
        `client[method] = async (...args) => {\n` +
        `const initialEntry = method === 'load' && automaticEntry;\n` +
        `if (method === 'load') automaticEntry = false;\n` +
        `const state = await transportClient[method](...args);\n` +
        `if (state.status === 'continue_to_dashboard') {\n` +
        `window.location.replace(dashboardDestination());\n}\n` +
        (customerTransport ? `if (state.status === 'continue_authentication' && !signInRecovery && !chooseAccount) window.location.replace('/api/external-customer-auth/login');\n` : '') +
        // Start the provider redirect without waiting on it inside this state
        // read: the page stays open until the provider page loads, which can
        // outlast the read's 30-second view backstop and must not show an error.
        // The fresh state is rendered, so manual sign-in remains available.
        `if (initialEntry && (state.status === 'create_account'${customerTransport ? " || entryIntent === 'login' && state.status === 'signin_required'" : ''})) {\n` +
        `window.location.replace(destination);\n}\n` +
        `return state;\n};\n}\n` +
        `async function start() {
` +
        `const fragment = window.location.hash || '';
` +
        `if (fragment) {
` +
        `window.history.replaceState(null, '', '${customerTransport ? '/signup?provider=external' : '/signup'}');
` +
        (customerTransport ? `throw new Error('signup_unavailable');\n` : '') +
        `if (!/^#invitation=[A-Za-z0-9_-]{43}$/.test(fragment)) throw new Error('signup_unavailable');
` +
        `const response = await window.fetch('/api/customer-signup/bootstrap', { method: 'POST', credentials: 'same-origin',
` +
        `mode: 'same-origin', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
` +
        `headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invitationToken: fragment.slice(12) }) });
` +
        `if (response.status !== 204) throw new Error('signup_unavailable');
}
` +
        `const journey = view.mountSignupJourney(document.getElementById('signup'), client, { signInRecovery, supportReference, chooseAccount, entryIntent${customerTransport ? ", customerTransport: 'external'" : ''} });\n` +
        `window.addEventListener('pagehide', () => { clearTimeout(openingWatchdog); journey.dispose(); client.dispose(); }, { once: true });\n}\n` +
        // A page restored from the back/forward cache holds a disposed view.
        // Start a fresh state read rather than showing a stale or empty card.
        `window.addEventListener('pageshow', event => { if (event.persisted) window.location.reload(); });\n` +
        // Backstop beyond the view's own 30-second bound: the opening
        // placeholder must never stay on screen without a way forward.
        `const openingWatchdog = setTimeout(() => {\n` +
        `const root = document.getElementById('signup'), first = root && root.querySelector('h1');\n` +
        `if (!first || first.textContent !== '${OPENING_HEADING}') return;\n` +
        `const heading = document.createElement('h1'); heading.textContent = 'We could not open your account'; heading.tabIndex = -1;\n` +
        `const message = document.createElement('p'); message.textContent = 'Checking your sign-in took too long. If you already have an account, it and your saved work are kept. You do not need to sign up again.';\n` +
        `const code = document.createElement('p'); code.textContent = 'Error code: NF-SIGNIN-UNCONFIRMED';\n` +
        `const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'button signup-entry-action'; retry.textContent = 'Try again';\n` +
        `retry.addEventListener('click', () => window.location.reload());\n` +
        `const restart = document.createElement('a'); restart.textContent = 'Sign in again'; restart.className = 'text-link signup-secondary-action';\n` +
        `restart.href = '${customerTransport ? '/api/external-customer-auth/login' : '/login'}';\n` +
        `root.removeAttribute('aria-busy'); root.replaceChildren(heading, message, code, retry, restart); heading.focus();\n` +
        `}, 45000);\n` +
        `start().catch(() => {\n` +
        `const root = document.getElementById('signup');\n` +
        `const heading = document.createElement('h1'); heading.textContent = 'Signup is unavailable'; heading.tabIndex = -1;\n` +
        `const message = document.createElement('p'); message.textContent = 'We could not open this invitation. Return to sign in, or use your original invitation link.';\n` +
        `root.replaceChildren(heading, message); heading.focus();\n});\n})();`;
    return signupRuntimeDocument(runtime, customerTransport);
}

// Static hosting cannot select a document from HttpOnly customer cookies. The
// callback supplies this fixed UI hint after authentication; the backend still
// validates every session and rejects ambiguous customer cookies independently.
function buildHostedSignupDocument({ clientSource, journeySource }) {
    const legacy = buildSignupDocument({ clientSource, journeySource, customerLogin: true });
    const external = buildSignupDocument({ clientSource, journeySource, customerLogin: true, customerTransport: 'external' });
    const runtime = `'use strict';\n(() => {\n` +
        `const providers = new URLSearchParams(window.location.search || '').getAll('provider');\n` +
        `if (providers.length > 1 || providers.length === 1 && !['legacy', 'external'].includes(providers[0])) {\n` +
        `if (window.location.hash) window.history.replaceState(null, '', '/signup');\n` +
        `const heading = document.createElement('h1'); heading.textContent = 'Signup is unavailable'; heading.tabIndex = -1;\n` +
        `const message = document.createElement('p'); message.textContent = 'Return to your original sign-in page and try again.';\n` +
        `document.getElementById('signup').replaceChildren(heading, message); heading.focus(); return;\n}\n` +
        `if (providers[0] === 'external') {\n` +
        `document.getElementById('signup-return-to-login')?.setAttribute('href', '/api/external-customer-auth/login?account=choose');\n` +
        `${external.runtime}\n} else {\n${legacy.runtime}\n}\n})();`;
    return signupRuntimeDocument(runtime);
}

function signupRuntimeDocument(runtime, customerTransport) {
    const scriptHash = `'sha256-${createHash('sha256').update(runtime).digest('base64')}'`;
    const contentSecurityPolicy = ["default-src 'none'", "base-uri 'none'", "object-src 'none'",
        "frame-src 'none'", "frame-ancestors 'none'", "form-action 'self'", "img-src 'self' data:",
        `script-src ${scriptHash}`, "script-src-attr 'none'", "style-src 'self'", "style-src-attr 'none'",
        "connect-src 'self'", "font-src 'self'", "worker-src 'none'", 'upgrade-insecure-requests'].join('; ');
    const html = signupShell(`<h1>${OPENING_HEADING}</h1><p>Opening your organisations…</p>` +
        '<noscript><p>Enable JavaScript to check your account setup and continue.</p></noscript>', `<script>${runtime}</script>`, customerTransport);
    return Object.freeze({ html, runtime, contentSecurityPolicy });
}

module.exports = { buildSignupDocument, buildHostedSignupDocument, buildSignupUnavailableDocument };
