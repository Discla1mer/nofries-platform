#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
    loadProspectEvalDataset,
    normaliseScenarioIds,
    runProspectEvalSuite
} = require('../evals/prospect-harness');

async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    if (options.help) {
        process.stdout.write(helpText());
        return 0;
    }
    if (options.list) {
        const loaded = loadProspectEvalDataset(options.datasetPath);
        process.stdout.write(`${loaded.dataset.scenarios.map((scenario) => scenario.id).join('\n')}\n`);
        return 0;
    }

    const result = await runProspectEvalSuite({
        runtime: options.runtime,
        scenarioIds: options.scenarioIds,
        datasetPath: options.datasetPath
    });
    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (options.outputPath) writeJsonArtifact(options.outputPath, json);
    if (options.json) process.stdout.write(json);
    else process.stdout.write(renderSummary(result));
    return result.summary.failed === 0 ? 0 : 1;
}

function parseArgs(args) {
    const runtimeArgs = valuesFor(args, '--runtime');
    const runtime = runtimeArgs.length ? runtimeArgs[runtimeArgs.length - 1] : 'mock';
    if (!['mock', 'openai'].includes(runtime)) throw new Error('Runtime must be mock or openai');
    const outputArgs = valuesFor(args, '--output');
    const datasetArgs = valuesFor(args, '--dataset');
    return {
        runtime,
        scenarioIds: normaliseScenarioIds(valuesFor(args, '--scenario')),
        outputPath: outputArgs.length ? outputArgs[outputArgs.length - 1] : '',
        datasetPath: datasetArgs.length ? datasetArgs[datasetArgs.length - 1] : undefined,
        json: args.includes('--json'),
        list: args.includes('--list'),
        help: args.includes('--help') || args.includes('-h')
    };
}

function valuesFor(args, name) {
    return args
        .filter((value) => String(value).startsWith(`${name}=`))
        .map((value) => String(value).slice(name.length + 1).trim())
        .filter(Boolean);
}

function writeJsonArtifact(outputPath, json) {
    const absolutePath = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, json, { encoding: 'utf8', mode: 0o600 });
}

function renderSummary(result) {
    const lines = result.scenarios.map((scenario) => {
        const detail = scenario.passed
            ? ''
            : ` — ${scenario.failedAssertions.join(', ')}`;
        return `${scenario.passed ? 'PASS' : 'FAIL'}  ${scenario.id}${detail}`;
    });
    lines.push('');
    lines.push(`${result.summary.passed}/${result.summary.total} scenarios passed (${result.run.runtime}).`);
    lines.push(`Suite ${result.suite.id}@${result.suite.version}; harness ${result.harness.version}.`);
    lines.push(`Usage ${result.run.usage.totalTokens} tokens; approximate cost USD ${result.run.approximateCostUsd.toFixed(6)}.`);
    return `${lines.join('\n')}\n`;
}

function helpText() {
    return [
        'Usage: node scripts/run-prospect-evals.js [options]',
        '',
        'Options:',
        '  --runtime=mock|openai       Select the deterministic or OpenAI runtime.',
        '  --scenario=<id>[,<id>]      Run one or more exact scenario IDs; repeatable.',
        '  --dataset=<path>            Override the scenario dataset.',
        '  --output=<path>             Write the versioned JSON result to this path.',
        '  --json                      Emit only the versioned JSON result on stdout.',
        '  --list                      List scenario IDs without running them.',
        '  --help                      Show this help.',
        ''
    ].join('\n');
}

if (require.main === module) {
    main().then((exitCode) => {
        process.exitCode = exitCode;
    }).catch((error) => {
        process.stderr.write(`Prospect evaluation failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    helpText,
    main,
    parseArgs,
    renderSummary,
    valuesFor,
    writeJsonArtifact
};
