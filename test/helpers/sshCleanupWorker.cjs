'use strict';
// Run only inside sshCleanupSupervisor.py, against the test-created fake CLI.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { connectSsh } = require('../../scripts/signup-policy-ssh');
const { createPolicyGuard } = require('../../scripts/signup-policy-transport');
const { CUSTOMER_MFA_POLICY } = require('../../api/shared/customerSignup/customerMfaPolicy');
const [directory, fakePath, mode, delayText] = process.argv.slice(2);
const delay = Number(delayText);
const controller = new AbortController();
const signals = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, resumed, resumedAt, cleanupStarted;
function groupExists() {
    try { process.kill(-child.pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function main() {
    const connect = signal => connectSsh(signal, {
        env: { ...process.env, PATH: fakePath + path.delimiter + process.env.PATH,
            NF_SSH_TEST_MODE: mode, NF_SSH_TEST_READY: path.join(directory, 'ready'),
            NF_SSH_TEST_TERM: path.join(directory, 'term') },
        spawn: (...args) => {
            child = spawn(...args);
            fs.writeFileSync(path.join(directory, 'group.tmp'), String(child.pid));
            fs.renameSync(path.join(directory, 'group.tmp'), path.join(directory, 'group'));
            return child;
        },
        kill: (pid, signal) => {
            if (signal !== 0) signals.push(signal);
            if (signal === 'SIGTERM' && cleanupStarted === undefined) {
                cleanupStarted = performance.now();
                if (delay) {
                    // Delay just the reaper; the CLI receives cancellation now.
                    process.kill(child.pid, 'SIGSTOP');
                    resumed = setTimeout(() => {
                        resumedAt = performance.now();
                        try { process.kill(child.pid, 'SIGCONT'); }
                        catch (error) { if (error.code !== 'ESRCH') throw error; }
                    }, delay);
                }
            }
            return process.kill(pid, signal);
        }
    });
    const config = { releaseSha: 'a'.repeat(40), releaseRunId: '123',
        policyId: CUSTOMER_MFA_POLICY.id, context: 'c1' };
    const successCase = mode.startsWith('linger');
    const work = successCase ? createPolicyGuard(config, { connect })() : connect(controller.signal).then(execute => {
        if (!mode.startsWith('hang-command')) return 'unexpected-ready';
        const { TARGET } = require('../../lib/signupPolicyProbe');
        const request = { schemaVersion: 1, ...TARGET, ...config, nonce: 'b'.repeat(64), issuedAt: Date.now() };
        return execute(['--request', Buffer.from(JSON.stringify(request)).toString('base64url')], controller.signal);
    });
    const result = work.then(() => successCase ? 'verified' : 'unexpected-success', error => error.code);
    const readyDeadline = performance.now() + 5000;
    // Do not let fast cleanup outrun the supervisor's ownership proof.
    while (!fs.existsSync(path.join(directory, 'ready')) ||
           !fs.existsSync(path.join(directory, 'group-verified'))) {
        if (performance.now() >= readyDeadline) throw Error('fixture readiness timeout');
        await pause(10);
    }
    if (successCase) {
        // The fake CLI stops its reaper before acknowledging TERM, proving
        // normal cleanup has started without racing worker scheduling.
        const termDeadline = performance.now() + 5000;
        while (!fs.existsSync(path.join(directory, 'term'))) {
            if (performance.now() >= termDeadline) throw Error('fixture TERM timeout');
            await pause(10);
        }
        cleanupStarted = performance.now();
        resumed = setTimeout(() => {
            resumedAt = performance.now();
            try { process.kill(child.pid, 'SIGCONT'); }
            catch (error) { if (error.code !== 'ESRCH') throw error; }
        }, delay);
    } else controller.abort();
    const outcome = await result;
    clearTimeout(resumed);
    const report = { outcome, groupAlive: groupExists(), signals,
        elapsed: performance.now() - cleanupStarted,
        resumedAfter: resumedAt === undefined ? null : resumedAt - cleanupStarted };
    fs.writeFileSync(path.join(directory, 'result'), JSON.stringify(report));
}
main().catch(() => { controller.abort(); process.exitCode = 1; });
