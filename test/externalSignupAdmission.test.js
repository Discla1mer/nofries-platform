'use strict';

const { createExternalSignupAdmission } = require('../api/shared/customerSignup/externalSignupAdmission');
const { createOrganisationSetup } = require('../api/shared/organisationSetup');
const { uid } = require('./helpers/customerProductionHarness');
const clone = value => JSON.parse(JSON.stringify(value));
const subject = n => uid(100) + ':' + uid(n);
const providerKey = 'a'.repeat(64);
function fixture() {
    const records = new Map(); let version = 0, at = Date.parse('2026-10-08T00:00:00Z');
    const store = {
        async load(key) { return records.has(key) ? clone(records.get(key)) : null; },
        async create(key, record) {
            if (records.has(key)) return false;
            records.set(key, { record: clone(record), version: ++version }); return true;
        },
        async replace(key, expected, record) {
            if (records.get(key)?.version !== expected) return false;
            records.set(key, { record: clone(record), version: ++version }); return true;
        }
    };
    const permitStore = { ...store };
    const options = { store, permitStore, providerKey, now: () => at };
    const restart = () => createExternalSignupAdmission(options);
    const budgets = () => [...records].filter(([key]) => key.startsWith('budget/')).map(([, value]) => value.record.count);
    const permits = () => [...records.keys()].filter(key => key.startsWith('admissions/'));
    return { records, store, permitStore, options, restart, admission: restart(), budgets, permits,
        nextDay() { at += 86400000; } };
}

test('two instances race for the final shared slot without exceeding twenty permits', async () => {
    const h = fixture();
    for (let n = 1; n <= 19; n++) await h.admission.reserve(subject(n));
    const results = await Promise.allSettled([h.admission.reserve(subject(20)), h.restart().reserve(subject(21))]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(h.budgets()).toEqual([20]); expect(h.permits()).toHaveLength(20);
    await expect(h.restart().reserve(subject(22))).rejects.toThrow();
    expect(h.permits()).toHaveLength(20);
});

test('twenty concurrent callbacks for one subject reserve aggregate capacity only once', async () => {
    const h = fixture();
    await Promise.all(Array.from({ length: 20 }, () => h.restart().reserve(subject(1))));
    expect(h.budgets()).toEqual([1]); expect(h.permits()).toHaveLength(1);
    await h.restart().reserve(subject(2)); expect(h.budgets()).toEqual([2]);
});

test('retained permits survive restart, exhaustion and day rollover without consuming new capacity', async () => {
    const h = fixture();
    for (let n = 1; n <= 20; n++) await h.admission.reserve(subject(n));
    const before = clone([...h.records]);
    await h.restart().reserve(subject(1)); await h.restart().recheck(subject(1));
    expect([...h.records]).toEqual(before);
    h.nextDay(); await h.restart().reserve(subject(1));
    expect([...h.records]).toEqual(before);
    await h.restart().reserve(subject(21));
    expect(h.budgets()).toEqual([20, 1]); expect(h.permits()).toHaveLength(21);
});

test('legacy email verification and managed admission spend the same twenty-per-day budget', async () => {
    const h = fixture(), delivered = jest.fn();
    const legacy = createOrganisationSetup({ store: h.store, sendEmail: delivered,
        origin: 'https://nofries.nz', now: h.options.now });
    const request = n => legacy.handle({ method: 'POST', path: '/api/organisation-setup/request',
        headers: { origin: 'https://nofries.nz', 'content-type': 'application/json' },
        clientKey: 'synthetic-network-' + n, body: { email: 'person' + n + '@synthetic.example' } });
    for (let n = 1; n <= 19; n++) expect((await request(n)).status).toBe(202);
    await h.admission.reserve(subject(1));
    expect((await request(20)).status).toBe(429);
    await expect(h.restart().reserve(subject(2))).rejects.toThrow();
    expect(delivered).toHaveBeenCalledTimes(19); expect(h.permits()).toHaveLength(1);
});

test('legacy increments preserve a pending subject reservation across a lost permit write', async () => {
    const h = fixture(), create = h.permitStore.create;
    h.permitStore.create = async () => false;
    await expect(h.admission.reserve(subject(1))).rejects.toThrow();
    const legacy = createOrganisationSetup({ store: h.store, sendEmail: async () => {},
        origin: 'https://nofries.nz', now: h.options.now });
    expect((await legacy.handle({ method: 'POST', path: '/api/organisation-setup/request',
        headers: { origin: 'https://nofries.nz', 'content-type': 'application/json' },
        clientKey: 'synthetic-network', body: { email: 'legacy@synthetic.example' } })).status).toBe(202);
    h.permitStore.create = create;
    await h.restart().reserve(subject(1));
    const global = [...h.records.values()].find(value => value.record.reservations)?.record;
    expect(global.count).toBe(2); expect(global.reservations).toHaveLength(1);
    expect(h.permits()).toHaveLength(1);
});

test.each([null, ['not-a-reservation-hash'], ['a'.repeat(64), 'a'.repeat(64)]].map(reservations => ({ reservations })))(
    'corrupt aggregate reservation list %j denies new permits', async ({ reservations }) => {
        const h = fixture(); await h.admission.reserve(subject(1));
        const counter = [...h.records].find(([key]) => key.startsWith('budget/'))[1];
        counter.record.count = Math.max(1, reservations?.length || 0);
        counter.record.reservations = reservations;
        await expect(h.admission.reserve(subject(2))).rejects.toThrow();
        expect(h.permits()).toHaveLength(1);
    });

test.each(['budget', 'permit'])('lost %s acknowledgement never refunds or creates an unbudgeted permit', async stage => {
    const h = fixture(), target = stage === 'budget' ? h.store : h.permitStore;
    const create = target.create; let lost = false;
    target.create = async (key, value) => {
        const result = await create(key, value);
        if (!lost && key.startsWith(stage === 'budget' ? 'budget/' : 'admissions/')) {
            lost = true; throw new Error('synthetic lost acknowledgement');
        }
        return result;
    };
    if (stage === 'budget') {
        await expect(h.admission.reserve(subject(1))).rejects.toThrow();
        expect(h.budgets()).toEqual([1]); expect(h.permits()).toHaveLength(0);
        await h.restart().reserve(subject(1)); expect(h.budgets()).toEqual([1]);
    } else {
        await h.admission.reserve(subject(1)); expect(h.budgets()).toEqual([1]);
        await h.restart().reserve(subject(1)); expect(h.budgets()).toEqual([1]);
    }
    expect(h.permits()).toHaveLength(1);
});

test('failed permit persistence retains spent capacity and denies assurance', async () => {
    const h = fixture();
    h.permitStore.create = async () => false;
    await expect(h.admission.reserve(subject(1))).rejects.toThrow();
    expect(h.budgets()).toEqual([1]); expect(h.permits()).toHaveLength(0);
});

test('missing, corrupt or unavailable permits fail rechecks and never become identity evidence', async () => {
    const h = fixture();
    await expect(h.admission.recheck(subject(1))).rejects.toThrow();
    await h.admission.reserve(subject(1));
    h.records.get(h.permits()[0]).record.subjectKey = subject(2);
    await expect(h.restart().reserve(subject(1))).rejects.toThrow();
    await expect(h.admission.recheck(subject(1))).rejects.toThrow();
    h.permitStore.load = async () => undefined;
    await expect(h.admission.reserve(subject(3))).rejects.toThrow();
    h.permitStore.load = async () => { throw new Error('synthetic storage failure'); };
    await expect(h.admission.reserve(subject(3))).rejects.toThrow();
    expect(h.budgets()).toEqual([1]);
});
