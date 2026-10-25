#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
    applicationContractManifest,
    evaluateScenarioEvidence,
    loadProspectEvalDataset
} = require('../evals/prospect-harness');
const { PROSPECT_PROMPT_VERSION } = require('../api/shared/agents/prospectAgent');
const { PROSPECT_TOOL_SCHEMA_VERSION } = require('../api/shared/agents/prospectTools');
const { MANAGED_IT_POLICY } = require('../api/shared/managedItPolicy');
const { PRICE_VERSION } = require('../api/shared/mspPricing');

function validateProspectEvalEvidence(result, options = {}) {
    const errors = [];
    const expectedRuntime = clean(options.runtime);
    const expectedReleaseSha = clean(options.releaseSha).toLowerCase();
    const expectedScenarioCount = options.scenarioCount == null
        ? null
        : Number(options.scenarioCount);
    const currentDataset = loadProspectEvalDataset(options.datasetPath);
    const currentContract = applicationContractManifest();

    requireEqual(errors, 'kind', result && result.kind, 'nofries.prospect-eval-result');
    requireEqual(errors, 'schemaVersion', result && result.schemaVersion, 1);
    requireEqual(errors, 'harness.id', result && result.harness && result.harness.id, 'nofries-prospect-application-path');
    requireSha(errors, 'harness.applicationContractSha256', result && result.harness && result.harness.applicationContractSha256);
    requireEqual(
        errors,
        'harness.applicationContractSha256 (current source)',
        result && result.harness && result.harness.applicationContractSha256,
        currentContract.sha256
    );
    requireEqual(
        errors,
        'harness.applicationContractFiles (current source)',
        result && result.harness && result.harness.applicationContractFiles,
        currentContract.files
    );

    requireEqual(errors, 'suite.dataClassification', result && result.suite && result.suite.dataClassification, 'synthetic_sanitised');
    requireSha(errors, 'suite.datasetSha256', result && result.suite && result.suite.datasetSha256);
    requireEqual(errors, 'suite.id (current source)', result && result.suite && result.suite.id, currentDataset.dataset.suiteId);
    requireEqual(errors, 'suite.version (current source)', result && result.suite && result.suite.version, currentDataset.dataset.suiteVersion);
    requireEqual(errors, 'suite.datasetSha256 (current source)', result && result.suite && result.suite.datasetSha256, currentDataset.sha256);

    const run = result && result.run || {};
    const scenarios = Array.isArray(result && result.scenarios) ? result.scenarios : [];
    const selectedIds = result && result.suite && Array.isArray(result.suite.selectedScenarioIds)
        ? result.suite.selectedScenarioIds
        : [];
    const summary = result && result.summary || {};
    const scenarioIds = scenarios.map((scenario) => scenario && scenario.id);
    const canonicalScenarioIds = currentDataset.dataset.scenarios.map((scenario) => scenario.id);
    const canonicalScenariosById = new Map(currentDataset.dataset.scenarios.map((scenario) => [scenario.id, scenario]));
    const scenarioIdSet = new Set(scenarioIds);
    requireEqual(errors, 'suite.selectedScenarioIds', selectedIds, scenarioIds);
    requireEqual(errors, 'summary.total', summary.total, scenarios.length);
    requireEqual(errors, 'summary.passed', summary.passed, scenarios.filter((scenario) => scenario && scenario.passed).length);
    requireEqual(errors, 'summary.failed', summary.failed, scenarios.filter((scenario) => !scenario || !scenario.passed).length);
    requireEqual(errors, 'summary.failed', summary.failed, 0);
    if (scenarioIdSet.size !== scenarioIds.length || scenarioIds.some((id) => !clean(id))) {
        errors.push('scenarios must have unique non-empty IDs');
    }
    const unknownScenarioIds = scenarioIds.filter((id) => !canonicalScenariosById.has(id));
    const missingScenarioIds = canonicalScenarioIds.filter((id) => !scenarioIdSet.has(id));
    if (unknownScenarioIds.length) {
        errors.push(`scenarios contain unknown canonical dataset IDs: ${unknownScenarioIds.join(', ')}`);
    }
    const requiresCompleteCanonicalSuite = run.runtime === 'openai' || expectedScenarioCount === canonicalScenarioIds.length;
    if (requiresCompleteCanonicalSuite && missingScenarioIds.length) {
        errors.push(`scenarios are missing canonical dataset IDs: ${missingScenarioIds.join(', ')}`);
    }
    scenarios.forEach((scenario, scenarioIndex) => {
        const canonicalScenario = canonicalScenariosById.get(scenario && scenario.id);
        if (canonicalScenario) {
            requireSha(errors, `scenario ${scenario.id} evidence.scenarioSha256`, scenario.evidence && scenario.evidence.scenarioSha256);
            requireEqual(
                errors,
                `scenario ${scenario.id} evidence.scenarioSha256 (current source)`,
                scenario.evidence && scenario.evidence.scenarioSha256,
                sha256(JSON.stringify(canonicalScenario))
            );
        }
        validateScenarioAssertions(
            errors,
            scenario,
            scenarioIndex,
            canonicalScenario ? evaluateScenarioEvidence(canonicalScenario, scenario.evidence, run.runtime) : []
        );
    });
    if (expectedScenarioCount != null) {
        requireEqual(errors, 'expected scenario count', scenarios.length, expectedScenarioCount);
    }

    if (expectedRuntime) requireEqual(errors, 'run.runtime', run.runtime, expectedRuntime);
    if (!['mock', 'openai'].includes(run.runtime)) errors.push('run.runtime must be mock or openai');
    requireEqual(errors, 'run.promptVersion', run.promptVersion, PROSPECT_PROMPT_VERSION);
    requireEqual(errors, 'run.toolSchemaVersion', run.toolSchemaVersion, PROSPECT_TOOL_SCHEMA_VERSION);
    requireEqual(errors, 'run.commercialPolicyId', run.commercialPolicyId, MANAGED_IT_POLICY.policyId);
    requireEqual(errors, 'run.commercialPolicyVersion', run.commercialPolicyVersion, PRICE_VERSION);
    requireEqual(errors, 'run.commercialPolicyEffectiveFrom', run.commercialPolicyEffectiveFrom, MANAGED_IT_POLICY.effectiveFrom);
    if (!clean(run.configuredModel)) errors.push('run.configuredModel is required');
    if (!run.usage || !isNonNegativeNumber(run.usage.totalTokens)) errors.push('run.usage.totalTokens must be non-negative');
    if (!isNonNegativeNumber(run.approximateCostUsd)) errors.push('run.approximateCostUsd must be non-negative');

    if (expectedReleaseSha) {
        if (!/^[0-9a-f]{40}$/.test(expectedReleaseSha)) errors.push('expected release SHA must be a full Git SHA');
        requireEqual(errors, 'run.releaseSha', clean(run.releaseSha).toLowerCase(), expectedReleaseSha);
    }
    if (run.releaseSha && !/^[0-9a-f]{40}$/.test(clean(run.releaseSha).toLowerCase())) {
        errors.push('run.releaseSha must be empty or a full Git SHA');
    }
    if (run.releaseSha && !/^\d+$/.test(clean(run.releaseRunId))) {
        errors.push('run.releaseRunId must identify the workflow that stamped an evaluated release');
    }

    if (run.runtime === 'openai') {
        const providerModels = Array.isArray(run.actualProviderModels) ? run.actualProviderModels : [];
        if (!providerModels.length || providerModels.some((model) => !clean(model))) {
            errors.push('run.actualProviderModels must contain provider-returned model identity');
        }
        if (!(Number(run.usage && run.usage.totalTokens) > 0)) {
            errors.push('an OpenAI result must record positive model usage');
        }
        const modelBackedTurns = scenarios.flatMap((scenario) => (
            scenario && scenario.evidence && Array.isArray(scenario.evidence.transcript)
                ? scenario.evidence.transcript
                : []
        )).filter((turn) => Number(turn && turn.usage && turn.usage.totalTokens) > 0);
        if (!modelBackedTurns.length) errors.push('an OpenAI result must include at least one model-backed turn');
        if (modelBackedTurns.some((turn) => !clean(turn.providerModel))) {
            errors.push('every model-backed turn must retain its provider-returned model identity');
        }
    }

    if (errors.length) {
        const error = new Error(`Prospect eval evidence is invalid:\n- ${errors.join('\n- ')}`);
        error.validationErrors = errors;
        throw error;
    }
    return {
        scenarioCount: scenarios.length,
        runtime: run.runtime,
        releaseSha: clean(run.releaseSha),
        contractSha256: currentContract.sha256,
        datasetSha256: currentDataset.sha256
    };
}

function validateScenarioAssertions(errors, scenario, scenarioIndex, recomputedAssertions) {
    const label = `scenario ${clean(scenario && scenario.id) || scenarioIndex + 1}`;
    if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
        errors.push(`${label} must be an evidence object`);
        return;
    }
    if (!Array.isArray(scenario.assertions) || !scenario.assertions.length) {
        errors.push(`${label} assertions must be a non-empty array`);
        return;
    }

    const failedAssertionNames = [];
    const assertionOutcomes = new Map();
    scenario.assertions.forEach((assertion, assertionIndex) => {
        const assertionLabel = `${label} assertion ${assertionIndex + 1}`;
        if (!assertion || typeof assertion !== 'object' || Array.isArray(assertion)) {
            errors.push(`${assertionLabel} must be an object`);
            return;
        }
        const assertionName = clean(assertion.name);
        if (!assertionName) errors.push(`${assertionLabel} requires a non-empty name`);
        if (assertionName && assertionOutcomes.has(assertionName)) {
            errors.push(`${label} assertions must have unique names: ${assertionName}`);
        }
        if (assertion.passed !== true && assertion.passed !== false) {
            errors.push(`${assertionLabel} passed must be a boolean`);
            return;
        }
        if (assertionName) assertionOutcomes.set(assertionName, assertion.passed);
        if (!assertion.passed) {
            failedAssertionNames.push(assertionName || `assertion_${assertionIndex + 1}`);
            errors.push(`${assertionLabel} failed`);
        }
    });

    requireEqual(errors, `${label} assertionCount`, scenario.assertionCount, scenario.assertions.length);
    requireEqual(errors, `${label} failedAssertions`, scenario.failedAssertions, failedAssertionNames);
    requireEqual(errors, `${label} passed`, scenario.passed, failedAssertionNames.length === 0);

    const expectedOutcomes = new Map((Array.isArray(recomputedAssertions) ? recomputedAssertions : []).map((assertion) => (
        [clean(assertion && assertion.name), assertion && assertion.passed]
    )));
    expectedOutcomes.forEach((passed, name) => {
        if (!assertionOutcomes.has(name)) {
            errors.push(`${label} assertions are missing recomputed assertion: ${name}`);
        } else if (assertionOutcomes.get(name) !== passed) {
            errors.push(`${label} assertion ${name} outcome does not match recomputed evidence`);
        }
    });
    assertionOutcomes.forEach((_passed, name) => {
        if (!expectedOutcomes.has(name)) errors.push(`${label} assertions contain unexpected assertion: ${name}`);
    });
}

function requireEqual(errors, label, actual, expected) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        errors.push(`${label} does not match the required value`);
    }
}

function requireSha(errors, label, value) {
    if (!/^[a-f0-9]{64}$/.test(clean(value).toLowerCase())) {
        errors.push(`${label} must be a SHA-256 digest`);
    }
}

function isNonNegativeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0;
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function clean(value) {
    return String(value == null ? '' : value).trim();
}

function parseArgs(argv) {
    const positional = argv.filter((value) => !String(value).startsWith('--'));
    if (positional.length !== 1) {
        throw new Error('Usage: validate-prospect-eval-evidence.js <result.json> [--runtime=mock|openai] [--release-sha=<sha>] [--scenario-count=<number>]');
    }
    return {
        resultPath: path.resolve(positional[0]),
        runtime: option(argv, '--runtime'),
        releaseSha: option(argv, '--release-sha'),
        scenarioCount: option(argv, '--scenario-count') || undefined
    };
}

function option(argv, name) {
    const found = argv.filter((value) => String(value).startsWith(`${name}=`)).pop();
    return found ? String(found).slice(name.length + 1).trim() : '';
}

if (require.main === module) {
    try {
        const options = parseArgs(process.argv.slice(2));
        const result = JSON.parse(fs.readFileSync(options.resultPath, 'utf8'));
        const evidence = validateProspectEvalEvidence(result, options);
        process.stdout.write(`Prospect eval evidence passed: ${evidence.scenarioCount} ${evidence.runtime} scenario(s).\n`);
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}

module.exports = {
    validateProspectEvalEvidence
};
