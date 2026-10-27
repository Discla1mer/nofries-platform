const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const yaml = require('js-yaml');

const {
    evaluateFindings,
    normaliseAuditReport,
    parseArguments,
    rejectUnsupportedShrinkwrap,
    stripTemporaryMsalFindings,
    validateReviewedSourceScope,
    validateConnectorClosure,
    validateExceptionRegistry,
    validateManifestLock
} = require('../scripts/check-dependency-audit');

const NOW = new Date('2026-09-10T00:00:00Z');
const MSAL_NOW = new Date('2026-10-24T00:00:00Z');
const MSAL_URL = 'https://github.com/advisories/GHSA-xcx6-jx8p-x3h5';
const DIRECT_MSAL_NODES = ['node_modules/@azure/msal-node'];
const DIRECT_IDENTITY_NODES = ['node_modules/@azure/identity'];
const ROOT_MSAL_NODES = [
    'node_modules/@azure/msal-node',
    'node_modules/promptfoo/node_modules/@azure/identity/node_modules/@azure/msal-node',
    'node_modules/promptfoo/node_modules/@azure/msal-node'
];
const ROOT_IDENTITY_NODES = [
    'node_modules/@azure/identity',
    'node_modules/promptfoo/node_modules/@azure/identity'
];

function msalAuditFixture(surface = 'root-all') {
    const rootAll = surface === 'root-all';
    const vulnerabilities = {
        '@azure/msal-node': {
            name: '@azure/msal-node', severity: 'high',
            nodes: [...(rootAll ? ROOT_MSAL_NODES : DIRECT_MSAL_NODES)],
            via: [{ url: MSAL_URL, source: 1243111, severity: 'high' }]
        },
        '@azure/identity': {
            name: '@azure/identity', severity: 'high',
            nodes: [...(rootAll ? ROOT_IDENTITY_NODES : DIRECT_IDENTITY_NODES)],
            via: ['@azure/msal-node']
        }
    };
    if (rootAll) {
        vulnerabilities['@azure/ai-projects'] = {
            name: '@azure/ai-projects', severity: 'high',
            nodes: ['node_modules/@azure/ai-projects'], via: ['@azure/identity']
        };
        vulnerabilities.promptfoo = {
            name: 'promptfoo', severity: 'high', nodes: ['node_modules/promptfoo'],
            via: ['@azure/ai-projects', '@azure/identity', '@azure/msal-node']
        };
    }
    return {
        auditReportVersion: 2,
        vulnerabilities
    };
}

function msalLockFixture(surface = 'root-all') {
    const packages = {
        'node_modules/@azure/msal-node': { version: '5.6.0' },
        'node_modules/@azure/identity': { version: '4.13.1' }
    };
    if (surface === 'root-all') Object.assign(packages, {
        'node_modules/promptfoo/node_modules/@azure/identity/node_modules/@azure/msal-node': { version: '6.0.1' },
        'node_modules/promptfoo/node_modules/@azure/msal-node': { version: '7.0.1' },
        'node_modules/promptfoo/node_modules/@azure/identity': { version: '4.13.3' },
        'node_modules/@azure/ai-projects': { version: '2.5.0', dev: true, optional: true },
        'node_modules/promptfoo': { version: '0.124.0' }
    });
    return { packages };
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
    test.each(['root-all', 'api-runtime', 'root-optional', 'root-runtime', 'api-production'])
    ('accepts only the fully pinned temporary MSAL chain on %s', (surface) => {
        const report = msalAuditFixture(surface);
        const { report: remaining, accepted } = stripTemporaryMsalFindings(
            surface, report, msalLockFixture(surface), MSAL_NOW, '11.9.0'
        );
        expect(Object.keys(remaining.vulnerabilities)).toEqual([]);
        expect(accepted.map((item) => item.package).sort())
            .toEqual(Object.keys(report.vulnerabilities).sort());
        expect(report.vulnerabilities['@azure/msal-node']).toBeDefined();
    });

    test('accepts only the exact npm 10 optional-omitted root projection', () => {
        const report = msalAuditFixture();
        delete report.vulnerabilities['@azure/ai-projects'];
        report.vulnerabilities.promptfoo.via = ['@azure/identity'];
        const lock = msalLockFixture();
        const result = stripTemporaryMsalFindings('root-all', report, lock, MSAL_NOW, '10.9.4');
        expect(result.accepted.map((item) => item.package).sort())
            .toEqual(['@azure/identity', '@azure/msal-node', 'promptfoo']);
        expect(Object.keys(result.report.vulnerabilities)).toEqual([]);
        expect(() => stripTemporaryMsalFindings('root-all', report, lock, MSAL_NOW, '11.9.0'))
            .toThrow();
        expect(() => stripTemporaryMsalFindings('root-all', msalAuditFixture(), lock,
            MSAL_NOW, '10.9.4')).toThrow();
        expect(() => stripTemporaryMsalFindings('root-all', report, lock, MSAL_NOW, '10.9.5'))
            .toThrow(/unreviewed npm audit client version/);
        lock.packages['node_modules/@azure/ai-projects'].version = '2.5.1';
        expect(() => stripTemporaryMsalFindings('root-all', report, lock, MSAL_NOW, '10.9.4'))
            .toThrow(/locked version changed/);
        lock.packages['node_modules/@azure/ai-projects'].version = '2.5.0';
        lock.packages['node_modules/@azure/ai-projects'].optional = false;
        expect(() => stripTemporaryMsalFindings('root-all', report, lock, MSAL_NOW, '10.9.4'))
            .toThrow(/optional lock classification changed/);
    });

    test('blocks expiry and any changed MSAL advisory, node, version, severity or inherited parent', () => {
        const make = () => msalAuditFixture();
        const lock = msalLockFixture();
        expect(() => stripTemporaryMsalFindings('root-all', make(), lock,
            new Date('2026-10-27T00:00:00Z'))).toThrow(/expired/);
        expect(() => stripTemporaryMsalFindings('root-all', make(), lock,
            new Date('invalid'))).toThrow(/expired/);
        const cases = [
            (report) => { report.vulnerabilities['@azure/msal-node'].via[0].url =
                'https://github.com/advisories/GHSA-other'; },
            (report) => { report.vulnerabilities['@azure/msal-node'].via[0].severity = 'critical'; },
            (report) => { report.vulnerabilities['@azure/msal-node'].via.push({ url: MSAL_URL, source: 99 }); },
            (report) => { report.vulnerabilities['@azure/msal-node'].nodes.push('node_modules/other/@azure/msal-node'); },
            (report) => { report.vulnerabilities['@azure/msal-node'].severity = 'critical'; },
            (report) => { report.vulnerabilities.promptfoo.via.push('unreviewed'); },
            (report) => { delete report.vulnerabilities['@azure/identity']; },
            (report) => { delete report.vulnerabilities.promptfoo; }
        ];
        for (const mutate of cases) {
            const report = make();
            mutate(report);
            expect(() => stripTemporaryMsalFindings('root-all', report, lock, MSAL_NOW, '11.9.0')).toThrow();
        }
        const changedLock = msalLockFixture();
        changedLock.packages['node_modules/promptfoo/node_modules/@azure/msal-node'].version = '7.1.0';
        expect(() => stripTemporaryMsalFindings('root-all', make(), changedLock, MSAL_NOW, '11.9.0'))
            .toThrow(/locked version changed/);
    });

    test('retains unrelated findings and rejects malformed reports', () => {
        const report = msalAuditFixture('api-runtime');
        report.vulnerabilities.other = {
            name: 'other', severity: 'high', nodes: ['node_modules/other'],
            via: [{ url: 'https://github.com/advisories/GHSA-other' }]
        };
        const lock = msalLockFixture('api-runtime');
        lock.packages['node_modules/other'] = { version: '1.0.0' };
        const filtered = stripTemporaryMsalFindings('api-runtime', report, lock, MSAL_NOW);
        expect(normaliseAuditReport('api-runtime', filtered.report, lock))
            .toEqual([expect.objectContaining({ package: 'other', severity: 'high' })]);
        expect(evaluateFindings(normaliseAuditReport('api-runtime', filtered.report, lock), {
            dependencyChanged: true, exceptions: [], now: MSAL_NOW
        }).blocked).toHaveLength(1);
        expect(() => stripTemporaryMsalFindings('api-runtime', {
            ...msalAuditFixture('api-runtime'), error: { code: 'EAUDIT' }
        }, lock, MSAL_NOW)).toThrow(/failed npm audit/);
        expect(() => stripTemporaryMsalFindings('api-runtime', {
            auditReportVersion: 2, vulnerabilities: {}
        }, lock, MSAL_NOW)).toThrow(/finding missing/);
        const patchedLock = msalLockFixture('root-all');
        patchedLock.packages['node_modules/@azure/msal-node'].version = '7.1.0';
        expect(() => stripTemporaryMsalFindings('root-all', {
            auditReportVersion: 2, vulnerabilities: {}
        }, patchedLock, MSAL_NOW)).toThrow(/finding missing/);
        const removedLock = { packages: {} };
        expect(stripTemporaryMsalFindings('api-runtime', {
            auditReportVersion: 2, vulnerabilities: {}
        }, removedLock, MSAL_NOW).accepted).toEqual([]);
    });

    test('retires acceptance only for conclusively remediated full MSAL closures after expiry', () => {
        const lock = msalLockFixture();
        for (const node of ROOT_MSAL_NODES) lock.packages[node].version = '7.1.1';
        const report = { auditReportVersion: 2, vulnerabilities: {} };
        expect(stripTemporaryMsalFindings('root-all', report, lock,
            new Date('2026-10-28T00:00:00Z'))).toEqual({ report, accepted: [] });
        for (const version of ['6.0.1', '7.0.1', '7.1.1-beta.1', 'garbage', undefined, '07.1.1']) {
            const hidden = structuredClone(lock);
            hidden.packages['node_modules/optional-sdk/node_modules/@azure/msal-node'] = { version };
            expect(() => stripTemporaryMsalFindings('root-all', report, hidden,
                new Date('2026-10-28T00:00:00Z'))).toThrow(/finding missing/);
        }
        for (const severity of ['moderate', 'high', 'critical']) {
            const unrelated = { auditReportVersion: 2, vulnerabilities: { other: {
                name: 'other', severity, nodes: ['node_modules/other'],
                via: [{ url: 'https://github.com/advisories/GHSA-other' }]
            } } };
            lock.packages['node_modules/other'] = { version: '1.0.0' };
            const result = stripTemporaryMsalFindings('root-all', unrelated, lock,
                new Date('2026-10-28T00:00:00Z'));
            expect(result.accepted).toEqual([]);
            expect(evaluateFindings(normaliseAuditReport('root-all', result.report, lock), {
                dependencyChanged: true, exceptions: [], now: NOW
            }).blocked).toHaveLength(1);
        }
    });

    test('recognizes MSAL identity and aliases, including hidden, malformed and unresolved copies', () => {
        const report = { auditReportVersion: 2, vulnerabilities: {} };
        const now = new Date('2026-10-28T00:00:00Z');
        const make = () => ({ packages: {
            '': { dependencies: { 'legacy-msal': 'npm:@azure/msal-node@7.0.1' } },
            'node_modules/@azure/msal-node': { version: '7.1.1' },
            'node_modules/legacy-msal': { name: '@azure/msal-node', version: '7.0.1' }
        } });
        const reject = lock => expect(() => stripTemporaryMsalFindings('root-all', report, lock, now))
            .toThrow(/finding missing/);
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
        expect(stripTemporaryMsalFindings('root-all', report, nested, now)).toEqual({ report, accepted: [] });
        // Resolve the nearest nested copy rather than accepting a safe hoisted alias.
        nested.packages['node_modules/optional-sdk/node_modules/legacy-msal'] = { version: '7.0.1' };
        reject(nested);
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

    test('blocks source changes outside the exact reviewed dependency and audit files', () => {
        expect(() => validateReviewedSourceScope([
            'package-lock.json', 'scripts/check-dependency-audit.js'
        ])).not.toThrow();
        for (const changed of ['api/shared/browserAuth.js', 'api/shared/identity.js',
            'connector-functions/package-lock.json', '.github/workflows/ci.yml']) {
            expect(() => validateReviewedSourceScope([changed])).toThrow(/source exposure changed/);
        }
        expect(() => validateReviewedSourceScope(['package-lock.json', null]))
            .toThrow(/source exposure changed/);
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