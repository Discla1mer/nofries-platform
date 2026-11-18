'use strict';

// Native HTTP checks of POST /api/dashboard/contact-requests (#409 stage 1b),
// registered by the existing disposable PostgreSQL dashboard suite. Synthetic
// sessions and organisations only; the route runs as the restricted runtime role.
const crypto = require('node:crypto');

module.exports = function registerContactRequestHttpPostgres({ ncscHttpSetup, httpJson, getOwnerPool, loginClean, subject, nextId, generationHeader }) {
    const body = (overrides = {}) => ({ operationId: nextId(), topic: 'results', consentVersion: 'contact-request-v1', ...overrides });
    const ask = (h, value, generation = h.generation) => h.post('contact-requests', value).set(generationHeader, generation);
    async function stored(h) {
        return (await getOwnerPool().query(`SELECT tenant_id, organisation_id, request_id::text, subject_key, topic, consent_version,
            requested_day::text AS day, (requested_at AT TIME ZONE 'Pacific/Auckland')::date::text AS nz_day, xmin::text AS tx
            FROM nofries.dashboard_contact_requests WHERE tenant_id = $1 ORDER BY requested_at, request_id`, [h.binding.scope.tenantId])).rows;
    }
    async function audits(h) {
        return (await getOwnerPool().query(`SELECT payload, xmin::text AS tx FROM nofries.dashboard_runtime_audit
            WHERE tenant_id = $1 AND payload->>'action' = 'contact.request' ORDER BY occurred_at, event_id`, [h.binding.scope.tenantId])).rows;
    }

    describe('HTTP contact requests with restricted real PostgreSQL', () => {
        test('the route is absent by default and nothing is written', async () => {
            const h = await ncscHttpSetup({ customerProvider: true });
            httpJson(await ask(h, body()), 404, 'dashboard_not_found');
            expect(await stored(h)).toEqual([]);
            await loginClean();
        });

        test('a customer asks once per topic and day; a retry is the same request and each success is audited with its row', async () => {
            const h = await ncscHttpSetup({ customerProvider: true, contactRequestsEnabled: true });
            const first = body();
            const created = await ask(h, first); httpJson(created, 200);
            expect(created.body).toEqual({ schemaVersion: 1, status: 'requested' });
            const [row] = await stored(h);
            expect(row).toMatchObject({ tenant_id: h.binding.scope.tenantId, organisation_id: h.binding.scope.organisationId, request_id: first.operationId, subject_key: subject(h.principal),
                topic: 'results', consent_version: 'contact-request-v1' });
            // The day is the Pacific/Auckland date of the stored time, never a caller value.
            expect(row.day).toBe(row.nz_day);
            const [audit] = await audits(h);
            expect(audit.tx).toBe(row.tx);
            expect(audit.payload).toMatchObject({ action: 'contact.request', module: 'overview', result: 'succeeded',
                actorSubjectKey: subject(h.principal), ...h.binding.scope });

            const retried = await ask(h, first); httpJson(retried, 200);
            expect(retried.body).toEqual({ schemaVersion: 1, status: 'requested' });
            const again = await ask(h, body()); httpJson(again, 200);
            expect(again.body).toEqual({ schemaVersion: 1, status: 'already_requested' });
            const other = await ask(h, body({ topic: 'managed_it_core' })); httpJson(other, 200);
            expect(other.body).toEqual({ schemaVersion: 1, status: 'requested' });
            expect((await stored(h)).map(item => item.topic)).toEqual(['results', 'managed_it_core']);
            expect(await audits(h)).toHaveLength(4);

            // The same operation id with different content is a conflict and writes nothing.
            httpJson(await ask(h, { ...first, topic: 'monthly_proof' }), 409, 'contact_request_operation_conflict');
            expect(await stored(h)).toHaveLength(2);
            await loginClean();
        });

        test('another tenant neither sees nor collides with these requests, and a viewer may ask', async () => {
            const a = await ncscHttpSetup({ customerProvider: true, contactRequestsEnabled: true });
            const shared = body();
            httpJson(await ask(a, shared), 200);
            await loginClean();
            const b = await ncscHttpSetup({ customerProvider: true, contactRequestsEnabled: true, role: 'viewer',
                scope: { tenantId: crypto.randomUUID(), organisationId: crypto.randomUUID() } });
            expect(b.binding.scope.tenantId).not.toBe(a.binding.scope.tenantId);
            // Same operation id, other tenant: a new request, not the first tenant's row.
            const created = await ask(b, shared); httpJson(created, 200);
            expect(created.body.status).toBe('requested');
            expect((await stored(b)).map(item => item.organisation_id)).toEqual([b.binding.scope.organisationId]);
            expect((await stored(a)).map(item => item.organisation_id)).toEqual([a.binding.scope.organisationId]);
            await loginClean();
        });

        test('staff sessions, stale generations, foreign origins and invalid input are refused without a row', async () => {
            const operator = await ncscHttpSetup({ contactRequestsEnabled: true });
            httpJson(await ask(operator, body()), 403, 'dashboard_access_denied');
            expect(await stored(operator)).toEqual([]);
            await loginClean();
            const h = await ncscHttpSetup({ customerProvider: true, contactRequestsEnabled: true });
            httpJson(await ask(h, body(), 'a'.repeat(64)), 403, 'contact_request_access_denied');
            httpJson(await ask(h, body()).set('Origin', 'https://foreign.invalid'), 403, 'dashboard_access_denied');
            for (const value of [body({ topic: 'everything' }), body({ consentVersion: 'contact-request-v0' }),
                body({ operationId: 'not-a-uuid' }), { ...body(), tenantId: h.binding.scope.tenantId }]) {
                httpJson(await ask(h, value), 400, 'dashboard_input_invalid');
            }
            expect(await stored(h)).toEqual([]);
            await loginClean();
        });
    });
};
