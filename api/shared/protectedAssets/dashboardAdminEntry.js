(function () {
    'use strict';
    if (document.body.dataset.page !== 'dashboard-admin-entry') return;
    const open = document.getElementById('adminEntryOpen');
    const cancel = document.getElementById('adminEntryCancel');
    const status = document.getElementById('adminEntryStatus');
    const signIn = document.getElementById('adminEntrySignIn');
    if (!open || !cancel || !status || !signIn) return;
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    let active = null, sequence = 0, initializationCommand = null;

    function fields(value, keys) {
        return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length &&
            keys.every(function (key) { return Object.prototype.hasOwnProperty.call(value, key); });
    }
    function ready(value) {
        const keys = ['schemaVersion', 'authenticated', 'purpose', 'expiresAt', 'generation', 'selectedBindingId'];
        if (Object.prototype.hasOwnProperty.call(value || {}, 'activationAvailable')) keys.push('activationAvailable');
        return fields(value, keys) && value.schemaVersion === 1 && value.authenticated === true && value.purpose === 'operator_dashboard' &&
            typeof value.expiresAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.expiresAt) &&
            Number.isFinite(Date.parse(value.expiresAt)) && new Date(value.expiresAt).toISOString() === value.expiresAt && Date.parse(value.expiresAt) > Date.now() &&
            typeof value.generation === 'string' && /^[0-9a-f]{64}$/.test(value.generation) &&
            (value.selectedBindingId === null || typeof value.selectedBindingId === 'string' && UUID.test(value.selectedBindingId)) &&
            (!keys.includes('activationAvailable') || value.activationAvailable === true);
    }
    function current(cycle) { return active === cycle && cycle.sequence === sequence; }
    function stop() {
        sequence += 1;
        const old = active; active = null;
        if (old) old.cancel.forEach(function (abort) { abort(); });
        open.disabled = false; cancel.hidden = true;
    }
    function request(cycle, url, body) {
        return new Promise(function (resolve, reject) {
            const controller = new AbortController();
            let settled = false;
            function finish(callback, value) {
                if (settled) return;
                settled = true; window.clearTimeout(timer); cycle.cancel.delete(abort); callback(value);
            }
            function abort() { controller.abort(); finish(reject, new Error('unavailable')); }
            const timer = window.setTimeout(abort, 12000);
            cycle.cancel.add(abort);
            const options = { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
                signal: controller.signal, headers: { Accept: 'application/json',
                    ...(url === '/api/dashboard/session' ? { 'X-Nofries-Dashboard-Purpose': 'operator_dashboard' } : {}),
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
            Promise.resolve().then(function () {
                if (!current(cycle) || settled) throw new Error('unavailable');
                return fetch(url, options);
            }).then(async function (response) {
                if (!current(cycle) || settled) return;
                if ([401, 403].includes(response.status)) throw Object.assign(new Error('denied'), { status: response.status });
                if (response.redirected || ['opaque', 'opaqueredirect'].includes(response.type) || !response.headers ||
                    !/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') || '')) throw new Error('unavailable');
                const value = await response.json();
                if (!current(cycle) || settled) return;
                finish(resolve, { status: response.status, value: value });
            }).catch(function (error) { finish(reject, error); });
        });
    }
    function requireReady(result) {
        if (result.status !== 200 || !ready(result.value)) throw new Error('unavailable');
    }
    function supported(value) {
        return value && !Array.isArray(value) && typeof value.lookup === 'boolean' && Array.isArray(value.recovery) && value.recovery.length === 0 &&
            Object.keys(value).every(function (key) { return ['lookup', 'signupList', 'recovery'].includes(key); }) &&
            (!Object.prototype.hasOwnProperty.call(value, 'signupList') || typeof value.signupList === 'boolean') &&
            (value.lookup === true || value.signupList === true);
    }
    async function enter() {
        if (active) return;
        const cycle = { sequence: ++sequence, cancel: new Set() }; active = cycle;
        open.disabled = true; cancel.hidden = false; signIn.hidden = true;
        status.textContent = 'Checking your staff session.';
        try {
            let result = await request(cycle, '/api/dashboard/session');
            if (!current(cycle)) return;
            if (result.status === 409 && fields(result.value, ['code']) && result.value.code === 'dashboard_initialization_required') {
                if (initializationCommand) throw new Error('unconfirmed');
                if (!window.crypto || typeof window.crypto.randomUUID !== 'function') throw new Error('unavailable');
                const operationId = window.crypto.randomUUID();
                if (typeof operationId !== 'string' || !UUID.test(operationId)) throw new Error('unavailable');
                // A lost acknowledgement does not establish command failure.
                // Later checks read current state and never resend this command.
                initializationCommand = Object.freeze({ operationId: operationId });
                status.textContent = 'Opening your staff session.';
                const acknowledged = await request(cycle, '/api/dashboard/session', initializationCommand);
                if (!current(cycle)) return;
                if (acknowledged.status !== 200 || !fields(acknowledged.value, ['schemaVersion', 'initialized']) ||
                    acknowledged.value.schemaVersion !== 1 || acknowledged.value.initialized !== true) throw new Error('unavailable');
                result = await request(cycle, '/api/dashboard/session');
            }
            requireReady(result);
            initializationCommand = null;
            status.textContent = 'Checking administration access.';
            const capabilities = await request(cycle, '/api/dashboard-admin/capabilities');
            if (!current(cycle)) return;
            if (capabilities.status !== 200 || !supported(capabilities.value)) {
                status.textContent = 'Administration access is unavailable for this session.';
                return;
            }
            status.textContent = 'Access checked. Opening dashboard administration.';
            window.location.assign('/dashboard-admin');
        } catch (error) {
            if (!current(cycle)) return;
            signIn.hidden = error.status !== 401;
            status.textContent = error.status === 401 ? 'Your staff session has ended. Sign in again to check access.' :
                error.status === 403 ? 'Administration access is unavailable for this staff session.' :
                initializationCommand ? 'Opening your session could not be confirmed. Check access again to see its current state.' :
                'Access could not be checked. You can check access again.';
        } finally {
            if (current(cycle)) { active = null; open.disabled = false; open.textContent = 'Check access again'; cancel.hidden = true; }
        }
    }
    open.addEventListener('click', enter);
    cancel.addEventListener('click', function () {
        stop(); open.textContent = 'Check access again';
        status.textContent = initializationCommand ? 'Opening your session could not be confirmed. Check access again to see its current state.' :
            'Access check cancelled. You can check access again.';
        open.focus();
    });
    window.addEventListener('pagehide', function () {
        stop(); open.textContent = 'Check access again';
        status.textContent = initializationCommand ? 'Opening your session could not be confirmed. Check access again to see its current state.' :
            'Access check paused. Choose Check access again to continue.';
    });
}());
