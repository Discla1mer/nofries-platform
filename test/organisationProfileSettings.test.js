'use strict';

// Settings → Organisation profile (#608 step 2) in the dashboard shell, with a
// scripted port. The loader's port and the server route have their own tests.
const shell = require('../api/shared/protectedAssets/dashboardShell');
const { projectDashboard } = require('../api/shared/appLifecycle/dashboardProjection');
const { fixture } = require('./fixtures/dashboardFixture');
const { createDom } = require('./fixtures/dashboardDom');

const CHOICES = { industries: [{ code: 'retail', label: 'Retail and wholesale' }, { code: 'health', label: 'Health and care' }],
    regions: [{ code: 'auckland', label: 'Auckland' }, { code: 'otago', label: 'Otago' }],
    sizeBands: [{ code: '2-5', label: '2 to 5 people' }, { code: '6-20', label: '6 to 20 people' }] };
const profile = values => ({ schemaVersion: 1, revision: 0, website: null, industry: null, region: null, sizeBand: null, updatedAt: null, ...values });
const flush = () => new Promise(resolve => setImmediate(resolve));

function mount(port) {
    const dom = createDom();
    const controller = shell.mount(dom.root, projectDashboard(fixture()), { initialRoute: 'settings', settingsAccount: { name: 'Alex Example' },
        ...(port ? { organisationProfile: port } : {}) });
    const walk = node => [node, ...node.children.flatMap(walk)];
    const byId = id => walk(dom.root).find(node => node.id === id) || null;
    const submit = () => { const form = dom.root.querySelector('form'); for (const fn of form.events.submit) fn({ preventDefault() {} }); };
    return { dom, controller, byId, submit };
}

test('without the port, Settings shows the organisation name only', () => {
    const h = mount();
    expect(h.dom.root.querySelector('form')).toBeNull();
    expect(h.dom.root.textContent).toContain('Organisation profile');
    h.controller.destroy();
});

test('an admin sees the saved details, saves changes with the current revision, and sees the saved result', async () => {
    const saves = [];
    const port = {
        read: async () => profile({ revision: 2, website: 'https://example.co.nz/', industry: 'retail', choices: CHOICES }),
        save: async values => { saves.push(values); return { status: 'saved', profile: profile({ ...values, revision: 3, website: 'https://new.co.nz/' }) }; }
    };
    const h = mount(port); await flush();
    expect(h.byId('organisation-profile-website').value).toBe('example.co.nz');
    expect(h.byId('organisation-profile-industry').value).toBe('retail');
    expect(h.byId('organisation-profile-region').value).toBe('');
    expect(h.byId('organisation-profile-sizeBand').querySelectorAll('option').map(option => option.textContent))
        .toEqual(['Not set', '2 to 5 people', '6 to 20 people']);
    h.byId('organisation-profile-website').value = ' new.co.nz ';
    h.byId('organisation-profile-region').value = 'otago';
    h.submit(); await flush();
    expect(saves).toEqual([{ expectedRevision: 2, website: 'new.co.nz', industry: 'retail', region: 'otago', sizeBand: '' }]);
    expect(h.byId('organisation-profile-status').textContent).toBe('Organisation details saved.');
    expect(h.byId('organisation-profile-website').value).toBe('new.co.nz');
    // The next save uses the new revision.
    h.submit(); await flush();
    expect(saves[1].expectedRevision).toBe(3);
    h.controller.destroy();
});

test.each([
    ['conflict', { status: 'conflict', profile: profile({ revision: 5, industry: 'health' }) }, 'Someone else changed these details. The latest are shown; check them and save again.'],
    ['denied', { status: 'denied' }, 'Only an organisation admin can change these details.'],
    ['invalid', { status: 'invalid' }, 'Check the website: use a public address such as example.co.nz.']
])('a %s save explains what happened', async (label, result, message) => {
    const h = mount({ read: async () => profile({ choices: CHOICES }), save: async () => result }); await flush();
    h.submit(); await flush();
    expect(h.byId('organisation-profile-status').textContent).toBe(message);
    if (label === 'conflict') expect(h.byId('organisation-profile-industry').value).toBe('health');
    h.controller.destroy();
});

test('a failed read or save says so without showing stale success', async () => {
    const failing = mount({ read: async () => { throw new Error('offline'); }, save: async () => ({}) }); await flush();
    expect(failing.byId('organisation-profile-status').textContent).toBe('Your organisation details could not be loaded. Refresh to try again.');
    expect(failing.dom.root.querySelector('form')).toBeNull();
    failing.controller.destroy();
    const h = mount({ read: async () => profile({ choices: CHOICES }), save: async () => { throw new Error('offline'); } }); await flush();
    h.submit(); await flush();
    expect(h.byId('organisation-profile-status').textContent).toBe('Your details weren\'t saved. Try again.');
    h.controller.destroy();
});
