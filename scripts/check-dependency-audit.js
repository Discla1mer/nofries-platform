'use strict';

const fs = require('fs');
const path = require('path');
const { verifyVendor } = require('./verify-adm-zip-memory-only');

const ROOT = path.resolve(__dirname, '..');
const EXCEPTIONS_PATH = path.join(ROOT, 'security', 'dependency-audit-exceptions.json');
const ALLOWED_SEVERITIES = new Set(['info', 'low', 'moderate', 'high', 'critical']);
const BLOCKING_SEVERITIES = new Set(['high', 'critical']);
// GHSA-xcx6-jx8p-x3h5 is remediated: every locked @azure/msal-node copy is a
// fixed release (docs/msal-dependency-compatibility.md). Its temporary High
// acceptance expired on 2026-10-27 and is retired, so no audit finding is
// filtered here. The lock check below still fails closed if a vulnerable copy
// returns, even when the advisory database does not report it.
const MSAL_ADVISORY = 'GHSA-XCX6-JX8P-X3H5';
const SURFACES = Object.freeze([
    {
        id: 'root-all',
        manifestPath: path.join(ROOT, 'package.json'),
        lockPath: path.join(ROOT, 'package-lock.json'),
        allowManifestOverrides: true
    },
    {
        id: 'api-runtime',
        manifestPath: path.join(ROOT, 'api', 'package.json'),
        lockPath: path.join(ROOT, 'api', 'package-lock.json'),
        allowManifestOverrides: false
    }
]);

function rejectUnsupportedShrinkwrap(rootDirectory = ROOT, exists = fs.existsSync) {
    const paths = [
        path.join(rootDirectory, 'npm-shrinkwrap.json'),
        path.join(rootDirectory, 'api', 'npm-shrinkwrap.json')
    ];
    const present = paths.filter((candidate) => exists(candidate));
    if (present.length > 0) {
        throw new Error(
            'npm-shrinkwrap.json is unsupported because it overrides the governed package-lock.json: ' +
            present.map((candidate) => path.relative(rootDirectory, candidate)).join(', ')
        );
    }
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function uniqueSorted(values) {
    return [...new Set(values)].sort();
}

// npm aliases can install MSAL under an arbitrary package path. Use both
// package identity and dependency declarations rather than trusting the path.
// An unresolved or malformed MSAL alias represents an unknown closure node.
function lockedMsalNodes(lock) {
    const nodes = new Map();
    for (const [nodePath, entry] of Object.entries(lock.packages)) {
        if (nodePath.endsWith('/@azure/msal-node') || entry?.name === '@azure/msal-node') {
            nodes.set(nodePath, entry?.name && entry.name !== '@azure/msal-node' ? null : entry);
        }
        for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
            for (const [alias, declaration] of Object.entries(entry?.[field] || {})) {
                if (typeof declaration !== 'string' ||
                    !/^npm:@azure\/msal-node(?:@|$)/.test(declaration)) continue;
                const validDeclaration = /^npm:@azure\/msal-node(?:@[^\s@][^@]*)?$/.test(declaration) &&
                    declaration.trim() === declaration;
                let directory = nodePath;
                let resolved = null;
                if (/^(?:@[^/]+\/)?[^/.][^/]*$/.test(alias)) {
                    while (true) {
                        if (path.posix.basename(directory) !== 'node_modules') {
                            const candidate = (directory ? directory + '/' : '') + 'node_modules/' + alias;
                            if (Object.hasOwn(lock.packages, candidate)) { resolved = candidate; break; }
                        }
                        if (!directory) break;
                        const parent = path.posix.dirname(directory);
                        if (parent === directory) break;
                        directory = parent === '.' ? '' : parent;
                    }
                }
                if (!validDeclaration || !resolved ||
                    (lock.packages[resolved]?.name && lock.packages[resolved].name !== '@azure/msal-node')) {
                    nodes.set(`${nodePath}:${field}:${alias}`, null);
                } else {
                    nodes.set(resolved, lock.packages[resolved]);
                }
            }
        }
    }
    return [...nodes.entries()];
}

// Fail closed on unknown or prerelease declarations. Only canonical stable
// versions conclusively outside GHSA-xcx6-jx8p-x3h5 count as remediated.
function hasRemediatedMsalClosure(lock) {
    return lockedMsalNodes(lock).every(([, entry]) => {
        const match = typeof entry?.version === 'string' &&
            /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(entry.version);
        if (!match) return false;
        const versions = match.slice(1).map(Number);
        if (!versions.every(Number.isSafeInteger)) return false;
        const [major, minor] = versions;
        return major < 5 || major > 7 || (major === 7 && minor >= 1);
    });
}

function assertRemediatedMsalClosure(surfaceId, lock) {
    if (!lock || !lock.packages || typeof lock.packages !== 'object') {
        throw new Error(`${surfaceId}: package lock does not expose an audited packages map`);
    }
    if (!hasRemediatedMsalClosure(lock)) {
        throw new Error(
            `${surfaceId}: locked @azure/msal-node closure is not remediated for ${MSAL_ADVISORY}; ` +
            'its temporary acceptance expired and is retired'
        );
    }
}

function advisoryIdentity(advisory) {
    const text = `${advisory.url || ''} ${advisory.source || ''}`;
    const ghsa = text.match(/GHSA-[0-9a-z-]+/i);
    if (ghsa) return ghsa[0].toUpperCase();
    if (advisory.source !== undefined && advisory.source !== null) {
        return `SOURCE-${String(advisory.source)}`;
    }
    throw new Error('npm audit advisory is missing a stable identifier');
}

function collectAdvisoryIds(packageName, vulnerabilities, visited = new Set()) {
    if (visited.has(packageName)) return [];
    visited.add(packageName);
    const vulnerability = vulnerabilities[packageName];
    if (!vulnerability || !Array.isArray(vulnerability.via)) return [];

    const identities = [];
    for (const via of vulnerability.via) {
        if (typeof via === 'string') {
            identities.push(...collectAdvisoryIds(via, vulnerabilities, visited));
        } else if (via && typeof via === 'object') {
            identities.push(advisoryIdentity(via));
        }
    }
    return uniqueSorted(identities);
}

function normaliseAuditReport(surfaceId, report, lock) {
    if (!report || report.auditReportVersion !== 2 || report.error ||
        !report.vulnerabilities || typeof report.vulnerabilities !== 'object' ||
        Array.isArray(report.vulnerabilities)) {
        throw new Error(`${surfaceId}: unsupported or failed npm audit JSON response`);
    }
    const packages = lock && lock.packages;
    if (!packages || typeof packages !== 'object') {
        throw new Error(`${surfaceId}: package lock does not expose an audited packages map`);
    }

    return Object.entries(report.vulnerabilities).map(([packageName, vulnerability]) => {
        const severity = String(vulnerability.severity || '').toLowerCase();
        if (!ALLOWED_SEVERITIES.has(severity)) {
            throw new Error(`${surfaceId}/${packageName}: unsupported severity ${severity || '<empty>'}`);
        }
        const nodePaths = uniqueSorted(Array.isArray(vulnerability.nodes) ? vulnerability.nodes : []);
        if (nodePaths.length === 0) {
            throw new Error(`${surfaceId}/${packageName}: vulnerability has no installed node path`);
        }
        const versions = uniqueSorted(nodePaths.map((nodePath) => {
            const version = packages[nodePath] && packages[nodePath].version;
            if (!version) throw new Error(`${surfaceId}/${packageName}: version missing for ${nodePath}`);
            return String(version);
        }));
        if (versions.length !== 1) {
            throw new Error(`${surfaceId}/${packageName}: multiple installed versions require separate review`);
        }
        const advisoryIds = collectAdvisoryIds(packageName, report.vulnerabilities);
        if (advisoryIds.length === 0) {
            throw new Error(`${surfaceId}/${packageName}: no stable advisory identity was found`);
        }
        return {
            surface: surfaceId,
            package: packageName,
            version: versions[0],
            severity,
            advisoryIds,
            nodePaths
        };
    }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function rejectWildcards(value, label) {
    const strings = Array.isArray(value) ? value : [value];
    if (strings.some((item) => typeof item !== 'string' || !item || item.includes('*'))) {
        throw new Error(`${label} must contain non-empty exact values without wildcards`);
    }
}

function validateExceptionRegistry(registry) {
    const topKeys = Object.keys(registry || {}).sort();
    if (JSON.stringify(topKeys) !== JSON.stringify(['exceptions', 'schemaVersion'])) {
        throw new Error('dependency audit exception registry has unknown or missing top-level fields');
    }
    if (registry.schemaVersion !== 1 || !Array.isArray(registry.exceptions)) {
        throw new Error('dependency audit exception registry must use schemaVersion 1 and an exceptions array');
    }
    const requiredKeys = [
        'acceptedAt', 'advisoryIds', 'affectedCapabilities', 'expiresAt', 'id', 'mitigations',
        'nodePaths', 'owner', 'package', 'promotionConditions', 'reachability', 'scope',
        'severity', 'sourceUrls', 'status', 'surfaces', 'targetMilestone', 'trackingId', 'version'
    ].sort();
    const ids = new Set();
    const matchKeys = new Set();
    for (const exception of registry.exceptions) {
        if (JSON.stringify(Object.keys(exception || {}).sort()) !== JSON.stringify(requiredKeys)) {
            throw new Error('dependency audit exception has unknown or missing fields');
        }
        rejectWildcards(exception.id, 'exception id');
        if (ids.has(exception.id)) throw new Error(`duplicate dependency audit exception ${exception.id}`);
        ids.add(exception.id);
        if (exception.status !== 'accepted' || exception.scope !== 'build-only') {
            throw new Error(`${exception.id}: only accepted build-only exceptions are valid`);
        }
        if (!['low', 'moderate'].includes(exception.severity)) {
            throw new Error(`${exception.id}: only Low or Moderate findings may be excepted`);
        }
        rejectWildcards(exception.package, `${exception.id} package`);
        rejectWildcards(exception.version, `${exception.id} version`);
        rejectWildcards(exception.surfaces, `${exception.id} surfaces`);
        rejectWildcards(exception.advisoryIds, `${exception.id} advisory IDs`);
        rejectWildcards(exception.nodePaths, `${exception.id} node paths`);
        for (const field of ['trackingId', 'owner', 'reachability', 'targetMilestone']) {
            rejectWildcards(exception[field], `${exception.id} ${field}`);
        }
        for (const field of ['affectedCapabilities', 'mitigations', 'promotionConditions', 'sourceUrls']) {
            rejectWildcards(exception[field], `${exception.id} ${field}`);
        }
        for (const field of ['surfaces', 'advisoryIds', 'nodePaths']) {
            if (uniqueSorted(exception[field]).length !== exception[field].length) {
                throw new Error(`${exception.id}: ${field} must not contain duplicates`);
            }
        }
        for (const surface of exception.surfaces) {
            if (!SURFACES.some((candidate) => candidate.id === surface)) {
                throw new Error(`${exception.id}: unsupported audit surface ${surface}`);
            }
            const matchKey = JSON.stringify({
                surface,
                severity: exception.severity,
                package: exception.package,
                version: exception.version,
                advisoryIds: uniqueSorted(exception.advisoryIds),
                nodePaths: uniqueSorted(exception.nodePaths)
            });
            if (matchKeys.has(matchKey)) {
                throw new Error(`${exception.id}: duplicate exception match tuple for ${surface}`);
            }
            matchKeys.add(matchKey);
        }
        const acceptedAt = Date.parse(exception.acceptedAt);
        const expiresAt = Date.parse(exception.expiresAt);
        if (!Number.isFinite(acceptedAt) || !Number.isFinite(expiresAt) || expiresAt <= acceptedAt) {
            throw new Error(`${exception.id}: acceptedAt and expiresAt must define a valid bounded period`);
        }
    }
    return registry;
}

function exceptionMatches(finding, exception, now = new Date()) {
    return exception.status === 'accepted' &&
        exception.scope === 'build-only' &&
        Date.parse(exception.acceptedAt) <= now.getTime() &&
        Date.parse(exception.expiresAt) > now.getTime() &&
        exception.severity === finding.severity &&
        exception.package === finding.package &&
        exception.version === finding.version &&
        exception.surfaces.includes(finding.surface) &&
        JSON.stringify(uniqueSorted(exception.advisoryIds)) === JSON.stringify(finding.advisoryIds) &&
        JSON.stringify(uniqueSorted(exception.nodePaths)) === JSON.stringify(finding.nodePaths);
}

function evaluateFindings(findings, { dependencyChanged, exceptions, now = new Date() }) {
    const blocked = [];
    const accepted = [];
    const matchedExceptionSurfaces = new Set();
    for (const finding of findings) {
        if (BLOCKING_SEVERITIES.has(finding.severity)) {
            blocked.push({ finding, reason: 'High/Critical findings always block the build lane' });
            continue;
        }
        const matches = dependencyChanged
            ? exceptions.filter((candidate) => exceptionMatches(finding, candidate, now))
            : [];
        if (finding.severity === 'moderate' && dependencyChanged) {
            if (matches.length === 0) {
                blocked.push({ finding, reason: 'new or changed Moderate finding on a dependency-changing change' });
                continue;
            }
            if (matches.length > 1) {
                blocked.push({ finding, reason: 'more than one exception matches the same finding' });
                continue;
            }
            const exception = matches[0];
            matchedExceptionSurfaces.add(`${exception.id}\u0000${finding.surface}`);
            accepted.push({ finding, exceptionId: exception.id });
        } else if (matches.length === 1) {
            matchedExceptionSurfaces.add(`${matches[0].id}\u0000${finding.surface}`);
        }
    }
    const staleExceptions = [];
    if (dependencyChanged) {
        for (const exception of exceptions) {
            if (Date.parse(exception.acceptedAt) > now.getTime() ||
                Date.parse(exception.expiresAt) <= now.getTime()) continue;
            for (const surface of exception.surfaces) {
                if (!matchedExceptionSurfaces.has(`${exception.id}\u0000${surface}`)) {
                    staleExceptions.push({
                        exceptionId: exception.id,
                        surface,
                        reason: 'active exception does not exactly match a current finding'
                    });
                }
            }
        }
    }
    return { blocked, accepted, staleExceptions };
}

function sortedMap(value) {
    return Object.fromEntries(Object.entries(value || {}).sort(([left], [right]) => left.localeCompare(right)));
}

// This is a reviewed cross-major compatibility override, not general API
// override permission. The exact direct pin and every locked MSAL node bind it
// to the API closure audited and exercised by the offline SDK tests.
function isReviewedApiMsalOverride(surfaceId, manifest, lock) {
    if (surfaceId !== 'api-runtime' ||
        manifest.dependencies?.['@azure/msal-node'] !== '7.1.1' ||
        JSON.stringify(manifest.overrides) !==
            JSON.stringify({ '@azure/identity': { '@azure/msal-node': '7.1.1' } }) ||
        lock.packages['node_modules/@azure/identity']?.version !== '4.13.1') return false;
    const nodes = lockedMsalNodes(lock);
    return nodes.length === 1 && nodes[0][0] === 'node_modules/@azure/msal-node' &&
        nodes[0][1]?.version === '7.1.1';
}

function validateManifestLock(surfaceId, manifest, lock, { allowManifestOverrides = false } = {}) {
    if (!lock || lock.lockfileVersion !== 3 || !lock.packages || !lock.packages['']) {
        throw new Error(`${surfaceId}: package lock must use lockfileVersion 3 with a root package entry`);
    }
    const lockedRoot = lock.packages[''];
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        const requested = sortedMap(manifest[field]);
        const locked = sortedMap(lockedRoot[field]);
        if (JSON.stringify(requested) !== JSON.stringify(locked)) {
            throw new Error(`${surfaceId}: ${field} does not exactly match the package lock root entry`);
        }
    }
    if (Object.hasOwn(manifest, 'overrides') && (!manifest.overrides ||
        typeof manifest.overrides !== 'object' || Array.isArray(manifest.overrides))) {
        throw new Error(`${surfaceId}: malformed manifest overrides require an explicitly audited install closure`);
    }
    if (!allowManifestOverrides && manifest.overrides && Object.keys(manifest.overrides).length > 0 &&
        !isReviewedApiMsalOverride(surfaceId, manifest, lock)) {
        throw new Error(`${surfaceId}: manifest overrides require an explicitly audited install closure`);
    }
}

function validateConnectorClosure(rootLock, connectorManifest) {
    for (const field of [
        'devDependencies', 'optionalDependencies', 'peerDependencies',
        'bundledDependencies', 'bundleDependencies', 'overrides'
    ]) {
        const value = connectorManifest[field];
        if (value && (Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0)) {
            throw new Error(`connector ${field} is unsupported without its own audited lock closure`);
        }
    }
    const dependencies = connectorManifest.dependencies || {};
    for (const [packageName, requestedVersion] of Object.entries(dependencies)) {
        if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(requestedVersion)) {
            throw new Error(`connector dependency ${packageName} must use an exact version`);
        }
        const nodePath = `node_modules/${packageName}`;
        const lockedVersion = rootLock.packages && rootLock.packages[nodePath] && rootLock.packages[nodePath].version;
        if (lockedVersion !== requestedVersion) {
            throw new Error(
                `connector dependency ${packageName}@${requestedVersion} is not covered by the root audited closure`
            );
        }
    }
}

function loadAuditFindings(surface, reportPath) {
    if (!reportPath) throw new Error(`${surface.id}: an audit report path is required`);
    try {
        const lock = readJson(surface.lockPath);
        assertRemediatedMsalClosure(surface.id, lock);
        return normaliseAuditReport(surface.id, readJson(reportPath), lock);
    } catch (error) {
        throw new Error(`${surface.id}: ${error.message}`);
    }
}

function parseArguments(argv, env) {
    const options = {
        dependencyChanged: env.NOFRIES_DEPENDENCY_CHANGED === 'true',
        connectorDependencyChanged: env.NOFRIES_CONNECTOR_DEPENDENCY_CHANGED === 'true',
        reports: {
            'root-all': env.NOFRIES_ROOT_AUDIT_REPORT || null,
            'api-runtime': env.NOFRIES_API_AUDIT_REPORT || null
        }
    };
    const releaseFlags = {
        '--release-root-optional-report': 'root-optional',
        '--release-root-runtime-report': 'root-runtime',
        '--release-api-runtime-report': 'api-production'
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--dependency-changed') {
            options.dependencyChanged = true;
        } else if (argument === '--connector-dependency-changed') {
            options.connectorDependencyChanged = true;
        } else if (argument === '--root-report' || argument === '--api-report' ||
            Object.hasOwn(releaseFlags, argument)) {
            const reportPath = argv[index + 1];
            if (!reportPath || reportPath.startsWith('--')) {
                throw new Error(`${argument} requires a path`);
            }
            if (Object.hasOwn(releaseFlags, argument)) {
                options.releaseReports ||= {};
                options.releaseReports[releaseFlags[argument]] = reportPath;
            } else {
                options.reports[argument === '--root-report' ? 'root-all' : 'api-runtime'] = reportPath;
            }
            index += 1;
        } else {
            throw new Error(`unknown argument: ${argument}`);
        }
    }
    if (options.connectorDependencyChanged && !options.dependencyChanged) {
        throw new Error('connector dependency changes must also use the changed-dependency policy');
    }
    if (options.releaseReports) {
        if (options.dependencyChanged || options.connectorDependencyChanged ||
            Object.values(options.reports).some(Boolean)) {
            throw new Error('release audit mode cannot combine with build audit arguments');
        }
        for (const surfaceId of Object.keys(releaseFlags).map((flag) => releaseFlags[flag])) {
            if (!options.releaseReports[surfaceId]) {
                throw new Error(`${surfaceId}: a release audit report path is required`);
            }
        }
    }
    if (options.dependencyChanged) {
        for (const surface of SURFACES) {
            if (!options.reports[surface.id]) {
                throw new Error(`${surface.id}: an audit report path is required for a dependency-changing build`);
            }
        }
    }
    return options;
}

function main() {
    const { dependencyChanged, connectorDependencyChanged, reports, releaseReports } =
        parseArguments(process.argv.slice(2), process.env);
    const registry = validateExceptionRegistry(readJson(EXCEPTIONS_PATH));
    rejectUnsupportedShrinkwrap();
    verifyVendor();
    if (!dependencyChanged && !releaseReports) {
        process.stdout.write(
            'No dependency surface or source artifact changed; reusing the protected-main dependency baseline. ' +
            'Tracked lower-severity debt remains visible in the exception registry and release gate.\n'
        );
        return;
    }
    if (connectorDependencyChanged) {
        validateConnectorClosure(
            readJson(path.join(ROOT, 'package-lock.json')),
            readJson(path.join(ROOT, 'connector-functions', 'package.json'))
        );
    }
    for (const surface of SURFACES) {
        validateManifestLock(
            surface.id,
            readJson(surface.manifestPath),
            readJson(surface.lockPath),
            { allowManifestOverrides: surface.allowManifestOverrides }
        );
    }
    const auditedSurfaces = releaseReports ? [
        { id: 'root-optional', lockPath: SURFACES[0].lockPath },
        { id: 'root-runtime', lockPath: SURFACES[0].lockPath },
        { id: 'api-production', lockPath: SURFACES[1].lockPath }
    ] : SURFACES;
    const findings = auditedSurfaces.flatMap((surface) =>
        loadAuditFindings(surface,
            releaseReports ? releaseReports[surface.id] : reports[surface.id])
    );

    for (const finding of findings) {
        process.stdout.write(
            `[${finding.surface}] ${finding.severity.toUpperCase()} ${finding.package}@${finding.version} ` +
            `${finding.advisoryIds.join(', ')} (${finding.nodePaths.join(', ')})\n`
        );
    }
    if (findings.length === 0) {
        process.stdout.write('No dependency vulnerabilities reported.\n');
    }

    const result = releaseReports ? {
        blocked: findings.filter((finding) =>
            ['moderate', 'high', 'critical'].includes(finding.severity))
            .map((finding) => ({ finding, reason: 'frozen release Moderate/High/Critical gate' })),
        accepted: [], staleExceptions: []
    } : evaluateFindings(findings, {
        dependencyChanged, exceptions: registry.exceptions
    });
    for (const item of result.accepted) {
        process.stdout.write(
            `Accepted build-only exception ${item.exceptionId}: ` +
            `${item.finding.surface}/${item.finding.package}@${item.finding.version}\n`
        );
    }
    for (const item of result.staleExceptions) {
        process.stderr.write(
            `BLOCKED ${item.exceptionId}/${item.surface}: ${item.reason}\n`
        );
    }
    if (result.blocked.length > 0 || result.staleExceptions.length > 0) {
        for (const item of result.blocked) {
            process.stderr.write(
                `BLOCKED ${item.finding.surface}/${item.finding.package}@${item.finding.version}: ` +
                `${item.reason}\n`
            );
        }
        process.exitCode = 1;
        return;
    }
    process.stdout.write(releaseReports
        ? 'Frozen release dependency audit passed: no Moderate, High or Critical findings.\n'
        : 'Dependency-changing build passed: no High/Critical findings and every Moderate is exactly dispositioned.\n');
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        process.stderr.write(`Dependency audit failed closed: ${error.message}\n`);
        process.exitCode = 1;
    }
}

module.exports = {
    assertRemediatedMsalClosure,
    collectAdvisoryIds,
    evaluateFindings,
    exceptionMatches,
    loadAuditFindings,
    normaliseAuditReport,
    parseArguments,
    rejectUnsupportedShrinkwrap,
    validateConnectorClosure,
    validateExceptionRegistry,
    validateManifestLock
};
