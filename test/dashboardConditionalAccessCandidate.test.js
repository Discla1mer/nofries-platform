'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { CANDIDATES, criteria, inspect } = require('../scripts/dashboard-conditional-access-candidate');
const { loadVerified } = require('../scripts/dashboard-conditional-access-validate');
const STATE = 'enabledForReportingButNotEnforced';
// Synthetic policy objects, built solely from the checked-in operator specification.
function fixture(candidate) {
    return { id: candidate.id, displayName: candidate.name, state: STATE,
        conditions: { signInRiskLevels: [], userRiskLevels: [], servicePrincipalRiskLevels: [],
            users: { includeUsers: ['All'], excludeUsers: [], excludeGroups: [], excludeRoles: [] },
            applications: { includeApplications: candidate.kind === 'context' ? [] : ['All'], excludeApplications: [],
                includeAuthenticationContextClassReferences: candidate.kind === 'context' ? ['c1'] : [], includeUserActions: [] },
            clientAppTypes: candidate.kind === 'legacy' ? ['exchangeActiveSync', 'other'] : ['all'],
            ...(candidate.kind === 'device' ? { authenticationFlows: { transferMethods: 'deviceCodeFlow' } } : {}) },
        grantControls: { operator: 'OR', builtInControls: [['legacy', 'device'].includes(candidate.kind) ? 'block' : 'mfa'] } };
}
const passes = (p, c = CANDIDATES[0], state = STATE) => Object.values(criteria(p, c, state)).every(Boolean);
test.each([undefined, null, 'Synthetic descriptive metadata'])('accepts non-control description metadata %#', description => {
    const p = fixture(CANDIDATES[0]); p.description = description;
    expect(passes(p)).toBe(true);
});
test.each([{}, [], 42])('rejects malformed description metadata %#', description => {
    const p = fixture(CANDIDATES[0]); p.description = description;
    expect(passes(p)).toBe(false);
});
test.each(CANDIDATES)('accepts exact $kind specification and all explicit states', candidate => {
    for (const state of [STATE, 'enabled', 'disabled']) {
        const p = fixture(candidate); p.state = state;
        expect(passes(p, candidate, state)).toBe(true);
        expect(passes(p, candidate, state === STATE ? 'enabled' : STATE)).toBe(false);
    }
});
test.each([
    ['excluded user', p => p.conditions.users.excludeUsers.push('sentinel')],
    ['missing exclusions', p => delete p.conditions.users.excludeRoles],
    ['group narrowing', p => p.conditions.users.includeGroups = ['sentinel']],
    ['role narrowing', p => p.conditions.users.includeRoles = ['sentinel']],
    ['guest exclusion', p => p.conditions.users.excludeGuestsOrExternalUsers = {}],
    ['guest inclusion', p => p.conditions.users.includeGuestsOrExternalUsers = {}],
    ['additional user', p => p.conditions.users.includeUsers.push('sentinel')],
    ['unknown user field', p => p.conditions.users.futureScope = null],
    ['excluded resource', p => p.conditions.applications.excludeApplications.push('sentinel')],
    ['resource narrowing', p => p.conditions.applications.includeApplications = ['sentinel']],
    ['resource filter', p => p.conditions.applications.applicationFilter = {}],
    ['agent action', p => p.conditions.applications.includeAgentActions = ['sentinel']],
    ['user action', p => p.conditions.applications.includeUserActions = ['sentinel']],
    ['extra context', p => p.conditions.applications.includeAuthenticationContextClassReferences = ['c1']],
    ['unknown application field', p => p.conditions.applications.futureScope = []],
    ['location filter', p => p.conditions.locations = {}],
    ['platform filter', p => p.conditions.platforms = {}],
    ['device filter', p => p.conditions.devices = {}],
    ['device state filter', p => p.conditions.deviceStates = {}],
    ['client filter', p => p.conditions.clientApplications = {}],
    ['time filter', p => p.conditions.times = {}],
    ['agent filter', p => p.conditions.agents = {}],
    ['risk filter', p => p.conditions.signInRiskLevels = ['high']],
    ['unknown condition', p => p.conditions.futureScope = null],
    ['incorrect client', p => p.conditions.clientAppTypes = ['browser']],
    ['unexpected flow', p => p.conditions.authenticationFlows = {}],
    ['wrong operator', p => p.grantControls.operator = 'AND'],
    ['alternative grant', p => p.grantControls.builtInControls.push('compliantDevice')],
    ['custom grant', p => p.grantControls.customAuthenticationFactors = ['sentinel']],
    ['terms grant', p => p.grantControls.termsOfUse = ['sentinel']],
    ['strength', p => p.grantControls.authenticationStrength = {}],
    ['unknown grant', p => p.grantControls.futureGrant = null],
    ['session control', p => p.sessionControls = { signInFrequency: {} }],
    ['rollout', p => p.partialEnablementStrategy = {}],
    ['deleted policy', p => p.deletedDateTime = '2026-01-01T00:00:00Z'],
    ['wrong ID', p => p.id = 'sentinel'],
    ['wrong name', p => p.displayName = 'sentinel'],
    ['unknown policy field', p => p.futureScope = null]
])('rejects %s', (_, change) => { const p = fixture(CANDIDATES[0]); change(p); expect(passes(p)).toBe(false); });
test('requires exact context and device flow shapes', () => {
    const context = CANDIDATES[3], device = CANDIDATES[2];
    const p = fixture(context); p.conditions.applications.includeAuthenticationContextClassReferences.push('c2');
    expect(passes(p, context)).toBe(false);
    const q = fixture(device); q.conditions.authenticationFlows.extra = null;
    expect(passes(q, device)).toBe(false);
    delete q.conditions.authenticationFlows;
    expect(passes(q, device)).toBe(false);
});
test.each([null, [], 'sentinel', {}, { conditions: [] }, { grantControls: [] }])('rejects malformed objects %#', value => {
    expect(passes(value)).toBe(false);
});
test.each(['signInRiskLevels', 'userRiskLevels', 'servicePrincipalRiskLevels'])('requires explicit empty %s', key => {
    for (const value of [undefined, null, {}, '', ['high']]) {
        const p = fixture(CANDIDATES[0]); p.conditions[key] = value;
        expect(passes(p)).toBe(false);
        delete p.conditions[key]; expect(passes(p)).toBe(false);
    }
});
let directory;
beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nofries-ca-test-'));
    for (const c of CANDIDATES) fs.writeFileSync(path.join(directory, c.id + '.json'), JSON.stringify(fixture(c)));
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
test('binds each result to exact bytes, emits no raw fields and changes no files', () => {
    const before = CANDIDATES.map(c => fs.readFileSync(path.join(directory, c.id + '.json')));
    const result = inspect(directory, STATE);
    expect(result.passed).toBe(true);
    result.policies.forEach((p, i) => {
        expect(p.sha256).toBe(crypto.createHash('sha256').update(before[i]).digest('hex'));
        expect(fs.readFileSync(path.join(directory, p.id + '.json'))).toEqual(before[i]);
    });
    expect(JSON.stringify(result)).not.toContain('displayName');
    expect(JSON.stringify(result)).not.toContain(directory);
});
test.each(['missing', 'malformed', 'symlink', 'directory', 'oversized', 'invalid-utf8'])('fails closed on %s file', kind => {
    const file = path.join(directory, CANDIDATES[0].id + '.json');
    fs.unlinkSync(file);
    if (kind === 'malformed') fs.writeFileSync(file, '{"secret":"never-print-this"');
    if (kind === 'symlink') fs.symlinkSync(path.join(directory, CANDIDATES[1].id + '.json'), file);
    if (kind === 'directory') fs.mkdirSync(file);
    if (kind === 'oversized') fs.writeFileSync(file, 'x'.repeat(65537));
    if (kind === 'invalid-utf8') fs.writeFileSync(file, Buffer.from([123, 255, 125]));
    const result = inspect(directory, STATE);
    expect(result.passed).toBe(false);
    expect(result.policies[0].code).toBe('candidate_unreadable_or_invalid');
    expect(JSON.stringify(result)).not.toContain('never-print-this');
});
test('CLI fails with redacted output for invalid arguments and reports success only for complete set', () => {
    const sourceFile = path.resolve(__dirname, '../scripts/dashboard-conditional-access-candidate.js');
    const script = path.resolve(__dirname, '../scripts/dashboard-conditional-access-validate.js');
    const hash = crypto.createHash('sha256').update(fs.readFileSync(sourceFile)).digest('hex');
    const valid = spawnSync(process.execPath, [script, directory, STATE, hash], { encoding: 'utf8' });
    expect(valid.status).toBe(0); expect(JSON.parse(valid.stdout).passed).toBe(true);
    const invalid = spawnSync(process.execPath, [script, directory, 'secret-state', hash], { encoding: 'utf8' });
    expect(invalid.status).toBe(1); expect(invalid.stderr).not.toContain('secret-state');
    fs.unlinkSync(path.join(directory, CANDIDATES[0].id + '.json'));
    const missing = spawnSync(process.execPath, [script, directory, STATE, hash], { encoding: 'utf8' });
    expect(missing.status).toBe(1); expect(JSON.parse(missing.stdout).passed).toBe(false);
});
test('verified loader hashes the exact source string it compiles, independently of later file contents', () => {
    let source = "module.exports = { inspect: () => ({ marker: 'original' }) };";
    const hash = crypto.createHash('sha256').update(source).digest('hex');
    const loaded = loadVerified(source, hash);
    source = "module.exports = { inspect: () => ({ marker: 'replacement' }) };";
    expect(loaded.inspect()).toEqual({ marker: 'original', validatorSha256: hash });
    expect(() => loadVerified(source, hash)).toThrow('candidate_source_invalid');
});
test('mismatched source is rejected before execution and core cannot claim a source digest', () => {
    const source = "throw new Error('MUST_NOT_EXECUTE');";
    expect(() => loadVerified(source, '0'.repeat(64))).toThrow('candidate_source_invalid');
    expect(inspect(directory, STATE)).not.toHaveProperty('validatorSha256');
    const file = path.resolve(__dirname, '../scripts/dashboard-conditional-access-candidate.js');
    const raw = spawnSync(process.execPath, [file, directory, STATE], { encoding: 'utf8' });
    expect(raw.status).toBe(1); expect(raw.stdout).toBe('');
});

test.each(CANDIDATES)('accepts absent/null insider risk and rejects all configured or malformed values for $kind', candidate => {
    for (const value of [undefined, null]) {
        const p = fixture(candidate); p.conditions.insiderRiskLevels = value;
        expect(passes(p, candidate)).toBe(true);
    }
    for (const value of ['minor', 'moderate', 'elevated', 'unknownFutureValue', '', [], {}, false, 0]) {
        const p = fixture(candidate); p.conditions.insiderRiskLevels = value;
        const result = criteria(p, candidate, STATE);
        expect(result.condition_keys).toBe(true);
        expect(result.no_insider_risk_condition).toBe(false);
        expect(passes(p, candidate)).toBe(false);
    }
});
