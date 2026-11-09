'use strict';
const { fields, copy, freeze, equal, uuid, instant } = require('../appLifecycle/dashboardRuntimeRecords');
const { normaliseSelector, DashboardAdminError } = require('./service');
const { readActionRecord } = require('./accountActionsStorage');
const { outcomeRecord, outcomePair, outcomeView } = require('./accountActionsOutcomeRecords');
const fail = (status, code) => { throw new DashboardAdminError(status, 'dashboard_admin_' + code); };
function createActionOutcomeReader({ auditContainer, readContext, clock }) {
    return async function readOutcome(actor, raw, invocation) {
        let selector, operationId;
        try { const input = fields(copy(raw, 2048), ['selector', 'operationId']); selector = normaliseSelector(input.selector); operationId = uuid(input.operationId); }
        catch (_) { fail(400, 'input_invalid'); }
        const signal = AbortSignal.any([invocation.signal, AbortSignal.timeout(10000)]);
        let context, last;
        const check = () => { const at = instant(clock()); if (signal.aborted || last && at < last) fail(503, 'unavailable'); last = at; return at; };
        async function current() {
            check(); const fresh = freeze(copy(await readContext(actor, selector, { ...invocation, signal }), 4096)); check();
            if (fresh.operatorSubjectKey !== actor.subjectKey || context && !equal(context, fresh)) fail(403, 'access_denied'); context = fresh;
        }
        try {
            await current(); const records = [];
            for (const phase of ['attempt', 'terminal']) {
                let found;
                try { found = await readActionRecord(auditContainer, `dashboard-admin-account-actions/${operationId}/${phase}.json`, signal); }
                catch (error) { if (error.statusCode === 404 && error.code === 'BlobNotFound') { records.push(null); continue; } throw error; }
                records.push(outcomeRecord(found.record, selector, operationId, phase, check()));
            }
            const [attempt, terminal] = records;
            if (!attempt) { if (terminal) fail(503, 'unavailable'); fail(404, 'not_found'); }
            outcomePair(attempt, terminal); await current();
            return { operationId, selector, outcome: terminal?.outcome || 'unconfirmed', attempt: outcomeView(attempt), terminal: outcomeView(terminal) };
        } catch (error) {
            if (error instanceof DashboardAdminError) throw error;
            fail(503, 'unavailable');
        }
    };
}
module.exports = { createActionOutcomeReader };
