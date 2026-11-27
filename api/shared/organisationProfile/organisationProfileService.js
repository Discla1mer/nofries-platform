'use strict';

// Organisation profile (#608 step 2): read and save an organisation's own
// website, industry, region and size. Runs only inside the dashboard's locked,
// generation-bound tenant transaction (dashboardRequestDatabase), which has
// already checked the signed-in member: any member may read; saving needs the
// organisation.manage permission (admins). The 0035 row-level policy admits
// only the selected organisation and stamps updated_by with the signed-in
// subject. Saves use an optimistic revision: a stale form gets a conflict with
// the current profile, never a silent overwrite. No website is fetched here.
const { requireTenantRequestContext } = require('../appLifecycle/tenantRequestContext');
const { INDUSTRIES, REGIONS, SIZE_BANDS, normaliseWebsite, choice } = require('./profileChoices');

const FIELDS = Object.freeze(['website', 'industry', 'region', 'sizeBand']);
// A read also carries the closed lists, so the Settings form shows the same
// choices the server and the 0035 CHECKs accept.
const CHOICES = Object.freeze({ industries: INDUSTRIES, regions: REGIONS, sizeBands: SIZE_BANDS });
const MAX_REVISION = 2147483647;

class OrganisationProfileError extends Error {
    constructor(code = 'organisation_profile_unavailable', statusCode = 503) {
        super(code); this.code = code; this.statusCode = statusCode;
    }
}
const fail = (code, status) => { throw new OrganisationProfileError(code, status); };

const READ_SQL = `SELECT revision, website, industry, region, size_band, updated_at
    FROM nofries.dashboard_organisation_profiles WHERE tenant_id=$1 AND organisation_id=$2`;
const INSERT_SQL = `INSERT INTO nofries.dashboard_organisation_profiles
    (tenant_id, organisation_id, revision, website, industry, region, size_band, updated_at, updated_by)
    VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8) ON CONFLICT (tenant_id, organisation_id) DO NOTHING`;
const UPDATE_SQL = `UPDATE nofries.dashboard_organisation_profiles
    SET revision=revision+1, website=$4, industry=$5, region=$6, size_band=$7, updated_at=$8, updated_by=$9
    WHERE tenant_id=$1 AND organisation_id=$2 AND revision=$3`;

// The browser sends exactly these keys. Empty strings clear a field.
function normaliseOrganisationProfile(input) {
    try {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) throw new Error();
        const keys = Object.keys(input);
        if (keys.length !== FIELDS.length + 1 || !['expectedRevision', ...FIELDS].every(key => Object.hasOwn(input, key))) throw new Error();
        const expectedRevision = input.expectedRevision;
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= MAX_REVISION) throw new Error();
        return Object.freeze({ expectedRevision, website: normaliseWebsite(input.website),
            industry: choice(INDUSTRIES, input.industry), region: choice(REGIONS, input.region),
            sizeBand: choice(SIZE_BANDS, input.sizeBand) });
    } catch (_) { return fail('organisation_profile_invalid', 400); }
}

function profileFromRow(row) {
    if (!row) return Object.freeze({ schemaVersion: 1, revision: 0, website: null, industry: null, region: null, sizeBand: null, updatedAt: null });
    const updatedAt = row.updated_at instanceof Date ? row.updated_at.toISOString() : new Date(row.updated_at).toISOString();
    // Re-check what the database returned against the same closed lists.
    try {
        if (!Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error();
        if (row.website !== null && normaliseWebsite(row.website) !== row.website) throw new Error();
        choice(INDUSTRIES, row.industry); choice(REGIONS, row.region); choice(SIZE_BANDS, row.size_band);
    } catch (_) { return fail(); }
    return Object.freeze({ schemaVersion: 1, revision: row.revision, website: row.website, industry: row.industry,
        region: row.region, sizeBand: row.size_band, updatedAt });
}

async function readProfile(tx, scope) {
    const { rows } = await tx.query(READ_SQL, [scope.tenantId, scope.organisationId]);
    if (rows.length > 1) fail();
    return profileFromRow(rows[0] || null);
}

const sameValues = (a, b) => FIELDS.every(key => a[key] === b[key]);

// input undefined: read. Otherwise a normalised save (normaliseOrganisationProfile).
// A stale save resolves (never throws) to { conflict: currentProfile }, so the
// transaction's final membership and permission checks still run before the
// current profile is disclosed.
async function organisationProfile({ database, context: contextInput, clock, audit }, input) {
    const context = requireTenantRequestContext(contextInput);
    const command = input === undefined ? null : normaliseOrganisationProfile(input);
    const scope = context.scope;
    return database.withTenantTransaction(scope.tenantId, async tx => {
        const current = await readProfile(tx, scope);
        if (!command) return Object.freeze({ ...current, choices: CHOICES });
        if (command.expectedRevision !== current.revision) return Object.freeze({ conflict: current });
        // Saving the same values again changes nothing and writes no audit event.
        if (current.revision > 0 && sameValues(current, command)) return current;
        const at = new Date(clock()).toISOString();
        const values = [command.website, command.industry, command.region, command.sizeBand, at, context.identity.subjectKey];
        const result = current.revision === 0
            ? await tx.query(INSERT_SQL, [scope.tenantId, scope.organisationId, ...values])
            : await tx.query(UPDATE_SQL, [scope.tenantId, scope.organisationId, current.revision, ...values]);
        if (result.rowCount !== 1) return Object.freeze({ conflict: await readProfile(tx, scope) });
        const saved = await readProfile(tx, scope);
        if (saved.revision !== current.revision + 1 || !sameValues(saved, command)) fail();
        await audit.writeEvent(audit.createEvent(context, { action: 'organisation.manage', module: 'overview', result: 'succeeded' }));
        return saved;
    });
}

module.exports = { OrganisationProfileError, normaliseOrganisationProfile, organisationProfile, profileFromRow, READ_SQL, INSERT_SQL, UPDATE_SQL };
