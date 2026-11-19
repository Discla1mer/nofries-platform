'use strict';

// D-013: per-request stage durations for dashboard API responses, sent as a
// Server-Timing header so slow stages can be seen from the browser. Only
// fixed stage names and rounded millisecond durations leave the server: no
// identifiers, SQL, paths or error detail.
const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');

const storage = new AsyncLocalStorage();
const STAGE = /^[a-z][a-z0-9]{0,15}$/;
const MAX_STAGES = 12;

function run(work) {
    const state = { started: performance.now(), stages: new Map() };
    return storage.run(state, () => work(state));
}

function record(name, ms) {
    const state = storage.getStore();
    if (!state || !STAGE.test(name) || !Number.isFinite(ms) || ms < 0) return;
    const stage = state.stages.get(name);
    if (stage) { stage.ms += ms; stage.count += 1; return; }
    if (state.stages.size >= MAX_STAGES) return;
    state.stages.set(name, { ms, count: 1 });
}

// Times one awaited step. Without an active request this is a plain call.
async function measure(name, work) {
    if (!storage.getStore()) return work();
    const started = performance.now();
    try { return await work(); } finally { record(name, performance.now() - started); }
}

function header(state) {
    if (!state || !(state.stages instanceof Map)) return '';
    const parts = [];
    for (const [name, { ms, count }] of state.stages) {
        parts.push(`${name};dur=${ms.toFixed(1)}` + (count > 1 ? `;desc="${count}"` : ''));
    }
    parts.push(`total;dur=${(performance.now() - state.started).toFixed(1)}`);
    return parts.join(', ');
}

module.exports = { run, measure, record, header };
