'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createDom } = require('./fixtures/dashboardDom');
const { createNcscQuestionnaireMetadata } = require('../api/shared/ncscQuestionnaireMetadata');
const { mount } = require('../api/shared/protectedAssets/ncscQuestionnaire');
const ROOT = path.resolve(__dirname, '..');
const FILES = [
    ['pptx', 'b898aff39ffd1d84992ec37868bc5ae2791eddf43b0c371e3acd05d9cafc2b5e'],
    ['pdf', '661738120bf79bc118b90a27550a6ac2d2c7f3167b9cd4880dd60cb56358a109']
];
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(list) {
    const dom = createDom();
    const client = Object.fromEntries(['read', 'create', 'save', 'submit', 'normaliseCommand', 'commandByteLength']
        .map(name => [name, jest.fn()]));
    client.list = jest.fn(list || (async () => ({ schemaVersion: 1, assessments: [], nextAfterAssessmentId: null })));
    const controller = mount(dom.root, { metadata: createNcscQuestionnaireMetadata(), client,
        presentationMode: 'editable', window: dom.window });
    return { ...dom, client, controller };
}

test('workshop links identify the fixed formats and provenance without assessment mutations or extra reads', async () => {
    const ui = setup();
    try {
        await tick();
        const section = ui.root.querySelector('.ncsc-workshop');
        expect(section.getAttribute('aria-labelledby')).toBe('ncsc-workshop-title');
        expect(section.textContent).toContain('Download workshop slides');
        expect(section.textContent).toContain('Version 2 · Prepared 20 October 2026 (NZDT).');
        expect(section.textContent).toContain('Source: No Fries questionnaire adapted from the NCSC Cyber Security Framework and Minimum Cyber Security Standards 2025, with selected NZISM v3.9 references.');
        expect(section.textContent).toContain('Optional NZISM references are No Fries interpretations of NZISM v3.9 (November 2025), © Crown copyright, GCSB, licensed under CC BY 4.0. Changes were made for this workshop. No endorsement is implied.');
        const links = section.querySelector('.ncsc-workshop-links').querySelectorAll('a');
        expect(links).toHaveLength(2);
        FILES.forEach(([extension], index) => {
            const filename = 'No_Fries_Questionnaire_Onsite_Companion_v2_NZISM.' + extension;
            expect(links[index].getAttribute('href')).toBe('/assets/workshops/' + filename);
            expect(links[index].getAttribute('download')).toBe(filename);
            expect(links[index].textContent).toContain('.' + extension);
            links[index].click();
        });
        expect(section.querySelector('.ncsc-workshop-sources').querySelectorAll('a').map(link => link.getAttribute('href')))
            .toEqual([
                'https://www.ncsc.govt.nz/protect-your-organisation/ncsc-cyber-security-framework/',
                'https://www.ncsc.govt.nz/protect-your-organisation/minimum-standards/',
                'https://www.ncsc.govt.nz/protect-your-organisation/summary/',
                'https://www.ncsc.govt.nz/legal-privacy-and-copyright/',
                'https://nzism.gcsb.govt.nz/ism-document/pdf',
                'https://nzism.gcsb.govt.nz/legal-privacy-and-copyright',
                'https://creativecommons.org/licenses/by/4.0/'
            ]);
        expect(ui.client.list).toHaveBeenCalledTimes(1);
        for (const name of ['read', 'create', 'save', 'submit']) expect(ui.client[name]).not.toHaveBeenCalled();
    } finally { ui.controller.destroy(); }
});

test('access denial removes the questionnaire download section', async () => {
    const ui = setup(async () => { throw { statusCode: 403, code: 'ncsc_access_denied' }; });
    try {
        await tick();
        expect(ui.root.querySelector('.ncsc-workshop')).toBeNull();
        expect(ui.root.textContent).toContain('This assessment is not available.');
        for (const name of ['read', 'create', 'save', 'submit']) expect(ui.client[name]).not.toHaveBeenCalled();
    } finally { ui.controller.destroy(); }
});

test('both production packages contain the exact reviewed workshop bytes', () => {
    for (const script of ['build-static.js', 'build-app-service.js']) {
        execFileSync(process.execPath, ['scripts/' + script], { cwd: ROOT, stdio: 'pipe' });
    }
    for (const [extension, expected] of FILES) {
        const relative = 'assets/workshops/No_Fries_Questionnaire_Onsite_Companion_v2_NZISM.' + extension;
        for (const output of ['', 'dist', 'app-service-dist']) {
            const bytes = fs.readFileSync(path.join(ROOT, output, relative));
            expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected);
        }
    }
});
