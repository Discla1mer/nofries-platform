'use strict';

// Native HTTP checks of GET/POST /api/dashboard/organisation-profile (#608 step 2),
// registered by the disposable PostgreSQL dashboard suite. Synthetic sessions and
// organisations only; the route runs as the restricted runtime role under 0035's
// row-level policy.
module.exports = function registerOrganisationProfileHttpPostgres({ ncscHttpSetup, httpJson, getOwnerPool, loginClean, subject, generationHeader }) {
    const ROUTE = 'organisation-profile';
    const CAPABILITIES = 'work-queue-v1 account-label-v1 contact-request-v1 starter-details-v1 questionnaire-details-v1 account-identity-v1 paid-status-v1 organisation-profile-v1';
    const save = (h, body) => h.post(ROUTE, body).set(generationHeader, h.generation);
    const empty = { schemaVersion: 1, revision: 0, website: null, industry: null, region: null, sizeBand: null, updatedAt: null };
    async function stored(h) {
        return (await getOwnerPool().query(`SELECT revision, website, industry, region, size_band, updated_by, xmin::text AS tx
            FROM nofries.dashboard_organisation_profiles WHERE tenant_id = $1`, [h.binding.scope.tenantId])).rows;
    }
    async function audits(h) {
        return (await getOwnerPool().query(`SELECT payload, xmin::text AS tx FROM nofries.dashboard_runtime_audit
            WHERE tenant_id = $1 AND payload->>'action' = 'organisation.manage' ORDER BY occurred_at, event_id`, [h.binding.scope.tenantId])).rows;
    }

    describe('HTTP organisation profile with restricted real PostgreSQL', () => {
        test('the route is absent by default and nothing is read or written', async () => {
            const h = await ncscHttpSetup({ customerProvider: true });
            httpJson(await h.get(ROUTE, h.generation), 404, 'dashboard_not_found');
            httpJson(await save(h, { expectedRevision: 0, website: '', industry: '', region: '', sizeBand: '' }), 404, 'dashboard_not_found');
            expect(await stored(h)).toEqual([]);
            await loginClean();
        });

        test('an admin reads an empty profile, saves it, updates it with the current revision and gets a conflict with a stale one', async () => {
            const h = await ncscHttpSetup({ customerProvider: true, organisationProfileEnabled: true });
            // Only a dashboard that offers organisation-profile-v1 is told the profile is available.
            const offered = await h.get('session').set('X-NoFries-Dashboard-Capabilities', CAPABILITIES); httpJson(offered, 200);
            expect(offered.body.organisationProfileAvailable).toBe(true);
            const older = await h.get('session').set('X-NoFries-Dashboard-Capabilities', CAPABILITIES.replace(' organisation-profile-v1', '')); httpJson(older, 200);
            expect(older.body).not.toHaveProperty('organisationProfileAvailable');
            const first = await h.get(ROUTE, h.generation); httpJson(first, 200);
            expect(first.body).toEqual(empty);

            const created = await save(h, { expectedRevision: 0, website: 'Example.co.nz/about', industry: 'retail', region: 'auckland', sizeBand: '6-20' });
            httpJson(created, 200);
            expect(created.body).toMatchObject({ schemaVersion: 1, revision: 1, website: 'https://example.co.nz/', industry: 'retail', region: 'auckland', sizeBand: '6-20' });
            const [row] = await stored(h);
            expect(row).toMatchObject({ revision: 1, website: 'https://example.co.nz/', size_band: '6-20', updated_by: subject(h.principal) });
            const [audit] = await audits(h);
            expect(audit.tx).toBe(row.tx);
            expect(audit.payload).toMatchObject({ action: 'organisation.manage', module: 'overview', result: 'succeeded', actorSubjectKey: subject(h.principal), ...h.binding.scope });

            // The same values again change nothing and write no audit event.
            httpJson(await save(h, { expectedRevision: 1, website: 'https://example.co.nz/', industry: 'retail', region: 'auckland', sizeBand: '6-20' }), 200);
            expect(await audits(h)).toHaveLength(1);

            const updated = await save(h, { expectedRevision: 1, website: '', industry: 'retail', region: 'otago', sizeBand: '' });
            httpJson(updated, 200);
            expect(updated.body).toMatchObject({ revision: 2, website: null, region: 'otago', sizeBand: null });

            const stale = await save(h, { expectedRevision: 1, website: '', industry: 'health', region: '', sizeBand: '' });
            httpJson(stale, 409, 'organisation_profile_conflict');
            expect(stale.body.profile).toMatchObject({ revision: 2, industry: 'retail', region: 'otago' });
            expect((await stored(h))[0]).toMatchObject({ revision: 2, industry: 'retail' });
            expect(await audits(h)).toHaveLength(2);

            // Invalid values are refused before any write.
            httpJson(await save(h, { expectedRevision: 2, website: 'http://localhost/', industry: '', region: '', sizeBand: '' }), 400, 'dashboard_input_invalid');
            httpJson(await save(h, { expectedRevision: 2, website: '', industry: 'mining', region: '', sizeBand: '' }), 400, 'dashboard_input_invalid');
            expect((await stored(h))[0].revision).toBe(2);
            await loginClean();
        });

        test('a viewer can read the profile but cannot save it', async () => {
            const h = await ncscHttpSetup({ customerProvider: true, organisationProfileEnabled: true, role: 'viewer' });
            const read = await h.get(ROUTE, h.generation); httpJson(read, 200);
            expect(read.body).toEqual(empty);
            httpJson(await save(h, { expectedRevision: 0, website: '', industry: 'retail', region: '', sizeBand: '' }), 403, 'organisation_profile_access_denied');
            expect(await stored(h)).toEqual([]);
            expect(await audits(h)).toEqual([]);
            await loginClean();
        });
    });
};
