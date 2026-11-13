const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const yaml = require('js-yaml');

const {
    assertRemediatedMsalClosure,
    evaluateFindings,
    normaliseAuditReport,
    parseArguments,
    rejectUnsupportedShrinkwrap,
    validateConnectorClosure,
    validateExceptionRegistry,
    validateManifestLock
} = require('../scripts/check-dependency-audit');

const NOW = new Date('2026-09-10T00:00:00Z');
const MSAL_URL = 'https://github.com/advisories/GHSA-xcx6-jx8p-x3h5';
const ROOT_MSAL_NODES = [
    'node_modules/@azure/msal-node',
    'node_modules/promptfoo/node_modules/@azure/identity/node_modules/@azure/msal-node',
    'node_modules/promptfoo/node_modules/@azure/msal-node'
];

// The remediated root closure: every MSAL copy is 7.1.1.
function remediatedLockFixture() {
    const packages = {
        'node_modules/@azure/identity': { version: '4.13.1' },
        'node_modules/promptfoo/node_modules/@azure/identity': { version: '4.13.3' },
        'node_modules/promptfoo': { version: '0.124.0' },
        'node_modules/hono': { version: '4.13.11' },
        'node_modules/@hono/node-server': { version: '2.1.3' }
    };
    for (const node of ROOT_MSAL_NODES) packages[node] = { version: '7.1.1' };
    return { packages };
}

// The npm 10.9.4 projection that broke main: promptfoo is reported only
// because of non-MSAL Moderate advisories in its own dependency chain.
function nonMsalPromptfooReport() {
    return { auditReportVersion: 2, vulnerabilities: {
        hono: { name: 'hono', severity: 'moderate', nodes: ['node_modules/hono'],
            via: [{ url: 'https://github.com/advisories/GHSA-4m76-xfj5-7975', source: 1246368, severity: 'moderate' }] },
        '@hono/node-server': { name: '@hono/node-server', severity: 'moderate',
            nodes: ['node_modules/@hono/node-server'],
            via: [{ url: 'https://github.com/advisories/GHSA-qv5m-9pm6-hqp3', source: 1246356, severity: 'moderate' }, 'hono'] },
        promptfoo: { name: 'promptfoo', severity: 'moderate', nodes: ['node_modules/promptfoo'],
            via: ['@hono/node-server', 'hono'] }
    } };
}

function finding(overrides = {}) {
    return {
        surface: 'root-all',
        package: 'qs',
        version: '6.15.2',
        severity: 'moderate',
        advisoryIds: ['GHSA-X5FP-WJ9C-MXMX'],
        nodePaths: ['node_modules/qs'],
        ...overrides
    };
}

function exception(overrides = {}) {
    return {
        id: 'DEP-EXC-TEST',
        status: 'accepted',
        scope: 'build-only',
        trackingId: 'DEP-001',
        severity: 'moderate',
        advisoryIds: ['GHSA-X5FP-WJ9C-MXMX'],
        surfaces: ['root-all'],
        package: 'qs',
        version: '6.15.2',
        nodePaths: ['node_modules/qs'],
        reachability: 'Bounded test evidence.',
        mitigations: ['Exact match only.'],
        affectedCapabilities: ['Query parsing.'],
        owner: 'Discla1mer',
        acceptedAt: '2026-09-04T00:00:00Z',
        expiresAt: '2026-10-04T00:00:00Z',
        targetMilestone: 'First-Customer Security Gate',
        promotionConditions: ['Severity changes.'],
        sourceUrls: ['https://github.com/advisories/GHSA-x5fp-wj9c-mxmx'],
        ...overrides
    };
}

describe('build-lane dependency audit policy', () => {
    test('a remediated MSAL closure filters nothing: non-MSAL promptfoo findings are evaluated normally', () => {
        const lock = remediatedLockFixture();
        expect(() => assertRemediatedMsalClosure('root-all', lock)).not.toThrow();
        const findings = normaliseAuditReport('root-all', nonMsalPromptfooReport(), lock);
        expect(findings.map((item) => item.package).sort())
            .toEqual(['@hono/node-server', 'hono', 'promptfoo']);
        const promptfoo = findings.find((item) => item.package === 'promptfoo');
        expect(promptfoo.advisoryIds).toEqual(['GHSA-4M76-XFJ5-7975', 'GHSA-QV5M-9PM6-HQP3']);
        const result = evaluateFindings(findings, { dependencyChanged: true, exceptions: [], now: NOW });
        expect(result.blocked.map((item) => item.finding.package).sort())
            .toEqual(['@hono/node-server', 'hono', 'promptfoo']);
        expect(result.blocked.every((item) => /Moderate/.test(item.reason))).toBe(true);
    });

    test('an MSAL advisory finding is never filtered and always blocks as High', () => {
        const lock = remediatedLockFixture();
        const report = { auditReportVersion: 2, vulnerabilities: {
            '@azure/msal-node': { name: '@azure/msal-node', severity: 'high',
                nodes: ['node_modules/@azure/msal-node'],
                via: [{ url: MSAL_URL, source: 1243111, severity: 'high' }] },
            promptfoo: { name: 'promptfoo', severity: 'high', nodes: ['node_modules/promptfoo'],
                via: ['@azure/msal-node'] }
        } };
        const findings = normaliseAuditReport('root-all', report, lock);
        expect(findings.map((item) => item.package).sort()).toEqual(['@azure/msal-node', 'promptfoo']);
        expect(evaluateFindings(findings, { dependencyChanged: false, exceptions: [], now: NOW })
            .blocked).toHaveLength(2);
    });

    test('fails closed when any locked MSAL copy is vulnerable, prerelease or unknown', () => {
        for (const version of ['5.6.0', '6.0.1', '7.0.1', '7.1.1-beta.1', 'garbage', undefined, '07.1.1']) {
            for (const node of ROOT_MSAL_NODES) {
                const lock = remediatedLockFixture();
                lock.packages[node] = { version };
                expect(() => assertRemediatedMsalClosure('root-all', lock))
                    .toThrow(/not remediated for GHSA-XCX6-JX8P-X3H5/);
            }
            const hidden = remediatedLockFixture();
            hidden.packages['node_modules/optional-sdk/node_modules/@azure/msal-node'] = { version };
            expect(() => assertRemediatedMsalClosure('root-all', hidden)).toThrow(/not remediated/);
        }
        expect(() => assertRemediatedMsalClosure('root-all', { packages: {} })).not.toThrow();
        for (const lock of [null, {}, { packages: null }]) {
            expect(() => assertRemediatedMsalClosure('root-all', lock)).toThrow(/packages map/);
        }
    });

    test('recognizes MSAL identity and aliases, including hidden, malformed and unresolved copies', () => {
        const make = () => ({ packages: {
            '': { dependencies: { 'legacy-msal': 'npm:@azure/msal-node@7.0.1' } },
            'node_modules/@azure/msal-node': { version: '7.1.1' },
            'node_modules/legacy-msal': { name: '@azure/msal-node', version: '7.0.1' }
        } });
        const reject = lock => expect(() => assertRemediatedMsalClosure('root-all', lock))
            .toThrow(/not remediated/);
        reject(make());
        const identityOnly = make(); delete identityOnly.packages[''].dependencies;
        reject(identityOnly);
        const declarationOnly = make(); delete declarationOnly.packages['node_modules/legacy-msal'].name;
        reject(declarationOnly);
        for (const version of [undefined, null, 'garbage', '7.1.1-beta.1']) {
            const lock = make(); lock.packages['node_modules/legacy-msal'].version = version; reject(lock);
        }
        const unresolved = make(); delete unresolved.packages['node_modules/legacy-msal']; reject(unresolved);
        const malformed = make();
        malformed.packages[''].dependencies['legacy-msal'] = 'npm:@azure/msal-node@';
        malformed.packages['node_modules/legacy-msal'].version = '7.1.1'; reject(malformed);
        malformed.packages[''].dependencies['legacy-msal'] = 'npm:@azure/msal-node@@7.1.1'; reject(malformed);
        const conflicting = make(); conflicting.packages['node_modules/legacy-msal'] = { name: 'other', version: '7.1.1' };
        reject(conflicting);
        const nested = make(); delete nested.packages[''];
        nested.packages['node_modules/optional-sdk'] = { optionalDependencies: {
            'legacy-msal': 'npm:@azure/msal-node@7.0.1'
        } };
        delete nested.packages['node_modules/legacy-msal'].name; reject(nested);
        nested.packages['node_modules/legacy-msal'].version = '7.1.1';
        expect(() => assertRemediatedMsalClosure('root-all', nested)).not.toThrow();
        // Resolve the nearest nested copy rather than accepting a safe hoisted alias.
        nested.packages['node_modules/optional-sdk/node_modules/legacy-msal'] = { version: '7.0.1' };
        reject(nested);
    });

    test('the committed root and API locks are fully remediated', () => {
        for (const lockPath of ['../package-lock.json', '../api/package-lock.json']) {
            const lock = JSON.parse(fs.readFileSync(path.join(__dirname, lockPath)));
            expect(() => assertRemediatedMsalClosure(lockPath, lock)).not.toThrow();
        }
    });

    test('admits only the reviewed API Identity override and exact audited MSAL closure', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../api/package.json')));
        const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '../api/package-lock.json')));
        expect(() => validateManifestLock('api-runtime', manifest, lock)).not.toThrow();
        for (const overrides of [
            { '@azure/msal-node': '7.1.1' },
            { '@azure/identity': { '@azure/msal-node': '^7.1.1' } },
            { '@azure/identity': { '@azure/msal-node': '7.1.2' } },
            { '@azure/identity': '4.13.1' },
            { ...manifest.overrides, other: '1.0.0' },
            ['7.1.1'], [], null, '7.1.1', ''
        ]) expect(() => validateManifestLock('api-runtime', { ...manifest, overrides }, lock))
            .toThrow(/explicitly audited/);
        for (const mutate of [
            value => { value.packages['node_modules/@azure/msal-node'].version = '7.0.1'; },
            value => { value.packages['node_modules/@azure/identity'].version = '4.14.0'; },
            value => { value.packages['node_modules/other/node_modules/@azure/msal-node'] = { version: '7.1.1' }; }
        ]) {
            const changed = structuredClone(lock); mutate(changed);
            expect(() => validateManifestLock('api-runtime', manifest, changed)).toThrow(/explicitly audited/);
        }
        for (const version of ['7.0.1', '7.1.1', undefined]) {
            const aliasedManifest = structuredClone(manifest), aliasedLock = structuredClone(lock);
            aliasedManifest.dependencies['legacy-msal'] = 'npm:@azure/msal-node@7.0.1';
            aliasedLock.packages[''].dependencies['legacy-msal'] = aliasedManifest.dependencies['legacy-msal'];
            aliasedLock.packages['node_modules/legacy-msal'] = { name: '@azure/msal-node', version };
            expect(() => validateManifestLock('api-runtime', aliasedManifest, aliasedLock)).toThrow(/explicitly audited/);
            delete aliasedLock.packages['node_modules/legacy-msal'].name;
            expect(() => validateManifestLock('api-runtime', aliasedManifest, aliasedLock)).toThrow(/explicitly audited/);
        }
        const identityAlias = structuredClone(lock);
        identityAlias.packages['node_modules/hidden'] = { name: '@azure/msal-node', version: '7.0.1' };
        expect(() => validateManifestLock('api-runtime', manifest, identityAlias)).toThrow(/explicitly audited/);
        const changed = structuredClone(manifest);
        changed.dependencies['@azure/msal-node'] = '^7.1.1';
        const drift = structuredClone(lock); drift.packages[''].dependencies = changed.dependencies;
        expect(() => validateManifestLock('api-runtime', changed, drift)).toThrow(/explicitly audited/);
        expect(() => validateManifestLock('other', manifest, lock)).toThrow(/explicitly audited/);
    });

    test('always blocks High and Critical findings', () => {
        for (const severity of ['high', 'critical']) {
            const result = evaluateFindings([finding({ severity })], {
                dependencyChanged: false,
                exceptions: [exception({ severity })],
                now: NOW
            });
            expect(result.blocked).toHaveLength(1);
        }
    });

    test('reports inherited Moderate findings without blocking unrelated changes', () => {
        const result = evaluateFindings([finding()], {
            dependencyChanged: false,
            exceptions: [],
            now: NOW
        });
        expect(result.blocked).toEqual([]);
        expect(result.accepted).toEqual([]);
        expect(result.staleExceptions).toEqual([]);
    });

    test('blocks a Moderate finding on a dependency-changing change without an exact exception', () => {
        const changed = { dependencyChanged: true, exceptions: [exception()], now: NOW };
        expect(evaluateFindings([finding()], changed).blocked).toEqual([]);

        for (const mismatch of [
            { package: 'other' },
            { version: '6.15.3' },
            { nodePaths: ['node_modules/nested/node_modules/qs'] },
            { advisoryIds: ['GHSA-OTHER'] },
            { surface: 'api-runtime' }
        ]) {
            expect(evaluateFindings([finding(mismatch)], changed).blocked).toHaveLength(1);
        }
        expect(evaluateFindings([finding()], {
            ...changed,
            exceptions: [exception({ expiresAt: '2026-09-09T00:00:00Z' })]
        }).blocked).toHaveLength(1);
        expect(evaluateFindings([finding()], {
            ...changed,
            exceptions: [exception({
                acceptedAt: '2026-09-11T00:00:00Z',
                expiresAt: '2026-10-11T00:00:00Z'
            })]
        }).blocked).toHaveLength(1);
    });

    test('never blocks Low findings', () => {
        expect(evaluateFindings([finding({ severity: 'low' })], {
            dependencyChanged: true,
            exceptions: [],
            now: NOW
        }).blocked).toEqual([]);
    });

    test('normalises stable advisory identities and exact installed versions', () => {
        const report = {
            auditReportVersion: 2,
            vulnerabilities: {
                qs: {
                    name: 'qs', severity: 'moderate', isDirect: false,
                    via: [{ source: 123, url: 'https://github.com/advisories/GHSA-x5fp-wj9c-mxmx' }],
                    effects: ['express'], nodes: ['node_modules/qs']
                },
                express: {
                    name: 'express', severity: 'moderate', isDirect: true,
                    via: ['qs'], effects: [], nodes: ['node_modules/express']
                }
            }
        };
        const lock = { packages: {
            'node_modules/qs': { version: '6.15.2' },
            'node_modules/express': { version: '4.22.2' }
        } };
        expect(normaliseAuditReport('root-all', report, lock)).toEqual(expect.arrayContaining([
            expect.objectContaining({
                package: 'express', version: '4.22.2',
                advisoryIds: ['GHSA-X5FP-WJ9C-MXMX']
            })
        ]));
    });

    test('rejects failed or malformed audit JSON', () => {
        const lock = { packages: {} };
        expect(() => normaliseAuditReport('root-all', {
            auditReportVersion: 2,
            error: { code: 'EAUDIT' },
            vulnerabilities: {}
        }, lock)).toThrow(/unsupported or failed/);
        expect(() => normaliseAuditReport('root-all', {
            auditReportVersion: 2,
            vulnerabilities: []
        }, lock)).toThrow(/unsupported or failed/);
        expect(() => normaliseAuditReport('root-all', {
            auditReportVersion: 1,
            vulnerabilities: {}
        }, lock)).toThrow(/unsupported or failed/);
    });

    test('rejects broad or malformed exception records', () => {
        expect(() => validateExceptionRegistry({
            schemaVersion: 1,
            exceptions: [exception({ package: '*' })]
        })).toThrow(/wildcards/);
        expect(() => validateExceptionRegistry({
            schemaVersion: 1,
            exceptions: [{ ...exception(), unexpected: true }]
        })).toThrow(/unknown or missing fields/);
        expect(() => validateExceptionRegistry({
            schemaVersion: 1,
            exceptions: [exception({ severity: 'high' })]
        })).toThrow(/Low or Moderate/);
        expect(() => validateExceptionRegistry({
            schemaVersion: 1,
            exceptions: [exception(), exception({ id: 'DEP-EXC-DUPLICATE' })]
        })).toThrow(/duplicate exception match tuple/);
        expect(() => validateExceptionRegistry({
            schemaVersion: 1,
            exceptions: [exception({ surfaces: ['unknown-surface'] })]
        })).toThrow(/unsupported audit surface/);
    });

    test('fails a dependency-changing build when an active exception is stale', () => {
        const result = evaluateFindings([], {
            dependencyChanged: true,
            exceptions: [exception()],
            now: NOW
        });
        expect(result.staleExceptions).toEqual([
            expect.objectContaining({ exceptionId: 'DEP-EXC-TEST', surface: 'root-all' })
        ]);
    });

    test('requires connector dependencies to be exact and covered by the root lock', () => {
        const lock = { packages: { 'node_modules/@azure/identity': { version: '4.13.1' } } };
        expect(() => validateConnectorClosure(lock, {
            dependencies: { '@azure/identity': '4.13.1' }
        })).not.toThrow();
        expect(() => validateConnectorClosure(lock, {
            dependencies: { '@azure/identity': '^4.13.1' }
        })).toThrow(/exact version/);
        expect(() => validateConnectorClosure(lock, {
            dependencies: { '@azure/identity': '4.14.0' }
        })).toThrow(/not covered/);
        expect(() => validateConnectorClosure(lock, {
            dependencies: { '@azure/identity': '4.13.1' },
            optionalDependencies: { unsafe: '1.0.0' }
        })).toThrow(/unsupported without its own audited lock closure/);
    });

    test('requires manifest and lock dependency maps to match exactly', () => {
        const manifest = {
            dependencies: { express: '^4.18.2' },
            devDependencies: { jest: '^29.7.0' }
        };
        const lock = {
            lockfileVersion: 3,
            packages: { '': {
                dependencies: { express: '^4.18.2' },
                devDependencies: { jest: '^29.7.0' }
            } }
        };
        expect(() => validateManifestLock('root-all', manifest, lock)).not.toThrow();
        expect(() => validateManifestLock('root-all', manifest, {
            ...lock,
            packages: { '': { dependencies: { express: '^5.0.0' } } }
        })).toThrow(/does not exactly match/);
        expect(() => validateManifestLock('root-all', manifest, {
            ...lock,
            lockfileVersion: 2
        })).toThrow(/lockfileVersion 3/);
    });

    test('rejects shrinkwrap files that would override the governed lockfiles', () => {
        expect(() => rejectUnsupportedShrinkwrap('/repo', (candidate) =>
            candidate === '/repo/npm-shrinkwrap.json'
        )).toThrow(/overrides the governed package-lock/);
        expect(() => rejectUnsupportedShrinkwrap('/repo', () => false)).not.toThrow();
    });

    test('requires exact audit reports only for dependency-changing builds', () => {
        expect(parseArguments([], {})).toEqual({
            dependencyChanged: false,
            connectorDependencyChanged: false,
            reports: { 'root-all': null, 'api-runtime': null }
        });
        expect(() => parseArguments(['--dependency-changed'], {})).toThrow(/root-all/);
        expect(parseArguments([
            '--dependency-changed',
            '--root-report', '/tmp/root.json',
            '--api-report', '/tmp/api.json'
        ], {})).toEqual({
            dependencyChanged: true,
            connectorDependencyChanged: false,
            reports: {
                'root-all': '/tmp/root.json',
                'api-runtime': '/tmp/api.json'
            }
        });
        expect(() => parseArguments(['--connector-dependency-changed'], {}))
            .toThrow(/must also use/);
        const release = parseArguments([
            '--release-root-optional-report', '/tmp/optional.json',
            '--release-root-runtime-report', '/tmp/runtime.json',
            '--release-api-runtime-report', '/tmp/api.json'
        ], {});
        expect(release.releaseReports).toEqual({
            'root-optional': '/tmp/optional.json',
            'root-runtime': '/tmp/runtime.json',
            'api-production': '/tmp/api.json'
        });
        expect(() => parseArguments([
            '--release-root-optional-report', '/tmp/optional.json'
        ], {})).toThrow(/release audit report path is required/);
        expect(() => parseArguments([
            '--release-root-optional-report', '/tmp/optional.json',
            '--release-root-runtime-report', '/tmp/runtime.json',
            '--release-api-runtime-report', '/tmp/api.json',
            '--dependency-changed'
        ], {})).toThrow(/cannot combine/);
    });
});

// These contract checks execute only the actual detector Bash and policy Node
// entrypoint. Reports are synthetic; no npm, install, audit or network runs.