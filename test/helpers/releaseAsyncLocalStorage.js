'use strict';

// Jest setup file (package.json "setupFiles"); runs before every test file.
//
// On Node 22 an AsyncLocalStorage that has been entered stays in a
// process-wide list until disable() is called, and every new promise copies a
// slot for each listed instance. The application creates one instance per app,
// session or handler factory: bounded in a server process, but tests build
// hundreds of apps per file and --runInBand runs all files in one process.
// Without release, each file makes every promise in every later file slower,
// which is what turns isolated sub-second journeys into full-run timeouts.
//
// At the start of each file this disables the instances that repository code
// entered while earlier files ran. Those files have finished and Jest has
// discarded their module registries, so no test can observe the change.
// Instances entered by Jest or other dependencies are never touched. No
// production code, timeout, assertion or test selection changes.
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');

const REPOSITORY = path.resolve(__dirname, '../..') + path.sep;
const DEPENDENCIES = REPOSITORY + 'node_modules' + path.sep;
const STATE = Symbol.for('nofries.test.releaseAsyncLocalStorage');

// Returns the file of the first stack frame outside this helper and Node core.
function callerFile(stack) {
    for (const line of String(stack).split('\n').slice(1)) {
        const match = /(?:\(|at )((?:\/|[A-Za-z]:\\)[^():]+):\d+:\d+\)?\s*$/.exec(line);
        if (match && match[1] !== __filename) return match[1];
    }
    return null;
}

function isRepositoryCode(file) {
    return typeof file === 'string' && file.startsWith(REPOSITORY) && !file.startsWith(DEPENDENCIES);
}

function install(prototype) {
    if (Object.hasOwn(prototype, STATE)) return prototype[STATE];
    const state = { owned: new Set(), seen: new WeakSet() };
    for (const name of ['run', 'enterWith']) {
        const original = prototype[name];
        Object.defineProperty(prototype, name, { configurable: true, writable: true, value: {
            [name](...args) {
                if (!state.seen.has(this)) {
                    state.seen.add(this);
                    if (isRepositoryCode(callerFile(new Error().stack))) state.owned.add(this);
                }
                return Reflect.apply(original, this, args);
            }
        }[name] });
    }
    Object.defineProperty(prototype, STATE, { value: state });
    return state;
}

function releaseEarlierFiles(state) {
    const released = state.owned.size;
    for (const storage of state.owned) {
        storage.disable();
        state.seen.delete(storage);
    }
    state.owned.clear();
    return released;
}

releaseEarlierFiles(install(AsyncLocalStorage.prototype));

module.exports = { callerFile, isRepositoryCode, install, releaseEarlierFiles, STATE };
