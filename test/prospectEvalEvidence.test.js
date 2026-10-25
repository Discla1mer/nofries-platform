const { runProspectEvalSuite } = require('../evals/prospect-harness');
const { validateProspectEvalEvidence } = require('../scripts/validate-prospect-eval-evidence');

describe('prospect evaluation evidence gate', () => {
    let currentResult;
    let focusedResult;

    beforeAll(async () => {
        currentResult = await runProspectEvalSuite({ runtime: 'mock' });
        focusedResult = await runProspectEvalSuite({
            runtime: 'mock',
            scenarioIds: ['core_identity_and_environment']
        });
    });

    function evidenceCopy() {
        return JSON.parse(JSON.stringify(currentResult));
    }

    test('accepts current full and focused application-path evidence', async () => {
        expect(validateProspectEvalEvidence(evidenceCopy(), {
            runtime: 'mock',
            scenarioCount: 11
        })).toEqual(expect.objectContaining({
            runtime: 'mock',
            scenarioCount: 11
        }));

        expect(validateProspectEvalEvidence(JSON.parse(JSON.stringify(focusedResult)), {
            runtime: 'mock',
            scenarioCount: 1
        })).toEqual(expect.objectContaining({
            runtime: 'mock',
            scenarioCount: 1
        }));
    });

    test('does not promote ambient pull-request CI metadata to stamped release evidence', async () => {
        const result = await runProspectEvalSuite({
            runtime: 'mock',
            scenarioIds: ['core_identity_and_environment'],
            env: {
                GITHUB_SHA: 'a'.repeat(40),
                GITHUB_RUN_ID: '32642827327'
            }
        });

        expect(result.run).toMatchObject({
            releaseSha: '',
            releaseRunId: ''
        });
        expect(validateProspectEvalEvidence(result, {
            runtime: 'mock',
            scenarioCount: 1
        })).toEqual(expect.objectContaining({
            runtime: 'mock',
            scenarioCount: 1,
            releaseSha: ''
        }));
    });

    test('requires an OpenAI release run to cover the complete canonical suite', () => {
        const result = JSON.parse(JSON.stringify(focusedResult));
        result.run.runtime = 'openai';

        expect(() => validateProspectEvalEvidence(result, {
            runtime: 'openai',
            scenarioCount: 1
        })).toThrow(/missing canonical dataset IDs/i);
    });

    test('rejects drifted contract identity and failed scenarios', async () => {
        const result = evidenceCopy();
        result.harness.applicationContractSha256 = '0'.repeat(64);
        result.summary.failed = 1;

        expect(() => validateProspectEvalEvidence(result, {
            runtime: 'mock',
            scenarioCount: 11
        })).toThrow(/current source|summary\.failed/i);
    });

    test('rejects fabricated scenario IDs and false assertions even when pass flags and summary claim success', () => {
        const result = evidenceCopy();
        result.scenarios.forEach((scenario, index) => {
            scenario.id = `fabricated_${index}`;
            scenario.assertions[0].passed = false;
            scenario.passed = true;
            scenario.failedAssertions = [];
        });
        result.suite.selectedScenarioIds = result.scenarios.map((scenario) => scenario.id);
        result.summary = { passed: 11, failed: 0, total: 11 };

        expect(() => validateProspectEvalEvidence(result, {
            runtime: 'mock',
            scenarioCount: 11
        })).toThrow(/unknown canonical dataset IDs|missing canonical dataset IDs|assertion 1 failed/i);
    });

    test.each([
        ['unknown', (result) => {
            result.scenarios[0].id = 'not_in_the_canonical_dataset';
        }],
        ['duplicate', (result) => {
            result.scenarios[1].id = result.scenarios[0].id;
        }],
        ['missing', (result) => {
            result.scenarios.pop();
            result.summary = { passed: 10, failed: 0, total: 10 };
        }]
    ])('rejects %s canonical scenario identity', (_name, mutate) => {
        const result = evidenceCopy();
        mutate(result);
        result.suite.selectedScenarioIds = result.scenarios.map((scenario) => scenario.id);

        expect(() => validateProspectEvalEvidence(result, {
            runtime: 'mock',
            scenarioCount: 11
        })).toThrow(/canonical scenario|unique non-empty IDs|unknown canonical dataset IDs|missing canonical dataset IDs/i);
    });

    test('rejects drifted per-scenario evidence identity', () => {
        const result = evidenceCopy();
        result.scenarios[0].evidence.scenarioSha256 = '0'.repeat(64);

        expect(() => validateProspectEvalEvidence(result, {
            runtime: 'mock',
            scenarioCount: 11
        })).toThrow(/scenarioSha256 \(current source\)/i);
    });

    test('rejects false assertions independently of pass flags and summary', () => {
        const result = evidenceCopy();
        result.scenarios[0].assertions[0].passed = false;
        result.scenarios[0].passed = true;
        result.scenarios[0].failedAssertions = [];
        result.summary = { passed: 11, failed: 0, total: 11 };

        expect(() => validateProspectEvalEvidence(result, {
            runtime: 'mock',
            scenarioCount: 11
        })).toThrow(/assertion 1 failed/i);
    });

    test('rejects malformed assertion evidence independently of pass flags', () => {
        const result = evidenceCopy();
        result.scenarios[0].assertions[0].passed = 'true';
        result.scenarios[0].passed = true;
        result.scenarios[0].failedAssertions = [];
        result.summary = { passed: 11, failed: 0, total: 11 };

        expect(() => validateProspectEvalEvidence(result, {
            runtime: 'mock',
            scenarioCount: 11
        })).toThrow(/passed must be a boolean/i);
    });

    test('rejects a fabricated single true assertion for every canonical scenario', () => {
        const result = evidenceCopy();
        result.scenarios.forEach((scenario) => {
            scenario.assertions = [{ name: 'fabricated', passed: true }];
            scenario.assertionCount = 1;
            scenario.failedAssertions = [];
            scenario.passed = true;
        });
        result.summary = { passed: 11, failed: 0, total: 11 };

        expect(() => validateProspectEvalEvidence(result, {
            runtime: 'mock',
            scenarioCount: 11
        })).toThrow(/missing recomputed assertion|unexpected assertion/i);
    });

    test('rejects canonical assertion names forced true when sanitized evidence fails', () => {
        const result = evidenceCopy();
        result.scenarios[0].evidence.final.knownFacts['company.name'] = 'Fabricated Company';
        result.scenarios[0].assertions.forEach((assertion) => {
            assertion.passed = true;
        });
        result.scenarios[0].failedAssertions = [];
        result.scenarios[0].passed = true;
        result.summary = { passed: 11, failed: 0, total: 11 };

        expect(() => validateProspectEvalEvidence(result, {
            runtime: 'mock',
            scenarioCount: 11
        })).toThrow(/outcome does not match recomputed evidence/i);
    });

    test.each([
        ['duplicate', (scenario) => scenario.assertions.push(Object.assign({}, scenario.assertions[0]))],
        ['missing', (scenario) => scenario.assertions.pop()],
        ['extra', (scenario) => scenario.assertions.push({ name: 'fabricated_extra', passed: true })]
    ])('rejects %s assertion identity', (_name, mutate) => {
        const result = evidenceCopy();
        mutate(result.scenarios[0]);
        result.scenarios[0].assertionCount = result.scenarios[0].assertions.length;

        expect(() => validateProspectEvalEvidence(result, {
            runtime: 'mock',
            scenarioCount: 11
        })).toThrow(/unique names|missing recomputed assertion|unexpected assertion/i);
    });
});
