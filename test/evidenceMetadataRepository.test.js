'use strict';
// Controlled adapters establish disclosure ordering; real PostgreSQL tests establish locking/RLS.
jest.mock('../api/shared/appLifecycle/postgresDashboardBootstrap', () => {
    const actual = jest.requireActual('../api/shared/appLifecycle/postgresDashboardBootstrap');
    return { ...actual, dataStorage: { ...actual.dataStorage, loadSnapshotForUpdate: jest.fn() } };
});
jest.mock('../api/shared/evidenceLifecycle/postgresEvidenceStore', () => ({ createPostgresEvidenceStore: jest.fn() }));
const { dataStorage } = require('../api/shared/appLifecycle/postgresDashboardBootstrap');
const { createPostgresEvidenceStore } = require('../api/shared/evidenceLifecycle/postgresEvidenceStore');
const { createPostgresEvidenceMetadataRepository } = require('../api/shared/appLifecycle/postgresEvidenceMetadataRepository');
const { resolveEvidenceAccess } = require('../api/shared/appLifecycle/dashboardResourceAuthority');
const { createDashboardAudit } = require('../api/shared/appLifecycle/dashboardAudit');
const { createContext, createClock } = require('./fixtures/ncscAssessmentFixture');
const { evidenceFixture, clone, NOW } = require('./fixtures/evidenceMetadataFixture');
const crypto = require('node:crypto');
async function harness(options = {}) {
    const f = evidenceFixture(options), clock = createClock(NOW), context = await createContext(f.scope, clock);
    const trace = [], tx = { query: jest.fn() }, h = { ...f, state: clone(f.state), clock, context, trace, tx, afterRead: null, afterAudit: null };
    h.read = jest.fn(async () => { trace.push('read'); if (h.afterRead) h.afterRead(); return h.evidence; });
    createPostgresEvidenceStore.mockImplementation(({ database }) => ({ read: selector => database.withTenantTransaction(selector.tenantId, inner => {
        expect(inner).toBe(tx); return h.read(selector);
    }) }));
    dataStorage.loadSnapshotForUpdate.mockImplementation(async actualTx => { expect(actualTx).toBe(tx); trace.push('authority'); return h.state; });
    h.database = { withTenantTransaction: jest.fn(async (tenantId, work) => {
        expect(tenantId).toBe(f.scope.tenantId); trace.push('begin'); const result = await work(tx); trace.push('commit'); return result;
    }) };
    h.audit = createDashboardAudit({ clock: clock.now, createEventId: crypto.randomUUID, writeEvent: async event => {
        expect(trace).not.toContain('commit'); expect(event).toMatchObject({ action: 'evidence.read', module: 'evidence', result: 'succeeded', ...f.scope });
        trace.push('audit'); if (h.afterAudit) h.afterAudit();
    } });
    h.repository = createPostgresEvidenceMetadataRepository({ database: h.database, clock: clock.now, audit: h.audit });
    h.execute = () => h.repository.readEvidenceMetadata(context, { artefactId: f.command.artefactId });
    return h;
}
afterEach(() => jest.clearAllMocks());
test('authority, metadata and closed audit complete under one transaction before disclosure', async () => {
    const h = await harness(), result = await h.execute();
    expect(result.evidence.artefactId).toBe(h.command.artefactId);
    expect(h.trace).toEqual(['begin', 'authority', 'read', 'audit', 'commit']);
    expect(h.database.withTenantTransaction).toHaveBeenCalledTimes(1);
    expect(h.read).toHaveBeenCalledWith({ ...h.scope, artefactId: h.command.artefactId });
    expect(Object.keys(h.repository)).toEqual(['readEvidenceMetadata']);
});
test.each(['viewer', 'membership', 'product', 'module', 'flag', 'tenant', 'organisation', 'wrong-scope'])
('current %s denial prevents evidence lookup and audit', async kind => {
    const h = await harness(kind === 'viewer' ? { role: 'viewer' } : {});
    if (kind === 'membership') h.state.membershipState.memberships[0].status = 'suspended';
    if (kind === 'product') h.state.entitlementState.grants = [];
    if (kind === 'module') h.state.entitlementState.grants[0].modules = ['overview'];
    if (kind === 'flag') h.state.flags.enabled.evidence = false;
    if (kind === 'tenant') h.state.tenantAggregate.tenant.recordStatus = 'suspended';
    if (kind === 'organisation') h.state.tenantAggregate.organisations[0].recordStatus = 'suspended';
    if (kind === 'wrong-scope') h.state.membershipState.organisationId = 'other';
    await expect(h.execute()).rejects.toMatchObject({ code: 'evidence_access_denied', statusCode: 403 });
    expect(h.read).not.toHaveBeenCalled(); expect(h.trace).not.toContain('audit');
});
test.each(['missing', 'wrong-module', 'expired', 'ambiguous', 'service-disabled'])
('advisor %s scope denies while matching active assignment permits', async kind => {
    const h = await harness({ role: 'fractional_advisor', service: 'fractional_advisory' });
    expect(() => resolveEvidenceAccess(h.state, h.context, NOW)).not.toThrow();
    if (kind === 'missing') h.state.advisorAssignments = [];
    if (kind === 'wrong-module') h.state.advisorAssignments[0].modules = ['cyber_security'];
    if (kind === 'expired') h.state.advisorAssignments[0].validUntil = NOW;
    if (kind === 'ambiguous') h.state.advisorAssignments.push({ ...clone(h.state.advisorAssignments[0]), assignmentId: 'duplicate' });
    if (kind === 'service-disabled') h.state.flags.enabled['service:fractional_advisory'] = false;
    await expect(h.execute()).rejects.toMatchObject({ code: 'evidence_access_denied' }); expect(h.read).not.toHaveBeenCalled();
});
test.each(['read', 'audit'])('authority expiry after %s withholds metadata and prevents commit', async phase => {
    const h = await harness(), expire = () => h.clock.set(h.state.membershipState.memberships[0].validUntil);
    h[phase === 'read' ? 'afterRead' : 'afterAudit'] = expire;
    await expect(h.execute()).rejects.toMatchObject({ code: 'evidence_access_denied' }); expect(h.trace).not.toContain('commit');
});
test('an audit failure withholds a successful metadata lookup', async () => {
    const h = await harness(); h.afterAudit = () => { throw new Error('driver-private secret'); };
    await expect(h.execute()).rejects.toMatchObject({ code: 'evidence_unavailable', statusCode: 503 });
    expect(h.trace).not.toContain('commit');
});
test('only an authorised missing artefact returns not found', async () => {
    const h = await harness(); h.evidence = null;
    await expect(h.execute()).rejects.toMatchObject({ code: 'evidence_not_found', statusCode: 404 });
});
test('forged branded context and scope injection fail before opening a transaction', async () => {
    const h = await harness();
    await expect(h.repository.readEvidenceMetadata(clone(h.context), { artefactId: 'x' })).rejects.toMatchObject({ code: 'evidence_access_denied' });
    await expect(h.repository.readEvidenceMetadata(h.context, { artefactId: 'x', tenantId: 'other' })).rejects.toMatchObject({ code: 'evidence_input_invalid' });
    expect(h.database.withTenantTransaction).not.toHaveBeenCalled();
});
