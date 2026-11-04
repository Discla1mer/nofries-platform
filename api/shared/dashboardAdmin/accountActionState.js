'use strict';

const { copy, fields, hash, equal, digest } = require('../appLifecycle/dashboardRuntimeRecords');
const { DashboardAdminError } = require('./service');
const fail = () => { throw new DashboardAdminError(503, 'dashboard_admin_unavailable'); };
// Audit records contain identifiers and integrity references only. Customer
// labels and membership witnesses live in immutable, private action state.
function auditResult(state) {
    return { action: state.command.action, selector: state.command.selector,
        operationId: state.command.operationId, commandSha256: state.command.commandSha256,
        stateSha256: hash(state), labelRevision: state.labelRevision,
        restoreEpoch: state.restoreEpoch, authoritySha256: state.authoritySha256 };
}
async function hydrate(row, store) {
    try {
        const result = fields(copy(row.payload.result), ['action', 'selector', 'operationId', 'commandSha256',
            'stateSha256', 'labelRevision', 'restoreEpoch', 'authoritySha256']);
        digest(result.stateSha256);
        if (row.result_sha256 !== hash(result) || row.payload.resultSha256 !== row.result_sha256) fail();
        const state = copy(await store.readState(result.stateSha256), 65536);
        if (!equal(auditResult(state), result)) fail();
        return { ...row, result_sha256: hash(state), payload: { ...row.payload, result: state, resultSha256: hash(state) } };
    } catch (_) { fail(); }
}
module.exports = { auditResult, hydrate };
