'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const v2Module = require('../api/shared/assessmentEngine/nistNcscCrosswalkV2');
const setModule = require('../api/shared/assessmentEngine/nistNcscCrosswalkSet');
const { createNistNcscCrosswalkV2 } = v2Module;
const { nistNcscCrosswalkForProfile } = setModule;
const { createNistNcscCrosswalk, NistNcscCrosswalkError } = require('../api/shared/assessmentEngine/nistNcscCrosswalk');
const { createNistFrameworkProfile } = require('../api/shared/assessmentEngine/nistFrameworkProfile');
const { createNcscFrameworkProfileV2 } = require('../api/shared/assessmentEngine/ncscFrameworkProfileV2');
const { ACCEPTED_NCSC_CONTEXT, NCSC_V2_CONTEXT } = require('../api/shared/assessmentEngine/ncscProfileSet');

// Pins written out by hand so a change to either publication shows up here.
const V1_CROSSWALK_SHA = '61f68fba7bfd3ce9480a0db5f6e4d297bdcf1aff63e80073bffd27dc2abf1e17';
const V1_PUBLICATION_FILE_SHA = '4fd74a503472b531d9a408041c9b11178ae360cebe67a756ec9e754af122e54e';
const V2_CROSSWALK_SHA = 'abf04ee3e9d6ebc8e4a3b71f4e1135abd9b33bb7360cc40298989e6fed0038b3';
const V1_REF = {
    frameworkId: 'nz-ncsc-cyber-security-framework', frameworkVersion: 'beta-verified-2026-09-02',
    profileId: 'nz-ncsc-mcss-2025-v3-sme', profileVersion: '2026-09-02.1',
    catalogueSha256: '32c3f8d154ffe2be9b1270f8fa1234427a05cdea96b231588cce0b147e7d5375',
    sourceCatalogueSha256: '26ccecee78ade16607e5e8c194d585dc47c7921f2eea54b2c76776e0d961b6ee'
};
const V2_REF = {
    frameworkId: 'nz-ncsc-cyber-security-framework', frameworkVersion: 'beta-verified-2026-09-02',
    profileId: 'nz-ncsc-mcss-2025-v3-sme', profileVersion: '2026-11-18.1',
    catalogueSha256: 'c90e999f627308f326a403b1d779e68087e3eaadab5149070f1df5e350daa537',
    sourceCatalogueSha256: 'c6120192675c9d12cdab296d6f5a84f014d613b300001394790f3ccf79692b71'
};
const NIST_REF = {
    frameworkId: 'nist-cybersecurity-framework', frameworkVersion: '2.0',
    profileId: 'nf-nist-csf-2-0-core', profileVersion: '2026-09-08.1',
    catalogueSha256: 'ec394a65b11417b67201f96af57a7eabeb284376bb0651b816b40017476b6073',
    sourceCatalogueSha256: 'ab75b51c3561c50cb48cd21b96c01afa2aecafb2efc6b46ae4a8ef8cd753a656'
};
const V2_CONTROLS = `NF-NCSC-MCSS-RM-01 NF-NCSC-MCSS-SA-01 NF-NCSC-MCSS-AI-01 NF-NCSC-MCSS-PA-01 NF-NCSC-MCSS-MF-01
NF-NCSC-MCSS-DU-01 NF-NCSC-MCSS-LP-01 NF-NCSC-MCSS-DR-01 NF-NCSC-MCSS-RP-01 NF-NCSC-CC-PM-01 NF-NCSC-CC-SV-01
NF-NCSC-CC-NS-01 NF-NCSC-CC-SU-01 NF-NCSC-CC-EM-01`.split(/\s+/);
const V2_QUESTIONS = V2_CONTROLS.flatMap(id => (/MF-01|DR-01/.test(id) ? [`${id}-Q1`, `${id}-Q2`] : [`${id}-Q1`]));
// The reviewed mapping, question by question, with its v1 lineage.
const POSITIVES = [
    ['NF-NCSC-MCSS-RM-01-Q1', 'GV.RM-03:restated GV.RR-01:new GV.RR-02:restated'],
    ['NF-NCSC-MCSS-SA-01-Q1', 'PR.AT-01:restated'],
    ['NF-NCSC-MCSS-AI-01-Q1', 'ID.AM-01:reused ID.AM-02:reused ID.AM-07:reused'],
    ['NF-NCSC-MCSS-PA-01-Q1', 'PR.PS-02:restated'],
    ['NF-NCSC-MCSS-MF-01-Q1', 'PR.AA-03:restated'],
    ['NF-NCSC-MCSS-MF-01-Q2', 'PR.AA-03:restated'],
    ['NF-NCSC-MCSS-DU-01-Q1', 'PR.PS-04:restated DE.CM-03:new DE.CM-09:restated DE.AE-06:new'],
    ['NF-NCSC-MCSS-LP-01-Q1', 'PR.AA-01:restated PR.AA-05:reused'],
    ['NF-NCSC-MCSS-DR-01-Q1', 'PR.DS-11:restated PR.IR-03:restated'],
    ['NF-NCSC-MCSS-DR-01-Q2', 'PR.DS-11:restated'],
    ['NF-NCSC-MCSS-RP-01-Q1', 'GV.SC-08:new ID.IM-04:restated'],
    ['NF-NCSC-CC-PM-01-Q1', 'PR.AA-01:restated'],
    ['NF-NCSC-CC-NS-01-Q1', 'PR.IR-01:restated PR.PS-01:new'],
    ['NF-NCSC-CC-SU-01-Q1', 'GV.SC-05:new PR.AA-03:new PR.AA-05:new'],
    ['NF-NCSC-CC-EM-01-Q1', 'PR.PS-01:new DE.CM-09:new']
].flatMap(([question, targets]) => targets.split(' ').map(entry => [question, ...entry.split(':')]));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));

// Independent of the module's encoder.
function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort()
        .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    return JSON.stringify(value);
}

describe('v1 crosswalk is unchanged', () => {
    test('keeps its publication digest, file bytes and closed surface', () => {
        const v1 = createNistNcscCrosswalk();
        expect(v1.crosswalkSha256).toBe(V1_CROSSWALK_SHA);
        expect(sha256(JSON.stringify(v1, null, 2) + '\n')).toBe(V1_PUBLICATION_FILE_SHA);
        expect(v1.fromProfileRef).toEqual(V1_REF);
        expect(Object.keys(require('../api/shared/assessmentEngine/nistNcscCrosswalk')).sort())
            .toEqual(['NistNcscCrosswalkError', 'createNistNcscCrosswalk']);
        createNistNcscCrosswalkV2();
        expect(sha256(JSON.stringify(createNistNcscCrosswalk(), null, 2) + '\n')).toBe(V1_PUBLICATION_FILE_SHA);
    });
});

describe('v2 crosswalk publication', () => {
    let crosswalk, v1, nist, v2;
    beforeAll(() => {
        crosswalk = createNistNcscCrosswalkV2(); v1 = createNistNcscCrosswalk();
        nist = createNistFrameworkProfile(); v2 = createNcscFrameworkProfileV2();
    });

    test('is keyed to the exact v2 profile and NIST catalogue and pins its digest', () => {
        expect(Object.keys(v2Module).sort()).toEqual(['NistNcscCrosswalkError', 'createNistNcscCrosswalkV2']);
        expect(crosswalk).toMatchObject({ schemaVersion: 2, id: 'nf-ncsc-to-nist-csf-2-0', version: '2026-11-20.1',
            fromProfileRef: V2_REF, toProfileRef: NIST_REF, crosswalkSha256: V2_CROSSWALK_SHA });
        expect(crosswalk.fromProfileRef).toEqual(NCSC_V2_CONTEXT.profileRef);
        expect(crosswalk.toProfileRef).toEqual(v1.toProfileRef);
        const { crosswalkSha256, ...body } = crosswalk;
        expect(sha256('no-fries-nist-ncsc-crosswalk-v2\n' + canonical(body))).toBe(crosswalkSha256);
        expect(crosswalk.priorEdition).toMatchObject({ id: v1.id, version: v1.version, crosswalkSha256: V1_CROSSWALK_SHA,
            fromProfileRef: V1_REF });
    });

    test('uses only CSF 2.0 ids already in the repo NIST catalogue, with v1 PDF pages', () => {
        const nistIds = new Set(nist.controls.map(control => control.id));
        const v1Pages = new Map(v1.records.filter(r => r.target).map(r => [r.target.controlId, r.locators.targetReference.pdfPage]));
        expect(crosswalk.reviewedTargetControlIds).toEqual(nist.controls.map(control => control.id));
        for (const record of crosswalk.records.filter(r => r.target)) {
            expect(nistIds.has(record.target.controlId)).toBe(true);
            expect(record.locators.targetReference).toEqual({ sourceId: 'nist-cswp-29-final-2024-02-26',
                referenceId: record.target.controlId, pdfPage: v1Pages.get(record.target.controlId) });
        }
        for (const entry of crosswalk.controlDispositions) {
            [...entry.mappedTargetControlIds, ...entry.droppedV1Targets.map(d => d.targetControlId)]
                .forEach(id => expect(nistIds.has(id)).toBe(true));
        }
    });

    test('holds exactly the reviewed mapping, then one no-match per remaining outcome, then SV-01', () => {
        const positives = crosswalk.records.filter(r => r.relationship === 'partial');
        expect(positives.map(r => [r.source.questionId, r.target.controlId, r.v1Lineage])).toEqual(POSITIVES);
        expect(crosswalk.records.filter(r => r.relationship === 'exact')).toEqual([]);
        const mappedTargets = new Set(POSITIVES.map(p => p[1]));
        expect(crosswalk.records.filter(r => r.source === null).map(r => r.target.controlId))
            .toEqual(nist.controls.map(c => c.id).filter(id => !mappedTargets.has(id)));
        expect(crosswalk.records.filter(r => r.target === null).map(r => r.id)).toEqual(['NF-NCSC-CC-SV-01-Q1--ALL-NIST106']);
        expect(crosswalk.records).toHaveLength(POSITIVES.length + (106 - mappedTargets.size) + 1);
        expect(crosswalk.records.map(r => r.order)).toEqual(crosswalk.records.map((_, index) => index + 1));
        for (const record of positives) {
            expect(record.omittedTargetScope.length).toBeGreaterThan(0);
            expect(record.rationale.trim()).not.toBe('');
            expect(record.id).toBe(`${record.source.questionId}--${record.target.controlId}`);
            expect(record.locators.sourceQuestionPointer).toBe(`/questions/${V2_QUESTIONS.indexOf(record.source.questionId)}/prompt`);
            expect(v2.questions[V2_QUESTIONS.indexOf(record.source.questionId)].id).toBe(record.source.questionId);
        }
    });

    test('covers every v2 control exactly once, mapped or explicitly unmapped with a reason', () => {
        expect(v2.controls.map(c => c.id)).toEqual(V2_CONTROLS);
        expect(crosswalk.reviewedSourceControlIds).toEqual(V2_CONTROLS);
        expect(crosswalk.reviewedSourceQuestionIds).toEqual(V2_QUESTIONS);
        expect(crosswalk.controlDispositions.map(d => d.controlId)).toEqual(V2_CONTROLS);
        for (const entry of crosswalk.controlDispositions) {
            const own = crosswalk.records.filter(r => r.source && r.source.controlId === entry.controlId);
            if (entry.disposition === 'mapped') {
                expect(own.every(r => r.relationship === 'partial')).toBe(true);
                expect(entry.mappedTargetControlIds.length).toBeGreaterThan(0);
            } else {
                expect(entry.disposition).toBe('unmapped');
                expect(own).toHaveLength(entry.questionIds.length);
                own.forEach(r => { expect(r.relationship).toBe('no_match'); expect(r.rationale.trim()).not.toBe(''); });
            }
        }
        expect(crosswalk.controlDispositions.filter(d => d.disposition === 'unmapped').map(d => d.controlId))
            .toEqual(['NF-NCSC-CC-SV-01']);
        // Every question and every outcome has one disposition: positive records, or exactly one no-match.
        for (const [side, field, ids] of [['source', 'questionId', V2_QUESTIONS], ['target', 'controlId', nist.controls.map(c => c.id)]]) {
            for (const id of ids) {
                const records = crosswalk.records.filter(r => r[side] && r[side][field] === id);
                expect(records.length).toBeGreaterThan(0);
                if (records.some(r => r.relationship === 'no_match')) expect(records).toHaveLength(1);
            }
        }
    });

    test('reuses v1 text only where meaning is unchanged and justifies every change', () => {
        const v1ByKey = new Map(v1.records.map(r => [JSON.stringify([r.source?.controlId ?? null, r.target?.controlId ?? null]), r]));
        for (const record of crosswalk.records) {
            const prior = v1ByKey.get(JSON.stringify([record.source?.controlId ?? null, record.target?.controlId ?? null]));
            if (record.v1Lineage === 'new') expect(prior).toBeUndefined();
            else {
                expect(prior).toBeDefined();
                const same = prior.rationale === record.rationale && canonical(prior.omittedTargetScope) === canonical(record.omittedTargetScope);
                expect(same).toBe(record.v1Lineage === 'reused');
            }
        }
        const byControl = new Map(crosswalk.controlDispositions.map(d => [d.controlId, d]));
        expect(byControl.get('NF-NCSC-CC-SU-01').v1Lineage).toBe('new-control');
        expect(byControl.get('NF-NCSC-CC-EM-01').v1Lineage).toBe('new-control');
        expect(byControl.get('NF-NCSC-CC-SV-01').v1Lineage).toBe('same-meaning');
        expect(Object.fromEntries(crosswalk.controlDispositions.filter(d => d.droppedV1Targets.length)
            .map(d => [d.controlId, d.droppedV1Targets.map(x => x.targetControlId)]))).toEqual({
            'NF-NCSC-MCSS-RM-01': ['GV.RM-02', 'GV.OV-02'], 'NF-NCSC-MCSS-SA-01': ['PR.AT-02'],
            'NF-NCSC-MCSS-AI-01': ['ID.AM-08'], 'NF-NCSC-MCSS-DU-01': ['DE.AE-02'],
            'NF-NCSC-MCSS-RP-01': ['GV.RR-02', 'ID.IM-02', 'ID.IM-03']
        });
        crosswalk.controlDispositions.forEach(d => {
            expect(d.changeNote.trim()).not.toBe('');
            d.droppedV1Targets.forEach(x => expect(x.reason.trim()).not.toBe(''));
        });
        expect(crosswalk.priorEdition.retiredSourceControls.map(r => r.controlId))
            .toEqual(['NF-NCSC-MCSS-SC-01', 'NF-NCSC-CC-AC-01']);
        expect(crosswalk.records.some(r => /-(SC|AC)-01/.test(r.source?.controlId ?? ''))).toBe(false);
    });

    test('is detached and deeply frozen, and is documented record by record', () => {
        const again = createNistNcscCrosswalkV2();
        expect(again).toEqual(crosswalk); expect(again).not.toBe(crosswalk);
        expect(Object.isFrozen(crosswalk.records[0].omittedTargetScope)).toBe(true);
        expect(() => { crosswalk.fromProfileRef.profileVersion = '2026-09-02.1'; }).toThrow(TypeError);
        expect(crosswalk).not.toHaveProperty('score');
        const doc = fs.readFileSync(path.join(__dirname, '../docs/nist-csf-2-crosswalk.md'), 'utf8');
        for (const record of crosswalk.records) expect(doc).toContain(record.id);
        expect(doc).toContain(V2_CROSSWALK_SHA);
    });
});

describe('selecting a crosswalk by exact profileRef', () => {
    const ON = { NOFRIES_NCSC_PROFILE_V2: 'true' };
    const refuse = (ref, env) => expect(() => nistNcscCrosswalkForProfile(ref, env)).toThrow(
        expect.objectContaining({ name: 'NistNcscCrosswalkError', code: 'crosswalk_profile_unknown' }));

    test('returns v1 for the exact v1 ref with the flag on or off', () => {
        for (const env of [{}, ON]) {
            const selected = nistNcscCrosswalkForProfile({ ...V1_REF }, env);
            expect(sha256(JSON.stringify(selected, null, 2) + '\n')).toBe(V1_PUBLICATION_FILE_SHA);
        }
        expect(ACCEPTED_NCSC_CONTEXT.profileRef).toEqual(V1_REF);
    });

    test('returns v2 for the exact v2 ref only when the flag is exactly true', () => {
        expect(nistNcscCrosswalkForProfile({ ...V2_REF }, ON).crosswalkSha256).toBe(V2_CROSSWALK_SHA);
        for (const value of [undefined, '', 'TRUE', 'True', '1', 'yes', ' true', 'true ']) {
            refuse({ ...V2_REF }, value === undefined ? {} : { NOFRIES_NCSC_PROFILE_V2: value });
        }
    });

    test.each(Object.keys(V2_REF))('refuses a v2 ref with a different %s, even with the flag on', field => {
        refuse({ ...V2_REF, [field]: field.endsWith('Sha256') ? '0'.repeat(64) : 'different' }, ON);
    });

    test('never selects by profileVersion alone or by a mixed or malformed ref', () => {
        refuse({ profileVersion: '2026-11-18.1' }, ON);
        refuse({ profileVersion: '2026-09-02.1' }, ON);
        refuse({ ...V1_REF, catalogueSha256: V2_REF.catalogueSha256, sourceCatalogueSha256: V2_REF.sourceCatalogueSha256 }, ON);
        refuse({ ...V2_REF, profileVersion: '2026-09-02.1' }, ON);
        refuse({ ...V2_REF, extra: 'x' }, ON);
        const { catalogueSha256, ...missing } = V2_REF; refuse(missing, ON);
        refuse({ ...NIST_REF }, ON);
        refuse(new Proxy({ ...V2_REF }, {}), ON);
        refuse(Object.create({ ...V2_REF }), ON);
        for (const bad of [null, undefined, '2026-11-18.1', [], 42]) refuse(bad, ON);
    });
});

describe('flag off: output unchanged', () => {
    test('with the flag off only v1 resolves, byte-identical to the fixed v1 publication', () => {
        const before = JSON.stringify(createNistNcscCrosswalk());
        expect(JSON.stringify(nistNcscCrosswalkForProfile({ ...V1_REF }, {}))).toBe(before);
        expect(() => nistNcscCrosswalkForProfile({ ...V2_REF }, {})).toThrow(NistNcscCrosswalkError);
    });

    test('adds no browser-visible output: no protected asset or handler reads a crosswalk', () => {
        const roots = ['api', 'src', 'public'].map(dir => path.join(__dirname, '..', dir)).filter(fs.existsSync);
        const readers = [];
        const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); }
            else if (/\.(c|m)?js$/.test(entry.name) && /nistNcscCrosswalk/.test(fs.readFileSync(full, 'utf8'))) {
                readers.push(path.relative(path.join(__dirname, '..'), full));
            }
        });
        roots.forEach(walk);
        expect(readers.sort()).toEqual([
            'api/shared/assessmentEngine/nistNcscCrosswalkSet.js',
            'api/shared/assessmentEngine/nistNcscCrosswalkV2.js'
        ]);
    });
});

describe('v2 crosswalk endpoint drift', () => {
    const modules = {
        v2: ['../api/shared/assessmentEngine/ncscFrameworkProfileV2', 'createNcscFrameworkProfileV2'],
        nist: ['../api/shared/assessmentEngine/nistFrameworkProfile', 'createNistFrameworkProfile']
    };
    afterEach(() => Object.values(modules).forEach(([modulePath]) => jest.dontMock(modulePath)));

    test.each(Object.keys(modules))('refuses %s prompt drift even when the reported pins are kept', side => {
        const [modulePath, exportName] = modules[side];
        jest.isolateModules(() => {
            jest.doMock(modulePath, () => {
                const actual = jest.requireActual(modulePath);
                return { ...actual, [exportName]: () => {
                    const value = copy(actual[exportName]());
                    value.questions[0].prompt = 'Changed exact compared prompt';
                    return value;
                } };
            });
            const isolated = require('../api/shared/assessmentEngine/nistNcscCrosswalkV2');
            expect(isolated.createNistNcscCrosswalkV2).toThrow(expect.objectContaining({ code: 'crosswalk_profile_mismatch' }));
        });
    });
});
