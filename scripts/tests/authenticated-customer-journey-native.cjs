'use strict';
// Explicitly selected only by the isolated local journey CI job.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { configuration, runLocalJourney, formatReport } = require('../authenticated-customer-journey');

test('authenticated journey and failure-path cleanup on native PostgreSQL', { timeout: 180000 }, async () => {
    const config = configuration(['--run-local'], process.env);
    const { Pool } = require('pg');
    const control = new Pool({ connectionString: config.databaseUrl, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
    const inventory = async () => ({
        databases: (await control.query("SELECT datname FROM pg_database WHERE datname LIKE 'nf_journey_%' ORDER BY datname")).rows,
        roles: (await control.query("SELECT rolname FROM pg_roles WHERE rolname LIKE 'nf_journey_%' ORDER BY rolname")).rows
    });
    const warn = console.warn, error = console.error;
    console.warn = console.error = () => {};
    try {
        const before = await inventory();
        for (const failAfter of [null, 'prepare isolated local stack', 'signup and authenticated company admission', 'submit once and retain results']) {
            const report = await runLocalJourney(config, { failAfter });
            process.stdout.write(formatReport(report));
            assert.equal(report.ok, failAfter === null);
            if (failAfter) assert.equal(report.steps.at(-2).name, failAfter);
            assert.equal(report.steps.at(-1).ok, true);
            assert.deepEqual(await inventory(), before, 'No generated databases or roles survive success or failure');
        }
    } finally { console.warn = warn; console.error = error; await control.end(); }
});
