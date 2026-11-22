'use strict';

const crypto = require('node:crypto');
const { hash } = require('../../api/shared/appLifecycle/dashboardRuntimeRecords');
const profileRef = {
    frameworkId: 'iso-iec-27001', frameworkVersion: '2022',
    profileId: 'nf-iso-27001-2022-readiness', profileVersion: '2026-11-19.1',
    catalogueSha256: '1971ad65405f1c20d8e13a65a26a7b40e9ff48b63505db4f0336d32d64fae73d',
    sourceCatalogueSha256: '66ce68bdf0d8ea2d271c52f68d6505b7a50f69f8d8d5ce40bcf833320caef1fd'
};
const board = 'iso_board_summary', statement = 'iso_statement_of_applicability';
const boardId = crypto.randomUUID(), statementId = crypto.randomUUID();
const at = '2026-11-19T09:00:00Z', later = '2026-11-19T10:00:00Z', earlier = '2026-11-19T08:00:00Z';
const sha = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const actor = () => crypto.randomUUID() + ':' + crypto.randomUUID();
const maker = actor(), checker = actor(), issuer = actor();
const artifactTable = 'dashboard_iso_report_artifacts', decisionTable = 'dashboard_iso_report_decisions';
const artifactColumns = ['tenant_id','organisation_id','report_id','profile_id','profile_version','assessment_id','revision',
    'source_record_sha256','response_set_sha256','output_kind','content','output_sha256','maker_subject','maker_email_sha256','prepared_at'];
const decisionColumns = ['tenant_id','organisation_id','report_id','output_sha256','stage','actor_subject','actor_email_sha256','decided_at'];

function insert(db, table, columns, row) {
    return db.query('INSERT INTO nofries.' + table + ' (' + columns.join(',') + ') VALUES (' +
        columns.map((_, i) => '$' + (i + 1)).join(',') + ')', columns.map(k => row[k]));
}
function artifact(source, kind) {
    const content = JSON.stringify({ formatVersion: 1, outputKind: kind, blocks: [['p', 'Synthetic café — ' + kind]] });
    return { ...source, report_id: kind === board ? boardId : statementId, output_kind: kind, content,
        output_sha256: sha(content), maker_subject: maker, maker_email_sha256: sha('maker@example.test'), prepared_at: at };
}
function decision(row, stage) {
    return { ...row, stage, actor_subject: stage === 'approved' ? checker : issuer,
        actor_email_sha256: sha(stage + '@example.test'), decided_at: later };
}
const addArtifact = (db, row) => insert(db, artifactTable, artifactColumns, row);
const addDecision = (db, row) => insert(db, decisionTable, decisionColumns, row);

module.exports = function registerIsoReportTests({ connect, account, wipeTarget, footprint, tx, asRuntime, repository }) {
    async function source(db, a, { revision = 2, status = 'submitted', ref = profileRef } = {}) {
        const tenantId = a.tenants[0];
        const { organisation_id: organisationId } = (await db.query(
            'SELECT organisation_id FROM nofries.dashboard_starter_scopes WHERE tenant_id=$1', [tenantId])).rows[0];
        const scope = { tenantId, organisationId }, assessmentId = 'iso-assessment';
        const responseSetSha256 = hash({ tenantId, assessmentId, revision });
        const state = { ...scope, moduleId: 'cyber_security', assessmentId, revision, profileRef: ref,
            updatedBy: a.c.actor, status, submission: status === 'submitted' ? { submittedAt: at, revision, responseSetSha256 } : null };
        const record = { state }, recordDigest = hash(record);
        await tx(db, () => asRuntime(db, a.c.actor, scope, () => db.query(`INSERT INTO nofries.dashboard_framework_revisions
            (tenant_id,organisation_id,profile_id,profile_version,assessment_id,revision,idempotency_key,intent_sha256,record_sha256,record)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [tenantId, organisationId, ref.profileId, ref.profileVersion,
            assessmentId, revision, 'fixture-' + revision, hash({revision}), recordDigest, record])));
        return { tenant_id: tenantId, organisation_id: organisationId, profile_id: ref.profileId, profile_version: ref.profileVersion,
            assessment_id: assessmentId, revision, response_set_sha256: responseSetSha256, source_record_sha256: recordDigest };
    }
    async function issued(db, a) {
        const sealed = await source(db, a);
        for (const kind of [board, statement]) {
            const row = artifact(sealed, kind);
            await addArtifact(db, row);
            await addDecision(db, decision(row, 'approved'));
            await addDecision(db, decision(row, 'issued'));
        }
    }
    async function retained(db, a) {
        const result = {};
        for (const table of [artifactTable, decisionTable, 'dashboard_framework_revisions', 'signup_acceptance_receipts', 'dashboard_starter_scopes']) {
            result[table] = (await db.query(`SELECT * FROM nofries.${table} WHERE tenant_id=ANY($1::text[]) ORDER BY to_jsonb(${table})::text`, [a.tenants])).rows;
        }
        return result;
    }

    test.each(['reset','delete'])('0031 staff %s erases both outputs and decisions and preserves the other tenant', async mode => {
        const db = await connect(), target = await account(db), other = await account(db);
        await issued(db, target); await issued(db, other);
        const before = await retained(db, target), sentinel = await retained(db, other);
        expect(before[artifactTable]).toHaveLength(2); expect(before[decisionTable]).toHaveLength(4);
        expect(before.signup_acceptance_receipts.length).toBeGreaterThan(0);
        const outcome = await repository()[mode](wipeTarget(target));
        expect(outcome.counts[artifactTable]).toBe(2); expect(outcome.counts[decisionTable]).toBe(4);
        const after = await retained(db, target);
        for (const table of [artifactTable, decisionTable, 'dashboard_framework_revisions']) expect(after[table]).toEqual([]);
        for (const table of ['signup_acceptance_receipts','dashboard_starter_scopes'])
            expect(after[table]).toEqual(mode === 'reset' ? before[table] : []);
        if (mode === 'delete') expect(Object.values(await footprint(db, target)).every(count => count === 0)).toBe(true);
        expect(await retained(db, other)).toEqual(sentinel);
    });

    test('0031 requires a matching sealed source and the exact reviewed UTF-8 bytes', async () => {
        const db = await connect(), a = await account(db), sealed = await source(db, a);
        const row = artifact(sealed, board);
        const draft = await source(db, a, { revision: 1, status: 'in-progress' });
        const otherPin = await source(db, a, { revision: 3, ref: { ...profileRef, catalogueSha256: sha('different') } });
        for (const changes of [draft, otherPin, { revision: 4 }, { tenant_id: a.tenants[1] }, { organisation_id: 'elsewhere' },
            { source_record_sha256: sha('other record') }, { response_set_sha256: sha('other responses') },
            { output_kind: statement }, { content: row.content + ' ' }, { prepared_at: earlier }]) {
            await expect(addArtifact(db, { ...row, ...changes })).rejects.toMatchObject({ code: '23514' });
        }
        await addArtifact(db, row);
        await expect(db.query('UPDATE nofries.dashboard_iso_report_artifacts SET content=content WHERE tenant_id=$1 AND report_id=$2', [row.tenant_id, row.report_id]))
            .rejects.toMatchObject({ code: '23514' });
        await expect(db.query('DELETE FROM nofries.dashboard_framework_revisions WHERE tenant_id=$1 AND revision=2', [sealed.tenant_id]))
            .rejects.toMatchObject({ code: '23503' });
    });

    test('0031 links each decision to the approved artifact, independent actors and ordered evidence', async () => {
        const db = await connect(), a = await account(db), row = artifact(await source(db, a), board);
        await addArtifact(db, row);
        const approve = decision(row, 'approved'), issue = decision(row, 'issued');
        await expect(addDecision(db, issue)).rejects.toMatchObject({ code: '23514' });
        for (const changes of [{ actor_subject: maker }, { actor_email_sha256: row.maker_email_sha256 },
            { output_sha256: sha('other content') }, { decided_at: earlier }]) {
            await expect(addDecision(db, { ...approve, ...changes })).rejects.toMatchObject({ code: '23514' });
        }
        await addDecision(db, approve);
        for (const changes of [{ actor_subject: checker }, { actor_subject: maker }, { actor_email_sha256: approve.actor_email_sha256 },
            { actor_email_sha256: row.maker_email_sha256 }, { decided_at: at }, { report_id: statementId }]) {
            await expect(addDecision(db, { ...issue, ...changes })).rejects.toMatchObject({ code: '23514' });
        }
        await addDecision(db, issue);
        await expect(addDecision(db, issue)).rejects.toMatchObject({ code: '23505' });
        await expect(db.query("UPDATE nofries.dashboard_iso_report_decisions SET stage=stage WHERE tenant_id=$1 AND report_id=$2", [row.tenant_id, row.report_id]))
            .rejects.toMatchObject({ code: '23514' });
        await expect(db.query("DELETE FROM nofries.dashboard_iso_report_decisions WHERE tenant_id=$1 AND report_id=$2 AND stage='approved'", [row.tenant_id, row.report_id]))
            .rejects.toMatchObject({ code: '23503' });
    });

    test('0031 grants only scoped erasure and no read or issuance capability to dashboard runtime', async () => {
        const db = await connect(), a = await account(db), other = await account(db);
        await issued(db, a); await issued(db, other);
        for (const table of [artifactTable, decisionTable]) {
            const relation = 'nofries.' + table;
            const { rows: [security] } = await db.query(`SELECT c.relrowsecurity AND c.relforcerowsecurity AS forced,
                has_any_column_privilege('nofries_runtime',c.oid,'SELECT,INSERT,UPDATE,REFERENCES') OR
                has_table_privilege('nofries_runtime',c.oid,'DELETE,TRUNCATE,TRIGGER') AS runtime,
                has_table_privilege('nofries_account_wipe',c.oid,'DELETE') AS erase,
                ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped
                    AND has_column_privilege('nofries_account_wipe', c.oid, attnum, 'SELECT')) AS readable
                FROM pg_class c WHERE c.oid=$1::regclass`, [relation]);
            expect(security).toEqual({ forced: true, runtime: false, erase: true, readable: ['tenant_id'] });
            await tx(db, async () => {
                await db.query('SET LOCAL ROLE nofries_account_wipe');
                expect((await db.query('SELECT tenant_id FROM ' + relation)).rowCount).toBe(0);
                await db.query("SELECT set_config('nofries.wipe_tenant_id',$1,true)", [a.tenants[0]]);
                const visible = await db.query('SELECT DISTINCT tenant_id FROM ' + relation);
                expect(visible.rows).toEqual([{ tenant_id: a.tenants[0] }]);
                expect((await db.query('DELETE FROM ' + relation + ' WHERE tenant_id=$1', [other.tenants[0]])).rowCount).toBe(0);
            });
        }
    });
};
