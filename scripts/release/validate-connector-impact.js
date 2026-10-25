'use strict';

const fs = require('fs');
const {
    validateConnectorArtifactEvidence,
    validateStandaloneConnectorImpact,
    validateUnifiedConnectorAdmission
} = require('./connector-production-release.js');

const CONNECTOR_TRANSITIVE_PATHS = Object.freeze(new Set([
    'api/shared/abuseProtection.js',
    'api/shared/browserAuth.js',
    'api/shared/browserSessionStore.js',
    'api/shared/customerSignup/customerIdentityProviderProfile.js',
    'api/shared/database/postgres.js',
    'api/shared/identity.js',
    'api/shared/lifecycle/customerOperations.js',
    'api/shared/lifecycle/lifecycleModel.js',
    'api/shared/lifecycle/lifecycleRepository.js',
    'api/shared/lifecycle/lifecycleService.js',
    'api/shared/lifecycle/lifecycleState.js',
    'api/shared/lifecycle/postgresLifecycleRepository.js',
    'api/shared/lifecycleRuntime.js',
    'api/shared/mcpAuth.js',
    'api/shared/mcpRuntime.js',
    'api/shared/nofriesCatalogue.js',
    'api/shared/proposalApprovalProvider.js',
    'api/shared/proposalApprovalSeal.js',
    'api/shared/releaseIdentity.js',
    'api/shared/releaseManifest.json',
    'api/shared/requestLimits.js',
    'api/shared/salesWorkspaceRepository.js',
    'api/shared/securityHeaders.js',
    'api/shared/tenantAccess.js',
    'package-lock.json'
]));

const CONNECTOR_RUNTIME_PACKAGE_FIELDS = Object.freeze([
    'cpu',
    'dependencies',
    'engines',
    'optionalDependencies',
    'os',
    'overrides'
]);
const CONNECTOR_PACKAGE_MANIFEST_PATH = 'release/connector-package-manifest.json';

function canonicalise(value) {
    if (Array.isArray(value)) return value.map(canonicalise);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalise(value[key])]));
    }
    return value;
}

function runtimePackageContract(packageJson) {
    if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
        throw new Error('connector_package_json_invalid');
    }
    return canonicalise(Object.fromEntries(CONNECTOR_RUNTIME_PACKAGE_FIELDS.map((field) => [
        field,
        Object.prototype.hasOwnProperty.call(packageJson, field) ? packageJson[field] : null
    ])));
}

function connectorPackageInputs(manifest) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
        !Array.isArray(manifest.metadataInputs) || !Array.isArray(manifest.entrypoints) ||
        !Array.isArray(manifest.strictTrees) || !Array.isArray(manifest.files) ||
        !Array.isArray(manifest.generatedFiles)) {
        throw new Error('connector_package_manifest_invalid');
    }
    const inputs = [
        ...manifest.metadataInputs,
        ...manifest.entrypoints,
        ...manifest.strictTrees.flatMap((entry) => entry && Array.isArray(entry.allowedFiles) ? entry.allowedFiles : []),
        ...manifest.files.map((entry) => entry && entry.source),
        ...manifest.generatedFiles.map((entry) => entry && entry.source)
    ];
    for (const relativePath of inputs) {
        if (typeof relativePath !== 'string' || !relativePath || relativePath.startsWith('/') ||
            relativePath.includes('\\') || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
            throw new Error('connector_package_manifest_source_invalid');
        }
    }
    return new Set(inputs.filter((entry) => entry !== 'package.json'));
}

function classifyConnectorImpact(paths, packageJson = {}, connectorManifest = null) {
    if (!Array.isArray(paths) || paths.some((value) => typeof value !== 'string')) {
        throw new Error('connector_impact_paths_invalid');
    }
    for (const relativePath of paths) {
        if (!relativePath || relativePath.startsWith('/') || relativePath.includes('\\') ||
            relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
            throw new Error('connector_impact_path_invalid');
        }
    }
    const changed = [...new Set(paths)].sort();
    const manifestInputs = connectorManifest ? connectorPackageInputs(connectorManifest) : new Set();
    const impacts = changed.filter((relativePath) => (
        relativePath === CONNECTOR_PACKAGE_MANIFEST_PATH ||
        relativePath === 'connector-server.js' ||
        relativePath.startsWith('connector-functions/') ||
        CONNECTOR_TRANSITIVE_PATHS.has(relativePath) ||
        manifestInputs.has(relativePath)
    ));
    if (changed.includes('package.json')) {
        const before = JSON.stringify(runtimePackageContract(packageJson.before));
        const after = JSON.stringify(runtimePackageContract(packageJson.after));
        if (before !== after) impacts.push('package.json');
    }
    impacts.sort();
    return Object.freeze({
        safe: impacts.length === 0,
        impacts: Object.freeze(impacts)
    });
}

function runCli(argv = process.argv.slice(2)) {
    const options = Object.create(null);
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        if (!/^--[a-z-]+$/.test(flag || '')) {
            throw new Error('connector_impact_validator_arguments_invalid');
        }
        const name = flag.slice(2);
        if (Object.prototype.hasOwnProperty.call(options, name)) {
            throw new Error('connector_impact_validator_arguments_invalid');
        }
        if (name === 'package-json') {
            if (!argv[index + 1] || !argv[index + 2] || argv[index + 1].startsWith('--') || argv[index + 2].startsWith('--')) {
                throw new Error('connector_impact_validator_arguments_invalid');
            }
            options[name] = [argv[index + 1], argv[index + 2]];
            index += 2;
        } else {
            if (!argv[index + 1] || argv[index + 1].startsWith('--')) {
                throw new Error('connector_impact_validator_arguments_invalid');
            }
            options[name] = argv[index + 1];
            index += 1;
        }
    }
    const baseOptions = ['package-json', 'paths'];
    for (const name of baseOptions) {
        if (!options[name]) throw new Error('connector_impact_validator_arguments_invalid');
    }
    const paths = fs.readFileSync(options.paths, 'utf8').split('\0').filter(Boolean);
    const packageJson = {
        before: JSON.parse(fs.readFileSync(options['package-json'][0], 'utf8')),
        after: JSON.parse(fs.readFileSync(options['package-json'][1], 'utf8'))
    };
    const connectorManifest = JSON.parse(fs.readFileSync(CONNECTOR_PACKAGE_MANIFEST_PATH, 'utf8'));
    const result = classifyConnectorImpact(paths, packageJson, connectorManifest);
    if (options.operation) {
        const appOptions = ['app-paths', 'app-package-json'];
        const withApp = appOptions.some(name => Object.hasOwn(options, name));
        const standaloneOptions = [...baseOptions, 'operation', ...(withApp ? appOptions : [])].sort();
        if (options.operation !== 'standalone' ||
            JSON.stringify(Object.keys(options).sort()) !== JSON.stringify(standaloneOptions)) {
            throw new Error('connector_impact_standalone_arguments_invalid');
        }
        const appImpact = withApp ? classifyConnectorImpact(
            fs.readFileSync(options['app-paths'], 'utf8').split('\0').filter(Boolean), {
                before: JSON.parse(fs.readFileSync(options['app-package-json'], 'utf8')),
                after: packageJson.after
            }, connectorManifest) : undefined;
        return validateStandaloneConnectorImpact(result, appImpact);
    }
    if (result.safe) {
        if (Object.keys(options).some((name) => !baseOptions.includes(name))) {
            throw new Error('connector_impact_safe_admission_forbidden');
        }
        return result;
    }
    const evidenceOptions = [
        'app-baseline-sha', 'artifact-metadata', 'artifact-zip',
        'candidate-archive', 'candidate-manifest', 'live-connector',
        'package-bundle', 'package-bundle-digest', 'recovery-bundle',
        'release-manifest', 'release-manifest-digest',
        'rollback-archive', 'rollback-control', 'rollback-lineage', 'rollback-manifest',
        'rollback-validation', 'standalone-run', 'target-sha'
    ];
    const expectedOptions = [...baseOptions, ...evidenceOptions].sort();
    if (JSON.stringify(Object.keys(options).sort()) !== JSON.stringify(expectedOptions)) {
        throw new Error(`connector_impact_requires_separate_release:${result.impacts.join(',')}`);
    }
    const releaseManifestBytes = fs.readFileSync(options['release-manifest']);
    const packageBundleBytes = fs.readFileSync(options['package-bundle']);
    const releaseManifest = JSON.parse(releaseManifestBytes.toString('utf8'));
    const packageBundle = JSON.parse(packageBundleBytes.toString('utf8'));
    const standaloneRun = JSON.parse(fs.readFileSync(options['standalone-run'], 'utf8'));
    const runId = String(standaloneRun.runId || '');
    const runAttempt = String(standaloneRun.runAttempt || '');
    const artifactEvidence = validateConnectorArtifactEvidence({
        metadata: JSON.parse(fs.readFileSync(options['artifact-metadata'], 'utf8')),
        artifactZip: fs.readFileSync(options['artifact-zip']),
        recoveryBundle: fs.readFileSync(options['recovery-bundle']),
        releaseManifest: releaseManifestBytes,
        releaseManifestDigest: fs.readFileSync(options['release-manifest-digest']),
        packageBundle: packageBundleBytes,
        packageBundleDigest: fs.readFileSync(options['package-bundle-digest']),
        candidateArchive: fs.readFileSync(options['candidate-archive']),
        candidatePackageManifest: fs.readFileSync(options['candidate-manifest']),
        rollbackArchive: fs.readFileSync(options['rollback-archive']),
        rollbackPackageManifest: fs.readFileSync(options['rollback-manifest']),
        rollbackControl: fs.readFileSync(options['rollback-control']),
        rollbackLineage: fs.readFileSync(options['rollback-lineage']),
        rollbackValidation: fs.readFileSync(options['rollback-validation'])
    }, { runId, runAttempt }, releaseManifest, packageBundle);
    const admission = validateUnifiedConnectorAdmission({
        appBaselineSha: options['app-baseline-sha'],
        connectorImpact: result,
        targetSha: options['target-sha'],
        liveConnector: JSON.parse(fs.readFileSync(options['live-connector'], 'utf8')),
        standaloneRun,
        releaseManifest,
        packageBundle
    }, artifactEvidence);
    return Object.freeze({ ...result, admission });
}

if (require.main === module) {
    try {
        runCli();
        process.stdout.write('Connector impact validation passed.\n');
    } catch (error) {
        console.error(`Unified production release blocked: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    CONNECTOR_TRANSITIVE_PATHS,
    CONNECTOR_RUNTIME_PACKAGE_FIELDS,
    CONNECTOR_PACKAGE_MANIFEST_PATH,
    classifyConnectorImpact,
    connectorPackageInputs,
    runtimePackageContract,
    runCli
};
