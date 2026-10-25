'use strict';

const path = require('node:path');
const DefaultSequencer = require('@jest/test-sequencer').default;
const { assertComplete, isPrioritySuite, prioritizeSuites } = require('./ci-journey-order');
const rootDirectory = path.resolve(__dirname, '..');

class JourneySequencer extends DefaultSequencer {
    sort(tests) {
        const discovered = [...tests];
        const ordered = prioritizeSuites(super.sort(tests), rootDirectory);
        assertComplete(discovered, ordered);
        const priorityCount = ordered.filter(suite => isPrioritySuite(suite, rootDirectory)).length;
        console.error(`CI suite ordering: ${priorityCount} journey/isolation suites first; all ${ordered.length} discovered suites retained exactly once.`);
        return ordered;
    }
}

module.exports = JourneySequencer;
