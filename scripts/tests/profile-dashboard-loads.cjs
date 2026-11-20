'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { configuration } = require('../profile-dashboard-loads');
const local = { NOFRIES_TEST_DATABASE_URL: 'postgresql://synthetic@127.0.0.1:5432/nofries_ci',
    NOFRIES_PROFILE_DISPOSABLE_CLUSTER: 'true' };

test('profiling is opt-in and refuses production, remote and ambiguous database targets', () => {
    assert.equal(configuration([], {}), null);
    assert.throws(() => configuration(['--run-local'], {}));
    assert.throws(() => configuration(['--run-local'], { ...local, NOFRIES_PROFILE_DISPOSABLE_CLUSTER: 'false' }));
    for (const url of ['postgresql://synthetic@remote.invalid/nofries_ci',
        'postgresql://synthetic@localhost/nofries_ci', 'postgresql://synthetic@127.0.0.1/production',
        local.NOFRIES_TEST_DATABASE_URL + '?host=remote.invalid', local.NOFRIES_TEST_DATABASE_URL + '#fragment']) {
        assert.throws(() => configuration(['--run-local'], { ...local, NOFRIES_TEST_DATABASE_URL: url }));
    }
    assert.throws(() => configuration(['--run-local', '--remote'], local));
});

test('profiling sample count is bounded and the optional #446 mode is explicit', () => {
    assert.deepEqual(configuration(['--run-local'], local), { databaseUrl: local.NOFRIES_TEST_DATABASE_URL, runs: 12, bundle: false });
    assert.equal(configuration(['--run-local'], { ...local, NOFRIES_PROFILE_OVERVIEW_BUNDLE: 'true' }).bundle, true);
    for (const runs of ['0', '-1', '101', 'Infinity', '1.5', 'NaN']) {
        assert.throws(() => configuration(['--run-local'], { ...local, NOFRIES_PROFILE_RUNS: runs }));
    }
    assert.throws(() => configuration(['--run-local'], { ...local, NOFRIES_PROFILE_OVERVIEW_BUNDLE: 'yes' }));
});
