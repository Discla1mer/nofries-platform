(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else if (root.document && root.document.body.dataset.page === 'customer-report') api.mount(root);
}(typeof window === 'object' ? window : globalThis, function () {
    'use strict';
    const RECIPIENT = 'joel@nofries.nz';
    const KINDS = Object.freeze({ error: 'Report a problem', bug: 'Report a bug', feedback: 'Give feedback' });
    const SCREENS = Object.freeze({ unspecified: 'Not specified', signin: 'Sign in', signup: 'Account setup',
        dashboard: 'Dashboard / assessment', portal: 'Customer portal', website: 'Website' });
    const STEPS = Object.freeze(['signin', 'callback', 'setup', 'status', 'terms', 'save', 'load']);
    const CODES = Object.freeze(['signup_unavailable', 'signup_signin_required', 'signup_setup_recovery_required',
        'browser_auth_unavailable', 'browser_auth_transaction_expired', 'browser_auth_account_change_pending',
        'dashboard_unavailable', 'dashboard_timeout', 'portal_startup_failed', 'website_request_unavailable']);
    const REFERENCE = /^NF-[A-F0-9]{16}$/;
    const validReference = value => typeof value === 'string' && value.length === 19 && REFERENCE.test(value);
    const MAX_MAILTO_LENGTH = 1900;

    function readContext(fragment) {
        const params = new URLSearchParams(String(fragment || '').replace(/^#/, ''));
        const one = name => params.getAll(name).length === 1 ? params.get(name) : '';
        const pick = (value, list, fallback) => list.includes(value) ? value : fallback;
        const sha = one('apiReleaseSha'), runId = one('apiReleaseRunId');
        const release = sha.length === 40 && /^[a-f0-9]{40}$/.test(sha) &&
            runId.length <= 20 && /^[1-9][0-9]{0,19}$/.test(runId)
            ? { apiReleaseSha: sha, apiReleaseRunId: runId } : {};
        return Object.freeze({ kind: pick(one('kind'), Object.keys(KINDS), 'bug'),
            screen: pick(one('screen'), Object.keys(SCREENS), 'unspecified'),
            step: pick(one('step'), STEPS, ''), code: pick(one('code'), CODES, ''),
            reference: validReference(one('reference')) ? one('reference') : '', ...release });
    }

    function link(context) {
        const values = new URLSearchParams();
        for (const key of ['kind', 'screen', 'step', 'code', 'reference', 'apiReleaseSha', 'apiReleaseRunId']) {
            if (context && typeof context[key] === 'string') values.set(key, context[key]);
        }
        const safe = readContext(values.toString());
        const selected = new URLSearchParams();
        for (const [key, value] of Object.entries(safe)) if (value) selected.set(key, value);
        return '/report.html#' + selected.toString();
    }

    function maskText(value) {
        const input = String(value || '').slice(0, 500).toWellFormed().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
        const text = input
            .replace(/(?:https?:\/\/|mailto:|www\.)\S+/gi, '[link removed]')
            .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email removed]')
            .replace(/\b(?:password|passwd|pwd|secret|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|token|api[_ -]?key|authorization|cookie|otp|verification[_ -]?code)\s*[:=]\s*[^\n]+/gi, '[credential removed]')
            .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, '[credential removed]')
            .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[credential removed]')
            .replace(/\b(?:sk|re)_[A-Za-z0-9_-]+\b|\bsk-[A-Za-z0-9_-]+\b/g, '[credential removed]')
            .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[identifier removed]')
            .replace(/\b\d{6,8}\b/g, '[code removed]');
        return Object.freeze({ text, masked: text !== input });
    }

    function reference(crypto) {
        if (!crypto || typeof crypto.getRandomValues !== 'function') return '';
        const bytes = new Uint8Array(8);
        crypto.getRandomValues(bytes);
        return 'NF-' + Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('').toUpperCase();
    }

    function prepare(input, context, reportReference, preparedAt) {
        const selected = readContext(new URLSearchParams({ ...context, kind: input.kind, screen: input.screen }).toString());
        const safe = selected.kind === 'error' && selected.screen === context.screen ? selected
            : { ...selected, step: '', code: '', reference: '', apiReleaseSha: '', apiReleaseRunId: '' };
        const description = maskText(input.description);
        if (!description.text.trim()) throw new Error('report_description_required');
        const id = validReference(reportReference) ? reportReference : '';
        const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(preparedAt) ? preparedAt : 'Not available';
        const lines = [KINDS[safe.kind], 'Screen: ' + SCREENS[safe.screen]];
        if (safe.step) lines.push('Failed step: ' + safe.step);
        if (safe.code) lines.push('Error code: ' + safe.code);
        if (safe.reference) lines.push('Support reference: ' + safe.reference);
        if (safe.apiReleaseSha) lines.push('Original API release SHA: ' + safe.apiReleaseSha,
            'Original API release run: ' + safe.apiReleaseRunId);
        if (id) lines.push('Report reference: ' + id);
        lines.push('Prepared (UTC): ' + timestamp, '', description.text);
        const body = lines.join('\n');
        const subject = 'No Fries — ' + KINDS[safe.kind] + (id ? ' — ' + id : '');
        const mailto = 'mailto:' + RECIPIENT + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
        return Object.freeze({ body, subject, masked: description.masked, identity: JSON.stringify([safe, description.text]),
            mailto: mailto.length <= MAX_MAILTO_LENGTH ? mailto : '',
            copy: 'To: ' + RECIPIENT + '\nSubject: ' + subject + '\n\n' + body });
    }

    function mount(browser) {
        const document = browser.document;
        const node = name => document.getElementById('report-' + name);
        const context = readContext(browser.location.hash);
        const reportReference = reference(browser.crypto);
        let current = null, copying = false;
        const handedOff = new Set();
        node('kind').value = context.kind;
        node('screen').value = context.screen;
        node('description').value = '';
        node('description').placeholder = 'Describe the problem and what you expected.';
        node('title').textContent = KINDS[context.kind];
        node('preview-button').disabled = false;
        try { browser.history.replaceState(null, '', browser.location.pathname); } catch (_) { /* no diagnostic logging */ }
        node('form').addEventListener('submit', event => event.preventDefault());

        function controls() {
            const reviewed = !!current && node('reviewed').checked;
            node('open').disabled = !reviewed || handedOff.has(current.identity) || !current.mailto;
            node('copy').disabled = !reviewed || copying;
        }
        function changed() {
            current = null;
            node('reviewed').checked = false;
            node('preview').hidden = true;
            node('form').hidden = false;
            node('status').textContent = 'Your draft changed. Review it again before sharing.';
            node('title').textContent = KINDS[node('kind').value] || KINDS.bug;
            controls();
        }
        for (const name of ['kind', 'screen', 'description']) node(name).addEventListener('input', changed);
        node('edit').addEventListener('click', function () { changed(); node('description').focus(); });
        node('reviewed').addEventListener('change', controls);
        node('preview-button').addEventListener('click', function () {
            if (!node('form').reportValidity()) return;
            try {
                current = prepare({ kind: node('kind').value, screen: node('screen').value,
                    description: node('description').value }, context, reportReference, new Date().toISOString());
            } catch (_) {
                node('status').textContent = 'Add a short description before reviewing your report.';
                return;
            }
            node('reviewed').checked = false;
            node('body').value = current.body;
            node('subject').textContent = 'Subject: ' + current.subject;
            node('masking').hidden = !current.masked;
            node('preview').hidden = false;
            node('form').hidden = true;
            node('status').textContent = current.mailto ? 'Check the report, then choose how to share it. This page does not send email.'
                : 'This draft is too long for some email apps. Use Copy report, or shorten it and review again. This page does not send email.';
            controls();
            node('preview-title').focus();
        });
        node('open').addEventListener('click', function () {
            if (!current || !node('reviewed').checked || handedOff.has(current.identity) || !current.mailto) return;
            handedOff.add(current.identity); controls();
            node('status').textContent = 'Email draft requested. Send it from your email app. Sending and delivery are not confirmed here. Check sent mail before sending again.';
            try { browser.location.assign(current.mailto); }
            catch (_) { node('status').textContent = 'We could not confirm that your email app opened. Copy the report and email it to joel@nofries.nz. Sending and delivery are not confirmed.'; }
        });
        node('copy').addEventListener('click', async function () {
            if (!current || !node('reviewed').checked || copying) return;
            copying = true; controls();
            const report = current;
            try {
                if (!browser.navigator.clipboard || typeof browser.navigator.clipboard.writeText !== 'function') throw new Error();
                await browser.navigator.clipboard.writeText(report.copy);
                if (current === report) node('status').textContent = 'Report copied. Paste it into an email to joel@nofries.nz. Sending and delivery are not confirmed here.';
            } catch (_) {
                if (current === report) {
                    node('body').focus(); node('body').select();
                    node('status').textContent = 'Copy was not confirmed. Select and copy the report above, then email joel@nofries.nz. Sending and delivery are not confirmed here.';
                }
            } finally { copying = false; controls(); }
        });
        return Object.freeze({ context });
    }

    return Object.freeze({ RECIPIENT, KINDS, SCREENS, STEPS, CODES, readContext, link, maskText, reference, prepare, mount });
}));
