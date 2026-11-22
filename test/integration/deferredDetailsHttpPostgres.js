'use strict';
const { deferredFixture, AT, DATA } = require('../fixtures/deferredDetailsFixture');
const { createPostgresSignupAcceptanceJournal } = require('../../api/shared/customerSignup/postgresSignupAcceptanceJournal');
module.exports = function ({ ncscHttpSetup, httpJson, getOwnerPool, loginClean, subject, nextId, generationHeader, createCommand, saveCommand, submitCommand }) {
    const read = h => h.get('representative-details', h.generation);
    const save = (h, data = DATA, generation = h.generation) => h.post('representative-details', data).set(generationHeader, generation);
    async function enrolled(customerAccountType = 'consultant', differentSigner = false) {
        const h = await ncscHttpSetup({ customerProvider: true, role: differentSigner ? 'editor' : 'admin', customerAccountType, ownDeferredAgreement: customerAccountType === 'company', representativeDetailsEnabled: true,
            questionnaireExportGateEnabled: true,
            contactRequestsEnabled: true, scope: { tenantId: nextId(), organisationId: nextId() } });
        h.state.now = AT; await h.login(); await h.initialize();
        h.generation = (await h.get('session')).body.generation;
        const f = await deferredFixture({ identity: differentSigner ? undefined : h.principal, scope: h.binding.scope }), pool = getOwnerPool();
        await createPostgresSignupAcceptanceJournal({ database: { withTenantTransaction: (_, work) => work(pool) } }).persist(f.receipt);
        await pool.query(`INSERT INTO nofries.dashboard_starter_accounts (account_id,email_sha256,subject_key,account_type)
            VALUES ($1,$2,$3,'company')`, [f.account.accountId, require('node:crypto').createHash('sha256').update(f.account.accountId).digest('hex'), f.preparation.subjectKey]);
        await pool.query(`INSERT INTO nofries.dashboard_starter_scopes
            (tenant_id,organisation_id,account_id,account_type,subject_key,ordinal,authority_id,binding_id,preparation,activation)
            VALUES ($1,$2,$3,'company',$4,0,$5,$6,$7::jsonb,$8::jsonb)`, [h.binding.scope.tenantId, h.binding.scope.organisationId,
            f.account.accountId, f.preparation.subjectKey, f.preparation.slot.authorityId, f.preparation.slot.bindingId,
            JSON.stringify(f.preparation), JSON.stringify(f.activation)]);
        return { h, f, pool };
    }
    describe('Stream E native selected-organisation gate', () => {
        test('own enrolled company binding negotiates the export gate', async () => {
            const { h } = await enrolled('company');
            const session = await h.get('session').set('X-NoFries-Dashboard-Capabilities', 'work-queue-v1 account-label-v1 contact-request-v1 starter-details-v1 questionnaire-details-v1');
            expect(session.body.questionnaireExportGateAvailable).toBe(true);
            await loginClean();
        });
        test('an enrolled company member with a hidden starter scope cannot export a new result after marker removal', async () => {
            const { h, f, pool } = await enrolled('company', true);
            expect(f.preparation.subjectKey).not.toBe(subject(h.principal));
            const tenant = [h.binding.scope.tenantId];
            const { hash } = require('../../api/shared/appLifecycle/dashboardRuntimeRecords');
            const { createAccountWipeRepository } = require('../../api/shared/dashboardAdmin/accountWipeRepository');
            const link = { schemaVersion: 1, ...f.preparation.scope, subjectKey: f.preparation.subjectKey,
                receiptId: f.receipt.receiptId, acceptanceSha256: hash(f.receipt), scheduleId: f.receipt.scheduleId,
                scheduleDigest: f.receipt.scheduleDigest, authorityEvidenceId: f.preparation.representativeAuthorityEvidenceId };
            const payload = { link, details: DATA, recordedAt: AT };
            await pool.query(`INSERT INTO nofries.dashboard_representative_details
                (tenant_id, organisation_id, subject_key, receipt_id, payload, payload_sha256) VALUES ($1,$2,$3,$4,$5,$6)`,
            [link.tenantId, link.organisationId, link.subjectKey, link.receiptId, payload, hash(payload)]);
            const count = async table => (await pool.query(`SELECT 1 FROM nofries.${table} WHERE tenant_id=$1`, tenant)).rowCount;
            expect(await count('dashboard_deferred_agreements')).toBe(1);
            expect(await count('dashboard_representative_details')).toBe(1);
            await createAccountWipeRepository(pool).reset({
                accountId: f.account.accountId, subjectKey: f.preparation.subjectKey, tenantIds: tenant
            });
            expect(await count('dashboard_deferred_agreements')).toBe(0);
            expect(await count('dashboard_representative_details')).toBe(0);
            expect(await count('dashboard_starter_scopes')).toBe(1);
            httpJson(await h.ncscPost(createCommand()), 201);
            httpJson(await h.ncscPost(saveCommand()), 200);
            httpJson(await h.ncscPost(submitCommand()), 200);
            const session = await h.get('session').set('X-NoFries-Dashboard-Capabilities', 'work-queue-v1 account-label-v1 contact-request-v1 starter-details-v1 questionnaire-details-v1');
            expect(session.body.questionnaireExportGateAvailable).toBe(true);
            httpJson(await read(h), 403, 'representative_details_access_denied');
            httpJson(await save(h), 403, 'representative_details_access_denied');
            expect((await pool.query('SELECT 1 FROM nofries.dashboard_representative_details WHERE tenant_id=$1', tenant)).rowCount).toBe(0);
            await loginClean();
        });
        test('historical account is ready without creating any supplemental evidence', async () => {
            const h = await ncscHttpSetup({ customerProvider: true, customerAccountType: 'company', representativeDetailsEnabled: true, questionnaireExportGateEnabled: true });
            const session = await h.get('session').set('X-NoFries-Dashboard-Capabilities', 'work-queue-v1 account-label-v1 contact-request-v1 starter-details-v1 questionnaire-details-v1');
            expect(session.body.questionnaireExportGateAvailable).toBeUndefined();
            const result = await read(h); httpJson(result, 200); expect(result.body.status).toBe('ready');
            httpJson(await save(h), 409, 'representative_details_not_required');
            expect((await getOwnerPool().query('SELECT * FROM nofries.dashboard_representative_details')).rows).toEqual([]);
            await loginClean();
        });
        test('first result precedes capture; direct contact is gated; save/retry is immutable and audited in the same transaction', async () => {
            const { h, f, pool } = await enrolled();
            const capabilities = 'work-queue-v1 account-label-v1 contact-request-v1 starter-details-v1';
            const oldSession = await h.get('session').set('X-NoFries-Dashboard-Capabilities', capabilities);
            expect(oldSession.body.representativeDetailsAvailable).toBe(true);
            expect(oldSession.body.questionnaireExportGateAvailable).toBeUndefined();
            const newSession = await h.get('session').set('X-NoFries-Dashboard-Capabilities', capabilities + ' questionnaire-details-v1');
            expect(newSession.body.questionnaireExportGateAvailable).toBeUndefined();
            const original = JSON.stringify((await pool.query('SELECT payload FROM nofries.signup_acceptance_receipts')).rows);
            httpJson(await read(h), 200); expect((await read(h)).body.status).toBe('result_required');
            httpJson(await save(h), 409, 'representative_details_result_required');
            httpJson(await save(h, { ...DATA, tenantId: nextId() }), 400, 'dashboard_input_invalid');
            httpJson(await save(h, DATA, 'f'.repeat(64)), 403, 'representative_details_access_denied');
            const contact = () => h.post('contact-requests', { operationId: nextId(), topic: 'results', consentVersion: 'contact-request-v1' }).set(generationHeader, h.generation);
            httpJson(await contact(), 409, 'representative_details_required');
            httpJson(await h.ncscPost(createCommand()), 201);
            httpJson(await h.ncscPost(saveCommand()), 200);
            httpJson(await h.ncscPost(submitCommand()), 200);
            expect((await read(h)).body.status).toBe('details_required');
            const repeated = await Promise.all([save(h), save(h)]);
            for (const saved of repeated) { httpJson(saved, 200); expect(saved.body.status).toBe('ready'); }
            httpJson(await save(h), 200);
            httpJson(await save(h, { ...DATA, name: 'Changed' }), 409, 'representative_details_locked');
            const records = (await pool.query('SELECT payload, xmin::text AS tx FROM nofries.dashboard_representative_details')).rows;
            expect(records).toHaveLength(1); expect(records[0].payload.link.receiptId).toBe(f.receipt.receiptId);
            expect(records[0].payload.details).toEqual(DATA);
            const audits = (await pool.query("SELECT xmin::text AS tx FROM nofries.dashboard_runtime_audit WHERE payload->>'action'='representative.record'")).rows;
            expect(audits).toEqual([{ tx: records[0].tx }]);
            expect(JSON.stringify((await pool.query('SELECT payload FROM nofries.signup_acceptance_receipts')).rows)).toBe(original);
            httpJson(await contact(), 200);
            // Another selected organisation and generation cannot read or save this evidence.
            const other = await h.addBinding({ tenantId: nextId(), organisationId: nextId() });
            await h.select(other, h.generation);
            httpJson(await save(h), 403, 'representative_details_access_denied');
            const privileges = (await pool.query(`SELECT has_table_privilege('nofries_runtime','nofries.dashboard_representative_details','UPDATE,DELETE,TRUNCATE') AS mutable`)).rows[0];
            expect(privileges.mutable).toBe(false);
            await loginClean();
        });
    });
};
