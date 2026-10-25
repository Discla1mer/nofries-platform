const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-bundle-test-'));
process.env.NOFRIES_DATA_DIR = dataDir;
process.env.NOFRIES_REQUIRE_AUTH = 'false';
process.env.NOFRIES_DEV_EMAIL = 'admin@example.com';
process.env.NOFRIES_ADMIN_EMAILS = 'admin@example.com';
process.env.NOFRIES_SCOPE_STORAGE_PROVIDER = 'memory';
delete process.env.NOFRIES_DYNAMICS_FLOW_URL;
delete process.env.NOFRIES_DYNAMICS_WRITE_ENABLED;

const app = require('../server');

function answer(value) {
    return {
        value,
        notes: '',
        evidence: '',
        importance: 'medium',
        confidence: 'high',
        internalNotes: ''
    };
}

describe('bundled service-plan API', () => {
    afterAll(() => {
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    test('saves all component decisions atomically before creating one proposal item', async () => {
        const bootstrap = (await request(app).get('/api/sales/bootstrap')).body;
        const customerResponse = await request(app)
            .post('/api/sales/customers')
            .send({
                expectedRevision: bootstrap.revision,
                name: 'Bundle Test Limited'
            });
        const customer = customerResponse.body.customer;
        const assessmentResponse = await request(app)
            .post('/api/sales/assessments')
            .send({
                expectedRevision: customerResponse.body.revision,
                customerId: customer.id,
                title: 'Bundled service review'
            });
        const assessmentId = assessmentResponse.body.assessment.id;
        const saved = await request(app)
            .put(`/api/sales/assessments/${assessmentId}/answers`)
            .send({
                expectedRevision: assessmentResponse.body.revision,
                status: 'completed',
                answers: {
                    'business.priorities': answer(['reliable_support', 'security', 'resilience']),
                    'business.concerns': answer(['slow_support', 'cyber_risk', 'backup_risk']),
                    'estate.users': answer('under_10'),
                    'estate.endpoints': answer('under_10'),
                    'estate.locations': answer('one'),
                    'productivity.platform': answer('google_workspace'),
                    'support.frustrations': answer(['slow_response', 'recurring', 'visibility']),
                    'support.hours': answer('business_hours'),
                    'support.delivery': answer('remote_first'),
                    'security.monitoring': answer('business_hours'),
                    'security.endpoint': answer('partial'),
                    'resilience.backups': answer('absent'),
                    'operations.suppliers': answer('three_plus'),
                    'operations.ownership': answer('fragmented'),
                    'priorities.procurement': answer('active'),
                    'priorities.next_step': answer('proposal')
                }
            });
        const matched = await request(app)
            .post(`/api/sales/assessments/${assessmentId}/match`)
            .send({ expectedRevision: saved.body.revision });
        expect(matched.status).toBe(200);

        const detail = await request(app).get(`/api/sales/assessments/${assessmentId}`);
        expect(detail.status).toBe(200);
        expect(detail.body.servicePlan).toMatchObject({
            available: true,
            model: 'bundled_managed_it'
        });
        expect(detail.body.servicePlan.pricing.status).toBe('needs_more_info');

        const components = detail.body.servicePlan.components.map((component) => ({
            serviceKey: component.serviceKey,
            status: component.status
        }));
        const reviewed = await request(app)
            .post(`/api/sales/assessments/${assessmentId}/service-plan`)
            .send({
                expectedRevision: detail.body.revision,
                counts: { users: 2, endpoints: 2, locations: 1 },
                components,
                owner: 'Joel Harvey',
                consultantRationale: 'A single managed service fits the stated need.',
                nextAction: 'Review the draft proposal.'
            });
        expect(reviewed.status).toBe(200);
        expect(reviewed.body.servicePlan).toMatchObject({
            status: 'reviewed',
            pricing: { monthly: 238, onboarding: 750 }
        });

        const proposalResponse = await request(app)
            .post(`/api/sales/assessments/${assessmentId}/proposal`)
            .send({ expectedRevision: reviewed.body.revision });
        expect(proposalResponse.status).toBe(201);
        expect(proposalResponse.body.proposal).toMatchObject({
            commercialModel: 'bundled_managed_it',
            pricing: { monthly: 238, onboarding: 750 }
        });
        expect(proposalResponse.body.proposal.recommendations).toHaveLength(1);

        const exported = await request(app)
            .get(`/api/sales/proposals/${proposalResponse.body.proposal.id}/export?format=html`);
        expect(exported.status).toBe(200);
        expect(exported.text).toContain('NZ$238 + GST per month');
        expect(exported.text).toContain('NZ$750 + GST initial set-up');
        expect(exported.text).toContain('Included components');

        const preview = await request(app)
            .post('/api/sales/integrations/dynamics/preview')
            .send({ proposalId: proposalResponse.body.proposal.id });
        expect(preview.status).toBe(200);
        expect(preview.body.payload.opportunities).toHaveLength(1);
        expect(preview.body.payload.opportunities[0]).toMatchObject({
            serviceKey: 'managed-it-core',
            estimatedMonthlyRevenue: 238,
            estimatedOneOffRevenue: 750
        });
    });
});
