const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    HARNESS_SCHEMA_VERSION,
    HARNESS_VERSION,
    loadProspectEvalDataset,
    parseSseEvents,
    runProspectEvalSuite,
    sanitiseEvidenceText,
    sumUsage
} = require('../evals/prospect-harness');
const NoFriesProspectApplicationProvider = require('../evals/prospect/provider.cjs');
const { parseArgs } = require('../scripts/run-prospect-evals');

const repositoryRoot = path.resolve(__dirname, '..');

describe('prospect application-path eval harness', () => {
    test('loads one versioned canonical dataset with unique scenarios', () => {
        const loaded = loadProspectEvalDataset();
        const ids = loaded.dataset.scenarios.map((scenario) => scenario.id);

        expect(loaded.dataset).toMatchObject({
            schemaVersion: 1,
            suiteId: 'nofries-prospect-application-path',
            dataClassification: 'synthetic_sanitised'
        });
        expect(loaded.dataset.suiteVersion).toMatch(/^\d{4}\.\d{2}\.\d{2}\.\d+$/);
        expect(ids).toHaveLength(11);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toEqual(expect.arrayContaining([
            'core_identity_and_environment',
            'unknowns_are_not_invented',
            'provider_and_internal_it',
            'security_apps_and_timing',
            'answers_before_discovery',
            'human_follow_up_is_suggested_not_booked',
            'secret_is_rejected_before_storage',
            'public_agent_has_no_customer_system_access'
        ]));
        expect(loaded.sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    test('keeps the Promptfoo scenario list and provider path aligned with the canonical suite', () => {
        const loaded = loadProspectEvalDataset();
        const configPath = path.join(repositoryRoot, 'evals/prospect/promptfooconfig.yaml');
        const config = fs.readFileSync(configPath, 'utf8');
        const configuredIds = [...config.matchAll(/^\s+scenarioId:\s*([a-z0-9_-]+)\s*$/gm)]
            .map((match) => match[1]);
        const providerMatch = config.match(/^\s+- id:\s*file:\/\/([^\s]+)\s*$/m);

        expect(configuredIds).toEqual(loaded.dataset.scenarios.map((scenario) => scenario.id));
        expect(providerMatch).not.toBeNull();
        expect(path.resolve(path.dirname(configPath), providerMatch[1])).toBe(
            path.join(repositoryRoot, 'evals/prospect/provider.cjs')
        );
        expect(fs.existsSync(path.resolve(path.dirname(configPath), providerMatch[1]))).toBe(true);
    });

    test('executes every scenario through the application path in isolated mock stores', async () => {
        const result = await runProspectEvalSuite({ runtime: 'mock' });

        expect(result).toMatchObject({
            schemaVersion: HARNESS_SCHEMA_VERSION,
            kind: 'nofries.prospect-eval-result',
            harness: {
                version: HARNESS_VERSION,
                target: 'handleProspectSessionRequest + handleProspectChatRequest'
            },
            run: {
                runtime: 'mock',
                model: 'mock-deterministic',
                usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
                approximateCostUsd: 0
            },
            summary: { passed: 11, failed: 0, total: 11 }
        });
        expect(result.harness.applicationContractSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(result.scenarios.every((scenario) => scenario.passed)).toBe(true);
        expect(result.scenarios.every((scenario) => scenario.evidence.storage.organisations <= 1)).toBe(true);
    });

    test('records the application guard and redacts rejected sensitive input', async () => {
        const result = await runProspectEvalSuite({
            runtime: 'mock',
            scenarioIds: [
                'secret_is_rejected_before_storage',
                'public_agent_has_no_customer_system_access'
            ]
        });
        const secret = result.scenarios[0];
        const injection = result.scenarios[1];

        expect(secret.passed).toBe(true);
        expect(secret.evidence.transcript[0]).toMatchObject({
            errorCode: 'sensitive_data_blocked',
            usage: { totalTokens: 0 }
        });
        expect(secret.evidence.transcript[0].visitor).toContain('[REDACTED]');
        expect(JSON.stringify(secret)).not.toContain('Summer2026!');
        expect(secret.evidence.storage).toMatchObject({ organisations: 0, conversations: 0, messages: 0 });

        expect(injection.passed).toBe(true);
        expect(injection.evidence.transcript[0]).toMatchObject({
            model: 'deterministic-security-guard',
            security: { blocked: true, code: 'prompt_injection_blocked' },
            usage: { totalTokens: 0 }
        });
        expect(injection.evidence.storage).toMatchObject({
            organisations: 0,
            conversations: 0,
            messages: 0,
            securityEvents: 0,
            audit: 0
        });
    });

    test('supports exact scenario filtering and a clean JSON stdout/output contract', () => {
        const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-eval-output-'));
        const outputPath = path.join(outputDir, 'result.json');
        try {
            const stdout = execFileSync(process.execPath, [
                path.join(repositoryRoot, 'scripts/run-prospect-evals.js'),
                '--runtime=mock',
                '--scenario=trivial_opening_does_not_create_a_prospect',
                '--json',
                `--output=${outputPath}`
            ], {
                cwd: repositoryRoot,
                encoding: 'utf8'
            });
            const stdoutResult = JSON.parse(stdout);
            const fileResult = JSON.parse(fs.readFileSync(outputPath, 'utf8'));

            expect(stdoutResult.summary).toEqual({ passed: 1, failed: 0, total: 1 });
            expect(stdoutResult.suite.selectedScenarioIds).toEqual([
                'trivial_opening_does_not_create_a_prospect'
            ]);
            expect(fileResult).toEqual(stdoutResult);
        } finally {
            fs.rmSync(outputDir, { recursive: true, force: true });
        }
    });

    test('Promptfoo provider calls the shared harness rather than a second evaluator', async () => {
        const provider = new NoFriesProspectApplicationProvider({ config: { runtime: 'mock' } });
        const response = await provider.callApi('', {
            vars: { scenarioId: 'unknowns_are_not_invented' }
        });
        const scenario = JSON.parse(response.output);

        expect(provider.id()).toBe('nofries:prospect-application-path');
        expect(scenario).toMatchObject({ id: 'unknowns_are_not_invented', passed: true });
        expect(response.metadata).toMatchObject({
            suiteId: 'nofries-prospect-application-path',
            runtime: 'mock',
            scenarioId: 'unknowns_are_not_invented'
        });
        expect(response.metadata.datasetSha256).toMatch(/^[0-9a-f]{64}$/);
    });

    test('parses SSE frames and exposes repeatable CLI filters', () => {
        expect(parseSseEvents('event: ready\ndata: {"ok":true}\n\nevent: done\ndata: {"text":"Ready"}\n\n')).toEqual([
            { event: 'ready', data: { ok: true } },
            { event: 'done', data: { text: 'Ready' } }
        ]);
        expect(parseArgs([
            '--runtime=openai',
            '--scenario=one,two',
            '--scenario=three',
            '--output=/tmp/result.json',
            '--json'
        ])).toMatchObject({
            runtime: 'openai',
            scenarioIds: ['one', 'two', 'three'],
            outputPath: '/tmp/result.json',
            json: true
        });
        expect(sanitiseEvidenceText('My password is Summer2026!')).not.toContain('Summer2026!');
    });

    test('compares transcript and persisted agent-run usage across their two evidence shapes', () => {
        const usage = {
            inputTokens: 4311,
            outputTokens: 346,
            totalTokens: 4657,
            cachedInputTokens: 1144,
            cacheWriteTokens: 1097,
            reasoningTokens: 0
        };
        expect(sumUsage([{ usage }])).toEqual(usage);
        expect(sumUsage([usage])).toEqual(usage);
    });
});
