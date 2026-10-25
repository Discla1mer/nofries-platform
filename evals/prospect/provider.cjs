const { runProspectEvalSuite } = require('../prospect-harness');

class NoFriesProspectApplicationProvider {
    constructor(options = {}) {
        this.config = options.config || {};
    }

    id() {
        return 'nofries:prospect-application-path';
    }

    async callApi(prompt, context = {}) {
        const scenarioId = String(
            context && context.vars && context.vars.scenarioId ||
            prompt ||
            ''
        ).trim();
        if (!scenarioId) throw new Error('Promptfoo prospect provider requires vars.scenarioId');
        const runtime = String(process.env.NOFRIES_EVAL_RUNTIME || this.config.runtime || 'mock').trim().toLowerCase();
        const result = await runProspectEvalSuite({ runtime, scenarioIds: [scenarioId] });
        const scenario = result.scenarios[0];
        const usage = scenario.evidence.usage;
        return {
            output: JSON.stringify(scenario),
            tokenUsage: {
                prompt: usage.inputTokens,
                completion: usage.outputTokens,
                total: usage.totalTokens
            },
            cost: scenario.evidence.approximateCostUsd,
            metadata: {
                suiteId: result.suite.id,
                suiteVersion: result.suite.version,
                dataClassification: result.suite.dataClassification,
                datasetSha256: result.suite.datasetSha256,
                harnessVersion: result.harness.version,
                applicationContractSha256: result.harness.applicationContractSha256,
                runtime: result.run.runtime,
                model: result.run.model,
                configuredModel: result.run.configuredModel,
                reasoningEffort: result.run.reasoningEffort,
                promptVersion: result.run.promptVersion,
                toolSchemaVersion: result.run.toolSchemaVersion,
                commercialPolicyId: result.run.commercialPolicyId,
                commercialPolicyVersion: result.run.commercialPolicyVersion,
                releaseSha: result.run.releaseSha,
                scenarioId
            }
        };
    }
}

module.exports = NoFriesProspectApplicationProvider;
module.exports.NoFriesProspectApplicationProvider = NoFriesProspectApplicationProvider;
