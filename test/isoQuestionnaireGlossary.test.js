'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDashboardService } = require('../api/shared/dashboardService');
const { admissionFixture } = require('./fixtures/dashboardAdmissionFixture');
const { createDom } = require('./fixtures/dashboardDom');

const asset = name => fs.readFileSync(path.join(__dirname, '../api/shared/protectedAssets', name), 'utf8');
const extension = asset('isoQuestionnaireGlossary.js');
const publication = { framework: { id: 'iso-iec-27001', version: '2022' },
    profile: { id: 'nf-iso-27001-2022-readiness', version: '2026-11-19.1' } };
const anchors = {
    'C4.1-Q1': ['Information risk'], 'C4.3-Q1': ['Scope', 'ISMS'], 'C5.3-Q1': ['Risk owner'],
    'C6.1.2-Q1': ['Likelihood'], 'C6.1.3-Q1': ['Annex A', 'Risk treatment', 'Statement of Applicability'],
    'C9.2-Q1': ['Internal audit'], 'C9.3-Q1': ['Management review'], 'C10.2-Q1': ['Corrective action']
};

function questionHelp(p) {
    const shared = { mount: jest.fn() }, browser = { NoFriesPaidQuestionnaire: shared };
    vm.runInNewContext(extension, browser);
    const container = {}, options = { publication: p };
    browser.NoFriesPaidQuestionnaire.mount(container, options);
    expect(shared.mount).toHaveBeenCalledTimes(1);
    const [root, context, help] = shared.mount.mock.calls[0];
    expect(root).toBe(container);
    expect(context).toBe(options);
    return help;
}

test.each([
    { ...publication, framework: { ...publication.framework, id: 'nist-csf' } },
    { ...publication, framework: { ...publication.framework, version: 'other' } },
    { ...publication, profile: { ...publication.profile, id: 'nf-nist-csf-2-0-core' } },
    { ...publication, profile: { ...publication.profile, version: 'other' } }
])('another publication cannot attach ISO question help', p => {
    expect(questionHelp(p)).toBeUndefined();
});

test('the free dashboard and standalone NIST questionnaire carry no ISO definitions', async () => {
    const { adapters } = admissionFixture();
    const free = await createDashboardService(adapters).handleRequest({ method: 'GET' }, 'app.js');
    expect(free.status).toBe(200);
    const nist = asset('paidQuestionnaire.js');
    const help = questionHelp(publication);
    for (const [id, labels] of Object.entries({ ...anchors, 'C4.2-Q1': [], 'C8.3-Q1': [], 'A.5.1-Q1': [] })) {
        const { root } = createDom();
        help(root, id);
        expect(root.querySelectorAll('summary').map(summary => summary.textContent)).toEqual(labels.map(term => term + ' explained'));
        for (const details of root.querySelectorAll('details')) {
            const definition = details.querySelector('p').textContent;
            expect(definition.length).toBeGreaterThan(30);
            expect(free.body).not.toContain(definition);
            expect(nist).not.toContain(definition);
        }
    }
});
