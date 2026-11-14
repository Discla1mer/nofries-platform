'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { readStarterDiscardLayout, createStarterDiscardGate, readStarterClientUse, starterClientsRemaining,
    discardStarterDraft } = require('../api/shared/customerSignup/starterClientDiscard');

const tx = (...answers) => {
    const calls = [];
    return { calls, async query(sql, params) { calls.push({ sql, params }); const next = answers.shift(); if (next instanceof Error) throw next; return next; } };
};

test('the layout read recognises the old schema, the 0019 schema, and refuses partial drift', async () => {
    assert.equal(await readStarterDiscardLayout(tx({ rows: [{ has_column: false, has_bound: false }] })), false);
    assert.equal(await readStarterDiscardLayout(tx({ rows: [{ has_column: true, has_bound: true }] })), true);
    for (const rows of [[], [{ has_column: true, has_bound: false }], [{ has_column: false, has_bound: true }],
        [{ has_column: 'true', has_bound: true }], [{ has_column: true, has_bound: true }, { has_column: true, has_bound: true }]]) {
        await assert.rejects(readStarterDiscardLayout(tx({ rows })), /starter_discard_layout_invalid/);
    }
    const t = tx({ rows: [{ has_column: false, has_bound: false }] }); await readStarterDiscardLayout(t);
    assert.match(t.calls[0].sql, /pg_catalog\.pg_attribute/); assert.doesNotMatch(t.calls[0].sql, /discarded_at\s+FROM|schema_migrations/);
});

test('the gate stays off without the flag, rechecks an absent schema, and remembers a present one', async () => {
    let reads = 0, layout = false;
    const readLayout = async () => { reads++; return layout; };
    assert.equal(await createStarterDiscardGate({ enabled: false, readLayout })(), false);
    assert.equal(await createStarterDiscardGate({ enabled: 'true', readLayout })(), false);
    assert.equal(reads, 0);
    const ready = createStarterDiscardGate({ enabled: true, readLayout });
    assert.equal(await ready(), false); assert.equal(await ready(), false); assert.equal(reads, 2);
    layout = true; assert.equal(await ready(), true);
    layout = false; assert.equal(await ready(), true); assert.equal(reads, 3);
    await assert.rejects(createStarterDiscardGate({ enabled: true, readLayout: async () => { throw new Error('starter_discard_layout_invalid'); } })(),
        /starter_discard_layout_invalid/);
});

test('client use counts activated, non-discarded clients and refuses inconsistent rows', async () => {
    const [a, b, c] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()], account = crypto.randomUUID();
    const t = tx({ rows: [{ organisation_id: a, activated: true, discarded: false }, { organisation_id: b, activated: false, discarded: true },
        { organisation_id: c, activated: false, discarded: false }] });
    const use = await readStarterClientUse(t, account);
    assert.equal(use.activated, 1); assert.deepEqual(use.scopes.get(b), { activated: false, discarded: true });
    assert.deepEqual(t.calls[0].params, [account, 13]); assert.match(t.calls[0].sql, /ordinal > 0/);
    for (const row of [{ organisation_id: a, activated: true, discarded: true }, { organisation_id: 'x', activated: true, discarded: false },
        { organisation_id: a, activated: 1, discarded: false }]) await assert.rejects(readStarterClientUse(tx({ rows: [row] }), account));
    await assert.rejects(readStarterClientUse(tx({ rows: [{ organisation_id: a, activated: false, discarded: false },
        { organisation_id: a, activated: false, discarded: false }] }), account), /starter_record_invalid/);
    await assert.rejects(readStarterClientUse(tx({ rows: Array.from({ length: 13 }, () => ({ organisation_id: crypto.randomUUID(), activated: false, discarded: false })) }), account));
});

test('remaining places follow activations, not drafts, within the record ceiling', () => {
    assert.equal(starterClientsRemaining({ limit: 3, activated: 0, reserved: 5 }), 3);
    assert.equal(starterClientsRemaining({ limit: 3, activated: 2, reserved: 3 }), 1);
    assert.equal(starterClientsRemaining({ limit: 3, activated: 3, reserved: 3 }), 0);
    assert.equal(starterClientsRemaining({ limit: 3, activated: 1, reserved: 11 }), 1);
    assert.equal(starterClientsRemaining({ limit: 3, activated: 0, reserved: 12 }), 0);
    assert.throws(() => starterClientsRemaining({ limit: 3, activated: -1, reserved: 0 }), /starter_record_invalid/);
});

test('discard marks one unactivated draft, is repeatable, and refuses anything else', async () => {
    const draft = { tenantId: crypto.randomUUID(), organisationId: crypto.randomUUID(), subjectKey: crypto.randomUUID() + ':' + crypto.randomUUID() };
    const first = tx({ rows: [{ tenant_id: draft.tenantId }] });
    assert.equal(await discardStarterDraft(first, draft), 'discarded');
    assert.match(first.calls[0].sql, /activation IS NULL AND discarded_at IS NULL/);
    assert.deepEqual(first.calls[0].params, [draft.tenantId, draft.organisationId, draft.subjectKey]);
    assert.equal(await discardStarterDraft(tx({ rows: [] }, { rows: [{ discarded: true }] }), draft), 'discarded');
    for (const rows of [[], [{ discarded: false }]]) {
        await assert.rejects(discardStarterDraft(tx({ rows: [] }, { rows }), draft), /starter_client_not_draft/);
    }
});
