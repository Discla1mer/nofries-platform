'use strict';

// Status-only portfolio read for an adviser's client organisations
// (docs/design/consultant-paid-framework-status.md). These are fixed,
// parameterised statements. Authority comes from the request database, never
// from these rows: the starter proof only narrows candidates further.
const { tuples } = require('../appLifecycle/paidFrameworkDecisions');
const { PaidAssessmentError } = require('./paidAssessments');
const { copy, fields, freeze, uuid } = require('../appLifecycle/dashboardRuntimeRecords');

const PAGE_BINDINGS = 10, MAX_ROWS = 20;
const PINS = freeze(tuples.map(({ moduleId, profileId, version }) => ({ moduleId, profileId, version }))
    .sort((a, b) => a.profileId < b.profileId ? -1 : a.profileId > b.profileId ? 1 : 0));
const WIRE = freeze({ not_started: 'not_started', created: 'in_progress', 'in-progress': 'in_progress', submitted: 'submitted' });

// Runs with the subject-only runtime settings. RLS limits both tables to the
// captured subject; the explicit predicates repeat that and require an
// activated consultant account and an activated, undiscarded client (ordinal > 0).
const STARTER_PROOF_SQL = `SELECT s.binding_id::text AS binding_id, s.tenant_id, s.organisation_id,
    s.authority_id::text AS authority_id FROM nofries.dashboard_starter_scopes s
    JOIN nofries.dashboard_starter_accounts a ON a.account_id = s.account_id AND a.account_type = s.account_type
        AND a.subject_key = s.subject_key
    WHERE s.subject_key = $1 AND s.account_type = 'consultant' AND a.activated_at IS NOT NULL
        AND s.activation IS NOT NULL AND s.discarded_at IS NULL AND s.ordinal > 0 AND s.binding_id = ANY($2::uuid[])
    ORDER BY s.binding_id`;

// Runs with one target's tenant/organisation settings, so the existing
// framework_runtime_scope RLS applies as well as the bound predicates. One
// aggregate per authorised tuple both detects an invalid head and selects the
// winning head (open first, then latest update, then lowest ID in byte order).
const STATUS_SQL = `WITH pins AS (SELECT * FROM unnest($3::text[], $4::text[]) AS p(profile_id, profile_version)),
heads AS (SELECT DISTINCT ON (r.profile_id, r.profile_version, r.assessment_id COLLATE "C")
        r.profile_id, r.profile_version, r.assessment_id, r.record#>>'{state,status}' AS status,
        r.record#>>'{state,updatedAt}' AS updated_at
    FROM nofries.dashboard_framework_revisions r
    JOIN pins p ON p.profile_id = r.profile_id AND p.profile_version = r.profile_version
    WHERE r.tenant_id = $1 AND r.organisation_id = $2
    ORDER BY r.profile_id, r.profile_version, r.assessment_id COLLATE "C", r.revision DESC)
SELECT p.profile_id, p.profile_version, CASE
    WHEN count(h.assessment_id) = 0 THEN 'not_started'
    WHEN bool_or(h.status IS NULL OR h.status NOT IN ('created', 'in-progress', 'submitted') OR h.updated_at IS NULL
        OR h.updated_at !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$') THEN 'invalid'
    ELSE (array_agg(h.status ORDER BY h.status <> 'submitted' DESC, h.updated_at DESC, h.assessment_id COLLATE "C"))[1]
    END AS status
FROM pins p LEFT JOIN heads h ON h.profile_id = p.profile_id AND h.profile_version = p.profile_version
GROUP BY p.profile_id, p.profile_version ORDER BY p.profile_id COLLATE "C"`;

function normalisePaidStatusPage(input) {
    try {
        const value = fields(copy(input, 1024), ['afterBindingId']);
        if (value.afterBindingId !== null) uuid(value.afterBindingId);
        return freeze(value);
    } catch { throw new PaidAssessmentError('input_invalid'); }
}
// Exactly one row per requested tuple, in the requested order, each with a
// known reduced status. Anything else is a failed read, never a partial answer.
function statusRows(result, pins) {
    const rows = result && Array.isArray(result.rows) ? result.rows : null;
    if (!rows || rows.length !== pins.length) throw new PaidAssessmentError();
    return pins.map((pin, index) => {
        const row = rows[index];
        if (!row || row.profile_id !== pin.profileId || row.profile_version !== pin.version ||
            typeof row.status !== 'string' || !Object.hasOwn(WIRE, row.status)) throw new PaidAssessmentError();
        return WIRE[row.status];
    });
}
module.exports = { PAGE_BINDINGS, MAX_ROWS, PINS, STARTER_PROOF_SQL, STATUS_SQL, normalisePaidStatusPage, statusRows };
