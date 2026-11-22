'use strict';
const { deferredFixture, AT, DATA } = require('./fixtures/deferredDetailsFixture');
const { representativeDetails, requireRepresentativeDetails, normaliseRepresentativeDetails } = require('../api/shared/customerSignup/deferredRepresentativeDetails');
const { createStarterSetupDetails } = require('../api/shared/customerSignup/starterSetupDetails');
const { hash } = require('../api/shared/appLifecycle/dashboardRuntimeRecords');

async function fixture(enabled = true) {
    const f = await deferredFixture({ enabled });
    let row = null, submitted = false, lose = false, corrupt = false;
    const audit = { createEvent: jest.fn((c, action) => action), writeEvent: jest.fn(async () => {}) };
    const tx = { async query(sql, args) {
        if (sql.includes('FROM nofries.dashboard_starter_scopes')) return { rows: [{ preparation: f.preparation, activation: f.activation }] };
        if (sql.includes('FROM nofries.signup_acceptance_receipts')) return { rows: [{ payload: { receipt: corrupt ? { ...f.receipt, scheduleDigest: '0'.repeat(64) } : f.receipt } }] };
        if (sql.includes('SELECT payload, payload_sha256')) return { rows: row ? [row] : [] };
        if (sql.includes('SELECT EXISTS')) return { rows: [{ found: submitted }] };
        if (sql.includes('INSERT INTO nofries.dashboard_representative_details')) {
            if (row) return { rowCount: 0 };
            row = { payload: JSON.parse(args[4]), payload_sha256: args[5] }; return { rowCount: 1 };
        }
        throw new Error('Unexpected synthetic query: ' + sql);
    } };
    const deps = { context: f.context, clock: () => AT, audit, database: { async withTenantTransaction(tenant, work) {
        expect(tenant).toBe(f.context.scope.tenantId); const value = await work(tx);
        if (lose) { lose = false; throw new Error('Synthetic lost COMMIT response'); } return value;
    } } };
    return { ...f, deps, tx, row: () => row, submit: () => { submitted = true; }, lose: () => { lose = true; }, corrupt: () => { corrupt = true; } };
}
test('flag off retains full offer bytes and requires the historical input', async () => {
    const f = await fixture(false), original = JSON.stringify(f.saved);
    expect(f.saved.offer.schedule.scheduleText).toContain('Principal address: "' + DATA.address + '"');
    await expect(f.setup.save(f.proof, { authorityConfirmed: true })).rejects.toThrow();
    expect(JSON.stringify(await f.setup.save(f.proof, f.body))).toBe(original);
    await expect(representativeDetails(f.deps)).resolves.toEqual({ schemaVersion: 1, status: 'ready' });
    expect(f.row()).toBeNull();
});
test('new minimal offer binds authority and terms; repeats and enrollment rollback keep the same record', async () => {
    const f = await fixture(), bytes = JSON.stringify(f.saved);
    expect(f.saved.offerInput.contact).toEqual({ email: f.proof.email, authorityEvidenceId: f.saved.representativeEvidenceId });
    expect(f.saved.offer.schedule.scheduleText).not.toMatch(/Principal address|Representative:|Registration identifier/);
    expect(f.receipt.scheduleDigest).toBe(f.saved.offer.schedule.scheduleDigest);
    const resumed = createStarterSetupDetails({ ...f.options, deferDetails: false });
    expect(JSON.stringify(await resumed.save(f.proof, f.body))).toBe(bytes);
    await expect(resumed.save(f.proof, { ...f.body, name: DATA.name })).rejects.toThrow();
    expect(f.rows.size).toBe(1);
});
test('capture is after a submitted result; gate fails closed and reads never write', async () => {
    const f = await fixture();
    await expect(representativeDetails(f.deps)).resolves.toMatchObject({ status: 'result_required' });
    await expect(representativeDetails(f.deps, DATA)).rejects.toMatchObject({ code: 'representative_details_result_required' });
    await expect(requireRepresentativeDetails(f.tx, f.context)).rejects.toMatchObject({ code: 'representative_details_required' });
    f.submit();
    await expect(representativeDetails(f.deps)).resolves.toMatchObject({ status: 'details_required' });
    expect(f.row()).toBeNull(); expect(f.deps.audit.writeEvent).not.toHaveBeenCalled();
});
test('lost response and concurrent repeated saves retain one linked record and one audit, leaving agreement bytes intact', async () => {
    const f = await fixture(), before = JSON.stringify([f.saved, f.preparation, f.receipt, f.activation]); f.submit(); f.lose();
    await expect(representativeDetails(f.deps, DATA)).rejects.toThrow('lost COMMIT');
    const retained = JSON.stringify(f.row());
    await Promise.all(Array.from({ length: 5 }, () => representativeDetails(f.deps, DATA)));
    expect(JSON.stringify(f.row())).toBe(retained);
    expect(f.row().payload.link.acceptanceSha256).toBe(hash(f.receipt));
    expect(f.row().payload.link.scheduleDigest).toBe(f.receipt.scheduleDigest);
    expect(f.deps.audit.writeEvent).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([f.saved, f.preparation, f.receipt, f.activation])).toBe(before);
    await expect(requireRepresentativeDetails(f.tx, f.context)).resolves.toBeUndefined();
    await expect(representativeDetails(f.deps, { ...DATA, role: 'Changed' })).rejects.toMatchObject({ code: 'representative_details_locked' });
});
test('forged receipt or changed evidence fails closed', async () => {
    const f = await fixture(); f.submit(); await representativeDetails(f.deps, DATA);
    f.row().payload.details.role = 'Tampered';
    await expect(requireRepresentativeDetails(f.tx, f.context)).rejects.toThrow();
    f.corrupt(); await expect(representativeDetails(f.deps)).rejects.toThrow();
});
test('an RLS-hidden deferred agreement never takes the historical-account bypass', async () => {
    const f = await fixture();
    const tx = { async query(sql) {
        if (sql.includes('dashboard_starter_scopes')) return { rows: [] };
        if (sql.includes('dashboard_deferred_agreements')) return { rows: [{ organisation_id: f.context.scope.organisationId }] };
        if (sql.includes('JOIN nofries.signup_acceptance_receipts')) return { rows: [] };
        throw new Error('Unexpected query');
    } };
    await expect(requireRepresentativeDetails(tx, f.context)).rejects.toMatchObject({ code: 'representative_details_required' });
});
test('hidden starter scope: verified completion unlocks only readiness, never a write', async () => {
    const f = await fixture(); f.submit(); await representativeDetails(f.deps, DATA);
    const tx = { async query(sql, args) {
        expect(args).toEqual([f.context.scope.tenantId, f.context.scope.organisationId]);
        if (sql.includes('dashboard_starter_scopes')) return { rows: [] };
        if (sql.includes('dashboard_deferred_agreements')) return { rows: [f.context.scope] };
        if (sql.includes('JOIN nofries.signup_acceptance_receipts')) return { rows: [{ ...f.row(), receipt: f.receipt }] };
        throw new Error('Unexpected query');
    } };
    const deps = { ...f.deps, database: { withTenantTransaction: (_, cb) => cb(tx) } };
    await expect(representativeDetails(deps)).resolves.toEqual({ schemaVersion: 1, status: 'ready' });
    await expect(requireRepresentativeDetails(tx, f.context)).resolves.toBeUndefined();
    await expect(representativeDetails(deps, DATA)).rejects.toMatchObject({ code: 'representative_details_access_denied' });
    f.row().payload.details.role = 'Corrupt';
    await expect(requireRepresentativeDetails(tx, f.context)).rejects.toThrow();
});
test.each([{ ...DATA, tenantId: 'foreign' }, { ...DATA, address: '' }, { ...DATA, name: '<script>' }, { ...DATA, role: 'a'.repeat(121) }])('rejects scope injection and invalid details', data => {
    expect(() => normaliseRepresentativeDetails(data)).toThrow();
});
