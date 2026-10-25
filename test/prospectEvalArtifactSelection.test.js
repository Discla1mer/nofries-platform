'use strict';

const { selectProspectEvalArtifact } = require('../scripts/select-prospect-eval-artifact');

const runId = '39194758930';
const releaseSha = '8906426a871ede863f849cf0dbe75a8aa524cb72';
const canonical = `prospect-live-eval-${runId}`;
const clean = { total_count: 0, artifacts: [] };
const existing = { total_count: 1, artifacts: [{
    id: 12161308568, name: canonical, expired: false, digest: 'sha256:' + 'a'.repeat(64),
    workflow_run: { id: Number(runId), head_sha: releaseSha }
}] };
const choose = (changes = {}) => selectProspectEvalArtifact({
    outcome: 'success', runId, attempt: '1', releaseSha, listing: clean, ...changes
});

test('first success gets the single release-admissible artifact name', () => {
    expect(choose()).toBe(canonical);
});

test('failed attempts retain unique immutable names and never occupy the success slot', () => {
    expect(choose({ outcome: 'failure', attempt: '1', listing: null })).toBe(`prospect-live-eval-failed-${runId}-1`);
    expect(choose({ outcome: 'failure', attempt: '2', listing: null })).toBe(`prospect-live-eval-failed-${runId}-2`);
    expect(choose({ outcome: 'success', attempt: '3' })).toBe(canonical);
});

test('repeated successful attempts keep the original canonical artifact and save each later result separately', () => {
    expect(choose({ attempt: '2', listing: existing })).toBe(`prospect-live-eval-success-${runId}-2`);
    expect(choose({ attempt: '3', listing: existing })).toBe(`prospect-live-eval-success-${runId}-3`);
});

test.each([
    { ...existing, total_count: 2 },
    { total_count: 2, artifacts: [...existing.artifacts, ...existing.artifacts] },
    { total_count: 1, artifacts: [{ ...existing.artifacts[0], expired: true }] },
    { total_count: 1, artifacts: [{ ...existing.artifacts[0], workflow_run: { id: Number(runId), head_sha: 'b'.repeat(40) } }] },
    { total_count: 1, artifacts: [{ ...existing.artifacts[0], name: 'foreign' }] },
    { total_count: 1, artifacts: [{ ...existing.artifacts[0], digest: 'bad' }] }
])('ambiguous or foreign canonical evidence fails closed: %p', listing => {
    expect(() => choose({ attempt: '2', listing })).toThrow();
});

test.each([
    { runId: '0' }, { attempt: '0' }, { releaseSha: 'not-a-sha' },
    { outcome: 'success', listing: null }, { outcome: 'failure', listing: clean },
    { outcome: 'unknown' }
])('invalid selection input fails closed: %p', changes => {
    expect(() => choose(changes)).toThrow();
});
