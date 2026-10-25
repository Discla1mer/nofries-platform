'use strict';

const path = require('node:path');

// This is an ordering preference, never a test-discovery or exclusion list.
const PRIORITY_SUITES = Object.freeze([
    'test/customerSignupJourney.test.js',
    'test/customerSignupRuntime.test.js',
    'test/customerProductionJourney.test.js',
    'test/sessionBoundSignupContinuation.test.js',
    'test/browserSignupContinuation.test.js',
    'test/organisationSetupHttp.test.js',
    'test/tenantAccessBff.test.js',
    'test/tenantRequestContext.test.js',
    'test/tenantAuthMode.test.js',
    'test/dashboardAdmission.test.js',
    'test/dashboardService.test.js',
    'test/assessmentRepository.test.js',
    'test/ncscAssessmentRepository.test.js',
    'test/ncscAssessmentService.test.js',
    'test/ncscAssessmentSubmission.test.js',
    'test/ncscAssessmentHandlers.test.js'
]);
const priorityPaths = new Set(PRIORITY_SUITES);

function assertComplete(original, ordered) {
    if (!Array.isArray(original) || !Array.isArray(ordered) || original.length !== ordered.length) {
        throw new Error('CI suite ordering must retain every discovered suite exactly once.');
    }
    const expected = new Map();
    for (const suite of original) {
        if (!suite || typeof suite.path !== 'string' || !suite.path || expected.has(suite.path)) {
            throw new Error('CI suite discovery contains an invalid or duplicate suite path.');
        }
        expected.set(suite.path, suite);
    }
    const seen = new Set();
    for (const suite of ordered) {
        if (!suite || expected.get(suite.path) !== suite || seen.has(suite.path)) {
            throw new Error('CI suite ordering dropped, duplicated or replaced a discovered suite.');
        }
        seen.add(suite.path);
    }
}

function isPrioritySuite(suite, rootDirectory) {
    const paths = /^[a-z]:[\\/]|^\\\\/i.test(rootDirectory) ? path.win32 : path.posix;
    const relative = paths.relative(rootDirectory, suite.path).split(paths.sep).join('/');
    return priorityPaths.has(relative);
}

function prioritizeSuites(defaultOrder, rootDirectory) {
    assertComplete(defaultOrder, defaultOrder);
    if (typeof rootDirectory !== 'string' ||
        !(path.posix.isAbsolute(rootDirectory) || path.win32.isAbsolute(rootDirectory))) {
        throw new Error('CI suite ordering requires an absolute repository root.');
    }
    const priority = [], remainder = [];
    for (const suite of defaultOrder) {
        (isPrioritySuite(suite, rootDirectory) ? priority : remainder).push(suite);
    }
    const ordered = [...priority, ...remainder];
    assertComplete(defaultOrder, ordered);
    return ordered;
}

module.exports = { PRIORITY_SUITES, assertComplete, isPrioritySuite, prioritizeSuites };
