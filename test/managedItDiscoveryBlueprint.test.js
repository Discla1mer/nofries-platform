const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { getAssessmentBlueprint, getQuestionMap, isQuestionVisible } = require('../api/shared/salesBlueprint');
const { buildLifecycleScopingPreview } = require('../api/shared/scoping/lifecycleScopingMapper');
const { proposalReviewEvidence } = require('../api/shared/salesRuntime');

const groups = ['voice', 'servers', 'web'];

describe('complex managed IT discovery', () => {
    test('keeps stable existing questions and all new IDs unique, with valid conditions', () => {
        const blueprint = getAssessmentBlueprint();
        expect(blueprint.version).toBe('2026.11.1');
        expect(blueprint.questions).toHaveLength(37);
        expect(new Set(blueprint.questions.map(question => question.id)).size).toBe(37);
        const sectionIds = new Set(blueprint.sections.map(section => section.id));
        const map = getQuestionMap();
        for (const question of blueprint.questions) {
            expect(sectionIds.has(question.section)).toBe(true);
            expect(question.capture).toMatchObject({ evidence: true, confidence: true, internalNotes: true });
            if (question.showWhen) {
                const dependency = map.get(question.showWhen.questionId);
                expect(dependency.type).toBe('single');
                expect(question.showWhen.values.every(value => dependency.options.some(option => option.value === value))).toBe(true);
            }
        }
        expect(map.get('estate.endpoints').options.map(option => option.value)).toEqual([
            'under_10', '10_24', '25_49', '50_99', '100_249', '250_plus', 'unknown'
        ]);
        expect(map.get('support.frustrations').type).toBe('multi');
    });

    test.each(groups)('%s details appear for yes or unknown, but not no or an unanswered gate', group => {
        const questions = getAssessmentBlueprint().questions;
        const gate = questions.find(question => question.id === `${group}.present`);
        const details = questions.filter(question => question.showWhen?.questionId === gate.id);
        expect(details).toHaveLength(3);
        expect(gate.options.map(option => option.value)).toEqual(['yes', 'no', 'unknown']);
        for (const value of ['yes', 'unknown', 'no', undefined]) {
            for (const question of details) {
                expect(isQuestionVisible(question, { [gate.id]: { value } })).toBe(value === 'yes' || value === 'unknown');
            }
        }
    });

    test('new deployment, responsibility and commercial facts stay unconfirmed on lifecycle import', () => {
        const preview = buildLifecycleScopingPreview({
            organisationId: 'synthetic-discovery', displayName: 'Fictional Company', context: {}, fieldStates: {}
        });
        for (const questionId of [...groups.map(group => `${group}.present`), 'operations.authority', 'operations.deployment', 'operations.costs']) {
            expect(preview.answers[questionId]).toBeUndefined();
            expect(preview.questionGaps).toContainEqual(expect.objectContaining({ questionId, status: 'unknown' }));
        }
        expect(preview.questionGaps.some(gap => gap.questionId === 'servers.recovery')).toBe(false);
    });

    test('blueprint copies cannot alter subsequent customer reviews', () => {
        const blueprint = getAssessmentBlueprint();
        blueprint.questions.find(question => question.id === 'voice.present').options[0].value = 'mutated';
        blueprint.questions.find(question => question.id === 'servers.recovery').showWhen.values.push('no');
        const fresh = getAssessmentBlueprint();
        expect(fresh.questions.find(question => question.id === 'voice.present').options[0].value).toBe('yes');
        expect(fresh.questions.find(question => question.id === 'servers.recovery').showWhen.values).toEqual(['yes', 'unknown']);
    });

    test('proposal evidence excludes unverified and hidden detail answers', () => {
        const assessment = { answers: {
            'servers.present': { value: 'yes' },
            'servers.recovery': { value: 'Customer to confirm restore owner', verification: 'pending' },
            'voice.present': { value: 'no' },
            'voice.inventory': { value: 'Old calling provider', verification: 'confirmed' },
            'operations.costs': { value: 'Charges checked with customer', verification: 'confirmed' }
        } };
        expect(proposalReviewEvidence(assessment).map(item => item.questionId)).toEqual(['servers.present', 'voice.present', 'operations.costs']);
        assessment.answers['servers.recovery'].verification = 'confirmed';
        expect(proposalReviewEvidence(assessment).map(item => item.questionId)).toContain('servers.recovery');
    });

    test('changing a service gate redraws the real UI immediately and restores keyboard focus', async () => {
        const element = () => ({ classList: { toggle() {} }, textContent: '', innerHTML: '' });
        const elements = Object.fromEntries(['appSidebar', 'appMain', 'loadingPanel', 'viewRoot', 'workspaceIdentity', 'tenantName', 'roleBadge', 'userName', 'saveIndicator', 'toastRegion', 'appDialog', 'dialogEyebrow', 'dialogTitle', 'dialogBody'].map(id => [id, element()]));
        const replacement = { dataset: { questionId: 'voice.present' }, value: 'yes', focus: jest.fn() };
        const statusControl = { dataset: { questionId: 'voice.inventory', answerField: 'verification' }, value: 'pending' };
        elements.viewRoot.querySelectorAll = selector => selector === '[data-answer-field="verification"]' ? [statusControl] : [replacement];
        elements.viewRoot.querySelector = () => null;
        const window = {};
        const source = fs.readFileSync(path.join(__dirname, '../api/shared/protectedAssets/mssp.js'), 'utf8')
            .replace('window.NoFriesSales = { start };', 'window.NoFriesSales = { start, app, renderDiscovery, handleChange, getVisibleQuestions };');
        vm.runInNewContext(source, { window, document: { getElementById: id => elements[id] } });
        const ui = window.NoFriesSales;
        Object.assign(ui.app, { bootstrap: { tenant: { name: 'Synthetic workspace' } }, view: 'discovery', blueprint: getAssessmentBlueprint(), discoverySection: 1,
            activeCustomer: { name: 'Fictional Company' }, activeAssessment: { title: 'Test review', status: 'draft', answers: {} } });
        ui.renderDiscovery();
        expect(elements.viewRoot.innerHTML).not.toContain('data-question-id="voice.inventory"');
        const target = { dataset: { questionId: 'voice.present', answerField: 'value' }, type: 'radio', checked: true, value: 'yes' };
        await ui.handleChange({ target });
        expect(elements.viewRoot.innerHTML).toContain('data-question-id="voice.inventory"');
        expect(replacement.focus).toHaveBeenCalledWith({ preventScroll: true });
        ui.app.activeAssessment.answers['voice.inventory'] = { value: 'Fictional calling supplier' };
        target.value = 'no';
        await ui.handleChange({ target });
        expect(elements.viewRoot.innerHTML).not.toContain('data-question-id="voice.inventory"');
        target.value = 'yes';
        await ui.handleChange({ target });
        expect(elements.viewRoot.innerHTML).toContain('Fictional calling supplier');
        expect(ui.app.dirty).toBe(true);
        expect(ui.app.activeAssessment.answers['voice.inventory'].verification).toBe('pending');

        ui.app.discoveryGapsOnly = true;
        ui.app.activeAssessment.prefill = { knownFactCount: 0 };
        expect(ui.getVisibleQuestions(false).map(question => question.id)).toContain('voice.inventory');
        statusControl.value = 'confirmed';
        await ui.handleChange({ target: statusControl });
        expect(ui.getVisibleQuestions(false).map(question => question.id)).not.toContain('voice.inventory');
        await ui.handleChange({ target: { dataset: { questionId: 'voice.inventory', answerField: 'value' }, value: 'Changed calling supplier', type: 'textarea' } });
        expect(ui.getVisibleQuestions(false).map(question => question.id)).toContain('voice.inventory');
        expect(statusControl.value).toBe('pending');

        const tab = { focus: jest.fn() };
        elements.viewRoot.querySelectorAll = () => [];
        elements.viewRoot.querySelector = () => tab;
        target.value = 'no';
        await ui.handleChange({ target });
        expect(tab.focus).toHaveBeenCalledWith({ preventScroll: true });
    });
});
