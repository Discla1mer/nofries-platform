'use strict';

// The native suite runs in two parallel CI jobs. The real-clock elapsed-recovery
// case waits 301 s for both the app and PostgreSQL clocks, so it runs alone in
// postgres-elapsed while postgres-native runs everything else. Each job passes
// its Jest --json report here so neither can silently drop or skip a test:
//   without: the elapsed case was filtered out and every other test passed.
//   only:    the elapsed case passed and every other test was filtered out.
const fs = require('node:fs');

const ELAPSED_CASE = /case: elapsed recovery\)$/;
const ELAPSED_PATTERN = 'case: elapsed recovery\\)$';
const EXCLUDE_PATTERN = '^(?!.*case: elapsed recovery\\)$)';

function checkSplitReport(report, mode) {
    if (mode !== 'without' && mode !== 'only') throw new Error('mode must be "without" or "only"');
    if (!report || !Array.isArray(report.testResults) || report.testResults.length === 0) throw new Error('empty Jest report');
    if (report.success !== true || report.numFailedTests !== 0 || report.numRuntimeErrorTestSuites !== 0) {
        throw new Error('native Jest run did not succeed');
    }
    const tests = report.testResults.flatMap(file => file.assertionResults);
    const elapsed = tests.filter(test => ELAPSED_CASE.test(test.fullName));
    const others = tests.filter(test => !ELAPSED_CASE.test(test.fullName));
    if (elapsed.length !== 1) throw new Error(`expected exactly one elapsed-recovery case, found ${elapsed.length}`);
    if (others.length === 0) throw new Error('no other native tests were discovered');
    const [ran, filtered] = mode === 'without' ? [others, elapsed] : [elapsed, others];
    const notPassed = ran.filter(test => test.status !== 'passed');
    if (notPassed.length) throw new Error(`${notPassed.length} test(s) in this job did not pass, e.g. ${notPassed[0].fullName}`);
    const notFiltered = filtered.filter(test => test.status !== 'pending');
    if (notFiltered.length) throw new Error(`${notFiltered.length} test(s) meant for the other job ran here`);
    return { ran: ran.length, filtered: filtered.length };
}

if (require.main === module) {
    try {
        const [mode, file] = process.argv.slice(2);
        const { ran, filtered } = checkSplitReport(JSON.parse(fs.readFileSync(file, 'utf8')), mode);
        console.log(`Postgres split (${mode}): ${ran} passed here, ${filtered} run by the other job.`);
    } catch (error) {
        console.error(`Postgres split check failed: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { checkSplitReport, ELAPSED_CASE, ELAPSED_PATTERN, EXCLUDE_PATTERN };
