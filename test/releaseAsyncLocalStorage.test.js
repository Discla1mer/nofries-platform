'use strict';

const path = require('node:path');
const vm = require('node:vm');
const { AsyncLocalStorage } = require('node:async_hooks');
const helper = require('./helpers/releaseAsyncLocalStorage');

const REPOSITORY = path.resolve(__dirname, '..');
// Compiles a caller whose stack frame names the given file, so ownership is
// decided by the same stack inspection that application callers go through.
const callerAt = file => vm.runInThisContext('(storage, value) => storage.enterWith(value)', { filename: file });

test('caller file is the first absolute frame outside the helper and Node core', () => {
    const stack = ['Error', `    at AsyncLocalStorage.run (${require.resolve('./helpers/releaseAsyncLocalStorage')}:40:17)`,
        '    at node:internal/process/task_queues:105:5', `    at createApp (${REPOSITORY}/server.js:432:9)`].join('\n');
    expect(helper.callerFile(stack)).toBe(`${REPOSITORY}/server.js`);
    expect(helper.callerFile(`Error\n    at ${REPOSITORY}/lib/app.js:1:2`)).toBe(`${REPOSITORY}/lib/app.js`);
    expect(helper.callerFile('Error\n    at node:internal/main:1:1')).toBeNull();
});

test('only repository files outside node_modules count as application callers', () => {
    expect(helper.isRepositoryCode(path.join(REPOSITORY, 'api/shared/dashboardRuntime.js'))).toBe(true);
    expect(helper.isRepositoryCode(path.join(REPOSITORY, 'node_modules/jest-circus/build/index.js'))).toBe(false);
    expect(helper.isRepositoryCode(path.join(path.dirname(REPOSITORY), 'elsewhere/index.js'))).toBe(false);
    expect(helper.isRepositoryCode(null)).toBe(false);
});

test('the wrappers are installed once per process, not once per test file', () => {
    const state = helper.install(AsyncLocalStorage.prototype);
    const { run, enterWith } = AsyncLocalStorage.prototype;
    expect(helper.install(AsyncLocalStorage.prototype)).toBe(state);
    expect(AsyncLocalStorage.prototype.run).toBe(run);
    expect(AsyncLocalStorage.prototype.enterWith).toBe(enterWith);
    expect([run.name, enterWith.name]).toEqual(['run', 'enterWith']);
});

test('release disables application storages and leaves dependency storages entered', async () => {
    const state = helper.install(AsyncLocalStorage.prototype);
    const application = new AsyncLocalStorage(), dependency = new AsyncLocalStorage();
    await new Promise(resolve => setImmediate(() => {
        callerAt(path.join(REPOSITORY, 'api/shared/synthetic.js'))(application, 'application-store');
        callerAt(path.join(REPOSITORY, 'node_modules/synthetic-dependency/index.js'))(dependency, 'dependency-store');
        expect(state.owned.has(application)).toBe(true);
        expect(state.owned.has(dependency)).toBe(false);
        expect(helper.releaseEarlierFiles(state)).toBeGreaterThanOrEqual(1);
        expect(state.owned.size).toBe(0);
        expect(application.getStore()).toBeUndefined();
        expect(dependency.getStore()).toBe('dependency-store');
        resolve();
    }));
    // A released storage still works normally if it is entered again.
    expect(application.run('again', () => application.getStore())).toBe('again');
    expect(state.owned.has(application)).toBe(true);
});

test('run and enterWith keep their return values and arguments', () => {
    const storage = new AsyncLocalStorage();
    expect(storage.run({ id: 1 }, (a, b) => [storage.getStore(), a, b], 'x', 'y')).toEqual([{ id: 1 }, 'x', 'y']);
    expect(storage.getStore()).toBeUndefined();
});
